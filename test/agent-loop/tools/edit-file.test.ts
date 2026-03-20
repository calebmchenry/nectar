import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editFileHandler } from '../../../src/agent-loop/tools/edit-file.js';
import { LocalExecutionEnvironment } from '../../../src/agent-loop/execution-environment.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup(): Promise<LocalExecutionEnvironment> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-edit-test-'));
  tempDirs.push(dir);
  return new LocalExecutionEnvironment(dir);
}

describe('edit_file tool', () => {
  it('replaces exact unique match', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 42;',
    }, env);

    expect(result).toContain('Edited');
    const content = await readFile(path.join(env.workspaceRoot, 'code.ts'), 'utf8');
    expect(content).toBe('const x = 42;\nconst y = 2;\n');
  });

  it('returns error on zero matches', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'const x = 1;\n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: 'const z = 99;',
      new_string: 'replaced',
    }, env);

    expect(result).toContain('not found');
  });

  it('returns error with line numbers on multiple matches', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'foo\nbar\nfoo\n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: 'foo',
      new_string: 'baz',
    }, env);

    expect(result).toContain('2 matches');
    expect(result).toContain('lines');
  });

  it('rejects paths outside workspace', async () => {
    const env = await setup();
    await expect(editFileHandler({
      path: '../../etc/hosts',
      old_string: 'a',
      new_string: 'b',
    }, env)).rejects.toThrow('outside workspace');
  });
});
