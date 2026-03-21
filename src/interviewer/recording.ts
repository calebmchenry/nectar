import { Answer, Interviewer, Question } from './types.js';

export class RecordingInterviewer implements Interviewer {
  private readonly inner: Interviewer;
  readonly recordings: Array<[Question, Answer | Error]> = [];

  constructor(inner: Interviewer) {
    this.inner = inner;
  }

  async ask(question: Question): Promise<Answer> {
    try {
      const answer = await this.inner.ask(question);
      this.recordings.push([question, answer]);
      return answer;
    } catch (error) {
      this.recordings.push([question, error instanceof Error ? error : new Error(String(error))]);
      throw error;
    }
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (const question of questions) {
      answers.push(await this.ask(question));
    }
    return answers;
  }

  inform(message: string, stage: string): Promise<void> | void {
    return this.inner.inform(message, stage);
  }
}
