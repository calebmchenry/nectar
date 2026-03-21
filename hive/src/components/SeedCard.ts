import type { AnalysisStatus, SeedPriority } from '../lib/api';

export interface SeedCardData {
  id: number;
  title: string;
  priority: SeedPriority;
  tags: string[];
  analysis_status: Record<string, AnalysisStatus>;
}

export interface SeedCardOptions {
  onSelect(seedId: number): void;
  onDragStart?(seedId: number): void;
}

export class SeedCard {
  readonly element: HTMLElement;

  constructor(seed: SeedCardData, options: SeedCardOptions) {
    const card = document.createElement('article');
    card.className = 'seed-card';
    card.draggable = true;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open seed ${seed.title}`);
    card.dataset.seedId = String(seed.id);

    card.addEventListener('click', () => options.onSelect(seed.id));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        options.onSelect(seed.id);
      }
    });

    card.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer) {
        return;
      }
      event.dataTransfer.setData('text/plain', String(seed.id));
      event.dataTransfer.effectAllowed = 'move';
      card.classList.add('is-dragging');
      options.onDragStart?.(seed.id);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
    });

    const title = document.createElement('h4');
    title.className = 'seed-card-title';
    title.textContent = seed.title;

    const meta = document.createElement('div');
    meta.className = 'seed-card-meta';
    meta.append(renderPriority(seed.priority), renderAnalysisDots(seed.analysis_status));

    const tags = document.createElement('div');
    tags.className = 'seed-card-tags';
    for (const tag of seed.tags) {
      const pill = document.createElement('span');
      pill.className = 'seed-tag-pill';
      pill.textContent = tag;
      tags.append(pill);
    }

    card.append(title, meta);
    if (seed.tags.length > 0) {
      card.append(tags);
    }

    this.element = card;
  }
}

function renderPriority(priority: SeedPriority): HTMLElement {
  const el = document.createElement('span');
  el.className = `seed-priority seed-priority-${priority}`;
  el.textContent = priority === 'queens_order' ? "Queen's Order" : priority;
  return el;
}

function renderAnalysisDots(statusByProvider: Record<string, AnalysisStatus>): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'seed-analysis-dots';

  for (const provider of ['claude', 'codex', 'gemini']) {
    const status = statusByProvider[provider] ?? 'pending';
    const dot = document.createElement('span');
    dot.className = `seed-analysis-dot analysis-dot status-${status}`;
    dot.title = `${provider}: ${status}`;
    wrap.append(dot);
  }

  return wrap;
}
