import { describe, expect, it, afterEach } from 'vitest';
import { LocalExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-env-'));
  tempDirs.push(dir);
  return dir;
}

describe('ExecutionEnvironment cwd and scoped()', () => {
  it('cwd defaults to workspaceRoot', async () => {
    const workspace = await createWorkspace();
    const env = new LocalExecutionEnvironment(workspace);
    // Resolve symlinks for comparison
    const resolved = env.workspaceRoot;
    expect(env.cwd).toBe(resolved);
  });

  it('scoped() creates new env with different cwd', async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, 'packages', 'cli'), { recursive: true });

    const env = new LocalExecutionEnvironment(workspace);
    const scoped = env.scoped('packages/cli');

    expect(scoped.workspaceRoot).toBe(env.workspaceRoot);
    expect(scoped.cwd).toContain('packages/cli');
    expect(scoped.cwd).not.toBe(env.cwd);
  });

  it('scoped() enforces workspace root boundary', async () => {
    const workspace = await createWorkspace();
    const env = new LocalExecutionEnvironment(workspace);

    expect(() => env.scoped('../../etc')).toThrow('resolves outside workspace root');
  });

  it('scoped env resolves relative paths from new cwd', async () => {
    const workspace = await createWorkspace();
    const subdir = path.join(workspace, 'packages', 'cli');
    await mkdir(subdir, { recursive: true });
    await writeFile(path.join(subdir, 'test.txt'), 'hello', 'utf8');

    const env = new LocalExecutionEnvironment(workspace);
    const scoped = env.scoped('packages/cli');

    const content = await scoped.readFile('test.txt');
    expect(content).toBe('hello');
  });

  it('scoped env runs shell commands from new cwd', async () => {
    const workspace = await createWorkspace();
    const subdir = path.join(workspace, 'packages');
    await mkdir(subdir, { recursive: true });

    const env = new LocalExecutionEnvironment(workspace);
    const scoped = env.scoped('packages');

    const result = await scoped.exec('pwd');
    expect(result.stdout.trim()).toContain('packages');
  });

  it('absolute paths inside workspace still work from scoped env', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'root.txt'), 'root content', 'utf8');
    await mkdir(path.join(workspace, 'sub'), { recursive: true });

    const env = new LocalExecutionEnvironment(workspace);
    const scoped = env.scoped('sub');

    const resolved = env.workspaceRoot;
    const content = await scoped.readFile(path.join(resolved, 'root.txt'));
    expect(content).toBe('root content');
  });
});
