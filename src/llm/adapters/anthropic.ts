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
  ContextWindowError,
  InvalidRequestError,
  NetworkError,
  OverloadedError,
  RateLimitError,
  parseRetryAfterMs
} from '../errors.js';
import { parseRateLimitHeaders } from '../rate-limit.js';

const PROVIDER = 'anthropic';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const STRUCTURED_OUTPUT_TOOL_NAME = '__structured_output';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
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

function translateRequest(request: GenerateRequest): Record<string, unknown> {
  const messages: Array<{ role: string; content: unknown }> = [];
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
          blocks.push({ type: 'redacted_thinking' });
          break;
      }
    }

    messages.push({
      role: msg.role === 'tool' ? 'user' : msg.role,
      content: blocks.length === 1 && (blocks[0] as Record<string, unknown>).type === 'text'
        ? (blocks[0] as Record<string, unknown>).text
        : blocks
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

  const body: Record<string, unknown> = {
    model: request.model ?? DEFAULT_MODEL,
    max_tokens: request.max_tokens ?? 4096,
    messages
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
            arguments: JSON.stringify(block.input ?? {})
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
        parts.push({ type: 'redacted_thinking' });
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
      cache_read_tokens: data.usage.cache_read_input_tokens,
      cache_write_tokens: data.usage.cache_creation_input_tokens
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

async function classifyError(response: Response): Promise<never> {
  const body = await response.text().catch(() => '');

  switch (response.status) {
    case 401:
      throw new AuthenticationError(PROVIDER, `Anthropic authentication failed: ${body}`);
    case 429: {
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new RateLimitError(PROVIDER, { retry_after_ms: retryAfter, message: `Anthropic rate limit: ${body}` });
    }
    case 529:
      throw new OverloadedError(PROVIDER, `Anthropic overloaded: ${body}`);
    case 400: {
      if (body.includes('context') || body.includes('too long') || body.includes('token')) {
        throw new ContextWindowError(PROVIDER, `Anthropic context window exceeded: ${body}`);
      }
      throw new InvalidRequestError(PROVIDER, `Anthropic invalid request: ${body}`);
    }
    default:
      throw new InvalidRequestError(PROVIDER, `Anthropic HTTP ${response.status}: ${body}`);
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

    // Caching: active by default, disabled via provider_options
    const shouldCache = request.provider_options?.anthropic?.cache_control !== false;
    if (shouldCache) {
      injectCacheBreakpoints(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.buildHeaders(request, shouldCache),
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

    const data = (await response.json()) as AnthropicResponse;
    const result = translateResponse(data, hasStructuredOutput);
    const rate_limit = parseRateLimitHeaders(response.headers, 'anthropic-ratelimit-');

    return {
      ...result,
      provider: PROVIDER,
      rate_limit
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const body = { ...translateRequest(request), stream: true };
    const hasStructuredOutput = !!(request.response_format && request.response_format.type !== 'text');

    // Caching: active by default, disabled via provider_options
    const shouldCache = request.provider_options?.anthropic?.cache_control !== false;
    if (shouldCache) {
      injectCacheBreakpoints(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.buildHeaders(request, shouldCache),
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

    const parts: ContentPart[] = [];
    let model = '';
    let stopReason: StopReason = 'end_turn';
    let usage: Usage = { input_tokens: 0, output_tokens: 0 };
    // Track current block type for delta routing
    let currentBlockType: string | undefined;
    let currentToolId = '';
    let currentToolName = '';
    let currentToolArgs = '';
    // Track synthetic tool for structured output streaming
    let isSyntheticTool = false;
    let syntheticToolArgs = '';

    for await (const sse of parseSSEStream(response, request.abort_signal)) {
      if (sse.data === '[DONE]') break;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(sse.data) as Record<string, unknown>;
      } catch {
        continue;
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
                cache_read_tokens: u.cache_read_input_tokens,
                cache_write_tokens: u.cache_creation_input_tokens
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
                yield { type: 'tool_call_delta', id: currentToolId, name: currentToolName, arguments_delta: '' };
              }
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
            parts.push({ type: 'text', text });
            yield { type: 'content_delta', text };
          } else if (deltaType === 'input_json_delta') {
            const partial = (delta.partial_json as string) ?? '';
            if (isSyntheticTool) {
              syntheticToolArgs += partial;
              // Emit as content_delta for structured output streaming
              yield { type: 'content_delta', text: partial };
            } else {
              currentToolArgs += partial;
              yield { type: 'tool_call_delta', id: currentToolId, arguments_delta: partial };
            }
          } else if (deltaType === 'thinking_delta') {
            const text = (delta.thinking as string) ?? '';
            yield { type: 'thinking_delta', text };
          }
          break;
        }

        case 'content_block_stop': {
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
                arguments: currentToolArgs
              });
            }
          }
          currentBlockType = undefined;
          break;
        }

        case 'message_delta': {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason) {
            stopReason = translateStopReason(delta.stop_reason as string);
            // Override stop_reason for structured output
            if (hasStructuredOutput && stopReason === 'tool_use') {
              stopReason = 'end_turn';
            }
          }
          const u = parsed.usage as Record<string, number> | undefined;
          if (u) {
            usage = {
              ...usage,
              output_tokens: u.output_tokens ?? usage.output_tokens
            };
          }
          break;
        }

        case 'message_stop': {
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
