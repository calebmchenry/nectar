import { describe, expect, it } from 'vitest';
import { parseSSEStream } from '../../src/llm/streaming.js';
import {
  TimeoutAbortError,
  createRequestTimeoutContext,
  getTimeoutPhaseFromReason,
  getTimeoutPhaseFromSignal,
  resolveTimeout,
} from '../../src/llm/timeouts.js';

function makeSseResponse(chunks: Array<{ text: string; delay_ms?: number }>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      const pushNext = () => {
        const next = chunks[index];
        if (!next) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.text));
        index += 1;
        setTimeout(pushNext, next.delay_ms ?? 0);
      };
      pushNext();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('timeouts', () => {
  it('resolves default timeout config', () => {
    expect(resolveTimeout()).toEqual({
      connect_ms: 10_000,
      request_ms: 120_000,
      stream_read_ms: 30_000,
    });
  });

  it('maps numeric timeout to request_ms', () => {
    expect(resolveTimeout(45_000)).toEqual({
      connect_ms: 10_000,
      request_ms: 45_000,
      stream_read_ms: 30_000,
    });
  });

  it('supports partial structured timeout config', () => {
    expect(resolveTimeout({ connect_ms: 5_000 })).toEqual({
      connect_ms: 5_000,
      request_ms: 120_000,
      stream_read_ms: 30_000,
    });
  });

  it('maps legacy timeout_ms to request_ms', () => {
    expect(resolveTimeout(undefined, 12_000)).toEqual({
      connect_ms: 10_000,
      request_ms: 12_000,
      stream_read_ms: 30_000,
    });
  });

  it('connect timeout aborts fetch signal', async () => {
    const timeout = resolveTimeout({ connect_ms: 5, request_ms: 100, stream_read_ms: 30 });
    const context = createRequestTimeoutContext(timeout);
    await new Promise((resolve) => setTimeout(resolve, 12));
    expect(getTimeoutPhaseFromSignal(context.fetch_signal)).toBe('connect');
    context.clear_all_timeouts();
  });

  it('enforces stream_read_ms per chunk with timer reset', async () => {
    const response = makeSseResponse([
      { text: 'data: {"v":1}\n\n', delay_ms: 5 },
      { text: 'data: {"v":2}\n\n', delay_ms: 5 },
    ]);

    const events: Array<{ event?: string; data: string }> = [];
    for await (const event of parseSSEStream(response, { stream_read_ms: 20 })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]?.data).toContain('"v":1');
    expect(events[1]?.data).toContain('"v":2');
  });

  it('throws stream_read timeout when no chunk arrives within deadline', async () => {
    const iterate = async () => {
      const response = makeSseResponse([
        { text: 'data: {"v":1}\n\n', delay_ms: 25 },
        { text: 'data: {"v":2}\n\n' },
      ]);
      for await (const _event of parseSSEStream(response, { stream_read_ms: 10 })) {
        // consume
      }
    };

    await expect(iterate()).rejects.toBeInstanceOf(TimeoutAbortError);

    try {
      await iterate();
      expect.unreachable('expected timeout');
    } catch (error) {
      expect(getTimeoutPhaseFromReason(error)).toBe('stream_read');
    }
  });
});
