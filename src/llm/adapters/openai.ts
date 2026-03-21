import type { ProviderAdapter, ToolChoiceMode } from './types.js';
import {
  GenerateResponse,
  normalizeContent,
  sanitizeMessageName,
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
  ContextLengthError,
  ContextWindowError,
  InvalidRequestError,
  LLMError,
  NetworkError,
  NotFoundError,
  OverloadedError,
  QuotaExceededError,
  RateLimitError,
  RequestTimeoutError,
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

const PROVIDER = 'openai';
const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MODEL = 'gpt-5.2';

function warnUnsupportedContentPart(partType: string): void {
  console.warn(`[llm:openai] skipping unsupported content part '${partType}'.`);
}

function isInsufficientQuota(body: string): boolean {
  const normalized = body.toLowerCase();
  if (normalized.includes('insufficient_quota')) {
    return true;
  }

  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; code?: string } };
    const type = parsed.error?.type?.toLowerCase();
    const code = parsed.error?.code?.toLowerCase();
    return type === 'insufficient_quota' || code === 'insufficient_quota';
  } catch {
    return false;
  }
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
      : (typeof errorObj?.type === 'string' ? errorObj.type : undefined);
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
  return normalized.includes('maximum context length')
    || normalized.includes('context_length_exceeded')
    || normalized.includes('too many tokens');
}

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

function toOpenAIMessageContent(parts: ContentPart[]): string | Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        content.push({ type: 'input_text', text: part.text });
        break;
      case 'image':
        if (part.source.type === 'url') {
          content.push({
            type: 'input_image',
            image_url: part.source.url,
          });
        } else {
          content.push({
            type: 'input_image',
            source: {
              type: 'base64',
              media_type: part.source.media_type,
              data: part.source.data,
            },
          });
        }
        break;
    }
  }

  if (content.length === 0) {
    return '';
  }
  if (content.length === 1 && content[0]?.type === 'input_text') {
    return String(content[0].text ?? '');
  }
  return content;
}

