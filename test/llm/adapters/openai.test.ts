import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenAIAdapter } from '../../../src/llm/adapters/openai.js';
import {
  AccessDeniedError,
  AuthenticationError,
  ContextLengthError,
  ContextWindowError,
  InvalidRequestError,
  NotFoundError,
  OverloadedError,
  QuotaExceededError,
  RateLimitError,
  RequestTimeoutError,
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
  describe('adapter capabilities', () => {
    it('supports all tool_choice modes', () => {
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      expect(adapter.supports_tool_choice('auto')).toBe(true);
      expect(adapter.supports_tool_choice('none')).toBe(true);
      expect(adapter.supports_tool_choice('required')).toBe(true);
      expect(adapter.supports_tool_choice('named')).toBe(true);
    });
  });

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
      expect(result.stop_reason).toBe('stop');
      expect(result.finish_reason.raw).toBe('completed');
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.total_tokens).toBe(15);

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

      expect(result.stop_reason).toBe('tool_calls');
      expect(result.finish_reason.raw).toBe('tool_use');
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
      expect(result.stop_reason).toBe('length');
      expect(result.finish_reason.raw).toBe('incomplete');
    });

    it('warn-skips unsupported AUDIO and DOCUMENT content parts', async () => {
      mockFetch({
        id: 'resp_1',
        model: 'gpt-4o',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const adapter = new OpenAIAdapter('key', 'https://test.api');
        await adapter.generate({
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

        const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
        expect(body.input).toEqual([
          {
            type: 'message',
            role: 'user',
            content: 'hello',
          },
        ]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('audio'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('document'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('serializes URL images as input_image parts', async () => {
      mockFetch({
        id: 'resp_1',
        model: 'gpt-4o',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        }],
        usage: { input_tokens: 1, output_tokens: 1 }
      });

      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this image' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/diagram.png' } },
          ],
        }],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.input[0].content).toEqual([
        { type: 'input_text', text: 'Analyze this image' },
        { type: 'input_image', image_url: 'https://example.com/diagram.png' },
      ]);
    });

    it('serializes base64 images as input_image source blocks', async () => {
      mockFetch({
        id: 'resp_1',
        model: 'gpt-4o',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        }],
        usage: { input_tokens: 1, output_tokens: 1 }
      });

      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await adapter.generate({
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
              },
            },
          ],
        }],
      });

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.input[0].content).toEqual([
        {
          type: 'input_image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          },
        },
      ]);
    });
  });

  describe('error classification', () => {
    it('408 → RequestTimeoutError', async () => {
      mockFetch({}, { ok: false, status: 408 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(RequestTimeoutError);
    });

    it('413 → ContextLengthError', async () => {
      mockFetch({}, { ok: false, status: 413 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(ContextLengthError);
    });

    it('422 → InvalidRequestError with status 422', async () => {
      mockFetch({ error: { message: 'unprocessable' } }, { ok: false, status: 422 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
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
      const adapter = new OpenAIAdapter('bad', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(AuthenticationError);
    });

    it('403 → AccessDeniedError', async () => {
      mockFetch({}, { ok: false, status: 403 });
      const adapter = new OpenAIAdapter('bad', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(AccessDeniedError);
    });

    it('404 → NotFoundError', async () => {
      mockFetch({}, { ok: false, status: 404 });
      const adapter = new OpenAIAdapter('bad', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(NotFoundError);
    });

    it('captures provider error_code/raw metadata', async () => {
      mockFetch({ error: { code: 'model_not_found', type: 'invalid_request_error' } }, { ok: false, status: 404 });
      const adapter = new OpenAIAdapter('bad', 'https://test.api');
      try {
        await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
        expect.unreachable('expected NotFoundError');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        expect((error as NotFoundError).error_code).toBe('model_not_found');
        expect((error as NotFoundError).raw).toEqual({ error: { code: 'model_not_found', type: 'invalid_request_error' } });
      }
    });

    it('429 → RateLimitError', async () => {
      mockFetch({}, { ok: false, status: 429 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(RateLimitError);
    });

    it('429 insufficient_quota → QuotaExceededError', async () => {
      mockFetch({ error: { type: 'insufficient_quota', message: 'Quota exceeded' } }, { ok: false, status: 429 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(QuotaExceededError);
    });

    it('503 → OverloadedError', async () => {
      mockFetch({}, { ok: false, status: 503 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(OverloadedError);
    });

    it('400 context-length message → ContextWindowError', async () => {
      mockFetch({ error: { message: 'maximum context length exceeded' } }, { ok: false, status: 400 });
      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
        .rejects.toThrow(ContextWindowError);
    });

    it('400 non-context message → InvalidRequestError', async () => {
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
        'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-4o"}}',
        'event: response.heartbeat\ndata: {"type":"response.heartbeat","heartbeat":true}',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"gpt-4o","usage":{"input_tokens":1,"output_tokens":1}}}',
      ]);

      const adapter = new OpenAIAdapter('key', 'https://test.api');
      const events: StreamEvent[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        events.push(event);
      }

      const providerEvent = events.find((event): event is Extract<StreamEvent, { type: 'provider_event' }> => event.type === 'provider_event');
      expect(providerEvent).toEqual({
        type: 'provider_event',
        provider: 'openai',
        provider_event: {
          type: 'response.heartbeat',
          data: { type: 'response.heartbeat', heartbeat: true },
        },
      });
    });

    it('emits thinking_start and thinking_end around reasoning deltas', async () => {
      sseResponse([
        'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-4o"}}',
        'event: response.reasoning_summary.delta\ndata: {"type":"response.reasoning_summary.delta","delta":"Thinking..."}',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Answer"}',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"gpt-4o","usage":{"input_tokens":5,"output_tokens":2}}}'
      ]);

      const adapter = new OpenAIAdapter('key', 'https://test.api');
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
        'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-4o"}}',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"fc_1","name":"read_file"}}',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":\\"README.md\\"}"}',
        'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done"}',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"gpt-4o","usage":{"input_tokens":2,"output_tokens":1}}}'
      ]);

      const adapter = new OpenAIAdapter('key', 'https://test.api');
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
        'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-4o"}}',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":'
      ]);

      const adapter = new OpenAIAdapter('key', 'https://test.api');
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
        'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-4o"}}',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}'
      ]);

      const adapter = new OpenAIAdapter('key', 'https://test.api');
      await expect(async () => {
        for await (const _event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
          // consume
        }
      }).rejects.toThrow(StreamError);
    });
  });
});
