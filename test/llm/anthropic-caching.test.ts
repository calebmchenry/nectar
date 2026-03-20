import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AnthropicAdapter, injectCacheBreakpoints } from '../../src/llm/adapters/anthropic.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function anthropicOk(overrides?: Partial<Record<string, unknown>>) {
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 },
    ...overrides
  }), { status: 200 });
}

describe('Anthropic Prompt Caching (L10)', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  describe('injectCacheBreakpoints()', () => {
    it('sets breakpoint on system prompt last block (string system)', () => {
      const body: Record<string, unknown> = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'You are helpful'
      };

      injectCacheBreakpoints(body);

      // String system should be converted to array with cache_control
      const system = body.system as Array<Record<string, unknown>>;
      expect(Array.isArray(system)).toBe(true);
      expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('sets breakpoint on system prompt last block (array system)', () => {
      const body: Record<string, unknown> = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
        system: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }]
      };

      injectCacheBreakpoints(body);

      const system = body.system as Array<Record<string, unknown>>;
      expect(system[0]!.cache_control).toBeUndefined();
      expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('sets breakpoint on last tool definition', () => {
      const body: Record<string, unknown> = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { name: 'tool_a', description: 'A', input_schema: {} },
          { name: 'tool_b', description: 'B', input_schema: {} }
        ]
      };

      injectCacheBreakpoints(body);

      const tools = body.tools as Array<Record<string, unknown>>;
      expect(tools[0]!.cache_control).toBeUndefined();
      expect(tools[1]!.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('sets breakpoint on conversation prefix (second-to-last user message)', () => {
      const body: Record<string, unknown> = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'first question' }] },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: [{ type: 'text', text: 'second question' }] }
        ]
      };

      injectCacheBreakpoints(body);

      const messages = body.messages as Array<{ role: string; content: unknown }>;
      // First user message (second-to-last user) should have breakpoint
      const firstUserContent = messages[0]!.content as Array<Record<string, unknown>>;
      expect(firstUserContent[0]!.cache_control).toEqual({ type: 'ephemeral' });
      // Last user message should NOT have breakpoint
      const lastUserContent = messages[2]!.content as Array<Record<string, unknown>>;
      expect(lastUserContent[0]!.cache_control).toBeUndefined();
    });

    it('no prefix breakpoint for single-turn conversations', () => {
      const body: Record<string, unknown> = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'only question' }] }
        ]
      };

      injectCacheBreakpoints(body);

      const messages = body.messages as Array<{ role: string; content: unknown }>;
      const content = messages[0]!.content as Array<Record<string, unknown>>;
      expect(content[0]!.cache_control).toBeUndefined();
    });

    it('empty tools → no tool breakpoint, no crash', () => {
      const body: Record<string, unknown> = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
        tools: []
      };

      expect(() => injectCacheBreakpoints(body)).not.toThrow();
    });

    it('empty/missing system → no system breakpoint, no crash', () => {
      const body: Record<string, unknown> = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }]
      };

      expect(() => injectCacheBreakpoints(body)).not.toThrow();
    });
  });

  describe('Adapter integration', () => {
    const adapter = new AnthropicAdapter('test-key');

    it('caching is active by default', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        system: 'You are helpful'
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      // System should be array with cache_control
      const system = body.system as Array<Record<string, unknown>>;
      expect(Array.isArray(system)).toBe(true);
      expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });

      // Beta header should include caching
      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers['anthropic-beta']).toContain('prompt-caching-2024-07-31');
    });

    it('no breakpoints when cache_control: false', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        system: 'You are helpful',
        provider_options: { anthropic: { cache_control: false } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      // System should be plain string, not array with cache_control
      expect(body.system).toBe('You are helpful');
    });

    it('cache_read_tokens and cache_write_tokens reported in Usage', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());

      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }]
      });

      expect(result.usage.cache_read_tokens).toBe(50);
      expect(result.usage.cache_write_tokens).toBe(100);
    });

    it('caching + structured output: synthetic tool gets breakpoint', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
        content: [{ type: 'tool_use', id: 'tu_1', name: '__structured_output', input: { key: 'value' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 20 }
      }), { status: 200 }));

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'Test', schema: { type: 'object' } } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      const tools = body.tools as Array<Record<string, unknown>>;
      // Last tool (synthetic) should have cache_control
      const lastTool = tools[tools.length - 1]!;
      expect(lastTool.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('caching beta auto-added to anthropic-beta header', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }]
      });

      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers['anthropic-beta']).toContain('prompt-caching-2024-07-31');
    });
  });
});
