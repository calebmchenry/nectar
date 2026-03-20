import type { ProviderAdapter } from './types.js';
import type {
  ContentPart,
  GenerateRequest,
  GenerateResponse,
  Message,
  StopReason,
  Usage
} from '../types.js';
import { normalizeContent } from '../types.js';
import type { StreamEvent } from '../streaming.js';
import { parseSSEStream } from '../streaming.js';
import {
  AuthenticationError,
  InvalidRequestError,
  NetworkError,
  OverloadedError,
  RateLimitError,
  parseRetryAfterMs
} from '../errors.js';
import { parseRateLimitHeaders } from '../rate-limit.js';

const PROVIDER = 'gemini';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-2.5-flash';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
  thought?: boolean;
}

interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

function translateRequest(request: GenerateRequest): {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: unknown[];
  toolConfig?: unknown;
  generationConfig: Record<string, unknown>;
  safetySettings?: unknown[];
} {
  const contents: GeminiContent[] = [];
  let systemInstruction: { parts: GeminiPart[] } | undefined;

  const developerParts: GeminiPart[] = [];

  for (const msg of request.messages) {
    const parts = normalizeContent(msg.content);

    if (msg.role === 'system') {
      const textParts = parts
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => ({ text: p.text }));
      systemInstruction = { parts: textParts };
      continue;
    }

    // Developer role: fold into systemInstruction
    if (msg.role === 'developer') {
      const textParts = parts
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => ({ text: p.text }));
      developerParts.push(...textParts);
      continue;
    }

    const geminiParts: GeminiPart[] = [];
    const role = msg.role === 'assistant' ? 'model' : 'user';

    for (const part of parts) {
      switch (part.type) {
        case 'text':
          geminiParts.push({ text: part.text });
          break;
        case 'tool_call':
          geminiParts.push({
            functionCall: {
              name: part.name,
              args: JSON.parse(part.arguments || '{}')
            }
          });
          break;
        case 'tool_result':
          geminiParts.push({
            functionResponse: {
              name: part.tool_call_id,
              response: { content: part.content }
            }
          });
          break;
      }
    }

    if (geminiParts.length > 0) {
      contents.push({ role, parts: geminiParts });
    }
  }

  if (request.system) {
    systemInstruction = { parts: [{ text: request.system }] };
  }

  // Append developer messages to systemInstruction
  if (developerParts.length > 0) {
    if (systemInstruction) {
      systemInstruction.parts.push(...developerParts);
    } else {
      systemInstruction = { parts: developerParts };
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (request.max_tokens) generationConfig.maxOutputTokens = request.max_tokens;
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.stop_sequences) generationConfig.stopSequences = request.stop_sequences;

  // Reasoning effort → thinking config
  if (request.reasoning_effort) {
    const budgetMap = { low: 1024, medium: 4096, high: 16384 };
    generationConfig.thinkingConfig = { thinkingBudget: budgetMap[request.reasoning_effort] };
  }

  // Structured output (L4)
  if (request.response_format) {
    switch (request.response_format.type) {
      case 'json_schema':
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = request.response_format.json_schema.schema;
        break;
      case 'json':
        generationConfig.responseMimeType = 'application/json';
        break;
      // 'text' — no changes needed
    }
  }

  // Provider options (L20)
  const geminiOpts = request.provider_options?.gemini;
  if (geminiOpts?.generation_config) {
    Object.assign(generationConfig, geminiOpts.generation_config);
  }

  let tools: unknown[] | undefined;
  if (request.tools && request.tools.length > 0) {
    tools = [{
      function_declarations: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }))
    }];
  }

  let toolConfig: unknown | undefined;
  if (request.tool_choice) {
    const modeMap = { auto: 'AUTO', none: 'NONE', required: 'ANY', named: 'ANY' };
    const config: Record<string, unknown> = { mode: modeMap[request.tool_choice.type] };
    if (request.tool_choice.type === 'named' && request.tool_choice.name) {
      config.allowed_function_names = [request.tool_choice.name];
    }
    toolConfig = { function_calling_config: config };
  }

  // Safety settings from provider_options
  let safetySettings: unknown[] | undefined;
  if (geminiOpts?.safety_settings) {
    safetySettings = geminiOpts.safety_settings;
  }

  return { contents, systemInstruction, tools, toolConfig, generationConfig, safetySettings };
}

function translateStopReason(reason: string): StopReason {
  switch (reason) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'STOP_SEQUENCE': return 'stop_sequence';
    default: return 'end_turn';
  }
}

function extractParts(geminiParts: GeminiPart[]): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const gp of geminiParts) {
    if (gp.thought && gp.text) {
      parts.push({ type: 'thinking', thinking: gp.text });
    } else if (gp.text !== undefined) {
      parts.push({ type: 'text', text: gp.text });
    } else if (gp.functionCall) {
      parts.push({
        type: 'tool_call',
        id: gp.functionCall.name, // Gemini doesn't have separate IDs
        name: gp.functionCall.name,
        arguments: JSON.stringify(gp.functionCall.args ?? {})
      });
    }
  }
  return parts;
}

