import type { ProviderAdapter, ToolChoiceMode } from './types.js';
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
  ContentFilterError,
  ContextLengthError,
  ContextWindowError,
  InvalidRequestError,
  LLMError,
  NetworkError,
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

const PROVIDER = 'anthropic';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6-20260115';
const STRUCTURED_OUTPUT_TOOL_NAME = '__structured_output';

function warnUnsupportedContentPart(partType: string): void {
  console.warn(`[llm:anthropic] skipping unsupported content part '${partType}'.`);
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
  data?: unknown;
}

interface AnthropicResponse {
  id: string;
  type: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface AnthropicRequestMessage {
  role: string;
  content: unknown[];
}

function normalizeAnthropicMessageContent(content: unknown): unknown[] {
  if (Array.isArray(content)) {
    return [...content];
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function mergeConsecutiveSameRoleMessages(messages: AnthropicRequestMessage[]): AnthropicRequestMessage[] {
  const merged: AnthropicRequestMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous && previous.role === message.role) {
      previous.content.push(...normalizeAnthropicMessageContent(message.content));
      continue;
    }
    merged.push({
      role: message.role,
      content: normalizeAnthropicMessageContent(message.content),
    });
  }
  return merged;
}

function shouldEnablePromptCaching(request: GenerateRequest): boolean {
  const anthropicOptions = request.provider_options?.anthropic;
  if (anthropicOptions?.auto_cache === false) {
    return false;
  }
  if (anthropicOptions?.cache_control === false) {
    return false;
  }
  return true;
}

function translateRequest(request: GenerateRequest): Record<string, unknown> {
  const messages: AnthropicRequestMessage[] = [];
  let system: unknown = undefined;
  const developerTexts: string[] = [];

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      // Extract system messages to top-level param
      const parts = normalizeContent(msg.content);
      const text = parts
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      system = text;
      continue;
    }

    // Developer role: accumulate and fold into system block
    if (msg.role === 'developer') {
      const parts = normalizeContent(msg.content);
      const text = parts
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      developerTexts.push(text);
      continue;
    }

    const parts = normalizeContent(msg.content);
    const blocks: unknown[] = [];

