import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '../../../src/llm/adapters/openai-compatible.js';
import { ContextLengthError, InvalidRequestError, RequestTimeoutError } from '../../../src/llm/errors.js';
import type { StreamEvent } from '../../../src/llm/streaming.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: unknown, opts?: { ok?: boolean; status?: number; headers?: Record<string, string> }) {
  const ok = opts?.ok ?? true;
  const status = opts?.status ?? 200;
  const headers = new Headers(opts?.headers ?? {});

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    headers,
    json: async () => response,
    text: async () => JSON.stringify(response),
  } as unknown as Response);
}

function sseResponse(events: string[]) {
  const text = `${events.join('\n\n')}\n\n`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: stream,
  } as unknown as Response);
}

describe('OpenAICompatibleAdapter capabilities', () => {
  it('supports default tool_choice modes auto/none', () => {
    const adapter = new OpenAICompatibleAdapter('test-key', 'https://test.api');
    expect(adapter.supports_tool_choice('auto')).toBe(true);
    expect(adapter.supports_tool_choice('none')).toBe(true);
    expect(adapter.supports_tool_choice('required')).toBe(false);
    expect(adapter.supports_tool_choice('named')).toBe(false);
  });

  it('supports configured tool_choice modes', () => {
    const adapter = new OpenAICompatibleAdapter('test-key', 'https://test.api', ['auto', 'none', 'required', 'named']);
    expect(adapter.supports_tool_choice('auto')).toBe(true);
    expect(adapter.supports_tool_choice('none')).toBe(true);
    expect(adapter.supports_tool_choice('required')).toBe(true);
    expect(adapter.supports_tool_choice('named')).toBe(true);
  });
});

describe('OpenAICompatibleAdapter error classification', () => {
  it('maps HTTP 408 to RequestTimeoutError', async () => {
    mockFetch({ error: { message: 'request timed out' } }, { ok: false, status: 408 });

    const adapter = new OpenAICompatibleAdapter('test-key', 'https://test.api');
    await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
      .rejects.toThrow(RequestTimeoutError);
  });

  it('maps HTTP 413 to ContextLengthError', async () => {
    mockFetch({ error: { message: 'context too long' } }, { ok: false, status: 413 });

    const adapter = new OpenAICompatibleAdapter('test-key', 'https://test.api');
    await expect(adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] }))
      .rejects.toThrow(ContextLengthError);
  });

  it('maps HTTP 422 to InvalidRequestError with status 422', async () => {
    mockFetch({ error: { message: 'unprocessable' } }, { ok: false, status: 422 });

    const adapter = new OpenAICompatibleAdapter('test-key', 'https://test.api');
    try {
      await adapter.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      expect.unreachable('expected InvalidRequestError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as InvalidRequestError).status_code).toBe(422);
    }
  });
});

describe('OpenAICompatibleAdapter streaming', () => {
  it('emits text_id on text events and provider_event for unknown chunks', async () => {
    sseResponse([
      'event: message\ndata: {"id":"chatcmpl-1","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      'event: heartbeat\ndata: {"type":"heartbeat","tick":1}',
      'event: message\ndata: {"id":"chatcmpl-1","model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      'data: [DONE]',
    ]);

    const adapter = new OpenAICompatibleAdapter('test-key', 'https://test.api');
    const events: StreamEvent[] = [];
    for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      events.push(event);
    }

    const textStart = events.find((event): event is Extract<StreamEvent, { type: 'text_start' }> => event.type === 'text_start');
    expect(textStart?.text_id).toBe('text_0');
    const deltas = events.filter((event): event is Extract<StreamEvent, { type: 'content_delta' }> => event.type === 'content_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.text_id).toBe('text_0');
    const textEnd = events.find((event): event is Extract<StreamEvent, { type: 'text_end' }> => event.type === 'text_end');
    expect(textEnd?.text_id).toBe('text_0');

    const providerEvent = events.find((event): event is Extract<StreamEvent, { type: 'provider_event' }> => event.type === 'provider_event');
    expect(providerEvent).toEqual({
      type: 'provider_event',
      provider: 'openai_compatible',
      provider_event: {
        type: 'heartbeat',
        data: { type: 'heartbeat', tick: 1 },
      },
    });
  });
});
