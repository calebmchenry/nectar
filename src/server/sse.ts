import type { IncomingMessage, ServerResponse } from 'node:http';
import { setSseHeaders, writeSseComment, writeSseEvent } from './router.js';

const DEFAULT_KEEPALIVE_MS = 15_000;

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
}

interface SseCore extends SseStream {}

export function createPersistentSseStream(options: SseStreamOptions): SseStream {
  return createSseCore(options);
}

export function createFiniteSseStream(options: FiniteSseStreamOptions): FiniteSseStream {
  const core = createSseCore(options);
  let sawTerminal = false;

  return {
    send(eventName: string, payload: unknown, id?: number): boolean {
      if (sawTerminal && options.terminal_events.has(eventName)) {
        return false;
      }

      const wrote = core.send(eventName, payload, id);
      if (!wrote) {
        return false;
      }

      if (options.terminal_events.has(eventName)) {
        sawTerminal = true;
        core.close();
      }
      return true;
    },
    comment(comment?: string): void {
      core.comment(comment);
    },
    close(): void {
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

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;

    clearInterval(keepalive);
    options.req.off('close', onRequestClose);

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
