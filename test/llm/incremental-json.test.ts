import { describe, expect, it } from 'vitest';
import { IncrementalJsonParser } from '../../src/llm/incremental-json.js';

describe('IncrementalJsonParser', () => {
  it('emits partial objects for flat JSON keys', () => {
    const parser = new IncrementalJsonParser<{ summary: string; score: number }>();
    const first = parser.feed('{"summary":"ok",');
    expect(first).toEqual([{ summary: 'ok' }]);

    const second = parser.feed('"score":7}');
    expect(second).toEqual([{ summary: 'ok', score: 7 }]);
  });

  it('handles nested objects and arrays across chunks', () => {
    const parser = new IncrementalJsonParser<{
      summary: { text: string };
      risks: string[];
      open_questions: string;
    }>();

    const first = parser.feed('{"summary":{"text":"ready"},"risks":[');
    expect(first).toEqual([{ summary: { text: 'ready' } }]);

    const second = parser.feed('"a","b"],"open_questions":"none"}');
    expect(second).toEqual([
      { summary: { text: 'ready' }, risks: ['a', 'b'] },
      { summary: { text: 'ready' }, risks: ['a', 'b'], open_questions: 'none' },
    ]);
  });

  it('handles escaped strings and unicode escapes', () => {
    const parser = new IncrementalJsonParser<{ summary: string; emoji: string }>();
    const partials = parser.feed('{"summary":"line\\\\n","emoji":"\\u263A"}');
    expect(partials).toEqual([
      { summary: 'line\\n' },
      { summary: 'line\\n', emoji: '☺' },
    ]);
  });

  it('does not fail on chunks that end mid-key', () => {
    const parser = new IncrementalJsonParser<{ summary: string; risks: string }>();
    const first = parser.feed('{"summary":"ok","ri');
    expect(first).toEqual([{ summary: 'ok' }]);

    const second = parser.feed('sks":"low"}');
    expect(second).toEqual([{ summary: 'ok', risks: 'low' }]);
  });

  it('throws on malformed JSON snapshots', () => {
    const parser = new IncrementalJsonParser<{ summary: string }>();
    expect(() => parser.feed('{"summary":"ok",,')).toThrow('Failed to parse incremental JSON snapshot');
  });
});
