import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../src/process/exec-command.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-exec-command-'));
  tempDirs.push(workspace);
  return workspace;
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

describe('execCommand', () => {
  it('kills parent and child processes on timeout', async () => {
    if (!['darwin', 'linux'].includes(process.platform)) {
      return;
    }

    const workspace = await createWorkspace();
    const heartbeatPath = path.join(workspace, 'heartbeat.log');
    const fixturePath = path.resolve('test/fixtures/process-tree.mjs');

    const result = await execCommand({
      command: `node ${JSON.stringify(fixturePath)} ${JSON.stringify(heartbeatPath)}`,
      cwd: workspace,
      env: buildEnv(),
      timeout_ms: 250,
      shell: true,
    });

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBe(124);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const sizeBefore = await fileSize(heartbeatPath);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const sizeAfter = await fileSize(heartbeatPath);
    expect(sizeAfter).toBe(sizeBefore);
  });
});

async function fileSize(filePath: string): Promise<number> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch {
    return 0;
  }
}
