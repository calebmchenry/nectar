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

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-fan-in-llm-'));
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
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Run '${runId}' did not finish in time.`);
}

describe('prompted fan-in integration', () => {
  it('persists selected branch and rationale in context and artifacts', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const source = `digraph FanInLlm {
      start [shape=Mdiamond]
      fan_out [shape=component]
      branch_a [shape=parallelogram, script="echo branch_a"]
      branch_b [shape=parallelogram, script="echo branch_b"]
      fan_in [shape=tripleoctagon, prompt="Choose the branch that is most production-ready."]
      done [shape=Msquare]

      start -> fan_out
      fan_out -> branch_a
      fan_out -> branch_b
      branch_a -> fan_in
      branch_b -> fan_in
      fan_in -> done
    }`;

    await writeFile(path.join(ws, 'gardens', 'fan-in-llm.dot'), source, 'utf8');

    const createResponse = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_path: 'gardens/fan-in-llm.dot' }),
    });
    expect(createResponse.status).toBe(202);

    const created = (await createResponse.json()) as { run_id: string };
    const finalStatus = await waitForTerminal(server.base_url, created.run_id);
    expect(finalStatus).toBe('completed');

    const contextResponse = await fetch(`${server.base_url}/pipelines/${created.run_id}/context`);
    expect(contextResponse.status).toBe(200);
    const contextPayload = (await contextResponse.json()) as { context: Record<string, string> };

    expect(['branch_a', 'branch_b']).toContain(contextPayload.context['parallel.fan_in.best_id']);
    expect(contextPayload.context['parallel.fan_in.best_outcome']).toBe('success');
    expect(contextPayload.context['parallel.fan_in.rationale']).toBeDefined();

    const artifactPath = path.join(
      ws,
      '.nectar',
      'cocoons',
      created.run_id,
      'fan_in',
      'fan-in-evaluation.response.json'
    );
    const artifact = await readFile(artifactPath, 'utf8');
    expect(artifact).toContain('selected_branch_id');
  });

  it('allows downstream routing on context.fan_in_selected_status when prompted fan-in selects a failed branch', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const source = `digraph FanInRouting {
      start [shape=Mdiamond]
      fan_out [shape=component]
      ok_branch [shape=parallelogram, script="echo ok"]
      failed_branch [shape=parallelogram, script="exit 1"]
      fan_in [shape=tripleoctagon, prompt="Select the branch to proceed with."]
      route [shape=diamond]
      done [shape=Msquare]

      start -> fan_out
      fan_out -> failed_branch
      fan_out -> ok_branch
      ok_branch -> fan_in
      failed_branch -> fan_in
      fan_in -> route
      route -> done [condition="context.fan_in_selected_status=failure"]
      route -> done
    }`;

    await writeFile(path.join(ws, 'gardens', 'fan-in-routing.dot'), source, 'utf8');

    const createResponse = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_path: 'gardens/fan-in-routing.dot' }),
    });
    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { run_id: string };

    const finalStatus = await waitForTerminal(server.base_url, created.run_id);
    expect(finalStatus).toBe('completed');

    const contextResponse = await fetch(`${server.base_url}/pipelines/${created.run_id}/context`);
    expect(contextResponse.status).toBe(200);
    const contextPayload = (await contextResponse.json()) as { context: Record<string, string> };
    expect(['success', 'failure']).toContain(contextPayload.context['fan_in_selected_status']);
    expect(['success', 'failure']).toContain(contextPayload.context['parallel.fan_in.best_outcome']);

    const checkpointResponse = await fetch(`${server.base_url}/pipelines/${created.run_id}/checkpoint`);
    expect(checkpointResponse.status).toBe(200);
    const checkpoint = (await checkpointResponse.json()) as { completed_nodes: Array<{ node_id: string }> };
    expect(checkpoint.completed_nodes.some((node) => node.node_id === 'done')).toBe(true);
  });
});
