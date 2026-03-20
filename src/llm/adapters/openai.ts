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

const PROVIDER = 'openai';
const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MODEL = 'gpt-4o';

// Responses API input item types
interface ResponsesInput {
  type: string;
  role?: string;
  content?: unknown;
  id?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
  // For instructions (system)
  instructions?: string;
}

function translateRequest(request: GenerateRequest): { body: Record<string, unknown>; systemInstructions?: string } {
  const input: ResponsesInput[] = [];
  let systemInstructions: string | undefined;

  for (const msg of request.messages) {
    const parts = normalizeContent(msg.content);

    if (msg.role === 'system') {
      systemInstructions = parts
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      continue;
    }

    // Developer role: pass through natively for OpenAI
    if (msg.role === 'developer') {
      const textContent = parts
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      input.push({
        type: 'message',
        role: 'developer',
        content: textContent,
      });
      continue;
    }

    if (msg.role === 'tool') {
      // Tool results map to function_call_output items
      for (const part of parts) {
        if (part.type === 'tool_result') {
          input.push({
            type: 'function_call_output',
            call_id: part.tool_call_id,
            output: part.content
          });
        }
      }
      continue;
    }

    // Check for tool_call parts (assistant messages with function calls)
    const toolCalls = parts.filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call');
    const textParts = parts.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text');

    // Add text content as a message
    if (textParts.length > 0) {
      const textContent = textParts.length === 1
        ? textParts[0]!.text
        : textParts.map((p) => ({ type: 'input_text' as const, text: p.text }));

      input.push({
        type: 'message',
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: textContent
      });
    }

    // Add tool calls as function_call items
    for (const tc of toolCalls) {
      input.push({
        type: 'function_call',
        id: tc.id,
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments
      });
    }
  }

  if (request.system) {
    systemInstructions = request.system;
  }

  const body: Record<string, unknown> = {
    model: request.model ?? DEFAULT_MODEL,
    input
  };

  if (systemInstructions) body.instructions = systemInstructions;
  if (request.max_tokens) body.max_output_tokens = request.max_tokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;

  // Tools
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema
    }));
  }

  // Tool choice
  if (request.tool_choice) {
    switch (request.tool_choice.type) {
      case 'auto':
      case 'none':
      case 'required':
        body.tool_choice = request.tool_choice.type;
        break;
      case 'named':
        body.tool_choice = { type: 'function', name: request.tool_choice.name };
        break;
    }
  }

  // Reasoning effort for o-series models
  if (request.reasoning_effort) {
    body.reasoning = { effort: request.reasoning_effort };
  }

  // Structured output (L4)
  if (request.response_format) {
    switch (request.response_format.type) {
      case 'json_schema': {
        const def = request.response_format.json_schema;
        body.text = {
          format: {
            type: 'json_schema',
            name: def.name,
            schema: def.schema,
            strict: def.strict ?? true
          }
        };
        break;
      }
      case 'json':
        body.text = { format: { type: 'json_object' } };
        break;
      // 'text' — no changes needed
    }
  }

  // Provider options (L20)
  const openaiOpts = request.provider_options?.openai;
  if (openaiOpts) {
    if (openaiOpts.store !== undefined) body.store = openaiOpts.store;
    if (openaiOpts.metadata) body.metadata = openaiOpts.metadata;
  }

  return { body, systemInstructions };
}

function translateStopReason(status: string): StopReason {
  switch (status) {
    case 'completed': return 'end_turn';
    case 'incomplete':
    case 'max_output_tokens': return 'max_tokens';
    case 'stop': return 'stop_sequence';
    default: return 'end_turn';
  }
}

function translateOutputToContentParts(output: Array<Record<string, unknown>>): ContentPart[] {
  const parts: ContentPart[] = [];

  for (const item of output) {
    if (item.type === 'message') {
      const content = item.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === 'output_text') {
            parts.push({ type: 'text', text: (block.text as string) ?? '' });
          }
        }
      }
    } else if (item.type === 'function_call') {
      parts.push({
        type: 'tool_call',
        id: (item.call_id as string) ?? (item.id as string) ?? '',
        name: (item.name as string) ?? '',
        arguments: (item.arguments as string) ?? '{}'
      });
    }
  }

  return parts;
}

