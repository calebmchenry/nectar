import { describe, expect, it } from 'vitest';
import { truncateForModel } from '../../src/agent-loop/truncation.js';

describe('truncateForModel', () => {
  it('returns text as-is when under limit', () => {
    const text = 'hello world';
    expect(truncateForModel(text, 100)).toBe(text);
  });

  it('returns text as-is when exactly at limit', () => {
    const text = 'a'.repeat(100);
    expect(truncateForModel(text, 100)).toBe(text);
  });

  it('truncates with head/tail split and marker', () => {
    const text = 'A'.repeat(200);
    const result = truncateForModel(text, 100);
    expect(result).toContain('[WARNING: Tool output was truncated.');
    expect(result).toContain('characters were removed from the middle.');
    expect(result).toContain('The full output is available in the event stream.');
    const headPart = result.split('\n\n[WARNING:')[0]!;
    expect(headPart.length).toBe(50);
  });

  it('preserves head/tail 50/50 proportions', () => {
    const text = 'H'.repeat(500) + 'T'.repeat(500);
    const result = truncateForModel(text, 200);
    expect(result.startsWith('H'.repeat(100))).toBe(true);
    expect(result.endsWith('T'.repeat(100))).toBe(true);
  });

  it('includes omitted character count in marker', () => {
    const text = 'x'.repeat(1000);
    const result = truncateForModel(text, 200);
    expect(result).toContain('800 characters were removed from the middle');
  });

  it('handles empty string', () => {
    expect(truncateForModel('', 100)).toBe('');
  });

  it('handles limit of 1', () => {
    const result = truncateForModel('abcdef', 1);
    expect(result).toContain('Tool output was truncated');
  });
});
