import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileHandler } from '../../../src/agent-loop/tools/write-file.js';
import { LocalExecutionEnvironment } from '../../../src/agent-loop/execution-environment.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup(): Promise<LocalExecutionEnvironment> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-write-test-'));
  tempDirs.push(dir);
  return new LocalExecutionEnvironment(dir);
}

describe('write_file tool', () => {
  it('writes a new file', async () => {
    const env = await setup();
    const result = await writeFileHandler({ path: 'new.txt', content: 'hello world' }, env);
    expect(result).toContain('Wrote');
    expect(result).toContain('bytes');

    const content = await readFile(path.join(env.workspaceRoot, 'new.txt'), 'utf8');
    expect(content).toBe('hello world');
  });

  it('creates parent directories', async () => {
    const env = await setup();
    await writeFileHandler({ path: 'deep/nested/file.txt', content: 'nested content' }, env);

    const content = await readFile(path.join(env.workspaceRoot, 'deep', 'nested', 'file.txt'), 'utf8');
    expect(content).toBe('nested content');
  });

  it('overwrites existing files', async () => {
    const env = await setup();
    await writeFileHandler({ path: 'overwrite.txt', content: 'original' }, env);
    await writeFileHandler({ path: 'overwrite.txt', content: 'updated' }, env);

    const content = await readFile(path.join(env.workspaceRoot, 'overwrite.txt'), 'utf8');
    expect(content).toBe('updated');
  });

  it('rejects paths outside workspace', async () => {
    const env = await setup();
    await expect(writeFileHandler({ path: '../../evil.txt', content: 'bad' }, env)).rejects.toThrow('outside workspace');
  });
});
