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

  it('replace_all=true replaces all occurrences and reports count', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'foo\nbar\nfoo\nfoo\n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: 'foo',
      new_string: 'baz',
      replace_all: true,
    }, env);

    expect(result).toContain('replaced 3 occurrence(s)');
    const content = await readFile(path.join(env.workspaceRoot, 'code.ts'), 'utf8');
    expect(content).toBe('baz\nbar\nbaz\nbaz\n');
  });

  it('rejects replace_all=true when old_string is empty', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'foo\n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: '',
      new_string: 'bar',
      replace_all: true,
    }, env);

    expect(result).toContain('old_string cannot be empty when replace_all=true');
  });

  it('rejects paths outside workspace', async () => {
    const env = await setup();
    await expect(editFileHandler({
      path: '../../etc/hosts',
      old_string: 'a',
      new_string: 'b',
    }, env)).rejects.toThrow('outside workspace');
  });

  it('falls back to fuzzy matching for tab-vs-space drift', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'if (ok) {\n\treturn 1;\n}\n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: 'if (ok) {\n  return 1;\n}',
      new_string: 'if (ok) {\n  return 2;\n}',
    }, env);

    expect(result).toContain('fuzzy_matched: true');
    const content = await readFile(path.join(env.workspaceRoot, 'code.ts'), 'utf8');
    expect(content).toContain('return 2;');
  });

  it('falls back to fuzzy matching for trailing whitespace drift', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'const value = 1;   \n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: 'const value = 1;\n',
      new_string: 'const value = 3;',
    }, env);

    expect(result).toContain('fuzzy_matched: true');
    const content = await readFile(path.join(env.workspaceRoot, 'code.ts'), 'utf8');
    expect(content).toContain('const value = 3;');
  });

  it('falls back to fuzzy matching for collapsed multi-space drift', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'const    name = "bee";\n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: 'const name = "bee";',
      new_string: 'const name = "hive";',
    }, env);

    expect(result).toContain('fuzzy_matched: true');
    const content = await readFile(path.join(env.workspaceRoot, 'code.ts'), 'utf8');
    expect(content).toContain('"hive"');
  });

  it('keeps original not-found error on ambiguous fuzzy matches', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'foo\tbar\nfoo    bar\n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: 'foo bar',
      new_string: 'x',
    }, env);

    expect(result).toContain('old_string not found');
  });

  it('prefers exact matching over fuzzy matching when exact exists', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'code.ts'), 'const value = 1;\nconst  value = 2;\n', 'utf8');

    const result = await editFileHandler({
      path: 'code.ts',
      old_string: 'const value = 1;',
      new_string: 'const value = 9;',
    }, env);

    expect(result).not.toContain('fuzzy_matched: true');
    const content = await readFile(path.join(env.workspaceRoot, 'code.ts'), 'utf8');
    expect(content).toContain('const value = 9;');
  });
});
