import { describe, expect, it } from 'vitest';
import { normalizeContent, getTextContent, ContentKind, Message as MessageHelpers } from '../../src/llm/types.js';
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
  it('supports all content variants', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      { type: 'audio', source: { media_type: 'audio/mpeg', data: 'SUQz' } },
      { type: 'document', source: { media_type: 'application/pdf', data: 'JVBERi0xLjQK', file_name: 'report.pdf' } },
      { type: 'tool_call', id: '1', name: 'fn', arguments: '{}' },
      { type: 'tool_result', tool_call_id: '1', content: 'result' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'redacted_thinking' }
    ];
    expect(parts).toHaveLength(8);
    expect(parts[0]!.type).toBe('text');
    expect(parts[7]!.type).toBe('redacted_thinking');
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

  it('supports all 5 roles', () => {
    const roles: Message['role'][] = ['system', 'user', 'assistant', 'tool', 'developer'];
    expect(roles).toHaveLength(5);
  });

  it('exposes tool_call_id for tool result messages (U4)', () => {
    const msg = MessageHelpers.tool_result('call-123', 'ok');
    expect(msg.tool_call_id).toBe('call-123');
  });

  it('exposes Message.text accessor concatenating only text parts (U5)', () => {
    const msg = MessageHelpers.assistant([
      { type: 'text', text: 'hello ' },
      { type: 'tool_call', id: '1', name: 'fn', arguments: '{}' },
      { type: 'text', text: 'world' },
    ]);
    expect(msg.text).toBe('hello world');
  });
});

describe('Usage', () => {
  it('supports all token fields', () => {
    const usage: Usage = {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      reasoning_tokens: 10,
      cache_read_tokens: 5,
      cache_write_tokens: 2
    };
    expect(usage.reasoning_tokens).toBe(10);
    expect(usage.cache_read_tokens).toBe(5);
    expect(usage.total_tokens).toBe(150);
  });
});

describe('StopReason', () => {
  it('includes all 4 values', () => {
    const reasons: StopReason[] = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'];
    expect(reasons).toHaveLength(4);
  });
});

describe('ContentKind', () => {
  it('includes AUDIO and DOCUMENT', () => {
    expect(ContentKind.AUDIO).toBe('audio');
    expect(ContentKind.DOCUMENT).toBe('document');
  });
});
