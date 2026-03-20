import { describe, expect, it } from 'vitest';
import { FanInHandler } from '../../src/handlers/fan-in.js';
import { serializeParallelResults } from '../../src/engine/parallel-results.js';
import { GardenNode } from '../../src/garden/types.js';

function makeFanInNode(): GardenNode {
  return {
    id: 'fan_in',
    kind: 'parallel.fan_in',
    shape: 'tripleoctagon',
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
      context: { 'parallel.results.fan_out': results }
    });

    expect(outcome.status).toBe('success');
    expect(outcome.context_updates!['parallel.fan_in.best_id']).toBe('b');
    expect(outcome.context_updates!['parallel.fan_in.best_outcome']).toBe('success');
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
      context: { 'parallel.results.fan_out': results }
    });

    expect(outcome.status).toBe('success');
    expect(outcome.context_updates!['parallel.fan_in.best_id']).toBe('a_branch');
  });

  it('returns failure when all branches failed', async () => {
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
      context: { 'parallel.results.fan_out': results }
    });

    expect(outcome.status).toBe('failure');
    expect(outcome.context_updates!['parallel.fan_in.best_id']).toBe('a');
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
      context: { 'parallel.results.fan_out': results }
    });

    expect(outcome.status).toBe('failure');
    expect(outcome.error_message).toContain('no branches');
  });
});
