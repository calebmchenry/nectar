import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readCocoon } from '../../src/checkpoint/cocoon.js';
import { PipelineEngine } from '../../src/engine/engine.js';
import { parseGardenFile } from '../../src/garden/parse.js';

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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-engine-test-'));
  tempDirs.push(workspace);
  await mkdir(path.join(workspace, 'scripts'), { recursive: true });
  await mkdir(path.join(workspace, 'gardens'), { recursive: true });
  await copyFile(path.join(ROOT, 'scripts', 'compliance_loop.mjs'), path.join(workspace, 'scripts', 'compliance_loop.mjs'));
  return workspace;
}

describe('pipeline engine', () => {
  it('runs smoke success graph end-to-end', async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'smoke-success.dot');
    const gardenPath = path.join(workspace, 'gardens', 'smoke-success.dot');
    await copyFile(fixturePath, gardenPath);

    const originalCwd = process.cwd();
    process.chdir(workspace);

    try {
      const graph = await parseGardenFile(gardenPath);
      const engine = new PipelineEngine({
        graph,
        graph_hash: 'smoke-hash',
        workspace_root: workspace,
        run_id: 'smoke-run'
      });

      const result = await engine.run();
      expect(result.status).toBe('completed');

      const cocoon = await readCocoon('smoke-run', workspace);
      expect(cocoon?.status).toBe('completed');
      expect(cocoon?.completed_nodes.length).toBeGreaterThan(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('runs compliance loop with retry and loop-back', { timeout: 60_000 }, async () => {
    const workspace = await createWorkspace();
    const sourceDot = await readFile(path.join(ROOT, 'test', 'fixtures', 'compliance-loop.dot'), 'utf8');
    const gardenPath = path.join(workspace, 'gardens', 'compliance-loop.dot');
    await writeFile(gardenPath, sourceDot, 'utf8');

    const originalCwd = process.cwd();
    process.chdir(workspace);

    try {
      const graph = await parseGardenFile(gardenPath);
      const engine = new PipelineEngine({
        graph,
        graph_hash: 'compliance-hash',
        workspace_root: workspace,
        run_id: 'compliance-run'
      });

      const result = await engine.run();
      expect(result.status).toBe('completed');

      const cocoon = await readCocoon('compliance-run', workspace);
      expect(cocoon?.status).toBe('completed');

      const completedComplianceChecks = cocoon?.completed_nodes.filter(
        (node) => node.node_id === 'compliance_check'
      ).length;
      expect(completedComplianceChecks).toBeGreaterThanOrEqual(2);

      const implementEntry = cocoon?.completed_nodes.find((node) => node.node_id === 'implement');
      // Sprint 026: failure outcomes are now retry-eligible.
      expect(implementEntry?.retries).toBeGreaterThanOrEqual(1);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
