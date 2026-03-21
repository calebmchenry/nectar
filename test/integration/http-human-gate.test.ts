import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-http-human-'));
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

async function waitForQuestion(baseUrl: string, runId: string, timeoutMs = 10_000): Promise<{ question_id: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${baseUrl}/pipelines/${runId}/questions`);
    const body = (await res.json()) as { questions: Array<{ question_id: string }> };
    if (body.questions.length > 0) {
      return body.questions[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No pending question found for run '${runId}'`);
}

async function waitForTerminal(baseUrl: string, runId: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${baseUrl}/pipelines/${runId}`);
    const body = (await res.json()) as { status: string };
    if (body.status !== 'running') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run '${runId}' did not finish within ${timeoutMs}ms`);
}

describe('HTTP human gate flow', () => {
  it('lists pending questions and resumes run after answer submission', async () => {
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
      approval [shape=hexagon, label="Choose deployment action"]
      approve_exit [shape=Msquare]
      reject_exit [shape=Msquare]
      start -> approval
      approval -> approve_exit [label="Approve"]
      approval -> reject_exit [label="Reject"]
    }`;

    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: dotSource }),
    });
    const created = (await createRes.json()) as { run_id: string };

    const question = await waitForQuestion(server.base_url, created.run_id);
    const questionPath = path.join(ws, '.nectar', 'cocoons', created.run_id, 'questions', `${question.question_id}.json`);
    const persistedPending = await readFile(questionPath, 'utf8');
    expect(persistedPending).toContain('"status": "pending"');

    const answerRes = await fetch(
      `${server.base_url}/pipelines/${created.run_id}/questions/${question.question_id}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'Reject' }),
      }
    );
    expect(answerRes.status).toBe(200);

    await waitForTerminal(server.base_url, created.run_id);

    const checkpointRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/checkpoint`);
    const checkpoint = (await checkpointRes.json()) as {
      completed_nodes: Array<{ node_id: string }>;
    };
    expect(checkpoint.completed_nodes.some((node) => node.node_id === 'reject_exit')).toBe(true);
  });
});
