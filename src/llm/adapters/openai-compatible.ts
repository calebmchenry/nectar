import type { ProviderAdapter } from './types.js';
import { parseSSEStream } from '../streaming.js';
import type { StreamEvent } from '../streaming.js';
import {
  GenerateResponse,
  normalizeContent,
  sanitizeMessageName,
} from '../types.js';
import type {
  ContentPart,
  FinishReason,
  FinishReasonValue,
  GenerateRequest,
  Message,
  Usage,
} from '../types.js';
import {
  AccessDeniedError,
  AbortError,
  AuthenticationError,
  InvalidRequestError,
  NetworkError,
  NotFoundError,
  OverloadedError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  StreamError,
  TimeoutError,
  parseRetryAfterMs,
} from '../errors.js';
import { parseRateLimitHeaders } from '../rate-limit.js';
import {
  createRequestTimeoutContext,
  getTimeoutPhaseFromReason,
  getTimeoutPhaseFromSignal,
  isAbortError,
  resolveTimeout,
} from '../timeouts.js';

const PROVIDER = 'openai_compatible';
const DEFAULT_MODEL = 'gpt-4o-mini';

function warnUnsupportedContentPart(partType: string): void {
  console.warn(`[llm:openai_compatible] skipping unsupported content part '${partType}'.`);
}

function isInsufficientQuota(body: string): boolean {
  const normalized = body.toLowerCase();
  if (normalized.includes('insufficient_quota') || normalized.includes('quota')) {
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

interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  response_format?: Record<string, unknown>;
  stream?: boolean;
  stream_options?: Record<string, unknown>;
  [key: string]: unknown;
}

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content?: string | Array<Record<string, unknown>>;
  name?: string;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
};

interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
}

function translateRequest(request: GenerateRequest, structuredFallback = false): ChatCompletionsRequest {
  const messages = translateMessages(request.messages, request.system, request.response_format, structuredFallback);

  const body: ChatCompletionsRequest = {
    model: request.model ?? DEFAULT_MODEL,
    messages,
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  if (request.tool_choice) {
    switch (request.tool_choice.type) {
      case 'auto':
      case 'none':
      case 'required':
        body.tool_choice = request.tool_choice.type;
        break;
      case 'named':
        body.tool_choice = {
          type: 'function',
          function: { name: request.tool_choice.name },
        };
        break;
    }
  }

  if (request.max_tokens !== undefined) {
    body.max_tokens = request.max_tokens;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    body.top_p = request.top_p;
  }
  if (request.stop_sequences && request.stop_sequences.length > 0) {
    body.stop = request.stop_sequences;
  }

  if (!structuredFallback && request.response_format) {
    switch (request.response_format.type) {
      case 'json':
        body.response_format = { type: 'json_object' };
        break;
      case 'json_schema':
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: request.response_format.json_schema.name,
            strict: request.response_format.json_schema.strict ?? true,
            schema: request.response_format.json_schema.schema,
          },
        };
        break;
      default:
        break;
    }
  }

  const providerOptions = request.provider_options?.openai_compatible;
  if (providerOptions) {
    Object.assign(body, providerOptions);
  }

  return body;
}

