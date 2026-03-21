import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventJournal } from '../../src/server/event-journal.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-event-journal-'));
  tempDirs.push(dir);
  return dir;
}

describe('EventJournal', () => {
  it('appends and replays events with monotonic sequence numbers', async () => {
    const dir = await createTempDir();
    const journal = await EventJournal.open(path.join(dir, 'events.ndjson'));

    const e1 = await journal.append({
      type: 'run_started',
      run_id: 'run-1',
      dot_file: 'a.dot',
      started_at: new Date().toISOString(),
    });
    const e2 = await journal.append({
      type: 'run_completed',
      run_id: 'run-1',
      completed_at: new Date().toISOString(),
      duration_ms: 12,
      completed_nodes: 2,
    });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);

    const replayed: number[] = [];
    await journal.replay({
      from_seq: 1,
      on_envelope: (envelope) => {
        replayed.push(envelope.seq);
      },
    });
    expect(replayed).toEqual([2]);
  });
});
