import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
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

  it('supports path as base search directory', async () => {
    const env = await setup();
    await mkdir(path.join(env.workspaceRoot, 'src'), { recursive: true });
    await mkdir(path.join(env.workspaceRoot, 'test'), { recursive: true });
    await writeFile(path.join(env.workspaceRoot, 'src', 'main.ts'), '', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'test', 'main.ts'), '', 'utf8');

    const result = await globHandler({ pattern: '**/*.ts', path: 'src' }, env);
    expect(result).toContain('src/main.ts');
    expect(result).not.toContain('test/main.ts');
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

  it('applies sorting before max_results truncation', async () => {
    const env = await setup();
    const oldPath = path.join(env.workspaceRoot, 'old.ts');
    const midPath = path.join(env.workspaceRoot, 'mid.ts');
    const newPath = path.join(env.workspaceRoot, 'new.ts');

    await writeFile(oldPath, '', 'utf8');
    await writeFile(midPath, '', 'utf8');
    await writeFile(newPath, '', 'utf8');

    const nowSeconds = Date.now() / 1000;
    await utimes(oldPath, nowSeconds - 300, nowSeconds - 300);
    await utimes(midPath, nowSeconds - 200, nowSeconds - 200);
    await utimes(newPath, nowSeconds - 100, nowSeconds - 100);

    const result = await globHandler({ pattern: '*.ts', max_results: 2 }, env);
    const files = result.split('\n');
    expect(files).toEqual(['new.ts', 'mid.ts']);
  });

  it('sorts results by mtime (newest first)', async () => {
    const env = await setup();
    const aPath = path.join(env.workspaceRoot, 'a.ts');
    const bPath = path.join(env.workspaceRoot, 'b.ts');
    const cPath = path.join(env.workspaceRoot, 'c.ts');

    await writeFile(aPath, '', 'utf8');
    await writeFile(bPath, '', 'utf8');
    await writeFile(cPath, '', 'utf8');

    const nowSeconds = Date.now() / 1000;
    await utimes(aPath, nowSeconds - 300, nowSeconds - 300);
    await utimes(bPath, nowSeconds - 200, nowSeconds - 200);
    await utimes(cPath, nowSeconds - 100, nowSeconds - 100);

    const result = await globHandler({ pattern: '*.ts' }, env);
    const files = result.split('\n');
    expect(files).toEqual(['c.ts', 'b.ts', 'a.ts']);
  });

  it('keeps files with stat failures and sorts them to the end', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'good.ts'), '', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'bad.ts'), '', 'utf8');

    const hookedEnv = Object.assign(Object.create(env), {
      statFile: async (relativePath: string) => {
        if (relativePath === 'bad.ts') {
          throw new Error('boom');
        }
        return Date.now();
      },
    });

    const result = await globHandler({ pattern: '*.ts' }, hookedEnv as LocalExecutionEnvironment);
    const files = result.split('\n');
    expect(files[0]).toBe('good.ts');
    expect(files[files.length - 1]).toBe('bad.ts');
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
