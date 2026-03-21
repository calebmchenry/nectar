import { describe, expect, it } from 'vitest';
import { LoopDetector } from '../../src/agent-loop/loop-detection.js';
import type { ToolCallEnvelope } from '../../src/agent-loop/types.js';

function makeRound(label: string): ToolCallEnvelope[] {
  return [
    {
      name: 'grep',
      arguments: { pattern: label },
      call_id: `call-${label}`,
    },
  ];
}

describe('LoopDetector', () => {
  it('does not fire on first round', () => {
    const detector = new LoopDetector();
    const result = detector.recordRound(makeRound('A'));
    expect(result).toBeNull();
  });

  it('detects single-step repeats (AAAAAA)', () => {
    const detector = new LoopDetector();
    let detected: string | null = null;

    for (let index = 0; index < 6; index += 1) {
      detected = detector.recordRound(makeRound('A'));
    }

    expect(detected).not.toBeNull();
  });

  it('detects two-step repeats (ABABAB)', () => {
    const detector = new LoopDetector();
    const sequence = ['A', 'B', 'A', 'B', 'A', 'B'];
    let detected: string | null = null;

    for (const label of sequence) {
      detected = detector.recordRound(makeRound(label));
    }

    expect(detected).not.toBeNull();
  });

  it('detects three-step repeats (ABCABCABC)', () => {
    const detector = new LoopDetector();
    const sequence = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C'];
    let detected: string | null = null;

    for (const label of sequence) {
      detected = detector.recordRound(makeRound(label));
    }

    expect(detected).not.toBeNull();
  });

  it('does not fire on non-repeating sequences', () => {
    const detector = new LoopDetector();
    const sequence = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    let detected: string | null = null;

    for (const label of sequence) {
      detected = detector.recordRound(makeRound(label));
    }

    expect(detected).toBeNull();
  });

  it('does not match patterns outside the 10-round window', () => {
    const detector = new LoopDetector();
    for (const label of ['A', 'B', 'A', 'B', 'A', 'B']) {
      detector.recordRound(makeRound(label));
    }

    let detected: string | null = null;
    for (let index = 0; index < 10; index += 1) {
      detected = detector.recordRound(makeRound(`X${index}`));
    }
    expect(detected).toBeNull();
  });

  it('respects custom detection window size', () => {
    const detector = new LoopDetector(4);
    // ABABAB pattern needs 6 rounds to trigger; with a 4-round window it should never trigger.
    const sequence = ['A', 'B', 'A', 'B', 'A', 'B'];
    let detected: string | null = null;
    for (const label of sequence) {
      detected = detector.recordRound(makeRound(label));
    }
    expect(detected).toBeNull();
  });

  it('does not fire when mutation occurs in the repeat window', () => {
    const detector = new LoopDetector();
    detector.recordRound(makeRound('A'));
    detector.recordRound(makeRound('A'));
    detector.markMutation();
    detector.recordRound(makeRound('A'));
    const detected = detector.recordRound(makeRound('A'));
    expect(detected).toBeNull();
  });

  it('fires after mutation once repeats happen again', () => {
    const detector = new LoopDetector();

    detector.markMutation();
    detector.recordRound(makeRound('A'));
    detector.recordRound(makeRound('A'));
    detector.recordRound(makeRound('A'));
    const detected = detector.recordRound(makeRound('A'));
    expect(detected).not.toBeNull();
  });
});
