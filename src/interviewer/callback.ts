import { Answer, Interviewer, Question, askSequentially, normalizeAnswer } from './types.js';

export class CallbackInterviewer implements Interviewer {
  private readonly callback: (question: Question) => Promise<Answer>;

  constructor(callback: (question: Question) => Promise<Answer>) {
    this.callback = callback;
  }

  async ask(question: Question): Promise<Answer> {
    if (question.timeout_ms !== undefined && question.timeout_ms > 0) {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('CallbackInterviewer: timeout exceeded.')), question.timeout_ms);
      });
      const answer = await Promise.race([this.callback(question), timeout]);
      return normalizeAnswer(question, answer, answer.source);
    }
    const answer = await this.callback(question);
    return normalizeAnswer(question, answer, answer.source);
  }

  ask_multiple(questions: Question[]): Promise<Answer[]> {
    return askSequentially(this, questions);
  }

  inform(_message: string, _stage: string): void {
    // no-op
  }
}
