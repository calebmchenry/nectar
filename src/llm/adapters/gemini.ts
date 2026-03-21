import type { ProviderAdapter } from './types.js';
import {
  GenerateResponse,
  normalizeContent,
} from '../types.js';
import type {
  ContentPart,
  FinishReason,
  GenerateRequest,
  Message,
  StopReason,
  Usage
} from '../types.js';
import type { StreamEvent } from '../streaming.js';
import { parseSSEStream } from '../streaming.js';
import {
  AbortError,
  AccessDeniedError,
  AuthenticationError,
  ContextWindowError,
  InvalidRequestError,
  LLMError,
  NetworkError,
  OverloadedError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  StreamError,
  TimeoutError,
  parseRetryAfterMs
} from '../errors.js';
import { parseRateLimitHeaders } from '../rate-limit.js';
import {
  createRequestTimeoutContext,
  getTimeoutPhaseFromReason,
  getTimeoutPhaseFromSignal,
  isAbortError,
  resolveTimeout
} from '../timeouts.js';

const PROVIDER = 'gemini';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
};

function warnUnsupportedContentPart(partType: string): void {
  console.warn(`[llm:gemini] skipping unsupported content part '${partType}'.`);
}

function isQuotaExceeded(body: string): boolean {
  const normalized = body.toLowerCase();
  return normalized.includes('resource_exhausted')
    && (normalized.includes('quota') || normalized.includes('exceeded') || normalized.includes('limit'));
}

function boundedPartialContent(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= 2000 ? trimmed : trimmed.slice(-2000);
}

function parseProviderErrorMetadata(body: string): { errorCode?: string; raw?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const errorObj = parsed.error as Record<string, unknown> | undefined;
    const errorCode = typeof errorObj?.code === 'string'
      ? errorObj.code
      : (typeof errorObj?.status === 'string' ? errorObj.status : undefined);
    return { errorCode, raw: parsed };
  } catch {
    return {};
  }
}

function withErrorMetadata<T extends LLMError>(
  error: T,
  metadata: { errorCode?: string; raw?: Record<string, unknown> }
): T {
  error.error_code = metadata.errorCode;
  error.raw = metadata.raw;
  return error;
}

function isContextWindowError(body: string): boolean {
  const normalized = body.toLowerCase();
  return normalized.includes('exceeds the maximum')
    || normalized.includes('context length')
    || normalized.includes('token limit');
}

