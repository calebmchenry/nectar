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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-pipeline-events-'));
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

function parseEventNames(ssePayload: string): string[] {
  return ssePayload
    .split('\n')
    .filter((line) => line.startsWith('event: '))
    .map((line) => line.slice('event: '.length).trim());
}

function parseEventData<T>(ssePayload: string, eventName: string): T[] {
  const lines = ssePayload.split('\n');
  const results: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line !== `event: ${eventName}`) {
      continue;
    }
    const dataLine = lines[i + 1]?.trim();
    if (!dataLine?.startsWith('data: ')) {
      continue;
    }
    try {
      const parsed = JSON.parse(dataLine.slice('data: '.length)) as { event?: T };
      if (parsed.event) {
        results.push(parsed.event);
      }
    } catch {
      // ignore malformed test payload
    }
  }
  return results;
}

async function waitForTerminal(baseUrl: string, runId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const response = await fetch(`${baseUrl}/pipelines/${runId}`);
    const payload = (await response.json()) as { status: string };
    if (payload.status !== 'running') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Run '${runId}' did not finish in time.`);
}

describe('pipeline failure events', () => {
  it('emits stage_failed and pipeline_failed while preserving run_error/node_completed', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    const server = await boot(ws);
    if (!server) {
      return;
    }

    const failingDot = `digraph Failing {
      start [shape=Mdiamond]
      bad [shape=parallelogram, script="exit 42"]
      done [shape=Msquare]
      start -> bad
      bad -> done [label="failure"]
    }`;

    const createResponse = await fetch(`${server.base_url}/pipelines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dot_source: failingDot }),
    });

    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { run_id: string };

    await waitForTerminal(server.base_url, created.run_id);

    const eventsResponse = await fetch(`${server.base_url}/pipelines/${created.run_id}/events`);
    expect(eventsResponse.status).toBe(200);
    const eventsPayload = await eventsResponse.text();
    const eventNames = parseEventNames(eventsPayload);

    expect(eventNames).toContain('node_completed');
    expect(eventNames).toContain('stage_failed');
    expect(eventNames).toContain('pipeline_failed');
    expect(eventNames).toContain('run_error');

    const stageFailedIndex = eventNames.indexOf('stage_failed');
    const pipelineFailedIndex = eventNames.indexOf('pipeline_failed');
    const runErrorIndex = eventNames.indexOf('run_error');
    expect(stageFailedIndex).toBeGreaterThan(-1);
    expect(stageFailedIndex).toBeLessThan(pipelineFailedIndex);
    expect(pipelineFailedIndex).toBeLessThan(runErrorIndex);

    const pipelineFailedEvents = parseEventData<{
      failed_node_id: string;
      final_status: string;
      message: string;
    }>(eventsPayload, 'pipeline_failed');
    expect(pipelineFailedEvents.length).toBe(1);
    expect(pipelineFailedEvents[0]?.failed_node_id).toBe('bad');
    expect(pipelineFailedEvents[0]?.final_status).toBe('failed');
    expect(pipelineFailedEvents[0]?.message).toMatch(/failed/i);
  });
});
