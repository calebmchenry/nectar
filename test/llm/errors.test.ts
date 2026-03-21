import { describe, expect, it } from 'vitest';
import {
  LLMError,
  AuthenticationError,
  QuotaExceededError,
  RateLimitError,
  OverloadedError,
  InvalidRequestError,
  ContextWindowError,
  ContentFilterError,
  ConfigurationError,
  ContextLengthError,
  NetworkError,
  RequestTimeoutError,
  StreamError,
  TimeoutError,
  parseRetryAfterMs
} from '../../src/llm/errors.js';

describe('LLMError hierarchy', () => {
  it('AuthenticationError is not retryable', () => {
    const err = new AuthenticationError('anthropic');
    expect(err.retryable).toBe(false);
    expect(err.status_code).toBe(401);
    expect(err.provider).toBe('anthropic');
    expect(err).toBeInstanceOf(LLMError);
    expect(err).toBeInstanceOf(Error);
  });

  it('RateLimitError is retryable with retry_after_ms', () => {
    const err = new RateLimitError('openai', { retry_after_ms: 5000 });
    expect(err.retryable).toBe(true);
    expect(err.status_code).toBe(429);
    expect(err.retry_after_ms).toBe(5000);
  });

  it('QuotaExceededError is not retryable', () => {
    const err = new QuotaExceededError('openai');
    expect(err.retryable).toBe(false);
    expect(err.status_code).toBe(429);
  });

  it('OverloadedError is retryable', () => {
    const err = new OverloadedError('anthropic');
    expect(err.retryable).toBe(true);
    expect(err.status_code).toBe(503);
  });

  it('InvalidRequestError is not retryable', () => {
    const err = new InvalidRequestError('gemini');
    expect(err.retryable).toBe(false);
    expect(err.status_code).toBe(400);
  });

  it('ContextWindowError is not retryable', () => {
    const err = new ContextWindowError('openai');
    expect(err.retryable).toBe(false);
  });

  it('ContentFilterError is not retryable', () => {
    const err = new ContentFilterError('anthropic');
    expect(err.retryable).toBe(false);
  });

  it('NetworkError is retryable', () => {
    const err = new NetworkError('openai');
    expect(err.retryable).toBe(true);
    expect(err.status_code).toBeUndefined();
  });

  it('TimeoutError is not retryable', () => {
    const err = new TimeoutError('gemini');
    expect(err.retryable).toBe(false);
    expect(err.status_code).toBe(408);
  });

  it('RequestTimeoutError is non-retryable with status 408', () => {
    const err = new RequestTimeoutError('openai');
    expect(err.retryable).toBe(false);
    expect(err.status_code).toBe(408);
  });

  it('ContextLengthError is non-retryable with status 413', () => {
    const err = new ContextLengthError('anthropic');
    expect(err.retryable).toBe(false);
    expect(err.status_code).toBe(413);
  });

  it('StreamError is retryable and carries optional metadata', () => {
    const err = new StreamError('anthropic', {
      partial_content: 'hello',
      phase: 'idle_timeout',
    });
    expect(err.retryable).toBe(true);
    expect(err.partial_content).toBe('hello');
    expect(err.phase).toBe('idle_timeout');
  });

  it('ConfigurationError is not retryable and is instance of LLMError', () => {
    const err = new ConfigurationError();
    expect(err.retryable).toBe(false);
    expect(err).toBeInstanceOf(LLMError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ConfigurationError');
    expect(err.provider).toBe('none');
    expect(err.message).toContain('ANTHROPIC_API_KEY');
  });

  it('ConfigurationError accepts custom message', () => {
    const err = new ConfigurationError('Custom config error');
    expect(err.message).toBe('Custom config error');
    expect(err.retryable).toBe(false);
  });

  it('ConfigurationError is distinct from InvalidRequestError', () => {
    const config = new ConfigurationError();
    const invalid = new InvalidRequestError('test');
    expect(config).not.toBeInstanceOf(InvalidRequestError);
    expect(invalid).not.toBeInstanceOf(ConfigurationError);
  });

  it('LLMError carries error_code and raw metadata when provided', () => {
    const err = new LLMError('provider error', {
      provider: 'openai',
      retryable: false,
      status_code: 400,
      retry_after_ms: 2000,
      error_code: 'context_length_exceeded',
      raw: { error: { code: 'context_length_exceeded' } },
    });
    expect(err.retry_after_ms).toBe(2000);
    expect(err.error_code).toBe('context_length_exceeded');
    expect(err.raw).toEqual({ error: { code: 'context_length_exceeded' } });
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
  });

  it('parses decimal seconds', () => {
    expect(parseRetryAfterMs('1.5')).toBe(1500);
  });

  it('returns undefined for null', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it('returns undefined for invalid values', () => {
    expect(parseRetryAfterMs('not-a-number')).toBeUndefined();
  });

  it('returns undefined for zero', () => {
    expect(parseRetryAfterMs('0')).toBeUndefined();
  });
});
