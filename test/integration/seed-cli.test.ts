import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { SeedStore } from '../../src/seedbed/store.js';
import { workspacePathsFromRoot, WorkspacePaths } from '../../src/seedbed/paths.js';
import { checkConsistency } from '../../src/seedbed/consistency.js';

let tmpDir: string;
let ws: WorkspacePaths;

beforeEach(async () => {
  tmpDir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'nectar-cli-')));
  ws = workspacePathsFromRoot(tmpDir);
  await mkdir(ws.seedbed, { recursive: true });
  await mkdir(ws.honey, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

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
    expect(files.sort()).toEqual(['analysis', 'attachments', 'meta.yaml', 'seed.md']);
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
