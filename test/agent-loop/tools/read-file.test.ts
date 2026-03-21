import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileHandler } from '../../../src/agent-loop/tools/read-file.js';
import { LocalExecutionEnvironment } from '../../../src/agent-loop/execution-environment.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup(): Promise<LocalExecutionEnvironment> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-read-test-'));
  tempDirs.push(dir);
  return new LocalExecutionEnvironment(dir);
}

describe('read_file tool', () => {
  it('reads file with line numbers', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'hello.txt'), 'line1\nline2\nline3', 'utf8');

    const result = await readFileHandler({ file_path: 'hello.txt' }, env);
    expect(result).toContain('1\tline1');
    expect(result).toContain('2\tline2');
    expect(result).toContain('3\tline3');
  });

  it('supports offset and limit', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'lines.txt'), 'a\nb\nc\nd\ne', 'utf8');

    const result = await readFileHandler({ file_path: 'lines.txt', offset: 2, limit: 2 }, env);
    expect(result).toContain('b');
    expect(result).toContain('c');
    expect(result).not.toContain('\ta\n');
    expect(result).not.toContain('\td\n');
  });

  it('detects and rejects binary files', async () => {
    const env = await setup();
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]);
    await writeFile(path.join(env.workspaceRoot, 'image.png'), binaryContent);

    const result = await readFileHandler({ file_path: 'image.png' }, env);
    expect(result).toContain('binary file');
  });

  it('errors on non-existent file', async () => {
    const env = await setup();
    await expect(readFileHandler({ file_path: 'missing.txt' }, env)).rejects.toThrow();
  });

  it('rejects paths outside workspace', async () => {
    const env = await setup();
    await expect(readFileHandler({ file_path: '../../etc/passwd' }, env)).rejects.toThrow('outside workspace');
  });

  it('accepts legacy path alias', async () => {
    const env = await setup();
    await writeFile(path.join(env.workspaceRoot, 'legacy.txt'), 'ok', 'utf8');
    const result = await readFileHandler({ path: 'legacy.txt' }, env);
    expect(result).toContain('1\tok');
  });
});
