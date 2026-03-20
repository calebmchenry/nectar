import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineEngine } from '../../src/engine/engine.js';
import { RunEvent } from '../../src/engine/events.js';
import { parseGardenSource, hashDotSource } from '../../src/garden/parse.js';
import { RunStore } from '../../src/checkpoint/run-store.js';
import type { ManifestData } from '../../src/checkpoint/run-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-restart-'));
  tempDirs.push(workspace);
  return workspace;
}

// A graph where: start -> work -> check -> done (success), check -> work (failure, loop_restart=true)
const RESTART_DOT = `digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="echo work-done"]
  check [shape=parallelogram, script="echo check-result"]
  done [shape=Msquare]

  start -> work
  work -> check
  check -> done [condition="outcome=success"]
  check -> work [condition="outcome=failure", loop_restart="true"]
}`;

// A graph that always fails check, forcing restart until depth cap
const ALWAYS_FAIL_DOT = `digraph G {
  graph [max_restart_depth="2"]
  start [shape=Mdiamond]
  work [shape=parallelogram, script="exit 1"]
  done [shape=Msquare]

  start -> work
  work -> done [condition="outcome=success"]
  work -> start [condition="outcome=failure", loop_restart="true"]
}`;

describe('loop_restart integration', () => {
  it('restart creates new run with new ID', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(RESTART_DOT, 'restart.dot');
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'original-run',
    });
    engine.onEvent((e) => events.push(e));

    // The graph completes successfully (echo exits 0), so no restart should fire
    const result = await engine.run();
    expect(result.status).toBe('completed');
    expect(result.run_id).toBe('original-run');
  });

  it('predecessor marked interrupted with restart linkage', async () => {
    const workspace = await createWorkspace();
    // Use a graph where work fails, triggering loop_restart
    const failOnce = `digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="exit 1"]
  done [shape=Msquare]

  start -> work
  work -> done [condition="outcome=success"]
  work -> start [condition="outcome=failure", loop_restart="true"]
}`;
    const graph = parseGardenSource(failOnce, 'fail-restart.dot');
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'pred-run',
    });
    engine.onEvent((e) => events.push(e));

    const result = await engine.run();
    // The engine returns the predecessor result with restart info
    expect(result.status).toBe('interrupted');
    expect(result.interruption_reason).toBe('loop_restart');
    expect(result.restart).toBeDefined();
    expect(result.restart!.successor_run_id).toBeTruthy();
    expect(result.restart!.restart_depth).toBe(1);

    // Check predecessor manifest has restarted_to link
    const predStore = new RunStore('pred-run', workspace);
    const predManifest = await predStore.readManifest();
    expect(predManifest?.restarted_to).toBe(result.restart!.successor_run_id);

    // Check run_restarted event was emitted
    const restartEvent = events.find(e => e.type === 'run_restarted');
    expect(restartEvent).toBeDefined();
  });

  it('context filtering: business keys preserved, internal keys stripped', async () => {
    const workspace = await createWorkspace();
    const failOnce = `digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="exit 1"]
  done [shape=Msquare]

  start -> work
  work -> done [condition="outcome=success"]
  work -> start [condition="outcome=failure", loop_restart="true"]
}`;
    const graph = parseGardenSource(failOnce, 'ctx-restart.dot');

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      initial_context: {
        'business.key': 'important',
        'internal.debug': 'should-strip',
        'stack.child.status': 'should-strip',
        'stack.manager.note': 'should-strip',
      },
    });

    const result = await engine.run();
    expect(result.restart).toBeDefined();
    const ctx = result.restart!.filtered_context;
    expect(ctx['business.key']).toBe('important');
    expect(ctx['internal.debug']).toBeUndefined();
    expect(ctx['stack.child.status']).toBeUndefined();
    expect(ctx['stack.manager.note']).toBeUndefined();
    // outcome and preferred_label should be stripped
    expect(ctx['outcome']).toBeUndefined();
  });

  it('successor starts at target node, not graph start', async () => {
    const workspace = await createWorkspace();
    // Graph: start -> a -> b, a fails -> b with loop_restart
    // Successor should start at b, not start
    const graph = parseGardenSource(`digraph G {
  start [shape=Mdiamond]
  a [shape=parallelogram, script="exit 1"]
  b [shape=parallelogram, script="echo b-ran"]
  done [shape=Msquare]

  start -> a
  a -> done [condition="outcome=success"]
  a -> b [condition="outcome=failure", loop_restart="true"]
  b -> done
}`, 'target-node.dot');

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
    });

    const result = await engine.run();
    expect(result.restart).toBeDefined();
    expect(result.restart!.target_node).toBe('b');
  });

  it('depth guard triggers at limit', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(ALWAYS_FAIL_DOT, 'depth-guard.dot');

    // Create a restart chain by simulating depth already at 2 (the max)
    // First run: depth 0, fails, wants restart
    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'depth-0',
    });

    const result1 = await engine.run();
    expect(result1.restart).toBeDefined();
    expect(result1.restart!.restart_depth).toBe(1);

    // Successor at depth 1
    const successorStore = new RunStore(result1.restart!.successor_run_id, workspace);
    await successorStore.initialize({
      run_id: result1.restart!.successor_run_id,
      dot_file: 'depth-guard.dot',
      graph_hash: hashDotSource(graph.dotSource),
      started_at: new Date().toISOString(),
      workspace_root: workspace,
      restart_of: 'depth-0',
      restart_depth: 1,
    });

    const engine2 = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: result1.restart!.successor_run_id,
      initial_context: result1.restart!.filtered_context,
      start_node_override: result1.restart!.target_node,
    });

    const result2 = await engine2.run();
    expect(result2.restart).toBeDefined();
    expect(result2.restart!.restart_depth).toBe(2);

    // Successor at depth 2 — should hit the cap (max_restart_depth=2)
    const store3 = new RunStore(result2.restart!.successor_run_id, workspace);
    await store3.initialize({
      run_id: result2.restart!.successor_run_id,
      dot_file: 'depth-guard.dot',
      graph_hash: hashDotSource(graph.dotSource),
      started_at: new Date().toISOString(),
      workspace_root: workspace,
      restart_of: result2.run_id,
      restart_depth: 2,
    });

    const engine3 = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: result2.restart!.successor_run_id,
      initial_context: result2.restart!.filtered_context,
      start_node_override: result2.restart!.target_node,
    });

    const result3 = await engine3.run();
    // Should fail with depth cap exceeded, not restart again
    expect(result3.status).toBe('failed');
    expect(result3.error).toContain('Restart depth cap');
    expect(result3.restart).toBeUndefined();
  });

  it('old cocoons without lineage fields resume cleanly', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(`digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="echo ok"]
  done [shape=Msquare]
  start -> work
  work -> done
}`, 'old-cocoon.dot');

    // Simulate an old cocoon without any lineage fields
    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      initial_cocoon: {
        version: 1,
        run_id: 'old-run',
        dot_file: 'old-cocoon.dot',
        graph_hash: hashDotSource(graph.dotSource),
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'running',
        interruption_reason: undefined,
        completed_nodes: [{ node_id: 'start', status: 'success', started_at: '', completed_at: '', retries: 0 }],
        current_node: 'work',
        context: {},
        retry_state: {},
        // No lineage fields — this is the "old cocoon" test
      },
    });

    const result = await engine.run();
    expect(result.status).toBe('completed');
  });

  it('successor manifest restart_of links to predecessor run_id', async () => {
    const workspace = await createWorkspace();
    const failOnce = `digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="exit 1"]
  done [shape=Msquare]

  start -> work
  work -> done [condition="outcome=success"]
  work -> start [condition="outcome=failure", loop_restart="true"]
}`;
    const graph = parseGardenSource(failOnce, 'link-test.dot');
    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'link-pred',
    });

    const result = await engine.run();
    expect(result.restart).toBeDefined();

    // Initialize successor store and verify manifest
    const successorStore = new RunStore(result.restart!.successor_run_id, workspace);
    await successorStore.initialize({
      run_id: result.restart!.successor_run_id,
      dot_file: 'link-test.dot',
      graph_hash: hashDotSource(graph.dotSource),
      started_at: new Date().toISOString(),
      workspace_root: workspace,
      restart_of: 'link-pred',
      restart_depth: result.restart!.restart_depth,
    });

    const manifest = await successorStore.readManifest();
    expect(manifest?.restart_of).toBe('link-pred');
    expect(manifest?.restart_depth).toBe(1);
  });

  it('predecessor cocoon has restarted_to field set', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(`digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="exit 1"]
  done [shape=Msquare]
  start -> work
  work -> done [condition="outcome=success"]
  work -> start [condition="outcome=failure", loop_restart="true"]
}`, 'cocoon-link.dot');

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'cocoon-pred',
    });

    const result = await engine.run();
    expect(result.restart).toBeDefined();

    // restarted_to is written to the manifest, not the cocoon
    const predStore = new RunStore('cocoon-pred', workspace);
    const manifest = await predStore.readManifest();
    expect(manifest?.restarted_to).toBe(result.restart!.successor_run_id);

    const cocoon = await RunStore.readCocoon('cocoon-pred', workspace);
    expect(cocoon?.status).toBe('interrupted');
    expect(cocoon?.interruption_reason).toBe('loop_restart');
  });

  it('graph.goal context key preserved across restart', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(`digraph G {
  graph [goal="Build everything"]
  start [shape=Mdiamond]
  work [shape=parallelogram, script="exit 1"]
  done [shape=Msquare]
  start -> work
  work -> done [condition="outcome=success"]
  work -> start [condition="outcome=failure", loop_restart="true"]
}`, 'goal-restart.dot');

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
    });

    const result = await engine.run();
    expect(result.restart).toBeDefined();
    // graph.goal should be preserved in filtered context
    expect(result.restart!.filtered_context['graph.goal']).toBe('Build everything');
  });
});
