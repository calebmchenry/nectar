import type { ProviderAdapter } from './adapters/types.js';
import type { GenerateRequest, GenerateResponse } from './types.js';
import type { StreamEvent } from './streaming.js';
import type { Middleware, GenerateFn, StreamFn } from './middleware.js';
import { LLMError, RateLimitError, TimeoutError } from './errors.js';
import { resolveTimeout } from './timeouts.js';

export interface RetryConfig {
  max_retries: number;
  base_delay_ms: number;
  max_delay_ms: number;
  jitter: boolean;
}

const DEFAULT_CONFIG: RetryConfig = {
  max_retries: 2,
  base_delay_ms: 1000,
  max_delay_ms: 60_000,
  jitter: true
};

function computeDelay(attempt: number, config: RetryConfig, retryAfterMs?: number): number {
  const exponential = Math.min(config.base_delay_ms * Math.pow(2, attempt - 1), config.max_delay_ms);
  const jitterFactor = config.jitter ? 0.5 + Math.random() : 1;
  const computed = exponential * jitterFactor;
  if (retryAfterMs !== undefined) {
    return Math.max(retryAfterMs, computed);
  }
  return computed;
}

function validateRetryAfterDelay(provider: string, retryAfterMs: number | undefined, maxDelayMs: number): void {
  if (retryAfterMs === undefined) {
    return;
  }
  if (retryAfterMs > maxDelayMs) {
    throw new RateLimitError(provider, {
      retry_after_ms: retryAfterMs,
      message: `Retry-After (${retryAfterMs}ms) exceeds max_delay_ms (${maxDelayMs}ms).`,
    });
  }
}

/**
 * Create a retry middleware with exponential backoff.
 * This is the preferred way to add retry behavior to the client.
 */
export function createRetryMiddleware(config?: Partial<RetryConfig>): Middleware {
  const cfg: RetryConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'retry',

    async generate(request: GenerateRequest, next: GenerateFn): Promise<GenerateResponse> {
      let lastError: LLMError | undefined;
      const timeout = resolveTimeout(request.timeout, request.timeout_ms);
      const startedAt = Date.now();

      const remainingBudgetMs = (): number => {
        return Math.max(0, timeout.request_ms - (Date.now() - startedAt));
      };

      for (let attempt = 0; attempt <= cfg.max_retries; attempt++) {
        const remainingBeforeAttempt = remainingBudgetMs();
        if (remainingBeforeAttempt <= 0) {
          throw new TimeoutError(request.provider ?? 'unknown', `Retry budget exhausted after ${timeout.request_ms}ms.`);
        }

        if (attempt > 0) {
          if (request.abort_signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          const retryAfter = lastError instanceof RateLimitError ? lastError.retry_after_ms : undefined;
          validateRetryAfterDelay(request.provider ?? lastError?.provider ?? 'unknown', retryAfter, cfg.max_delay_ms);
          const delay = computeDelay(attempt, cfg, retryAfter);
          if (delay >= remainingBeforeAttempt) {
            throw new TimeoutError(request.provider ?? 'unknown', `Retry budget exhausted after ${timeout.request_ms}ms.`);
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        try {
          const remaining = remainingBudgetMs();
          const attemptRequest: GenerateRequest = {
            ...request,
            timeout: { ...timeout, request_ms: remaining },
            timeout_ms: remaining,
          };
          return await next(attemptRequest);
        } catch (error) {
          if (error instanceof LLMError) {
            if (!error.retryable) throw error;
            lastError = error;
          } else {
            throw error;
          }
        }
      }

      throw lastError!;
    },

    async *stream(request: GenerateRequest, next: StreamFn): AsyncIterable<StreamEvent> {
      let lastError: LLMError | undefined;
      let yieldedContent = false;
      const timeout = resolveTimeout(request.timeout, request.timeout_ms);
      const startedAt = Date.now();

      const remainingBudgetMs = (): number => {
        return Math.max(0, timeout.request_ms - (Date.now() - startedAt));
      };

      for (let attempt = 0; attempt <= cfg.max_retries; attempt++) {
        const remainingBeforeAttempt = remainingBudgetMs();
        if (remainingBeforeAttempt <= 0) {
          throw new TimeoutError(request.provider ?? 'unknown', `Retry budget exhausted after ${timeout.request_ms}ms.`);
        }

        if (attempt > 0) {
          if (request.abort_signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          const retryAfter = lastError instanceof RateLimitError ? lastError.retry_after_ms : undefined;
          validateRetryAfterDelay(request.provider ?? lastError?.provider ?? 'unknown', retryAfter, cfg.max_delay_ms);
          const delay = computeDelay(attempt, cfg, retryAfter);
          if (delay >= remainingBeforeAttempt) {
            throw new TimeoutError(request.provider ?? 'unknown', `Retry budget exhausted after ${timeout.request_ms}ms.`);
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        try {
          yieldedContent = false;
          const remaining = remainingBudgetMs();
          const attemptRequest: GenerateRequest = {
            ...request,
            timeout: { ...timeout, request_ms: remaining },
            timeout_ms: remaining,
          };
          for await (const event of next(attemptRequest)) {
            if (event.type === 'content_delta' || event.type === 'tool_call_delta' || event.type === 'thinking_delta') {
              yieldedContent = true;
            }
            yield event;
          }
          return; // Stream completed successfully
        } catch (error) {
          if (error instanceof LLMError) {
            if (!error.retryable || yieldedContent) throw error;
            lastError = error;
          } else {
            throw error;
          }
        }
      }

      throw lastError!;
    }
  };
}

/**
 * @deprecated Use `createRetryMiddleware()` instead. This wrapper is kept for backward compatibility.
 */
export function withRetry(
  adapter: ProviderAdapter,
  config?: Partial<RetryConfig>
): ProviderAdapter {
  const middleware = createRetryMiddleware(config);

  return {
    get provider_name() {
      return adapter.provider_name;
    },

    async generate(request: GenerateRequest): Promise<GenerateResponse> {
      if (middleware.generate) {
        return middleware.generate(request, (req) => adapter.generate(req));
      }
      return adapter.generate(request);
    },

    async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
      if (middleware.stream) {
        yield* middleware.stream(request, (req) => adapter.stream(req));
      } else {
        yield* adapter.stream(request);
      }
    }
  };
}
