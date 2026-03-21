import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shellHandler } from '../../../src/agent-loop/tools/shell.js';
import { LocalExecutionEnvironment } from '../../../src/agent-loop/execution-environment.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup(): Promise<LocalExecutionEnvironment> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-shell-test-'));
  tempDirs.push(dir);
  return new LocalExecutionEnvironment(dir);
}

describe('shell tool', () => {
  it('executes a command and returns output', async () => {
    const env = await setup();
    const result = await shellHandler({ command: 'echo "hello world"' }, env);
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('hello world');
  });

  it('captures stderr', async () => {
    const env = await setup();
    const result = await shellHandler({ command: 'echo "err" >&2' }, env);
    expect(result).toContain('STDERR');
    expect(result).toContain('err');
  });

  it('reports non-zero exit code', async () => {
    const env = await setup();
    const result = await shellHandler({ command: 'exit 42' }, env);
    expect(result).toContain('Exit code: 42');
  });

  it('includes optional description in output', async () => {
    const env = await setup();
    const result = await shellHandler({ command: 'echo "hello"', description: 'Run quick hello check' }, env);
    expect(result).toContain('Description: Run quick hello check');
  });

  it('filters sensitive environment variables', async () => {
    const env = await setup();
    // Set a sensitive env var
    const originalKey = process.env['MY_API_KEY'];
    process.env['MY_API_KEY'] = 'secret123';
    try {
      const result = await shellHandler({ command: 'echo $MY_API_KEY' }, env);
      expect(result).not.toContain('secret123');
    } finally {
      if (originalKey === undefined) {
        delete process.env['MY_API_KEY'];
      } else {
        process.env['MY_API_KEY'] = originalKey;
      }
    }
  });

  it('appends timeout guidance when command times out', async () => {
    const env = await setup();
    const result = await shellHandler({ command: 'sleep 1', timeout_ms: 10 }, env);
    expect(result).toContain('Exit code: 124');
    expect(result).toContain('[ERROR: Command timed out after');
    expect(result).toContain('timeout_ms parameter');
  });
});
