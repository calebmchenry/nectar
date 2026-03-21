import { describe, expect, it, vi, afterEach } from 'vitest';
import { GeminiAdapter } from '../../../src/llm/adapters/gemini.js';
import {
  AccessDeniedError,
  AuthenticationError,
  ContextLengthError,
  ContextWindowError,
  InvalidRequestError,
  OverloadedError,
  QuotaExceededError,
  RateLimitError,
  RequestTimeoutError,
  StreamError,
} from '../../../src/llm/errors.js';
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
  describe('adapter capabilities', () => {
    it('supports tool_choice auto/none/required but not named', () => {
      const adapter = new GeminiAdapter('key', 'https://test.api');
      expect(adapter.supports_tool_choice('auto')).toBe(true);
      expect(adapter.supports_tool_choice('none')).toBe(true);
      expect(adapter.supports_tool_choice('required')).toBe(true);
      expect(adapter.supports_tool_choice('named')).toBe(false);
    });
  });

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
      expect(result.stop_reason).toBe('stop');
      expect(result.finish_reason.raw).toBe('STOP');
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);
      expect(result.usage.total_tokens).toBe(15);

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

      expect(result.stop_reason).toBe('tool_calls');
      expect(result.finish_reason.raw).toBe('tool_use');
      const parts = result.message.content as Array<{ type: string; name?: string }>;
      expect(parts[0]!.type).toBe('tool_call');
      expect(parts[0]!.name).toBe('read_file');
    });

    it('assigns unique synthetic IDs for repeated function calls', async () => {
      mockFetch({
        candidates: [{
          content: {
            parts: [
              { functionCall: { name: 'grep', args: { pattern: 'a' } } },
              { functionCall: { name: 'grep', args: { pattern: 'b' } } },
            ]
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'run grep twice' }],
      });

      const parts = result.message.content as Array<{ type: string; id?: string; name?: string }>;
      expect(parts.map((part) => part.id)).toEqual(['call_0', 'call_1']);
      expect(parts.map((part) => part.name)).toEqual(['grep', 'grep']);
    });

    it('assigns sequential synthetic IDs across multiple function names', async () => {
      mockFetch({
        candidates: [{
          content: {
            parts: [
              { functionCall: { name: 'read_file', args: { path: 'a' } } },
              { functionCall: { name: 'grep', args: { pattern: 'todo' } } },
              { functionCall: { name: 'write_file', args: { path: 'b', content: 'x' } } },
            ]
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'run tools' }],
      });

      const parts = result.message.content as Array<{ type: string; id?: string; name?: string }>;
      expect(parts.map((part) => part.id)).toEqual(['call_0', 'call_1', 'call_2']);
      expect(parts.map((part) => part.name)).toEqual(['read_file', 'grep', 'write_file']);
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
      expect(result.stop_reason).toBe('length');
      expect(result.finish_reason.raw).toBe('MAX_TOKENS');
    });

    it('maps RECITATION finish reason to content_filter', async () => {
      mockFetch({
        candidates: [{
          content: { parts: [{ text: 'blocked' }] },
          finishReason: 'RECITATION'
        }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      const result = await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      expect(result.finish_reason.reason).toBe('content_filter');
      expect(result.finish_reason.raw).toBe('RECITATION');
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

    it('serializes AUDIO and DOCUMENT as inlineData', async () => {
      mockFetch({
        candidates: [{
          content: { parts: [{ text: 'ok' }] },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [{
          role: 'user',
          content: [
            {
              type: 'audio',
              source: {
                media_type: 'audio/mpeg',
                data: 'SUQz',
              },
            },
            {
              type: 'document',
              source: {
                media_type: 'application/pdf',
                data: 'JVBERi0xLjQK',
              },
            },
          ],
        }],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.contents[0].parts).toEqual([
        { inlineData: { mimeType: 'audio/mpeg', data: 'SUQz' } },
        { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0xLjQK' } },
      ]);
    });

    it('serializes AUDIO and DOCUMENT URLs as fileData', async () => {
      mockFetch({
        candidates: [{
          content: { parts: [{ text: 'ok' }] },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [{
          role: 'user',
          content: [
            {
              type: 'audio',
              source: {
                media_type: 'audio/mpeg',
                url: 'gs://bucket/audio.mp3',
              },
            },
            {
              type: 'document',
              source: {
                media_type: 'application/pdf',
                url: 'gs://bucket/doc.pdf',
              },
            },
          ],
        }],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.contents[0].parts).toEqual([
        { fileData: { mimeType: 'audio/mpeg', fileUri: 'gs://bucket/audio.mp3' } },
        { fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/doc.pdf' } },
      ]);
    });

    it('serializes base64 images as inlineData', async () => {
      mockFetch({
        candidates: [{
          content: { parts: [{ text: 'ok' }] },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
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
      expect(body.contents[0].parts).toEqual([
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          },
        },
      ]);
    });

    it('serializes URL images as fileData', async () => {
      mockFetch({
        candidates: [{
          content: { parts: [{ text: 'ok' }] },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 }
      });

      const adapter = new GeminiAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.com/photo.jpeg',
            },
          }],
        }],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.contents[0].parts).toEqual([
        {
          fileData: {
            mimeType: 'image/jpeg',
            fileUri: 'https://example.com/photo.jpeg',
          },
        },
      ]);
    });

    it('maps tool_result call IDs back to function names', async () => {
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
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'call_0', name: 'grep', arguments: '{"pattern":"x"}' }],
          },
          {
            role: 'tool',
            content: [{ type: 'tool_result', tool_call_id: 'call_0', content: 'result', is_error: false }],
          },
        ],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.contents[1].parts).toEqual([
        {
          functionResponse: {
            name: 'grep',
            response: { content: 'result' },
          },
        },
      ]);
    });
  });

  describe('error classification', () => {
    it('408 → RequestTimeoutError', async () => {
      mockFetch({}, { ok: false, status: 408 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(RequestTimeoutError);
    });

    it('413 → ContextLengthError', async () => {
      mockFetch({}, { ok: false, status: 413 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(ContextLengthError);
    });

    it('422 → InvalidRequestError with status 422', async () => {
      mockFetch({ error: { message: 'unprocessable' } }, { ok: false, status: 422 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      try {
        await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
        expect.unreachable('expected InvalidRequestError');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidRequestError);
        expect((error as InvalidRequestError).status_code).toBe(422);
      }
    });

    it('401 → AuthenticationError', async () => {
      mockFetch({}, { ok: false, status: 401 });
      const adapter = new GeminiAdapter('bad', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(AuthenticationError);
    });

    it('403 → AccessDeniedError', async () => {
      mockFetch({}, { ok: false, status: 403 });
      const adapter = new GeminiAdapter('bad', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(AccessDeniedError);
    });

    it('captures provider error_code/raw metadata', async () => {
      mockFetch({ error: { status: 'PERMISSION_DENIED', code: 'PERMISSION_DENIED' } }, { ok: false, status: 403 });
      const adapter = new GeminiAdapter('bad', 'https://test.api');
      try {
        await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
        expect.unreachable('expected AccessDeniedError');
      } catch (error) {
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect((error as AccessDeniedError).error_code).toBe('PERMISSION_DENIED');
        expect((error as AccessDeniedError).raw).toEqual({ error: { status: 'PERMISSION_DENIED', code: 'PERMISSION_DENIED' } });
      }
    });

    it('429 → RateLimitError', async () => {
      mockFetch({}, { ok: false, status: 429 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(RateLimitError);
    });

    it('429 RESOURCE_EXHAUSTED quota → QuotaExceededError', async () => {
      mockFetch({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exhausted' } }, { ok: false, status: 429 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(QuotaExceededError);
    });

    it('503 → OverloadedError', async () => {
      mockFetch({}, { ok: false, status: 503 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(OverloadedError);
    });

    it('400 context-length message → ContextWindowError', async () => {
      mockFetch({ error: { message: 'request exceeds the maximum context window' } }, { ok: false, status: 400 });
      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(ContextWindowError);
    });

    it('400 non-context message → InvalidRequestError', async () => {
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
      expect(events.some((e) => e.type === 'text_start')).toBe(true);
      expect(events.filter((e) => e.type === 'content_delta')).toHaveLength(2);
      expect(events.some((e) => e.type === 'text_end')).toBe(true);
      const textStart = events.find((e): e is Extract<StreamEvent, { type: 'text_start' }> => e.type === 'text_start');
      expect(textStart?.text_id).toBe('text_0');
      const deltas = events.filter((e): e is Extract<StreamEvent, { type: 'content_delta' }> => e.type === 'content_delta');
      expect(deltas.every((event) => event.text_id === 'text_0')).toBe(true);
      const textEnd = events.find((e): e is Extract<StreamEvent, { type: 'text_end' }> => e.type === 'text_end');
      expect(textEnd?.text_id).toBe('text_0');
      const end = events.find((e) => e.type === 'stream_end');
      expect(end).toBeDefined();
      if (end?.type === 'stream_end') {
        expect(end.response?.usage.total_tokens).toBe(7);
      }
    });

    it('emits provider_event for unknown provider stream events', async () => {
      sseResponse([
        'event: ping\ndata: {"type":"ping","heartbeat":true}',
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}',
      ]);

      const adapter = new GeminiAdapter('key', 'https://test.api');
      const events: StreamEvent[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        events.push(event);
      }

      const providerEvent = events.find((event): event is Extract<StreamEvent, { type: 'provider_event' }> => event.type === 'provider_event');
      expect(providerEvent).toEqual({
        type: 'provider_event',
        provider: 'gemini',
        provider_event: {
          type: 'ping',
          data: { type: 'ping', heartbeat: true },
        },
      });
    });

    it('emits thinking_start and thinking_end around thought deltas', async () => {
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Reasoning","thought":true}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}',
        'data: {"candidates":[{"content":{"parts":[{"text":"Answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}'
      ]);

      const adapter = new GeminiAdapter('key', 'https://test.api');
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

    it('emits tool_call_start/delta/end for function calls', async () => {
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"README.md"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1}}'
      ]);

      const adapter = new GeminiAdapter('key', 'https://test.api');
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
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}',
        'data: {"candidates":'
      ]);

      const adapter = new GeminiAdapter('key', 'https://test.api');
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
        'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}'
      ]);

      const adapter = new GeminiAdapter('key', 'https://test.api');
      await expect(async () => {
        for await (const _event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
          // consume
        }
      }).rejects.toThrow(StreamError);
    });

    it('maps RECITATION stream finish reason to content_filter response reason', async () => {
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"blocked"}]},"finishReason":"RECITATION"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}'
      ]);

      const adapter = new GeminiAdapter('key', 'https://test.api');
      const events: StreamEvent[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        events.push(event);
      }

      const end = events.find((event) => event.type === 'stream_end');
      expect(end?.type).toBe('stream_end');
      if (end?.type === 'stream_end') {
        expect(end.response.finish_reason.reason).toBe('content_filter');
        expect(end.response.finish_reason.raw).toBe('RECITATION');
      }
    });
  });
});
