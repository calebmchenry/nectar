import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-seed-run-linkage-'));
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

async function waitForStatus(baseUrl: string, runId: string, accepted: Set<string>, timeoutMs = 20_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/pipelines/${runId}`);
    const payload = (await response.json()) as { status: string };
    if (accepted.has(payload.status)) {
      return payload.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Run '${runId}' did not reach expected status in time.`);
}

async function waitForQuestion(baseUrl: string, runId: string, timeoutMs = 20_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/pipelines/${runId}/questions`);
    const payload = (await response.json()) as { questions: Array<{ question_id: string }> };
    if (payload.questions.length > 0) {
      return payload.questions[0]!.question_id;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`No question surfaced for run '${runId}'.`);
}

describe('seed run linkage integration', () => {
  it('tracks link -> run -> interrupt -> resume -> complete on filesystem', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    await writeFile(
      path.join(ws, 'gardens', 'seed-lifecycle.dot'),
      `digraph SeedLifecycle {
        start [shape=Mdiamond]
        approve [shape=hexagon, label="Continue?"]
        continue_work [shape=parallelogram, tool_command="echo continue"]
        stop_work [shape=parallelogram, tool_command="echo stop"]
        done [shape=Msquare]
        start -> approve
        approve -> continue_work [label="Yes"]
        approve -> stop_work [label="No"]
        continue_work -> done
        stop_work -> done
      }`,
      'utf8'
    );

    const server = await boot(ws);
    if (!server) {
      return;
    }

    const createSeedResponse = await fetch(`${server.base_url}/seeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Seed run lifecycle',
        body: 'Validate run linkage lifecycle.',
      }),
    });
    expect(createSeedResponse.status).toBe(201);
    const created = (await createSeedResponse.json()) as { seed: { id: number } };
    const seedId = created.seed.id;

    const linkResponse = await fetch(`${server.base_url}/seeds/${seedId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linked_gardens_add: ['gardens/seed-lifecycle.dot'] }),
    });
    expect(linkResponse.status).toBe(200);

    const runStartResponse = await fetch(`${server.base_url}/seeds/${seedId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(runStartResponse.status).toBe(202);
    const started = (await runStartResponse.json()) as { run_id: string };

    await waitForQuestion(server.base_url, started.run_id);

    const cancelResponse = await fetch(`${server.base_url}/pipelines/${started.run_id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(cancelResponse.status).toBe(200);
    expect(await waitForStatus(server.base_url, started.run_id, new Set(['interrupted']))).toBe('interrupted');

    const resumeResponse = await fetch(`${server.base_url}/seeds/${seedId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        run_id: started.run_id,
        garden_path: 'gardens/seed-lifecycle.dot',
      }),
    });
    expect(resumeResponse.status).toBe(202);

    const questionId = await waitForQuestion(server.base_url, started.run_id);
    const answerResponse = await fetch(`${server.base_url}/pipelines/${started.run_id}/questions/${questionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selected_label: 'Yes' }),
    });
    expect(answerResponse.status).toBe(200);
    expect(await waitForStatus(server.base_url, started.run_id, new Set(['completed']))).toBe('completed');

    const seedDirs = await readdir(path.join(ws, 'seedbed'));
    expect(seedDirs).toHaveLength(1);
    const seedDir = path.join(ws, 'seedbed', seedDirs[0]!);

    const metaRaw = await readFile(path.join(seedDir, 'meta.yaml'), 'utf8');
    const meta = parseYaml(metaRaw) as {
      status: string;
      linked_gardens: string[];
      linked_runs: string[];
    };
    expect(meta.linked_gardens).toContain('gardens/seed-lifecycle.dot');
    expect(meta.linked_runs[0]).toBe(started.run_id);
    expect(meta.status).toBe('blooming');

    const activityRaw = await readFile(path.join(seedDir, 'activity.jsonl'), 'utf8');
    const events = activityRaw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; run_id?: string });

    const runEvents = events.filter((event) => event.run_id === started.run_id).map((event) => event.type);
    expect(runEvents).toContain('run_started');
    expect(runEvents).toContain('run_interrupted');
    expect(runEvents).toContain('run_resumed');
    expect(runEvents).toContain('run_completed');
    expect(runEvents.filter((type) => type === 'run_started')).toHaveLength(1);
    expect(runEvents.filter((type) => type === 'run_interrupted')).toHaveLength(1);
    expect(runEvents.filter((type) => type === 'run_resumed')).toHaveLength(1);
    expect(runEvents.filter((type) => type === 'run_completed')).toHaveLength(1);
    expect(runEvents.indexOf('run_started')).toBeLessThan(runEvents.indexOf('run_interrupted'));
    expect(runEvents.indexOf('run_interrupted')).toBeLessThan(runEvents.indexOf('run_resumed'));
    expect(runEvents.indexOf('run_resumed')).toBeLessThan(runEvents.indexOf('run_completed'));
  });

  it('records run_failed exactly once for linked failing runs', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const ws = await workspace();
    await writeFile(
      path.join(ws, 'gardens', 'seed-failure.dot'),
      `digraph SeedFailure {
        start [shape=Mdiamond]
        fail_step [shape=parallelogram, tool_command="exit 42"]
        done [shape=Msquare]
        start -> fail_step
        fail_step -> done
      }`,
      'utf8',
    );

    const server = await boot(ws);
    if (!server) {
      return;
    }

    const createSeedResponse = await fetch(`${server.base_url}/seeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Seed run failure linkage',
        body: 'Validate run_failed linkage.',
      }),
    });
    expect(createSeedResponse.status).toBe(201);
    const created = (await createSeedResponse.json()) as { seed: { id: number } };
    const seedId = created.seed.id;

    const linkResponse = await fetch(`${server.base_url}/seeds/${seedId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linked_gardens_add: ['gardens/seed-failure.dot'] }),
    });
    expect(linkResponse.status).toBe(200);

    const runStartResponse = await fetch(`${server.base_url}/seeds/${seedId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(runStartResponse.status).toBe(202);
    const started = (await runStartResponse.json()) as { run_id: string };

    expect(await waitForStatus(server.base_url, started.run_id, new Set(['failed']))).toBe('failed');

    const seedDirs = await readdir(path.join(ws, 'seedbed'));
    expect(seedDirs).toHaveLength(1);
    const seedDir = path.join(ws, 'seedbed', seedDirs[0]!);

    const metaRaw = await readFile(path.join(seedDir, 'meta.yaml'), 'utf8');
    const meta = parseYaml(metaRaw) as { linked_runs: string[] };
    expect(meta.linked_runs).toEqual([started.run_id]);

    const activityRaw = await readFile(path.join(seedDir, 'activity.jsonl'), 'utf8');
    const events = activityRaw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; run_id?: string });

    const runEvents = events.filter((event) => event.run_id === started.run_id).map((event) => event.type);
    expect(runEvents.filter((type) => type === 'run_started')).toHaveLength(1);
    expect(runEvents.filter((type) => type === 'run_failed')).toHaveLength(1);
    expect(runEvents.indexOf('run_started')).toBeLessThan(runEvents.indexOf('run_failed'));
  });
});