    for (const part of parts) {
      switch (part.type) {
        case 'text':
          blocks.push({ type: 'text', text: part.text });
          break;
        case 'image':
          if (part.source.type === 'base64') {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.source.media_type,
                data: part.source.data
              }
            });
          } else {
            blocks.push({
              type: 'image',
              source: {
                type: 'url',
                url: part.source.url,
              },
            });
          }
          break;
        case 'audio':
          // Root cause note (Sprint 025 GAP-1): Anthropic messages API currently has no
          // first-class audio input block, so we warn and skip instead of failing the request.
          warnUnsupportedContentPart('audio');
          break;
        case 'document':
          if (part.source.data) {
            blocks.push({
              type: 'document',
              source: {
                type: 'base64',
                media_type: part.source.media_type,
                data: part.source.data,
              },
            });
          } else {
            warnUnsupportedContentPart('document:url');
          }
          break;
        case 'tool_call':
          blocks.push({
            type: 'tool_use',
            id: part.id,
            name: part.name,
            input: JSON.parse(part.arguments || '{}')
          });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: part.tool_call_id,
            content: part.content,
            ...(part.is_error ? { is_error: true } : {})
          });
          break;
        case 'thinking': {
          const thinkingBlock: Record<string, unknown> = { type: 'thinking', thinking: part.thinking };
          if (part.signature) thinkingBlock.signature = part.signature;
          blocks.push(thinkingBlock);
          break;
        }
        case 'redacted_thinking':
          blocks.push({
            type: 'redacted_thinking',
            ...(part.data !== undefined ? { data: part.data } : {}),
          });
          break;
      }
    }

    messages.push({
      role: msg.role === 'tool' ? 'user' : msg.role,
      content: blocks,
    });
  }

  // If system provided in request directly, use that
  if (request.system) {
    system = request.system;
  }

  // Fold developer messages as last entries in the system block (FIFO order)
  if (developerTexts.length > 0) {
    const baseSystem = system ? String(system) : '';
    const systemParts: Array<{ type: string; text: string }> = [];
    if (baseSystem) {
      systemParts.push({ type: 'text', text: baseSystem });
    }
    for (const dt of developerTexts) {
      systemParts.push({ type: 'text', text: dt });
    }
    system = systemParts;
  }

  const mergedMessages = mergeConsecutiveSameRoleMessages(messages);

  const body: Record<string, unknown> = {
    model: request.model ?? DEFAULT_MODEL,
    max_tokens: request.max_tokens ?? 4096,
    messages: mergedMessages
  };

  if (system) body.system = system;

  // Tools
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema
    }));
  }

  // Structured output via synthetic tool (L4)
  if (request.response_format && request.response_format.type !== 'text') {
    const schema = request.response_format.type === 'json_schema'
      ? request.response_format.json_schema.schema
      : { type: 'object' };

    const syntheticTool = {
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description: 'Respond with structured output matching the required schema',
      input_schema: schema
    };

    const existingTools = (body.tools as Array<Record<string, unknown>>) ?? [];
    body.tools = [...existingTools, syntheticTool];
    body.tool_choice = { type: 'tool', name: STRUCTURED_OUTPUT_TOOL_NAME };
  }

  // Tool choice (only if not overridden by structured output)
  if (request.tool_choice && !(request.response_format && request.response_format.type !== 'text')) {
    switch (request.tool_choice.type) {
      case 'auto':
        body.tool_choice = { type: 'auto' };
        break;
      case 'none':
        // Omit tools to indicate no tool use
        delete body.tools;
        break;
      case 'required':
        body.tool_choice = { type: 'any' };
        break;
      case 'named':
        body.tool_choice = { type: 'tool', name: request.tool_choice.name };
        break;
    }
  }

  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.stop_sequences) body.stop_sequences = request.stop_sequences;

  // Reasoning effort → thinking config
  if (request.reasoning_effort) {
    const budgetMap = { low: 1024, medium: 4096, high: 16384 };
    body.thinking = { type: 'enabled', budget_tokens: budgetMap[request.reasoning_effort] };
  }

  return body;
}

function translateStopReason(reason: string): StopReason {
  switch (reason) {
    case 'end_turn': return 'end_turn';
    case 'max_tokens': return 'max_tokens';
    case 'stop_sequence': return 'stop_sequence';
    case 'tool_use': return 'tool_use';
    default: return 'end_turn';
  }
}

function translateUnifiedFinishReason(reason: string, hasStructuredOutput: boolean): FinishReason {
  if (hasStructuredOutput && reason === 'tool_use') {
    return { reason: 'stop', raw: reason };
  }
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { reason: 'stop', raw: reason };
    case 'max_tokens':
      return { reason: 'length', raw: reason };
    case 'tool_use':
      return { reason: 'tool_calls', raw: reason };
    case 'content_filtered':
      return { reason: 'content_filter', raw: reason };
    case 'error':
      return { reason: 'error', raw: reason };
    default:
      return { reason: 'other', raw: reason || 'other' };
  }
}

