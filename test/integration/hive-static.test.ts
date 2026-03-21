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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-hive-static-'));
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

describe('hive static serving', () => {
  it('serves the Hive shell and embedded assets from the same origin', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const indexResponse = await fetch(`${server.base_url}/`);
    expect(indexResponse.status).toBe(200);
    const indexHtml = await indexResponse.text();
    expect(indexHtml).toContain('<div id="app">');

    const assetMatch = indexHtml.match(/(?:src|href)="(\/assets\/[^"]+)"/);
    expect(assetMatch).not.toBeNull();

    const assetPath = assetMatch![1];
    const assetResponse = await fetch(`${server.base_url}${assetPath}`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toMatch(/text\/|javascript|css|image\//);

    const fallbackResponse = await fetch(`${server.base_url}/hive/workbench`, {
      headers: { accept: 'text/html' },
    });
    expect(fallbackResponse.status).toBe(200);
    const fallbackHtml = await fallbackResponse.text();
    expect(fallbackHtml).toContain('<div id="app">');
  });
});