async function classifyError(response: Response): Promise<never> {
  const body = await response.text().catch(() => '');

  switch (response.status) {
    case 401:
    case 403:
      throw new AuthenticationError(PROVIDER, `Gemini authentication failed: ${body}`);
    case 429: {
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new RateLimitError(PROVIDER, { retry_after_ms: retryAfter, message: `Gemini rate limit: ${body}` });
    }
    case 503:
      throw new OverloadedError(PROVIDER, `Gemini overloaded: ${body}`);
    default:
      throw new InvalidRequestError(PROVIDER, `Gemini HTTP ${response.status}: ${body}`);
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly provider_name = PROVIDER;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? process.env['GEMINI_BASE_URL'] ?? DEFAULT_BASE_URL;
  }

  private modelUrl(model: string, method: string, stream = false): string {
    const streamSuffix = stream ? '?alt=sse&' : '?';
    return `${this.baseUrl}/v1beta/models/${model}:${method}${streamSuffix}key=${this.apiKey}`;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const model = request.model ?? DEFAULT_MODEL;
    const { contents, systemInstruction, tools, toolConfig, generationConfig, safetySettings } = translateRequest(request);

    const body: Record<string, unknown> = { contents, generationConfig };
    if (systemInstruction) body.system_instruction = systemInstruction;
    if (tools) body.tools = tools;
    if (toolConfig) body.tool_config = toolConfig;
    if (safetySettings) body.safetySettings = safetySettings;

    let response: Response;
    try {
      response = await fetch(this.modelUrl(model, 'generateContent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.abort_signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError(PROVIDER, `Network error: ${error instanceof Error ? error.message : error}`);
    }

    if (!response.ok) {
      await classifyError(response);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
    const candidate = candidates?.[0];

    const geminiContent = candidate?.content as { parts: GeminiPart[] } | undefined;
    const parts = geminiContent?.parts ? extractParts(geminiContent.parts) : [];

    const finishReason = (candidate?.finishReason as string) ?? 'STOP';
    const hasToolCall = parts.some((p) => p.type === 'tool_call');

    const usageMeta = data.usageMetadata as Record<string, number> | undefined;
    const usage: Usage = {
      input_tokens: usageMeta?.promptTokenCount ?? 0,
      output_tokens: usageMeta?.candidatesTokenCount ?? 0,
      reasoning_tokens: usageMeta?.thoughtsTokenCount,
      cache_read_tokens: usageMeta?.cachedContentTokenCount
    };

    const rate_limit = parseRateLimitHeaders(response.headers);

    return {
      message: { role: 'assistant', content: parts },
      usage,
      stop_reason: hasToolCall ? 'tool_use' : translateStopReason(finishReason),
      model,
      provider: PROVIDER,
      rate_limit
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const model = request.model ?? DEFAULT_MODEL;
    const { contents, systemInstruction, tools, toolConfig, generationConfig, safetySettings } = translateRequest(request);

    const body: Record<string, unknown> = { contents, generationConfig };
    if (systemInstruction) body.system_instruction = systemInstruction;
    if (tools) body.tools = tools;
    if (toolConfig) body.tool_config = toolConfig;
    if (safetySettings) body.safetySettings = safetySettings;

    let response: Response;
    try {
      response = await fetch(this.modelUrl(model, 'streamGenerateContent', true), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.abort_signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError(PROVIDER, `Network error: ${error instanceof Error ? error.message : error}`);
    }

    if (!response.ok) {
      await classifyError(response);
    }

    const allParts: ContentPart[] = [];
    let yieldedStart = false;
    let stopReason: StopReason = 'end_turn';
    let usage: Usage = { input_tokens: 0, output_tokens: 0 };

    for await (const sse of parseSSEStream(response, request.abort_signal)) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(sse.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (!yieldedStart) {
        yield { type: 'stream_start', model };
        yieldedStart = true;
      }

      const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
      const candidate = candidates?.[0];

      if (candidate) {
        const content = candidate.content as { parts?: GeminiPart[] } | undefined;
        if (content?.parts) {
          for (const gp of content.parts) {
            if (gp.thought && gp.text) {
              yield { type: 'thinking_delta', text: gp.text };
            } else if (gp.text !== undefined) {
              allParts.push({ type: 'text', text: gp.text });
              yield { type: 'content_delta', text: gp.text };
            } else if (gp.functionCall) {
              const tc: ContentPart = {
                type: 'tool_call',
                id: gp.functionCall.name,
                name: gp.functionCall.name,
                arguments: JSON.stringify(gp.functionCall.args ?? {})
              };
              allParts.push(tc);
              yield { type: 'tool_call_delta', id: gp.functionCall.name, name: gp.functionCall.name, arguments_delta: JSON.stringify(gp.functionCall.args ?? {}) };
            }
          }
        }

        if (candidate.finishReason) {
          const hasToolCall = allParts.some((p) => p.type === 'tool_call');
          stopReason = hasToolCall ? 'tool_use' : translateStopReason(candidate.finishReason as string);
        }
      }

      const usageMeta = parsed.usageMetadata as Record<string, number> | undefined;
      if (usageMeta) {
        usage = {
          input_tokens: usageMeta.promptTokenCount ?? 0,
          output_tokens: usageMeta.candidatesTokenCount ?? 0,
          reasoning_tokens: usageMeta.thoughtsTokenCount,
          cache_read_tokens: usageMeta.cachedContentTokenCount
        };
      }
    }

    if (yieldedStart) {
      yield { type: 'usage', usage };
      yield {
        type: 'stream_end',
        stop_reason: stopReason,
        message: { role: 'assistant', content: allParts }
      };
    }
  }
}
