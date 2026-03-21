import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-seeds-run-'));
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

async function waitForTerminal(baseUrl: string, runId: string, timeoutMs = 20_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/pipelines/${runId}`);
    const payload = (await response.json()) as { status: string };
    if (payload.status !== 'running') {
      return payload.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Run '${runId}' did not finish in time.`);
}

describe('seed run routes', () => {
  it('PATCH /seeds/:id accepts linked_gardens_add/remove and keeps links normalized', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const createSeed = await fetch(`${server.base_url}/seeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Patch linked gardens test' }),
    });
    const created = (await createSeed.json()) as { seed: { id: number } };

    const addResponse = await fetch(`${server.base_url}/seeds/${created.seed.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        linked_gardens_add: ['gardens/demo.dot', './gardens/demo.dot'],
      }),
    });
    expect(addResponse.status).toBe(200);
    const added = (await addResponse.json()) as { seed: { linked_gardens: string[] } };
    expect(added.seed.linked_gardens).toEqual(['gardens/demo.dot']);

    const detailResponse = await fetch(`${server.base_url}/seeds/${created.seed.id}`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      linked_garden_summaries: Array<{ garden: string; status: string }>;
    };
    expect(detailPayload.linked_garden_summaries[0]).toMatchObject({
      garden: 'gardens/demo.dot',
      status: 'unknown',
    });

    const removeResponse = await fetch(`${server.base_url}/seeds/${created.seed.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        linked_gardens_remove: ['gardens/demo.dot'],
      }),
    });
    expect(removeResponse.status).toBe(200);
    const removed = (await removeResponse.json()) as { seed: { linked_gardens: string[] } };
    expect(removed.seed.linked_gardens).toEqual([]);
  });

  it('POST /seeds/:id/run launches linked garden, updates linkage, and emits timeline', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    await writeFile(
      path.join(ws, 'gardens', 'seed-run.dot'),
      `digraph SeedRun {
        start [shape=Mdiamond]
        work [shape=parallelogram, script="echo linked run"]
        done [shape=Msquare]
        start -> work
        work -> done
      }`,
      'utf8'
    );

    const server = await boot(ws);
    if (!server) {
      return;
    }

    const createSeed = await fetch(`${server.base_url}/seeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Seed run linkage test' }),
    });
    expect(createSeed.status).toBe(201);
    const created = (await createSeed.json()) as { seed: { id: number } };
    const seedId = created.seed.id;

    const linkResponse = await fetch(`${server.base_url}/seeds/${seedId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linked_gardens_add: ['gardens/seed-run.dot'] }),
    });
    expect(linkResponse.status).toBe(200);

    const runResponse = await fetch(`${server.base_url}/seeds/${seedId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(runResponse.status).toBe(202);
    const started = (await runResponse.json()) as { run_id: string };

    const detailDuringRun = await fetch(`${server.base_url}/seeds/${seedId}`);
    const duringPayload = (await detailDuringRun.json()) as {
      meta: { status: string; linked_runs: string[] };
    };
    expect(duringPayload.meta.status).toBe('blooming');
    expect(duringPayload.meta.linked_runs[0]).toBe(started.run_id);

    const finalStatus = await waitForTerminal(server.base_url, started.run_id);
    expect(finalStatus).toBe('completed');

    const detailResponse = await fetch(`${server.base_url}/seeds/${seedId}`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      linked_garden_summaries: Array<{ garden: string; status: string }>;
      linked_run_summaries: Array<{ run_id: string; status: string }>;
      status_suggestion: { suggested_status: string } | null;
    };
    expect(detailPayload.linked_garden_summaries[0]).toMatchObject({
      garden: 'gardens/seed-run.dot',
      status: 'ok',
    });
    expect(detailPayload.linked_run_summaries[0]).toMatchObject({
      run_id: started.run_id,
      status: 'completed',
    });
    expect(detailPayload.status_suggestion?.suggested_status).toBe('honey');

    const activityResponse = await fetch(`${server.base_url}/seeds/activity?limit=50`);
    expect(activityResponse.status).toBe(200);
    const activityPayload = (await activityResponse.json()) as {
      events: Array<{ type: string; seed_id: number; run_id?: string }>;
    };
    const seedEvents = activityPayload.events.filter((event) => event.seed_id === seedId);
    expect(seedEvents.some((event) => event.type === 'run_started' && event.run_id === started.run_id)).toBe(true);
    expect(seedEvents.some((event) => event.type === 'run_completed' && event.run_id === started.run_id)).toBe(true);
  });
});
