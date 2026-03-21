export interface DotEditorOptions {
  onChange(value: string): void;
  onSave(): void;
}

export class DotEditor {
  readonly element: HTMLElement;

  private readonly fileLabel: HTMLSpanElement;
  private readonly dirtyDot: HTMLSpanElement;
  private readonly statusLine: HTMLParagraphElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly highlightLayer: HTMLPreElement;
  private readonly onChange: (value: string) => void;
  private readonly onSave: () => void;

  constructor(options: DotEditorOptions) {
    this.onChange = options.onChange;
    this.onSave = options.onSave;

    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section dot-editor';

    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';

    const left = document.createElement('div');
    left.className = 'toolbar-left';

    this.dirtyDot = document.createElement('span');
    this.dirtyDot.className = 'dirty-dot';

    this.fileLabel = document.createElement('span');
    this.fileLabel.textContent = 'No garden selected';

    left.append(this.dirtyDot, this.fileLabel);

    const right = document.createElement('div');
    right.className = 'toolbar-right';

    this.saveButton = document.createElement('button');
    this.saveButton.type = 'button';
    this.saveButton.className = 'button primary';
    this.saveButton.textContent = 'Save (Ctrl/Cmd+S)';
    this.saveButton.addEventListener('click', () => this.onSave());

    right.append(this.saveButton);
    toolbar.append(left, right);

    const shell = document.createElement('div');
    shell.className = 'dot-editor-shell';

    this.highlightLayer = document.createElement('pre');
    this.highlightLayer.className = 'dot-highlight';

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'text-area';
    this.textarea.spellcheck = false;
    this.textarea.addEventListener('input', () => {
      this.refreshHighlight();
      this.onChange(this.textarea.value);
    });
    this.textarea.addEventListener('scroll', () => {
      this.highlightLayer.scrollTop = this.textarea.scrollTop;
      this.highlightLayer.scrollLeft = this.textarea.scrollLeft;
    });
    this.textarea.addEventListener('keydown', (event) => {
      const isSave = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's';
      if (!isSave) {
        return;
      }
      event.preventDefault();
      this.onSave();
    });

    shell.append(this.highlightLayer, this.textarea);

    this.statusLine = document.createElement('p');
    this.statusLine.className = 'note';
    this.statusLine.textContent = 'Use preview to validate DOT while editing.';

    this.element.append(toolbar, shell, this.statusLine);
    this.refreshHighlight();
  }

  focus(): void {
    this.textarea.focus();
  }

  getValue(): string {
    return this.textarea.value;
  }

  setValue(value: string): void {
    this.textarea.value = value;
    this.refreshHighlight();
  }

  setFileName(name: string | null): void {
    this.fileLabel.textContent = name ?? 'No garden selected';
  }

  setDirty(isDirty: boolean): void {
    this.dirtyDot.classList.toggle('is-dirty', isDirty);
  }

  setEnabled(enabled: boolean): void {
    this.textarea.disabled = !enabled;
    this.saveButton.disabled = !enabled;
  }

  setStatus(message: string): void {
    this.statusLine.textContent = message;
  }

  private refreshHighlight(): void {
    const highlighted = highlightDot(this.textarea.value);
    this.highlightLayer.innerHTML = highlighted.length > 0 ? highlighted : '&nbsp;';
  }
}

function highlightDot(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const current = source[index]!;

    if (current === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      const comment = end === -1 ? source.slice(index) : source.slice(index, end);
      out += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
      if (end === -1) {
        break;
      }
      out += '\n';
      index = end + 1;
      continue;
    }

    if (current === '"') {
      let cursor = index + 1;
      let escaped = false;
      while (cursor < source.length) {
        const char = source[cursor]!;
        if (escaped) {
          escaped = false;
          cursor += 1;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          cursor += 1;
          continue;
        }
        if (char === '"') {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      const segment = source.slice(index, cursor);
      out += `<span class="tok-string">${escapeHtml(segment)}</span>`;
      index = cursor;
      continue;
    }

    let cursor = index;
    while (cursor < source.length) {
      const char = source[cursor]!;
      if (char === '"') {
        break;
      }
      if (char === '/' && source[cursor + 1] === '/') {
        break;
      }
      cursor += 1;
    }

    const plainSegment = source.slice(index, cursor);
    out += decoratePlainSegment(plainSegment);
    index = cursor;
  }

  return out;
}

function decoratePlainSegment(input: string): string {
  const escaped = escapeHtml(input);
  const withKeywords = escaped.replace(
    /\b(digraph|graph|subgraph|node|edge|strict|true|false)\b/gi,
    '<span class="tok-keyword">$1</span>'
  );
  return withKeywords.replace(
    /\b(Mdiamond|Msquare|parallelogram|box|diamond|hexagon|component|tripleoctagon|house)\b/g,
    '<span class="tok-shape">$1</span>'
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