function translateResponse(data: AnthropicResponse, hasStructuredOutput: boolean): {
  message: Message;
  usage: Usage;
  stop_reason: StopReason;
  model: string;
} {
  const parts: ContentPart[] = [];

  for (const block of data.content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text ?? '' });
        break;
      case 'tool_use':
        if (hasStructuredOutput && block.name === STRUCTURED_OUTPUT_TOOL_NAME) {
          // Rewrite synthetic tool call to text content
          const jsonText = typeof block.input === 'string'
            ? block.input
            : JSON.stringify(block.input ?? {});
          parts.push({ type: 'text', text: jsonText });
        } else {
          parts.push({
            type: 'tool_call',
            id: block.id ?? '',
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
            tool_type: 'function',
          });
        }
        break;
      case 'thinking': {
        const thinkingPart: ContentPart = { type: 'thinking', thinking: block.thinking ?? '' };
        if (block.signature) {
          (thinkingPart as { type: 'thinking'; thinking: string; signature?: string }).signature = block.signature;
        }
        parts.push(thinkingPart);
        break;
      }
      case 'redacted_thinking':
        parts.push({
          type: 'redacted_thinking',
          ...(block.data !== undefined ? { data: block.data } : {}),
        });
        break;
    }
  }

  // If structured output, override stop_reason to end_turn
  const stopReason = hasStructuredOutput && data.stop_reason === 'tool_use'
    ? 'end_turn'
    : translateStopReason(data.stop_reason);

  return {
    message: { role: 'assistant', content: parts },
    usage: {
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      cache_read_tokens: data.usage.cache_read_input_tokens,
      cache_write_tokens: data.usage.cache_creation_input_tokens,
      raw: data.usage,
    },
    stop_reason: stopReason,
    model: data.model
  };
}

