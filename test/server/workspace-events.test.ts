import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-workspace-events-'));
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

async function createAndAnalyze(baseUrl: string): Promise<void> {
  const create = await fetch(`${baseUrl}/seeds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Workspace events seed',
      body: 'Emit semantic events through SSE.',
    }),
  });
  expect(create.status).toBe(201);
  const created = (await create.json()) as { seed: { id: number } };

  const analyze = await fetch(`${baseUrl}/seeds/${created.seed.id}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providers: ['claude'],
      include_attachments: false,
    }),
  });
  expect(analyze.status).toBe(202);
}

async function readUntilMatches(
  baseUrl: string,
  expectedPatterns: string[],
  action: () => Promise<void>,
  timeoutMs = 8_000
): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/events`, {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.body).toBeTruthy();

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  await action();
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const chunk = await readChunkWithTimeout(reader, 200);
      if (!chunk) {
        continue;
      }

      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      if (expectedPatterns.every((pattern) => buffer.includes(pattern))) {
        return buffer;
      }
    }
  } finally {
    controller.abort();
    reader.releaseLock();
  }

  throw new Error(`Timed out waiting for patterns: ${expectedPatterns.join(', ')}`);
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  return (await Promise.race([reader.read(), timeout])) as ReadableStreamReadResult<Uint8Array> | null;
}

describe('workspace events route', () => {
  it('emits semantic seed analysis lifecycle events through /events SSE', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const payload = await readUntilMatches(
      server.base_url,
      ['event: seed_created', 'event: seed_analysis_started', 'event: seed_analysis_completed'],
      () => createAndAnalyze(server.base_url)
    );

    expect(payload).toContain('event: seed_created');
    expect(payload).toContain('event: seed_analysis_started');
    expect(payload).toContain('event: seed_analysis_completed');
  });
});
