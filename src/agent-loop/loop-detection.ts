import { createHash } from 'node:crypto';
import type { ToolCallEnvelope } from './types.js';

const PATTERN_LENGTHS = [1, 2, 3] as const;
const MIN_PATTERN_REPEATS = 3;

interface RoundFingerprint {
  value: string;
  mutated: boolean;
}

/** Tracks tool-call fingerprints to detect runaway loops. */
export class LoopDetector {
  private readonly windowSize: number;
  private fingerprints: RoundFingerprint[] = [];
  private mutatedInRound = false;

  constructor(windowSize = 10) {
    this.windowSize = Math.max(1, windowSize);
  }

  /** Record that a file was mutated in this round (write/edit succeeded). */
  markMutation(): void {
    this.mutatedInRound = true;
  }

  /** Clear recorded fingerprints after steering intervention. */
  reset(): void {
    this.fingerprints = [];
    this.mutatedInRound = false;
  }

  /**
   * Record a completed tool round and check for loops.
   * Returns the fingerprint if loop detected, null otherwise.
   */
  recordRound(toolCalls: ToolCallEnvelope[]): string | null {
    const fp = fingerprint(toolCalls);
    this.fingerprints.push({
      value: fp,
      mutated: this.mutatedInRound,
    });

    // Keep window bounded
    if (this.fingerprints.length > this.windowSize) {
      this.fingerprints.shift();
    }

    const stableWindow = this.windowSinceLastMutation().map((entry) => entry.value);

    if (hasRepeatingPattern(stableWindow)) {
      this.mutatedInRound = false;
      return fp;
    }

    // Reset mutation flag for next round
    this.mutatedInRound = false;
    return null;
  }

  private windowSinceLastMutation(): RoundFingerprint[] {
    for (let index = this.fingerprints.length - 1; index >= 0; index -= 1) {
      if (this.fingerprints[index]?.mutated) {
        return this.fingerprints.slice(index + 1);
      }
    }
    return this.fingerprints;
  }
}

function fingerprint(toolCalls: ToolCallEnvelope[]): string {
  const data = toolCalls
    .map((c) => c.name + JSON.stringify(c.arguments))
    .join('|');
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function hasRepeatingPattern(values: string[]): boolean {
  for (const patternLength of PATTERN_LENGTHS) {
    const minLength = patternLength * MIN_PATTERN_REPEATS;
    if (values.length < minLength) {
      continue;
    }

    const maxLength = Math.floor(values.length / patternLength) * patternLength;
    for (let length = maxLength; length >= minLength; length -= patternLength) {
      const start = values.length - length;
      const window = values.slice(start);
      if (isRepeatedWindow(window, patternLength)) {
        return true;
      }
    }
  }

  return false;
}

function isRepeatedWindow(values: string[], patternLength: number): boolean {
  const pattern = values.slice(0, patternLength);
  if (pattern.length !== patternLength) {
    return false;
  }

  for (let index = 0; index < values.length; index += patternLength) {
    for (let offset = 0; offset < patternLength; offset += 1) {
      if (values[index + offset] !== pattern[offset]) {
        return false;
      }
    }
  }

  return true;
}
