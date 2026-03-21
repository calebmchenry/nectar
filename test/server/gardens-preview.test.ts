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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-garden-preview-'));
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

describe('garden preview endpoint', () => {
  it('returns SVG and metadata for a valid unsaved DOT buffer', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const dotSource = `digraph Preview {
      start [shape=Mdiamond]
      step [shape=parallelogram, script="echo hi"]
      done [shape=Msquare]
      start -> step -> done
    }`;

    const response = await fetch(`${server.base_url}/gardens/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: dotSource }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      parse_ok: boolean;
      valid: boolean;
      metadata: { node_count: number; edge_count: number };
      diagnostics: Array<{ severity: string }>;
      svg?: string;
    };

    expect(payload.parse_ok).toBe(true);
    expect(payload.valid).toBe(true);
    expect(payload.metadata.node_count).toBe(3);
    expect(payload.metadata.edge_count).toBe(2);
    expect(payload.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(0);
    expect(payload.svg).toContain('<svg');
  });

  it('previews composed graphs with prepared node and edge counts', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    await mkdir(path.join(ws, 'gardens', 'lib'), { recursive: true });
    await writeFile(
      path.join(ws, 'gardens', 'lib', 'review-loop.dot'),
      `digraph ReviewLoop {
        c_start [shape=Mdiamond]
        draft [shape=box, prompt="Draft"]
        c_done [shape=Msquare]
        c_start -> draft -> c_done
      }`,
      'utf8',
    );

    const server = await boot(ws);
    if (!server) {
      return;
    }

    const dotSource = `digraph ModularPreview {
      start [shape=Mdiamond]
      review_loop [shape=component, "compose.dotfile"="lib/review-loop.dot"]
      done [shape=Msquare]
      start -> review_loop -> done
    }`;

    const response = await fetch(`${server.base_url}/gardens/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dot_source: dotSource,
        dot_path: path.join(ws, 'gardens', 'modular-preview.dot'),
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      parse_ok: boolean;
      valid: boolean;
      metadata: { node_count: number; edge_count: number };
      diagnostics: Array<{ severity: string }>;
      svg?: string;
    };

    expect(payload.parse_ok).toBe(true);
    expect(payload.valid).toBe(true);
    expect(payload.metadata.node_count).toBe(5);
    expect(payload.metadata.edge_count).toBe(4);
    expect(payload.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(0);
    expect(payload.svg).toContain('review_loop__draft');
  });

  it('returns parse diagnostics for invalid DOT without throwing HTTP errors', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const response = await fetch(`${server.base_url}/gardens/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: 'digraph {' }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      parse_ok: boolean;
      valid: boolean;
      metadata: { node_count: number; edge_count: number };
      diagnostics: Array<{ code: string; severity: string }>;
      svg?: string;
    };

    expect(payload.parse_ok).toBe(false);
    expect(payload.valid).toBe(false);
    expect(payload.metadata.node_count).toBe(0);
    expect(payload.metadata.edge_count).toBe(0);
    expect(payload.diagnostics.some((diagnostic) => diagnostic.code === 'DOT_PARSE_ERROR')).toBe(true);
    expect(payload.svg).toBeUndefined();
  });
});
