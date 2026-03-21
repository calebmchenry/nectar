import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../../src/llm/retry.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { GenerateRequest, GenerateResponse } from '../../src/llm/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';
import {
  AuthenticationError,
  QuotaExceededError,
  RateLimitError,
  OverloadedError,
  NetworkError,
  ServerError,
  StreamError,
  TimeoutError,
} from '../../src/llm/errors.js';

function mockAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    provider_name: 'test',
    supports_tool_choice: () => true,
    generate: vi.fn(),
    async *stream() { /* empty */ },
    ...overrides
  };
}

const dummyRequest: GenerateRequest = {
  messages: [{ role: 'user', content: 'hello' }]
};

const dummyResponse: GenerateResponse = {
  message: { role: 'assistant', content: 'hi' },
  usage: { input_tokens: 1, output_tokens: 1 },
  stop_reason: 'end_turn',
  model: 'test',
  provider: 'test'
};

describe('withRetry', () => {
  it('returns result on success without retry', async () => {
    const adapter = mockAdapter({
      generate: vi.fn().mockResolvedValue(dummyResponse)
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const result = await wrapped.generate(dummyRequest);
    expect(result).toBe(dummyResponse);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('retries on RateLimitError (429)', async () => {
    const adapter = mockAdapter({
      generate: vi.fn()
        .mockRejectedValueOnce(new RateLimitError('test'))
        .mockResolvedValueOnce(dummyResponse)
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const result = await wrapped.generate(dummyRequest);
    expect(result).toBe(dummyResponse);
    expect(adapter.generate).toHaveBeenCalledTimes(2);
  });

  it('retries on OverloadedError (503)', async () => {
    const adapter = mockAdapter({
      generate: vi.fn()
        .mockRejectedValueOnce(new OverloadedError('test'))
        .mockResolvedValueOnce(dummyResponse)
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const result = await wrapped.generate(dummyRequest);
    expect(result).toBe(dummyResponse);
    expect(adapter.generate).toHaveBeenCalledTimes(2);
  });

  it('retries on NetworkError', async () => {
    const adapter = mockAdapter({
      generate: vi.fn()
        .mockRejectedValueOnce(new NetworkError('test'))
        .mockResolvedValueOnce(dummyResponse)
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const result = await wrapped.generate(dummyRequest);
    expect(result).toBe(dummyResponse);
  });

  it('does NOT retry on AuthenticationError (401)', async () => {
    const adapter = mockAdapter({
      generate: vi.fn().mockRejectedValue(new AuthenticationError('test'))
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    await expect(wrapped.generate(dummyRequest)).rejects.toThrow(AuthenticationError);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on QuotaExceededError', async () => {
    const adapter = mockAdapter({
      generate: vi.fn().mockRejectedValue(new QuotaExceededError('test'))
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    await expect(wrapped.generate(dummyRequest)).rejects.toThrow(QuotaExceededError);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on TimeoutError', async () => {
    const adapter = mockAdapter({
      generate: vi.fn().mockRejectedValue(new TimeoutError('test'))
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    await expect(wrapped.generate(dummyRequest)).rejects.toThrow(TimeoutError);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('retries stream on StreamError before any content is yielded', async () => {
    let callCount = 0;
    const adapter = mockAdapter({
      async *stream(): AsyncIterable<StreamEvent> {
        callCount += 1;
        throw new StreamError('test', { phase: 'transport' });
      }
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    await expect(async () => {
      for await (const _event of wrapped.stream(dummyRequest)) {
        // no-op
      }
    }).rejects.toThrow(StreamError);
    expect(callCount).toBe(4); // initial + 3 retries
  });

  it('throws last error when max retries exhausted', async () => {
    const adapter = mockAdapter({
      generate: vi.fn().mockRejectedValue(new RateLimitError('test'))
    });

    const wrapped = withRetry(adapter, { max_retries: 2, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    await expect(wrapped.generate(dummyRequest)).rejects.toThrow(RateLimitError);
    expect(adapter.generate).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('uses default max_retries=2 and base_delay_ms=1000', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const adapter = mockAdapter({
        generate: vi.fn().mockRejectedValue(new RateLimitError('test'))
      });

      const wrapped = withRetry(adapter, { jitter: false });
      const pendingAssertion = expect(wrapped.generate(dummyRequest)).rejects.toThrow(RateLimitError);
      await vi.runAllTimersAsync();

      await pendingAssertion;
      expect(adapter.generate).toHaveBeenCalledTimes(3); // initial + 2 retries

      const numericDelays = timeoutSpy.mock.calls
        .map((call) => call[1])
        .filter((value): value is number => typeof value === 'number');
      expect(numericDelays).toEqual(expect.arrayContaining([1000, 2000]));
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('respects Retry-After from RateLimitError', async () => {
    const adapter = mockAdapter({
      generate: vi.fn()
        .mockRejectedValueOnce(new RateLimitError('test', { retry_after_ms: 50 }))
        .mockResolvedValueOnce(dummyResponse)
    });

    const start = Date.now();
    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 100, jitter: false });
    await wrapped.generate(dummyRequest);
    const elapsed = Date.now() - start;
    // Should have waited at least the retry_after_ms
    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some timing slack
  });

  it('respects retry_after_ms on any retryable provider error', async () => {
    const adapter = mockAdapter({
      generate: vi.fn()
        .mockRejectedValueOnce(new ServerError('test', { status_code: 503, retry_after_ms: 40 }))
        .mockResolvedValueOnce(dummyResponse),
    });

    const start = Date.now();
    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 100, jitter: false });
    await wrapped.generate(dummyRequest);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it('invokes on_retry(error, attempt, delay) before each retry sleep', async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    try {
      const adapter = mockAdapter({
        generate: vi.fn()
          .mockRejectedValueOnce(new RateLimitError('test'))
          .mockRejectedValueOnce(new NetworkError('test'))
          .mockResolvedValueOnce(dummyResponse),
      });

      const wrapped = withRetry(adapter, {
        max_retries: 3,
        base_delay_ms: 100,
        max_delay_ms: 1000,
        jitter: false,
        on_retry: onRetry,
      });

      const pending = wrapped.generate(dummyRequest);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBe(dummyResponse);

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry.mock.calls[0]?.[0]).toBeInstanceOf(RateLimitError);
      expect(onRetry.mock.calls[0]?.[1]).toBe(1);
      expect(onRetry.mock.calls[0]?.[2]).toBe(100);
      expect(onRetry.mock.calls[1]?.[0]).toBeInstanceOf(NetworkError);
      expect(onRetry.mock.calls[1]?.[1]).toBe(2);
      expect(onRetry.mock.calls[1]?.[2]).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when Retry-After exceeds max_delay_ms', async () => {
    const adapter = mockAdapter({
      generate: vi.fn().mockRejectedValue(new RateLimitError('test', { retry_after_ms: 120 })),
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 30, jitter: false });
    await expect(wrapped.generate(dummyRequest)).rejects.toThrow(RateLimitError);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('abort cancels retry loop', async () => {
    const controller = new AbortController();
    const adapter = mockAdapter({
      generate: vi.fn().mockRejectedValue(new RateLimitError('test'))
    });

    const wrapped = withRetry(adapter, { max_retries: 5, base_delay_ms: 100, max_delay_ms: 1000, jitter: false });

    // Abort after a short delay
    setTimeout(() => controller.abort(), 10);

    await expect(
      wrapped.generate({ ...dummyRequest, abort_signal: controller.signal })
    ).rejects.toThrow();
  });

  it('respects total timeout budget across retries', async () => {
    const adapter = mockAdapter({
      generate: vi.fn().mockRejectedValue(new RateLimitError('test'))
    });

    const wrapped = withRetry(adapter, { max_retries: 5, base_delay_ms: 50, max_delay_ms: 50, jitter: false });
    await expect(
      wrapped.generate({
        ...dummyRequest,
        timeout: { request_ms: 20 },
      })
    ).rejects.toThrow(TimeoutError);

    // Initial attempt runs, then retry budget check fails before sleeping.
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('stream retries before first content delta', async () => {
    let callCount = 0;
    const adapter = mockAdapter({
      async *stream(_req: GenerateRequest): AsyncIterable<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          throw new NetworkError('test');
        }
        yield { type: 'stream_start', model: 'test' };
        yield { type: 'content_delta', text: 'hello' };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'hello' } };
      }
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const events: StreamEvent[] = [];
    for await (const event of wrapped.stream(dummyRequest)) {
      events.push(event);
    }
    expect(callCount).toBe(2);
    expect(events.some((e) => e.type === 'content_delta')).toBe(true);
  });

  it('stream does NOT retry after content has been yielded', async () => {
    let callCount = 0;
    const adapter = mockAdapter({
      async *stream(_req: GenerateRequest): AsyncIterable<StreamEvent> {
        callCount++;
        yield { type: 'stream_start', model: 'test' };
        yield { type: 'content_delta', text: 'partial' };
        throw new NetworkError('test');
      }
    });

    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const event of wrapped.stream(dummyRequest)) {
        events.push(event);
      }
    }).rejects.toThrow(NetworkError);
    expect(callCount).toBe(1);
  });

  it('preserves provider_name', () => {
    const adapter = mockAdapter();
    const wrapped = withRetry(adapter);
    expect(wrapped.provider_name).toBe('test');
  });

  it('forwards lifecycle and tool-choice capability methods', async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const supports = vi.fn((mode: 'auto' | 'none' | 'required' | 'named') => mode !== 'named');
    const adapter = mockAdapter({
      initialize,
      close,
      supports_tool_choice: supports,
      generate: vi.fn().mockResolvedValue(dummyResponse),
    });
    const wrapped = withRetry(adapter);

    await wrapped.initialize?.();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(wrapped.supports_tool_choice('auto')).toBe(true);
    expect(wrapped.supports_tool_choice('named')).toBe(false);
    expect(supports).toHaveBeenCalledWith('auto');
    expect(supports).toHaveBeenCalledWith('named');
    await wrapped.close?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('request.max_retries overrides configured max_retries', async () => {
    const adapter = mockAdapter({
      generate: vi.fn()
        .mockRejectedValueOnce(new RateLimitError('test'))
        .mockResolvedValueOnce(dummyResponse),
    });
    const wrapped = withRetry(adapter, { max_retries: 0, base_delay_ms: 1, max_delay_ms: 10, jitter: false });

    const result = await wrapped.generate({
      ...dummyRequest,
      max_retries: 1,
    });

    expect(result).toBe(dummyResponse);
    expect(adapter.generate).toHaveBeenCalledTimes(2);
  });

  it('request.max_retries=0 disables retries even when global config allows them', async () => {
    const adapter = mockAdapter({
      generate: vi.fn().mockRejectedValue(new RateLimitError('test')),
    });
    const wrapped = withRetry(adapter, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });

    await expect(wrapped.generate({ ...dummyRequest, max_retries: 0 })).rejects.toThrow(RateLimitError);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });
});
