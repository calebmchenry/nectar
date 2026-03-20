import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createArtifactsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-artifacts-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'artifacts');
}

describe('ArtifactStore', () => {
  it('stores and retrieves small inline artifact (<=100KB)', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    const data = 'Hello, world!';
    const info = await store.store('art-1', 'greeting', data);
    expect(info.id).toBe('art-1');
    expect(info.inline).toBe(true);
    expect(info.size).toBe(Buffer.byteLength(data));

    const retrieved = await store.retrieve('art-1');
    expect(retrieved).toBe(data);
  });

  it('stores and retrieves large file-backed artifact (>100KB)', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    const data = 'X'.repeat(150 * 1024); // 150KB
    const info = await store.store('art-big', 'large-payload', data);
    expect(info.inline).toBe(false);

    // File should exist on disk
    const filePath = path.join(dir, 'art-big.json');
    const fileStat = await stat(filePath);
    expect(fileStat.isFile()).toBe(true);

    const retrieved = await store.retrieve('art-big');
    expect(retrieved).toBe(data);
  });

  it('has() returns true for existing artifact', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    await store.store('art-1', 'test', 'data');
    expect(await store.has('art-1')).toBe(true);
    expect(await store.has('nonexistent')).toBe(false);
  });

  it('list() returns all artifact infos', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    await store.store('a', 'first', 'data1');
    await store.store('b', 'second', 'data2');
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.map(a => a.id).sort()).toEqual(['a', 'b']);
  });

  it('remove() deletes inline artifact', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    await store.store('art-1', 'test', 'data');
    const removed = await store.remove('art-1');
    expect(removed).toBe(true);
    expect(await store.has('art-1')).toBe(false);
    expect(await store.retrieve('art-1')).toBeNull();
  });

  it('remove() deletes file-backed artifact', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    const data = 'Y'.repeat(150 * 1024);
    await store.store('art-big', 'large', data);
    const removed = await store.remove('art-big');
    expect(removed).toBe(true);
    expect(await store.has('art-big')).toBe(false);
  });

  it('remove() returns false for nonexistent artifact', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    const removed = await store.remove('nonexistent');
    expect(removed).toBe(false);
  });

  it('clear() removes all artifacts', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    await store.store('a', 'first', 'data1');
    await store.store('b', 'second', 'Z'.repeat(150 * 1024));
    await store.clear();
    const list = await store.list();
    expect(list).toHaveLength(0);
  });

  it('index.json persists inline payloads', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    await store.store('art-1', 'test', 'inline-data');

    // Read raw index
    const raw = await readFile(path.join(dir, 'index.json'), 'utf8');
    const index = JSON.parse(raw);
    expect(index.artifacts['art-1'].data).toBe('inline-data');
  });

  it('retrieve returns null for nonexistent', async () => {
    const dir = await createArtifactsDir();
    const store = new ArtifactStore(dir);
    expect(await store.retrieve('ghost')).toBeNull();
  });
});
