import type { Answer, Interviewer, Question } from '../interviewer/types.js';
import { QuestionStore } from './question-store.js';

export class HttpInterviewer implements Interviewer {
  private readonly questionStore: QuestionStore;
  private readonly onInformMessage?: (message: string, stage: string) => void;

  constructor(
    questionStore: QuestionStore,
    onInformMessage?: (message: string, stage: string) => void
  ) {
    this.questionStore = questionStore;
    this.onInformMessage = onInformMessage;
  }

  ask(question: Question): Promise<Answer> {
    return this.questionStore.ask(question, question.node_id);
  }

  ask_multiple(questions: Question[]): Promise<Answer[]> {
    return this.questionStore.ask_multiple(questions, 'ask_multiple');
  }

  inform(message: string, stage: string): void {
    this.onInformMessage?.(message, stage);
  }
}
