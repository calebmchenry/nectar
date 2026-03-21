import type { PendingQuestion } from '../lib/api';

export interface QuestionTrayOptions {
  onAnswer(questionId: string, selectedLabel: string): void;
}

export class QuestionTray {
  readonly element: HTMLElement;

  private readonly list: HTMLDivElement;
  private readonly statusLine: HTMLParagraphElement;
  private readonly onAnswer: (questionId: string, selectedLabel: string) => void;

  constructor(options: QuestionTrayOptions) {
    this.onAnswer = options.onAnswer;

    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section';

    const title = document.createElement('h2');
    title.className = 'hive-title';
    title.textContent = 'Human Gates';

    this.statusLine = document.createElement('p');
    this.statusLine.className = 'note';
    this.statusLine.textContent = 'No pending questions.';

    this.list = document.createElement('div');

    this.element.append(title, this.statusLine, this.list);
  }

  setStatus(message: string): void {
    this.statusLine.textContent = message;
  }

  setQuestions(questions: PendingQuestion[]): void {
    this.list.innerHTML = '';

    const pending = questions.filter((question) => question.status === 'pending');
    if (pending.length === 0) {
      this.statusLine.textContent = 'No pending questions.';
      return;
    }

    this.statusLine.textContent = `${pending.length} pending question${pending.length === 1 ? '' : 's'}`;

    for (const question of pending) {
      const card = document.createElement('div');
      card.className = 'question-card';

      const text = document.createElement('div');
      text.textContent = question.text;

      const meta = document.createElement('div');
      meta.className = 'note';
      meta.textContent = `Node: ${question.node_id}`;

      const choices = document.createElement('div');
      choices.className = 'choice-row';
      for (const choice of question.choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button ghost';
        button.textContent = choice.label;
        button.addEventListener('click', () => {
          this.onAnswer(question.question_id, choice.label);
        });
        choices.append(button);
      }

      card.append(text, meta, choices);
      this.list.append(card);
    }
  }
}
