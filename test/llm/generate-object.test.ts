import { describe, expect, it } from 'vitest';
import { UnifiedClient } from '../../src/llm/client.js';
import type { GenerateObjectRequest } from '../../src/llm/client.js';
import { SimulationProvider } from '../../src/llm/simulation.js';
import { StructuredOutputError, InvalidRequestError } from '../../src/llm/errors.js';
import { extractJsonText } from '../../src/llm/structured.js';
import type { GenerateResponse, GenerateRequest } from '../../src/llm/types.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';

const testSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    score: { type: 'number' },
    status: { type: 'string', enum: ['active', 'inactive'] }
  },
  required: ['name', 'score', 'status']
};

function makeClient(provider: ProviderAdapter): UnifiedClient {
  const providers = new Map();
  providers.set(provider.provider_name, provider);
  return new UnifiedClient(providers);
}

// A mock provider that returns controlled responses
function mockProvider(responses: string[]): ProviderAdapter {
  let callIdx = 0;
  return {
    provider_name: 'mock',
    async generate(_req: GenerateRequest): Promise<GenerateResponse> {
      const text = responses[callIdx] ?? '{}';
      callIdx++;
      return {
        message: { role: 'assistant', content: text },
        usage: { input_tokens: 10, output_tokens: text.length },
        stop_reason: 'end_turn',
        model: 'mock-model',
        provider: 'mock'
      };
    },
    async *stream(_req: GenerateRequest): AsyncIterable<StreamEvent> {
      yield { type: 'stream_start', model: 'mock' };
      const text = responses[callIdx] ?? '{}';
      callIdx++;
      yield { type: 'content_delta', text };
      yield { type: 'usage', usage: { input_tokens: 10, output_tokens: text.length } };
      yield {
        type: 'stream_end',
        stop_reason: 'end_turn',
        message: { role: 'assistant', content: text }
      };
    }
  };
}

