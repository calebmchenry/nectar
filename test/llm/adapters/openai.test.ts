import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenAIAdapter } from '../../../src/llm/adapters/openai.js';
import { AuthenticationError, RateLimitError, OverloadedError, InvalidRequestError } from '../../../src/llm/errors.js';
import type { StreamEvent } from '../../../src/llm/streaming.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(response: unknown, opts?: { ok?: boolean; status?: number; headers?: Record<string, string> }) {
  const ok = opts?.ok ?? true;
  const status = opts?.status ?? 200;
  const headers = new Headers(opts?.headers ?? {});

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok, status, headers,
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
    ok: true, status: 200,
    headers: new Headers(),
    body: stream
  } as unknown as Response);
}

describe('OpenAIAdapter', () => {
  describe('generate', () => {
    it('sends correct request and translates response', async () => {
      mockFetch({
        id: 'resp_1',
        model: 'gpt-4o',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello!' }]
        }],
        usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } }
      });

      const adapter = new OpenAIAdapter('test-key', 'https://test.api');
      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-4o',
        max_tokens: 1024
      });

      expect(result.provider).toBe('openai');
      expect(result.stop_reason).toBe('end_turn');
      expect(result.usage.input_tokens).toBe(10);

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toBe('https://test.api/v1/responses');
      expect(call[1].headers['Authorization']).toBe('Bearer test-key');
    });

    it('translates function_call output to tool_call parts', async () => {
      mockFetch({
        id: 'resp_1',
        model: 'gpt-4o',
        status: 'completed',
        output: [{
          type: 'function_call',
          id: 'fc_1',
          call_id: 'fc_1',
          name: 'read_file',
          arguments: '{"path":"/test"}'
        }],
        usage: { input_tokens: 5, output_tokens: 10 }
      });

      const adapter = new OpenAIAdapter('key', 'https://test.api');
      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'Read it' }],
        tools: [{ name: 'read_file', description: 'Read', input_schema: {} }]
      });

      expect(result.stop_reason).toBe('tool_use');
      const parts = result.message.content as Array<{ type: string; name?: string }>;
      expect(parts[0]!.type).toBe('tool_call');
      expect(parts[0]!.name).toBe('read_file');
    });

    it('tracks reasoning tokens', async () => {
      mockFetch({
        id: 'resp_1', model: 'o1', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 10, output_tokens: 50, output_tokens_details: { reasoning_tokens: 40 } }
      });

      const adapter = new OpenAIAdapter('key', 'https://test.api');
      const result = await adapter.generate({ messages: [{ role: 'user', content: 'Think' }] });
      expect(result.usage.reasoning_tokens).toBe(40);
    });

    it('translates stop reasons correctly', async () => {
      mockFetch({
        id: 'resp_1', model: 'gpt-4o', status: 'incomplete',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'cut' }] }],
        usage: { input_tokens: 0, output_tokens: 0 }
      });

      const adapter = new OpenAIAdapter('key', 'https://test.api');
      const result = await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      expect(result.stop_reason).toBe('max_tokens');
    });
  });

  describe('error classification', () => {
    it('401 → AuthenticationError', async () => {
      mockFetch({}, { ok: false, status: 401 });
      const adapter = new OpenAIAdapter('bad', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(AuthenticationError);
    });

    it('429 → RateLimitError', async () => {
      mockFetch({}, { ok: false, status: 429 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(RateLimitError);
    });

    it('503 → OverloadedError', async () => {
      mockFetch({}, { ok: false, status: 503 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(OverloadedError);
    });

    it('400 → InvalidRequestError', async () => {
      mockFetch({}, { ok: false, status: 400 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(InvalidRequestError);
    });
  });

  describe('streaming', () => {
    it('parses SSE stream into unified events', async () => {
      sseResponse([
        'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-4o"}}',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"gpt-4o","usage":{"input_tokens":5,"output_tokens":2}}}'
      ]);

      const adapter = new OpenAIAdapter('key', 'https://test.api');
      const events: StreamEvent[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        events.push(event);
      }

      expect(events[0]!.type).toBe('stream_start');
      expect(events.filter((e) => e.type === 'content_delta')).toHaveLength(2);
      const end = events.find((e) => e.type === 'stream_end');
      expect(end).toBeDefined();
    });
  });
});
