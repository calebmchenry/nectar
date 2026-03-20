import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { UnifiedClient, clearDefaultClient, setDefaultClient, getDefaultClient } from '../../src/llm/client.js';
import { SimulationProvider } from '../../src/llm/simulation.js';
import { createRetryMiddleware } from '../../src/llm/retry.js';
import { getModelInfo, listModels, resolveModelSelector } from '../../src/llm/catalog.js';
import { ConfigurationError } from '../../src/llm/errors.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { Middleware } from '../../src/llm/middleware.js';
import type { GenerateRequest, GenerateResponse, Usage } from '../../src/llm/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';

const originalEnv = process.env;

beforeEach(() => {
  clearDefaultClient();
  process.env = { ...originalEnv };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

afterEach(() => {
  clearDefaultClient();
  process.env = originalEnv;
});

describe('Integration: middleware + retry + catalog + telemetry', () => {
  it('middleware + retry + catalog work together in a realistic flow', async () => {
    const sim = new SimulationProvider();
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));

    // Add retry middleware
    client.use(createRetryMiddleware({ max_retries: 1, base_delay_ms: 1, max_delay_ms: 10, jitter: false }));

    // Add a logging middleware
    const log: string[] = [];
    const loggingMiddleware: Middleware = {
      name: 'logging',
      async generate(request, next) {
        log.push(`generate:${request.model ?? 'default'}`);
        const resp = await next(request);
        log.push(`response:${resp.provider}`);
        return resp;
      }
    };
    client.use(loggingMiddleware);

    // Generate with catalog info
    const modelInfo = getModelInfo('claude-sonnet-4-20250514');
    expect(modelInfo).toBeDefined();

    const result = await client.generateUnified({
      messages: [{ role: 'user', content: 'hello' }],
      provider: 'simulation',
    });

    expect(result.provider).toBe('simulation');
    expect(result.usage).toBeDefined();
    expect(log.length).toBe(2);
    expect(log[0]).toContain('generate');
    expect(log[1]).toContain('response');
  });

  it('generateObject() carries full usage through middleware', async () => {
    const sim = new SimulationProvider();
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));

    let usageSeen: Usage | undefined;
    client.use({
      name: 'usage-tracker',
      async generate(request, next) {
        const resp = await next(request);
        usageSeen = resp.usage;
        return resp;
      }
    });

    const result = await client.generateObject({
      messages: [{ role: 'user', content: 'respond' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'test',
          schema: { type: 'object', properties: {}, additionalProperties: true }
        }
      }
    });

    expect(result.object).toBeDefined();
    expect(usageSeen).toBeDefined();
    expect(usageSeen!.input_tokens).toBeGreaterThanOrEqual(0);
  });

  it('simulation adapter works when explicitly requested (test-only path)', async () => {
    const sim = new SimulationProvider();
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));

    const result = await client.generateUnified({
      messages: [{ role: 'user', content: 'test' }],
      provider: 'simulation',
    });

    expect(result.provider).toBe('simulation');
    expect(result.model).toContain('simulated');
  });

  it('from_env() without API keys throws ConfigurationError on getDefaultClient()', () => {
    // No API keys set
    expect(() => getDefaultClient()).toThrow(ConfigurationError);
  });

  it('existing code using UnifiedClient without middleware works identically', async () => {
    const sim = new SimulationProvider();
    const providers = new Map<string, ProviderAdapter>([['simulation', sim]]);
    const client = new UnifiedClient(providers);

    // No middleware registered
    const result = await client.generateUnified({
      messages: [{ role: 'user', content: 'hello' }]
    });

    expect(result.provider).toBe('simulation');
    expect(result.usage.input_tokens).toBeGreaterThanOrEqual(0);
  });

  it('createLLMClient() backward compat preserved', async () => {
    // from_env always includes simulation
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = createLLMClient();
    expect(client).toBeInstanceOf(UnifiedClient);
    expect(client.available_providers()).toContain('simulation');
  });

  it('stream middleware + generate middleware compose independently', async () => {
    const sim = new SimulationProvider();
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));

    let generateCalled = false;
    let streamCalled = false;

    client.use({
      name: 'tracker',
      async generate(request, next) {
        generateCalled = true;
        return next(request);
      },
      async *stream(request, next) {
        streamCalled = true;
        yield* next(request);
      }
    });

    // Only generate
    await client.generateUnified({ messages: [{ role: 'user', content: 'hi' }] });
    expect(generateCalled).toBe(true);
    expect(streamCalled).toBe(false);

    // Now stream
    const events: StreamEvent[] = [];
    for await (const event of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    expect(streamCalled).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });
});
