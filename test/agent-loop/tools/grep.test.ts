import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grepHandler } from '../../../src/agent-loop/tools/grep.js';
import { LocalExecutionEnvironment } from '../../../src/agent-loop/execution-environment.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup(): Promise<LocalExecutionEnvironment> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-grep-test-'));
  tempDirs.push(dir);
  return new LocalExecutionEnvironment(dir);
}

describe('grep tool', () => {
  it('finds matches in files', async () => {
    const env = await setup();
    await mkdir(path.join(env.workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(env.workspaceRoot, 'src', 'main.ts'), 'const TODO = "fix this";\nconst x = 1;\n', 'utf8');

    const result = await grepHandler({ pattern: 'TODO' }, env);
    expect(result).toContain('src/main.ts');
    expect(result).toContain('TODO');
  });

  it('returns no matches message', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'empty.ts'), 'nothing here\n', 'utf8');

    const result = await grepHandler({ pattern: 'NONEXISTENT' }, env);
    expect(result).toContain('No matches');
  });

  it('scopes search to subdirectory', async () => {
    const env = await setup();
    await mkdir(path.join(env.workspaceRoot, 'src'), { recursive: true });
    await mkdir(path.join(env.workspaceRoot, 'test'), { recursive: true });
    await writeFile(path.join(env.workspaceRoot, 'src', 'a.ts'), 'MATCH\n', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'test', 'b.ts'), 'MATCH\n', 'utf8');

    const result = await grepHandler({ pattern: 'MATCH', path: 'src' }, env);
    expect(result).toContain('src/a.ts');
    expect(result).not.toContain('test/b.ts');
  });

  it('filters by include pattern', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'a.ts'), 'FIND\n', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'b.js'), 'FIND\n', 'utf8');

    const result = await grepHandler({ pattern: 'FIND', include: '*.ts' }, env);
    expect(result).toContain('a.ts');
    expect(result).not.toContain('b.js');
  });

  it('respects max_results', async () => {
    const env = await setup();
    const lines = Array.from({ length: 50 }, (_, i) => `MATCH line ${i}`).join('\n');
    await writeFile(path.join(env.workspaceRoot, 'big.txt'), lines, 'utf8');

    const result = await grepHandler({ pattern: 'MATCH', max_results: 5 }, env);
    const matches = result.split('\n').filter((l) => l.includes('MATCH'));
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  it('returns error for invalid regex', async () => {
    const env = await setup();
    const result = await grepHandler({ pattern: '[invalid' }, env);
    expect(result).toContain('Invalid regex');
  });

  it('supports case_insensitive matching', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'todo.txt'), 'Todo item\n', 'utf8');

    const result = await grepHandler({ pattern: 'todo', case_insensitive: true }, env);
    expect(result).toContain('todo.txt:1:Todo item');
  });

  it('does not match different casing when case_insensitive is false', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'todo.txt'), 'Todo item\n', 'utf8');

    const result = await grepHandler({ pattern: 'todo' }, env);
    expect(result).toContain('No matches');
  });
});
