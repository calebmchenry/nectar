import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalExecutionEnvironment } from '../../../src/agent-loop/execution-environment.js';
import {
  readManyFilesDescription,
  readManyFilesHandler,
  readManyFilesSchema,
} from '../../../src/agent-loop/tools/read-many-files.js';
import { ToolRegistry } from '../../../src/agent-loop/tool-registry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function setupWorkspace(): Promise<LocalExecutionEnvironment> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-read-many-files-'));
  tempDirs.push(dir);
  return new LocalExecutionEnvironment(dir);
}

describe('read_many_files tool', () => {
  it('reads multiple files with path headers', async () => {
    const env = await setupWorkspace();
    await writeFile(path.join(env.workspaceRoot, 'a.txt'), 'alpha\n', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'b.txt'), 'beta\n', 'utf8');

    const result = await readManyFilesHandler(
      {
        paths: ['a.txt', 'b.txt'],
      },
      env,
    );

    expect(result).toContain('=== a.txt ===');
    expect(result).toContain('=== b.txt ===');
    expect(result).toContain('1\talpha');
    expect(result).toContain('1\tbeta');
  });

  it('supports shared offset/limit and reports missing files inline', async () => {
    const env = await setupWorkspace();
    await writeFile(path.join(env.workspaceRoot, 'a.txt'), 'line1\nline2\nline3\n', 'utf8');

    const result = await readManyFilesHandler(
      {
        paths: ['a.txt', 'missing.txt'],
        offset: 2,
        limit: 1,
      },
      env,
    );

    expect(result).toContain('=== a.txt ===');
    expect(result).toContain('2\tline2');
    expect(result).toContain('=== missing.txt ===');
    expect(result).toContain('Error:');
  });

  it('enforces workspace boundary per path', async () => {
    const env = await setupWorkspace();
    const result = await readManyFilesHandler(
      {
        paths: ['../../etc/passwd'],
      },
      env,
    );
    expect(result).toContain('outside workspace');
  });

  it('enforces the 20-file cap', async () => {
    const env = await setupWorkspace();
    const tooMany = Array.from({ length: 21 }, (_, i) => `f${i}.txt`);
    const result = await readManyFilesHandler({ paths: tooMany }, env);
    expect(result).toContain('at most 20');
  });

  it('uses registry truncation limits', async () => {
    const env = await setupWorkspace();
    const large = Array.from({ length: 120 }, (_, i) => `line-${i}`).join('\n') + '\n';
    await writeFile(path.join(env.workspaceRoot, 'big.txt'), large, 'utf8');

    const registry = new ToolRegistry();
    registry.register('read_many_files', readManyFilesDescription, readManyFilesSchema, readManyFilesHandler);

    const result = await registry.execute(
      {
        name: 'read_many_files',
        call_id: 'c1',
        arguments: { paths: ['big.txt'] },
      },
      env,
      {
        output_limits: { read_many_files: 160 },
      },
    );

    expect(result.is_error).toBe(false);
    expect(result.content).toContain('truncated');
    expect(result.full_content).toBeTruthy();
  });
});
