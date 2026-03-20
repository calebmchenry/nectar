import { Answer, Interviewer, Question } from './types.js';

export class QueueInterviewer implements Interviewer {
  private readonly answers: Answer[];
  private index = 0;

  constructor(answers: Answer[]) {
    this.answers = answers;
  }

  async ask(_question: Question): Promise<Answer> {
    if (this.index >= this.answers.length) {
      throw new Error('QueueInterviewer: answer queue exhausted.');
    }
    const answer = this.answers[this.index]!;
    this.index++;
    return answer;
  }
}
