import type { EventEnvelope } from '../lib/api';

export interface RunPanelOptions {
  onStart(): void;
  onCancel(): void;
  onResume(): void;
}

export class RunPanel {
  readonly element: HTMLElement;

  private readonly statusLine: HTMLParagraphElement;
  private readonly currentNodeLine: HTMLParagraphElement;
  private readonly timeline: HTMLUListElement;
  private readonly startButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly fanInCard: HTMLDivElement;

  private selectedGarden: string | null = null;
  private runId: string | null = null;
  private runStatus: 'idle' | 'running' | 'completed' | 'failed' | 'interrupted' = 'idle';

  private readonly onStart: () => void;
  private readonly onCancel: () => void;
  private readonly onResume: () => void;

  constructor(options: RunPanelOptions) {
    this.onStart = options.onStart;
    this.onCancel = options.onCancel;
    this.onResume = options.onResume;

    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section';

    const title = document.createElement('h2');
    title.className = 'hive-title';
    title.textContent = 'Run Panel';

    const controls = document.createElement('div');
    controls.className = 'toolbar-left';

    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.className = 'button primary';
    this.startButton.textContent = 'Run';
    this.startButton.addEventListener('click', () => this.onStart());

    this.cancelButton = document.createElement('button');
    this.cancelButton.type = 'button';
    this.cancelButton.className = 'button warn';
    this.cancelButton.textContent = 'Cancel';
    this.cancelButton.addEventListener('click', () => this.onCancel());

    this.resumeButton = document.createElement('button');
    this.resumeButton.type = 'button';
    this.resumeButton.className = 'button secondary';
    this.resumeButton.textContent = 'Resume';
    this.resumeButton.addEventListener('click', () => this.onResume());

    controls.append(this.startButton, this.cancelButton, this.resumeButton);

    this.statusLine = document.createElement('p');
    this.statusLine.className = 'run-status';
    this.statusLine.textContent = 'Status: idle';

    this.currentNodeLine = document.createElement('p');
    this.currentNodeLine.className = 'note';
    this.currentNodeLine.textContent = 'Current node: -';

    this.fanInCard = document.createElement('div');
    this.fanInCard.className = 'fan-in-card';
    this.fanInCard.hidden = true;

    this.timeline = document.createElement('ul');
    this.timeline.className = 'timeline';

    this.element.append(title, controls, this.statusLine, this.currentNodeLine, this.fanInCard, this.timeline);
    this.refreshButtons();
  }

  setSelectedGarden(name: string | null): void {
    this.selectedGarden = name;
    this.refreshButtons();
  }

  setRunState(runId: string | null, status: 'running' | 'completed' | 'failed' | 'interrupted' | 'idle'): void {
    this.runId = runId;
    this.runStatus = status;
    this.statusLine.textContent = `Status: ${status}${runId ? ` (${runId})` : ''}`;
    if (status === 'idle') {
      this.currentNodeLine.textContent = 'Current node: -';
    }
    this.refreshButtons();
  }

  setCurrentNode(nodeId: string | undefined): void {
    this.currentNodeLine.textContent = `Current node: ${nodeId ?? '-'}`;
  }

  setFanIn(bestId: string | undefined, rationale: string | undefined): void {
    if (!bestId && !rationale) {
      this.fanInCard.hidden = true;
      this.fanInCard.textContent = '';
      return;
    }

    this.fanInCard.hidden = false;
    const best = bestId ? `Best branch: ${bestId}` : 'Best branch: n/a';
    const why = rationale ? `Rationale: ${rationale}` : 'Rationale: n/a';
    this.fanInCard.textContent = `${best} • ${why}`;
  }

  clearTimeline(): void {
    this.timeline.innerHTML = '';
  }

  appendEnvelope(envelope: EventEnvelope): void {
    const event = envelope.event;

    if (event.type === 'node_started') {
      this.setCurrentNode(asString(event.node_id));
    }
    if (event.type === 'run_completed') {
      this.setRunState(this.runId, 'completed');
      this.setCurrentNode(undefined);
    }
    if (event.type === 'pipeline_failed' || event.type === 'run_error') {
      this.setRunState(this.runId, 'failed');
    }
    if (event.type === 'run_interrupted') {
      this.setRunState(this.runId, 'interrupted');
    }

    const item = document.createElement('li');
    item.className = 'timeline-item';
    if (event.type === 'stage_failed' || event.type === 'pipeline_failed' || event.type === 'run_error') {
      item.classList.add('error');
    }

    const timestamp = new Date(envelope.timestamp).toLocaleTimeString();
    item.textContent = `${timestamp} • ${formatEvent(event)}`;
    this.timeline.prepend(item);

    while (this.timeline.children.length > 120) {
      this.timeline.removeChild(this.timeline.lastElementChild!);
    }
  }

  private refreshButtons(): void {
    this.startButton.disabled = !this.selectedGarden || this.runStatus === 'running';
    this.cancelButton.disabled = this.runStatus !== 'running';
    this.resumeButton.disabled = this.runStatus !== 'interrupted';
  }
}

function formatEvent(event: EventEnvelope['event']): string {
  switch (event.type) {
    case 'run_started':
      return `run started`;
    case 'node_started':
      return `node ${asString(event.node_id)} started`;
    case 'node_completed':
      return `node ${asString(event.node_id)} ${asString(event.outcome && (event.outcome as Record<string, unknown>).status)}`;
    case 'stage_failed':
      return `stage ${asString(event.node_id)} failed`;
    case 'run_completed':
      return `run completed`;
    case 'pipeline_failed':
      return `pipeline failed: ${asString(event.message)}`;
    case 'run_error':
      return `run error: ${asString(event.message)}`;
    case 'run_interrupted':
      return `run interrupted (${asString(event.reason)})`;
    case 'human_question':
      return `human gate: ${asString(event.text)}`;
    case 'human_answer':
      return `human answer: ${asString(event.selected_label)}`;
    default:
      return event.type;
  }
}

function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}
