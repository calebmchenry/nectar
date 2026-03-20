import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  UnifiedClient,
  setDefaultClient,
  getDefaultClient,
  clearDefaultClient,
  generate,
  stream,
} from '../../src/llm/client.js';
import { SimulationProvider } from '../../src/llm/simulation.js';
import { ConfigurationError } from '../../src/llm/errors.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
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

describe('module-level default client', () => {
  it('setDefaultClient() overrides the lazy default', async () => {
    const sim = new SimulationProvider();
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));
    setDefaultClient(client);

    const got = getDefaultClient();
    expect(got).toBe(client);
  });

  it('getDefaultClient() without prior set lazily initializes', () => {
    // Set an API key so from_env finds a real provider
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const client = getDefaultClient();
    expect(client).toBeInstanceOf(UnifiedClient);
    expect(client.available_providers()).toContain('anthropic');
  });

  it('multiple getDefaultClient() calls return same instance (singleton)', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const a = getDefaultClient();
    const b = getDefaultClient();
    expect(a).toBe(b);
  });

  it('ConfigurationError thrown when no providers available', () => {
    // No API keys set → only simulation available
    expect(() => getDefaultClient()).toThrow(ConfigurationError);
  });

  it('clearDefaultClient() resets for next test', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const first = getDefaultClient();
    clearDefaultClient();

    // Re-fetch creates new instance
    const second = getDefaultClient();
    expect(second).not.toBe(first);
  });

  it('per-call client override works with generate()', async () => {
    const sim = new SimulationProvider();
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));

    // Don't set default — pass directly
    const result = await generate(
      { messages: [{ role: 'user', content: 'hello' }] },
      { client }
    );
    expect(result.provider).toBe('simulation');
  });

  it('per-call client override works with stream()', async () => {
    const sim = new SimulationProvider();
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));

    const events: StreamEvent[] = [];
    for await (const event of stream(
      { messages: [{ role: 'user', content: 'hello' }] },
      { client }
    )) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'content_delta')).toBe(true);
  });

  it('generate() uses default client when no override', async () => {
    const sim = new SimulationProvider();
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));
    setDefaultClient(client);

    const result = await generate({ messages: [{ role: 'user', content: 'hello' }] });
    expect(result.provider).toBe('simulation');
  });
});
