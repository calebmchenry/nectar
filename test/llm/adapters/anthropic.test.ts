import { describe, expect, it, vi, afterEach } from 'vitest';
import { AnthropicAdapter } from '../../../src/llm/adapters/anthropic.js';
import {
  AuthenticationError,
  ContextWindowError,
  InvalidRequestError,
  OverloadedError,
  QuotaExceededError,
  RateLimitError,
  StreamError,
} from '../../../src/llm/errors.js';
import type { StreamEvent } from '../../../src/llm/streaming.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(response: unknown, opts?: { ok?: boolean; status?: number; headers?: Record<string, string> }) {
  const ok = opts?.ok ?? true;
  const status = opts?.status ?? 200;
  const headers = new Headers(opts?.headers ?? {});

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    headers,
    json: async () => response,
    text: async () => JSON.stringify(response)
  } as unknown as Response);
}

function sseResponse(events: string[]) {
  const text = events.join('\n\n') + '\n\n';
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: stream
  } as unknown as Response);
}

describe('AnthropicAdapter', () => {
  describe('generate', () => {
    it('sends correct request and translates response', async () => {
      const mockResponse = {
        id: 'msg_1',
        type: 'message',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 }
      };
      mockFetch(mockResponse);

      const adapter = new AnthropicAdapter('test-key', 'https://test.api');
      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024
      });

      expect(result.message.role).toBe('assistant');
      expect(result.message.content).toEqual([{ type: 'text', text: 'Hello!' }]);
      expect(result.stop_reason).toBe('stop');
      expect(result.finish_reason.raw).toBe('end_turn');
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.total_tokens).toBe(15);
      expect(result.provider).toBe('anthropic');

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toBe('https://test.api/v1/messages');
      expect(call[1].headers['x-api-key']).toBe('test-key');
      expect(call[1].headers['anthropic-version']).toBe('2023-06-01');
    });

    it('extracts system messages to top-level param', async () => {
      mockFetch({
        id: 'msg_1', type: 'message', model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      });

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hi' }
        ]
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      // Caching is on by default, so system string is converted to array with cache_control
      expect(body.system).toEqual([{ type: 'text', text: 'Be helpful', cache_control: { type: 'ephemeral' } }]);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
    });

    it('merges consecutive same-role messages before request submission', async () => {
      mockFetch({
        id: 'msg_1', type: 'message', model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      });

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [
          { role: 'user', content: 'first user' },
          { role: 'user', content: 'second user' },
          { role: 'assistant', content: 'assistant turn' },
          { role: 'assistant', content: 'assistant follow-up' },
        ],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[1].role).toBe('assistant');
      expect(body.messages[0].content).toEqual([
        { type: 'text', text: 'first user' },
        { type: 'text', text: 'second user' },
      ]);
      expect(body.messages[1].content).toEqual([
        { type: 'text', text: 'assistant turn' },
        { type: 'text', text: 'assistant follow-up' },
      ]);
    });

    it('does not merge alternating roles', async () => {
      mockFetch({
        id: 'msg_1', type: 'message', model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      });

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [
          { role: 'user', content: 'first user' },
          { role: 'assistant', content: 'assistant' },
          { role: 'user', content: 'second user' },
        ],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.messages).toHaveLength(3);
      expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user']);
    });

    it('translates tool definitions', async () => {
      mockFetch({
        id: 'msg_1', type: 'message', model: 'test',
        content: [{ type: 'tool_use', id: 'tc_1', name: 'read_file', input: { path: '/test' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 0, output_tokens: 0 }
      });

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'Read the file' }],
        tools: [{
          name: 'read_file',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } }
        }]
      });

      expect(result.stop_reason).toBe('tool_calls');
      expect(result.finish_reason.raw).toBe('tool_use');
      const parts = result.message.content as Array<{ type: string }>;
      expect(parts[0]!.type).toBe('tool_call');

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.tools[0].name).toBe('read_file');
    });

    it('serializes DOCUMENT blocks and warn-skips AUDIO blocks', async () => {
      mockFetch({
        id: 'msg_1', type: 'message', model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const adapter = new AnthropicAdapter('key', 'https://test.api');
        await adapter.generate({
          messages: [{
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  media_type: 'application/pdf',
                  data: 'JVBERi0xLjQK',
                },
              },
              {
                type: 'audio',
                source: {
                  media_type: 'audio/mpeg',
                  data: 'SUQz',
                },
              },
            ],
          }],
        });

        const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
        expect(Array.isArray(body.messages[0].content)).toBe(true);
        expect(body.messages[0].content).toEqual([
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'JVBERi0xLjQK',
            },
          },
        ]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('audio'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('serializes URL images using source.type=url', async () => {
      mockFetch({
        id: 'msg_1', type: 'message', model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      });

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.com/reference.png',
            },
          }],
        }],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.messages[0].content).toEqual([
        {
          type: 'image',
          source: {
            type: 'url',
            url: 'https://example.com/reference.png',
          },
        },
      ]);
    });

    it('preserves base64 image serialization', async () => {
      mockFetch({
        id: 'msg_1', type: 'message', model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      });

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
            },
          }],
        }],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.messages[0].content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          },
        },
      ]);
    });

    it('translates tool_choice modes', async () => {
      mockFetch({
        id: 'msg_1', type: 'message', model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      });

      const adapter = new AnthropicAdapter('key', 'https://test.api');

      // required → any
      await adapter.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ name: 'fn', description: 'test', input_schema: {} }],
        tool_choice: { type: 'required' }
      });
      let body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.tool_choice).toEqual({ type: 'any' });
    });

    it('translates stop reasons correctly', async () => {
      for (const [input, expected] of [
        ['end_turn', 'stop'],
        ['max_tokens', 'length'],
        ['stop_sequence', 'stop'],
        ['tool_use', 'tool_calls']
      ] as const) {
        mockFetch({
          id: 'msg_1', type: 'message', model: 'test',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: input,
          usage: { input_tokens: 0, output_tokens: 0 }
        });
        const adapter = new AnthropicAdapter('key', 'https://test.api');
        const result = await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
        expect(result.stop_reason).toBe(expected);
        expect(result.finish_reason.raw).toBe(input);
      }
    });

    it('maps cache tokens in usage', async () => {
      mockFetch({
        id: 'msg_1', type: 'message', model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100, output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20
        }
      });

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      const result = await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      expect(result.usage.cache_write_tokens).toBe(10);
      expect(result.usage.cache_read_tokens).toBe(20);
    });
  });

  describe('error classification', () => {
    it('401 → AuthenticationError', async () => {
      mockFetch({}, { ok: false, status: 401 });
      const adapter = new AnthropicAdapter('bad-key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(AuthenticationError);
    });

    it('429 → RateLimitError', async () => {
      mockFetch({}, { ok: false, status: 429, headers: { 'retry-after': '5' } });
      const adapter = new AnthropicAdapter('key', 'https://test.api');
      try {
        await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        expect((err as RateLimitError).retry_after_ms).toBe(5000);
      }
    });

    it('429 with quota body → QuotaExceededError', async () => {
      mockFetch({ error: { type: 'insufficient_quota', message: 'quota exceeded' } }, { ok: false, status: 429 });
      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(QuotaExceededError);
    });

    it('529 → OverloadedError', async () => {
      mockFetch({}, { ok: false, status: 529 });
      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(OverloadedError);
    });

    it('529 with quota body → QuotaExceededError', async () => {
      mockFetch('quota exhausted', { ok: false, status: 529 });
      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(QuotaExceededError);
    });

    it('400 with context message → ContextWindowError', async () => {
      mockFetch('context length exceeded', { ok: false, status: 400 });
      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(ContextWindowError);
    });

    it('400 without context message → InvalidRequestError', async () => {
      mockFetch('bad field', { ok: false, status: 400 });
      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(InvalidRequestError);
    });
  });

  describe('streaming', () => {
    it('parses SSE stream into unified events', async () => {
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop"}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        'event: message_stop\ndata: {"type":"message_stop"}'
      ]);

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      const events: StreamEvent[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        events.push(event);
      }

      expect(events[0]!.type).toBe('stream_start');
      expect(events.some((e) => e.type === 'text_start')).toBe(true);
      expect(events.filter((e) => e.type === 'content_delta')).toHaveLength(2);
      expect(events.some((e) => e.type === 'text_end')).toBe(true);
      const end = events.find((e) => e.type === 'stream_end');
      expect(end).toBeDefined();
      if (end?.type === 'stream_end') {
        expect(end.stop_reason).toBe('end_turn');
        expect(end.response?.usage.total_tokens).toBe(12);
      }
    });

    it('emits thinking_start and thinking_end around thinking_delta', async () => {
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"thinking"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Analyzing..."}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop"}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        'event: message_stop\ndata: {"type":"message_stop"}'
      ]);

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      const events: StreamEvent[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
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

    it('emits tool_call_start/delta/end for tool blocks', async () => {
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":2,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool_1","name":"read_file"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop"}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
        'event: message_stop\ndata: {"type":"message_stop"}'
      ]);

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      const events: StreamEvent[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        events.push(event);
      }

      expect(events.some((event) => event.type === 'tool_call_start')).toBe(true);
      expect(events.some((event) => event.type === 'tool_call_delta')).toBe(true);
      expect(events.some((event) => event.type === 'tool_call_end')).toBe(true);
    });

    it('maps malformed SSE payloads to StreamError(sse_parse)', async () => {
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-20250514"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":'
      ]);

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      try {
        for await (const _event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
          // consume
        }
        expect.unreachable('expected stream parse failure');
      } catch (error) {
        expect(error).toBeInstanceOf(StreamError);
        expect((error as StreamError).phase).toBe('sse_parse');
      }
    });

    it('maps truncated streams to StreamError(transport)', async () => {
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-20250514"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}'
      ]);

      const adapter = new AnthropicAdapter('key', 'https://test.api');
      await expect(async () => {
        for await (const _event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
          // consume
        }
      }).rejects.toThrow(StreamError);
    });
  });
});
