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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-garden-draft-'));
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

function parseSseEventNames(payload: string): string[] {
  return payload
    .split('\n')
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice('event:'.length).trim());
}

describe('garden draft endpoint', () => {
  it('streams draft_start, content_delta, and draft_complete events', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const response = await fetch(`${server.base_url}/gardens/draft`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hive-tab-id': 'test-tab',
      },
      body: JSON.stringify({
        prompt: 'Create a plan, implement, and test workflow.',
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.text();
    const events = parseSseEventNames(payload);
    expect(events).toContain('draft_start');
    expect(events).toContain('content_delta');
    expect(events).toContain('draft_complete');
    expect(events).not.toContain('draft_error');
    const terminalEvents = events.filter((name) => name === 'draft_complete' || name === 'draft_error');
    expect(terminalEvents).toHaveLength(1);
    expect(payload).toContain('digraph Drafted');
  });

  it('surfaces request validation errors', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const response = await fetch(`${server.base_url}/gardens/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code?: string; error?: string };
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.error).toMatch(/prompt is required/i);
  });
});
