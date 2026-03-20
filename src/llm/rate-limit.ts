import type { RateLimitInfo } from './types.js';

/**
 * Parse rate-limit headers from an HTTP response.
 *
 * Standard prefix: `x-ratelimit-`
 * Anthropic prefix: `anthropic-ratelimit-`
 *
 * Returns undefined if no rate-limit headers are present.
 */
export function parseRateLimitHeaders(
  headers: Headers,
  prefix = 'x-ratelimit-'
): RateLimitInfo | undefined {
  const requestsRemaining = parseIntHeader(headers, `${prefix}remaining-requests`);
  const requestsLimit = parseIntHeader(headers, `${prefix}limit-requests`);
  const tokensRemaining = parseIntHeader(headers, `${prefix}remaining-tokens`);
  const tokensLimit = parseIntHeader(headers, `${prefix}limit-tokens`);
  const resetAt = parseResetHeader(headers, `${prefix}reset-requests`);

  if (
    requestsRemaining === undefined &&
    requestsLimit === undefined &&
    tokensRemaining === undefined &&
    tokensLimit === undefined &&
    resetAt === undefined
  ) {
    return undefined;
  }

  return {
    requests_remaining: requestsRemaining,
    requests_limit: requestsLimit,
    tokens_remaining: tokensRemaining,
    tokens_limit: tokensLimit,
    reset_at: resetAt,
  };
}

function parseIntHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null) return undefined;
  const num = parseInt(value, 10);
  return Number.isNaN(num) ? undefined : num;
}

function parseResetHeader(headers: Headers, name: string): Date | undefined {
  const value = headers.get(name);
  if (value === null) return undefined;

  // Try as Unix timestamp (seconds)
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && asNumber > 0) {
    // If it looks like a Unix timestamp (> year 2000 in seconds)
    if (asNumber > 946684800) {
      return new Date(asNumber * 1000);
    }
    // Small numbers: seconds from now
    return new Date(Date.now() + asNumber * 1000);
  }

  // Try as ISO 8601 / HTTP-date
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed);
  }

  return undefined;
}
