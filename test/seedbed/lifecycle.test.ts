import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SeedActivityStore } from '../../src/seedbed/activity.js';
import { SeedLifecycleService } from '../../src/seedbed/lifecycle.js';
import { workspacePathsFromRoot, type WorkspacePaths } from '../../src/seedbed/paths.js';
import { SeedStore } from '../../src/seedbed/store.js';

let tmpDir = '';
let ws: WorkspacePaths;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nectar-seed-lifecycle-'));
  ws = workspacePathsFromRoot(tmpDir);
  await mkdir(ws.seedbed, { recursive: true });
  await mkdir(ws.honey, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SeedLifecycleService', () => {
  it('links and unlinks gardens while recording activity', async () => {
    const store = new SeedStore(ws);
    const activity = new SeedActivityStore(ws);
    const lifecycle = new SeedLifecycleService(store, activity);
    const seed = await store.create({ body: 'Link test seed' });

    await lifecycle.linkGarden(seed.id, 'gardens/alpha.dot');
    await lifecycle.linkGarden(seed.id, 'gardens/alpha.dot');
    await lifecycle.unlinkGarden(seed.id, 'gardens/alpha.dot');

    const updated = await store.get(seed.id);
    expect(updated?.meta.linked_gardens).toEqual([]);

    const events = await activity.list(seed.id, { limit: 10 });
    expect(events.filter((event) => event.type === 'garden_linked')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'garden_unlinked')).toHaveLength(1);
  });

  it('auto-promotes seedling/sprouting to blooming and caps linked run history', async () => {
    const store = new SeedStore(ws);
    const activity = new SeedActivityStore(ws);
    const lifecycle = new SeedLifecycleService(store, activity);
    const created = await store.create({ body: 'Run attach seed' });
    await store.patch(created.id, { status: 'sprouting' });

    await lifecycle.attachRun(created.id, 'run-001', 'gardens/alpha.dot', 'seedbed', 'start');

    for (let index = 2; index <= 30; index += 1) {
      await lifecycle.attachRun(
        created.id,
        `run-${String(index).padStart(3, '0')}`,
        'gardens/alpha.dot',
        'seedbed',
        'start',
      );
    }

    const updated = await store.get(created.id);
    expect(updated?.meta.status).toBe('blooming');
    expect(updated?.meta.linked_runs.length).toBe(25);
    expect(updated?.meta.linked_runs[0]).toBe('run-030');
    expect(updated?.meta.linked_runs.at(-1)).toBe('run-006');
  });

  it('does not auto-override manual honey status on run attach', async () => {
    const store = new SeedStore(ws);
    const activity = new SeedActivityStore(ws);
    const lifecycle = new SeedLifecycleService(store, activity);
    const created = await store.create({ body: 'Honey status seed' });
    await store.patch(created.id, { status: 'honey' });

    await lifecycle.attachRun(created.id, 'run-001', 'gardens/alpha.dot', 'seedbed', 'resume');
    const updated = await store.get(created.id);
    expect(updated?.meta.status).toBe('honey');
  });

  it('computes honey suggestion from latest completed linked run only', async () => {
    const store = new SeedStore(ws);
    const activity = new SeedActivityStore(ws);
    const lifecycle = new SeedLifecycleService(store, activity);
    const created = await store.create({ body: 'Suggestion seed' });

    const suggestion = lifecycle.computeStatusSuggestion(created, [
      { run_id: 'run-1', status: 'completed' },
      { run_id: 'run-0', status: 'failed' },
    ]);
    expect(suggestion?.suggested_status).toBe('honey');
    expect(suggestion?.based_on_run_id).toBe('run-1');

    await store.patch(created.id, { status: 'wilted' });
    const wilted = await store.get(created.id);
    const none = lifecycle.computeStatusSuggestion(wilted!.meta, [{ run_id: 'run-2', status: 'completed' }]);
    expect(none).toBeNull();
  });

  it('records run transition events with failure details', async () => {
    const store = new SeedStore(ws);
    const activity = new SeedActivityStore(ws);
    const lifecycle = new SeedLifecycleService(store, activity);
    const created = await store.create({ body: 'Transition seed' });

    await lifecycle.recordRunTransition(created.id, {
      run_id: 'run-1',
      transition: 'run_failed',
      message: 'Boom',
      garden: 'gardens/alpha.dot',
      launch_origin: 'seedbed',
    });

    const events = await activity.list(created.id, { limit: 10 });
    expect(events[0]?.type).toBe('run_failed');
    expect(events[0]).toMatchObject({
      run_id: 'run-1',
      message: 'Boom',
    });
  });
});
