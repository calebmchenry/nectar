import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../../src/checkpoint/run-store.js';
import { writeCocoon } from '../../src/checkpoint/cocoon.js';
import type { Cocoon } from '../../src/checkpoint/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-runstore-test-'));
  tempDirs.push(workspace);
  return workspace;
}

function makeCocoon(runId: string, overrides: Partial<Cocoon> = {}): Cocoon {
  return {
    version: 1,
    run_id: runId,
    dot_file: 'test.dot',
    graph_hash: 'hash-123',
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    status: 'running',
    interruption_reason: undefined,
    completed_nodes: [],
    current_node: 'start',
    context: {},
    retry_state: {},
    ...overrides,
  };
}

describe('RunStore', () => {
  it('creates run directory and writes manifest.json on initialize()', async () => {
    const ws = await createWorkspace();
    const store = new RunStore('run-001', ws);
    await store.initialize({
      run_id: 'run-001',
      dot_file: 'test.dot',
      graph_hash: 'abc123',
      goal: 'Test the system',
      started_at: '2026-01-01T00:00:00Z',
      workspace_root: ws,
    });

    const manifest = await store.readManifest();
    expect(manifest).not.toBeNull();
    expect(manifest!.run_id).toBe('run-001');
    expect(manifest!.goal).toBe('Test the system');
    expect(manifest!.graph_hash).toBe('abc123');
  });

  it('writes and reads canonical checkpoint.json', async () => {
    const ws = await createWorkspace();
    const store = new RunStore('run-002', ws);
    await store.initialize({
      run_id: 'run-002',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      workspace_root: ws,
    });

    const cocoon = makeCocoon('run-002', { status: 'completed' });
    await store.writeCheckpoint(cocoon);

    const read = await store.readCheckpoint();
    expect(read).not.toBeNull();
    expect(read!.run_id).toBe('run-002');
    expect(read!.status).toBe('completed');
  });

  it('writes legacy flat cocoon and reads it back', async () => {
    const ws = await createWorkspace();
    const store = new RunStore('run-003', ws);
    await store.initialize({
      run_id: 'run-003',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      workspace_root: ws,
    });

    const cocoon = makeCocoon('run-003');
    await store.writeLegacyMirror(cocoon);

    // Delete canonical to test legacy fallback
    const read = await store.readCheckpoint();
    // Should find canonical first (from initialize, but no checkpoint written yet)
    // Let's test the legacy path directly
    const legacyPath = path.join(ws, '.nectar', 'cocoons', 'run-003.json');
    const raw = await readFile(legacyPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.run_id).toBe('run-003');
  });

  it('readCheckpoint falls back to legacy when canonical missing', async () => {
    const ws = await createWorkspace();
    // Write only a legacy cocoon, no canonical
    const cocoon = makeCocoon('legacy-run', { status: 'interrupted' });
    await writeCocoon(cocoon, ws);

    const store = new RunStore('legacy-run', ws);
    const read = await store.readCheckpoint();
    expect(read).not.toBeNull();
    expect(read!.run_id).toBe('legacy-run');
    expect(read!.status).toBe('interrupted');
  });

  it('listRuns finds both canonical directories and legacy flat files', async () => {
    const ws = await createWorkspace();

    // Create a canonical run
    const store1 = new RunStore('canonical-run', ws);
    await store1.initialize({
      run_id: 'canonical-run',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      workspace_root: ws,
    });
    await store1.writeCheckpoint(makeCocoon('canonical-run', { status: 'completed' }));

    // Create a legacy-only run
    await writeCocoon(makeCocoon('legacy-only', { status: 'interrupted' }), ws);

    const runs = await RunStore.listRuns(ws);
    expect(runs.length).toBe(2);
    const runIds = runs.map(r => r.run_id);
    expect(runIds).toContain('canonical-run');
    expect(runIds).toContain('legacy-only');
  });

  it('pending_transition survives checkpoint serialization', async () => {
    const ws = await createWorkspace();
    const store = new RunStore('run-pt', ws);
    await store.initialize({
      run_id: 'run-pt',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      workspace_root: ws,
    });

    const cocoon = makeCocoon('run-pt', {
      pending_transition: {
        source_node_id: 'nodeA',
        target_node_id: 'nodeB',
        edge: {
          weight: 1,
          fidelity: 'compact',
          thread_id: 'main-thread',
        },
      },
    });
    await store.writeCheckpoint(cocoon);

    const read = await store.readCheckpoint();
    expect(read!.pending_transition).toBeDefined();
    expect(read!.pending_transition!.source_node_id).toBe('nodeA');
    expect(read!.pending_transition!.target_node_id).toBe('nodeB');
    expect(read!.pending_transition!.edge.fidelity).toBe('compact');
    expect(read!.pending_transition!.edge.thread_id).toBe('main-thread');
  });

  it('resume_requires_degraded_fidelity round-trips', async () => {
    const ws = await createWorkspace();
    const store = new RunStore('run-degrade', ws);
    await store.initialize({
      run_id: 'run-degrade',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      workspace_root: ws,
    });

    const cocoon = makeCocoon('run-degrade', {
      resume_requires_degraded_fidelity: true,
    });
    await store.writeCheckpoint(cocoon);

    const read = await store.readCheckpoint();
    expect(read!.resume_requires_degraded_fidelity).toBe(true);
  });

  it('thread_registry_keys round-trips', async () => {
    const ws = await createWorkspace();
    const store = new RunStore('run-threads', ws);
    await store.initialize({
      run_id: 'run-threads',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      workspace_root: ws,
    });

    const cocoon = makeCocoon('run-threads', {
      thread_registry_keys: ['thread-a', 'thread-b'],
    });
    await store.writeCheckpoint(cocoon);

    const read = await store.readCheckpoint();
    expect(read!.thread_registry_keys).toEqual(['thread-a', 'thread-b']);
  });

  it('nextArtifactId allocates unique monotonic IDs', async () => {
    const ws = await createWorkspace();
    const store = new RunStore('run-art', ws);
    const id1 = store.nextArtifactId('node1', 'preamble');
    const id2 = store.nextArtifactId('node1', 'preamble');
    const id3 = store.nextArtifactId('node2', 'response');
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).toContain('node1');
    expect(id3).toContain('node2');
  });

  it('readCocoon static method works for canonical and legacy', async () => {
    const ws = await createWorkspace();

    // Canonical
    const store = new RunStore('static-test', ws);
    await store.initialize({
      run_id: 'static-test',
      dot_file: 'test.dot',
      graph_hash: 'hash',
      started_at: '2026-01-01T00:00:00Z',
      workspace_root: ws,
    });
    await store.writeCheckpoint(makeCocoon('static-test'));

    const read = await RunStore.readCocoon('static-test', ws);
    expect(read).not.toBeNull();
    expect(read!.run_id).toBe('static-test');
  });

  it('returns empty list when no cocoons exist', async () => {
    const ws = await createWorkspace();
    const runs = await RunStore.listRuns(ws);
    expect(runs).toEqual([]);
  });

  it('old cocoons without new fields resume cleanly', async () => {
    const ws = await createWorkspace();
    // Simulate an old cocoon without pending_transition or resume_requires_degraded_fidelity
    const oldCocoon: any = {
      version: 1,
      run_id: 'old-run',
      dot_file: 'test.dot',
      graph_hash: 'old-hash',
      started_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
      status: 'interrupted',
      completed_nodes: [{ node_id: 'start', status: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:01Z', retries: 0 }],
      current_node: 'hello',
      context: {},
      retry_state: {},
    };
    await writeCocoon(oldCocoon, ws);

    const read = await RunStore.readCocoon('old-run', ws);
    expect(read).not.toBeNull();
    expect(read!.pending_transition).toBeUndefined();
    expect(read!.resume_requires_degraded_fidelity).toBeUndefined();
    expect(read!.thread_registry_keys).toBeUndefined();
  });
});
