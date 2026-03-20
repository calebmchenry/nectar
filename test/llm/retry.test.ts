import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../../src/llm/retry.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { GenerateRequest, GenerateResponse } from '../../src/llm/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';
import {
  AuthenticationError,
  RateLimitError,
  OverloadedError,
  NetworkError
} from '../../src/llm/errors.js';

function mockAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    provider_name: 'test',
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

  it('throws last error when max retries exhausted', async () => {
    const adapter = mockAdapter({
      generate: vi.fn().mockRejectedValue(new RateLimitError('test'))
    });

    const wrapped = withRetry(adapter, { max_retries: 2, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    await expect(wrapped.generate(dummyRequest)).rejects.toThrow(RateLimitError);
    expect(adapter.generate).toHaveBeenCalledTimes(3); // initial + 2 retries
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
});