// Prompt caching (L10): inject cache_control breakpoints
export function injectCacheBreakpoints(body: Record<string, unknown>): void {
  // 1. System — convert string to array if needed for cache_control attachment
  const system = body.system;
  if (typeof system === 'string') {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(system) && system.length > 0) {
    (system[system.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  }

  // 2. Tools
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (tools && tools.length > 0) {
    tools[tools.length - 1]!.cache_control = { type: 'ephemeral' };
  }

  // 3. Conversation prefix — second-to-last user message
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (messages) {
    const userIndices = messages
      .map((m, i) => m.role === 'user' ? i : -1)
      .filter(i => i >= 0);
    if (userIndices.length >= 2) {
      const prefixIdx = userIndices[userIndices.length - 2]!;
      const content = messages[prefixIdx]!.content;
      if (Array.isArray(content) && content.length > 0) {
        (content[content.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
      }
    }
  }
}

// Build beta headers (L11)
function buildBetaHeaders(request: GenerateRequest, shouldCache: boolean): string {
  const betas: string[] = [...(request.provider_options?.anthropic?.betas ?? [])];

  if (request.reasoning_effort) {
    betas.push('interleaved-thinking-2025-05-14');
  }
  if (shouldCache) {
    betas.push('prompt-caching-2024-07-31');
  }

  const unique = [...new Set(betas)];
  return unique.join(',');
}

function isQuotaExceeded(body: string): boolean {
  const normalized = body.toLowerCase();
  return normalized.includes('quota')
    || normalized.includes('insufficient_quota')
    || normalized.includes('credit balance')
    || normalized.includes('usage limit');
}

function isContentFiltered(body: string, errorCode?: string): boolean {
  const normalized = body.toLowerCase();
  const normalizedCode = (errorCode ?? '').toLowerCase();
  return normalized.includes('content_filter')
    || normalized.includes('content filter')
    || normalized.includes('safety')
    || normalized.includes('policy')
    || normalized.includes('blocked')
    || normalized.includes('not allowed')
    || normalizedCode.includes('content')
    || normalizedCode.includes('safety')
    || normalizedCode.includes('policy');
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

async function classifyError(response: Response): Promise<never> {
  const body = await response.text().catch(() => '');
  const metadata = parseProviderErrorMetadata(body);
  const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));

  switch (response.status) {
    case 408:
      throw withErrorMetadata(new RequestTimeoutError(PROVIDER, `Anthropic request timeout: ${body}`), metadata);
    case 413:
      throw withErrorMetadata(new ContextLengthError(PROVIDER, `Anthropic context length exceeded: ${body}`), metadata);
    case 422:
      throw withErrorMetadata(new InvalidRequestError(PROVIDER, `Anthropic invalid request: ${body}`, undefined, 422), metadata);
    case 401:
      throw withErrorMetadata(new AuthenticationError(PROVIDER, `Anthropic authentication failed: ${body}`), metadata);
    case 403:
      throw withErrorMetadata(new AccessDeniedError(PROVIDER, `Anthropic access denied: ${body}`), metadata);
    case 429: {
      if (isQuotaExceeded(body)) {
        throw withErrorMetadata(
          new QuotaExceededError(PROVIDER, { status_code: 429, message: `Anthropic quota exceeded: ${body}` }),
          metadata,
        );
      }
      throw withErrorMetadata(
        new RateLimitError(PROVIDER, { retry_after_ms: retryAfter, message: `Anthropic rate limit: ${body}` }),
        metadata,
      );
    }
    case 529:
      if (isQuotaExceeded(body)) {
        throw withErrorMetadata(
          new QuotaExceededError(PROVIDER, { status_code: 529, message: `Anthropic quota exceeded: ${body}` }),
          metadata,
        );
      }
      throw withErrorMetadata(
        new OverloadedError(PROVIDER, { message: `Anthropic overloaded: ${body}`, retry_after_ms: retryAfter }),
        metadata,
      );
    case 500:
    case 502:
    case 504:
      throw withErrorMetadata(
        new ServerError(
          PROVIDER,
          { status_code: response.status, retry_after_ms: retryAfter, message: `Anthropic HTTP ${response.status}: ${body}` }
        ),
        metadata,
      );
    case 400: {
      if (body.includes('context') || body.includes('too long') || body.includes('token')) {
        throw withErrorMetadata(new ContextWindowError(PROVIDER, `Anthropic context window exceeded: ${body}`), metadata);
      }
      if (isContentFiltered(body, metadata.errorCode)) {
        throw withErrorMetadata(new ContentFilterError(PROVIDER, `Anthropic content filtered: ${body}`), metadata);
      }
      throw withErrorMetadata(new InvalidRequestError(PROVIDER, `Anthropic invalid request: ${body}`), metadata);
    }
    default:
      throw withErrorMetadata(new InvalidRequestError(PROVIDER, `Anthropic HTTP ${response.status}: ${body}`), metadata);
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider_name = PROVIDER;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? process.env['ANTHROPIC_BASE_URL'] ?? DEFAULT_BASE_URL;
  }

  async initialize(): Promise<void> {
    // Stateless adapter; no initialization required.
  }

  async close(): Promise<void> {
    // Stateless adapter; no cleanup required.
  }

  supports_tool_choice(mode: ToolChoiceMode): boolean {
    return mode === 'auto' || mode === 'none' || mode === 'required' || mode === 'named';
  }

  private buildHeaders(request: GenerateRequest, shouldCache: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': API_VERSION
    };

    const betaHeader = buildBetaHeaders(request, shouldCache);
    if (betaHeader) headers['anthropic-beta'] = betaHeader;

    return headers;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const body = translateRequest(request);
    const hasStructuredOutput = !!(request.response_format && request.response_format.type !== 'text');
    const timeout = resolveTimeout(request.timeout, request.timeout_ms);
    const timeoutContext = createRequestTimeoutContext(timeout, request.abort_signal);

    // Caching: active by default, disabled via provider_options
    const shouldCache = shouldEnablePromptCaching(request);
    if (shouldCache) {
      injectCacheBreakpoints(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.buildHeaders(request, shouldCache),
        body: JSON.stringify(body),
        signal: timeoutContext.fetch_signal
      });
    } catch (error) {
      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.fetch_signal) ?? getTimeoutPhaseFromReason(error);
      timeoutContext.clear_all_timeouts();
      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(PROVIDER, `Anthropic ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`, error);
      }
      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, 'Anthropic request aborted by caller.', error);
      }
      throw new NetworkError(PROVIDER, `Network error: ${error instanceof Error ? error.message : error}`);
    }
    timeoutContext.clear_connect_timeout();

    if (!response.ok) {
      timeoutContext.clear_all_timeouts();
      await classifyError(response);
    }

    const data = (await response.json()) as AnthropicResponse;
    timeoutContext.clear_all_timeouts();
    const result = translateResponse(data, hasStructuredOutput);
    const rate_limit = parseRateLimitHeaders(response.headers, 'anthropic-ratelimit-');

    return new GenerateResponse({
      ...result,
      finish_reason: translateUnifiedFinishReason(data.stop_reason, hasStructuredOutput),
      provider: PROVIDER,
      id: data.id,
      raw: data,
      warnings: [],
      rate_limit,
    });
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const body = { ...translateRequest(request), stream: true };
    const hasStructuredOutput = !!(request.response_format && request.response_format.type !== 'text');
    const timeout = resolveTimeout(request.timeout, request.timeout_ms);
    const timeoutContext = createRequestTimeoutContext(timeout, request.abort_signal);

    // Caching: active by default, disabled via provider_options
    const shouldCache = shouldEnablePromptCaching(request);
    if (shouldCache) {
      injectCacheBreakpoints(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.buildHeaders(request, shouldCache),
        body: JSON.stringify(body),
        signal: timeoutContext.fetch_signal
      });
    } catch (error) {
      const timeoutPhase = getTimeoutPhaseFromSignal(timeoutContext.fetch_signal) ?? getTimeoutPhaseFromReason(error);
      timeoutContext.clear_all_timeouts();
      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(PROVIDER, `Anthropic ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`, error);
      }
      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, 'Anthropic request aborted by caller.', error);
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
    let rawStopReason = 'end_turn';
    let usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let sawMessageStop = false;
    let thinkingActive = false;
    let textActive = false;
    // Track current block type for delta routing
    let currentBlockType: string | undefined;
    let currentToolId = '';
    let currentToolName = '';
    let currentToolArgs = '';
    // Track synthetic tool for structured output streaming
    let isSyntheticTool = false;
    let syntheticToolArgs = '';
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
            message: 'Anthropic stream payload could not be parsed as JSON.',
            cause: error,
          });
        }

        const eventType = (sse.event ?? parsed.type) as string;

        switch (eventType) {
          case 'message_start': {
            const msg = parsed.message as Record<string, unknown> | undefined;
            if (msg) {
              model = (msg.model as string) ?? '';
              const u = msg.usage as Record<string, number> | undefined;
              if (u) {
                usage = {
                  input_tokens: u.input_tokens ?? 0,
                  output_tokens: u.output_tokens ?? 0,
                  total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
                  cache_read_tokens: u.cache_read_input_tokens,
                  cache_write_tokens: u.cache_creation_input_tokens,
                  raw: u,
                };
              }
            }
            yield { type: 'stream_start', model };
            break;
          }

          case 'content_block_start': {
            const block = parsed.content_block as Record<string, unknown> | undefined;
            if (block) {
              currentBlockType = block.type as string;
              if (currentBlockType === 'thinking' && !thinkingActive) {
                thinkingActive = true;
                yield { type: 'thinking_start' };
              }
              if (currentBlockType === 'text') {
                textActive = true;
                yield { type: 'text_start', text_id: textId };
              }
              if (currentBlockType === 'tool_use') {
                const toolName = (block.name as string) ?? '';
                if (hasStructuredOutput && toolName === STRUCTURED_OUTPUT_TOOL_NAME) {
                  isSyntheticTool = true;
                  syntheticToolArgs = '';
                } else {
                  isSyntheticTool = false;
                  currentToolId = (block.id as string) ?? '';
                  currentToolName = toolName;
                  currentToolArgs = '';
                  yield { type: 'tool_call_start', id: currentToolId, name: currentToolName };
                  yield { type: 'tool_call_delta', id: currentToolId, name: currentToolName, arguments_delta: '' };
                }
              } else if (currentBlockType === 'redacted_thinking') {
                parts.push({
                  type: 'redacted_thinking',
                  ...(Object.prototype.hasOwnProperty.call(block, 'data') ? { data: block.data } : {}),
                });
              }
            }
            break;
          }

          case 'content_block_delta': {
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (!delta) break;

            const deltaType = delta.type as string;
            if (deltaType === 'text_delta') {
              const text = (delta.text as string) ?? '';
              partialText += text;
              parts.push({ type: 'text', text });
              yield { type: 'content_delta', text, text_id: textId };
            } else if (deltaType === 'input_json_delta') {
              const partial = (delta.partial_json as string) ?? '';
              if (isSyntheticTool) {
                syntheticToolArgs += partial;
                partialText += partial;
                // Emit as content_delta for structured output streaming
                yield { type: 'content_delta', text: partial, text_id: textId };
              } else {
                currentToolArgs += partial;
                yield { type: 'tool_call_delta', id: currentToolId, arguments_delta: partial };
              }
            } else if (deltaType === 'thinking_delta') {
              const text = (delta.thinking as string) ?? '';
              if (!thinkingActive) {
                thinkingActive = true;
                yield { type: 'thinking_start' };
              }
              yield { type: 'thinking_delta', text };
            }
            break;
          }

          case 'content_block_stop': {
            if (currentBlockType === 'thinking' && thinkingActive) {
              thinkingActive = false;
              yield { type: 'thinking_end' };
            }
            if (currentBlockType === 'text' && textActive) {
              textActive = false;
              yield { type: 'text_end', text_id: textId };
            }
            if (currentBlockType === 'tool_use') {
              if (isSyntheticTool) {
                // Rewrite synthetic tool as text content
                parts.push({ type: 'text', text: syntheticToolArgs });
                isSyntheticTool = false;
              } else {
                parts.push({
                  type: 'tool_call',
                  id: currentToolId,
                  name: currentToolName,
                  arguments: currentToolArgs,
                  tool_type: 'function',
                });
                yield {
                  type: 'tool_call_end',
                  id: currentToolId,
                  name: currentToolName,
                  arguments: currentToolArgs,
                };
              }
            }
            currentBlockType = undefined;
            break;
          }

          case 'message_delta': {
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (delta?.stop_reason) {
              rawStopReason = delta.stop_reason as string;
              stopReason = translateStopReason(rawStopReason);
              // Override stop_reason for structured output
              if (hasStructuredOutput && stopReason === 'tool_use') {
                stopReason = 'end_turn';
              }
            }
            const u = parsed.usage as Record<string, number> | undefined;
            if (u) {
              usage = {
                ...usage,
                output_tokens: u.output_tokens ?? usage.output_tokens,
                total_tokens: usage.input_tokens + (u.output_tokens ?? usage.output_tokens),
                raw: {
                  ...(usage.raw && typeof usage.raw === 'object' ? usage.raw as Record<string, unknown> : {}),
                  ...u,
                },
              };
            }
            break;
          }

          case 'message_stop': {
            sawMessageStop = true;
            if (thinkingActive) {
              thinkingActive = false;
              yield { type: 'thinking_end' };
            }
            if (textActive) {
              textActive = false;
              yield { type: 'text_end', text_id: textId };
            }
            const responsePayload = new GenerateResponse({
              message: { role: 'assistant', content: parts },
              usage,
              finish_reason: translateUnifiedFinishReason(rawStopReason, hasStructuredOutput),
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

      if (!sawMessageStop) {
        throw new StreamError(PROVIDER, {
          phase: 'transport',
          partial_content: boundedPartialContent(partialText),
          message: 'Anthropic stream ended before message_stop.',
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
          message: `Anthropic stream idle timeout after ${timeout.stream_read_ms}ms.`,
          cause: error,
        });
      }

      if (isAbortError(error) && timeoutPhase) {
        throw new TimeoutError(
          PROVIDER,
          `Anthropic ${timeoutPhase} timeout after ${timeout[`${timeoutPhase}_ms` as keyof typeof timeout]}ms`,
          error
        );
      }

      if (isAbortError(error) && request.abort_signal?.aborted) {
        throw new AbortError(PROVIDER, 'Anthropic stream aborted by caller.', error);
      }

      throw new StreamError(PROVIDER, {
        phase: 'transport',
        partial_content: boundedPartialContent(partialText),
        message: `Anthropic stream transport error: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    } finally {
      timeoutContext.clear_all_timeouts();
    }
  }
}
