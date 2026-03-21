import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { createProgram } from '../../src/cli/index.js';
import { RunStore } from '../../src/checkpoint/run-store.js';
import { SeedStore } from '../../src/seedbed/store.js';
import { workspacePathsFromRoot, WorkspacePaths } from '../../src/seedbed/paths.js';
import { checkConsistency } from '../../src/seedbed/consistency.js';
import type { Cocoon } from '../../src/checkpoint/types.js';

let tmpDir: string;
let ws: WorkspacePaths;

beforeEach(async () => {
  tmpDir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'nectar-cli-')));
  ws = workspacePathsFromRoot(tmpDir);
  await mkdir(ws.seedbed, { recursive: true });
  await mkdir(ws.honey, { recursive: true });
  await mkdir(path.join(tmpDir, 'gardens'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function captureOutput() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  (process.stdout.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;

  (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;

  return {
    restore() {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    },
    stdout() {
      return stdoutChunks.join('');
    },
    stderr() {
      return stderrChunks.join('');
    },
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  process.chdir(tmpDir);
  process.exitCode = 0;

  const capture = captureOutput();
  try {
    await createProgram().parseAsync(args, { from: 'user' });
  } finally {
    capture.restore();
    process.chdir(originalCwd);
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = originalExitCode;
  return {
    stdout: capture.stdout(),
    stderr: capture.stderr(),
    exitCode,
  };
}

describe('seed CLI end-to-end', () => {
  it('creates a seed and inspects it', async () => {
    const store = new SeedStore(ws);
    const meta = await store.create({
      body: 'Add rate limiting to the API gateway',
      priority: 'high',
      tags: ['api', 'infra'],
    });

    expect(meta.id).toBe(1);
    expect(meta.status).toBe('seedling');

    const result = await store.get(1);
    expect(result).not.toBeNull();
    expect(result!.meta.title).toBe('Add rate limiting to the API gateway');
    expect(result!.meta.priority).toBe('high');
    expect(result!.meta.tags).toEqual(['api', 'infra']);
    expect(result!.seedMd).toContain('# Add rate limiting to the API gateway');
  });

  it('triages seed status to honey and moves directory', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Complete feature' });

    await store.updateMeta(1, { status: 'sprouting' });
    let result = await store.get(1);
    expect(result!.meta.status).toBe('sprouting');

    await store.updateMeta(1, { status: 'honey' });
    result = await store.get(1);
    expect(result!.meta.status).toBe('honey');

    const honeyEntries = await readdir(ws.honey);
    expect(honeyEntries).toHaveLength(1);
    const seedbedEntries = await readdir(ws.seedbed);
    expect(seedbedEntries).toHaveLength(0);
  });

  it('triages seed priority', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Priority test' });
    await store.updateMeta(1, { priority: 'queens_order' });

    const result = await store.get(1);
    expect(result!.meta.priority).toBe('queens_order');
  });

  it('lists seeds with filtering', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'First', priority: 'low' });
    await store.create({ body: 'Second', priority: 'high' });
    await store.create({ body: 'Third', priority: 'high' });

    const all = await store.list();
    expect(all).toHaveLength(3);

    const highPriority = all.filter(s => s.meta.priority === 'high');
    expect(highPriority).toHaveLength(2);
  });

  it('consistency check detects placement mismatch', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Mismatch test' });
    // Manually move to honey without changing status
    const entries = await readdir(ws.seedbed);
    const { rename } = await import('node:fs/promises');
    await rename(
      path.join(ws.seedbed, entries[0]!),
      path.join(ws.honey, entries[0]!)
    );

    const issues = await checkConsistency(ws);
    expect(issues.some(i => i.code === 'PLACEMENT_MISMATCH')).toBe(true);
  });

  it('consistency check returns clean for valid state', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Clean seed' });
    const issues = await checkConsistency(ws);
    expect(issues).toHaveLength(0);
  });

  it('seed directory structure is filesystem-only', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Filesystem check' });

    // No hidden database or index files
    const rootEntries = await readdir(tmpDir);
    expect(rootEntries).not.toContain('.nectar');
    expect(rootEntries).not.toContain('seeds.db');

    // Directory contains expected files
    const seedEntries = await readdir(ws.seedbed);
    const seedDir = path.join(ws.seedbed, seedEntries[0]!);
    const files = await readdir(seedDir);
    expect(files.sort()).toEqual(['activity.jsonl', 'analysis', 'attachments', 'meta.yaml', 'seed.md']);
  });

  it('links and unlinks gardens from the CLI without server mode', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Link garden from CLI' });
    await writeFile(path.join(tmpDir, 'gardens', 'example.dot'), 'digraph Example { start [shape=Mdiamond] done [shape=Msquare] start -> done }', 'utf8');

    const linked = await runCli(['seed', 'link', '1', 'gardens/example.dot']);
    expect(linked.exitCode).toBe(0);
    const afterLink = await store.get(1);
    expect(afterLink?.meta.linked_gardens).toEqual(['gardens/example.dot']);

    const unlinked = await runCli(['seed', 'unlink', '1', 'gardens/example.dot']);
    expect(unlinked.exitCode).toBe(0);
    const afterUnlink = await store.get(1);
    expect(afterUnlink?.meta.linked_gardens).toEqual([]);
  });

  it('seed show includes linked gardens, runs, and status suggestion', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Show linked run details' });
    await writeFile(path.join(tmpDir, 'gardens', 'example.dot'), 'digraph Example { start [shape=Mdiamond] done [shape=Msquare] start -> done }', 'utf8');
    await store.patch(1, { linked_gardens_add: ['gardens/example.dot'] });

    const runId = 'seed-run-show';
    const startedAt = new Date().toISOString();
    const runStore = new RunStore(runId, tmpDir);
    await runStore.initialize({
      run_id: runId,
      dot_file: 'gardens/example.dot',
      graph_hash: 'show-hash',
      started_at: startedAt,
      workspace_root: tmpDir,
      seed_id: 1,
      seed_dir: 'seedbed/001-show-linked-run-details',
      seed_garden: 'gardens/example.dot',
      launch_origin: 'seed_cli',
    });
    const completedCheckpoint: Cocoon = {
      version: 1,
      run_id: runId,
      dot_file: 'gardens/example.dot',
      graph_hash: 'show-hash',
      started_at: startedAt,
      updated_at: startedAt,
      status: 'completed',
      interruption_reason: undefined,
      completed_nodes: [],
      current_node: undefined,
      context: {},
      retry_state: {},
    };
    await runStore.writeCheckpoint(completedCheckpoint);
    await store.patch(1, { linked_runs_add: [runId] });

    const shown = await runCli(['seed', 'show', '1']);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain('Linked Gardens: 1');
    expect(shown.stdout).toContain('Linked Runs: 1');
    expect(shown.stdout).toContain(runId);
    expect(shown.stdout).toContain('Status suggestion: honey');
  });

  it('handles multiple seeds with archive moves', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Seed One' });
    await store.create({ body: 'Seed Two' });
    await store.create({ body: 'Seed Three' });

    await store.updateMeta(2, { status: 'honey' });

    const all = await store.list();
    expect(all).toHaveLength(3);
    expect(all.find(s => s.meta.id === 2)?.location).toBe('honey');
    expect(all.find(s => s.meta.id === 1)?.location).toBe('seedbed');
    expect(all.find(s => s.meta.id === 3)?.location).toBe('seedbed');
  });
});
