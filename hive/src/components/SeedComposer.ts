import type { SeedPriority } from '../lib/api';

export interface SeedComposerSubmit {
  title: string;
  body: string;
  tags: string[];
  priority: SeedPriority;
  files: File[];
  analyze_now: boolean;
}

export type SeedComposerSubmitInput = SeedComposerSubmit;

export interface SeedComposerOptions {
  onCreate?(input: SeedComposerSubmit): void;
  onSubmit?(input: SeedComposerSubmit): void;
}

export class SeedComposer {
  readonly element: HTMLElement;

  private readonly form: HTMLFormElement;
  private readonly titleInput: HTMLInputElement;
  private readonly bodyInput: HTMLTextAreaElement;
  private readonly tagsInput: HTMLInputElement;
  private readonly priorityInput: HTMLSelectElement;
  private readonly analyzeNowInput: HTMLInputElement;
  private readonly fileInput: HTMLInputElement;
  private readonly filesList: HTMLUListElement;
  private readonly dropZone: HTMLButtonElement;
  private readonly statusLine: HTMLParagraphElement;

  private files: File[] = [];

  private readonly onCreate: (input: SeedComposerSubmit) => void;

  constructor(options: SeedComposerOptions) {
    const submit = options.onSubmit ?? options.onCreate;
    if (!submit) {
      throw new Error('SeedComposer requires onSubmit or onCreate callback.');
    }
    this.onCreate = submit;

    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section seed-composer';

    const title = document.createElement('h2');
    title.className = 'hive-title';
    title.textContent = 'Plant Seed';

    this.statusLine = document.createElement('p');
    this.statusLine.className = 'hive-subtitle';
    this.statusLine.textContent = 'Capture ideas fast and optionally analyze immediately.';

    this.form = document.createElement('form');
    this.form.className = 'seed-composer-form';
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });

    this.titleInput = document.createElement('input');
    this.titleInput.className = 'text-input';
    this.titleInput.type = 'text';
    this.titleInput.placeholder = 'Title (optional; inferred from body if empty)';

    this.bodyInput = document.createElement('textarea');
    this.bodyInput.className = 'text-area seed-body-input';
    this.bodyInput.placeholder = 'Drop the idea here...';

    this.tagsInput = document.createElement('input');
    this.tagsInput.className = 'text-input';
    this.tagsInput.type = 'text';
    this.tagsInput.placeholder = 'Tags (comma separated)';

    this.priorityInput = document.createElement('select');
    this.priorityInput.className = 'text-input';
    for (const priority of ['normal', 'low', 'high', 'queens_order'] as const) {
      const option = document.createElement('option');
      option.value = priority;
      option.textContent = priority === 'queens_order' ? "Queen's Order" : toTitleCase(priority);
      this.priorityInput.append(option);
    }

    const controls = document.createElement('div');
    controls.className = 'toolbar';

    const priorityWrap = document.createElement('label');
    priorityWrap.className = 'seed-inline-label';
    priorityWrap.textContent = 'Priority';
    priorityWrap.append(this.priorityInput);

    const analyzeWrap = document.createElement('label');
    analyzeWrap.className = 'seed-inline-check';
    this.analyzeNowInput = document.createElement('input');
    this.analyzeNowInput.type = 'checkbox';
    this.analyzeNowInput.checked = true;
    analyzeWrap.append(this.analyzeNowInput, document.createTextNode(' Analyze now'));

    controls.append(priorityWrap, analyzeWrap);

    this.dropZone = document.createElement('button');
    this.dropZone.type = 'button';
    this.dropZone.className = 'seed-drop-zone';
    this.dropZone.textContent = 'Drop attachments here or click to browse';
    this.dropZone.addEventListener('click', () => this.fileInput.click());
    this.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      this.dropZone.classList.add('is-dragover');
    });
    this.dropZone.addEventListener('dragleave', () => {
      this.dropZone.classList.remove('is-dragover');
    });
    this.dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      this.dropZone.classList.remove('is-dragover');
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      this.setFiles([...this.files, ...dropped]);
    });

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.multiple = true;
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => {
      const selected = Array.from(this.fileInput.files ?? []);
      this.setFiles([...this.files, ...selected]);
      this.fileInput.value = '';
    });

    this.filesList = document.createElement('ul');
    this.filesList.className = 'seed-files-list';

    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'button primary';
    submitButton.textContent = 'Plant Seed';

    this.form.append(
      this.titleInput,
      this.bodyInput,
      this.tagsInput,
      controls,
      this.dropZone,
      this.fileInput,
      this.filesList,
      submitButton
    );

    this.element.append(title, this.statusLine, this.form);
  }

  setBusy(busy: boolean): void {
    for (const field of [
      this.titleInput,
      this.bodyInput,
      this.tagsInput,
      this.priorityInput,
      this.analyzeNowInput,
      this.dropZone,
    ]) {
      field.disabled = busy;
    }
  }

  setStatus(message: string): void {
    this.statusLine.textContent = message;
  }

  reset(): void {
    this.titleInput.value = '';
    this.bodyInput.value = '';
    this.tagsInput.value = '';
    this.priorityInput.value = 'normal';
    this.analyzeNowInput.checked = true;
    this.setFiles([]);
  }

  clear(): void {
    this.reset();
  }

  private submit(): void {
    const body = this.bodyInput.value.trim();
    if (!body) {
      this.setStatus('Body is required to plant a seed.');
      return;
    }

    this.onCreate({
      title: this.titleInput.value.trim(),
      body,
      tags: parseTags(this.tagsInput.value),
      priority: (this.priorityInput.value as SeedPriority) ?? 'normal',
      files: [...this.files],
      analyze_now: this.analyzeNowInput.checked,
    });
  }

  private setFiles(next: File[]): void {
    const seen = new Set<string>();
    this.files = [];

    for (const file of next) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      this.files.push(file);
    }

    this.renderFiles();
  }

  private renderFiles(): void {
    this.filesList.innerHTML = '';

    for (const file of this.files) {
      const item = document.createElement('li');
      item.className = 'seed-file-item';

      const label = document.createElement('span');
      label.textContent = `${file.name} (${formatBytes(file.size)})`;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button ghost';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        this.setFiles(this.files.filter((candidate) => candidate !== file));
      });

      item.append(label, remove);
      this.filesList.append(item);
    }
  }
}

function parseTags(input: string): string[] {
  const values = input
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of values) {
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }

  return tags;
}

function toTitleCase(input: string): string {
  return input
    .split('_')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
