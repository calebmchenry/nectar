import { Answer, AnswerValue, Interviewer, Question, askSequentially, normalizeAnswer } from './types.js';

export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    if (question.type === 'CONFIRMATION') {
      const selectedLabel =
        question.default_choice
        ?? resolveAffirmativeChoice(question)
        ?? question.choices?.[0]?.label
        ?? 'Yes';
      return normalizeAnswer(
        question,
        { selected_label: selectedLabel, source: 'auto', answer_value: AnswerValue.YES },
        'auto'
      );
    }

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

const AFFIRMATIVE_LABELS = new Set(['yes', 'y', 'approve', 'approved', 'confirm', 'confirmed', 'accept', 'accepted', 'proceed', 'continue', 'ok']);

function resolveAffirmativeChoice(question: Question): string | undefined {
  if (!question.choices || question.choices.length === 0) {
    return undefined;
  }
  for (const choice of question.choices) {
    const normalized = choice.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (AFFIRMATIVE_LABELS.has(normalized)) {
      return choice.label;
    }
  }
  return undefined;
}