async function classifyError(response: Response): Promise<never> {
  const body = await response.text().catch(() => '');

  switch (response.status) {
    case 401:
      throw new AuthenticationError(PROVIDER, `OpenAI authentication failed: ${body}`);
    case 429: {
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new RateLimitError(PROVIDER, { retry_after_ms: retryAfter, message: `OpenAI rate limit: ${body}` });
    }
    case 503:
      throw new OverloadedError(PROVIDER, `OpenAI overloaded: ${body}`);
    default:
      throw new InvalidRequestError(PROVIDER, `OpenAI HTTP ${response.status}: ${body}`);
  }
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider_name = PROVIDER;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? process.env['OPENAI_BASE_URL'] ?? DEFAULT_BASE_URL;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { body } = translateRequest(request);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
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
    const output = (data.output as Array<Record<string, unknown>>) ?? [];
    const parts = translateOutputToContentParts(output);

    const usageData = data.usage as Record<string, unknown> | undefined;
    const outputTokenDetails = usageData?.output_tokens_details as Record<string, number> | undefined;
    const inputTokenDetails = usageData?.input_tokens_details as Record<string, number> | undefined;

    const usage: Usage = {
      input_tokens: (usageData?.input_tokens as number) ?? 0,
      output_tokens: (usageData?.output_tokens as number) ?? 0,
      reasoning_tokens: outputTokenDetails?.reasoning_tokens,
      cache_read_tokens: inputTokenDetails?.cached_tokens
    };

    const hasToolCall = parts.some((p) => p.type === 'tool_call');
    const status = (data.status as string) ?? 'completed';
    const rate_limit = parseRateLimitHeaders(response.headers);

    return {
      message: { role: 'assistant', content: parts },
      usage,
      stop_reason: hasToolCall ? 'tool_use' : translateStopReason(status),
      model: (data.model as string) ?? request.model ?? DEFAULT_MODEL,
      provider: PROVIDER,
      rate_limit
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const { body } = translateRequest(request);
    const streamBody = { ...body, stream: true };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(streamBody),
        signal: request.abort_signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError(PROVIDER, `Network error: ${error instanceof Error ? error.message : error}`);
    }

    if (!response.ok) {
      await classifyError(response);
    }

    const parts: ContentPart[] = [];
    let model = '';
    let stopReason: StopReason = 'end_turn';
    let usage: Usage = { input_tokens: 0, output_tokens: 0 };
    let currentFunctionCallId = '';
    let currentFunctionName = '';
    let currentFunctionArgs = '';

    for await (const sse of parseSSEStream(response, request.abort_signal)) {
      if (sse.data === '[DONE]') break;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(sse.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const eventType = sse.event ?? (parsed.type as string);

      switch (eventType) {
        case 'response.created': {
          const resp = parsed.response as Record<string, unknown> | undefined;
          model = (resp?.model as string) ?? (parsed.model as string) ?? '';
          yield { type: 'stream_start', model };
          break;
        }

        case 'response.output_item.added': {
          const item = parsed.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call') {
            currentFunctionCallId = (item.call_id as string) ?? (item.id as string) ?? '';
            currentFunctionName = (item.name as string) ?? '';
            currentFunctionArgs = '';
            yield { type: 'tool_call_delta', id: currentFunctionCallId, name: currentFunctionName, arguments_delta: '' };
          }
          break;
        }

        case 'response.output_text.delta':
        case 'response.content_part.delta': {
          const text = (parsed.delta as string) ?? '';
          if (text) {
            parts.push({ type: 'text', text });
            yield { type: 'content_delta', text };
          }
          break;
        }

        case 'response.function_call_arguments.delta': {
          const delta = (parsed.delta as string) ?? '';
          currentFunctionArgs += delta;
          yield { type: 'tool_call_delta', id: currentFunctionCallId, arguments_delta: delta };
          break;
        }

        case 'response.function_call_arguments.done': {
          parts.push({
            type: 'tool_call',
            id: currentFunctionCallId,
            name: currentFunctionName,
            arguments: currentFunctionArgs
          });
          break;
        }

        case 'response.output_item.done': {
          const item = parsed.item as Record<string, unknown> | undefined;
          if (item?.type === 'message') {
            const content = item.content as Array<Record<string, unknown>> | undefined;
            if (content) {
              for (const block of content) {
                if (block.type === 'output_text') {
                  // Already accumulated via deltas
                }
              }
            }
          }
          break;
        }

        case 'response.completed': {
          const resp = parsed.response as Record<string, unknown> | undefined;
          if (resp) {
            const status = (resp.status as string) ?? 'completed';
            const hasToolCall = parts.some((p) => p.type === 'tool_call');
            stopReason = hasToolCall ? 'tool_use' : translateStopReason(status);

            const u = resp.usage as Record<string, unknown> | undefined;
            if (u) {
              const outputDetails = u.output_tokens_details as Record<string, number> | undefined;
              const inputDetails = u.input_tokens_details as Record<string, number> | undefined;
              usage = {
                input_tokens: (u.input_tokens as number) ?? 0,
                output_tokens: (u.output_tokens as number) ?? 0,
                reasoning_tokens: outputDetails?.reasoning_tokens,
                cache_read_tokens: inputDetails?.cached_tokens
              };
            }
          }

          yield { type: 'usage', usage };
          yield {
            type: 'stream_end',
            stop_reason: stopReason,
            message: { role: 'assistant', content: parts }
          };
          break;
        }
      }
    }
  }
}
