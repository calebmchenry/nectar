import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type NectarServer } from '../../src/server/server.js';
import { canListenOnLoopback } from '../helpers/network.js';

const tempDirs: string[] = [];
const servers: NectarServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-http-resume-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'gardens'), { recursive: true });
  return dir;
}

async function boot(workspaceRoot: string): Promise<NectarServer | null> {
  try {
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      workspace_root: workspaceRoot,
    });
    servers.push(server);
    return server;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('EPERM')) {
      return null;
    }
    throw error;
  }
}

async function waitForStatus(baseUrl: string, runId: string, target: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${baseUrl}/pipelines/${runId}`);
    const body = (await res.json()) as { status: string };
    if (body.status === target) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run '${runId}' did not reach status '${target}' within ${timeoutMs}ms`);
}

describe('HTTP cancel and resume flow', () => {
  it('cancels an active run and resumes it to completion', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }
    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }
    const dotSource = `digraph G {
      start [shape=Mdiamond]
      slow [shape=parallelogram, tool_command="node -e \\"setTimeout(() => process.exit(0), 2000)\\""]
      done [shape=Msquare]
      start -> slow -> done
    }`;

    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: dotSource }),
    });
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { run_id: string };

    const cancelRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/cancel`, { method: 'POST' });
    expect(cancelRes.status).toBe(200);
    const cancelled = (await cancelRes.json()) as { status: string };
    expect(cancelled.status).toBe('interrupted');

    const checkpointRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/checkpoint`);
    const checkpoint = (await checkpointRes.json()) as { interruption_reason?: string };
    expect(checkpoint.interruption_reason).toBe('api_cancel');

    const resumeRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/resume`, { method: 'POST' });
    expect(resumeRes.status).toBe(202);

    await waitForStatus(server.base_url, created.run_id, 'completed', 15_000);
  });
});
