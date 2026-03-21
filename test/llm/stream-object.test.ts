import { describe, expect, it } from 'vitest';
import { UnifiedClient } from '../../src/llm/client.js';
import type { GenerateObjectRequest, StreamObjectEvent } from '../../src/llm/client.js';
import { StructuredOutputError } from '../../src/llm/errors.js';
import type { GenerateRequest, GenerateResponse } from '../../src/llm/types.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';

const testSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, score: { type: 'number' } },
  required: ['name', 'score']
};

function streamProvider(chunks: string[]): ProviderAdapter {
  return {
    provider_name: 'mock-stream',
    async generate(_req: GenerateRequest): Promise<GenerateResponse> {
      return {
        message: { role: 'assistant', content: chunks.join('') },
        usage: { input_tokens: 10, output_tokens: 50 },
        stop_reason: 'end_turn', model: 'mock', provider: 'mock-stream'
      };
    },
    async *stream(_req: GenerateRequest): AsyncIterable<StreamEvent> {
      yield { type: 'stream_start', model: 'mock' };
      for (const chunk of chunks) {
        yield { type: 'content_delta', text: chunk };
      }
      yield { type: 'usage', usage: { input_tokens: 10, output_tokens: 50 } };
      yield {
        type: 'stream_end',
        stop_reason: 'end_turn',
        message: { role: 'assistant', content: chunks.join('') }
      };
    }
  };
}

function makeClient(provider: ProviderAdapter): UnifiedClient {
  const providers = new Map();
  providers.set(provider.provider_name, provider);
  return new UnifiedClient(providers);
}

describe('streamObject()', () => {
  const baseRequest: GenerateObjectRequest = {
    messages: [{ role: 'user', content: 'generate' }],
    response_format: { type: 'json_schema', json_schema: { name: 'Test', schema: testSchema } },
    provider: 'mock-stream'
  };

  it('yields partial object snapshots as top-level keys complete', async () => {
    const client = makeClient(streamProvider(['{"name":', '"Alice",', '"score":95}']));
    const events: StreamObjectEvent<unknown>[] = [];

    for await (const e of client.streamObject(baseRequest)) {
      events.push(e);
    }

    const partials = events.filter(e => e.type === 'partial');
    expect(partials.length).toBe(2);
    expect((partials[0] as { type: 'partial'; object: Record<string, unknown> }).object).toEqual({ name: 'Alice' });
    expect((partials[1] as { type: 'partial'; object: Record<string, unknown> }).object).toEqual({
      name: 'Alice',
      score: 95,
    });
  });

  it('yields complete event with correct type on valid JSON', async () => {
    const json = '{"name":"Bob","score":80}';
    const client = makeClient(streamProvider([json]));
    const events: StreamObjectEvent<{ name: string; score: number }>[] = [];

    for await (const e of client.streamObject<{ name: string; score: number }>(baseRequest)) {
      events.push(e);
    }

    const objEvent = events.find(e => e.type === 'complete') as { type: 'complete'; object: { name: string; score: number }; raw_text: string };
    expect(objEvent).toBeDefined();
    expect(objEvent.object.name).toBe('Bob');
    expect(objEvent.object.score).toBe(80);
    expect(objEvent.raw_text).toBe(json);
  });

  it('yields error event on invalid JSON', async () => {
    const client = makeClient(streamProvider(['not json at all']));
    const events: StreamObjectEvent<unknown>[] = [];

    for await (const e of client.streamObject(baseRequest)) {
      events.push(e);
    }

    const errEvent = events.find(e => e.type === 'error') as { type: 'error'; error: StructuredOutputError };
    expect(errEvent).toBeDefined();
    expect(errEvent.error).toBeInstanceOf(StructuredOutputError);
    expect(errEvent.error.rawText).toBe('not json at all');
  });

  it('yields error event on schema validation failure', async () => {
    const client = makeClient(streamProvider(['{"name":"test"}'])); // missing score
    const events: StreamObjectEvent<unknown>[] = [];

    for await (const e of client.streamObject(baseRequest)) {
      events.push(e);
    }

    const errEvent = events.find(e => e.type === 'error') as { type: 'error'; error: StructuredOutputError };
    expect(errEvent).toBeDefined();
    expect(errEvent.error).toBeInstanceOf(StructuredOutputError);
    expect(errEvent.error.validationErrors.length).toBeGreaterThan(0);
  });

  it('empty stream yields error event', async () => {
    const client = makeClient(streamProvider([]));
    const events: StreamObjectEvent<unknown>[] = [];

    for await (const e of client.streamObject(baseRequest)) {
      events.push(e);
    }

    const errEvent = events.find(e => e.type === 'error');
    expect(errEvent).toBeDefined();
  });
});
