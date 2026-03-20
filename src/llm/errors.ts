export class LLMError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status_code?: number;

  constructor(
    message: string,
    opts: { provider: string; retryable: boolean; status_code?: number; cause?: unknown }
  ) {
    super(message, { cause: opts.cause });
    this.name = 'LLMError';
    this.provider = opts.provider;
    this.retryable = opts.retryable;
    this.status_code = opts.status_code;
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

export class RateLimitError extends LLMError {
  readonly retry_after_ms?: number;

  constructor(provider: string, opts?: { retry_after_ms?: number; message?: string; cause?: unknown }) {
    super(opts?.message ?? `Rate limited by provider '${provider}'`, {
      provider,
      retryable: true,
      status_code: 429,
      cause: opts?.cause
    });
    this.name = 'RateLimitError';
    this.retry_after_ms = opts?.retry_after_ms;
  }
}

export class OverloadedError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Provider '${provider}' is overloaded`, {
      provider,
      retryable: true,
      status_code: 503,
      cause
    });
    this.name = 'OverloadedError';
  }
}

export class InvalidRequestError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Invalid request to provider '${provider}'`, {
      provider,
      retryable: false,
      status_code: 400,
      cause
    });
    this.name = 'InvalidRequestError';
  }
}

export class ContextWindowError extends LLMError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Context window exceeded for provider '${provider}'`, {
      provider,
      retryable: false,
      status_code: 400,
      cause
    });
    this.name = 'ContextWindowError';
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
  constructor(provider: string, message?: string, cause?: unknown) {
    super(message ?? `Request to provider '${provider}' timed out`, {
      provider,
      retryable: true,
      cause
    });
    this.name = 'TimeoutError';
  }
}

export class ConfigurationError extends LLMError {
  constructor(message?: string, cause?: unknown) {
    super(
      message ?? 'No LLM provider configured. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY',
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
