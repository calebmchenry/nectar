import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenAIAdapter } from '../../../src/llm/adapters/openai.js';
import { AnthropicAdapter } from '../../../src/llm/adapters/anthropic.js';
import { GeminiAdapter } from '../../../src/llm/adapters/gemini.js';
import type { Message } from '../../../src/llm/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function captureFetch(): { getBody: () => Record<string, unknown> } {
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: 'test',
        type: 'message',
        model: 'test-model',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => 'ok',
    } as unknown as Response;
  });

  return { getBody: () => capturedBody };
}

describe('developer role — OpenAI adapter', () => {
  it('passes developer messages natively', async () => {
    const { getBody } = captureFetch();
    const adapter = new OpenAIAdapter('test-key');

    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'developer', content: 'redirect to tests' },
    ];

    await adapter.generate({ messages });
    const body = getBody();
    const input = body.input as Array<Record<string, unknown>>;

    // Should have a message with role 'developer'
    const devMsg = input.find(i => i.role === 'developer');
    expect(devMsg).toBeDefined();
    expect(devMsg!.type).toBe('message');
    expect(devMsg!.content).toBe('redirect to tests');
  });

  it('passes multiple developer messages in FIFO order', async () => {
    const { getBody } = captureFetch();
    const adapter = new OpenAIAdapter('test-key');

    const messages: Message[] = [
      { role: 'user', content: 'start' },
      { role: 'developer', content: 'steer 1' },
      { role: 'developer', content: 'steer 2' },
    ];

    await adapter.generate({ messages });
    const body = getBody();
    const input = body.input as Array<Record<string, unknown>>;

    const devMsgs = input.filter(i => i.role === 'developer');
    expect(devMsgs).toHaveLength(2);
    expect(devMsgs[0]!.content).toBe('steer 1');
    expect(devMsgs[1]!.content).toBe('steer 2');
  });
});

describe('developer role — Anthropic adapter', () => {
  it('folds developer messages into system block as last entries', async () => {
    const { getBody } = captureFetch();
    const adapter = new AnthropicAdapter('test-key');

    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'developer', content: 'redirect to tests' },
    ];

    await adapter.generate({ messages, system: 'base system' });
    const body = getBody();

    // System should be an array with base system first, then developer message
    const system = body.system as Array<{ type: string; text: string }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system.length).toBe(2);
    expect(system[0]!.text).toBe('base system');
    expect(system[1]!.text).toBe('redirect to tests');
  });

  it('preserves FIFO order among multiple developer messages', async () => {
    const { getBody } = captureFetch();
    const adapter = new AnthropicAdapter('test-key');

    const messages: Message[] = [
      { role: 'user', content: 'start' },
      { role: 'developer', content: 'steer 1' },
      { role: 'developer', content: 'steer 2' },
    ];

    await adapter.generate({ messages, system: 'base' });
    const body = getBody();
    const system = body.system as Array<{ type: string; text: string }>;

    expect(system).toHaveLength(3);
    expect(system[1]!.text).toBe('steer 1');
    expect(system[2]!.text).toBe('steer 2');
  });

  it('developer messages do not appear in conversation messages', async () => {
    const { getBody } = captureFetch();
    const adapter = new AnthropicAdapter('test-key');

    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'developer', content: 'steer' },
    ];

    await adapter.generate({ messages });
    const body = getBody();
    const msgs = body.messages as Array<Record<string, unknown>>;

    // Only user message should be in messages array
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
  });
});

describe('developer role — Gemini adapter', () => {
  it('folds developer messages into systemInstruction', async () => {
    const { getBody } = captureFetch();
    const adapter = new GeminiAdapter('test-key');

    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'developer', content: 'redirect to tests' },
    ];

    await adapter.generate({ messages, system: 'base system' });
    const body = getBody();

    const sysInst = body.system_instruction as { parts: Array<{ text: string }> };
    expect(sysInst).toBeDefined();
    expect(sysInst.parts.length).toBeGreaterThanOrEqual(2);
    expect(sysInst.parts[0]!.text).toBe('base system');
    expect(sysInst.parts[1]!.text).toBe('redirect to tests');
  });

  it('developer messages do not appear in contents', async () => {
    const { getBody } = captureFetch();
    const adapter = new GeminiAdapter('test-key');

    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'developer', content: 'steer' },
    ];

    await adapter.generate({ messages });
    const body = getBody();
    const contents = body.contents as Array<Record<string, unknown>>;

    // Only user content
    expect(contents).toHaveLength(1);
    expect(contents[0]!.role).toBe('user');
  });
});
