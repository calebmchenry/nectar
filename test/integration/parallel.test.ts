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

    // Verify parallel.results.* populated
    const nodeCompleted = events.filter((e) => e.type === 'node_completed');
    const fanOutCompleted = nodeCompleted.find(
      (e) => e.type === 'node_completed' && e.node_id === 'fan_out'
    );
    expect(fanOutCompleted).toBeDefined();
    if (fanOutCompleted && fanOutCompleted.type === 'node_completed') {
      expect(fanOutCompleted.outcome.context_updates?.['parallel.results.fan_out']).toBeDefined();
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
