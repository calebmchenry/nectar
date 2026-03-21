import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
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
import type { GenerateResponse } from '../../src/llm/types.js';

const originalEnv = process.env;

beforeEach(() => {
  clearDefaultClient();
  process.env = { ...originalEnv };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  delete process.env.OPENAI_COMPATIBLE_API_KEY;
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

  it('generate(request, { tools }) executes tool calls until natural completion', async () => {
    const first: GenerateResponse = {
      message: {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 't1', name: 'sum', arguments: JSON.stringify({ a: 2, b: 3 }) }],
      },
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
      model: 'mock',
      provider: 'simulation',
    };
    const second: GenerateResponse = {
      message: { role: 'assistant', content: 'done' },
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
      model: 'mock',
      provider: 'simulation',
    };
    const mockClient = {
      generateUnified: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    } as unknown as UnifiedClient;

    const result = await generate(
      { messages: [{ role: 'user', content: 'add numbers' }] },
      {
        client: mockClient,
        tools: new Map([
          ['sum', async (args: unknown) => {
            const input = args as { a: number; b: number };
            return { total: input.a + input.b };
          }],
        ]),
      }
    );

    expect(result.stop_reason).toBe('end_turn');
    expect((mockClient.generateUnified as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    const secondRequest = (mockClient.generateUnified as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(secondRequest.messages.at(-1).role).toBe('tool');
    expect(secondRequest.messages.at(-1).content[0]).toMatchObject({
      type: 'tool_result',
      tool_call_id: 't1',
      is_error: false,
    });
  });

  it('generate(request, { tools }) returns tool errors as tool_result messages', async () => {
    const first: GenerateResponse = {
      message: {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 't1', name: 'explode', arguments: '{}' }],
      },
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
      model: 'mock',
      provider: 'simulation',
    };
    const second: GenerateResponse = {
      message: { role: 'assistant', content: 'recovered' },
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
      model: 'mock',
      provider: 'simulation',
    };
    const mockClient = {
      generateUnified: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    } as unknown as UnifiedClient;

    await generate(
      { messages: [{ role: 'user', content: 'run failing tool' }] },
      {
        client: mockClient,
        tools: new Map([
          ['explode', async () => { throw new Error('tool failed'); }],
        ]),
      }
    );

    const secondRequest = (mockClient.generateUnified as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(secondRequest.messages.at(-1).content[0]).toMatchObject({
      type: 'tool_result',
      tool_call_id: 't1',
      is_error: true,
      content: 'tool failed',
    });
  });

  it('generate(request, { tools, maxIterations }) stops at maxIterations', async () => {
    const toolResponse: GenerateResponse = {
      message: {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 't1', name: 'noop', arguments: '{}' }],
      },
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
      model: 'mock',
      provider: 'simulation',
    };
    const mockClient = {
      generateUnified: vi.fn().mockResolvedValue(toolResponse),
    } as unknown as UnifiedClient;

    const result = await generate(
      { messages: [{ role: 'user', content: 'loop' }] },
      {
        client: mockClient,
        maxIterations: 1,
        tools: new Map([['noop', async () => 'ok']]),
      }
    );

    expect(result.stop_reason).toBe('tool_use');
    expect((mockClient.generateUnified as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});
