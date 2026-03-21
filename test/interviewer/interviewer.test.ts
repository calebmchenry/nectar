import { describe, expect, it } from 'vitest';
import { AutoApproveInterviewer } from '../../src/interviewer/auto-approve.js';
import { CallbackInterviewer } from '../../src/interviewer/callback.js';
import { QueueInterviewer } from '../../src/interviewer/queue.js';
import { RecordingInterviewer } from '../../src/interviewer/recording.js';
import { Answer, AnswerValue, Question, parseAccelerator } from '../../src/interviewer/types.js';

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    type: 'MULTIPLE_CHOICE',
    text: 'Pick one',
    choices: [
      { label: 'Alpha', edge_target: 'a' },
      { label: 'Beta', edge_target: 'b' }
    ],
    node_id: 'gate',
    run_id: 'run-1',
    ...overrides
  };
}

describe('QueueInterviewer', () => {
  it('returns answers in FIFO order', async () => {
    const queue = new QueueInterviewer([
      { selected_label: 'Alpha', source: 'queue' },
      { selected_label: 'Beta', source: 'queue' }
    ]);

    const a1 = await queue.ask(makeQuestion());
    expect(a1.selected_label).toBe('Alpha');
    expect(a1.source).toBe('queue');

    const a2 = await queue.ask(makeQuestion());
    expect(a2.selected_label).toBe('Beta');
  });

  it('returns SKIPPED when queue is exhausted', async () => {
    const queue = new QueueInterviewer([]);
    await expect(queue.ask(makeQuestion())).resolves.toMatchObject({
      selected_label: 'SKIPPED',
      source: 'queue_exhausted',
      answer_value: AnswerValue.SKIPPED,
    });
  });
});

describe('AutoApproveInterviewer', () => {
  it('selects default_choice when defined', async () => {
    const auto = new AutoApproveInterviewer();
    const answer = await auto.ask(makeQuestion({ default_choice: 'Beta' }));
    expect(answer.selected_label).toBe('Beta');
    expect(answer.source).toBe('auto');
  });

  it('selects first choice when no default', async () => {
    const auto = new AutoApproveInterviewer();
    const answer = await auto.ask(makeQuestion());
    expect(answer.selected_label).toBe('Alpha');
    expect(answer.source).toBe('auto');
  });

  it('returns empty label when no choices and no default', async () => {
    const auto = new AutoApproveInterviewer();
    const answer = await auto.ask(makeQuestion({ choices: [], default_choice: undefined }));
    expect(answer.selected_label).toBe('');
  });

  it('treats CONFIRMATION prompts like YES_NO and picks an affirmative option', async () => {
    const auto = new AutoApproveInterviewer();
    const answer = await auto.ask(
      makeQuestion({
        type: 'CONFIRMATION',
        choices: [
          { label: 'Decline', edge_target: 'stop' },
          { label: 'Approve', edge_target: 'go' },
        ],
      }),
    );
    expect(answer.selected_label).toBe('Approve');
    expect(answer.answer_value).toBe(AnswerValue.YES);
  });
});

describe('RecordingInterviewer', () => {
  it('records question-answer pairs', async () => {
    const inner = new QueueInterviewer([{ selected_label: 'Alpha', source: 'queue' }]);
    const recorder = new RecordingInterviewer(inner);

    const question = makeQuestion();
    const answer = await recorder.ask(question);

    expect(answer.selected_label).toBe('Alpha');
    expect(recorder.recordings).toHaveLength(1);
    expect(recorder.recordings[0]![0]).toBe(question);
    expect((recorder.recordings[0]![1] as Answer).selected_label).toBe('Alpha');
  });

  it('records SKIPPED answer when wrapped queue is exhausted', async () => {
    const inner = new QueueInterviewer([]);
    const recorder = new RecordingInterviewer(inner);

    const answer = await recorder.ask(makeQuestion());
    expect(answer.selected_label).toBe('SKIPPED');
    expect(answer.source).toBe('queue_exhausted');
    expect(recorder.recordings).toHaveLength(1);
    expect((recorder.recordings[0]![1] as Answer).selected_label).toBe('SKIPPED');
  });
});

describe('CallbackInterviewer', () => {
  it('delegates to callback', async () => {
    const cb = new CallbackInterviewer(async () => ({
      selected_label: 'Custom',
      source: 'user' as const
    }));
    const answer = await cb.ask(makeQuestion());
    expect(answer.selected_label).toBe('Custom');
  });

  it('times out when callback hangs', async () => {
    const cb = new CallbackInterviewer(
      () => new Promise(() => {}) // never resolves
    );
    await expect(cb.ask(makeQuestion({ timeout_ms: 100 }))).rejects.toThrow(/timeout/);
  });
});

describe('parseAccelerator', () => {
  it('parses [X] prefix', () => {
    const result = parseAccelerator('[Y] Yes');
    expect(result.accelerator).toBe('Y');
    expect(result.cleanLabel).toBe('Yes');
  });

  it('parses X) prefix', () => {
    const result = parseAccelerator('N) No');
    expect(result.accelerator).toBe('N');
    expect(result.cleanLabel).toBe('No');
  });

  it('parses X - prefix', () => {
    const result = parseAccelerator('A - Approve');
    expect(result.accelerator).toBe('A');
    expect(result.cleanLabel).toBe('Approve');
  });

  it('returns null for no accelerator', () => {
    const result = parseAccelerator('Plain Label');
    expect(result.accelerator).toBeNull();
    expect(result.cleanLabel).toBe('Plain Label');
  });

  it('does not match multi-char brackets like [OK]', () => {
    const result = parseAccelerator('[OK] Okay');
    expect(result.accelerator).toBeNull();
    expect(result.cleanLabel).toBe('[OK] Okay');
  });

  it('handles empty label', () => {
    const result = parseAccelerator('');
    expect(result.accelerator).toBeNull();
    expect(result.cleanLabel).toBe('');
  });
});
