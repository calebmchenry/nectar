import type { GardenSummary } from '../lib/api';

export interface GardenSidebarOptions {
  onSelect(name: string): void;
}

export class GardenSidebar {
  readonly element: HTMLElement;

  private readonly list: HTMLUListElement;
  private readonly statusLine: HTMLParagraphElement;
  private readonly onSelect: (name: string) => void;

  constructor(options: GardenSidebarOptions) {
    this.onSelect = options.onSelect;

    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section';

    const title = document.createElement('h2');
    title.className = 'hive-title';
    title.textContent = 'Gardens';

    this.statusLine = document.createElement('p');
    this.statusLine.className = 'hive-subtitle';
    this.statusLine.textContent = 'Loading gardens...';

    this.list = document.createElement('ul');
    this.list.className = 'sidebar-list';

    this.element.append(title, this.statusLine, this.list);
  }

  setStatus(message: string): void {
    this.statusLine.textContent = message;
  }

  renderGardens(gardens: GardenSummary[], selectedName: string | null): void {
    this.list.innerHTML = '';

    if (gardens.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'note';
      empty.textContent = 'No .dot gardens found in workspace.';
      this.list.append(empty);
      return;
    }

    for (const garden of gardens) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sidebar-item';
      if (selectedName === garden.name) {
        button.classList.add('is-selected');
      }
      button.addEventListener('click', () => this.onSelect(garden.name));

      const file = document.createElement('span');
      file.className = 'sidebar-file';
      file.textContent = garden.name;

      const meta = document.createElement('span');
      meta.className = 'sidebar-meta';
      meta.textContent = `${garden.node_count} nodes • ${formatTime(garden.modified_at)}`;

      button.append(file, meta);
      item.append(button);
      this.list.append(item);
    }
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}
