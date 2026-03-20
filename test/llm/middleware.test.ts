import { describe, expect, it, vi } from 'vitest';
import type { Middleware } from '../../src/llm/middleware.js';
import { composeGenerateChain, composeStreamChain } from '../../src/llm/middleware.js';
import { createRetryMiddleware } from '../../src/llm/retry.js';
import { UnifiedClient } from '../../src/llm/client.js';
import { SimulationProvider } from '../../src/llm/simulation.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { GenerateRequest, GenerateResponse } from '../../src/llm/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';
import {
  AuthenticationError,
  NetworkError,
  RateLimitError,
} from '../../src/llm/errors.js';

const dummyRequest: GenerateRequest = {
  messages: [{ role: 'user', content: 'hello' }]
};

const dummyResponse: GenerateResponse = {
  message: { role: 'assistant', content: 'hi' },
  usage: { input_tokens: 1, output_tokens: 1 },
  stop_reason: 'end_turn',
  model: 'test',
  provider: 'test'
};

function mockAdapter(name: string, response?: GenerateResponse): ProviderAdapter {
  const resp = response ?? dummyResponse;
  return {
    provider_name: name,
    generate: vi.fn().mockResolvedValue(resp),
    async *stream(_req: GenerateRequest): AsyncIterable<StreamEvent> {
      yield { type: 'stream_start', model: resp.model };
      yield { type: 'content_delta', text: 'hello' };
      yield { type: 'usage', usage: resp.usage };
      yield { type: 'stream_end', stop_reason: resp.stop_reason, message: resp.message };
    }
  };
}

describe('composeGenerateChain', () => {
  it('single middleware modifies request before next()', async () => {
    const order: string[] = [];
    const mw: Middleware = {
      name: 'test',
      async generate(request, next) {
        order.push('before');
        const resp = await next({ ...request, model: 'modified' });
        order.push('after');
        return resp;
      }
    };

    const terminal = vi.fn().mockResolvedValue(dummyResponse);
    const chain = composeGenerateChain([mw], terminal);
    await chain(dummyRequest);

    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ model: 'modified' }));
    expect(order).toEqual(['before', 'after']);
  });

  it('single middleware modifies response after next()', async () => {
    const mw: Middleware = {
      name: 'test',
      async generate(request, next) {
        const resp = await next(request);
        return { ...resp, model: 'response-modified' };
      }
    };

    const terminal = vi.fn().mockResolvedValue(dummyResponse);
    const chain = composeGenerateChain([mw], terminal);
    const result = await chain(dummyRequest);

    expect(result.model).toBe('response-modified');
  });

  it('multi-middleware: registration-order for requests, reverse for responses', async () => {
    const order: string[] = [];
    const mw1: Middleware = {
      name: 'first',
      async generate(request, next) {
        order.push('first-before');
        const resp = await next(request);
        order.push('first-after');
        return resp;
      }
    };
    const mw2: Middleware = {
      name: 'second',
      async generate(request, next) {
        order.push('second-before');
        const resp = await next(request);
        order.push('second-after');
        return resp;
      }
    };

    const terminal = vi.fn().mockResolvedValue(dummyResponse);
    const chain = composeGenerateChain([mw1, mw2], terminal);
    await chain(dummyRequest);

    expect(order).toEqual(['first-before', 'second-before', 'second-after', 'first-after']);
  });

  it('middleware error propagates to caller', async () => {
    const mw: Middleware = {
      name: 'error-mw',
      async generate(_request, _next) {
        throw new Error('middleware error');
      }
    };

    const terminal = vi.fn().mockResolvedValue(dummyResponse);
    const chain = composeGenerateChain([mw], terminal);
    await expect(chain(dummyRequest)).rejects.toThrow('middleware error');
    expect(terminal).not.toHaveBeenCalled();
  });

  it('empty middleware list: direct passthrough', async () => {
    const terminal = vi.fn().mockResolvedValue(dummyResponse);
    const chain = composeGenerateChain([], terminal);
    const result = await chain(dummyRequest);

    expect(result).toBe(dummyResponse);
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('middleware with only stream (no generate) passes generate calls through', async () => {
    const mw: Middleware = {
      name: 'stream-only',
      async *stream(request, next) {
        yield* next(request);
      }
    };

    const terminal = vi.fn().mockResolvedValue(dummyResponse);
    const chain = composeGenerateChain([mw], terminal);
    const result = await chain(dummyRequest);
    expect(result).toBe(dummyResponse);
  });
});

describe('composeStreamChain', () => {
  it('streaming middleware wraps async iterable correctly', async () => {
    const mw: Middleware = {
      name: 'passthrough',
      async *stream(request, next) {
        for await (const event of next(request)) {
          yield event;
        }
      }
    };

    const events: StreamEvent[] = [
      { type: 'stream_start', model: 'test' },
      { type: 'content_delta', text: 'hello' },
      { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'hello' } }
    ];

    async function* terminal() {
      for (const e of events) yield e;
    }

    const chain = composeStreamChain([mw], terminal);
    const result: StreamEvent[] = [];
    for await (const event of chain(dummyRequest)) {
      result.push(event);
    }

    expect(result).toEqual(events);
  });

  it('middleware with only generate (no stream) passes stream calls through', async () => {
    const mw: Middleware = {
      name: 'generate-only',
      async generate(request, next) {
        return next(request);
      }
    };

    const events: StreamEvent[] = [
      { type: 'stream_start', model: 'test' },
      { type: 'content_delta', text: 'hello' },
    ];

    async function* terminal() {
      for (const e of events) yield e;
    }

    const chain = composeStreamChain([mw], terminal);
    const result: StreamEvent[] = [];
    for await (const event of chain(dummyRequest)) {
      result.push(event);
    }

    expect(result).toEqual(events);
  });
});

