export class LLMError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status_code?: number;
  readonly retry_after_ms?: number;
  error_code?: string;
  raw?: Record<string, unknown>;

  constructor(
    message: string,
    opts: {
      provider: string;
      retryable: boolean;
      status_code?: number;
      retry_after_ms?: number;
      cause?: unknown;
      error_code?: string;
      raw?: Record<string, unknown>;
    }
  ) {
    super(message, { cause: opts.cause });
    this.name = 'LLMError';
    this.provider = opts.provider;
    this.retryable = opts.retryable;
    this.status_code = opts.status_code;
    this.retry_after_ms = opts.retry_after_ms;
    this.error_code = opts.error_code;
    this.raw = opts.raw;
  }
}

export class AuthenticationError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Authentication failed for provider '${provider}'`, {
      provider,
      retryable: false,
      status_code: 401,
      cause
    });
    this.name = 'AuthenticationError';
  }
}

export class AccessDeniedError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Access denied for provider '${provider}'`, {
      provider,
      retryable: false,
      status_code: 403,
      cause
    });
    this.name = 'AccessDeniedError';
  }
}

export class NotFoundError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Requested resource not found for provider '${provider}'`, {
      provider,
      retryable: false,
      status_code: 404,
      cause
    });
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends LLMError {
  constructor(provider: string, opts?: { retry_after_ms?: number; message?: string; cause?: unknown }) {
    super(opts?.message ?? `Rate limited by provider '${provider}'`, {
      provider,
      retryable: true,
      status_code: 429,
      retry_after_ms: opts?.retry_after_ms,
      cause: opts?.cause
    });
    this.name = 'RateLimitError';
  }
}

export class ServerError extends LLMError {
  constructor(
    provider: string,
    opts?: { status_code?: number; retry_after_ms?: number; message?: string; cause?: unknown }
  ) {
    const statusCode = opts?.status_code ?? 500;
    super(opts?.message ?? `Provider '${provider}' server error (${statusCode})`, {
      provider,
      retryable: true,
      status_code: statusCode,
      retry_after_ms: opts?.retry_after_ms,
      cause: opts?.cause,
    });
    this.name = 'ServerError';
  }
}

export class QuotaExceededError extends LLMError {
  constructor(provider: string, opts?: { message?: string; status_code?: number; cause?: unknown }) {
    super(opts?.message ?? `Quota exhausted for provider '${provider}'`, {
      provider,
      retryable: false,
      status_code: opts?.status_code ?? 429,
      cause: opts?.cause
    });
    this.name = 'QuotaExceededError';
  }
}

export type StreamErrorPhase = 'transport' | 'sse_parse' | 'idle_timeout';

export class StreamError extends LLMError {
  readonly partial_content?: string;
  readonly phase?: StreamErrorPhase;

  constructor(
    provider: string,
    opts?: { partial_content?: string; phase?: StreamErrorPhase; message?: string; cause?: unknown }
  ) {
    super(opts?.message ?? `Stream failed for provider '${provider}'`, {
      provider,
      retryable: true,
      cause: opts?.cause
    });
    this.name = 'StreamError';
    this.partial_content = opts?.partial_content;
    this.phase = opts?.phase;
  }
}

export class OverloadedError extends ServerError {
  constructor(
    provider: string,
    messageOrOpts?: string | { message?: string; retry_after_ms?: number; cause?: unknown },
    cause?: unknown
  ) {
    const message = typeof messageOrOpts === 'string' ? messageOrOpts : messageOrOpts?.message;
    const retryAfter = typeof messageOrOpts === 'string' ? undefined : messageOrOpts?.retry_after_ms;
    const causeValue = typeof messageOrOpts === 'string' ? cause : messageOrOpts?.cause;
    super(provider, {
      status_code: 503,
      message: message ?? `Provider '${provider}' is overloaded`,
      retry_after_ms: retryAfter,
      cause: causeValue,
    });
    this.name = 'OverloadedError';
  }
}

export class AbortError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Request aborted for provider '${provider}'`, {
      provider,
      retryable: false,
      cause,
    });
    this.name = 'AbortError';
  }
}

export class InvalidToolCallError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Invalid tool call for provider '${provider}'`, {
      provider,
      retryable: false,
      status_code: 400,
      cause,
    });
    this.name = 'InvalidToolCallError';
  }
}

export class UnsupportedToolChoiceError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Unsupported tool choice for provider '${provider}'`, {
      provider,
      retryable: false,
      status_code: 400,
      cause,
    });
    this.name = 'UnsupportedToolChoiceError';
  }
}

export class InvalidRequestError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown, status_code = 400) {
    super(message ?? `Invalid request to provider '${provider}'`, {
      provider,
      retryable: false,
      status_code,
      cause
    });
    this.name = 'InvalidRequestError';
  }
}

export class ContextWindowError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown, status_code = 400) {
    super(message ?? `Context window exceeded for provider '${provider}'`, {
      provider,
      retryable: false,
      status_code,
      cause
    });
    this.name = 'ContextWindowError';
  }
}

export class ContextLengthError extends ContextWindowError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(provider, message ?? `Context length exceeded for provider '${provider}'`, cause, 413);
    this.name = 'ContextLengthError';
  }
}

export class ContentFilterError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Content filtered by provider '${provider}'`, {
      provider,
      retryable: false,
      status_code: 400,
      cause
    });
    this.name = 'ContentFilterError';
  }
}

export class NetworkError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Network error communicating with provider '${provider}'`, {
      provider,
      retryable: true,
      cause
    });
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown, status_code = 408) {
    super(message ?? `Request to provider '${provider}' timed out`, {
      provider,
      retryable: false,
      status_code,
      cause
    });
    this.name = 'TimeoutError';
  }
}

export class RequestTimeoutError extends TimeoutError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(provider, message ?? `Request timed out for provider '${provider}'`, cause, 408);
    this.name = 'RequestTimeoutError';
  }
}

export class ConfigurationError extends LLMError {
  constructor(message?: string, cause?: unknown) {
    super(
      message ?? 'No LLM provider configured. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENAI_COMPATIBLE_BASE_URL, GEMINI_API_KEY',
      { provider: 'none', retryable: false, cause }
    );
    this.name = 'ConfigurationError';
  }
}

export class StructuredOutputError extends LLMError {
  readonly rawText: string;
  readonly validationErrors: string[];
  readonly schema: Record<string, unknown>;
  readonly parseError?: string;

  constructor(opts: {
    provider: string;
    rawText: string;
    validationErrors: string[];
    schema: Record<string, unknown>;
    parseError?: string;
    cause?: unknown;
  }) {
    const msg = opts.parseError
      ? `Structured output parse error: ${opts.parseError}`
      : `Structured output validation failed: ${opts.validationErrors.join('; ')}`;
    super(msg, { provider: opts.provider, retryable: false, status_code: 400, cause: opts.cause });
    this.name = 'StructuredOutputError';
    this.rawText = opts.rawText;
    this.validationErrors = opts.validationErrors;
    this.schema = opts.schema;
    this.parseError = opts.parseError;
  }
}

export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }
  // Try parsing as HTTP-date
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}
