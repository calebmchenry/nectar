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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-sse-lifecycle-'));
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

describe('SSE lifecycle', () => {
  it('closes /pipelines/:id/events within 1 second of the terminal event', async () => {
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
      slow [shape=parallelogram, script="node -e \\"setTimeout(() => process.exit(0), 200)\\""]
      done [shape=Msquare]
      start -> slow -> done
    }`;

    const createResponse = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: dotSource }),
    });
    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { run_id: string };

    const eventsResponse = await fetch(`${server.base_url}/pipelines/${created.run_id}/events`);
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.body).toBeTruthy();

    const terminalEvents = new Set(['run_completed', 'pipeline_failed', 'run_interrupted', 'run_error']);
    const reader = eventsResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let terminalSeenAt: number | null = null;
    let streamClosedAt: number | null = null;

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        streamClosedAt = Date.now();
        break;
      }

      buffered += decoder.decode(value, { stream: true });
      let newlineIndex = buffered.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffered.slice(0, newlineIndex).trim();
        buffered = buffered.slice(newlineIndex + 1);
        if (line.startsWith('event:')) {
          const eventName = line.slice('event:'.length).trim();
          if (terminalEvents.has(eventName)) {
            terminalSeenAt = Date.now();
          }
        }
        newlineIndex = buffered.indexOf('\n');
      }
    }

    expect(terminalSeenAt).not.toBeNull();
    expect(streamClosedAt).not.toBeNull();
    expect((streamClosedAt as number) - (terminalSeenAt as number)).toBeLessThanOrEqual(1000);
  });
});
