import { describe, expect, it } from 'vitest';
import { normalizeContent, getTextContent } from '../../src/llm/types.js';
import type { ContentPart, Message, Usage, StopReason } from '../../src/llm/types.js';

describe('normalizeContent', () => {
  it('converts string to ContentPart array', () => {
    const result = normalizeContent('hello');
    expect(result).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('passes through ContentPart array unchanged', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: '1', name: 'fn', arguments: '{}' }
    ];
    expect(normalizeContent(parts)).toBe(parts);
  });
});

describe('getTextContent', () => {
  it('returns string content directly', () => {
    expect(getTextContent('hello')).toBe('hello');
  });

  it('extracts text from ContentPart array', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'hello ' },
      { type: 'tool_call', id: '1', name: 'fn', arguments: '{}' },
      { type: 'text', text: 'world' }
    ];
    expect(getTextContent(parts)).toBe('hello world');
  });
});

describe('ContentPart type narrowing', () => {
  it('supports all 6 variants', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      { type: 'tool_call', id: '1', name: 'fn', arguments: '{}' },
      { type: 'tool_result', tool_call_id: '1', content: 'result' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'redacted_thinking' }
    ];
    expect(parts).toHaveLength(6);
    expect(parts[0]!.type).toBe('text');
    expect(parts[5]!.type).toBe('redacted_thinking');
  });
});

describe('Message', () => {
  it('accepts string content', () => {
    const msg: Message = { role: 'user', content: 'hello' };
    expect(msg.content).toBe('hello');
  });

  it('accepts ContentPart[] content', () => {
    const msg: Message = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
    expect(Array.isArray(msg.content)).toBe(true);
  });

  it('supports all 4 roles', () => {
    const roles: Message['role'][] = ['system', 'user', 'assistant', 'tool'];
    expect(roles).toHaveLength(4);
  });
});

describe('Usage', () => {
  it('supports all token fields', () => {
    const usage: Usage = {
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 10,
      cache_read_tokens: 5,
      cache_write_tokens: 2
    };
    expect(usage.reasoning_tokens).toBe(10);
    expect(usage.cache_read_tokens).toBe(5);
  });
});

describe('StopReason', () => {
  it('includes all 4 values', () => {
    const reasons: StopReason[] = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'];
    expect(reasons).toHaveLength(4);
  });
});
