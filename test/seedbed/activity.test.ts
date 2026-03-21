import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SeedActivityStore } from '../../src/seedbed/activity.js';
import { workspacePathsFromRoot, type WorkspacePaths } from '../../src/seedbed/paths.js';
import { SeedStore } from '../../src/seedbed/store.js';

let tmpDir = '';
let ws: WorkspacePaths;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nectar-seed-activity-'));
  ws = workspacePathsFromRoot(tmpDir);
  await mkdir(ws.seedbed, { recursive: true });
  await mkdir(ws.honey, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SeedActivityStore', () => {
  it('appends events and lists newest-first', async () => {
    const seedStore = new SeedStore(ws);
    const activity = new SeedActivityStore(ws);
    const seed = await seedStore.create({ body: 'Seed for activity tests' });

    await activity.append(seed.id, {
      type: 'seed_created',
      actor: 'user',
      title: seed.title,
      status: seed.status,
      priority: seed.priority,
      timestamp: '2026-03-20T10:00:00.000Z',
    });
    await activity.append(seed.id, {
      type: 'run_started',
      actor: 'system',
      run_id: 'run-1',
      garden: 'gardens/demo.dot',
      launch_origin: 'seedbed',
      timestamp: '2026-03-20T10:01:00.000Z',
    });

    const listed = await activity.list(seed.id);
    expect(listed).toHaveLength(2);
    expect(listed[0]?.type).toBe('run_started');
    expect(listed[1]?.type).toBe('seed_created');
  });

  it('skips malformed activity lines instead of crashing', async () => {
    const seedStore = new SeedStore(ws);
    const activity = new SeedActivityStore(ws);
    const seed = await seedStore.create({ body: 'Corruption test seed' });
    const listed = await seedStore.list();
    const seedDir = listed.find((entry) => entry.meta.id === seed.id)?.dirPath;
    expect(seedDir).toBeTruthy();

    await writeFile(
      path.join(seedDir!, 'activity.jsonl'),
      [
        '{"timestamp":"2026-03-20T10:00:00.000Z","seed_id":1,"actor":"user","type":"seed_created","title":"x","status":"seedling","priority":"normal"}',
        'not-json',
        '{"timestamp":"2026-03-20T10:00:05.000Z","seed_id":1,"actor":"system","type":"run_started","run_id":"run-1"}',
      ].join('\n'),
      'utf8'
    );

    const events = await activity.list(seed.id);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(['run_started', 'seed_created']);
  });

  it('aggregates workspace activity across seedbed and honey', async () => {
    const seedStore = new SeedStore(ws);
    const activity = new SeedActivityStore(ws);
    const first = await seedStore.create({ body: 'Seed A' });
    const second = await seedStore.create({ body: 'Seed B' });
    await seedStore.patch(second.id, { status: 'honey' });

    await activity.append(first.id, {
      type: 'seed_created',
      actor: 'user',
      title: first.title,
      status: first.status,
      priority: first.priority,
      timestamp: '2026-03-20T10:00:00.000Z',
    });
    await activity.append(second.id, {
      type: 'seed_created',
      actor: 'user',
      title: second.title,
      status: second.status,
      priority: second.priority,
      timestamp: '2026-03-20T10:02:00.000Z',
    });

    const workspaceEvents = await activity.listWorkspace({ limit: 10 });
    expect(workspaceEvents).toHaveLength(2);
    expect(workspaceEvents[0]?.seed_id).toBe(second.id);
    expect(workspaceEvents[1]?.seed_id).toBe(first.id);
  });
});