function translateMessages(
  messages: Message[],
  systemOverride?: string,
  responseFormat?: GenerateRequest['response_format'],
  structuredFallback = false,
): ChatMessage[] {
  const translated: ChatMessage[] = [];

  if (systemOverride && systemOverride.trim().length > 0) {
    translated.push({ role: 'system', content: systemOverride });
  }

  for (const message of messages) {
    const parts = normalizeContent(message.content);

    for (const part of parts) {
      if (part.type === 'audio' || part.type === 'document') {
        // Root cause note (Sprint 025 GAP-1): Chat Completions compatible servers
        // have no standard wire shape for these unified part kinds, so we skip safely.
        warnUnsupportedContentPart(part.type);
      }
    }

    if (message.role === 'tool') {
      for (const part of parts) {
        if (part.type !== 'tool_result') {
          continue;
        }
        const name = sanitizeMessageName(message.name);
        translated.push({
          role: 'tool',
          tool_call_id: part.tool_call_id,
          content: part.content,
          ...(name ? { name } : {}),
        });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const toolCalls = parts
        .filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call')
        .map((part) => ({
          id: part.id,
          type: 'function',
          function: {
            name: part.name,
            arguments: part.arguments,
          },
        }));

      const textContent = parts
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');

      translated.push({
        role: 'assistant',
        content: textContent.length > 0 ? textContent : '',
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(sanitizeMessageName(message.name) ? { name: sanitizeMessageName(message.name) } : {}),
      });
      continue;
    }

    const contentBlocks: Array<Record<string, unknown>> = [];
    for (const part of parts) {
      if (part.type === 'text') {
        contentBlocks.push({ type: 'text', text: part.text });
      }
      if (part.type === 'image') {
        const imageUrl = part.source.type === 'url'
          ? part.source.url
          : `data:${part.source.media_type};base64,${part.source.data}`;
        contentBlocks.push({ type: 'image_url', image_url: { url: imageUrl } });
      }
    }

    if (contentBlocks.length === 1 && contentBlocks[0]?.type === 'text') {
      const name = sanitizeMessageName(message.name);
      translated.push({
        role: toChatRole(message.role),
        content: String(contentBlocks[0].text ?? ''),
        ...(name ? { name } : {}),
      });
      continue;
    }

    const name = sanitizeMessageName(message.name);
    translated.push({
      role: toChatRole(message.role),
      content: contentBlocks.length > 0 ? contentBlocks : '',
      ...(name ? { name } : {}),
    });
  }

  if (structuredFallback && responseFormat && responseFormat.type !== 'text') {
    translated.push({
      role: 'system',
      content: buildStructuredFallbackInstruction(responseFormat),
    });
  }

  return translated;
}

function buildStructuredFallbackInstruction(responseFormat: GenerateRequest['response_format']): string {
  if (!responseFormat || responseFormat.type === 'text') {
    return 'Respond with plain text.';
  }

  if (responseFormat.type === 'json') {
    return 'Respond with valid JSON only. Do not include markdown code fences or explanatory text.';
  }

  const schema = JSON.stringify(responseFormat.json_schema.schema);
  return `Respond with valid JSON only that matches this schema: ${schema}`;
}

function toChatRole(role: Message['role']): ChatMessage['role'] {
  if (role === 'developer') {
    return 'developer';
  }
  if (role === 'system' || role === 'assistant' || role === 'tool') {
    return role;
  }
  return 'user';
}

function translateUnifiedFinishReason(reason: string | null | undefined, hasToolCall: boolean): FinishReason {
  if (hasToolCall) {
    return { reason: 'tool_calls', raw: 'tool_calls' };
  }
  switch (reason) {
    case 'length':
      return { reason: 'length', raw: reason };
    case 'content_filter':
      return { reason: 'content_filter', raw: reason };
    case 'tool_calls':
    case 'function_call':
      return { reason: 'tool_calls', raw: reason };
    case 'stop':
      return { reason: 'stop', raw: reason };
    case 'error':
      return { reason: 'error', raw: reason };
    case null:
    case undefined:
      return { reason: 'other', raw: 'other' };
    default:
      return { reason: 'other', raw: reason };
  }
}

function translateUsage(raw: Record<string, unknown> | undefined): Usage {
  const completionDetails = raw?.completion_tokens_details as Record<string, unknown> | undefined;
  const inputTokens = Number(raw?.prompt_tokens ?? 0);
  const outputTokens = Number(raw?.completion_tokens ?? 0);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    reasoning_tokens: numberOrUndefined(completionDetails?.reasoning_tokens),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }
  return value;
}

function getReasoningDelta(delta: Record<string, unknown>): string {
  const direct = delta.reasoning_content;
  if (typeof direct === 'string') {
    return direct;
  }

  const fallback = delta.reasoning;
  if (typeof fallback === 'string') {
    return fallback;
  }

  if (Array.isArray(direct)) {
    return direct
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }

  return '';
}

async function classifyHttpError(provider: string, response: Response): Promise<never> {
  const body = await safeReadText(response);

  switch (response.status) {
    case 401:
      throw new AuthenticationError(provider, `Authentication failed: ${body}`);
    case 403:
      throw new AccessDeniedError(provider, `Access denied: ${body}`);
    case 404:
      throw new NotFoundError(provider, `Endpoint or model not found: ${body}`);
    case 429: {
      if (isInsufficientQuota(body)) {
        throw new QuotaExceededError(provider, { status_code: 429, message: `Quota exceeded: ${body}` });
      }
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new RateLimitError(provider, { retry_after_ms: retryAfter, message: `Rate limited: ${body}` });
    }
    case 503:
      throw new OverloadedError(provider, `Server error ${response.status}: ${body}`);
    case 500:
    case 502:
    case 504:
      throw new ServerError(provider, { status_code: response.status, message: `Server error ${response.status}: ${body}` });
    default:
      if (response.status >= 500) {
        throw new ServerError(provider, { status_code: response.status, message: `Server error ${response.status}: ${body}` });
      }
      throw new InvalidRequestError(provider, `HTTP ${response.status}: ${body}`);
  }
}

