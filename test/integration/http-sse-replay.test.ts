import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type NectarServer } from '../../src/server/server.js';

const tempDirs: string[] = [];
const servers: NectarServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-http-sse-'));
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

async function waitForDone(baseUrl: string, runId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const res = await fetch(`${baseUrl}/pipelines/${runId}`);
    const body = (await res.json()) as { status: string };
    if (body.status !== 'running') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Run '${runId}' did not complete in time`);
}

function parseEventIds(payload: string): number[] {
  return payload
    .split('\n')
    .filter((line) => line.startsWith('id: '))
    .map((line) => Number.parseInt(line.slice(4), 10))
    .filter((value) => Number.isInteger(value));
}

describe('HTTP SSE replay', () => {
  it('honors Last-Event-ID and replays only newer events', async () => {
    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const dotSource = `digraph G {
      start [shape=Mdiamond]
      step [shape=parallelogram, tool_command="echo replay-test"]
      done [shape=Msquare]
      start -> step -> done
    }`;

    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: dotSource }),
    });
    const created = (await createRes.json()) as { run_id: string };

    await waitForDone(server.base_url, created.run_id);

    const allEventsRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/events`);
    const allPayload = await allEventsRes.text();
    const allIds = parseEventIds(allPayload);
    expect(allIds.length).toBeGreaterThan(1);

    const replayFrom = allIds[0]!;
    const replayRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/events`, {
      headers: { 'Last-Event-ID': String(replayFrom) },
    });
    const replayPayload = await replayRes.text();
    const replayIds = parseEventIds(replayPayload);
    expect(replayIds.every((id) => id > replayFrom)).toBe(true);
  });
});
