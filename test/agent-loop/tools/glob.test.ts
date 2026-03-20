import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { globHandler } from '../../../src/agent-loop/tools/glob.js';
import { LocalExecutionEnvironment } from '../../../src/agent-loop/execution-environment.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup(): Promise<LocalExecutionEnvironment> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-glob-test-'));
  tempDirs.push(dir);
  return new LocalExecutionEnvironment(dir);
}

describe('glob tool', () => {
  it('matches files by extension', async () => {
    const env = await setup();
    await mkdir(path.join(env.workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(env.workspaceRoot, 'src', 'main.ts'), '', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'src', 'style.css'), '', 'utf8');

    const result = await globHandler({ pattern: '**/*.ts' }, env);
    expect(result).toContain('src/main.ts');
    expect(result).not.toContain('style.css');
  });

  it('returns no matches message', async () => {
    const env = await setup();
    const result = await globHandler({ pattern: '**/*.xyz' }, env);
    expect(result).toContain('No files matching');
  });

  it('respects max_results', async () => {
    const env = await setup();
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(env.workspaceRoot, `file${i}.ts`), '', 'utf8');
    }

    const result = await globHandler({ pattern: '*.ts', max_results: 3 }, env);
    const files = result.split('\n').filter((l) => l.trim());
    expect(files.length).toBeLessThanOrEqual(3);
  });

  it('returns sorted paths', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'c.ts'), '', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'a.ts'), '', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'b.ts'), '', 'utf8');

    const result = await globHandler({ pattern: '*.ts' }, env);
    const files = result.split('\n');
    expect(files).toEqual([...files].sort());
  });

  it('ignores node_modules and .git', async () => {
    const env = await setup();
    await mkdir(path.join(env.workspaceRoot, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(env.workspaceRoot, 'node_modules', 'pkg', 'index.ts'), '', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'app.ts'), '', 'utf8');

    const result = await globHandler({ pattern: '**/*.ts' }, env);
    expect(result).toContain('app.ts');
    expect(result).not.toContain('node_modules');
  });
});
