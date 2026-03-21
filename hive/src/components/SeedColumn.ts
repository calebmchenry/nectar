import type { SeedStatus, SeedSummary } from '../lib/api';
import { SeedCard } from './SeedCard';

export interface SeedColumnOptions {
  status: SeedStatus;
  title: string;
  seeds: SeedSummary[];
  onSelect(seedId: number): void;
  onMove(seedId: number, status: SeedStatus): void;
  onDragStart?(seedId: number): void;
}

export class SeedColumn {
  readonly element: HTMLElement;

  constructor(options: SeedColumnOptions) {
    const column = document.createElement('section');
    column.className = `seed-column seed-column-${options.status} col-${options.status}`;
    column.dataset.status = options.status;

    const header = document.createElement('header');
    header.className = 'seed-column-header';

    const title = document.createElement('h3');
    title.className = 'seed-column-title';
    title.textContent = options.title;

    const count = document.createElement('span');
    count.className = 'seed-column-count';
    count.textContent = String(options.seeds.length);

    header.append(title, count);

    const body = document.createElement('div');
    body.className = 'seed-column-list';

    for (const seed of options.seeds) {
      const card = new SeedCard(
        {
          id: seed.id,
          title: seed.title,
          priority: seed.priority,
          tags: seed.tags,
          analysis_status: seed.analysis_status,
        },
        {
          onSelect: options.onSelect,
          onDragStart: options.onDragStart,
        }
      );
      body.append(card.element);
    }

    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      column.classList.add('is-drag-over');
    });
    column.addEventListener('dragleave', () => {
      column.classList.remove('is-drag-over');
    });
    column.addEventListener('drop', (event) => {
      event.preventDefault();
      column.classList.remove('is-drag-over');

      const seedIdRaw = event.dataTransfer?.getData('text/plain') ?? '';
      const seedId = Number.parseInt(seedIdRaw, 10);
      if (!Number.isInteger(seedId) || seedId <= 0) {
        return;
      }
      options.onMove(seedId, options.status);
    });

    column.append(header, body);
    this.element = column;
  }
}
