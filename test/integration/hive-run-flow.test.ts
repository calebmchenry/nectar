import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-hive-flow-'));
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

async function waitForStatus(baseUrl: string, runId: string, accepted: Set<string>, timeoutMs = 15_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/pipelines/${runId}`);
    const payload = (await response.json()) as { status: string };
    if (accepted.has(payload.status)) {
      return payload.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Run '${runId}' did not reach expected status.`);
}

async function waitForQuestion(baseUrl: string, runId: string, timeoutMs = 15_000): Promise<{ question_id: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/pipelines/${runId}/questions`);
    const payload = (await response.json()) as { questions: Array<{ question_id: string }> };
    if (payload.questions.length > 0) {
      return payload.questions[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`No pending question found for run '${runId}'.`);
}

function parseEventIds(payload: string): number[] {
  return payload
    .split('\n')
    .filter((line) => line.startsWith('id: '))
    .map((line) => Number.parseInt(line.slice(4), 10))
    .filter((value) => Number.isInteger(value));
}

describe('hive run flow integration', () => {
  it('covers preview/save/run/question/cancel/resume/replay flow over HTTP', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const dotSource = `digraph HiveFlow {
      start [shape=Mdiamond]
      approve [shape=hexagon, label="Ship this change?"]
      yes_exit [shape=Msquare]
      no_exit [shape=Msquare]
      start -> approve
      approve -> yes_exit [label="Yes"]
      approve -> no_exit [label="No"]
    }`;

    const previewResponse = await fetch(`${server.base_url}/gardens/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: dotSource }),
    });
    expect(previewResponse.status).toBe(200);
    const previewPayload = (await previewResponse.json()) as { parse_ok: boolean; svg?: string };
    expect(previewPayload.parse_ok).toBe(true);
    expect(previewPayload.svg).toContain('<svg');

    await writeFile(path.join(ws, 'gardens', 'hive-flow.dot'), dotSource, 'utf8');

    const createResponse = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_path: 'gardens/hive-flow.dot' }),
    });
    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { run_id: string };

    const firstQuestion = await waitForQuestion(server.base_url, created.run_id);
    expect(firstQuestion.question_id).toBeTruthy();

    const cancelResponse = await fetch(`${server.base_url}/pipelines/${created.run_id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(cancelResponse.status).toBe(200);
    const interrupted = await waitForStatus(server.base_url, created.run_id, new Set(['interrupted']));
    expect(interrupted).toBe('interrupted');

    const resumeResponse = await fetch(`${server.base_url}/pipelines/${created.run_id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resumeResponse.status).toBe(202);

    const resumedQuestion = await waitForQuestion(server.base_url, created.run_id);
    const answerResponse = await fetch(
      `${server.base_url}/pipelines/${created.run_id}/questions/${resumedQuestion.question_id}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selected_label: 'Yes' }),
      }
    );
    expect(answerResponse.status).toBe(200);

    const finalStatus = await waitForStatus(server.base_url, created.run_id, new Set(['completed']));
    expect(finalStatus).toBe('completed');

    const eventsResponse = await fetch(`${server.base_url}/pipelines/${created.run_id}/events`);
    expect(eventsResponse.status).toBe(200);
    const eventsPayload = await eventsResponse.text();
    const eventIds = parseEventIds(eventsPayload);
    expect(eventIds.length).toBeGreaterThan(3);

    const replayFrom = eventIds[0]!;
    const replayResponse = await fetch(`${server.base_url}/pipelines/${created.run_id}/events`, {
      headers: { 'Last-Event-ID': String(replayFrom) },
    });
    const replayPayload = await replayResponse.text();
    const replayIds = parseEventIds(replayPayload);
    expect(replayIds.every((id) => id > replayFrom)).toBe(true);
  });
});
