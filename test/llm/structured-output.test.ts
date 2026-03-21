import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AnthropicAdapter } from '../../src/llm/adapters/anthropic.js';
import { OpenAIAdapter } from '../../src/llm/adapters/openai.js';
import { GeminiAdapter } from '../../src/llm/adapters/gemini.js';
import type { GenerateRequest } from '../../src/llm/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const testSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, score: { type: 'number' } },
  required: ['name', 'score']
};

describe('Structured Output per-provider (L4)', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  describe('Anthropic', () => {
    const adapter = new AnthropicAdapter('test-key');

    it('injects synthetic __structured_output tool with json_schema', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
        content: [{ type: 'tool_use', id: 'tu_1', name: '__structured_output', input: { name: 'test', score: 95 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 20 }
      }), { status: 200 }));

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'TestSchema', schema: testSchema } },
        provider_options: { anthropic: { cache_control: false } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      const tools = body.tools as Array<Record<string, unknown>>;
      const synth = tools.find(t => t.name === '__structured_output');
      expect(synth).toBeDefined();
      expect(synth!.input_schema).toEqual(testSchema);
    });

    it('sets forced tool_choice to __structured_output', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
        content: [{ type: 'tool_use', id: 'tu_1', name: '__structured_output', input: { name: 'test', score: 95 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 20 }
      }), { status: 200 }));

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'TestSchema', schema: testSchema } },
        provider_options: { anthropic: { cache_control: false } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      expect(body.tool_choice).toEqual({ type: 'tool', name: '__structured_output' });
    });

    it('rewrites synthetic tool_use to text in response, stop_reason is stop', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
        content: [{ type: 'tool_use', id: 'tu_1', name: '__structured_output', input: { name: 'test', score: 95 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 20 }
      }), { status: 200 }));

      const result = await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'TestSchema', schema: testSchema } },
        provider_options: { anthropic: { cache_control: false } }
      });

      expect(result.stop_reason).toBe('stop');
      expect(result.finish_reason.raw).toBe('tool_use');
      const parts = result.message.content as Array<{ type: string; text?: string }>;
      expect(parts[0]!.type).toBe('text');
      const parsed = JSON.parse(parts[0]!.text!);
      expect(parsed.name).toBe('test');
      expect(parsed.score).toBe(95);
    });

    it('preserves caller tools alongside synthetic tool', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
        content: [{ type: 'tool_use', id: 'tu_1', name: '__structured_output', input: { name: 'test', score: 95 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 20 }
      }), { status: 200 }));

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'my_tool', description: 'A tool', input_schema: { type: 'object' } }],
        response_format: { type: 'json_schema', json_schema: { name: 'TestSchema', schema: testSchema } },
        provider_options: { anthropic: { cache_control: false } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      const tools = body.tools as Array<Record<string, unknown>>;
      expect(tools.length).toBe(2);
      expect(tools.some(t => t.name === 'my_tool')).toBe(true);
      expect(tools.some(t => t.name === '__structured_output')).toBe(true);
    });

    it('json mode uses permissive object schema', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
        content: [{ type: 'tool_use', id: 'tu_1', name: '__structured_output', input: { key: 'value' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 20 }
      }), { status: 200 }));

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json' },
        provider_options: { anthropic: { cache_control: false } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      const tools = body.tools as Array<Record<string, unknown>>;
      const synth = tools.find(t => t.name === '__structured_output');
      expect(synth!.input_schema).toEqual({ type: 'object' });
    });

    it('streaming: synthetic tool deltas accumulated and rewritten', async () => {
      const sseData = [
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"__structured_output"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"name\\""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":":\\"test\\",\\"score\\":95}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');

      mockFetch.mockResolvedValueOnce(new Response(sseData, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      }));

      const events = [];
      for await (const e of adapter.stream({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'TestSchema', schema: testSchema } },
        provider_options: { anthropic: { cache_control: false } }
      })) {
        events.push(e);
      }

      // Should see content_delta events (synthetic tool args emitted as content)
      const contentDeltas = events.filter(e => e.type === 'content_delta');
      expect(contentDeltas.length).toBeGreaterThan(0);

      // Should NOT see tool_call_delta events for synthetic tool
      const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
      expect(toolDeltas.length).toBe(0);

      // stream_end should have end_turn, not tool_use
      const endEvent = events.find(e => e.type === 'stream_end') as { type: 'stream_end'; stop_reason: string };
      expect(endEvent.stop_reason).toBe('end_turn');
    });
  });

  describe('OpenAI', () => {
    const adapter = new OpenAIAdapter('test-key');

    it('sets text.format for json_schema mode', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_1', model: 'gpt-4o', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"name":"test","score":95}' }] }],
        usage: { input_tokens: 10, output_tokens: 5 }
      }), { status: 200 }));

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'TestSchema', schema: testSchema } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      const text = body.text as Record<string, unknown>;
      expect(text.format).toEqual({
        type: 'json_schema',
        name: 'TestSchema',
        schema: testSchema,
        strict: true
      });
    });

    it('sets text.format for json mode', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_1', model: 'gpt-4o', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
        usage: { input_tokens: 10, output_tokens: 5 }
      }), { status: 200 }));

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json' }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      const text = body.text as Record<string, unknown>;
      expect(text.format).toEqual({ type: 'json_object' });
    });
  });

  describe('Gemini', () => {
    const adapter = new GeminiAdapter('test-key');

    it('sets responseMimeType and responseSchema for json_schema', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"name":"test","score":95}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
      }), { status: 200 }));

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'TestSchema', schema: testSchema } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      const genConfig = body.generationConfig as Record<string, unknown>;
      expect(genConfig.responseMimeType).toBe('application/json');
      expect(genConfig.responseSchema).toEqual(testSchema);
    });

    it('sets responseMimeType for json mode (no schema)', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
      }), { status: 200 }));

      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json' }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      const genConfig = body.generationConfig as Record<string, unknown>;
      expect(genConfig.responseMimeType).toBe('application/json');
      expect(genConfig.responseSchema).toBeUndefined();
    });
  });

  describe('text mode', () => {
    it('all providers: text mode produces no changes to request', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 }
      }), { status: 200 }));

      const adapter = new AnthropicAdapter('test-key');
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'text' },
        provider_options: { anthropic: { cache_control: false } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      // No tools or tool_choice should be added for text mode
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });
  });
});
