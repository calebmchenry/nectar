import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FanInHandler } from '../../src/handlers/fan-in.js';
import { serializeParallelResults } from '../../src/engine/parallel-results.js';
import { GardenNode } from '../../src/garden/types.js';
import { UnifiedClient } from '../../src/llm/client.js';
import { SimulationProvider } from '../../src/llm/simulation.js';

function makeFanInNode(prompt?: string): GardenNode {
  return {
    id: 'fan_in',
    kind: 'parallel.fan_in',
    shape: 'tripleoctagon',
    prompt,
    attributes: {}
  };
}

describe('FanInHandler', () => {
  const handler = new FanInHandler();

  it('selects best candidate by outcome status ranking', async () => {
    const results = serializeParallelResults({
      branches: [
        { branchId: 'a', status: 'failure', contextSnapshot: {}, durationMs: 100 },
        { branchId: 'b', status: 'success', contextSnapshot: {}, durationMs: 200 },
        { branchId: 'c', status: 'partial_success', contextSnapshot: {}, durationMs: 150 }
      ],
      joinPolicy: 'wait_all'
    });

    const outcome = await handler.execute({
      node: makeFanInNode(),
      run_id: 'test',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test',
      context: { 'parallel.results': results }
    });

    expect(outcome.status).toBe('success');
    expect(outcome.context_updates!['parallel.fan_in.best_id']).toBe('b');
    expect(outcome.context_updates!['parallel.fan_in.best_outcome']).toBe('success');
  });

  it('falls back to legacy parallel.results.* keys for checkpoint compatibility', async () => {
    const results = serializeParallelResults({
      branches: [
        { branchId: 'legacy_a', status: 'partial_success', contextSnapshot: {}, durationMs: 100 },
        { branchId: 'legacy_b', status: 'success', contextSnapshot: {}, durationMs: 200 }
      ],
      joinPolicy: 'wait_all'
    });

    const outcome = await handler.execute({
      node: makeFanInNode(),
      run_id: 'test',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test',
      context: { 'parallel.results.fan_out': results }
    });

    expect(outcome.status).toBe('success');
    expect(outcome.context_updates!['parallel.fan_in.best_id']).toBe('legacy_b');
  });

  it('tiebreaks by branch ID (lexical order)', async () => {
    const results = serializeParallelResults({
      branches: [
        { branchId: 'z_branch', status: 'success', contextSnapshot: {}, durationMs: 100 },
        { branchId: 'a_branch', status: 'success', contextSnapshot: {}, durationMs: 200 }
      ],
      joinPolicy: 'wait_all'
    });

    const outcome = await handler.execute({
      node: makeFanInNode(),
      run_id: 'test',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test',
      context: { 'parallel.results': results }
    });

    expect(outcome.status).toBe('success');
    expect(outcome.context_updates!['parallel.fan_in.best_id']).toBe('a_branch');
  });

  it('returns success even when all branches failed so downstream edges can decide routing', async () => {
    const results = serializeParallelResults({
      branches: [
        { branchId: 'a', status: 'failure', contextSnapshot: {}, durationMs: 100 },
        { branchId: 'b', status: 'failure', contextSnapshot: {}, durationMs: 200 }
      ],
      joinPolicy: 'wait_all'
    });

    const outcome = await handler.execute({
      node: makeFanInNode(),
      run_id: 'test',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test',
      context: { 'parallel.results': results }
    });

    expect(outcome.status).toBe('success');
    expect(outcome.context_updates!['parallel.fan_in.best_id']).toBe('a');
    expect(outcome.context_updates!['fan_in_selected_status']).toBe('failure');
  });

  it('returns failure when no parallel results in context', async () => {
    const outcome = await handler.execute({
      node: makeFanInNode(),
      run_id: 'test',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test',
      context: {}
    });

    expect(outcome.status).toBe('failure');
    expect(outcome.error_message).toContain('no parallel.results');
  });

  it('returns failure when results have zero branches', async () => {
    const results = serializeParallelResults({
      branches: [],
      joinPolicy: 'wait_all'
    });

    const outcome = await handler.execute({
      node: makeFanInNode(),
      run_id: 'test',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test',
      context: { 'parallel.results': results }
    });

    expect(outcome.status).toBe('failure');
    expect(outcome.error_message).toContain('no branches');
  });

  it('uses prompted LLM fan-in path and writes rationale artifacts', async () => {
    const providers = new Map();
    providers.set('simulation', new SimulationProvider());
    const handler = new FanInHandler(new UnifiedClient(providers));

    const results = serializeParallelResults({
      branches: [
        { branchId: 'branch_a', status: 'success', contextSnapshot: { 'plan.response': 'Plan A' }, durationMs: 120 },
        { branchId: 'branch_b', status: 'failure', contextSnapshot: { 'plan.response': 'Plan B' }, durationMs: 180 }
      ],
      joinPolicy: 'wait_all'
    });

    const runDir = await mkdtemp(path.join(os.tmpdir(), 'nectar-fan-in-'));
    try {
      const outcome = await handler.execute({
        node: makeFanInNode('Choose the strongest branch for production readiness.'),
        run_id: 'test',
        dot_file: '<test>',
        attempt: 1,
        run_dir: runDir,
        context: { 'parallel.results': results }
      });

      expect(outcome.status).toBe('success');
      expect(outcome.context_updates?.['parallel.fan_in.best_id']).toBe('branch_a');
      expect(outcome.context_updates?.['parallel.fan_in.rationale']).toBeDefined();
      expect(outcome.context_updates?.['fan_in_selected_branch']).toBe('branch_a');
      expect(outcome.context_updates?.['fan_in_selected_status']).toBe('success');

      const requestArtifact = await readFile(path.join(runDir, 'fan_in', 'fan-in-evaluation.request.json'), 'utf8');
      const responseArtifact = await readFile(path.join(runDir, 'fan_in', 'fan-in-evaluation.response.json'), 'utf8');
      expect(requestArtifact).toContain('production readiness');
      expect(responseArtifact).toContain('selected_branch_id');
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('prompted path returns success when the selected branch failed', async () => {
    const providers = new Map();
    providers.set('simulation', new SimulationProvider());
    const handler = new FanInHandler(new UnifiedClient(providers));

    const results = serializeParallelResults({
      branches: [
        { branchId: 'branch_a', status: 'failure', contextSnapshot: { 'plan.response': 'Plan A' }, durationMs: 120 },
        { branchId: 'branch_b', status: 'success', contextSnapshot: { 'plan.response': 'Plan B' }, durationMs: 180 }
      ],
      joinPolicy: 'wait_all'
    });

    const runDir = await mkdtemp(path.join(os.tmpdir(), 'nectar-fan-in-failed-selection-'));
    try {
      const outcome = await handler.execute({
        node: makeFanInNode('Pick one branch.'),
        run_id: 'test',
        dot_file: '<test>',
        attempt: 1,
        run_dir: runDir,
        context: { 'parallel.results': results }
      });

      expect(outcome.status).toBe('success');
      expect(outcome.context_updates?.['parallel.fan_in.best_id']).toBe('branch_a');
      expect(outcome.context_updates?.['fan_in_selected_status']).toBe('failure');
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
