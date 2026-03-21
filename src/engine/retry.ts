import type { ErrorCategory, NodeOutcome } from './types.js';

export type RetryStrategy = 'exponential' | 'linear';

export interface RetryPreset {
  name: string;
  max_retries: number;
  initial_delay_ms: number;
  multiplier: number;
  max_delay_ms: number;
  strategy: RetryStrategy;
  jitter: boolean;
}

const NONE_PRESET: RetryPreset = {
  name: 'none',
  max_retries: 0,
  initial_delay_ms: 0,
  multiplier: 1,
  max_delay_ms: 0,
  strategy: 'exponential',
  jitter: false,
};

const STANDARD_PRESET: RetryPreset = {
  name: 'standard',
  max_retries: 5,
  initial_delay_ms: 200,
  multiplier: 2,
  max_delay_ms: 60_000,
  strategy: 'exponential',
  jitter: true,
};

const AGGRESSIVE_PRESET: RetryPreset = {
  name: 'aggressive',
  max_retries: 5,
  initial_delay_ms: 500,
  multiplier: 2.0,
  max_delay_ms: 60_000,
  strategy: 'exponential',
  jitter: true,
};

const LINEAR_PRESET: RetryPreset = {
  name: 'linear',
  max_retries: 3,
  initial_delay_ms: 500,
  multiplier: 1,
  max_delay_ms: 5_000,
  strategy: 'linear',
  jitter: true,
};

const PATIENT_PRESET: RetryPreset = {
  name: 'patient',
  max_retries: 3,
  initial_delay_ms: 2_000,
  multiplier: 3.0,
  max_delay_ms: 120_000,
  strategy: 'exponential',
  jitter: true,
};

export const RETRY_PRESETS: Record<string, RetryPreset> = {
  none: NONE_PRESET,
  standard: STANDARD_PRESET,
  aggressive: AGGRESSIVE_PRESET,
  linear: LINEAR_PRESET,
  patient: PATIENT_PRESET,
};

export const DEFAULT_RETRY_PRESET_NAME = 'standard';
export const DEFAULT_RETRY_BASE_DELAY_MS = STANDARD_PRESET.initial_delay_ms;
export const DEFAULT_RETRY_MULTIPLIER = STANDARD_PRESET.multiplier;
export const DEFAULT_RETRY_MAX_DELAY_MS = STANDARD_PRESET.max_delay_ms;

export function getRetryPreset(name: string): RetryPreset | undefined {
  return RETRY_PRESETS[name.trim().toLowerCase()];
}

export function listRetryPresetNames(): string[] {
  return Object.keys(RETRY_PRESETS);
}

export function computeBackoff(attempt: number, preset: RetryPreset, jitter = preset.jitter): number {
  if (attempt <= 0 || preset.initial_delay_ms <= 0 || preset.max_delay_ms <= 0) {
    return 0;
  }

  let delay: number;
  if (preset.strategy === 'linear') {
    delay = Math.min(preset.initial_delay_ms, preset.max_delay_ms);
  } else {
    const exponential = preset.initial_delay_ms * Math.pow(preset.multiplier, Math.max(0, attempt - 1));
    delay = Math.min(exponential, preset.max_delay_ms);
  }

  if (!jitter || delay === 0) {
    return delay;
  }

  // Keep retries spread under contention to avoid synchronized thundering herds.
  const jitterFactor = 0.5 + Math.random();
  return Math.round(delay * jitterFactor);
}

// Legacy helper retained for existing call sites.
export function getRetryDelayMs(retryIndex: number, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS): number {
  return computeBackoff(retryIndex, {
    ...STANDARD_PRESET,
    initial_delay_ms: baseDelayMs,
  }, false);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const NON_RETRYABLE_FAILURE_CATEGORIES = new Set<ErrorCategory>(['http_400', 'http_401', 'http_403']);
const NON_RETRYABLE_EXIT_CODES = new Set([1, 137, 143]);

export function shouldRetry(
  outcome: Pick<NodeOutcome, 'status' | 'error_category' | 'exit_code' | 'timed_out'>,
  error?: unknown,
): boolean {
  if (outcome.status !== 'retry' && outcome.status !== 'failure') {
    return false;
  }
  if (outcome.status === 'retry') {
    return true;
  }

  // Shell/tool semantics:
  // - timeout remains retryable
  // - known terminal failures should fail fast
  // - other non-zero exit codes remain retryable by default
  if (outcome.timed_out) {
    return true;
  }
  if (typeof outcome.exit_code === 'number') {
    if (NON_RETRYABLE_EXIT_CODES.has(outcome.exit_code)) {
      return false;
    }
    if (outcome.exit_code !== 0) {
      return true;
    }
  }

  const category = outcome.error_category ?? inferErrorCategory(error);
  if (!category) {
    // Backwards-compatible default: unclassified failures stay retryable.
    return true;
  }
  return !NON_RETRYABLE_FAILURE_CATEGORIES.has(category);
}

function inferErrorCategory(error: unknown): ErrorCategory | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const maybe = error as {
    status_code?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };

  if (typeof maybe.status_code === 'number') {
    return mapStatusCode(maybe.status_code);
  }

  if (typeof maybe.code === 'string') {
    const code = maybe.code.toUpperCase();
    if (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'EHOSTUNREACH' ||
      code === 'ETIMEDOUT' ||
      code === 'EPIPE' ||
      code === 'EAI_AGAIN'
    ) {
      return 'network';
    }
  }

  const name = typeof maybe.name === 'string' ? maybe.name : '';
  if (name.includes('Network') || name.includes('Timeout')) {
    return 'network';
  }

  const message = typeof maybe.message === 'string' ? maybe.message : '';
  const statusMatch = message.match(/\b([45]\d{2})\b/);
  if (statusMatch) {
    return mapStatusCode(Number.parseInt(statusMatch[1]!, 10));
  }
  if (/network|timed?\s*out|connection|socket|dns|econn|enotfound/i.test(message)) {
    return 'network';
  }

  return undefined;
}

function mapStatusCode(statusCode: number): ErrorCategory | undefined {
  if (statusCode === 400) {
    return 'http_400';
  }
  if (statusCode === 401) {
    return 'http_401';
  }
  if (statusCode === 403) {
    return 'http_403';
  }
  if (statusCode === 429) {
    return 'http_429';
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return 'http_5xx';
  }
  return undefined;
}
