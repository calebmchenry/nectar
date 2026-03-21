import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createFiniteSseStream, createPersistentSseStream } from '../../src/server/sse.js';

class MockRequest extends EventEmitter {
  readonly headers: Record<string, string> = {};
}

class MockResponse extends EventEmitter {
  statusCode = 0;
  writableEnded = false;
  readonly headers = new Map<string, string>();
  readonly chunks: string[] = [];

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  write(chunk: string): boolean {
    if (this.writableEnded) {
      return false;
    }
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): void {
    if (typeof chunk === 'string' && chunk.length > 0) {
      this.write(chunk);
    }
    this.writableEnded = true;
  }

  flushHeaders(): void {
    // no-op in tests
  }
}

function asRequest(request: MockRequest): IncomingMessage {
  return request as unknown as IncomingMessage;
}

function asResponse(response: MockResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

describe('server SSE helpers', () => {
  it('finite streams close synchronously after terminal events and emit close callbacks once', () => {
    const req = new MockRequest();
    const res = new MockResponse();
    const stream = createFiniteSseStream({
      req: asRequest(req),
      res: asResponse(res),
      terminal_events: new Set(['done']),
      keepalive_ms: 60_000,
    });

    let closeCount = 0;
    stream.onClose(() => {
      closeCount += 1;
    });

    expect(stream.send('progress', { step: 1 }, 1)).toBe(true);
    expect(stream.terminalEmitted()).toBe(false);
    expect(res.writableEnded).toBe(false);

    expect(stream.send('done', { status: 'ok' }, 2)).toBe(true);
    expect(stream.terminalEmitted()).toBe(true);
    expect(res.writableEnded).toBe(true);
    expect(closeCount).toBe(1);

    expect(stream.send('done', { status: 'duplicate' }, 3)).toBe(false);
    expect(closeCount).toBe(1);
  });

  it('finite streams close after idle timeout when no terminal event is emitted', async () => {
    const req = new MockRequest();
    const res = new MockResponse();
    const stream = createFiniteSseStream({
      req: asRequest(req),
      res: asResponse(res),
      terminal_events: new Set(['done']),
      keepalive_ms: 60_000,
      idle_timeout_ms: 20,
    });

    expect(stream.send('progress', { step: 1 }, 1)).toBe(true);
    expect(stream.terminalEmitted()).toBe(false);
    expect(res.writableEnded).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(res.writableEnded).toBe(true);
  });

  it('persistent streams close and clean up when the client disconnects', () => {
    const req = new MockRequest();
    const res = new MockResponse();
    const stream = createPersistentSseStream({
      req: asRequest(req),
      res: asResponse(res),
      keepalive_ms: 60_000,
    });

    let closeCount = 0;
    stream.onClose(() => {
      closeCount += 1;
    });

    expect(stream.send('tick', { ok: true })).toBe(true);
    expect(res.writableEnded).toBe(false);
    expect(closeCount).toBe(0);

    req.emit('close');
    expect(res.writableEnded).toBe(true);
    expect(closeCount).toBe(1);

    req.emit('close');
    expect(closeCount).toBe(1);
  });
});
