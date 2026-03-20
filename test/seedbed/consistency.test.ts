import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { stringify as yamlStringify } from 'yaml';
import { checkConsistency } from '../../src/seedbed/consistency.js';
import { WorkspacePaths, workspacePathsFromRoot } from '../../src/seedbed/paths.js';

let tmpDir: string;
let ws: WorkspacePaths;

beforeEach(async () => {
  tmpDir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'nectar-consist-')));
  ws = workspacePathsFromRoot(tmpDir);
  await mkdir(ws.seedbed, { recursive: true });
  await mkdir(ws.honey, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeMeta(dir: string, meta: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'meta.yaml'), yamlStringify(meta), 'utf8');
}

describe('checkConsistency', () => {
  it('returns no issues for a healthy seed', async () => {
    await writeMeta(path.join(ws.seedbed, '001-test'), {
      id: 1, slug: 'test', title: 'Test', status: 'seedling',
      priority: 'normal', tags: [], created_at: '2026-01-01', updated_at: '2026-01-01',
    });
    const issues = await checkConsistency(ws);
    expect(issues).toHaveLength(0);
  });

  it('detects honey/ with non-honey status', async () => {
    await writeMeta(path.join(ws.honey, '001-test'), {
      id: 1, slug: 'test', title: 'Test', status: 'blooming',
      priority: 'normal', tags: [], created_at: '2026-01-01', updated_at: '2026-01-01',
    });
    const issues = await checkConsistency(ws);
    expect(issues.some(i => i.code === 'PLACEMENT_MISMATCH')).toBe(true);
  });

  it('detects seedbed/ with honey status', async () => {
    await writeMeta(path.join(ws.seedbed, '001-test'), {
      id: 1, slug: 'test', title: 'Test', status: 'honey',
      priority: 'normal', tags: [], created_at: '2026-01-01', updated_at: '2026-01-01',
    });
    const issues = await checkConsistency(ws);
    expect(issues.some(i => i.code === 'PLACEMENT_MISMATCH')).toBe(true);
  });

  it('detects missing required keys', async () => {
    await writeMeta(path.join(ws.seedbed, '001-test'), {
      id: 1, slug: 'test',
      // Missing title, status, priority, tags, created_at, updated_at
    });
    const issues = await checkConsistency(ws);
    const missingKeys = issues.filter(i => i.code === 'MISSING_KEY');
    expect(missingKeys.length).toBeGreaterThanOrEqual(5);
  });

  it('detects unknown status values', async () => {
    await writeMeta(path.join(ws.seedbed, '001-test'), {
      id: 1, slug: 'test', title: 'Test', status: 'invalid_status',
      priority: 'normal', tags: [], created_at: '2026-01-01', updated_at: '2026-01-01',
    });
    const issues = await checkConsistency(ws);
    expect(issues.some(i => i.code === 'UNKNOWN_STATUS')).toBe(true);
  });

  it('detects unknown priority values', async () => {
    await writeMeta(path.join(ws.seedbed, '001-test'), {
      id: 1, slug: 'test', title: 'Test', status: 'seedling',
      priority: 'urgent', tags: [], created_at: '2026-01-01', updated_at: '2026-01-01',
    });
    const issues = await checkConsistency(ws);
    expect(issues.some(i => i.code === 'UNKNOWN_PRIORITY')).toBe(true);
  });

  it('detects missing meta.yaml', async () => {
    await mkdir(path.join(ws.seedbed, '001-no-meta'), { recursive: true });
    const issues = await checkConsistency(ws);
    expect(issues.some(i => i.code === 'MISSING_META')).toBe(true);
  });

  it('detects malformed meta.yaml', async () => {
    const dir = path.join(ws.seedbed, '001-bad');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'meta.yaml'), '}{invalid yaml{}{', 'utf8');
    const issues = await checkConsistency(ws);
    expect(issues.some(i => i.code === 'MALFORMED_META')).toBe(true);
  });

  it('handles empty directories gracefully', async () => {
    const issues = await checkConsistency(ws);
    expect(issues).toHaveLength(0);
  });
});
