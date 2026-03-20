import { describe, expect, it } from 'vitest';
import { LoopDetector } from '../../src/agent-loop/loop-detection.js';
import type { ToolCallEnvelope } from '../../src/agent-loop/types.js';

function makeCall(name: string, args: Record<string, unknown> = {}): ToolCallEnvelope {
  return { name, arguments: args, call_id: `call-${Math.random()}` };
}

describe('LoopDetector', () => {
  it('does not fire on first round', () => {
    const detector = new LoopDetector();
    const result = detector.recordRound([makeCall('grep', { pattern: 'TODO' })]);
    expect(result).toBeNull();
  });

  it('does not fire on two identical rounds', () => {
    const detector = new LoopDetector();
    const calls = [makeCall('grep', { pattern: 'TODO' })];
    detector.recordRound(calls);
    const result = detector.recordRound(calls);
    expect(result).toBeNull();
  });

  it('fires on 3 consecutive identical rounds with no mutation', () => {
    const detector = new LoopDetector();
    const calls = [makeCall('grep', { pattern: 'TODO' })];
    detector.recordRound(calls);
    detector.recordRound(calls);
    const result = detector.recordRound(calls);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
  });

  it('does NOT fire when files are being mutated', () => {
    const detector = new LoopDetector();
    const calls = [makeCall('edit_file', { path: 'foo.ts', old_string: 'a', new_string: 'b' })];

    detector.markMutation();
    detector.recordRound(calls);
    detector.markMutation();
    detector.recordRound(calls);
    detector.markMutation();
    const result = detector.recordRound(calls);
    expect(result).toBeNull();
  });

  it('does not fire on different tool calls', () => {
    const detector = new LoopDetector();
    detector.recordRound([makeCall('grep', { pattern: 'A' })]);
    detector.recordRound([makeCall('grep', { pattern: 'B' })]);
    const result = detector.recordRound([makeCall('grep', { pattern: 'C' })]);
    expect(result).toBeNull();
  });

  it('fires when mutation stops but calls continue identically', () => {
    const detector = new LoopDetector();
    const calls = [makeCall('read_file', { path: 'foo.ts' })];

    // First round: mutation
    detector.markMutation();
    detector.recordRound(calls);

    // Next 3 rounds: no mutation, same calls
    detector.recordRound(calls);
    detector.recordRound(calls);
    const result = detector.recordRound(calls);
    expect(result).not.toBeNull();
  });
});
