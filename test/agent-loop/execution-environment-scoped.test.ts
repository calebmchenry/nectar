import { describe, expect, it, afterEach } from 'vitest';
import { LocalExecutionEnvironment, _filterEnvForTest } from '../../src/agent-loop/execution-environment.js';
import { mkdtemp, rm, mkdir, stat, writeFile } from 'node:fs/promises';
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

async function heartbeatSize(filePath: string): Promise<number> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch {
    return 0;
  }
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
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.timed_out).toBe(false);
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

  it('initialize and cleanup are idempotent', async () => {
    const workspace = await createWorkspace();
    const env = new LocalExecutionEnvironment(workspace);

    await env.initialize();
    await env.initialize();
    await env.cleanup();
    await env.cleanup();
  });

  it('list_directory delegates tree rendering from the environment', async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, 'a', 'b'), { recursive: true });
    await writeFile(path.join(workspace, 'a', 'b', 'file.txt'), 'hello', 'utf8');

    const env = new LocalExecutionEnvironment(workspace);
    const listing = await env.list_directory('a', 2);
    expect(listing).toContain('a/');
    expect(listing).toContain('b/');
    expect(listing).toContain('file.txt');
  });

  it('exec sets timed_out when command exceeds timeout', async () => {
    const workspace = await createWorkspace();
    const env = new LocalExecutionEnvironment(workspace);

    const result = await env.exec('sleep 1', { timeout_ms: 10 });
    expect(result.timed_out).toBe(true);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('timeout kills the full process group (including grandchildren)', async () => {
    if (!['darwin', 'linux'].includes(process.platform)) {
      return;
    }

    const workspace = await createWorkspace();
    const env = new LocalExecutionEnvironment(workspace);
    const heartbeatPath = path.join(workspace, 'timeout-heartbeat.log');
    const fixturePath = path.resolve('test/fixtures/process-tree.mjs');
    const command = `node ${JSON.stringify(fixturePath)} ${JSON.stringify(heartbeatPath)}`;

    const result = await env.exec(command, { timeout_ms: 250 });
    expect(result.timed_out).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const sizeBefore = await heartbeatSize(heartbeatPath);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const sizeAfter = await heartbeatSize(heartbeatPath);
    expect(sizeAfter).toBe(sizeBefore);
  });

  it('abort kills the full process group (including grandchildren)', async () => {
    if (!['darwin', 'linux'].includes(process.platform)) {
      return;
    }

    const workspace = await createWorkspace();
    const env = new LocalExecutionEnvironment(workspace);
    const heartbeatPath = path.join(workspace, 'abort-heartbeat.log');
    const fixturePath = path.resolve('test/fixtures/process-tree.mjs');
    const command = `node ${JSON.stringify(fixturePath)} ${JSON.stringify(heartbeatPath)}`;
    const controller = new AbortController();

    const pending = env.exec(command, {
      timeout_ms: 10_000,
      abort_signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();

    const result = await pending;
    expect(result.timed_out).toBe(false);
    expect(result.exitCode).toBe(130);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const sizeBefore = await heartbeatSize(heartbeatPath);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const sizeAfter = await heartbeatSize(heartbeatPath);
    expect(sizeAfter).toBe(sizeBefore);
  });

  it('allowlist retains language toolchain roots while stripping secrets', () => {
    const filtered = _filterEnvForTest({
      PATH: '/usr/bin',
      GOPATH: '/tmp/go',
      CARGO_HOME: '/tmp/cargo',
      VOLTA_HOME: '/tmp/volta',
      PNPM_HOME: '/tmp/pnpm',
      OPENAI_API_KEY: 'secret',
      MY_SECRET: 'should-not-pass',
    });

    expect(filtered['GOPATH']).toBe('/tmp/go');
    expect(filtered['CARGO_HOME']).toBe('/tmp/cargo');
    expect(filtered['VOLTA_HOME']).toBe('/tmp/volta');
    expect(filtered['PNPM_HOME']).toBe('/tmp/pnpm');
    expect(filtered['OPENAI_API_KEY']).toBeUndefined();
    expect(filtered['MY_SECRET']).toBeUndefined();
  });
});
