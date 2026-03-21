import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceConfigLoader } from '../../src/config/workspace.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-workspace-config-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, '.nectar'), { recursive: true });
  return dir;
}

describe('WorkspaceConfigLoader', () => {
  it('uses safe defaults when config file is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const loader = new WorkspaceConfigLoader(workspaceRoot);

    const loaded = await loader.load();

    expect(loaded.exists).toBe(false);
    expect(loaded.source).toBe('defaults');
    expect(loaded.resolved.draft.provider).toBe('simulation');
    expect(loaded.resolved.draft.model).toBe('simulation');
    expect(loaded.resolved.runtime.fallback_llm_provider).toBe('simulation');
    expect(loaded.diagnostics).toEqual([]);
  });

  it('reports invalid YAML', async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, '.nectar', 'config.yaml'), 'draft: [broken', 'utf8');

    const loader = new WorkspaceConfigLoader(workspaceRoot);
    const loaded = await loader.load();

    expect(loaded.exists).toBe(true);
    expect(loaded.diagnostics.some((diag) => diag.code === 'INVALID_YAML')).toBe(true);
    expect(loaded.resolved.draft.provider).toBe('simulation');
  });

  it('reports unknown model IDs', async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(
      path.join(workspaceRoot, '.nectar', 'config.yaml'),
      [
        'draft:',
        '  provider: openai',
        '  model: made-up-model',
      ].join('\n'),
      'utf8',
    );

    const loader = new WorkspaceConfigLoader(workspaceRoot);
    const loaded = await loader.load();

    expect(loaded.resolved.draft.provider).toBe('openai');
    expect(loaded.resolved.draft.model).toBe('made-up-model');
    expect(
      loaded.diagnostics.some((diag) => diag.code === 'UNKNOWN_MODEL' && diag.path === 'draft.model'),
    ).toBe(true);
  });

  it('warns on secret-looking keys and ignores them', async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(
      path.join(workspaceRoot, '.nectar', 'config.yaml'),
      [
        'draft:',
        '  provider: simulation',
        '  model: simulation',
        '  api_key: should-not-be-here',
      ].join('\n'),
      'utf8',
    );

    const loader = new WorkspaceConfigLoader(workspaceRoot);
    const loaded = await loader.load();

    expect(loaded.resolved.draft.provider).toBe('simulation');
    expect(loaded.resolved.draft.model).toBe('simulation');
    expect(
      loaded.diagnostics.some((diag) => diag.code === 'SECRET_FIELD' && diag.path === 'draft.api_key'),
    ).toBe(true);
  });
});
