import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SeedStore } from '../../src/seedbed/store.js';
import { WorkspacePaths, slugify, scanHighestId, workspacePathsFromRoot } from '../../src/seedbed/paths.js';
import { parse as yamlParse } from 'yaml';

let tmpDir: string;
let ws: WorkspacePaths;

beforeEach(async () => {
  tmpDir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'nectar-test-')));
  ws = workspacePathsFromRoot(tmpDir);
  await mkdir(ws.seedbed, { recursive: true });
  await mkdir(ws.honey, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('slugify', () => {
  it('converts title to lowercase slug', () => {
    expect(slugify('Add Rate Limiting to the API Gateway')).toBe('add-rate-limiting-to-the-api-gateway');
  });

  it('replaces non-alphanumeric runs with hyphens', () => {
    expect(slugify('Hello, World! @#$% Test')).toBe('hello-world-test');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('truncates to 48 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(48);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

describe('scanHighestId', () => {
  it('returns 0 for empty directories', async () => {
    const highest = await scanHighestId(ws);
    expect(highest).toBe(0);
  });

  it('finds highest ID across seedbed and honey', async () => {
    await mkdir(path.join(ws.seedbed, '001-first'), { recursive: false });
    await mkdir(path.join(ws.seedbed, '003-third'), { recursive: false });
    await mkdir(path.join(ws.honey, '005-archived'), { recursive: false });
    const highest = await scanHighestId(ws);
    expect(highest).toBe(5);
  });
});

describe('SeedStore', () => {
  it('creates a seed with all fields', async () => {
    const store = new SeedStore(ws);
    const meta = await store.create({
      body: 'Add rate limiting to the API gateway',
      priority: 'high',
      tags: ['api', 'infra'],
    });

    expect(meta.id).toBe(1);
    expect(meta.slug).toBe('add-rate-limiting-to-the-api-gateway');
    expect(meta.title).toBe('Add rate limiting to the API gateway');
    expect(meta.status).toBe('seedling');
    expect(meta.priority).toBe('high');
    expect(meta.tags).toEqual(['api', 'infra']);
    expect(meta.analysis_status.claude).toBe('pending');

    // Check directory structure
    const entries = await readdir(ws.seedbed);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe('001-add-rate-limiting-to-the-api-gateway');

    const seedDir = path.join(ws.seedbed, entries[0]!);
    const subDirs = await readdir(seedDir);
    expect(subDirs).toContain('seed.md');
    expect(subDirs).toContain('meta.yaml');
    expect(subDirs).toContain('attachments');
    expect(subDirs).toContain('analysis');
  });

  it('derives title from first line of body', async () => {
    const store = new SeedStore(ws);
    const meta = await store.create({ body: 'First line title\nMore details here' });
    expect(meta.title).toBe('First line title');
  });

  it('uses explicit --title over body', async () => {
    const store = new SeedStore(ws);
    const meta = await store.create({ title: 'Custom Title', body: 'Body text' });
    expect(meta.title).toBe('Custom Title');
  });

  it('throws when no title or body', async () => {
    const store = new SeedStore(ws);
    await expect(store.create({ body: '' })).rejects.toThrow('Cannot create a seed without a title');
  });

  it('allocates sequential IDs', async () => {
    const store = new SeedStore(ws);
    const s1 = await store.create({ body: 'First seed' });
    const s2 = await store.create({ body: 'Second seed' });
    const s3 = await store.create({ body: 'Third seed' });
    expect(s1.id).toBe(1);
    expect(s2.id).toBe(2);
    expect(s3.id).toBe(3);
  });

  it('retries on ID collision', async () => {
    // Pre-create directory to force collision
    await mkdir(path.join(ws.seedbed, '001-collision'), { recursive: false });
    const store = new SeedStore(ws);
    const meta = await store.create({ body: 'After collision' });
    expect(meta.id).toBe(2);
  });

  it('gets a seed by ID', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Test seed content', tags: ['test'] });
    const result = await store.get(1);

    expect(result).not.toBeNull();
    expect(result!.meta.title).toBe('Test seed content');
    expect(result!.seedMd).toContain('# Test seed content');
  });

  it('returns null for non-existent seed', async () => {
    const store = new SeedStore(ws);
    const result = await store.get(999);
    expect(result).toBeNull();
  });

  it('lists all seeds', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'First' });
    await store.create({ body: 'Second' });
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.meta.id).toBe(1);
    expect(list[1]!.meta.id).toBe(2);
  });

  it('updates meta and refreshes updated_at', async () => {
    const store = new SeedStore(ws);
    const created = await store.create({ body: 'Updatable seed' });
    const before = created.updated_at;

    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 10));
    const updated = await store.updateMeta(1, { priority: 'queens_order' });
    expect(updated.priority).toBe('queens_order');
    expect(updated.updated_at).not.toBe(before);
  });

  it('moves seed to honey/ when status becomes honey', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Archive me' });
    await store.updateMeta(1, { status: 'honey' });

    const seedbedEntries = await readdir(ws.seedbed);
    const honeyEntries = await readdir(ws.honey);
    expect(seedbedEntries).toHaveLength(0);
    expect(honeyEntries).toHaveLength(1);
  });

  it('moves seed back from honey/ when status changes from honey', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Back and forth' });
    await store.updateMeta(1, { status: 'honey' });
    await store.updateMeta(1, { status: 'sprouting' });

    const seedbedEntries = await readdir(ws.seedbed);
    const honeyEntries = await readdir(ws.honey);
    expect(seedbedEntries).toHaveLength(1);
    expect(honeyEntries).toHaveLength(0);
  });

  it('meta.yaml is valid YAML with required fields', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'YAML check', priority: 'high', tags: ['test'] });

    const entries = await readdir(ws.seedbed);
    const metaRaw = await readFile(path.join(ws.seedbed, entries[0]!, 'meta.yaml'), 'utf8');
    const meta = yamlParse(metaRaw) as Record<string, unknown>;

    expect(meta.id).toBe(1);
    expect(meta.slug).toBeTruthy();
    expect(meta.title).toBeTruthy();
    expect(meta.status).toBe('seedling');
    expect(meta.priority).toBe('high');
    expect(meta.tags).toEqual(['test']);
    expect(meta.created_at).toBeTruthy();
    expect(meta.updated_at).toBeTruthy();
    expect(meta.linked_gardens).toEqual([]);
    expect(meta.linked_runs).toEqual([]);
    expect(meta.analysis_status).toBeTruthy();
  });
});