function shouldFallbackStructuredOutput(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }

  const normalized = body.toLowerCase();
  return normalized.includes('response_format') || normalized.includes('json_schema');
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly provider_name = PROVIDER;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const body = translateRequest(request);
    const supportsStructuredFallback = !!(request.response_format && request.response_format.type !== 'text');
    const timeout = resolveTimeout(request.timeout, request.timeout_ms);
    const timeoutContext = createRequestTimeoutContext(timeout, request.abort_signal);

    let response: Response;
    try {
      response = await this.fetchChatCompletions(body, timeoutContext.fetch_signal);
    } catch (error) {
      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.fetch_signal) ?? getTimeoutPhaseFromReason(error);
      timeoutContext.clear_all_timeouts();
      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(PROVIDER, `${PROVIDER} ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`, error);
      }
      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, `${PROVIDER} request aborted by caller.`, error);
      }
      throw error;
    }
    timeoutContext.clear_connect_timeout();

    if (!response.ok && supportsStructuredFallback) {
      const bodyText = await safeReadText(response);
      if (shouldFallbackStructuredOutput(response.status, bodyText)) {
        const fallbackBody = translateRequest(request, true);
        delete fallbackBody.response_format;
        try {
          response = await this.fetchChatCompletions(fallbackBody, timeoutContext.stream_signal);
        } catch (error) {
          const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.stream_signal) ?? getTimeoutPhaseFromReason(error);
          timeoutContext.clear_all_timeouts();
          if (isAbortError(error) && timeoutPhase) {
            throw new TimeoutError(PROVIDER, `${PROVIDER} ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`, error);
          }
          if (isAbortError(error) && request.abort_signal?.aborted) {
            throw new AbortError(PROVIDER, `${PROVIDER} request aborted by caller.`, error);
          }
          throw error;
        }
      } else {
        timeoutContext.clear_all_timeouts();
        throw await classifyHttpError(PROVIDER, toReplayableResponse(response, bodyText));
      }
    }

    if (!response.ok) {
      timeoutContext.clear_all_timeouts();
      throw await classifyHttpError(PROVIDER, response);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    timeoutContext.clear_all_timeouts();
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const firstChoice = choices?.[0];
    const message = firstChoice?.message as Record<string, unknown> | undefined;

    const contentParts: ContentPart[] = [];
    const content = message?.content;
    if (typeof content === 'string' && content.length > 0) {
      contentParts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const block = part as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          contentParts.push({ type: 'text', text: block.text });
        }
      }
    }

    const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const toolCall of toolCalls) {
        const fn = toolCall.function as Record<string, unknown> | undefined;
        contentParts.push({
          type: 'tool_call',
          id: String(toolCall.id ?? ''),
          name: String(fn?.name ?? ''),
          arguments: String(fn?.arguments ?? '{}'),
        });
      }
    }

    const usage = translateUsage(payload.usage as Record<string, unknown> | undefined);
    const finishReason = firstChoice?.finish_reason as string | undefined;
    const hasToolCall = contentParts.some((part) => part.type === 'tool_call');

    return new GenerateResponse({
      message: {
        role: 'assistant',
        content: contentParts,
      },
      usage,
      finish_reason: translateUnifiedFinishReason(finishReason, hasToolCall),
      model: String(payload.model ?? request.model ?? DEFAULT_MODEL),
      provider: PROVIDER,
      id: typeof payload.id === 'string' ? payload.id : undefined,
      raw: payload,
      warnings: [],
      rate_limit: parseRateLimitHeaders(response.headers),
    });
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const body = translateRequest(request);
    body.stream = true;
    body.stream_options = { include_usage: true };
    const timeout = resolveTimeout(request.timeout, request.timeout_ms);
    const timeoutContext = createRequestTimeoutContext(timeout, request.abort_signal);

    let response: Response;
    try {
      response = await this.fetchChatCompletions(body, timeoutContext.fetch_signal);
    } catch (error) {
      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.fetch_signal) ?? getTimeoutPhaseFromReason(error);
      timeoutContext.clear_all_timeouts();
      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(PROVIDER, `${PROVIDER} ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`, error);
      }
      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, `${PROVIDER} stream aborted by caller.`, error);
      }
      throw error;
    }
    timeoutContext.clear_connect_timeout();

    if (!response.ok) {
      timeoutContext.clear_all_timeouts();
      throw await classifyHttpError(PROVIDER, response);
    }

    let started = false;
    let model = request.model ?? DEFAULT_MODEL;
    let stopReason: FinishReasonValue = 'stop';
    let usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let text = '';
    let sawDone = false;
    let thinkingActive = false;
    const toolCalls = new Map<number, ToolCallState>();

    try {
      for await (const chunk of parseSSEStream(response, {
        signal: timeoutContext.stream_signal,
        stream_read_ms: timeout.stream_read_ms,
      })) {
        const data = chunk.data.trim();
        if (!data) {
          continue;
        }
        if (data === '[DONE]') {
          sawDone = true;
          break;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch (error) {
          throw new StreamError(PROVIDER, {
            phase: 'sse_parse',
            partial_content: boundedPartialContent(text),
            message: 'OpenAI-compatible stream payload could not be parsed as JSON.',
            cause: error,
          });
        }

        if (!started) {
          if (typeof parsed.model === 'string') {
            model = parsed.model;
          }
          started = true;
          yield { type: 'stream_start', model };
        }

        const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        const delta = choice?.delta as Record<string, unknown> | undefined;

        if (delta) {
          const reasoningText = getReasoningDelta(delta);
          if (reasoningText.length > 0) {
            if (!thinkingActive) {
              thinkingActive = true;
              yield { type: 'thinking_start' };
            }
            yield { type: 'thinking_delta', text: reasoningText };
          }

          const deltaContent = delta.content;
          if (typeof deltaContent === 'string' && deltaContent.length > 0) {
            if (thinkingActive) {
              thinkingActive = false;
              yield { type: 'thinking_end' };
            }
            text += deltaContent;
            yield { type: 'content_delta', text: deltaContent };
          }

          const deltaToolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          if (deltaToolCalls) {
            for (const toolCall of deltaToolCalls) {
              const index = typeof toolCall.index === 'number' ? toolCall.index : 0;
              const existing = toolCalls.get(index) ?? {
                id: typeof toolCall.id === 'string' ? toolCall.id : `tool_${index}`,
                name: '',
                arguments: '',
              };

              if (typeof toolCall.id === 'string' && toolCall.id.length > 0) {
                existing.id = toolCall.id;
              }

              const fn = toolCall.function as Record<string, unknown> | undefined;
              if (typeof fn?.name === 'string' && fn.name.length > 0) {
                existing.name = fn.name;
              }

              let argumentsDelta = '';
              if (typeof fn?.arguments === 'string') {
                argumentsDelta = fn.arguments;
                existing.arguments += fn.arguments;
              }

              toolCalls.set(index, existing);
              if (argumentsDelta.length > 0 || existing.name.length > 0) {
                yield {
                  type: 'tool_call_delta',
                  id: existing.id,
                  ...(existing.name.length > 0 ? { name: existing.name } : {}),
                  arguments_delta: argumentsDelta,
                };
              }
            }
          }
        }

        if (choice && typeof choice.finish_reason === 'string') {
          stopReason = translateUnifiedFinishReason(choice.finish_reason, false).reason;
        }

        if (parsed.usage && typeof parsed.usage === 'object') {
          usage = translateUsage(parsed.usage as Record<string, unknown>);
        }
      }

      if (!started) {
        yield { type: 'stream_start', model };
      }

      if (!sawDone) {
        throw new StreamError(PROVIDER, {
          phase: 'transport',
          partial_content: boundedPartialContent(text),
          message: 'OpenAI-compatible stream ended before [DONE].',
        });
      }

      if (thinkingActive) {
        thinkingActive = false;
        yield { type: 'thinking_end' };
      }

      const contentParts: ContentPart[] = [];
      if (text.length > 0) {
        contentParts.push({ type: 'text', text });
      }

      const orderedToolCalls = Array.from(toolCalls.entries()).sort(([left], [right]) => left - right);
      for (const [, toolCall] of orderedToolCalls) {
        contentParts.push({
          type: 'tool_call',
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
      }

      if (contentParts.some((part) => part.type === 'tool_call')) {
        stopReason = 'tool_calls';
      }

      const responsePayload = new GenerateResponse({
        message: {
          role: 'assistant',
          content: contentParts,
        },
        usage,
        finish_reason: stopReason,
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
          partial_content: boundedPartialContent(text),
          message: `OpenAI-compatible stream idle timeout after ${timeout.stream_read_ms}ms.`,
          cause: error,
        });
      }

      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(
          PROVIDER,
          `${PROVIDER} ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`,
          error
        );
      }

      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, `${PROVIDER} stream aborted by caller.`, error);
      }

      throw new StreamError(PROVIDER, {
        phase: 'transport',
        partial_content: boundedPartialContent(text),
        message: `OpenAI-compatible stream transport error: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    } finally {
      timeoutContext.clear_all_timeouts();
    }
  }

  private async fetchChatCompletions(body: ChatCompletionsRequest, abortSignal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    try {
      return await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortSignal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw new NetworkError(PROVIDER, `Network error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function toReplayableResponse(response: Response, body: string): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
