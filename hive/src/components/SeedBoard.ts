import type { SeedStatus, SeedSummary } from '../lib/api';
import { SeedColumn } from './SeedColumn';

const COLUMN_ORDER: Array<{ status: SeedStatus; title: string }> = [
  { status: 'seedling', title: 'Seedling' },
  { status: 'sprouting', title: 'Sprouting' },
  { status: 'blooming', title: 'Blooming' },
  { status: 'honey', title: 'Honey' },
  { status: 'wilted', title: 'Wilted' },
];

export interface SeedBoardOptions {
  onSelect(seedId: number): void;
  onMove(seedId: number, status: SeedStatus): void;
  onDragStart?(seedId: number): void;
  onScroll?(top: number): void;
}

export class SeedBoard {
  readonly element: HTMLElement;

  private readonly grid: HTMLDivElement;
  private readonly scrollBody: HTMLDivElement;
  private readonly statusLine: HTMLParagraphElement;
  private readonly onSelect: (seedId: number) => void;
  private readonly onMove: (seedId: number, status: SeedStatus) => void;
  private readonly onDragStart?: (seedId: number) => void;

  constructor(options: SeedBoardOptions) {
    this.onSelect = options.onSelect;
    this.onMove = options.onMove;
    this.onDragStart = options.onDragStart;

    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section seed-board-shell';

    const title = document.createElement('h2');
    title.className = 'hive-title';
    title.textContent = 'Seedbed Kanban';

    this.statusLine = document.createElement('p');
    this.statusLine.className = 'hive-subtitle';
    this.statusLine.textContent = 'No seeds yet. Plant your first one in the left column.';

    this.scrollBody = document.createElement('div');
    this.scrollBody.className = 'seed-board-scroll';
    this.scrollBody.addEventListener('scroll', () => {
      options.onScroll?.(this.scrollBody.scrollTop);
    });

    this.grid = document.createElement('div');
    this.grid.className = 'seed-board';
    this.scrollBody.append(this.grid);

    this.element.append(title, this.statusLine, this.scrollBody);
  }

  setSeeds(seeds: SeedSummary[], _selectedSeedId?: number | null): void {
    this.grid.innerHTML = '';
    this.statusLine.textContent = seeds.length > 0
      ? `${seeds.length} seed${seeds.length === 1 ? '' : 's'}`
      : 'No seeds yet. Plant your first one in the left column.';

    const grouped = groupByStatus(seeds);
    for (const columnDef of COLUMN_ORDER) {
      const column = new SeedColumn({
        status: columnDef.status,
        title: columnDef.title,
        seeds: grouped[columnDef.status],
        onSelect: this.onSelect,
        onMove: this.onMove,
        onDragStart: this.onDragStart,
      });
      this.grid.append(column.element);
    }
  }

  setStatus(message: string): void {
    this.statusLine.textContent = message;
  }

  setScroll(top: number): void {
    this.scrollBody.scrollTop = Math.max(0, top);
  }

  getScroll(): number {
    return this.scrollBody.scrollTop;
  }
}

function groupByStatus(seeds: SeedSummary[]): Record<SeedStatus, SeedSummary[]> {
  const grouped: Record<SeedStatus, SeedSummary[]> = {
    seedling: [],
    sprouting: [],
    blooming: [],
    honey: [],
    wilted: [],
  };

  for (const seed of seeds) {
    grouped[seed.status].push(seed);
  }

  return grouped;
}
