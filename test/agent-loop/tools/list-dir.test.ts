import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalExecutionEnvironment } from '../../../src/agent-loop/execution-environment.js';
import { ToolRegistry } from '../../../src/agent-loop/tool-registry.js';
import { listDirDescription, listDirHandler, listDirSchema } from '../../../src/agent-loop/tools/list-dir.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function setupWorkspace(): Promise<LocalExecutionEnvironment> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-list-dir-'));
  tempDirs.push(dir);
  return new LocalExecutionEnvironment(dir);
}

describe('list_dir tool', () => {
  it('lists a directory tree with configurable depth', async () => {
    const env = await setupWorkspace();
    await mkdir(path.join(env.workspaceRoot, 'src', 'lib'), { recursive: true });
    await writeFile(path.join(env.workspaceRoot, 'src', 'index.ts'), 'export {};\n', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'src', 'lib', 'util.ts'), 'export const x = 1;\n', 'utf8');

    const depth1 = await listDirHandler({ path: 'src', depth: 1 }, env);
    expect(depth1).toContain('src/');
    expect(depth1).toContain('  lib/');
    expect(depth1).toContain('  index.ts');
    expect(depth1).not.toContain('util.ts');

    const depth2 = await listDirHandler({ path: 'src', depth: 2 }, env);
    expect(depth2).toContain('    util.ts');
  });

  it('respects .gitignore entries', async () => {
    const env = await setupWorkspace();
    await mkdir(path.join(env.workspaceRoot, 'visible'), { recursive: true });
    await mkdir(path.join(env.workspaceRoot, 'ignored'), { recursive: true });
    await writeFile(path.join(env.workspaceRoot, '.gitignore'), 'ignored/\n', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'visible', 'ok.txt'), 'ok\n', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'ignored', 'secret.txt'), 'secret\n', 'utf8');

    const listing = await listDirHandler({ path: '.', depth: 2 }, env);
    expect(listing).toContain('visible/');
    expect(listing).toContain('ok.txt');
    expect(listing).not.toContain('ignored/');
    expect(listing).not.toContain('secret.txt');
  });

  it('enforces workspace boundary', async () => {
    const env = await setupWorkspace();
    await expect(listDirHandler({ path: '../../', depth: 1 }, env)).rejects.toThrow('outside workspace');
  });

  it('uses registry truncation limits', async () => {
    const env = await setupWorkspace();
    await mkdir(path.join(env.workspaceRoot, 'many'), { recursive: true });
    for (let i = 0; i < 80; i++) {
      await writeFile(path.join(env.workspaceRoot, 'many', `file-${i}.txt`), 'x\n', 'utf8');
    }

    const registry = new ToolRegistry();
    registry.register('list_dir', listDirDescription, listDirSchema, listDirHandler);

    const result = await registry.execute(
      {
        name: 'list_dir',
        call_id: 'c1',
        arguments: { path: 'many', depth: 1 },
      },
      env,
      {
        output_limits: { list_dir: 120 },
      },
    );

    expect(result.is_error).toBe(false);
    expect(result.content).toContain('truncated');
    expect(result.full_content).toBeTruthy();
  });
});
