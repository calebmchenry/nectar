import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QuestionStore } from '../../src/server/question-store.js';
import type { Question } from '../../src/interviewer/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function runDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-question-store-'));
  tempDirs.push(dir);
  return dir;
}

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    type: 'MULTIPLE_CHOICE',
    text: 'Proceed?',
    choices: [
      { label: 'Yes', edge_target: 'yes' },
      { label: 'No', edge_target: 'no' },
    ],
    node_id: 'gate',
    run_id: 'run-1',
    ...overrides,
  };
}

describe('QuestionStore', () => {
  it('marks pending questions as interrupted on close and rejects stale answers', async () => {
    const dir = await runDir();
    const store = new QuestionStore(dir);

    const pending = store.ask(makeQuestion());
    const pendingOutcome = pending.then(
      () => ({ resolved: true as const }),
      (error) => ({ resolved: false as const, error }),
    );
    await waitForPending(store);

    await store.close({
      disposition: 'interrupted',
      reason: 'Run cancelled via API.',
    });

    const outcome = await pendingOutcome;
    expect(outcome.resolved).toBe(false);
    if (!outcome.resolved) {
      expect(String(outcome.error)).toMatch(/cancelled/i);
    }

    const pendingAfterClose = await store.listPending();
    expect(pendingAfterClose).toHaveLength(0);

    const persisted = JSON.parse(
      await readFile(path.join(dir, 'questions', 'q-1.json'), 'utf8'),
    ) as { status?: string };
    expect(persisted.status).toBe('interrupted');

    await expect(store.submitAnswer('q-1', 'Yes')).rejects.toThrow(/already interrupted/i);
  });

  it('archives orphaned on-disk pending questions during interruption close', async () => {
    const dir = await runDir();
    const questionsDir = path.join(dir, 'questions');
    await mkdir(questionsDir, { recursive: true });

    const now = new Date().toISOString();
    const orphanedRecord = {
      question_id: 'q-orphaned',
      run_id: 'run-2',
      node_id: 'gate',
      stage: 'gate',
      text: 'Continue?',
      choices: [{ label: 'Continue', edge_target: 'next' }],
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    await writeFile(
      path.join(questionsDir, 'q-orphaned.json'),
      `${JSON.stringify(orphanedRecord, null, 2)}\n`,
      'utf8',
    );

    const store = new QuestionStore(dir);
    await store.close({
      disposition: 'interrupted',
      reason: 'Run resumed; stale pending questions were archived.',
    });

    const persisted = JSON.parse(
      await readFile(path.join(questionsDir, 'q-orphaned.json'), 'utf8'),
    ) as { status?: string };
    expect(persisted.status).toBe('interrupted');
  });

  it('deserializes legacy records with unknown status as pending', async () => {
    const dir = await runDir();
    const questionsDir = path.join(dir, 'questions');
    await mkdir(questionsDir, { recursive: true });

    const now = new Date().toISOString();
    const legacyRecord = {
      question_id: 'q-legacy',
      run_id: 'run-3',
      node_id: 'gate',
      stage: 'gate',
      text: 'Legacy question?',
      choices: [{ label: 'Yes', edge_target: 'yes' }],
      status: 'legacy_status_value',
      created_at: now,
      updated_at: now,
    };
    await writeFile(
      path.join(questionsDir, 'q-legacy.json'),
      `${JSON.stringify(legacyRecord, null, 2)}\n`,
      'utf8',
    );

    const store = new QuestionStore(dir);
    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.question_id).toBe('q-legacy');
    expect(pending[0]?.status).toBe('pending');
  });
});

async function waitForPending(store: QuestionStore, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pending = await store.listPending();
    if (pending.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('No pending question was persisted in time.');
}
