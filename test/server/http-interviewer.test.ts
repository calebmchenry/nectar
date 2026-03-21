import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpInterviewer } from '../../src/server/http-interviewer.js';
import { QuestionStore } from '../../src/server/question-store.js';
import type { Question } from '../../src/interviewer/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function runDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-http-interviewer-'));
  tempDirs.push(dir);
  return dir;
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    type: 'MULTIPLE_CHOICE',
    text: 'Deploy?',
    choices: [
      { label: 'Yes', edge_target: 'yes' },
      { label: 'No', edge_target: 'no' },
    ],
    node_id: 'gate',
    run_id: 'run-1',
    ...overrides,
  };
}

describe('HttpInterviewer', () => {
  it('persists pending questions and resolves after answer submission', async () => {
    const dir = await runDir();
    const store = new QuestionStore(dir);
    const interviewer = new HttpInterviewer(store);

    const pendingAnswer = interviewer.ask(question());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pendingQuestions = await waitForPending(store);
    expect(pendingQuestions).toHaveLength(1);
    expect(pendingQuestions[0]?.question_id).toBe('q-1');

    await store.submitAnswer('q-1', 'Yes');
    const answer = await pendingAnswer;
    expect(answer.selected_label).toBe('Yes');
    expect(answer.source).toBe('user');
  });

  it('times out to default choice when configured', async () => {
    const dir = await runDir();
    const store = new QuestionStore(dir);
    const interviewer = new HttpInterviewer(store);

    const answer = await interviewer.ask(
      question({
        id: 'q-timeout',
        timeout_ms: 20,
        default_choice: 'No',
      })
    );

    expect(answer.selected_label).toBe('No');
    expect(answer.source).toBe('timeout');
  });
});

async function waitForPending(
  store: QuestionStore,
  timeoutMs = 1_000
): Promise<Awaited<ReturnType<QuestionStore['listPending']>>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pending = await store.listPending();
    if (pending.length > 0) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.listPending();
}
