import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type NectarServer } from '../../src/server/server.js';
import { canListenOnLoopback } from '../helpers/network.js';

const tempDirs: string[] = [];
const servers: NectarServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-seedbed-flow-'));
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

async function waitForAnalysisTerminal(baseUrl: string, seedId: number, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/seeds/${seedId}`);
    const payload = (await response.json()) as {
      meta: {
        analysis_status: Record<string, string>;
      };
    };

    const statuses = Object.values(payload.meta.analysis_status);
    if (statuses.some((status) => status === 'complete' || status === 'failed' || status === 'skipped')) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Seed ${seedId} analysis did not reach terminal state.`);
}

async function waitForRunTerminal(baseUrl: string, runId: string, timeoutMs = 20_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/pipelines/${runId}`);
    const payload = (await response.json()) as { status: string };
    if (payload.status !== 'running') {
      return payload.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Run '${runId}' did not reach a terminal status.`);
}

describe('hive seedbed integration flow', () => {
  it('creates seed, uploads attachment, analyzes, synthesizes, and archives to honey', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const createResponse = await fetch(`${server.base_url}/seeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Integration flow seed',
        body: 'Validate end-to-end Seedbed + Swarm flow',
        tags: ['integration', 'seedbed'],
        priority: 'high',
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { seed: { id: number } };
    const seedId = created.seed.id;

    const formData = new FormData();
    formData.set('file', new Blob(['attachment body'], { type: 'text/plain' }), 'notes.txt');
    const uploadResponse = await fetch(`${server.base_url}/seeds/${seedId}/attachments`, {
      method: 'POST',
      body: formData,
    });
    expect(uploadResponse.status).toBe(201);

    const analyzeResponse = await fetch(`${server.base_url}/seeds/${seedId}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: ['claude', 'codex', 'gemini'],
        include_attachments: true,
      }),
    });
    expect(analyzeResponse.status).toBe(202);

    await waitForAnalysisTerminal(server.base_url, seedId);

    const seedbedEntries = await readdir(path.join(ws, 'seedbed'));
    expect(seedbedEntries).toHaveLength(1);
    const seedDir = path.join(ws, 'seedbed', seedbedEntries[0]!);
    const analysisDirEntries = await readdir(path.join(seedDir, 'analysis'));
    expect(analysisDirEntries.some((entry) => entry.endsWith('.md'))).toBe(true);
    const firstAnalysis = await readFile(path.join(seedDir, 'analysis', analysisDirEntries[0]!), 'utf8');
    expect(firstAnalysis).toContain('provider:');
    expect(firstAnalysis).toContain('# Summary');

    const synthesisResponse = await fetch(`${server.base_url}/seeds/${seedId}/synthesis`);
    expect(synthesisResponse.status).toBe(200);
    const synthesisPayload = (await synthesisResponse.json()) as {
      consensus: Record<string, string>;
      divergences: Array<unknown>;
      available_providers: string[];
    };
    expect(synthesisPayload).toHaveProperty('consensus');
    expect(Array.isArray(synthesisPayload.divergences)).toBe(true);
    expect(Array.isArray(synthesisPayload.available_providers)).toBe(true);

    const archiveResponse = await fetch(`${server.base_url}/seeds/${seedId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'honey',
      }),
    });
    expect(archiveResponse.status).toBe(200);

    const seedbedAfter = await readdir(path.join(ws, 'seedbed'));
    const honeyAfter = await readdir(path.join(ws, 'honey'));
    expect(seedbedAfter).toHaveLength(0);
    expect(honeyAfter).toHaveLength(1);
  });

  it('links a garden, runs it from seed API, and detail returns linked runs + suggestion', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    await writeFile(
      path.join(ws, 'gardens', 'seed-hive.dot'),
      `digraph SeedHive {
        start [shape=Mdiamond]
        task [shape=parallelogram, script="echo hive seed run"]
        done [shape=Msquare]
        start -> task
        task -> done
      }`,
      'utf8'
    );

    const server = await boot(ws);
    if (!server) {
      return;
    }

    const createResponse = await fetch(`${server.base_url}/seeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Hive seed run',
        body: 'Run linked garden from seed detail.',
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { seed: { id: number } };
    const seedId = created.seed.id;

    const linkResponse = await fetch(`${server.base_url}/seeds/${seedId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linked_gardens_add: ['gardens/seed-hive.dot'] }),
    });
    expect(linkResponse.status).toBe(200);

    const runResponse = await fetch(`${server.base_url}/seeds/${seedId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(runResponse.status).toBe(202);
    const started = (await runResponse.json()) as { run_id: string };
    expect(await waitForRunTerminal(server.base_url, started.run_id)).toBe('completed');

    const detailResponse = await fetch(`${server.base_url}/seeds/${seedId}`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      linked_run_summaries: Array<{ run_id: string; status: string }>;
      status_suggestion: { suggested_status: string } | null;
    };
    expect(detailPayload.linked_run_summaries[0]).toMatchObject({
      run_id: started.run_id,
      status: 'completed',
    });
    expect(detailPayload.status_suggestion?.suggested_status).toBe('honey');
  });
});