function inferImageMimeFromUrl(url: string): string {
  const normalized = url.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
  for (const [ext, mimeType] of Object.entries(IMAGE_MIME_BY_EXTENSION)) {
    if (normalized.endsWith(ext)) {
      return mimeType;
    }
  }
  return 'image/png';
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
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
  const toolCallIdToName = new Map<string, string>();

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
        case 'image':
          if (part.source.type === 'base64') {
            geminiParts.push({
              inlineData: {
                mimeType: part.source.media_type,
                data: part.source.data,
              },
            });
          } else {
            geminiParts.push({
              fileData: {
                mimeType: inferImageMimeFromUrl(part.source.url),
                fileUri: part.source.url,
              },
            });
          }
          break;
        case 'audio':
          if (part.source.data) {
            geminiParts.push({
              inlineData: {
                mimeType: part.source.media_type,
                data: part.source.data,
              },
            });
          } else if (part.source.url) {
            geminiParts.push({
              fileData: {
                mimeType: part.source.media_type,
                fileUri: part.source.url,
              },
            });
          } else {
            warnUnsupportedContentPart('audio');
          }
          break;
        case 'document':
          if (part.source.data) {
            geminiParts.push({
              inlineData: {
                mimeType: part.source.media_type,
                data: part.source.data,
              },
            });
          } else if (part.source.url) {
            geminiParts.push({
              fileData: {
                mimeType: part.source.media_type,
                fileUri: part.source.url,
              },
            });
          } else {
            warnUnsupportedContentPart('document');
          }
          break;
        case 'tool_call':
          toolCallIdToName.set(part.id, part.name);
          geminiParts.push({
            functionCall: {
              name: part.name,
              args: JSON.parse(part.arguments || '{}')
            }
          });
          break;
        case 'tool_result':
          // Gemini function responses require the function name, not call ID.
          // Root cause note (Sprint 026): synthetic call IDs need deterministic back-mapping.
          const functionName = toolCallIdToName.get(part.tool_call_id) ?? part.tool_call_id;
          geminiParts.push({
            functionResponse: {
              name: functionName,
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

function translateUnifiedFinishReason(reason: string, hasToolCall: boolean): FinishReason {
  if (hasToolCall) {
    return { reason: 'tool_calls', raw: 'tool_use' };
  }
  switch (reason) {
    case 'STOP':
      return { reason: 'stop', raw: reason };
    case 'MAX_TOKENS':
      return { reason: 'length', raw: reason };
    case 'SAFETY':
      return { reason: 'content_filter', raw: reason };
    case 'ERROR':
      return { reason: 'error', raw: reason };
    default:
      return { reason: 'other', raw: reason || 'other' };
  }
}

function extractParts(geminiParts: GeminiPart[]): ContentPart[] {
  const parts: ContentPart[] = [];
  let toolCallCounter = 0;
  for (const gp of geminiParts) {
    if (gp.thought && gp.text) {
      parts.push({ type: 'thinking', thinking: gp.text });
    } else if (gp.text !== undefined) {
      parts.push({ type: 'text', text: gp.text });
    } else if (gp.functionCall) {
      const callId = `call_${toolCallCounter++}`;
      parts.push({
        type: 'tool_call',
        id: callId,
        name: gp.functionCall.name,
        arguments: JSON.stringify(gp.functionCall.args ?? {})
      });
    }
  }
  return parts;
}

async function classifyError(response: Response): Promise<never> {
  const body = await response.text().catch(() => '');
  const metadata = parseProviderErrorMetadata(body);

  switch (response.status) {
    case 401:
      throw withErrorMetadata(new AuthenticationError(PROVIDER, `Gemini authentication failed: ${body}`), metadata);
    case 403:
      throw withErrorMetadata(new AccessDeniedError(PROVIDER, `Gemini access denied: ${body}`), metadata);
    case 429: {
      if (isQuotaExceeded(body)) {
        throw withErrorMetadata(
          new QuotaExceededError(PROVIDER, { status_code: 429, message: `Gemini quota exceeded: ${body}` }),
          metadata,
        );
      }
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      throw withErrorMetadata(
        new RateLimitError(PROVIDER, { retry_after_ms: retryAfter, message: `Gemini rate limit: ${body}` }),
        metadata,
      );
    }
    case 503:
      throw withErrorMetadata(new OverloadedError(PROVIDER, `Gemini overloaded: ${body}`), metadata);
    case 400:
      if (isContextWindowError(body)) {
        throw withErrorMetadata(new ContextWindowError(PROVIDER, `Gemini context window exceeded: ${body}`), metadata);
      }
      throw withErrorMetadata(new InvalidRequestError(PROVIDER, `Gemini invalid request: ${body}`), metadata);
    case 500:
    case 502:
    case 504:
      throw withErrorMetadata(
        new ServerError(PROVIDER, { status_code: response.status, message: `Gemini HTTP ${response.status}: ${body}` }),
        metadata,
      );
    default:
      throw withErrorMetadata(new InvalidRequestError(PROVIDER, `Gemini HTTP ${response.status}: ${body}`), metadata);
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
    const timeout = resolveTimeout(request.timeout, request.timeout_ms);
    const timeoutContext = createRequestTimeoutContext(timeout, request.abort_signal);

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
        signal: timeoutContext.fetch_signal
      });
    } catch (error) {
      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.fetch_signal) ?? getTimeoutPhaseFromReason(error);
      timeoutContext.clear_all_timeouts();
      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(PROVIDER, `Gemini ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`, error);
      }
      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, 'Gemini request aborted by caller.', error);
      }
      throw new NetworkError(PROVIDER, `Network error: ${error instanceof Error ? error.message : error}`);
    }
    timeoutContext.clear_connect_timeout();

    if (!response.ok) {
      timeoutContext.clear_all_timeouts();
      await classifyError(response);
    }

    const data = (await response.json()) as Record<string, unknown>;
    timeoutContext.clear_all_timeouts();
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
      total_tokens: (usageMeta?.promptTokenCount ?? 0) + (usageMeta?.candidatesTokenCount ?? 0),
      reasoning_tokens: usageMeta?.thoughtsTokenCount,
      cache_read_tokens: usageMeta?.cachedContentTokenCount
    };

    const rate_limit = parseRateLimitHeaders(response.headers);

    return new GenerateResponse({
      message: { role: 'assistant', content: parts },
      usage,
      finish_reason: translateUnifiedFinishReason(finishReason, hasToolCall),
      model,
      provider: PROVIDER,
      id: typeof data.responseId === 'string' ? data.responseId : `gemini-${Date.now().toString(36)}`,
      raw: data,
      warnings: finishReason === 'SAFETY'
        ? [{ code: 'safety', message: 'Gemini stopped due to safety filters.' }]
        : [],
      rate_limit,
    });
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const model = request.model ?? DEFAULT_MODEL;
    const { contents, systemInstruction, tools, toolConfig, generationConfig, safetySettings } = translateRequest(request);
    const timeout = resolveTimeout(request.timeout, request.timeout_ms);
    const timeoutContext = createRequestTimeoutContext(timeout, request.abort_signal);

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
        signal: timeoutContext.fetch_signal
      });
    } catch (error) {
      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.fetch_signal) ?? getTimeoutPhaseFromReason(error);
      timeoutContext.clear_all_timeouts();
      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(PROVIDER, `Gemini ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`, error);
      }
      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, 'Gemini request aborted by caller.', error);
      }
      throw new NetworkError(PROVIDER, `Network error: ${error instanceof Error ? error.message : error}`);
    }
    timeoutContext.clear_connect_timeout();

    if (!response.ok) {
      timeoutContext.clear_all_timeouts();
      await classifyError(response);
    }

    const allParts: ContentPart[] = [];
    let partialText = '';
    let yieldedStart = false;
    let stopReason: StopReason = 'end_turn';
    let finishReasonRaw = 'STOP';
    let usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let sawFinishReason = false;
    let thinkingActive = false;
    let toolCallCounter = 0;
    let textActive = false;

    try {
      for await (const sse of parseSSEStream(response, {
        signal: timeoutContext.stream_signal,
        stream_read_ms: timeout.stream_read_ms,
      })) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(sse.data) as Record<string, unknown>;
        } catch (error) {
          throw new StreamError(PROVIDER, {
            phase: 'sse_parse',
            partial_content: boundedPartialContent(partialText),
            message: 'Gemini stream payload could not be parsed as JSON.',
            cause: error,
          });
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
                if (!thinkingActive) {
                  thinkingActive = true;
                  yield { type: 'thinking_start' };
                }
                yield { type: 'thinking_delta', text: gp.text };
              } else if (gp.text !== undefined) {
                if (thinkingActive) {
                  thinkingActive = false;
                  yield { type: 'thinking_end' };
                }
                if (!textActive) {
                  textActive = true;
                  yield { type: 'text_start' };
                }
                partialText += gp.text;
                allParts.push({ type: 'text', text: gp.text });
                yield { type: 'content_delta', text: gp.text };
              } else if (gp.functionCall) {
                if (thinkingActive) {
                  thinkingActive = false;
                  yield { type: 'thinking_end' };
                }
                if (textActive) {
                  textActive = false;
                  yield { type: 'text_end' };
                }
                const callId = `call_${toolCallCounter++}`;
                const serializedArgs = JSON.stringify(gp.functionCall.args ?? {});
                const tc: ContentPart = {
                  type: 'tool_call',
                  id: callId,
                  name: gp.functionCall.name,
                  arguments: serializedArgs
                };
                allParts.push(tc);
                yield { type: 'tool_call_start', id: callId, name: gp.functionCall.name };
                yield { type: 'tool_call_delta', id: callId, name: gp.functionCall.name, arguments_delta: serializedArgs };
                yield { type: 'tool_call_end', id: callId, name: gp.functionCall.name, arguments: serializedArgs };
              }
            }
          }

          if (candidate.finishReason) {
            sawFinishReason = true;
            finishReasonRaw = candidate.finishReason as string;
            const hasToolCall = allParts.some((p) => p.type === 'tool_call');
            stopReason = hasToolCall ? 'tool_use' : translateStopReason(finishReasonRaw);
          }
        }

        const usageMeta = parsed.usageMetadata as Record<string, number> | undefined;
        if (usageMeta) {
          usage = {
            input_tokens: usageMeta.promptTokenCount ?? 0,
            output_tokens: usageMeta.candidatesTokenCount ?? 0,
            total_tokens: (usageMeta.promptTokenCount ?? 0) + (usageMeta.candidatesTokenCount ?? 0),
            reasoning_tokens: usageMeta.thoughtsTokenCount,
            cache_read_tokens: usageMeta.cachedContentTokenCount
          };
        }
      }

      if (!yieldedStart) {
        return;
      }

      if (!sawFinishReason) {
        throw new StreamError(PROVIDER, {
          phase: 'transport',
          partial_content: boundedPartialContent(partialText),
          message: 'Gemini stream ended before finishReason was received.',
        });
      }

      if (thinkingActive) {
        thinkingActive = false;
        yield { type: 'thinking_end' };
      }
      if (textActive) {
        textActive = false;
        yield { type: 'text_end' };
      }

      const responsePayload = new GenerateResponse({
        message: { role: 'assistant', content: allParts },
        usage,
        finish_reason: translateUnifiedFinishReason(finishReasonRaw, allParts.some((p) => p.type === 'tool_call')),
        model,
        provider: PROVIDER,
      });
      yield { type: 'usage', usage };
      yield {
        type: 'stream_end',
        stop_reason: stopReason,
        message: responsePayload.message,
        response: responsePayload,
      };
    } catch (error) {
      if (error instanceof StreamError) {
        throw error;
      }

      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.stream_signal) ?? getTimeoutPhaseFromReason(error);
      if (timeoutPhase === 'stream_read') {
        throw new StreamError(PROVIDER, {
          phase: 'idle_timeout',
          partial_content: boundedPartialContent(partialText),
          message: `Gemini stream idle timeout after ${timeout.stream_read_ms}ms.`,
          cause: error,
        });
      }

      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(
          PROVIDER,
          `Gemini ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`,
          error
        );
      }

      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, 'Gemini stream aborted by caller.', error);
      }

      throw new StreamError(PROVIDER, {
        phase: 'transport',
        partial_content: boundedPartialContent(partialText),
        message: `Gemini stream transport error: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    } finally {
      timeoutContext.clear_all_timeouts();
    }
  }
}
