import { Answer, Interviewer, Question, askSequentially, normalizeAnswer } from './types.js';

export class QueueInterviewer implements Interviewer {
  private readonly answers: Answer[];
  private index = 0;

  constructor(answers: Answer[]) {
    this.answers = answers;
  }

  async ask(question: Question): Promise<Answer> {
    if (this.index >= this.answers.length) {
      return normalizeAnswer(question, {
        selected_label: 'SKIPPED',
        source: 'queue_exhausted',
      }, 'queue_exhausted');
    }
    const answer = this.answers[this.index]!;
    this.index++;
    return normalizeAnswer(question, answer, answer.source);
  }

  ask_multiple(questions: Question[]): Promise<Answer[]> {
    return askSequentially(this, questions);
  }

  inform(_message: string, _stage: string): void {
    // no-op
  }
}
