import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { UnifiedClient, generate as generateWithTools } from '../../src/llm/client.js';
import { SimulationProvider } from '../../src/llm/simulation.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { ContentPart, GenerateRequest, GenerateResponse } from '../../src/llm/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';
import { InvalidRequestError, UnsupportedToolChoiceError } from '../../src/llm/errors.js';
import { resolveTimeout } from '../../src/llm/timeouts.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

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
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    supports_tool_choice: vi.fn().mockReturnValue(true),
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

  it('rejects invalid tool names before provider request translation', async () => {
    const anthropic = mockAdapter('anthropic');
    const providers = new Map<string, ProviderAdapter>([
      ['anthropic', anthropic],
      ['simulation', new SimulationProvider()],
    ]);
    const client = new UnifiedClient(providers);

    await expect(client.generateUnified({
      ...dummyRequest,
      tools: [
        {
          name: 'bad-name',
          description: 'bad',
          input_schema: { type: 'object' },
        },
      ],
    })).rejects.toThrow(InvalidRequestError);
    expect(anthropic.generate).not.toHaveBeenCalled();
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

  it('initializes adapters on first use and closes them via client.close()', async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const adapter: ProviderAdapter = {
      provider_name: 'anthropic',
      initialize,
      close,
      supports_tool_choice: () => true,
      generate: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'ok' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: { reason: 'stop', raw: 'stop' },
        model: 'test-model',
        provider: 'anthropic',
      }),
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'stream_start', model: 'test-model' };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'ok' } };
      },
    };
    const client = new UnifiedClient(new Map([['anthropic', adapter], ['simulation', new SimulationProvider()]]));

    await client.generateUnified({ provider: 'anthropic', messages: [{ role: 'user', content: 'Hi' }] });
    await client.generateUnified({ provider: 'anthropic', messages: [{ role: 'user', content: 'Again' }] });
    expect(initialize).toHaveBeenCalledTimes(1);

    await client.close();
    expect(close).toHaveBeenCalledTimes(1);

    await client.generateUnified({ provider: 'anthropic', messages: [{ role: 'user', content: 'After close' }] });
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported tool_choice modes before provider calls', async () => {
    const adapter: ProviderAdapter = {
      provider_name: 'gemini',
      supports_tool_choice: (mode) => mode !== 'named',
      generate: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'ok' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: { reason: 'stop', raw: 'stop' },
        model: 'test-model',
        provider: 'gemini',
      }),
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'stream_start', model: 'test-model' };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'ok' } };
      },
    };
    const client = new UnifiedClient(new Map([['gemini', adapter], ['simulation', new SimulationProvider()]]));

    await expect(client.generateUnified({
      provider: 'gemini',
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: { type: 'named', name: 'read_file' },
      tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } }],
    })).rejects.toBeInstanceOf(UnsupportedToolChoiceError);

    expect(adapter.generate).not.toHaveBeenCalled();
  });

  it('threads timeout.per_step_ms through each tool-loop generation step', async () => {
    const observedTimeouts: Array<GenerateRequest['timeout']> = [];
    const adapter: ProviderAdapter = {
      provider_name: 'openai',
      supports_tool_choice: () => true,
      generate: vi
        .fn()
        .mockImplementationOnce(async (request: GenerateRequest) => {
          observedTimeouts.push(request.timeout);
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'tool_call', id: 'call_1', name: 'echo', arguments: '{}', tool_type: 'function' }],
            },
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            finish_reason: { reason: 'tool_calls', raw: 'tool_calls' },
            model: 'gpt-test',
            provider: 'openai',
          };
        })
        .mockImplementationOnce(async (request: GenerateRequest) => {
          observedTimeouts.push(request.timeout);
          return {
            message: { role: 'assistant', content: 'done' },
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            finish_reason: { reason: 'stop', raw: 'stop' },
            model: 'gpt-test',
            provider: 'openai',
          };
        }),
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'stream_start', model: 'gpt-test' };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'done' } };
      },
    };
    const client = new UnifiedClient(new Map([['openai', adapter], ['simulation', new SimulationProvider()]]));

    await generateWithTools({
      provider: 'openai',
      messages: [{ role: 'user', content: 'Use the tool then finish' }],
      timeout: { request_ms: 5_000, per_step_ms: 123 },
      tools: [{
        name: 'echo',
        description: 'Echo',
        input_schema: { type: 'object' },
        execute: async () => 'ok',
      }],
    }, { client });

    expect(observedTimeouts).toHaveLength(2);
    for (const timeout of observedTimeouts) {
      expect(typeof timeout).toBe('object');
      expect(timeout).toMatchObject({ request_ms: 123, per_step_ms: 123 });
    }
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

  it('normalizes local image file paths to base64 before provider translation', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-client-image-'));
    tempDirs.push(workspace);
    const imagePath = path.join(workspace, 'sample.png');
    const imageBytes = Buffer.from('png-bytes');
    await writeFile(imagePath, imageBytes);

    let observedImageSource: unknown;
    const adapter: ProviderAdapter = {
      provider_name: 'anthropic',
      async generate(request: GenerateRequest): Promise<GenerateResponse> {
        const message = request.messages[0];
        if (message && Array.isArray(message.content)) {
          const imagePart = message.content.find((part): part is Extract<ContentPart, { type: 'image' }> => part.type === 'image');
          observedImageSource = imagePart?.source;
        }
        return {
          message: { role: 'assistant', content: 'ok' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'test',
          provider: 'anthropic',
        };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'stream_start', model: 'test' };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'ok' } };
      },
    };

    const client = new UnifiedClient(new Map([['anthropic', adapter], ['simulation', new SimulationProvider()]]));
    await client.generateUnified({
      provider: 'anthropic',
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: imagePath } }],
      }],
    });

    expect(observedImageSource).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: imageBytes.toString('base64'),
    });
  });

  it('accepts structured timeout config on requests', async () => {
    let observedRequestMs: number | undefined;
    const adapter: ProviderAdapter = {
      provider_name: 'anthropic',
      async generate(request: GenerateRequest): Promise<GenerateResponse> {
        observedRequestMs = resolveTimeout(request.timeout, request.timeout_ms).request_ms;
        return {
          message: { role: 'assistant', content: 'ok' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'test',
          provider: 'anthropic',
        };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'stream_start', model: 'test' };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'ok' } };
      },
    };

    const client = new UnifiedClient(new Map([['anthropic', adapter], ['simulation', new SimulationProvider()]]));
    await client.generateUnified({
      messages: [{ role: 'user', content: 'Hi' }],
      timeout: { request_ms: 4321 },
    });
    expect(observedRequestMs).toBe(4321);
  });

  it('supports legacy timeout_ms as request timeout', async () => {
    let observedRequestMs: number | undefined;
    const adapter: ProviderAdapter = {
      provider_name: 'anthropic',
      async generate(request: GenerateRequest): Promise<GenerateResponse> {
        observedRequestMs = resolveTimeout(request.timeout, request.timeout_ms).request_ms;
        return {
          message: { role: 'assistant', content: 'ok' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'test',
          provider: 'anthropic',
        };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'stream_start', model: 'test' };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'ok' } };
      },
    };

    const client = new UnifiedClient(new Map([['anthropic', adapter], ['simulation', new SimulationProvider()]]));
    await client.generateUnified({
      messages: [{ role: 'user', content: 'Hi' }],
      timeout_ms: 8765,
    });
    expect(observedRequestMs).toBe(8765);
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
      delete process.env.OPENAI_COMPATIBLE_BASE_URL;
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
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

    it('registers openai_compatible when OPENAI_COMPATIBLE_BASE_URL is set', () => {
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1234';
      process.env.OPENAI_COMPATIBLE_API_KEY = 'test';
      const client = UnifiedClient.from_env();
      expect(client.available_providers()).toContain('openai_compatible');
      expect(client.available_providers()).toContain('simulation');
    });
  });
});
