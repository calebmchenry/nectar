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
    expect(result).toContain('[... truncated');
    expect(result).toContain('characters ...');
    // Head should be ~80 chars, tail ~20 chars
    const headPart = result.split('\n\n[...')[0]!;
    expect(headPart.length).toBe(80);
  });

  it('preserves head (80%) and tail (20%) proportions', () => {
    const text = 'H'.repeat(500) + 'T'.repeat(500);
    const result = truncateForModel(text, 200);
    // Head: 160 chars of H, tail: 40 chars of T
    expect(result.startsWith('H'.repeat(160))).toBe(true);
    expect(result.endsWith('T'.repeat(40))).toBe(true);
  });

  it('includes omitted character count in marker', () => {
    const text = 'x'.repeat(1000);
    const result = truncateForModel(text, 200);
    // 1000 - 160 (head) - 40 (tail) = 800 omitted
    expect(result).toContain('truncated 800 characters');
  });

  it('handles empty string', () => {
    expect(truncateForModel('', 100)).toBe('');
  });

  it('handles limit of 1', () => {
    const result = truncateForModel('abcdef', 1);
    expect(result).toContain('truncated');
  });
});
