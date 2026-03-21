import { describe, expect, it } from 'vitest';
import { AutoApproveInterviewer } from '../../src/interviewer/auto-approve.js';
import { CallbackInterviewer } from '../../src/interviewer/callback.js';
import { QueueInterviewer } from '../../src/interviewer/queue.js';
import { RecordingInterviewer } from '../../src/interviewer/recording.js';
import { Question } from '../../src/interviewer/types.js';

function question(id: string, label = 'Pick'): Question {
  return {
    id,
    type: 'MULTIPLE_CHOICE',
    text: label,
    choices: [
      { label: 'Alpha', edge_target: 'a' },
      { label: 'Beta', edge_target: 'b' },
    ],
    node_id: 'gate',
    run_id: 'run-1',
  };
}

describe('Interviewer.ask_multiple', () => {
  it('QueueInterviewer returns answers in input order', async () => {
    const queue = new QueueInterviewer([
      { selected_label: 'Beta', source: 'queue' },
      { selected_label: 'Alpha', source: 'queue' },
    ]);

    const answers = await queue.ask_multiple([question('q1'), question('q2')]);
    expect(answers.map((answer) => answer.selected_label)).toEqual(['Beta', 'Alpha']);
  });

  it('QueueInterviewer returns SKIPPED when answers are exhausted mid-batch', async () => {
    const queue = new QueueInterviewer([{ selected_label: 'Beta', source: 'queue' }]);
    const answers = await queue.ask_multiple([question('q1'), question('q2')]);
    expect(answers).toEqual([
      { selected_label: 'Beta', source: 'queue' },
      { selected_label: 'SKIPPED', source: 'queue_exhausted' },
    ]);
  });

  it('AutoApproveInterviewer resolves all questions', async () => {
    const interviewer = new AutoApproveInterviewer();
    const answers = await interviewer.ask_multiple([
      question('q1'),
      { ...question('q2'), default_choice: 'Beta' },
    ]);

    expect(answers[0]?.selected_label).toBe('Alpha');
    expect(answers[1]?.selected_label).toBe('Beta');
  });

  it('CallbackInterviewer ask_multiple is sequential', async () => {
    const seen: string[] = [];
    const interviewer = new CallbackInterviewer(async (q) => {
      seen.push(q.id);
      return { selected_label: q.default_choice ?? 'Alpha', source: 'user' };
    });

    await interviewer.ask_multiple([
      question('q1'),
      { ...question('q2'), default_choice: 'Beta' },
    ]);

    expect(seen).toEqual(['q1', 'q2']);
  });
});

describe('Interviewer.inform', () => {
  it('RecordingInterviewer forwards inform to inner interviewer', async () => {
    let informed = '';
    const inner = new CallbackInterviewer(async () => ({ selected_label: 'Alpha', source: 'user' }));
    inner.inform = (message: string, stage: string) => {
      informed = `${stage}:${message}`;
    };

    const recorder = new RecordingInterviewer(inner);
    recorder.inform('Waiting for approval', 'review');
    expect(informed).toBe('review:Waiting for approval');
  });
});
