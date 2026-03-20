import { Answer, Interviewer, Question } from './types.js';

export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    if (question.default_choice) {
      return { selected_label: question.default_choice, source: 'auto' };
    }

    if (question.choices && question.choices.length > 0) {
      return { selected_label: question.choices[0]!.label, source: 'auto' };
    }

    return { selected_label: '', source: 'auto' };
  }
}