function translateRequest(request: GenerateRequest): { body: Record<string, unknown>; systemInstructions?: string } {
  const input: ResponsesInput[] = [];
  let systemInstructions: string | undefined;

  for (const msg of request.messages) {
    const parts = normalizeContent(msg.content);

    for (const part of parts) {
      if (part.type === 'audio' || part.type === 'document') {
        // Root cause note (Sprint 025 GAP-1): OpenAI Responses currently does not
        // accept these unified content kinds in this adapter path.
        warnUnsupportedContentPart(part.type);
      }
    }

    if (msg.role === 'system') {
      systemInstructions = parts
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      continue;
    }

    // Developer role: pass through natively for OpenAI
    if (msg.role === 'developer') {
      const messageContent = toOpenAIMessageContent(parts);
      const name = sanitizeMessageName(msg.name);
      input.push({
        type: 'message',
        role: 'developer',
        content: messageContent,
        ...(name ? { name } : {}),
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
    const messageParts = parts.filter((part) => part.type === 'text' || part.type === 'image');

    if (messageParts.length > 0) {
      const name = sanitizeMessageName(msg.name);
      input.push({
        type: 'message',
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: toOpenAIMessageContent(messageParts),
        ...(name ? { name } : {}),
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
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.stop_sequences && request.stop_sequences.length > 0) body.stop = request.stop_sequences;

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

function translateUnifiedFinishReason(status: string, hasToolCall: boolean, incompleteReason?: string): FinishReason {
  if (hasToolCall) {
    return { reason: 'tool_calls', raw: 'tool_use' };
  }

  if (status === 'completed' || status === 'stop') {
    return { reason: 'stop', raw: status };
  }

  if (status === 'incomplete' || status === 'max_output_tokens') {
    if (incompleteReason === 'content_filter') {
      return { reason: 'content_filter', raw: incompleteReason };
    }
    return { reason: 'length', raw: status };
  }

  if (status === 'failed' || status === 'error') {
    return { reason: 'error', raw: status };
  }

  return { reason: 'other', raw: status || 'other' };
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
        arguments: (item.arguments as string) ?? '{}',
        tool_type: 'function',
      });
    }
  }

  return parts;
}

async function classifyError(response: Response): Promise<never> {
  const body = await response.text().catch(() => '');
  const metadata = parseProviderErrorMetadata(body);
  const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));

  switch (response.status) {
    case 408:
      throw withErrorMetadata(new RequestTimeoutError(PROVIDER, `OpenAI request timeout: ${body}`), metadata);
    case 413:
      throw withErrorMetadata(new ContextLengthError(PROVIDER, `OpenAI context length exceeded: ${body}`), metadata);
    case 422:
      throw withErrorMetadata(new InvalidRequestError(PROVIDER, `OpenAI invalid request: ${body}`, undefined, 422), metadata);
    case 401:
      throw withErrorMetadata(new AuthenticationError(PROVIDER, `OpenAI authentication failed: ${body}`), metadata);
    case 403:
      throw withErrorMetadata(new AccessDeniedError(PROVIDER, `OpenAI access denied: ${body}`), metadata);
    case 404:
      throw withErrorMetadata(new NotFoundError(PROVIDER, `OpenAI resource not found: ${body}`), metadata);
    case 429: {
      if (isInsufficientQuota(body)) {
        throw withErrorMetadata(
          new QuotaExceededError(PROVIDER, { status_code: 429, message: `OpenAI quota exceeded: ${body}` }),
          metadata,
        );
      }
      throw withErrorMetadata(
        new RateLimitError(PROVIDER, { retry_after_ms: retryAfter, message: `OpenAI rate limit: ${body}` }),
        metadata,
      );
    }
    case 503:
      throw withErrorMetadata(
        new OverloadedError(PROVIDER, { message: `OpenAI overloaded: ${body}`, retry_after_ms: retryAfter }),
        metadata,
      );
    case 400:
      if (isContextWindowError(body)) {
        throw withErrorMetadata(new ContextWindowError(PROVIDER, `OpenAI context window exceeded: ${body}`), metadata);
      }
      throw withErrorMetadata(new InvalidRequestError(PROVIDER, `OpenAI invalid request: ${body}`), metadata);
    case 500:
    case 502:
    case 504:
      throw withErrorMetadata(
        new ServerError(
          PROVIDER,
          { status_code: response.status, retry_after_ms: retryAfter, message: `OpenAI HTTP ${response.status}: ${body}` }
        ),
        metadata,
      );
    default:
      throw withErrorMetadata(new InvalidRequestError(PROVIDER, `OpenAI HTTP ${response.status}: ${body}`), metadata);
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

  async initialize(): Promise<void> {
    // Stateless adapter; no initialization required.
  }

  async close(): Promise<void> {
    // Stateless adapter; no cleanup required.
  }

  supports_tool_choice(_mode: ToolChoiceMode): boolean {
    return true;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { body } = translateRequest(request);
    const timeout = resolveTimeout(request.timeout, request.timeout_ms);
    const timeoutContext = createRequestTimeoutContext(timeout, request.abort_signal);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: timeoutContext.fetch_signal
      });
    } catch (error) {
      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.fetch_signal) ?? getTimeoutPhaseFromReason(error);
      timeoutContext.clear_all_timeouts();
      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(PROVIDER, `OpenAI ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`, error);
      }
      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, 'OpenAI request aborted by caller.', error);
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
    const output = (data.output as Array<Record<string, unknown>>) ?? [];
    const parts = translateOutputToContentParts(output);

    const usageData = data.usage as Record<string, unknown> | undefined;
    const outputTokenDetails = usageData?.output_tokens_details as Record<string, number> | undefined;
    const inputTokenDetails = usageData?.input_tokens_details as Record<string, number> | undefined;

    const usage: Usage = {
      input_tokens: (usageData?.input_tokens as number) ?? 0,
      output_tokens: (usageData?.output_tokens as number) ?? 0,
      total_tokens: ((usageData?.input_tokens as number) ?? 0) + ((usageData?.output_tokens as number) ?? 0),
      reasoning_tokens: outputTokenDetails?.reasoning_tokens,
      cache_read_tokens: inputTokenDetails?.cached_tokens,
      raw: usageData,
    };

    const hasToolCall = parts.some((p) => p.type === 'tool_call');
    const status = (data.status as string) ?? 'completed';
    const incompleteDetails = data.incomplete_details as Record<string, unknown> | undefined;
    const incompleteReason = typeof incompleteDetails?.reason === 'string' ? incompleteDetails.reason : undefined;
    const rate_limit = parseRateLimitHeaders(response.headers);
    const warnings = typeof incompleteReason === 'string'
      ? [{ code: 'incomplete', message: `OpenAI returned incomplete response reason '${incompleteReason}'.` }]
      : [];

    return new GenerateResponse({
      message: { role: 'assistant', content: parts },
      usage,
      finish_reason: translateUnifiedFinishReason(status, hasToolCall, incompleteReason),
      model: (data.model as string) ?? request.model ?? DEFAULT_MODEL,
      provider: PROVIDER,
      id: typeof data.id === 'string' ? data.id : undefined,
      raw: data,
      warnings,
      rate_limit,
    });
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const { body } = translateRequest(request);
    const streamBody = { ...body, stream: true };
    const timeout = resolveTimeout(request.timeout, request.timeout_ms);
    const timeoutContext = createRequestTimeoutContext(timeout, request.abort_signal);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(streamBody),
        signal: timeoutContext.fetch_signal
      });
    } catch (error) {
      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.fetch_signal) ?? getTimeoutPhaseFromReason(error);
      timeoutContext.clear_all_timeouts();
      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(PROVIDER, `OpenAI ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`, error);
      }
      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, 'OpenAI request aborted by caller.', error);
      }
      throw new NetworkError(PROVIDER, `Network error: ${error instanceof Error ? error.message : error}`);
    }
    timeoutContext.clear_connect_timeout();

    if (!response.ok) {
      timeoutContext.clear_all_timeouts();
      await classifyError(response);
    }

    const parts: ContentPart[] = [];
    let partialText = '';
    let model = '';
    let stopReason: StopReason = 'end_turn';
    let usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let currentFunctionCallId = '';
    let currentFunctionName = '';
    let currentFunctionArgs = '';
    let sawCompleted = false;
    let thinkingActive = false;
    let textActive = false;
    const textId = 'text_0';

    try {
      for await (const sse of parseSSEStream(response, {
        signal: timeoutContext.stream_signal,
        stream_read_ms: timeout.stream_read_ms,
      })) {
        if (sse.data === '[DONE]') break;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(sse.data) as Record<string, unknown>;
        } catch (error) {
          throw new StreamError(PROVIDER, {
            phase: 'sse_parse',
            partial_content: boundedPartialContent(partialText),
            message: 'OpenAI stream payload could not be parsed as JSON.',
            cause: error,
          });
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
              if (textActive) {
                textActive = false;
                yield { type: 'text_end', text_id: textId };
              }
              currentFunctionCallId = (item.call_id as string) ?? (item.id as string) ?? '';
              currentFunctionName = (item.name as string) ?? '';
              currentFunctionArgs = '';
              yield { type: 'tool_call_start', id: currentFunctionCallId, name: currentFunctionName };
              yield { type: 'tool_call_delta', id: currentFunctionCallId, name: currentFunctionName, arguments_delta: '' };
            }
            break;
          }

          case 'response.reasoning.delta':
          case 'response.reasoning_summary.delta': {
            const reasoningText = (parsed.delta as string) ?? (parsed.text as string) ?? '';
            if (reasoningText) {
              if (!thinkingActive) {
                thinkingActive = true;
                yield { type: 'thinking_start' };
              }
              yield { type: 'thinking_delta', text: reasoningText };
            }
            break;
          }

          case 'response.output_text.delta':
          case 'response.content_part.delta': {
            const text = (parsed.delta as string) ?? '';
            if (text) {
              if (thinkingActive) {
                thinkingActive = false;
                yield { type: 'thinking_end' };
              }
              if (!textActive) {
                textActive = true;
                yield { type: 'text_start', text_id: textId };
              }
              partialText += text;
              parts.push({ type: 'text', text });
              yield { type: 'content_delta', text, text_id: textId };
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
              arguments: currentFunctionArgs,
              tool_type: 'function',
            });
            yield {
              type: 'tool_call_end',
              id: currentFunctionCallId,
              name: currentFunctionName,
              arguments: currentFunctionArgs,
            };
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
            sawCompleted = true;
            if (thinkingActive) {
              thinkingActive = false;
              yield { type: 'thinking_end' };
            }
            if (textActive) {
              textActive = false;
              yield { type: 'text_end', text_id: textId };
            }
            const resp = parsed.response as Record<string, unknown> | undefined;
            let status = 'completed';
            let incompleteReason: string | undefined;
            if (resp) {
              status = (resp.status as string) ?? 'completed';
              const hasToolCall = parts.some((p) => p.type === 'tool_call');
              stopReason = hasToolCall ? 'tool_use' : translateStopReason(status);

              const u = resp.usage as Record<string, unknown> | undefined;
              if (u) {
                const outputDetails = u.output_tokens_details as Record<string, number> | undefined;
                const inputDetails = u.input_tokens_details as Record<string, number> | undefined;
                usage = {
                  input_tokens: (u.input_tokens as number) ?? 0,
                  output_tokens: (u.output_tokens as number) ?? 0,
                  total_tokens: ((u.input_tokens as number) ?? 0) + ((u.output_tokens as number) ?? 0),
                  reasoning_tokens: outputDetails?.reasoning_tokens,
                  cache_read_tokens: inputDetails?.cached_tokens,
                  raw: u,
                };
              }

              const incompleteDetails = resp.incomplete_details as Record<string, unknown> | undefined;
              incompleteReason = typeof incompleteDetails?.reason === 'string' ? incompleteDetails.reason : undefined;
            }

            const hasToolCall = parts.some((p) => p.type === 'tool_call');
            const responsePayload = new GenerateResponse({
              message: { role: 'assistant', content: parts },
              usage,
              finish_reason: translateUnifiedFinishReason(status, hasToolCall, incompleteReason),
              model: model || request.model || DEFAULT_MODEL,
              provider: PROVIDER,
            });

            yield { type: 'usage', usage };
            yield {
              type: 'stream_end',
              stop_reason: stopReason,
              message: responsePayload.message,
              response: responsePayload,
            };
            break;
          }
          default: {
            if (typeof eventType === 'string' && eventType.length > 0) {
              yield {
                type: 'provider_event',
                provider: PROVIDER,
                provider_event: {
                  type: eventType,
                  data: parsed,
                },
              };
            }
            break;
          }
        }
      }

      if (!sawCompleted) {
        throw new StreamError(PROVIDER, {
          phase: 'transport',
          partial_content: boundedPartialContent(partialText),
          message: 'OpenAI stream ended before response.completed.',
        });
      }
    } catch (error) {
      if (error instanceof StreamError) {
        throw error;
      }

      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.stream_signal) ?? getTimeoutPhaseFromReason(error);
      if (timeoutPhase === 'stream_read') {
        throw new StreamError(PROVIDER, {
          phase: 'idle_timeout',
          partial_content: boundedPartialContent(partialText),
          message: `OpenAI stream idle timeout after ${timeout.stream_read_ms}ms.`,
          cause: error,
        });
      }

      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(
          PROVIDER,
          `OpenAI ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`,
          error
        );
      }

      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, 'OpenAI stream aborted by caller.', error);
      }

      throw new StreamError(PROVIDER, {
        phase: 'transport',
        partial_content: boundedPartialContent(partialText),
        message: `OpenAI stream transport error: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    } finally {
      timeoutContext.clear_all_timeouts();
    }
  }
}
