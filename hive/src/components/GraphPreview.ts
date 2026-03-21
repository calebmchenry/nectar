export class GraphPreview {
  readonly element: HTMLElement;

  private readonly metaLine: HTMLParagraphElement;
  private readonly surface: HTMLDivElement;
  private readonly status: HTMLParagraphElement;

  constructor() {
    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section';

    const title = document.createElement('h2');
    title.className = 'hive-title';
    title.textContent = 'Graph Preview';

    this.metaLine = document.createElement('p');
    this.metaLine.className = 'hive-subtitle';
    this.metaLine.textContent = 'No graph metadata yet.';

    this.surface = document.createElement('div');
    this.surface.className = 'graph-surface';

    this.status = document.createElement('p');
    this.status.className = 'note';
    this.status.textContent = 'Preview will appear after parsing.';

    this.element.append(title, this.metaLine, this.surface, this.status);
  }

  setMetadata(nodeCount: number, edgeCount: number): void {
    this.metaLine.textContent = `${nodeCount} nodes • ${edgeCount} edges`;
  }

  setSvg(svg: string, statusMessage?: string): void {
    this.surface.innerHTML = svg;
    this.status.textContent = statusMessage ?? 'Preview is server-rendered from DOT source.';
  }

  setEmpty(message: string): void {
    this.surface.innerHTML = '';
    this.status.textContent = message;
  }
}
