import type { IncomingMessage, ServerResponse } from 'node:http';
import { setSseHeaders, writeSseComment, writeSseEvent } from './router.js';

const DEFAULT_KEEPALIVE_MS = 15_000;
const DEFAULT_FINITE_IDLE_TIMEOUT_MS = 30 * 60_000;
const activeSseConnections = new Set<ServerResponse>();
const closeByResponse = new Map<ServerResponse, () => void>();

export interface SseStreamOptions {
  req: IncomingMessage;
  res: ServerResponse;
  keepalive_ms?: number;
  initial_event_id?: number;
}

export interface SseStream {
  send(eventName: string, payload: unknown, id?: number): boolean;
  comment(comment?: string): void;
  close(): void;
  isClosed(): boolean;
  onClose(listener: () => void): () => void;
}

export interface FiniteSseStream extends SseStream {
  terminalEmitted(): boolean;
}

interface FiniteSseStreamOptions extends SseStreamOptions {
  terminal_events: ReadonlySet<string>;
  idle_timeout_ms?: number;
}

interface SseCore extends SseStream {}

export function closeAllSseStreams(): void {
  const closers = Array.from(closeByResponse.values());
  for (const close of closers) {
    try {
      close();
    } catch {
      // Best-effort shutdown.
    }
  }
}

export function createPersistentSseStream(options: SseStreamOptions): SseStream {
  return createSseCore(options);
}

export function createFiniteSseStream(options: FiniteSseStreamOptions): FiniteSseStream {
  const core = createSseCore(options);
  let sawTerminal = false;
  const idleTimeoutMs = options.idle_timeout_ms ?? DEFAULT_FINITE_IDLE_TIMEOUT_MS;
  let idleCloseTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdleTimeout = () => {
    if (!idleCloseTimer) {
      return;
    }
    clearTimeout(idleCloseTimer);
    idleCloseTimer = undefined;
  };

  const armIdleTimeout = () => {
    clearIdleTimeout();
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || core.isClosed()) {
      return;
    }
    idleCloseTimer = setTimeout(() => {
      idleCloseTimer = undefined;
      core.close();
    }, idleTimeoutMs);
    idleCloseTimer.unref?.();
  };

  armIdleTimeout();
  core.onClose(() => {
    clearIdleTimeout();
  });

  return {
    send(eventName: string, payload: unknown, id?: number): boolean {
      const wrote = core.send(eventName, payload, id);
      if (!wrote) {
        return false;
      }
      armIdleTimeout();

      if (closeOnTerminalEvent(eventName, options.terminal_events)) {
        sawTerminal = true;
        core.close();
      }
      return true;
    },
    comment(comment?: string): void {
      core.comment(comment);
      armIdleTimeout();
    },
    close(): void {
      clearIdleTimeout();
      core.close();
    },
    isClosed(): boolean {
      return core.isClosed();
    },
    onClose(listener: () => void): () => void {
      return core.onClose(listener);
    },
    terminalEmitted(): boolean {
      return sawTerminal;
    },
  };
}

export function closeOnTerminalEvent(eventName: string, terminalEvents: ReadonlySet<string>): boolean {
  return terminalEvents.has(eventName);
}

function createSseCore(options: SseStreamOptions): SseCore {
  const keepaliveMs = options.keepalive_ms ?? DEFAULT_KEEPALIVE_MS;
  let nextEventId = options.initial_event_id ?? 1;
  let closed = false;
  const closeListeners = new Set<() => void>();

  setSseHeaders(options.res);
  options.res.flushHeaders?.();

  const keepalive = setInterval(() => {
    if (closed || options.res.writableEnded) {
      return;
    }
    writeSseComment(options.res, 'keepalive');
  }, keepaliveMs);
  keepalive.unref?.();

  const onRequestClose = () => {
    close();
  };
  options.req.on('close', onRequestClose);
  const onResponseClose = () => {
    activeSseConnections.delete(options.res);
    closeByResponse.delete(options.res);
  };
  options.res.on('close', onResponseClose);

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;

    clearInterval(keepalive);
    options.req.off('close', onRequestClose);
    options.res.off('close', onResponseClose);
    activeSseConnections.delete(options.res);
    closeByResponse.delete(options.res);

    for (const listener of closeListeners) {
      try {
        listener();
      } catch {
        // Keep close idempotent and best-effort.
      }
    }
    closeListeners.clear();

    if (!options.res.writableEnded) {
      options.res.end();
    }
  };

  activeSseConnections.add(options.res);
  closeByResponse.set(options.res, close);

  return {
    send(eventName: string, payload: unknown, id?: number): boolean {
      if (closed || options.res.writableEnded) {
        return false;
      }

      const validId = typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : nextEventId;
      writeSseEvent(options.res, validId, eventName, payload);
      nextEventId = Math.max(nextEventId, validId + 1);
      return true;
    },
    comment(comment = 'keepalive'): void {
      if (closed || options.res.writableEnded) {
        return;
      }
      writeSseComment(options.res, comment);
    },
    close,
    isClosed(): boolean {
      return closed || options.res.writableEnded;
    },
    onClose(listener: () => void): () => void {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
  };
}
