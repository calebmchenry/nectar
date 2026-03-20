import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AnthropicAdapter } from '../../src/llm/adapters/anthropic.js';
import { OpenAIAdapter } from '../../src/llm/adapters/openai.js';
import { GeminiAdapter } from '../../src/llm/adapters/gemini.js';
import type { GenerateRequest } from '../../src/llm/types.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function anthropicOk(overrides?: Partial<Record<string, unknown>>) {
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', model: 'claude-sonnet-4-20250514',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides
  }), { status: 200 });
}

function openaiOk() {
  return new Response(JSON.stringify({
    id: 'resp_1', model: 'gpt-4o', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    usage: { input_tokens: 10, output_tokens: 5 }
  }), { status: 200 });
}

function geminiOk() {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
  }), { status: 200 });
}

describe('provider_options (L20)', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  describe('Anthropic beta headers (L11)', () => {
    const adapter = new AnthropicAdapter('test-key');

    it('injects single beta header', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        provider_options: { anthropic: { betas: ['my-beta-1'] } }
      });

      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers['anthropic-beta']).toContain('my-beta-1');
    });

    it('comma-joins multiple betas', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        provider_options: { anthropic: { betas: ['beta-a', 'beta-b'] } }
      });

      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      // Should contain both, with prompt-caching beta auto-added
      expect(headers['anthropic-beta']).toContain('beta-a');
      expect(headers['anthropic-beta']).toContain('beta-b');
    });

    it('deduplicates betas', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        provider_options: { anthropic: { betas: ['prompt-caching-2024-07-31', 'other'] } }
      });

      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      const betas = headers['anthropic-beta']!.split(',');
      const cacheBetas = betas.filter(b => b === 'prompt-caching-2024-07-31');
      expect(cacheBetas.length).toBe(1); // deduplicated
    });

    it('auto-injects thinking beta when reasoning_effort is set', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high'
      });

      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers['anthropic-beta']).toContain('interleaved-thinking-2025-05-14');
    });

    it('auto-injects caching beta by default', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }]
      });

      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers['anthropic-beta']).toContain('prompt-caching-2024-07-31');
    });

    it('no beta header when empty betas and no features', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        provider_options: { anthropic: { cache_control: false } }
      });

      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers['anthropic-beta']).toBeUndefined();
    });

    it('beta header present in stream() requests', async () => {
      mockFetch.mockResolvedValueOnce(new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      ));

      const events = [];
      for await (const e of adapter.stream({
        messages: [{ role: 'user', content: 'hi' }],
        provider_options: { anthropic: { betas: ['my-stream-beta'] } }
      })) {
        events.push(e);
      }

      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers['anthropic-beta']).toContain('my-stream-beta');
    });
  });

  describe('OpenAI provider_options', () => {
    const adapter = new OpenAIAdapter('test-key');

    it('merges store and metadata', async () => {
      mockFetch.mockResolvedValueOnce(openaiOk());
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        provider_options: { openai: { store: true, metadata: { env: 'test' } } }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      expect(body.store).toBe(true);
      expect(body.metadata).toEqual({ env: 'test' });
    });
  });

  describe('Gemini provider_options', () => {
    const adapter = new GeminiAdapter('test-key');

    it('merges safety_settings', async () => {
      mockFetch.mockResolvedValueOnce(geminiOk());
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        provider_options: {
          gemini: {
            safety_settings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }]
          }
        }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      expect(body.safetySettings).toEqual([{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }]);
    });

    it('merges generation_config', async () => {
      mockFetch.mockResolvedValueOnce(geminiOk());
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        provider_options: {
          gemini: { generation_config: { topK: 40 } }
        }
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      expect((body.generationConfig as Record<string, unknown>).topK).toBe(40);
    });
  });

  describe('unknown provider_options silently ignored', () => {
    it('Anthropic ignores openai options', async () => {
      mockFetch.mockResolvedValueOnce(anthropicOk());
      const adapter = new AnthropicAdapter('test-key');
      // Should not throw
      await adapter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        provider_options: { openai: { store: true } } as GenerateRequest['provider_options']
      });
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});
