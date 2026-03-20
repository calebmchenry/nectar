import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { UnifiedClient } from '../../src/llm/client.js';
import { SimulationProvider } from '../../src/llm/simulation.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { GenerateRequest, GenerateResponse } from '../../src/llm/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';
import { InvalidRequestError } from '../../src/llm/errors.js';

function mockAdapter(name: string, response?: GenerateResponse): ProviderAdapter {
  const resp: GenerateResponse = response ?? {
    message: { role: 'assistant', content: [{ type: 'text', text: `Hello from ${name}` }] },
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'end_turn',
    model: `${name}-model`,
    provider: name
  };

  return {
    provider_name: name,
    generate: vi.fn().mockResolvedValue(resp),
    async *stream(_req: GenerateRequest): AsyncIterable<StreamEvent> {
      yield { type: 'stream_start', model: resp.model };
      yield { type: 'content_delta', text: `Hello from ${name}` };
      yield { type: 'usage', usage: resp.usage };
      yield { type: 'stream_end', stop_reason: resp.stop_reason, message: resp.message };
    }
  };
}

const dummyRequest: GenerateRequest = {
  messages: [{ role: 'user', content: 'Hello' }]
};

describe('UnifiedClient', () => {
  it('routes to correct provider based on request.provider', async () => {
    const anthropic = mockAdapter('anthropic');
    const openai = mockAdapter('openai');
    const providers = new Map<string, ProviderAdapter>([
      ['anthropic', anthropic],
      ['openai', openai],
      ['simulation', new SimulationProvider()]
    ]);

    const client = new UnifiedClient(providers);
    const result = await client.generateUnified({ ...dummyRequest, provider: 'openai' });
    expect(result.provider).toBe('openai');
    expect(openai.generate).toHaveBeenCalledTimes(1);
    expect(anthropic.generate).not.toHaveBeenCalled();
  });

  it('defaults to first available by priority (Anthropic > OpenAI > Simulation)', async () => {
    const anthropic = mockAdapter('anthropic');
    const openai = mockAdapter('openai');
    const providers = new Map<string, ProviderAdapter>([
      ['anthropic', anthropic],
      ['openai', openai],
      ['simulation', new SimulationProvider()]
    ]);

    const client = new UnifiedClient(providers);
    const result = await client.generateUnified(dummyRequest);
    expect(result.provider).toBe('anthropic');
    expect(anthropic.generate).toHaveBeenCalledTimes(1);
  });

  it('falls back to simulation when no real providers configured', async () => {
    const sim = new SimulationProvider();
    const providers = new Map<string, ProviderAdapter>([['simulation', sim]]);
    const client = new UnifiedClient(providers);

    const result = await client.generateUnified(dummyRequest);
    expect(result.provider).toBe('simulation');
    expect(result.model).toContain('simulated');
  });

  it('raises InvalidRequestError for unconfigured explicit provider', async () => {
    const providers = new Map<string, ProviderAdapter>([['simulation', new SimulationProvider()]]);
    const client = new UnifiedClient(providers);

    await expect(
      client.generateUnified({ ...dummyRequest, provider: 'openai' })
    ).rejects.toThrow(InvalidRequestError);
  });

  it('raises InvalidRequestError with clear message for unconfigured provider', async () => {
    const providers = new Map<string, ProviderAdapter>([['simulation', new SimulationProvider()]]);
    const client = new UnifiedClient(providers);

    try {
      await client.generateUnified({ ...dummyRequest, provider: 'openai' });
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidRequestError);
      expect((e as Error).message).toContain('openai');
      expect((e as Error).message).toContain('not configured');
    }
  });

  it('available_providers returns configured provider names', () => {
    const providers = new Map<string, ProviderAdapter>([
      ['anthropic', mockAdapter('anthropic')],
      ['simulation', new SimulationProvider()]
    ]);
    const client = new UnifiedClient(providers);
    expect(client.available_providers()).toEqual(['anthropic', 'simulation']);
  });

  it('stream() returns AsyncIterable<StreamEvent> with content deltas', async () => {
    const anthropic = mockAdapter('anthropic');
    const providers = new Map<string, ProviderAdapter>([
      ['anthropic', anthropic],
      ['simulation', new SimulationProvider()]
    ]);

    const client = new UnifiedClient(providers);
    const events: StreamEvent[] = [];
    for await (const event of client.stream(dummyRequest)) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'stream_start')).toBe(true);
    expect(events.some((e) => e.type === 'content_delta')).toBe(true);
    expect(events.some((e) => e.type === 'stream_end')).toBe(true);
  });

  it('legacy generate() returns LLMResponse format', async () => {
    const anthropic = mockAdapter('anthropic');
    const providers = new Map<string, ProviderAdapter>([
      ['anthropic', anthropic],
      ['simulation', new SimulationProvider()]
    ]);

    const client = new UnifiedClient(providers);
    const result = await client.generate({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    expect(result.content).toBe('Hello from anthropic');
    expect(typeof result.content).toBe('string');
    expect(result.usage).toBeDefined();
  });

  it('simulation streaming produces deterministic output', async () => {
    const sim = new SimulationProvider();
    const providers = new Map<string, ProviderAdapter>([['simulation', sim]]);
    const client = new UnifiedClient(providers);

    const events: StreamEvent[] = [];
    for await (const event of client.stream(dummyRequest)) {
      events.push(event);
    }

    expect(events[0]!.type).toBe('stream_start');
    const deltas = events.filter((e) => e.type === 'content_delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(events[events.length - 1]!.type).toBe('stream_end');
  });

  describe('from_env()', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('discovers ANTHROPIC_API_KEY from env', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const client = UnifiedClient.from_env();
      expect(client.available_providers()).toContain('anthropic');
      expect(client.available_providers()).toContain('simulation');
    });

    it('discovers OPENAI_API_KEY from env', () => {
      process.env.OPENAI_API_KEY = 'test-key';
      const client = UnifiedClient.from_env();
      expect(client.available_providers()).toContain('openai');
      expect(client.available_providers()).toContain('simulation');
    });

    it('includes only simulation when no API keys set', () => {
      const client = UnifiedClient.from_env();
      expect(client.available_providers()).toContain('simulation');
      expect(client.available_providers()).not.toContain('anthropic');
      expect(client.available_providers()).not.toContain('openai');
    });
  });
});