describe('UnifiedClient middleware integration', () => {
  it('use() returns this for chaining', () => {
    const client = new UnifiedClient(new Map([['simulation', new SimulationProvider()]]));
    const result = client.use({ name: 'a' }).use({ name: 'b' });
    expect(result).toBe(client);
  });

  it('middleware is applied to generateUnified()', async () => {
    const adapter = mockAdapter('test');
    const client = new UnifiedClient(new Map([['test', adapter]]));

    const order: string[] = [];
    client.use({
      name: 'tracker',
      async generate(request, next) {
        order.push('before');
        const resp = await next(request);
        order.push('after');
        return resp;
      }
    });

    await client.generateUnified({ ...dummyRequest, provider: 'test' });
    expect(order).toEqual(['before', 'after']);
  });

  it('middleware is applied to stream()', async () => {
    const adapter = mockAdapter('test');
    const client = new UnifiedClient(new Map([['test', adapter]]));

    const streamEvents: StreamEvent[] = [];
    client.use({
      name: 'tracker',
      async *stream(request, next) {
        for await (const event of next(request)) {
          streamEvents.push(event);
          yield event;
        }
      }
    });

    const events: StreamEvent[] = [];
    for await (const event of client.stream({ ...dummyRequest, provider: 'test' })) {
      events.push(event);
    }

    expect(streamEvents.length).toBeGreaterThan(0);
    expect(events).toEqual(streamEvents);
  });

  it('generateObject() calls flow through middleware', async () => {
    const sim = new SimulationProvider();
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));

    let middlewareCalled = false;
    client.use({
      name: 'tracker',
      async generate(request, next) {
        middlewareCalled = true;
        return next(request);
      }
    });

    const result = await client.generateObject({
      messages: [{ role: 'user', content: 'respond with json' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'test',
          schema: { type: 'object', properties: {}, additionalProperties: true }
        }
      }
    });

    expect(middlewareCalled).toBe(true);
    expect(result.object).toBeDefined();
  });
});

describe('createRetryMiddleware', () => {
  it('retries on retryable errors with backoff', async () => {
    let callCount = 0;
    const terminal = async (_req: GenerateRequest) => {
      callCount++;
      if (callCount < 3) throw new RateLimitError('test');
      return dummyResponse;
    };

    const mw = createRetryMiddleware({ max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const chain = composeGenerateChain([mw], terminal);
    const result = await chain(dummyRequest);

    expect(result).toBe(dummyResponse);
    expect(callCount).toBe(3);
  });

  it('does NOT retry non-retryable errors', async () => {
    let callCount = 0;
    const terminal = async (_req: GenerateRequest) => {
      callCount++;
      throw new AuthenticationError('test');
    };

    const mw = createRetryMiddleware({ max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const chain = composeGenerateChain([mw], terminal);
    await expect(chain(dummyRequest)).rejects.toThrow(AuthenticationError);
    expect(callCount).toBe(1);
  });

  it('respects max_retries config', async () => {
    let callCount = 0;
    const terminal = async (_req: GenerateRequest) => {
      callCount++;
      throw new NetworkError('test');
    };

    const mw = createRetryMiddleware({ max_retries: 2, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const chain = composeGenerateChain([mw], terminal);
    await expect(chain(dummyRequest)).rejects.toThrow(NetworkError);
    expect(callCount).toBe(3); // initial + 2 retries
  });

  it('streaming retry: retries before first delta, not after', async () => {
    let callCount = 0;

    async function* terminal(_req: GenerateRequest): AsyncIterable<StreamEvent> {
      callCount++;
      if (callCount === 1) {
        throw new NetworkError('test');
      }
      yield { type: 'stream_start', model: 'test' };
      yield { type: 'content_delta', text: 'hello' };
      yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'hello' } };
    }

    const mw = createRetryMiddleware({ max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const chain = composeStreamChain([mw], terminal);

    const events: StreamEvent[] = [];
    for await (const event of chain(dummyRequest)) {
      events.push(event);
    }

    expect(callCount).toBe(2);
    expect(events.some(e => e.type === 'content_delta')).toBe(true);
  });

  it('streaming: does NOT retry after content has been yielded', async () => {
    let callCount = 0;

    async function* terminal(_req: GenerateRequest): AsyncIterable<StreamEvent> {
      callCount++;
      yield { type: 'stream_start', model: 'test' };
      yield { type: 'content_delta', text: 'partial' };
      throw new NetworkError('test');
    }

    const mw = createRetryMiddleware({ max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter: false });
    const chain = composeStreamChain([mw], terminal);

    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const event of chain(dummyRequest)) {
        events.push(event);
      }
    }).rejects.toThrow(NetworkError);
    expect(callCount).toBe(1);
  });
});
