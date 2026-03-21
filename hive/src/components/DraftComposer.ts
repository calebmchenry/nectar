export interface DraftComposerOptions {
  onDraft(prompt: string): void;
  onStop(): void;
}

export class DraftComposer {
  readonly element: HTMLElement;

  private readonly input: HTMLInputElement;
  private readonly draftButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly status: HTMLParagraphElement;
  private readonly onDraft: (prompt: string) => void;
  private readonly onStop: () => void;

  constructor(options: DraftComposerOptions) {
    this.onDraft = options.onDraft;
    this.onStop = options.onStop;

    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section';

    const title = document.createElement('h2');
    title.className = 'hive-title';
    title.textContent = 'Draft Garden';

    const form = document.createElement('form');
    form.className = 'draft-form';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });

    this.input = document.createElement('input');
    this.input.className = 'text-input';
    this.input.placeholder = 'Describe a pipeline in plain English';

    this.draftButton = document.createElement('button');
    this.draftButton.type = 'submit';
    this.draftButton.className = 'button secondary';
    this.draftButton.textContent = 'Draft';

    this.stopButton = document.createElement('button');
    this.stopButton.type = 'button';
    this.stopButton.className = 'button ghost';
    this.stopButton.textContent = 'Stop';
    this.stopButton.disabled = true;
    this.stopButton.addEventListener('click', () => this.onStop());

    form.append(this.input, this.draftButton, this.stopButton);

    this.status = document.createElement('p');
    this.status.className = 'note';
    this.status.textContent = 'DOT drafts stream into the editor in real-time.';

    this.element.append(title, form, this.status);
  }

  private submit(): void {
    const prompt = this.input.value.trim();
    if (!prompt) {
      this.setStatus('Enter a prompt before drafting.');
      return;
    }
    this.onDraft(prompt);
  }

  setBusy(busy: boolean): void {
    this.draftButton.disabled = busy;
    this.stopButton.disabled = !busy;
  }

  setStatus(message: string): void {
    this.status.textContent = message;
  }
}
