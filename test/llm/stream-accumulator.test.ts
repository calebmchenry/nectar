import { describe, expect, it } from 'vitest';
import { StreamError } from '../../src/llm/errors.js';
import { StreamAccumulator } from '../../src/llm/stream-accumulator.js';
import { GenerateResponse } from '../../src/llm/types.js';

describe('StreamAccumulator', () => {
  it('builds partial responses from deltas before stream end', () => {
    const accumulator = new StreamAccumulator({ provider: 'openai_compatible', model: 'fallback-model' });

    accumulator.push({ type: 'stream_start', model: 'local-model' });
    accumulator.push({ type: 'content_delta', text: 'Hel' });
    accumulator.push({ type: 'content_delta', text: 'lo' });
    accumulator.push({ type: 'thinking_start' });
    accumulator.push({ type: 'thinking_delta', text: 'Need to add numbers.' });
    accumulator.push({ type: 'thinking_end' });
    accumulator.push({ type: 'tool_call_delta', id: 'call_1', name: 'sum', arguments_delta: '{"a":1' });
    accumulator.push({ type: 'tool_call_delta', id: 'call_1', arguments_delta: ',"b":2}' });
    accumulator.push({ type: 'usage', usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, reasoning_tokens: 2 } });

    accumulator.push({
      type: 'step_finish',
      step: 1,
      response: new GenerateResponse({
        message: { role: 'assistant', content: 'ignored step_finish payload' },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        finish_reason: { reason: 'stop', raw: 'stop' },
        model: 'mock-model',
        provider: 'mock',
      }),
    });
    accumulator.push({
      type: 'error',
      error: new StreamError('mock', { phase: 'transport', message: 'ignored error payload' }),
    });

    const partial = accumulator.partial_response;
    expect(partial.provider).toBe('openai_compatible');
    expect(partial.model).toBe('local-model');
    expect(partial.stop_reason).toBe('other');
    expect(partial.text).toBe('Hello');
    expect(partial.usage).toEqual({
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      reasoning_tokens: 2,
      cache_read_tokens: undefined,
      cache_write_tokens: undefined,
    });

    const parts = partial.message.content as Array<Record<string, unknown>>;
    const thinking = parts.find((part) => part.type === 'thinking');
    expect(thinking).toEqual({ type: 'thinking', thinking: 'Need to add numbers.' });

    const toolCall = parts.find((part) => part.type === 'tool_call');
    expect(toolCall).toEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'sum',
      arguments: '{"a":1,"b":2}',
    });
  });

  it('returns the explicit stream_end message for final response assembly', () => {
    const accumulator = new StreamAccumulator({ provider: 'openai_compatible', model: 'fallback-model' });

    accumulator.push({ type: 'stream_start', model: 'local-model' });
    accumulator.push({ type: 'content_delta', text: 'draft text' });
    accumulator.push({ type: 'tool_call_delta', id: 'call_partial', name: 'sum', arguments_delta: '{"x":1}' });
    accumulator.push({ type: 'usage', usage: { input_tokens: 3, output_tokens: 9, total_tokens: 12 } });
    const finalResponse = new GenerateResponse({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'final text' },
          { type: 'tool_call', id: 'call_final', name: 'sum', arguments: '{"a":1,"b":2}' },
        ],
      },
      usage: { input_tokens: 3, output_tokens: 9, total_tokens: 12 },
      finish_reason: { reason: 'tool_calls', raw: 'tool_calls' },
      model: 'local-model',
      provider: 'openai_compatible',
      id: 'resp_final',
    });
    accumulator.push({
      type: 'stream_end',
      stop_reason: 'tool_calls',
      message: finalResponse.message,
      response: finalResponse,
    });

    const response = accumulator.response();
    expect(response.stop_reason).toBe('tool_calls');
    expect(response.text).toBe('final text');
    expect(response.id).toBe('resp_final');
    expect(response.message).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'final text' },
        { type: 'tool_call', id: 'call_final', name: 'sum', arguments: '{"a":1,"b":2}' },
      ],
    });
    expect(response.usage).toEqual({
      input_tokens: 3,
      output_tokens: 9,
      total_tokens: 12,
      reasoning_tokens: undefined,
      cache_read_tokens: undefined,
      cache_write_tokens: undefined,
    });
  });

  it('normalizes legacy stream_end stop reasons to unified finish reasons', () => {
    const accumulator = new StreamAccumulator({ provider: 'mock', model: 'mock-model' });

    accumulator.push({ type: 'stream_start', model: 'mock-model' });
    accumulator.push({
      type: 'stream_end',
      stop_reason: 'end_turn',
      message: { role: 'assistant', content: 'done' },
    });

    const response = accumulator.response();
    expect(response.finish_reason).toEqual({ reason: 'stop', raw: 'end_turn' });
    expect(response.stop_reason).toBe('stop');
  });
});
