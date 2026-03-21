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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-http-resume-'));
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

async function waitForStatus(baseUrl: string, runId: string, target: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${baseUrl}/pipelines/${runId}`);
    const body = (await res.json()) as { status: string };
    if (body.status === target) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run '${runId}' did not reach status '${target}' within ${timeoutMs}ms`);
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
  throw new Error(`Run '${runId}' did not expose a pending question within ${timeoutMs}ms`);
}

describe('HTTP cancel and resume flow', () => {
  it('cancels a wait.human run, resumes with a fresh question, and rejects stale answers', async () => {
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
      approval [shape=hexagon, label="Deploy?"]
      deploy [shape=parallelogram, tool_command="echo deploy"]
      reject [shape=parallelogram, tool_command="echo reject"]
      done [shape=Msquare]
      start -> approval
      approval -> deploy [label="Yes"]
      approval -> reject [label="No"]
      deploy -> done
      reject -> done
    }`;

    const createRes = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: dotSource }),
    });
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as { run_id: string };

    const firstQuestion = await waitForQuestion(server.base_url, created.run_id);

    const cancelRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/cancel`, { method: 'POST' });
    expect(cancelRes.status).toBe(200);
    const cancelled = (await cancelRes.json()) as { status: string };
    expect(cancelled.status).toBe('interrupted');

    const checkpointRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/checkpoint`);
    const checkpoint = (await checkpointRes.json()) as { interruption_reason?: string };
    expect(checkpoint.interruption_reason).toBe('api_cancel');

    const pendingAfterCancelRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/questions`);
    const pendingAfterCancel = (await pendingAfterCancelRes.json()) as { questions: Array<{ question_id: string }> };
    expect(pendingAfterCancel.questions).toHaveLength(0);

    const resumeRes = await fetch(`${server.base_url}/pipelines/${created.run_id}/resume`, { method: 'POST' });
    expect(resumeRes.status).toBe(202);

    const resumedQuestion = await waitForQuestion(server.base_url, created.run_id);
    expect(resumedQuestion.question_id).not.toBe(firstQuestion.question_id);

    const staleAnswerRes = await fetch(
      `${server.base_url}/pipelines/${created.run_id}/questions/${firstQuestion.question_id}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selected_label: 'Yes' }),
      },
    );
    expect(staleAnswerRes.status).toBe(409);

    const answerRes = await fetch(
      `${server.base_url}/pipelines/${created.run_id}/questions/${resumedQuestion.question_id}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selected_label: 'Yes' }),
      },
    );
    expect(answerRes.status).toBe(200);

    await waitForStatus(server.base_url, created.run_id, 'completed', 15_000);
  });
});
