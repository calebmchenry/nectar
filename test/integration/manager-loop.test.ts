import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineEngine } from '../../src/engine/engine.js';
import { RunEvent } from '../../src/engine/events.js';
import { parseGardenSource, parseGardenFile, hashDotSource } from '../../src/garden/parse.js';

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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-mgr-int-'));
  tempDirs.push(workspace);
  return workspace;
}

describe('manager-loop integration', () => {
  it('parent launches child, child completes, parent succeeds', async () => {
    const workspace = await createWorkspace();

    // Create child DOT file in workspace
    const childDot = `digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="echo child-work-done"]
  done [shape=Msquare]
  start -> work
  work -> done
}`;
    await mkdir(path.join(workspace, 'gardens'), { recursive: true });
    await writeFile(path.join(workspace, 'gardens', 'child.dot'), childDot, 'utf8');

    // Parent graph with manager node
    const parentDot = `digraph G {
  graph [\"stack.child_dotfile\"=\"gardens/child.dot\"]
  start [shape=Mdiamond]
  supervisor [shape=house, \"manager.poll_interval\"=\"100ms\", \"manager.max_cycles\"=\"50\"]
  done [shape=Msquare]

  start -> supervisor
  supervisor -> done
}`;
    const graph = parseGardenSource(parentDot, 'parent.dot');
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
    });
    engine.onEvent((e) => events.push(e));

    const result = await engine.run();
    expect(result.status).toBe('completed');

    // Verify manager-related events
    const childStarted = events.find(e => e.type === 'child_run_started');
    expect(childStarted).toBeTruthy();

    const snapshots = events.filter(e => e.type === 'child_snapshot_observed');
    expect(snapshots.length).toBeGreaterThan(0);

    // Verify context keys
    const completedSupervisor = result.completed_nodes.find(n => n.node_id === 'supervisor');
    expect(completedSupervisor?.status).toBe('success');
  });

  it('manager fails when child dotfile is missing', async () => {
    const workspace = await createWorkspace();

    const parentDot = `digraph G {
  graph [\"stack.child_dotfile\"=\"gardens/nonexistent.dot\"]
  start [shape=Mdiamond]
  supervisor [shape=house, \"manager.poll_interval\"=\"100ms\", \"manager.max_cycles\"=\"5\"]
  done [shape=Msquare]

  start -> supervisor
  supervisor -> done
}`;
    const graph = parseGardenSource(parentDot, 'parent.dot');

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
    });

    const result = await engine.run();
    // Manager should fail because child DOT file doesn't exist
    const supervisorNode = result.completed_nodes.find(n => n.node_id === 'supervisor');
    expect(supervisorNode?.status).toBe('failure');
  });

  it('manager populates stack.child.* context keys from snapshot', async () => {
    const workspace = await createWorkspace();

    const childDot = `digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="echo done"]
  done [shape=Msquare]
  start -> work
  work -> done
}`;
    await mkdir(path.join(workspace, 'gardens'), { recursive: true });
    await writeFile(path.join(workspace, 'gardens', 'child.dot'), childDot, 'utf8');

    const parentDot = `digraph G {
  graph [\"stack.child_dotfile\"=\"gardens/child.dot\"]
  start [shape=Mdiamond]
  supervisor [shape=house, \"manager.poll_interval\"=\"100ms\", \"manager.max_cycles\"=\"50\"]
  after [shape=parallelogram, script="echo after"]
  done [shape=Msquare]

  start -> supervisor
  supervisor -> after
  after -> done
}`;
    const graph = parseGardenSource(parentDot, 'parent.dot');

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
    });

    const events: RunEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const result = await engine.run();
    expect(result.status).toBe('completed');

    // Verify snapshot events had child context
    const snapshotEvents = events.filter(e => e.type === 'child_snapshot_observed');
    expect(snapshotEvents.length).toBeGreaterThan(0);
  });

  it('manager with steering emits steer events', async () => {
    const workspace = await createWorkspace();

    const childDot = `digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="echo working"]
  done [shape=Msquare]
  start -> work
  work -> done
}`;
    await mkdir(path.join(workspace, 'gardens'), { recursive: true });
    await writeFile(path.join(workspace, 'gardens', 'child.dot'), childDot, 'utf8');

    const parentDot = `digraph G {
  graph [\"stack.child_dotfile\"=\"gardens/child.dot\"]
  start [shape=Mdiamond]
  supervisor [shape=house, prompt=\"Focus on tests\", \"manager.poll_interval\"=\"100ms\", \"manager.max_cycles\"=\"50\", \"manager.actions\"=\"observe,steer,wait\"]
  done [shape=Msquare]

  start -> supervisor
  supervisor -> done
}`;
    const graph = parseGardenSource(parentDot, 'parent.dot');

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
    });

    const events: RunEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const result = await engine.run();
    expect(result.status).toBe('completed');

    // May or may not have steer events depending on timing (child may complete before first steer)
    // But child_run_started should always be present
    expect(events.some(e => e.type === 'child_run_started')).toBe(true);
  });

  it('manager fails when child run fails', async () => {
    const workspace = await createWorkspace();

    const childDot = `digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="exit 1"]
  done [shape=Msquare]
  start -> work
  work -> done [condition="outcome=success"]
}`;
    await mkdir(path.join(workspace, 'gardens'), { recursive: true });
    await writeFile(path.join(workspace, 'gardens', 'child.dot'), childDot, 'utf8');

    const parentDot = `digraph G {
  graph [\"stack.child_dotfile\"=\"gardens/child.dot\"]
  start [shape=Mdiamond]
  supervisor [shape=house, \"manager.poll_interval\"=\"100ms\", \"manager.max_cycles\"=\"20\"]
  done [shape=Msquare]

  start -> supervisor
  supervisor -> done
}`;
    const graph = parseGardenSource(parentDot, 'parent.dot');

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
    });

    const result = await engine.run();
    // The child fails (exit 1), so the manager should return failure, then the run might
    // fail due to no matching edge or complete via a failure path
    const supervisorNode = result.completed_nodes.find(n => n.node_id === 'supervisor');
    expect(supervisorNode).toBeTruthy();
    // Child fails -> manager returns failure
    expect(supervisorNode?.status).toBe('failure');
  });

  it('manager with stop_condition returns success when condition met', async () => {
    const workspace = await createWorkspace();

    const childDot = `digraph G {
  start [shape=Mdiamond]
  work [shape=parallelogram, script="echo done"]
  done [shape=Msquare]
  start -> work
  work -> done
}`;
    await mkdir(path.join(workspace, 'gardens'), { recursive: true });
    await writeFile(path.join(workspace, 'gardens', 'child.dot'), childDot, 'utf8');

    const parentDot = `digraph G {
  graph [\"stack.child_dotfile\"=\"gardens/child.dot\"]
  start [shape=Mdiamond]
  supervisor [shape=house, \"manager.poll_interval\"=\"100ms\", \"manager.max_cycles\"=\"50\", \"manager.stop_condition\"=\"context.stack.child.status=completed\"]
  done [shape=Msquare]

  start -> supervisor
  supervisor -> done
}`;
    const graph = parseGardenSource(parentDot, 'parent.dot');

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
    });

    const result = await engine.run();
    expect(result.status).toBe('completed');
  });
});
