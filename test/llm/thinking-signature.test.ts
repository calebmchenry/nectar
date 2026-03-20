import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AnthropicAdapter } from '../../src/llm/adapters/anthropic.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('ThinkingData.signature (L2)', () => {
  const adapter = new AnthropicAdapter('test-key');

  beforeEach(() => { mockFetch.mockReset(); });

  it('extracts signature from response thinking blocks', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
      content: [
        { type: 'thinking', thinking: 'Let me think...', signature: 'ErUBsig123' },
        { type: 'text', text: 'Here is my answer' }
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 }
    }), { status: 200 }));

    const result = await adapter.generate({
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
      provider_options: { anthropic: { cache_control: false } }
    });

    const parts = result.message.content;
    expect(Array.isArray(parts)).toBe(true);
    const thinkingPart = (parts as Array<{ type: string; thinking?: string; signature?: string }>).find(p => p.type === 'thinking');
    expect(thinkingPart).toBeDefined();
    expect(thinkingPart!.thinking).toBe('Let me think...');
    expect(thinkingPart!.signature).toBe('ErUBsig123');
  });

  it('includes signature when serializing thinking blocks in requests', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_2', type: 'message', model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text: 'continued' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    }), { status: 200 }));

    await adapter.generate({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Previous thinking', signature: 'sig-abc' },
            { type: 'text', text: 'Previous answer' }
          ]
        },
        { role: 'user', content: 'follow up' }
      ],
      reasoning_effort: 'high',
      provider_options: { anthropic: { cache_control: false } }
    });

    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const assistantMsg = messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    const blocks = assistantMsg!.content as Array<Record<string, unknown>>;
    const thinkingBlock = blocks.find(b => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.signature).toBe('sig-abc');
  });

  it('round-trips multi-turn thinking with signatures', async () => {
    // First turn response with signature
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
      content: [
        { type: 'thinking', thinking: 'Turn 1 thinking', signature: 'sig-turn1' },
        { type: 'text', text: 'Turn 1 answer' }
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 }
    }), { status: 200 }));

    const turn1 = await adapter.generate({
      messages: [{ role: 'user', content: 'first question' }],
      reasoning_effort: 'high',
      provider_options: { anthropic: { cache_control: false } }
    });

    // Second turn — send back the assistant message with signature
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_2', type: 'message', model: 'claude-sonnet-4-20250514',
      content: [
        { type: 'thinking', thinking: 'Turn 2 thinking', signature: 'sig-turn2' },
        { type: 'text', text: 'Turn 2 answer' }
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 30, output_tokens: 20 }
    }), { status: 200 }));

    const turn2 = await adapter.generate({
      messages: [
        { role: 'user', content: 'first question' },
        turn1.message,
        { role: 'user', content: 'follow up' }
      ],
      reasoning_effort: 'high',
      provider_options: { anthropic: { cache_control: false } }
    });

    // Verify turn 1's signature was sent in request
    const turn2Body = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
    const turn2Messages = turn2Body.messages as Array<{ role: string; content: unknown }>;
    const assistantMsg = turn2Messages.find(m => m.role === 'assistant');
    const blocks = assistantMsg!.content as Array<Record<string, unknown>>;
    const thinking = blocks.find(b => b.type === 'thinking');
    expect(thinking!.signature).toBe('sig-turn1');

    // Verify turn 2's response has signature
    const turn2Parts = turn2.message.content as Array<{ type: string; signature?: string }>;
    const turn2Thinking = turn2Parts.find(p => p.type === 'thinking');
    expect(turn2Thinking!.signature).toBe('sig-turn2');
  });

  it('backward compatible: missing signature causes no errors', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
      content: [
        { type: 'thinking', thinking: 'thinking without signature' },
        { type: 'text', text: 'answer' }
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    }), { status: 200 }));

    const result = await adapter.generate({
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
      provider_options: { anthropic: { cache_control: false } }
    });

    const parts = result.message.content as Array<{ type: string; thinking?: string; signature?: string }>;
    const thinking = parts.find(p => p.type === 'thinking');
    expect(thinking).toBeDefined();
    expect(thinking!.signature).toBeUndefined();
  });

  it('thinking blocks without signature do not include signature key in request', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    }), { status: 200 }));

    await adapter.generate({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'no signature here' },
            { type: 'text', text: 'answer' }
          ]
        },
        { role: 'user', content: 'follow up' }
      ],
      provider_options: { anthropic: { cache_control: false } }
    });

    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const assistantMsg = messages.find(m => m.role === 'assistant');
    const blocks = assistantMsg!.content as Array<Record<string, unknown>>;
    const thinking = blocks.find(b => b.type === 'thinking');
    expect(thinking).toBeDefined();
    expect('signature' in thinking!).toBe(false);
  });
});
