import type { Diagnostic } from '../lib/api';

export class DiagnosticsPanel {
  readonly element: HTMLElement;

  private readonly list: HTMLUListElement;

  constructor() {
    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section';

    const title = document.createElement('h2');
    title.className = 'hive-title';
    title.textContent = 'Diagnostics';

    this.list = document.createElement('ul');
    this.list.className = 'diagnostics-list';

    this.element.append(title, this.list);
  }

  setDiagnostics(diagnostics: Diagnostic[]): void {
    this.list.innerHTML = '';

    if (diagnostics.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'note';
      empty.textContent = 'No parse or validation diagnostics.';
      this.list.append(empty);
      return;
    }

    const ordered = diagnostics.slice().sort((a, b) => {
      if (a.severity === b.severity) {
        return a.code.localeCompare(b.code);
      }
      return a.severity === 'error' ? -1 : 1;
    });

    for (const diagnostic of ordered) {
      const item = document.createElement('li');
      item.className = `diag-item ${diagnostic.severity}`;
      const location = diagnostic.location ? `:${diagnostic.location.line}:${diagnostic.location.col}` : '';
      const file = diagnostic.file ? `${diagnostic.file}${location}` : location;
      item.textContent = `[${diagnostic.severity.toUpperCase()} ${diagnostic.code}] ${diagnostic.message}${file ? ` (${file})` : ''}`;
      this.list.append(item);
    }
  }
}
