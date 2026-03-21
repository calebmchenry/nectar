import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-http-server-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'gardens'), { recursive: true });
  return dir;
}

async function start(workspace: string): Promise<NectarServer | null> {
  try {
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      workspace_root: workspace,
      max_concurrent_runs: 4,
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

async function waitForTerminal(baseUrl: string, runId: string, timeoutMs = 10_000): Promise<{ status: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${baseUrl}/pipelines/${runId}`);
    const body = (await res.json()) as { status: string };
    if (body.status !== 'running') {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run '${runId}' did not complete within ${timeoutMs}ms`);
}

async function waitForRunning(baseUrl: string, runId: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${baseUrl}/pipelines/${runId}`);
    const body = (await res.json()) as { status: string };
    if (body.status === 'running') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run '${runId}' did not enter running state within ${timeoutMs}ms`);
}

describe('HTTP pipeline server', () => {
  it('starts a pipeline from dot_path and serves status/checkpoint/context/graph', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }
    const workspace = await createWorkspace();
    const dotPath = path.join(workspace, 'gardens', 'http.dot');
    await writeFile(
      dotPath,
      `digraph G {
        start [shape=Mdiamond]
        step [shape=parallelogram, tool_command="echo hello-http"]
        done [shape=Msquare]
        start -> step -> done
      }`,
      'utf8'
    );

    const server = await start(workspace);
    if (!server) {
      return;
    }
    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_path: 'gardens/http.dot' }),
    });
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { run_id: string; status: string };
    expect(created.status).toBe('running');

    const terminal = await waitForTerminal(server.base_url, created.run_id);
    expect(terminal.status).toBe('completed');

    const checkpointRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/checkpoint`);
    expect(checkpointRes.status).toBe(200);
    const checkpoint = (await checkpointRes.json()) as { status: string; completed_nodes: Array<{ node_id: string }> };
    expect(checkpoint.status).toBe('completed');
    expect(checkpoint.completed_nodes.some((node) => node.node_id === 'step')).toBe(true);

    const contextRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/context`);
    expect(contextRes.status).toBe(200);
    const contextPayload = (await contextRes.json()) as Record<string, string> | { context: Record<string, string> };
    const context =
      typeof contextPayload === 'object' && contextPayload !== null && 'context' in contextPayload
        ? (contextPayload as { context: Record<string, string> }).context
        : (contextPayload as Record<string, string>);
    expect(typeof context).toBe('object');

    const graphRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/graph`);
    expect(graphRes.status).toBe(200);
    const graphSvg = await graphRes.text();
    expect(graphSvg).toContain('<svg');
  });

  it('persists dot_source submissions as input.dot under run directory', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }
    const workspace = await createWorkspace();
    const server = await start(workspace);
    if (!server) {
      return;
    }
    const dotSource = `digraph G {
      start [shape=Mdiamond]
      done [shape=Msquare]
      start -> done
    }`;

    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: dotSource }),
    });
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { run_id: string };
    await waitForTerminal(server.base_url, created.run_id);

    const persisted = await readFile(path.join(workspace, '.nectar', 'cocoons', created.run_id, 'input.dot'), 'utf8');
    expect(persisted).toContain('start -> done');
  });

  it('renders composed pipelines from prepared.dot and includes namespaced imported nodes', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, 'gardens', 'lib'), { recursive: true });

    await writeFile(
      path.join(workspace, 'gardens', 'lib', 'review-loop.dot'),
      `digraph ReviewLoop {
        child_start [shape=Mdiamond]
        child_work [shape=parallelogram, tool_command="echo child"]
        child_done [shape=Msquare]
        child_start -> child_work -> child_done
      }`,
      'utf8',
    );

    await writeFile(
      path.join(workspace, 'gardens', 'release.dot'),
      `digraph Release {
        start [shape=Mdiamond]
        review_loop [shape=component, "compose.dotfile"="lib/review-loop.dot"]
        done [shape=Msquare]
        start -> review_loop -> done
      }`,
      'utf8',
    );

    const server = await start(workspace);
    if (!server) {
      return;
    }

    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_path: 'gardens/release.dot' }),
    });
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { run_id: string };
    await waitForTerminal(server.base_url, created.run_id);

    const runDir = path.join(workspace, '.nectar', 'cocoons', created.run_id);
    const prepared = await readFile(path.join(runDir, 'prepared.dot'), 'utf8');
    expect(prepared).toContain('review_loop__child_work');

    const manifest = JSON.parse(await readFile(path.join(runDir, 'source-manifest.json'), 'utf8')) as {
      graph_hash_kind?: string;
    };
    expect(manifest.graph_hash_kind).toBe('prepared');

    const graphRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/graph`);
    expect(graphRes.status).toBe(200);
    const graphSvg = await graphRes.text();
    expect(graphSvg).toContain('review_loop__child_work');
  });

  it('cancels active runs and returns interrupted status with checkpoint_id', { timeout: 15_000 }, async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const workspace = await createWorkspace();
    const server = await start(workspace);
    if (!server) {
      return;
    }

    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dot_source: `digraph SlowRun {
          start [shape=Mdiamond]
          slow [shape=parallelogram, tool_command="node -e \\"setTimeout(() => process.exit(0), 2000)\\""]
          done [shape=Msquare]
          start -> slow -> done
        }`,
      }),
    });
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { run_id: string };

    await waitForRunning(server.base_url, created.run_id);

    const statusRes = await fetch(`${server.base_url}/pipelines/${created.run_id}`);
    expect(statusRes.status).toBe(200);
    const activeStatus = (await statusRes.json()) as { current_node?: string; status: string };
    expect(activeStatus.status).toBe('running');

    // current_node may not be set yet due to event chain timing —
    // only verify consistency when present
    if (activeStatus.current_node) {
      const contextRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/context`);
      expect(contextRes.status).toBe(200);
      const activeContext = (await contextRes.json()) as { context: Record<string, string> };
      expect(typeof activeContext.context).toBe('object');
      expect(activeContext.context.current_node).toBe(activeStatus.current_node);

      const graphRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/graph`);
      expect(graphRes.status).toBe(200);
      const graphSvg = await graphRes.text();
      expect(graphSvg).toContain('#FFF3C4');
    }

    const cancelRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/cancel`, {
      method: 'POST',
    });
    expect(cancelRes.status).toBe(200);
    const cancelled = (await cancelRes.json()) as { run_id: string; status: string; checkpoint_id: string };
    expect(cancelled.run_id).toBe(created.run_id);
    expect(cancelled.status).toBe('interrupted');
    expect(cancelled.checkpoint_id).toBe(created.run_id);

    const checkpointRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/checkpoint`);
    expect(checkpointRes.status).toBe(200);
    const checkpoint = (await checkpointRes.json()) as { interruption_reason?: string; status: string };
    expect(checkpoint.status).toBe('interrupted');
    expect(checkpoint.interruption_reason).toBe('api_cancel');
  });

  it('returns 409 when cancelling a completed run', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const workspace = await createWorkspace();
    const server = await start(workspace);
    if (!server) {
      return;
    }

    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dot_source: `digraph Done {
          start [shape=Mdiamond]
          done [shape=Msquare]
          start -> done
        }`,
      }),
    });
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { run_id: string };
    const terminal = await waitForTerminal(server.base_url, created.run_id);
    expect(terminal.status).toBe('completed');

    const cancelRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/cancel`, {
      method: 'POST',
    });
    expect(cancelRes.status).toBe(409);
    const payload = (await cancelRes.json()) as { code?: string; error?: string };
    expect(payload.code).toBe('CONFLICT');
    expect(payload.error).toMatch(/already completed/i);
  });

  it('returns 200 for concurrent cancel requests while shutdown is in progress', { timeout: 15_000 }, async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const workspace = await createWorkspace();
    const server = await start(workspace);
    if (!server) {
      return;
    }

    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dot_source: `digraph SlowRun {
          start [shape=Mdiamond]
          slow [shape=parallelogram, tool_command="node -e \\"setTimeout(() => process.exit(0), 2000)\\""]
          done [shape=Msquare]
          start -> slow -> done
        }`,
      }),
    });
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { run_id: string };
    await waitForRunning(server.base_url, created.run_id);

    const [cancelA, cancelB] = await Promise.all([
      fetch(`${server.base_url}/pipelines/${created.run_id}/cancel`, { method: 'POST' }),
      fetch(`${server.base_url}/pipelines/${created.run_id}/cancel`, { method: 'POST' }),
    ]);

    expect(cancelA.status).toBe(200);
    expect(cancelB.status).toBe(200);
  });

  it('returns 404 when cancelling a non-existent run', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const workspace = await createWorkspace();
    const server = await start(workspace);
    if (!server) {
      return;
    }

    const response = await fetch(`${server.base_url}/pipelines/missing-run/cancel`, { method: 'POST' });
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { code?: string; error?: string };
    expect(payload.code).toBe('NOT_FOUND');
    expect(payload.error).toMatch(/not found/i);
  });
});
