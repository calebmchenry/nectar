import { describe, expect, it } from 'vitest';
import { parseRateLimitHeaders } from '../../src/llm/rate-limit.js';

function makeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe('parseRateLimitHeaders', () => {
  it('parses full standard x-ratelimit- header set', () => {
    const headers = makeHeaders({
      'x-ratelimit-remaining-requests': '95',
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-tokens': '45000',
      'x-ratelimit-limit-tokens': '50000',
      'x-ratelimit-reset-requests': '2025-06-01T00:00:00Z',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.requests_remaining).toBe(95);
    expect(info!.requests_limit).toBe(100);
    expect(info!.tokens_remaining).toBe(45000);
    expect(info!.tokens_limit).toBe(50000);
    expect(info!.reset_at).toBeInstanceOf(Date);
  });

  it('parses partial headers — only populated fields', () => {
    const headers = makeHeaders({
      'x-ratelimit-remaining-requests': '42',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.requests_remaining).toBe(42);
    expect(info!.requests_limit).toBeUndefined();
    expect(info!.tokens_remaining).toBeUndefined();
    expect(info!.tokens_limit).toBeUndefined();
    expect(info!.reset_at).toBeUndefined();
  });

  it('returns undefined when no rate-limit headers present', () => {
    const headers = makeHeaders({
      'content-type': 'application/json',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeUndefined();
  });

  it('parses Anthropic-prefixed headers', () => {
    const headers = makeHeaders({
      'anthropic-ratelimit-remaining-requests': '10',
      'anthropic-ratelimit-limit-requests': '50',
      'anthropic-ratelimit-remaining-tokens': '80000',
      'anthropic-ratelimit-limit-tokens': '100000',
    });

    const info = parseRateLimitHeaders(headers, 'anthropic-ratelimit-');
    expect(info).toBeDefined();
    expect(info!.requests_remaining).toBe(10);
    expect(info!.requests_limit).toBe(50);
    expect(info!.tokens_remaining).toBe(80000);
    expect(info!.tokens_limit).toBe(100000);
  });

  it('parses reset_at from ISO 8601 date', () => {
    const headers = makeHeaders({
      'x-ratelimit-reset-requests': '2025-06-15T12:30:00.000Z',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.reset_at).toBeInstanceOf(Date);
    expect(info!.reset_at!.toISOString()).toBe('2025-06-15T12:30:00.000Z');
  });

  it('parses reset_at from Unix timestamp', () => {
    const headers = makeHeaders({
      'x-ratelimit-reset-requests': '1750000000',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.reset_at).toBeInstanceOf(Date);
    // 1750000000 seconds → 2025-06-15T...
    expect(info!.reset_at!.getTime()).toBe(1750000000 * 1000);
  });

  it('handles non-numeric header values gracefully', () => {
    const headers = makeHeaders({
      'x-ratelimit-remaining-requests': 'not-a-number',
      'x-ratelimit-limit-tokens': '500',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.requests_remaining).toBeUndefined();
    expect(info!.tokens_limit).toBe(500);
  });

  it('handles empty string header values', () => {
    const headers = makeHeaders({
      'x-ratelimit-remaining-requests': '',
      'x-ratelimit-limit-requests': '100',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.requests_limit).toBe(100);
  });
});
