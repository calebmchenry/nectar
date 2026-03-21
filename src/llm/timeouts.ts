import type { TimeoutConfig } from './types.js';

export type TimeoutPhase = 'connect' | 'request' | 'stream_read';

export interface ResolvedTimeoutConfig {
  connect_ms: number;
  request_ms: number;
  stream_read_ms: number;
}

export const DEFAULT_TIMEOUT_CONFIG: ResolvedTimeoutConfig = {
  connect_ms: 10_000,
  request_ms: 120_000,
  stream_read_ms: 30_000,
};

export class TimeoutAbortError extends Error {
  readonly phase: TimeoutPhase;
  readonly timeout_ms: number;

  constructor(phase: TimeoutPhase, timeoutMs: number) {
    super(`LLM ${phase} timeout after ${timeoutMs}ms`);
    this.name = 'TimeoutAbortError';
    this.phase = phase;
    this.timeout_ms = timeoutMs;
  }
}

export interface RequestTimeoutContext {
  timeout: ResolvedTimeoutConfig;
  fetch_signal: AbortSignal;
  stream_signal: AbortSignal;
  clear_connect_timeout: () => void;
  clear_all_timeouts: () => void;
}

export function resolveTimeout(
  timeout?: number | TimeoutConfig,
  legacyTimeoutMs?: number,
): ResolvedTimeoutConfig {
  if (typeof timeout === 'number') {
    return {
      ...DEFAULT_TIMEOUT_CONFIG,
      request_ms: normalizeTimeoutMs(timeout, DEFAULT_TIMEOUT_CONFIG.request_ms),
    };
  }

  if (timeout && typeof timeout === 'object') {
    return {
      connect_ms: normalizeTimeoutMs(timeout.connect_ms, DEFAULT_TIMEOUT_CONFIG.connect_ms),
      request_ms: normalizeTimeoutMs(timeout.request_ms, DEFAULT_TIMEOUT_CONFIG.request_ms),
      stream_read_ms: normalizeTimeoutMs(timeout.stream_read_ms, DEFAULT_TIMEOUT_CONFIG.stream_read_ms),
    };
  }

  if (typeof legacyTimeoutMs === 'number') {
    return {
      ...DEFAULT_TIMEOUT_CONFIG,
      request_ms: normalizeTimeoutMs(legacyTimeoutMs, DEFAULT_TIMEOUT_CONFIG.request_ms),
    };
  }

  return { ...DEFAULT_TIMEOUT_CONFIG };
}

export function createRequestTimeoutContext(
  timeout: ResolvedTimeoutConfig,
  externalSignal?: AbortSignal,
): RequestTimeoutContext {
  const connectController = new AbortController();
  const requestController = new AbortController();

  const connectTimer = setTimeout(() => {
    connectController.abort(new TimeoutAbortError('connect', timeout.connect_ms));
  }, timeout.connect_ms);

  const requestTimer = setTimeout(() => {
    requestController.abort(new TimeoutAbortError('request', timeout.request_ms));
  }, timeout.request_ms);

  const clearConnect = (): void => {
    clearTimeout(connectTimer);
  };

  const clearAll = (): void => {
    clearTimeout(connectTimer);
    clearTimeout(requestTimer);
  };

  return {
    timeout,
    fetch_signal: composeAbortSignals([externalSignal, connectController.signal, requestController.signal]),
    stream_signal: composeAbortSignals([externalSignal, requestController.signal]),
    clear_connect_timeout: clearConnect,
    clear_all_timeouts: clearAll,
  };
}

export function composeAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    return new AbortController().signal;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0]!;
  }
  return AbortSignal.any(activeSignals);
}

export function getTimeoutPhaseFromSignal(signal: AbortSignal | undefined): TimeoutPhase | undefined {
  if (!signal?.aborted) {
    return undefined;
  }
  return getTimeoutPhaseFromReason(signal.reason);
}

export function getTimeoutPhaseFromReason(reason: unknown): TimeoutPhase | undefined {
  if (reason instanceof TimeoutAbortError) {
    return reason.phase;
  }
  if (reason && typeof reason === 'object') {
    const maybe = reason as { name?: unknown; phase?: unknown };
    if (maybe.name === 'TimeoutAbortError' && typeof maybe.phase === 'string') {
      if (maybe.phase === 'connect' || maybe.phase === 'request' || maybe.phase === 'stream_read') {
        return maybe.phase;
      }
    }
  }
  return undefined;
}

export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}
