import { describe, expect, it } from 'vitest';
import { buildPreamble } from '../../src/engine/preamble.js';
import type { PreambleInput, CompletedNodeRecord } from '../../src/engine/preamble.js';

function makeInput(overrides: Partial<PreambleInput> = {}): PreambleInput {
  return {
    mode: 'compact',
    goal: 'Test goal',
    run_id: 'run-001',
    completed_nodes: [],
    context: {},
    ...overrides,
  };
}

function makeNode(overrides: Partial<CompletedNodeRecord> = {}): CompletedNodeRecord {
  return {
    node_id: 'node1',
    status: 'success',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:00:01Z',
    retries: 0,
    ...overrides,
  };
}

describe('buildPreamble', () => {
  describe('full mode', () => {
    it('returns goal-only preamble', () => {
      const result = buildPreamble(makeInput({ mode: 'full' }));
      expect(result).toContain('You are continuing an existing conversation.');
      expect(result).toContain('Test goal');
    });

    it('works without a goal', () => {
      const result = buildPreamble(makeInput({ mode: 'full', goal: undefined }));
      expect(result).toBe('You are continuing an existing conversation.');
    });
  });

  describe('truncate mode', () => {
    it('includes goal and run ID', () => {
      const result = buildPreamble(makeInput({ mode: 'truncate' }));
      expect(result).toContain('Test goal');
      expect(result).toContain('run-001');
    });

    it('respects 400 char budget', () => {
      const longGoal = 'A'.repeat(500);
      const result = buildPreamble(makeInput({ mode: 'truncate', goal: longGoal }));
      expect(result.length).toBeLessThanOrEqual(400);
    });
  });

  describe('compact mode', () => {
    it('produces structured Markdown table', () => {
      const nodes = [
        makeNode({ node_id: 'start', status: 'success' }),
        makeNode({ node_id: 'tool1', status: 'success' }),
      ];
      const result = buildPreamble(makeInput({ mode: 'compact', completed_nodes: nodes }));
      expect(result).toContain('| Node | Status |');
      expect(result).toContain('start');
      expect(result).toContain('tool1');
    });

    it('handles empty completed nodes', () => {
      const result = buildPreamble(makeInput({ mode: 'compact' }));
      expect(result).toContain('No prior nodes completed.');
    });

    it('respects 3200 char budget', () => {
      const manyNodes = Array.from({ length: 200 }, (_, i) =>
        makeNode({ node_id: `node-${i}`, context_snippet: 'x'.repeat(50) })
      );
      const result = buildPreamble(makeInput({ mode: 'compact', completed_nodes: manyNodes }));
      expect(result.length).toBeLessThanOrEqual(3200);
    });
  });

  describe('summary:low mode', () => {
    it('produces one-line-per-node summary', () => {
      const nodes = [
        makeNode({ node_id: 'start' }),
        makeNode({ node_id: 'tool1', retries: 2 }),
      ];
      const result = buildPreamble(makeInput({ mode: 'summary:low', completed_nodes: nodes }));
      expect(result).toContain('start: success');
      expect(result).toContain('tool1: success (2 retries)');
    });

    it('respects 2400 char budget', () => {
      const manyNodes = Array.from({ length: 200 }, (_, i) =>
        makeNode({ node_id: `node-${i}` })
      );
      const result = buildPreamble(makeInput({ mode: 'summary:low', completed_nodes: manyNodes }));
      expect(result.length).toBeLessThanOrEqual(2400);
    });
  });

  describe('summary:medium mode', () => {
    it('includes multi-sentence details with retries and human answers', () => {
      const nodes = [
        makeNode({ node_id: 'gate', retries: 1, is_human_answer: true, human_answer: 'yes' }),
      ];
      const result = buildPreamble(makeInput({ mode: 'summary:medium', completed_nodes: nodes }));
      expect(result).toContain('gate');
      expect(result).toContain('1 retries');
      expect(result).toContain('yes');
    });

    it('respects 6000 char budget', () => {
      const manyNodes = Array.from({ length: 200 }, (_, i) =>
        makeNode({ node_id: `node-${i}`, context_snippet: 'context-data'.repeat(10) })
      );
      const result = buildPreamble(makeInput({ mode: 'summary:medium', completed_nodes: manyNodes }));
      expect(result.length).toBeLessThanOrEqual(6000);
    });
  });

  describe('summary:high mode', () => {
    it('produces detailed narrative with context state', () => {
      const nodes = [
        makeNode({ node_id: 'analyze', retries: 0, context_snippet: 'found 3 issues' }),
      ];
      const result = buildPreamble(makeInput({
        mode: 'summary:high',
        completed_nodes: nodes,
        context: { 'analyze.result': 'passed', 'graph.goal': 'Test' },
      }));
      expect(result).toContain('# Execution Summary');
      expect(result).toContain('analyze');
      expect(result).toContain('found 3 issues');
      expect(result).toContain('Context State');
    });

    it('excludes internal.* keys from context', () => {
      const result = buildPreamble(makeInput({
        mode: 'summary:high',
        completed_nodes: [makeNode()],
        context: { 'internal.retry_count.node1': '2', 'visible.key': 'value' },
      }));
      expect(result).not.toContain('internal.');
      expect(result).toContain('visible.key');
    });

    it('respects 12000 char budget', () => {
      const manyNodes = Array.from({ length: 200 }, (_, i) =>
        makeNode({ node_id: `node-${i}`, context_snippet: 'x'.repeat(100) })
      );
      const result = buildPreamble(makeInput({ mode: 'summary:high', completed_nodes: manyNodes }));
      expect(result.length).toBeLessThanOrEqual(12000);
    });
  });

  describe('truncation priority', () => {
    it('retains recent failures over old successes when over budget', () => {
      const nodes = [
        ...Array.from({ length: 100 }, (_, i) =>
          makeNode({ node_id: `old-success-${i}`, status: 'success' })
        ),
        makeNode({ node_id: 'recent-failure', status: 'failure', retries: 3 }),
      ];
      const result = buildPreamble(makeInput({ mode: 'compact', completed_nodes: nodes }));
      expect(result).toContain('recent-failure');
    });

    it('retains human answers when over budget', () => {
      const nodes = [
        ...Array.from({ length: 100 }, (_, i) =>
          makeNode({ node_id: `old-${i}`, status: 'success' })
        ),
        makeNode({ node_id: 'human-gate', is_human_answer: true, human_answer: 'approve' }),
      ];
      const result = buildPreamble(makeInput({ mode: 'compact', completed_nodes: nodes }));
      // Should include human answer reference
      expect(result.length).toBeLessThanOrEqual(3200);
    });
  });
});
