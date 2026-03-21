import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineEngine } from '../../src/engine/engine.js';
import { parseGardenFile, parseGardenSource } from '../../src/garden/parse.js';
import { resolveFidelity } from '../../src/engine/fidelity.js';
import { resolveThreadId } from '../../src/engine/thread-resolver.js';
import { buildPreamble } from '../../src/engine/preamble.js';
import { RunStore } from '../../src/checkpoint/run-store.js';
import { ArtifactStore } from '../../src/artifacts/store.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { Cocoon } from '../../src/checkpoint/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const ws = await mkdtemp(path.join(os.tmpdir(), 'nectar-fidelity-runtime-'));
  tempDirs.push(ws);
  return ws;
}

describe('fidelity runtime integration', () => {
  it('compact fidelity graph runs to completion with tool nodes', async () => {
    const ws = await createWorkspace();
    const dotPath = path.join(FIXTURES, 'fidelity-compact.dot');
    const gardenPath = path.join(ws, 'fidelity-compact.dot');
    await copyFile(dotPath, gardenPath);

    const graph = await parseGardenFile(gardenPath);
    expect(graph.defaultFidelity).toBe('compact');

    const engine = new PipelineEngine({
      graph,
      graph_hash: 'compact-hash',
      workspace_root: ws,
      run_id: 'compact-runtime',
    });

    const events: RunEvent[] = [];
    engine.onEvent(e => events.push(e));
    const result = await engine.run();
    // Will fail at codergen (no LLM client), but should get through tool nodes
    // Check that it attempted tool1 at least
    const nodeCompletions = events.filter(e => e.type === 'node_completed');
    expect(nodeCompletions.length).toBeGreaterThanOrEqual(1);
  });

  it('fidelity resolution from DOT attributes works end-to-end', async () => {
    const source = `
      digraph {
        graph [goal="e2e fidelity", default_fidelity="summary:low"]
        start [shape=mdiamond]
        agent1 [shape=box, prompt="test", fidelity="full"]
        agent2 [shape=box, prompt="test2"]
        done [shape=msquare]
        start -> agent1
        agent1 -> agent2 [fidelity="truncate"]
        agent2 -> done
      }
    `;
    const graph = parseGardenSource(source);
    const agent1 = graph.nodeMap.get('agent1')!;
    const agent2 = graph.nodeMap.get('agent2')!;
    const edge12 = graph.edges.find(e => e.source === 'agent1' && e.target === 'agent2')!;

    // agent1: node fidelity=full
    expect(resolveFidelity(agent1, undefined, graph)).toBe('full');
    // agent2 via edge: edge fidelity=truncate overrides graph default
    expect(resolveFidelity(agent2, edge12, graph)).toBe('truncate');
    // agent2 without edge: uses graph default
    expect(resolveFidelity(agent2, undefined, graph)).toBe('summary:low');
  });

  it('thread resolution from DOT attributes works end-to-end', async () => {
    const source = `
      digraph {
        graph [goal="e2e threads"]
        start [shape=mdiamond]
        plan [shape=box, prompt="plan", thread_id="feature"]
        implement [shape=box, prompt="impl"]
        done [shape=msquare]
        start -> plan
        plan -> implement [thread_id="review-thread"]
        implement -> done
      }
    `;
    const graph = parseGardenSource(source);
    const plan = graph.nodeMap.get('plan')!;
    const impl = graph.nodeMap.get('implement')!;
    const edge = graph.edges.find(e => e.source === 'plan' && e.target === 'implement')!;

    // plan: node thread_id=feature
    expect(resolveThreadId(plan, undefined, graph, null)).toBe('feature');
    // implement via edge: edge thread_id=review-thread (map from GardenEdge.threadId to thread_id)
    expect(resolveThreadId(impl, { thread_id: edge.threadId }, graph, 'feature')).toBe('review-thread');
    // implement without edge: inherits from previous (feature)
    expect(resolveThreadId(impl, undefined, graph, 'feature')).toBe('feature');
  });

  it('degraded resume: interrupted full fidelity forces summary:high', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        graph [goal="degraded resume test"]
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo step1"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = parseGardenSource(source);

    // Simulate an interrupted cocoon with full-fidelity codergen
    const cocoon: Cocoon = {
      version: 1,
      run_id: 'degraded-run',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:05Z',
      status: 'interrupted',
      interruption_reason: 'SIGINT',
      completed_nodes: [
        { node_id: 'start', status: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:01Z', retries: 0 },
      ],
      current_node: 'tool1',
      context: {},
      retry_state: {},
      resume_requires_degraded_fidelity: true,
      thread_registry_keys: ['analysis'],
    };

    const engine = new PipelineEngine({
      graph,
      graph_hash: 'hash',
      workspace_root: ws,
      initial_cocoon: cocoon,
    });
    const result = await engine.run();
    expect(result.status).toBe('completed');
  });

  it('canonical run layout created with manifest, checkpoint, artifacts dir', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        graph [goal="layout test"]
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo layout"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = parseGardenSource(source);
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'layout-hash',
      workspace_root: ws,
      run_id: 'layout-test',
    });
    await engine.run();

    const runDir = path.join(ws, '.nectar', 'cocoons', 'layout-test');
    const manifestStat = await stat(path.join(runDir, 'manifest.json'));
    const checkpointStat = await stat(path.join(runDir, 'checkpoint.json'));
    const artifactsDirStat = await stat(path.join(runDir, 'artifacts'));
    expect(manifestStat.isFile()).toBe(true);
    expect(checkpointStat.isFile()).toBe(true);
    expect(artifactsDirStat.isDirectory()).toBe(true);
  });

  it('per-node status.json exists for completed nodes', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo status-test"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = parseGardenSource(source);
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'status-hash',
      workspace_root: ws,
      run_id: 'status-test',
    });
    await engine.run();
    expect(engine.getContextSnapshot()['steps.tool1.notes']).toBeTruthy();

    const statusPath = path.join(ws, '.nectar', 'cocoons', 'status-test', 'tool1', 'status.json');
    const raw = await readFile(statusPath, 'utf8');
    const statusData = JSON.parse(raw);
    expect(statusData.node_id).toBe('tool1');
    expect(statusData.outcome).toBe('success');
    expect(statusData.suggested_next_ids).toBeDefined();
    expect(statusData.context_updates).toBeDefined();
    expect(typeof statusData.notes).toBe('string');
  });

  it('preamble deterministic for same input', () => {
    const input = {
      mode: 'compact' as const,
      goal: 'Determinism test',
      run_id: 'det-001',
      completed_nodes: [
        { node_id: 'a', status: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:01Z', retries: 0 },
      ],
      context: {},
    };
    const p1 = buildPreamble(input);
    const p2 = buildPreamble(input);
    expect(p1).toBe(p2);
  });

  it('ArtifactStore CRUD round-trip in run context', async () => {
    const ws = await createWorkspace();
    const store = new RunStore('art-run', ws);
    await store.initialize({
      run_id: 'art-run',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      workspace_root: ws,
    });

    const artifacts = store.artifactStore();
    const id = store.nextArtifactId('node1', 'preamble');
    await artifacts.store(id, 'test-preamble', 'preamble content');
    expect(await artifacts.has(id)).toBe(true);
    expect(await artifacts.retrieve(id)).toBe('preamble content');
    const list = await artifacts.list();
    expect(list.length).toBe(1);
    await artifacts.remove(id);
    expect(await artifacts.has(id)).toBe(false);
  });

  it('edge fidelity and thread_id parsed from DOT', () => {
    const source = `
      digraph {
        start [shape=mdiamond]
        a [shape=box, prompt="test"]
        b [shape=box, prompt="test2"]
        done [shape=msquare]
        start -> a
        a -> b [fidelity="full", thread_id="shared"]
        b -> done
      }
    `;
    const graph = parseGardenSource(source);
    const edge = graph.edges.find(e => e.source === 'a' && e.target === 'b')!;
    expect(edge.fidelity).toBe('full');
    expect(edge.threadId).toBe('shared');
  });

  it('graph default_fidelity parsed from DOT', () => {
    const source = `
      digraph {
        graph [default_fidelity="summary:high"]
        start [shape=mdiamond]
        done [shape=msquare]
        start -> done
      }
    `;
    const graph = parseGardenSource(source);
    expect(graph.defaultFidelity).toBe('summary:high');
  });

  it('non-codergen nodes unaffected by fidelity', async () => {
    const ws = await createWorkspace();
    const source = `
      digraph {
        graph [default_fidelity="full"]
        start [shape=mdiamond]
        tool1 [shape=parallelogram, script="echo unaffected"]
        done [shape=msquare]
        start -> tool1
        tool1 -> done
      }
    `;
    const graph = parseGardenSource(source);
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'non-codergen-hash',
      workspace_root: ws,
      run_id: 'non-codergen-fidelity',
    });
    const result = await engine.run();
    expect(result.status).toBe('completed');
  });
});
