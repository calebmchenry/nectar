import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cocoonPath,
  listCocoons,
  readCocoon,
  writeCocoon,
  writeNodeAttemptLogs
} from '../../src/checkpoint/cocoon.js';
import { Cocoon } from '../../src/checkpoint/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }));
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-cocoon-test-'));
  tempDirs.push(dir);
  return dir;
}

function exampleCocoon(runId = 'run-1'): Cocoon {
  return {
    version: 1,
    run_id: runId,
    dot_file: 'gardens/demo.dot',
    graph_hash: 'abc123',
    started_at: '2026-03-19T00:00:00.000Z',
    updated_at: '2026-03-19T00:00:01.000Z',
    status: 'running',
    interruption_reason: undefined,
    completed_nodes: [],
    current_node: 'start',
    context: {},
    retry_state: {},
    logs: [],
  };
}

describe('cocoon storage', () => {
  it('writes and reads cocoons', async () => {
    const root = await createTempDir();
    const cocoon = exampleCocoon('roundtrip');

    await writeCocoon(cocoon, root);
    const loaded = await readCocoon('roundtrip', root);

    expect(loaded).toEqual(cocoon);
  });

  it('lists cocoons with summaries', async () => {
    const root = await createTempDir();
    await writeCocoon(exampleCocoon('one'), root);
    await writeCocoon({ ...exampleCocoon('two'), updated_at: '2026-03-19T00:10:00.000Z' }, root);

    const summaries = await listCocoons(root);
    expect(summaries.map((summary) => summary.run_id)).toEqual(['two', 'one']);
  });

  it('writes atomically without leftover temp files', async () => {
    const root = await createTempDir();
    await writeCocoon(exampleCocoon('atomic'), root);

    const files = await readdir(path.dirname(cocoonPath('atomic', root)));
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('stores stdout/stderr attempt logs', async () => {
    const root = await createTempDir();
    await writeNodeAttemptLogs('run-logs', 'node-a', 2, 'hello', 'oops', root);

    const files = await readdir(path.join(root, '.nectar', 'cocoons', 'run-logs', 'node-a'));
    expect(files).toContain('attempt-2.stdout.log');
    expect(files).toContain('attempt-2.stderr.log');
  });
});
