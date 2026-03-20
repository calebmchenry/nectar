import { createHash } from 'node:crypto';
import type { ToolCallEnvelope } from './types.js';

const WINDOW_SIZE = 5;
const REPEAT_THRESHOLD = 3;

/** Tracks tool-call fingerprints to detect runaway loops. */
export class LoopDetector {
  private fingerprints: string[] = [];
  private mutatedInRound = false;

  /** Record that a file was mutated in this round (write/edit succeeded). */
  markMutation(): void {
    this.mutatedInRound = true;
  }

  /**
   * Record a completed tool round and check for loops.
   * Returns the fingerprint if loop detected, null otherwise.
   */
  recordRound(toolCalls: ToolCallEnvelope[]): string | null {
    const fp = fingerprint(toolCalls);
    this.fingerprints.push(fp);

    // Keep window bounded
    if (this.fingerprints.length > WINDOW_SIZE) {
      this.fingerprints.shift();
    }

    // Check for N consecutive identical fingerprints with no mutation
    if (this.fingerprints.length >= REPEAT_THRESHOLD) {
      const last = this.fingerprints.slice(-REPEAT_THRESHOLD);
      const allSame = last.every((f) => f === last[0]);
      if (allSame && !this.mutatedInRound) {
        return fp;
      }
    }

    // Reset mutation flag for next round
    this.mutatedInRound = false;
    return null;
  }
}

function fingerprint(toolCalls: ToolCallEnvelope[]): string {
  const data = toolCalls
    .map((c) => c.name + JSON.stringify(c.arguments))
    .join('|');
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}
