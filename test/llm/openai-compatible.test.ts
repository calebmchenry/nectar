import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AccessDeniedError,
  AuthenticationError,
  NotFoundError,
  OverloadedError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  StreamError,
} from '../../src/llm/errors.js';
import { OpenAICompatibleAdapter } from '../../src/llm/adapters/openai-compatible.js';
import { startMockChatCompletionsServer, type MockChatCompletionsServer } from '../helpers/mock-chat-completions.js';
import type { StreamEvent } from '../../src/llm/streaming.js';
import { canListenOnLoopback } from '../helpers/network.js';

const servers: MockChatCompletionsServer[] = [];
let canListen = true;

beforeAll(async () => {
  canListen = await canListenOnLoopback();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function withServer(
  handler?: Parameters<typeof startMockChatCompletionsServer>[0],
): Promise<MockChatCompletionsServer> {
  const server = await startMockChatCompletionsServer(handler);
  servers.push(server);
  return server;
}

describe('OpenAICompatibleAdapter', () => {
  it('translates request/response for text generation and provider options', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer((request) => {
      return {
        json: {
          id: 'chatcmpl-1',
          model: 'local-model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'hello from compatible',
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
          },
        },
      };
    });

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    const result = await adapter.generate({
      model: 'local-model',
      messages: [{ role: 'user', content: 'say hello' }],
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      provider_options: {
        openai_compatible: {
          seed: 42,
          custom_option: 'yes',
        },
      },
    });

    expect(result.provider).toBe('openai_compatible');
    expect(result.model).toBe('local-model');
    expect(result.stop_reason).toBe('stop');
    expect(result.usage.input_tokens).toBe(12);
    expect(result.usage.output_tokens).toBe(4);

    const requestBody = server.requests[0]?.body as Record<string, unknown>;
    expect(requestBody.model).toBe('local-model');
    expect(requestBody.max_tokens).toBe(64);
    expect(requestBody.temperature).toBe(0.2);
    expect(requestBody.top_p).toBe(0.9);
    expect(requestBody.seed).toBe(42);
    expect(requestBody.custom_option).toBe('yes');
  });

  it('translates tool calls in non-streaming responses', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer(() => ({
      json: {
        id: 'chatcmpl-2',
        model: 'mock-model',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: '{"path":"/tmp/demo.txt"}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
        },
      },
    }));

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    const result = await adapter.generate({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'read a file' }],
    });

    expect(result.stop_reason).toBe('tool_calls');
    const parts = result.message.content as Array<{ type: string; name?: string }>;
    expect(parts[0]?.type).toBe('tool_call');
    expect(parts[0]?.name).toBe('read_file');
  });

  it('warn-skips unsupported AUDIO and DOCUMENT content parts', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer(() => ({
      json: {
        id: 'chatcmpl-a1',
        model: 'mock-model',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'ok',
            },
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 1,
        },
      },
    }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
      await adapter.generate({
        model: 'mock-model',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            {
              type: 'audio',
              source: { media_type: 'audio/mpeg', data: 'SUQz' },
            },
            {
              type: 'document',
              source: { media_type: 'application/pdf', data: 'JVBERi0xLjQK' },
            },
          ],
        }],
      });

      const requestBody = server.requests[0]?.body as { messages: Array<{ content: unknown }> };
      expect(requestBody.messages[0]?.content).toBe('hello');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('audio'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('document'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('supports streaming text and tool call deltas', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer(() => ({
      sse: [
        'data: {"id":"chatcmpl-3","model":"mock-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-3","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"sum","arguments":"{\\"a\\":1"}}]},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":",\\"b\\":2}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":6}}',
        'data: [DONE]',
      ],
    }));

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    const events: StreamEvent[] = [];
    for await (const event of adapter.stream({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      events.push(event);
    }

    expect(events[0]?.type).toBe('stream_start');
    expect(events.filter((event) => event.type === 'content_delta')).toHaveLength(2);
    expect(events.some((event) => event.type === 'tool_call_delta')).toBe(true);

    const end = events.find((event) => event.type === 'stream_end') as Extract<StreamEvent, { type: 'stream_end' }>;
    expect(end.stop_reason).toBe('tool_calls');
    const parts = end.message.content as Array<{ type: string; text?: string; name?: string; arguments?: string }>;
    expect(parts.some((part) => part.type === 'text' && part.text === 'Hello')).toBe(true);
    const toolPart = parts.find((part) => part.type === 'tool_call');
    expect(toolPart?.name).toBe('sum');
    expect(toolPart?.arguments).toBe('{"a":1,"b":2}');
  });

  it('falls back when response_format json_schema is unsupported', async () => {
    if (!canListen) {
      return;
    }
    let callCount = 0;
    const server = await withServer((request) => {
      callCount += 1;
      const body = request.body as Record<string, unknown>;
      if (callCount === 1 && body.response_format) {
        return {
          status: 400,
          text: 'response_format json_schema is not supported',
        };
      }

      return {
        json: {
          id: 'chatcmpl-4',
          model: 'mock-model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '{"ok":true}',
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
          },
        },
      };
    });

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    const result = await adapter.generate({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'return json' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'Outcome',
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
            },
            required: ['ok'],
          },
        },
      },
    });

    expect(callCount).toBe(2);
    expect(result.stop_reason).toBe('stop');

    const first = server.requests[0]?.body as Record<string, unknown>;
    const second = server.requests[1]?.body as Record<string, unknown>;
    expect(first.response_format).toBeDefined();
    expect(second.response_format).toBeUndefined();
  });

  it('maps 401/403/404/429/500/503 errors to the right error classes', async () => {
    if (!canListen) {
      return;
    }
    const scenarios = [
      { status: 401, expected: AuthenticationError },
      { status: 403, expected: AccessDeniedError },
      { status: 404, expected: NotFoundError },
      { status: 429, expected: RateLimitError },
      { status: 500, expected: ServerError },
      { status: 503, expected: OverloadedError },
    ];

    for (const scenario of scenarios) {
      const server = await withServer(() => ({
        status: scenario.status,
        headers: scenario.status === 429 ? { 'retry-after': '2' } : undefined,
        text: `status-${scenario.status}`,
      }));

      const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
      await expect(
        adapter.generate({
          model: 'mock-model',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      ).rejects.toBeInstanceOf(scenario.expected);
    }
  });

  it('parses Retry-After on 429 responses', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer(() => ({
      status: 429,
      headers: { 'retry-after': '2' },
      text: 'slow down',
    }));

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    try {
      await adapter.generate({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'ping' }],
      });
      expect.unreachable('expected a RateLimitError');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      const rateError = error as RateLimitError;
      expect(rateError.retry_after_ms).toBe(2000);
    }
  });

  it('maps insufficient_quota 429 responses to QuotaExceededError', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer(() => ({
      status: 429,
      text: JSON.stringify({ error: { type: 'insufficient_quota', message: 'Quota exceeded' } }),
    }));

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    await expect(
      adapter.generate({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('emits thinking_start and thinking_end around reasoning deltas', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer(() => ({
      sse: [
        'data: {"id":"chatcmpl-6","model":"mock-model","choices":[{"index":0,"delta":{"reasoning_content":"plan"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-6","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
        'data: [DONE]',
      ],
    }));

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    const events: StreamEvent[] = [];
    for await (const event of adapter.stream({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      events.push(event);
    }

    const names = events.map((event) => event.type);
    const startIndex = names.indexOf('thinking_start');
    const deltaIndex = names.indexOf('thinking_delta');
    const endIndex = names.indexOf('thinking_end');
    expect(startIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeLessThan(deltaIndex);
    expect(deltaIndex).toBeLessThan(endIndex);
  });

  it('maps malformed SSE payloads to StreamError(sse_parse)', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer(() => ({
      sse: [
        'data: {"id":"chatcmpl-7","model":"mock-model","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-7","choices":',
      ],
    }));

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    try {
      for await (const _event of adapter.stream({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        // consume
      }
      expect.unreachable('expected stream parse failure');
    } catch (error) {
      expect(error).toBeInstanceOf(StreamError);
      expect((error as StreamError).phase).toBe('sse_parse');
    }
  });

  it('maps truncated streams to StreamError(transport)', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer(() => ({
      sse: [
        'data: {"id":"chatcmpl-8","model":"mock-model","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
      ],
    }));

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    await expect((async () => {
      for await (const _event of adapter.stream({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        // consume
      }
    })()).rejects.toBeInstanceOf(StreamError);
  });

  it('respects AbortSignal cancellation for streaming', async () => {
    if (!canListen) {
      return;
    }
    const server = await withServer(() => ({
      sse: [
        'data: {"id":"chatcmpl-5","model":"mock-model","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
      ],
    }));

    const adapter = new OpenAICompatibleAdapter('token-1', server.baseUrl);
    const controller = new AbortController();
    controller.abort();

    await expect((async () => {
      for await (const _event of adapter.stream({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hello' }],
        abort_signal: controller.signal,
      })) {
        // no-op
      }
    })()).rejects.toThrow();
  });
});