describe('generateObject()', () => {
  const baseRequest: GenerateObjectRequest = {
    messages: [{ role: 'user', content: 'Generate a test object' }],
    response_format: { type: 'json_schema', json_schema: { name: 'Test', schema: testSchema } },
    provider: 'mock'
  };

  it('returns validated typed object on valid response', async () => {
    const validJson = JSON.stringify({ name: 'Alice', score: 95, status: 'active' });
    const client = makeClient(mockProvider([validJson]));

    const result = await client.generateObject<{ name: string; score: number; status: string }>(baseRequest);

    expect(result.object.name).toBe('Alice');
    expect(result.object.score).toBe(95);
    expect(result.object.status).toBe('active');
    expect(result.raw_text).toBe(validJson);
  });

  it('retries on malformed JSON and succeeds on second attempt', async () => {
    const validJson = JSON.stringify({ name: 'Bob', score: 80, status: 'inactive' });
    const client = makeClient(mockProvider(['not valid json', validJson]));

    const result = await client.generateObject<{ name: string; score: number; status: string }>(baseRequest);

    expect(result.object.name).toBe('Bob');
    expect(result.object.score).toBe(80);
  });

  it('retries on schema validation failure and succeeds', async () => {
    const invalidJson = JSON.stringify({ name: 'Carol' }); // missing required fields
    const validJson = JSON.stringify({ name: 'Carol', score: 70, status: 'active' });
    const client = makeClient(mockProvider([invalidJson, validJson]));

    const result = await client.generateObject<{ name: string; score: number; status: string }>(baseRequest);

    expect(result.object.name).toBe('Carol');
    expect(result.object.score).toBe(70);
  });

  it('throws StructuredOutputError when retries exhausted (parse error)', async () => {
    const client = makeClient(mockProvider(['bad json', 'still bad', 'really bad']));

    try {
      await client.generateObject(baseRequest);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(StructuredOutputError);
      const err = e as StructuredOutputError;
      expect(err.rawText).toBeDefined();
      expect(err.validationErrors.length).toBeGreaterThan(0);
      expect(err.schema).toEqual(testSchema);
    }
  });

  it('throws StructuredOutputError when retries exhausted (validation error)', async () => {
    const invalid = JSON.stringify({ name: 'only name' }); // missing score, status
    const client = makeClient(mockProvider([invalid, invalid, invalid]));

    await expect(client.generateObject(baseRequest))
      .rejects.toThrow(StructuredOutputError);
  });

  it('StructuredOutputError contains rawText, validationErrors, and schema', async () => {
    const client = makeClient(mockProvider(['{}', '{}', '{}']));

    try {
      await client.generateObject(baseRequest);
    } catch (e) {
      const err = e as StructuredOutputError;
      expect(err.rawText).toBe('{}');
      expect(err.validationErrors.length).toBeGreaterThan(0);
      expect(err.schema).toEqual(testSchema);
    }
  });

  it('accumulates Usage across retry attempts', async () => {
    const invalid = JSON.stringify({ name: 'test' }); // missing fields
    const valid = JSON.stringify({ name: 'test', score: 50, status: 'active' });
    const client = makeClient(mockProvider([invalid, valid]));

    const result = await client.generateObject(baseRequest);

    // Should have usage from both attempts
    expect(result.usage.input_tokens).toBe(20); // 10 + 10
  });

  it('validates: missing required fields', async () => {
    const client = makeClient(mockProvider([
      JSON.stringify({ name: 'only' }),
      JSON.stringify({ name: 'only' }),
      JSON.stringify({ name: 'only' })
    ]));

    await expect(client.generateObject(baseRequest))
      .rejects.toThrow(StructuredOutputError);
  });

  it('validates: wrong types', async () => {
    const client = makeClient(mockProvider([
      JSON.stringify({ name: 123, score: 'not a number', status: 'active' }),
      JSON.stringify({ name: 123, score: 'not a number', status: 'active' }),
      JSON.stringify({ name: 123, score: 'not a number', status: 'active' })
    ]));

    await expect(client.generateObject(baseRequest))
      .rejects.toThrow(StructuredOutputError);
  });

  it('validates: invalid enum values', async () => {
    const client = makeClient(mockProvider([
      JSON.stringify({ name: 'test', score: 50, status: 'unknown' }),
      JSON.stringify({ name: 'test', score: 50, status: 'unknown' }),
      JSON.stringify({ name: 'test', score: 50, status: 'unknown' })
    ]));

    await expect(client.generateObject(baseRequest))
      .rejects.toThrow(StructuredOutputError);
  });

  it('throws InvalidRequestError without json_schema response_format', async () => {
    const client = makeClient(mockProvider(['{}']));

    await expect(client.generateObject({
      messages: [{ role: 'user', content: 'test' }],
      response_format: { type: 'json' }
    } as unknown as GenerateObjectRequest)).rejects.toThrow(InvalidRequestError);
  });

  it('SimulationProvider returns schema-valid JSON for json_schema requests', async () => {
    const sim = new SimulationProvider();
    const client = makeClient(sim);

    const result = await client.generateObject<{ name: string; score: number; status: string }>({
      messages: [{ role: 'user', content: 'test' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'Test',
          schema: testSchema
        }
      }
    });

    expect(result.object).toBeDefined();
    expect(typeof result.object.name).toBe('string');
    expect(typeof result.object.score).toBe('number');
  });

  it('respects max_validation_retries', async () => {
    const invalid = JSON.stringify({ name: 'only' }); // missing fields
    let callCount = 0;
    const counting: ProviderAdapter = {
      provider_name: 'counting',
      async generate() {
        callCount++;
        return {
          message: { role: 'assistant', content: invalid },
          usage: { input_tokens: 10, output_tokens: invalid.length },
          stop_reason: 'end_turn',
          model: 'test',
          provider: 'counting'
        };
      },
      async *stream() { yield { type: 'stream_start', model: 'test' } as StreamEvent; }
    };

    const client = makeClient(counting);

    await expect(client.generateObject({
      ...baseRequest,
      provider: 'counting',
      max_validation_retries: 1
    })).rejects.toThrow(StructuredOutputError);

    expect(callCount).toBe(2); // 1 initial + 1 retry
  });
});

describe('extractJsonText()', () => {
  function makeResponse(text: string): GenerateResponse {
    return {
      message: { role: 'assistant', content: text },
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
      model: 'test',
      provider: 'test'
    };
  }

  it('handles plain JSON', () => {
    expect(extractJsonText(makeResponse('{"key":"value"}'))).toBe('{"key":"value"}');
  });

  it('handles markdown code fences', () => {
    expect(extractJsonText(makeResponse('```json\n{"key":"value"}\n```'))).toBe('{"key":"value"}');
  });

  it('handles code fences without language tag', () => {
    expect(extractJsonText(makeResponse('```\n{"key":"value"}\n```'))).toBe('{"key":"value"}');
  });

  it('trims whitespace', () => {
    expect(extractJsonText(makeResponse('  \n  {"key":"value"}  \n  '))).toBe('{"key":"value"}');
  });
});
