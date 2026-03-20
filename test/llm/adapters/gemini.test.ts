import { describe, expect, it, vi, afterEach } from 'vitest';
import { GeminiAdapter } from '../../../src/llm/adapters/gemini.js';
import { AuthenticationError, RateLimitError, OverloadedError, InvalidRequestError } from '../../../src/llm/errors.js';
import type { StreamEvent } from '../../../src/llm/streaming.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(response: unknown, opts?: { ok?: boolean; status?: number }) {
  const ok = opts?.ok ?? true;
  const status = opts?.status ?? 200;

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok, status,
    headers: new Headers(),
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

describe('GeminiAdapter', () => {
  describe('generate', () => {
    it('sends correct request and translates response', async () => {
      mockFetch({
        candidates: [{
          content: { parts: [{ text: 'Hello!' }] },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
      });

      const adapter = new GeminiAdapter('test-key', 'https://test.api');
      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gemini-2.5-flash'
      });

      expect(result.provider).toBe('gemini');
      expect(result.stop_reason).toBe('end_turn');
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
      expect(call[0]).toContain('key=test-key');
    });

    it('translates function calls', async () => {
      mockFetch({
        candidates: [{
          content: {
            parts: [{ functionCall: { name: 'read_file', args: { path: '/test' } } }]
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'Read it' }],
        tools: [{ name: 'read_file', description: 'Read', input_schema: {} }]
      });

      expect(result.stop_reason).toBe('tool_use');
      const parts = result.message.content as Array<{ type: string; name?: string }>;
      expect(parts[0]!.type).toBe('tool_call');
      expect(parts[0]!.name).toBe('read_file');
    });

    it('extracts thinking tokens', async () => {
      mockFetch({
        candidates: [{
          content: {
            parts: [
              { text: 'thinking about it...', thought: true },
              { text: 'Here is my answer' }
            ]
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 15 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      const result = await adapter.generate({ messages: [{ role: 'user', content: 'Think' }] });
      expect(result.usage.reasoning_tokens).toBe(15);

      const parts = result.message.content as Array<{ type: string }>;
      expect(parts[0]!.type).toBe('thinking');
      expect(parts[1]!.type).toBe('text');
    });

    it('translates stop reasons', async () => {
      mockFetch({
        candidates: [{
          content: { parts: [{ text: 'cut' }] },
          finishReason: 'MAX_TOKENS'
        }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      const result = await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      expect(result.stop_reason).toBe('max_tokens');
    });

    it('passes system instruction separately', async () => {
      mockFetch({
        candidates: [{
          content: { parts: [{ text: 'ok' }] },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hi' }
        ]
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.system_instruction).toEqual({ parts: [{ text: 'Be helpful' }] });
      expect(body.contents).toHaveLength(1);
    });
  });

  describe('error classification', () => {
    it('401 → AuthenticationError', async () => {
      mockFetch({}, { ok: false, status: 401 });
      const adapter = new GeminiAdapter('bad', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(AuthenticationError);
    });

    it('403 → AuthenticationError', async () => {
      mockFetch({}, { ok: false, status: 403 });
      const adapter = new GeminiAdapter('bad', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(AuthenticationError);
    });

    it('429 → RateLimitError', async () => {
      mockFetch({}, { ok: false, status: 429 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(RateLimitError);
    });

    it('503 → OverloadedError', async () => {
      mockFetch({}, { ok: false, status: 503 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(OverloadedError);
    });

    it('400 → InvalidRequestError', async () => {
      mockFetch({}, { ok: false, status: 400 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(InvalidRequestError);
    });
  });

  describe('streaming', () => {
    it('parses SSE stream into unified events', async () => {
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}',
        'data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}'
      ]);

      const adapter = new GeminiAdapter('key', 'https://test.api');
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
