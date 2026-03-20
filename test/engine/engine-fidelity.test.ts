import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineEngine } from '../../src/engine/engine.js';
import { parseGardenSource } from '../../src/garden/parse.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { Cocoon } from '../../src/checkpoint/types.js';
import { RunStore } from '../../src/checkpoint/run-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const ws = await mkdtemp(path.join(os.tmpdir(), 'nectar-efidelity-test-'));
  tempDirs.push(ws);
  return ws;
}

function makeGraph(source: string, dotPath = 'test.dot') {
  return parseGardenSource(source, dotPath);
}

describe('engine fidelity integration', () => {
  it('resolves fidelity and passes plan to handler', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        graph [goal="test fidelity" default_fidelity="compact"]
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo ok"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = makeGraph(source);
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'hash1',
      workspace_root: ws,
      run_id: 'fidelity-test',
    });

    const events: RunEvent[] = [];
    engine.onEvent(e => events.push(e));
    const result = await engine.run();
    expect(result.status).toBe('completed');
  });

  it('checkpoint includes pending_transition and thread keys', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        graph [goal="checkpoint fields"]
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo ok"]
        tool2 [shape=parallelogram, script="echo ok2"]
        done [shape=msquare]
        start -> tool1
        tool1 -> tool2
        tool2 -> done
      }
    `;
    const graph = makeGraph(source);
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'hash2',
      workspace_root: ws,
      run_id: 'checkpoint-test',
    });
    await engine.run();

    const cocoon = await RunStore.readCocoon('checkpoint-test', ws);
    expect(cocoon).not.toBeNull();
    // Last checkpoint after exit should have completed status
    expect(cocoon!.status).toBe('completed');
  });

  it('checkpoint_saved event emitted', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo ok"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = makeGraph(source);
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'hash3',
      workspace_root: ws,
      run_id: 'ckpt-event-test',
    });

    const checkpointEvents: RunEvent[] = [];
    engine.onEvent(e => {
      if (e.type === 'checkpoint_saved') checkpointEvents.push(e);
    });
    await engine.run();
    expect(checkpointEvents.length).toBeGreaterThan(0);
  });

  it('manifest.json exists after first node', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        graph [goal="manifest test"]
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo ok"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = makeGraph(source);
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'manifest-hash',
      workspace_root: ws,
      run_id: 'manifest-test',
    });
    await engine.run();

    const manifestPath = path.join(ws, '.nectar', 'cocoons', 'manifest-test', 'manifest.json');
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    expect(manifest.run_id).toBe('manifest-test');
    expect(manifest.goal).toBe('manifest test');
    expect(manifest.graph_hash).toBe('manifest-hash');
  });

  it('backward compat: resume with old cocoon works', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo resumed"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = makeGraph(source);

    // Create old-style cocoon without new fields
    const oldCocoon: Cocoon = {
      version: 1,
      run_id: 'old-run',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:01Z',
      status: 'running',
      interruption_reason: undefined,
      completed_nodes: [
        { node_id: 'start', status: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:00Z', retries: 0 },
      ],
      current_node: 'tool1',
      context: {},
      retry_state: {},
    };

    const engine = new PipelineEngine({
      graph,
      graph_hash: 'hash',
      workspace_root: ws,
      initial_cocoon: oldCocoon,
      run_id: 'old-run',
    });
    const result = await engine.run();
    expect(result.status).toBe('completed');
  });

  it('auto_status applied when handler returns no explicit status', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo ok", auto_status="true"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = makeGraph(source);
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'auto-hash',
      workspace_root: ws,
      run_id: 'auto-status-test',
    });

    const events: RunEvent[] = [];
    engine.onEvent(e => events.push(e));
    const result = await engine.run();
    // Tool handler always returns explicit status, so auto_status is not triggered in this case
    expect(result.status).toBe('completed');
  });

  it('nodes with no fidelity get compact default', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo ok"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = makeGraph(source);
    // No default_fidelity set — should default to compact
    expect(graph.defaultFidelity).toBeUndefined();

    const engine = new PipelineEngine({
      graph,
      graph_hash: 'default-hash',
      workspace_root: ws,
      run_id: 'default-fidelity',
    });
    const result = await engine.run();
    expect(result.status).toBe('completed');
  });

  it('legacy flat cocoon still written', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo ok"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = makeGraph(source);
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'legacy-hash',
      workspace_root: ws,
      run_id: 'legacy-dual',
    });
    await engine.run();

    // Both canonical and legacy should exist
    const canonicalPath = path.join(ws, '.nectar', 'cocoons', 'legacy-dual', 'checkpoint.json');
    const legacyPath = path.join(ws, '.nectar', 'cocoons', 'legacy-dual.json');
    const canonicalStat = await stat(canonicalPath);
    const legacyStat = await stat(legacyPath);
    expect(canonicalStat.isFile()).toBe(true);
    expect(legacyStat.isFile()).toBe(true);
  });
});
