import { Answer, Interviewer, Question, askSequentially, normalizeAnswer } from './types.js';

export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    if (question.default_choice) {
      return normalizeAnswer(question, { selected_label: question.default_choice, source: 'auto' }, 'auto');
    }

    if (question.choices && question.choices.length > 0) {
      return normalizeAnswer(
        question,
        { selected_label: question.choices[0]!.label, selected_option: 0, source: 'auto' },
        'auto',
      );
    }

    return normalizeAnswer(question, { selected_label: '', source: 'auto' }, 'auto');
  }

  ask_multiple(questions: Question[]): Promise<Answer[]> {
    return askSequentially(this, questions);
  }

  inform(_message: string, _stage: string): void {
    // no-op
  }
}
