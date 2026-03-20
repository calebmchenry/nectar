import { describe, expect, it } from 'vitest';
import {
  LLMError,
  AuthenticationError,
  RateLimitError,
  OverloadedError,
  InvalidRequestError,
  ContextWindowError,
  ContentFilterError,
  ConfigurationError,
  NetworkError,
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

  it('TimeoutError is retryable', () => {
    const err = new TimeoutError('gemini');
    expect(err.retryable).toBe(true);
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
