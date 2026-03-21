import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineEngine } from '../../src/engine/engine.js';
import { parseGardenSource } from '../../src/garden/parse.js';
import { QueueInterviewer } from '../../src/interviewer/queue.js';
import type { RunEvent } from '../../src/engine/events.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-interview-events-'));
  tempDirs.push(dir);
  return dir;
}

function graphSource(): string {
  return `digraph G {
    start [shape=Mdiamond]
    gate [shape=hexagon, label="Approve?"]
    yes [shape=Msquare]
    no [shape=Msquare]
    start -> gate
    gate -> yes [label="Yes"]
    gate -> no [label="No"]
  }`;
}

describe('wait-human interview lifecycle events', () => {
  it('emits interview_started and interview_completed', async () => {
    const graph = parseGardenSource(graphSource(), '/tmp/interview.dot');
    const events: RunEvent[] = [];
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'hash',
      workspace_root: await workspace(),
      interviewer: new QueueInterviewer([{ selected_label: 'Yes', source: 'queue' }]),
    });
    engine.onEvent((event) => events.push(event));

    const result = await engine.run();
    expect(result.status).toBe('completed');

    const started = events.find((event) => event.type === 'interview_started');
    expect(started).toBeTruthy();
    if (started?.type === 'interview_started') {
      expect(started.question_id.length).toBeGreaterThan(0);
      expect(started.question_text).toContain('Approve');
    }

    const completed = events.find((event) => event.type === 'interview_completed');
    expect(completed).toBeTruthy();
    if (completed?.type === 'interview_completed') {
      expect(completed.answer).toBe('Yes');
      expect(completed.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('emits interview_timeout when answer source is timeout', async () => {
    const graph = parseGardenSource(graphSource(), '/tmp/interview-timeout.dot');
    const events: RunEvent[] = [];
    const engine = new PipelineEngine({
      graph,
      graph_hash: 'hash',
      workspace_root: await workspace(),
      interviewer: new QueueInterviewer([{ selected_label: 'No', source: 'timeout' }]),
    });
    engine.onEvent((event) => events.push(event));

    const result = await engine.run();
    expect(result.status).toBe('completed');
    expect(events.some((event) => event.type === 'interview_timeout')).toBe(true);
  });
});
