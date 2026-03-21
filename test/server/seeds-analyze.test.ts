import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-seeds-analyze-'));
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

async function createSeed(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/seeds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Analyze endpoint contract',
      body: 'Create a seed for analyze endpoint validation.',
      tags: ['server'],
      priority: 'high',
    }),
  });
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { seed: { id: number } };
  return payload.seed.id;
}

async function waitForAnalysis(baseUrl: string, seedId: number, provider: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/seeds/${seedId}`);
    const payload = (await response.json()) as {
      meta: { analysis_status: Record<string, string> };
    };
    const status = payload.meta.analysis_status[provider];
    if (status && status !== 'running' && status !== 'pending') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  throw new Error(`Analysis for provider '${provider}' did not reach terminal state.`);
}

describe('seed analyze routes', () => {
  it('starts analysis with 202 contract and surfaces parse_error documents', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const seedId = await createSeed(server.base_url);

    const analyzeResponse = await fetch(`${server.base_url}/seeds/${seedId}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: ['claude'],
        include_attachments: false,
      }),
    });

    expect(analyzeResponse.status).toBe(202);
    const analyzePayload = (await analyzeResponse.json()) as {
      seed_id: number;
      job_status: string;
      accepted_providers: string[];
      already_running: boolean;
    };
    expect(analyzePayload.seed_id).toBe(seedId);
    expect(analyzePayload.job_status).toBe('started');
    expect(analyzePayload.accepted_providers).toEqual(['claude']);
    expect(typeof analyzePayload.already_running).toBe('boolean');

    await waitForAnalysis(server.base_url, seedId, 'claude');

    const listSeedbed = await readdir(path.join(ws, 'seedbed'));
    expect(listSeedbed.length).toBe(1);
    const seedDir = path.join(ws, 'seedbed', listSeedbed[0]!);
    await writeFile(path.join(seedDir, 'analysis', 'gemini.md'), 'not valid analysis markdown', 'utf8');

    const detailResponse = await fetch(`${server.base_url}/seeds/${seedId}`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      analyses: Array<{ provider: string; status: string; error?: string }>;
    };

    const parseError = detailPayload.analyses.find((analysis) => analysis.provider === 'gemini');
    expect(parseError?.status).toBe('parse_error');
    expect(parseError?.error).toMatch(/invalid analysis document/i);
  });
});
