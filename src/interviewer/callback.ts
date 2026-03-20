import { Answer, Interviewer, Question } from './types.js';

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
      return Promise.race([this.callback(question), timeout]);
    }
    return this.callback(question);
  }
}
