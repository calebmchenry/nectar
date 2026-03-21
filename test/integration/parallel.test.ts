import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineEngine } from '../../src/engine/engine.js';
import { RunEvent } from '../../src/engine/events.js';
import { parseGardenFile, hashDotSource } from '../../src/garden/parse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-parallel-test-'));
  tempDirs.push(workspace);
  await mkdir(path.join(workspace, 'gardens'), { recursive: true });
  return workspace;
}

describe('parallel integration', () => {
  it('runs parallel-basic.dot end-to-end', { timeout: 30_000 }, async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'parallel-basic.dot');
    const gardenPath = path.join(workspace, 'gardens', 'parallel-basic.dot');
    await copyFile(fixturePath, gardenPath);

    const graph = await parseGardenFile(gardenPath);
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'parallel-basic-run'
    });

    engine.onEvent((e) => events.push(e));
    const result = await engine.run();

    expect(result.status).toBe('completed');

    // Verify parallel events were emitted
    const parallelStarted = events.filter((e) => e.type === 'parallel_started');
    expect(parallelStarted.length).toBe(1);

    const branchStarted = events.filter((e) => e.type === 'parallel_branch_started');
    expect(branchStarted.length).toBe(3);

    const branchCompleted = events.filter((e) => e.type === 'parallel_branch_completed');
    expect(branchCompleted.length).toBe(3);

    const parallelCompleted = events.filter((e) => e.type === 'parallel_completed');
    expect(parallelCompleted.length).toBe(1);

    // Verify parallel.results populated
    const nodeCompleted = events.filter((e) => e.type === 'node_completed');
    const fanOutCompleted = nodeCompleted.find(
      (e) => e.type === 'node_completed' && e.node_id === 'fan_out'
    );
    expect(fanOutCompleted).toBeDefined();
    if (fanOutCompleted && fanOutCompleted.type === 'node_completed') {
      expect(fanOutCompleted.outcome.context_updates?.['parallel.results']).toBeDefined();
    }

    // Verify fan-in selects best
    const fanInCompleted = nodeCompleted.find(
      (e) => e.type === 'node_completed' && e.node_id === 'fan_in'
    );
    expect(fanInCompleted).toBeDefined();
    if (fanInCompleted && fanInCompleted.type === 'node_completed') {
      expect(fanInCompleted.outcome.context_updates?.['parallel.fan_in.best_id']).toBeDefined();
      expect(fanInCompleted.outcome.context_updates?.['parallel.fan_in.best_outcome']).toBe('success');
    }
  });

  it('runs parallel-failure.dot with partial_success', { timeout: 30_000 }, async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'parallel-failure.dot');
    const gardenPath = path.join(workspace, 'gardens', 'parallel-failure.dot');
    await copyFile(fixturePath, gardenPath);

    const graph = await parseGardenFile(gardenPath);
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'parallel-failure-run'
    });

    engine.onEvent((e) => events.push(e));
    const result = await engine.run();

    expect(result.status).toBe('completed');

    // The parallel node should report partial_success
    const parallelCompleted = events.find(
      (e) => e.type === 'parallel_completed'
    );
    expect(parallelCompleted).toBeDefined();
    if (parallelCompleted && parallelCompleted.type === 'parallel_completed') {
      expect(parallelCompleted.status).toBe('partial_success');
      expect(parallelCompleted.succeeded).toBe(1);
      expect(parallelCompleted.failed).toBe(1);
    }
  });

  it('runs double fan-out/fan-in without duplicate node executions', { timeout: 30_000 }, async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'parallel-double-fanout.dot');
    const gardenPath = path.join(workspace, 'gardens', 'parallel-double-fanout.dot');
    await copyFile(fixturePath, gardenPath);

    const graph = await parseGardenFile(gardenPath);
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'parallel-double-fanout-run'
    });

    engine.onEvent((e) => events.push(e));
    const result = await engine.run();

    expect(result.status).toBe('completed');

    // Two parallel fan-outs should have been started
    const parallelStarted = events.filter((e) => e.type === 'parallel_started');
    expect(parallelStarted.length).toBe(2);

    // Each branch node should only be executed ONCE (inside the parallel handler)
    // The main engine should NOT re-execute branch nodes after the parallel completes.
    const nodeStarted = events.filter((e) => e.type === 'node_started');
    for (const branchId of ['branch_a', 'branch_b', 'branch_c', 'branch_d', 'branch_e', 'branch_f']) {
      const starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === branchId);
      expect(starts.length, `${branchId} should execute exactly once`).toBe(1);
    }

    // fan_in nodes should each execute exactly once
    for (const fanInId of ['fan_in_1', 'fan_in_2']) {
      const starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === fanInId);
      expect(starts.length, `${fanInId} should execute exactly once`).toBe(1);
    }
  });

  it('double fan-out with failing branch does not duplicate executions', { timeout: 30_000 }, async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'parallel-double-fanout-fail.dot');
    const gardenPath = path.join(workspace, 'gardens', 'parallel-double-fanout-fail.dot');
    await copyFile(fixturePath, gardenPath);

    const graph = await parseGardenFile(gardenPath);
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'parallel-double-fanout-fail-run'
    });

    engine.onEvent((e) => events.push(e));
    const result = await engine.run();

    // Pipeline should complete (partial_success from fan_out_2 is not fatal)
    expect(result.status).toBe('completed');

    const nodeStarted = events.filter((e) => e.type === 'node_started');

    // Each branch node should execute exactly once
    for (const branchId of ['branch_a', 'branch_b', 'branch_c', 'branch_d', 'branch_e', 'branch_f']) {
      const starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === branchId);
      expect(starts.length, `${branchId} should execute exactly once`).toBe(1);
    }

    // fan_in nodes should each execute exactly once
    for (const fanInId of ['fan_in_1', 'fan_in_2']) {
      const starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === fanInId);
      expect(starts.length, `${fanInId} should execute exactly once`).toBe(1);
    }

    // middle and final should each execute exactly once
    for (const nodeId of ['middle', 'final']) {
      const starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === nodeId);
      expect(starts.length, `${nodeId} should execute exactly once`).toBe(1);
    }
  });

  it('chained fan-out/fan-in (no middle node) does not duplicate executions', { timeout: 30_000 }, async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'parallel-chained-fanout.dot');
    const gardenPath = path.join(workspace, 'gardens', 'parallel-chained-fanout.dot');
    await copyFile(fixturePath, gardenPath);

    const graph = await parseGardenFile(gardenPath);
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'parallel-chained-fanout-run'
    });

    engine.onEvent((e) => events.push(e));
    const result = await engine.run();

    expect(result.status).toBe('completed');

    const nodeStarted = events.filter((e) => e.type === 'node_started');

    // Each branch should execute exactly once
    for (const branchId of ['branch_a', 'branch_b', 'branch_c', 'branch_d', 'branch_e', 'branch_f']) {
      const starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === branchId);
      expect(starts.length, `${branchId} should execute exactly once`).toBe(1);
    }

    // fan_in nodes should each execute exactly once
    for (const fanInId of ['fan_in_1', 'fan_in_2']) {
      const starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === fanInId);
      expect(starts.length, `${fanInId} should execute exactly once`).toBe(1);
    }

    // fan_out nodes should each execute exactly once
    for (const fanOutId of ['fan_out_1', 'fan_out_2']) {
      const starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === fanOutId);
      expect(starts.length, `${fanOutId} should execute exactly once`).toBe(1);
    }
  });

  it('cyclic graph does not select wrong convergence node through loop-back edges', { timeout: 30_000 }, async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'parallel-cyclic-fanout.dot');
    const gardenPath = path.join(workspace, 'gardens', 'parallel-cyclic-fanout.dot');
    await copyFile(fixturePath, gardenPath);

    const graph = await parseGardenFile(gardenPath);
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'parallel-cyclic-fanout-run'
    });

    engine.onEvent((e) => events.push(e));
    const result = await engine.run();

    expect(result.status).toBe('completed');

    const nodeStarted = events.filter((e) => e.type === 'node_started');

    // Critical: fan_in_1 should execute exactly once (not once per fan_out_2 branch)
    const fanIn1Starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === 'fan_in_1');
    expect(fanIn1Starts.length, 'fan_in_1 should execute exactly once').toBe(1);

    // fan_in_2 should execute exactly once
    const fanIn2Starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === 'fan_in_2');
    expect(fanIn2Starts.length, 'fan_in_2 should execute exactly once').toBe(1);

    // Each branch should execute exactly once
    for (const branchId of ['branch_a', 'branch_b', 'branch_c', 'branch_d']) {
      const starts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === branchId);
      expect(starts.length, `${branchId} should execute exactly once`).toBe(1);
    }

    // post should execute exactly once
    const postStarts = nodeStarted.filter((e) => e.type === 'node_started' && e.node_id === 'post');
    expect(postStarts.length, 'post should execute exactly once').toBe(1);
  });

  it('runs parallel-first-success.dot with early completion', { timeout: 30_000 }, async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'parallel-first-success.dot');
    const gardenPath = path.join(workspace, 'gardens', 'parallel-first-success.dot');
    await copyFile(fixturePath, gardenPath);

    const graph = await parseGardenFile(gardenPath);
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'parallel-first-success-run'
    });

    engine.onEvent((e) => events.push(e));
    const result = await engine.run();

    expect(result.status).toBe('completed');

    const parallelCompleted = events.find((e) => e.type === 'parallel_completed');
    expect(parallelCompleted).toBeDefined();
    if (parallelCompleted && parallelCompleted.type === 'parallel_completed') {
      expect(parallelCompleted.status).toBe('success');
    }
  });
});
