import type { SeedDetail as SeedDetailPayload, SeedPriority, SeedSynthesis } from '../lib/api';
import { SwarmCompare } from './SwarmCompare';

export interface SeedDetailOptions {
  onAnalyze(seedId: number, force: boolean): void;
  onLinkGarden?(seedId: number, gardenPath: string): void;
  onUnlinkGarden?(seedId: number, gardenPath: string): void;
  onRunLinkedGarden?(seedId: number, input: { garden_path?: string; run_id?: string }): void;
  onApplyStatusSuggestion?(seedId: number, status: 'honey'): void;
  onSave?(
    seedId: number,
    patch: {
      title?: string;
      body?: string;
      priority?: SeedPriority;
      tags?: string[];
    }
  ): void;
}

export class SeedDetail {
  readonly element: HTMLElement;

  private readonly headerTitle: HTMLHeadingElement;
  private readonly statusLine: HTMLParagraphElement;
  private readonly analyzeButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly titleInput: HTMLInputElement;
  private readonly bodyInput: HTMLTextAreaElement;
  private readonly tagsInput: HTMLInputElement;
  private readonly priorityInput: HTMLSelectElement;
  private readonly markdownPanel: HTMLDivElement;
  private readonly attachmentsList: HTMLDivElement;
  private readonly metadataLine: HTMLParagraphElement;
  private readonly linkedGardensPanel: HTMLDivElement;
  private readonly linkedGardenInput: HTMLInputElement;
  private readonly linkedGardenList: HTMLUListElement;
  private readonly runGardenSelect: HTMLSelectElement;
  private readonly runGardenButton: HTMLButtonElement;
  private readonly linkedRunsPanel: HTMLDivElement;
  private readonly linkedRunsList: HTMLUListElement;
  private readonly statusSuggestionBanner: HTMLDivElement;
  private readonly suggestionButton: HTMLButtonElement;
  private readonly swarmCompare: SwarmCompare;

  private readonly onAnalyze: (seedId: number, force: boolean) => void;
  private readonly onLinkGarden: (seedId: number, gardenPath: string) => void;
  private readonly onUnlinkGarden: (seedId: number, gardenPath: string) => void;
  private readonly onRunLinkedGarden: (seedId: number, input: { garden_path?: string; run_id?: string }) => void;
  private readonly onApplyStatusSuggestion: (seedId: number, status: 'honey') => void;
  private readonly onSave: (
    seedId: number,
    patch: {
      title?: string;
      body?: string;
      priority?: SeedPriority;
      tags?: string[];
    }
  ) => void;

  private seed: SeedDetailPayload | null = null;
  private synthesis: SeedSynthesis | null = null;

  constructor(options: SeedDetailOptions) {
    this.onAnalyze = options.onAnalyze;
    this.onLinkGarden = options.onLinkGarden ?? (() => undefined);
    this.onUnlinkGarden = options.onUnlinkGarden ?? (() => undefined);
    this.onRunLinkedGarden = options.onRunLinkedGarden ?? (() => undefined);
    this.onApplyStatusSuggestion = options.onApplyStatusSuggestion ?? (() => undefined);
    this.onSave = options.onSave ?? (() => undefined);

    this.element = document.createElement('section');
    this.element.className = 'hive-panel hive-section seed-detail';

    this.headerTitle = document.createElement('h2');
    this.headerTitle.className = 'hive-title';
    this.headerTitle.textContent = 'Seed Detail';

    this.statusLine = document.createElement('p');
    this.statusLine.className = 'hive-subtitle';
    this.statusLine.textContent = 'Select a seed card to inspect and edit it.';

    const actionRow = document.createElement('div');
    actionRow.className = 'toolbar-left';

    this.analyzeButton = document.createElement('button');
    this.analyzeButton.type = 'button';
    this.analyzeButton.className = 'button secondary';
    this.analyzeButton.textContent = 'Analyze';
    this.analyzeButton.addEventListener('click', () => {
      if (!this.seed) {
        return;
      }
      this.onAnalyze(this.seed.meta.id, false);
    });

    this.saveButton = document.createElement('button');
    this.saveButton.type = 'button';
    this.saveButton.className = 'button primary';
    this.saveButton.textContent = 'Save';
    this.saveButton.addEventListener('click', () => this.submitPatch());

    actionRow.append(this.analyzeButton, this.saveButton);

    this.titleInput = document.createElement('input');
    this.titleInput.className = 'text-input';
    this.titleInput.placeholder = 'Title';

    this.bodyInput = document.createElement('textarea');
    this.bodyInput.className = 'text-area seed-detail-body';
    this.bodyInput.placeholder = 'Body';

    this.tagsInput = document.createElement('input');
    this.tagsInput.className = 'text-input';
    this.tagsInput.placeholder = 'Tags (comma separated)';

    this.priorityInput = document.createElement('select');
    this.priorityInput.className = 'text-input';
    for (const priority of ['low', 'normal', 'high', 'queens_order'] as const) {
      const option = document.createElement('option');
      option.value = priority;
      option.textContent = priority === 'queens_order' ? "Queen's Order" : toTitleCase(priority);
      this.priorityInput.append(option);
    }

    this.metadataLine = document.createElement('p');
    this.metadataLine.className = 'seed-detail-meta';

    this.statusSuggestionBanner = document.createElement('div');
    this.statusSuggestionBanner.className = 'seed-status-suggestion';
    this.statusSuggestionBanner.hidden = true;

    this.suggestionButton = document.createElement('button');
    this.suggestionButton.type = 'button';
    this.suggestionButton.className = 'button warn';
    this.suggestionButton.textContent = 'Move To Honey';
    this.suggestionButton.addEventListener('click', () => {
      if (!this.seed || !this.seed.status_suggestion) {
        return;
      }
      this.onApplyStatusSuggestion(this.seed.meta.id, this.seed.status_suggestion.suggested_status);
    });
    this.statusSuggestionBanner.append(this.suggestionButton);

    this.linkedGardensPanel = document.createElement('div');
    this.linkedGardensPanel.className = 'seed-linked-gardens';

    const linkedGardensTitle = document.createElement('h3');
    linkedGardensTitle.className = 'seed-detail-subtitle';
    linkedGardensTitle.textContent = 'Linked Gardens';

    this.linkedGardenInput = document.createElement('input');
    this.linkedGardenInput.className = 'text-input';
    this.linkedGardenInput.placeholder = 'gardens/example.dot';

    const linkGardenButton = document.createElement('button');
    linkGardenButton.type = 'button';
    linkGardenButton.className = 'button secondary';
    linkGardenButton.textContent = 'Link Garden';
    linkGardenButton.addEventListener('click', () => {
      if (!this.seed) {
        return;
      }
      const gardenPath = this.linkedGardenInput.value.trim();
      if (!gardenPath) {
        this.setStatus('Provide a garden path to link.');
        return;
      }
      this.onLinkGarden(this.seed.meta.id, gardenPath);
      this.linkedGardenInput.value = '';
    });

    this.linkedGardenList = document.createElement('ul');
    this.linkedGardenList.className = 'seed-linked-garden-list';

    const linkControls = document.createElement('div');
    linkControls.className = 'seed-linked-garden-controls';
    linkControls.append(this.linkedGardenInput, linkGardenButton);

    this.runGardenSelect = document.createElement('select');
    this.runGardenSelect.className = 'text-input';

    this.runGardenButton = document.createElement('button');
    this.runGardenButton.type = 'button';
    this.runGardenButton.className = 'button primary';
    this.runGardenButton.textContent = 'Run Linked Garden';
    this.runGardenButton.addEventListener('click', () => {
      if (!this.seed) {
        return;
      }
      const linkedGardens = this.seed.meta.linked_gardens;
      const selectedGarden =
        linkedGardens.length === 1
          ? linkedGardens[0]
          : this.runGardenSelect.value.trim();
      if (!selectedGarden) {
        this.setStatus('Select a linked garden before starting a run.');
        return;
      }
      this.onRunLinkedGarden(this.seed.meta.id, { garden_path: selectedGarden });
    });

    const runControls = document.createElement('div');
    runControls.className = 'seed-linked-garden-controls';
    runControls.append(this.runGardenSelect, this.runGardenButton);

    this.linkedGardensPanel.append(linkedGardensTitle, linkControls, this.linkedGardenList, runControls);

    this.linkedRunsPanel = document.createElement('div');
    this.linkedRunsPanel.className = 'seed-linked-runs';

    const linkedRunsTitle = document.createElement('h3');
    linkedRunsTitle.className = 'seed-detail-subtitle';
    linkedRunsTitle.textContent = 'Recent Linked Runs';

    this.linkedRunsList = document.createElement('ul');
    this.linkedRunsList.className = 'seed-linked-run-list';

    this.linkedRunsPanel.append(linkedRunsTitle, this.linkedRunsList);

    this.markdownPanel = document.createElement('div');
    this.markdownPanel.className = 'seed-markdown-panel';

    this.attachmentsList = document.createElement('div');
    this.attachmentsList.className = 'seed-attachments';

    this.swarmCompare = new SwarmCompare({
      onRetry: (provider) => {
        if (!this.seed) {
          return;
        }
        this.onAnalyze(this.seed.meta.id, true);
      },
    });

    this.element.append(
      this.headerTitle,
      this.statusLine,
      actionRow,
      this.titleInput,
      this.bodyInput,
      this.tagsInput,
      this.priorityInput,
      this.metadataLine,
      this.statusSuggestionBanner,
      this.linkedGardensPanel,
      this.linkedRunsPanel,
      this.markdownPanel,
      this.attachmentsList,
      this.swarmCompare.element
    );

    this.setSeed(null, null);
  }

  setSeed(seed: SeedDetailPayload | null, synthesis: SeedSynthesis | null): void {
    this.seed = seed;
    this.synthesis = synthesis;

    const hasSeed = Boolean(seed);
    this.analyzeButton.disabled = !hasSeed;
    this.saveButton.disabled = !hasSeed;
    for (const control of [this.titleInput, this.bodyInput, this.tagsInput, this.priorityInput]) {
      control.disabled = !hasSeed;
    }

    if (!seed) {
      this.headerTitle.textContent = 'Seed Detail';
      this.statusLine.textContent = 'Select a seed card to inspect and edit it.';
      this.titleInput.value = '';
      this.bodyInput.value = '';
      this.tagsInput.value = '';
      this.priorityInput.value = 'normal';
      this.metadataLine.textContent = '';
      this.statusSuggestionBanner.hidden = true;
      this.statusSuggestionBanner.textContent = '';
      this.statusSuggestionBanner.append(this.suggestionButton);
      this.linkedGardenList.innerHTML = '';
      this.linkedRunsList.innerHTML = '';
      this.runGardenSelect.innerHTML = '';
      this.runGardenButton.disabled = true;
      this.markdownPanel.innerHTML = '';
      this.attachmentsList.innerHTML = '';
      this.swarmCompare.setData({
        analyses: [],
        analysis_status: {},
        synthesis: null,
      });
      return;
    }

    this.headerTitle.textContent = `Seed #${seed.meta.id}`;
    this.statusLine.textContent = `Status: ${seed.meta.status}`;
    this.titleInput.value = seed.meta.title;
    this.bodyInput.value = extractBody(seed.seed_md);
    this.tagsInput.value = seed.meta.tags.join(', ');
    this.priorityInput.value = seed.meta.priority;
    this.metadataLine.textContent = `Created ${formatDate(seed.meta.created_at)} • Updated ${formatDate(seed.meta.updated_at)}`;
    this.renderStatusSuggestion(seed);
    this.renderLinkedGardens(seed);
    this.renderLinkedRuns(seed);
    this.markdownPanel.innerHTML = renderMarkdown(seed.seed_md);
    this.renderAttachments(seed);
    this.swarmCompare.setData({
      analyses: seed.analyses,
      analysis_status: seed.meta.analysis_status,
      synthesis: this.synthesis,
    });
  }

  private renderStatusSuggestion(seed: SeedDetailPayload): void {
    if (!seed.status_suggestion) {
      this.statusSuggestionBanner.hidden = true;
      return;
    }

    this.statusSuggestionBanner.hidden = false;
    this.statusSuggestionBanner.textContent = seed.status_suggestion.reason;
    this.statusSuggestionBanner.append(this.suggestionButton);
  }

  private renderLinkedGardens(seed: SeedDetailPayload): void {
    this.linkedGardenList.innerHTML = '';
    this.runGardenSelect.innerHTML = '';

    const linked = seed.linked_garden_summaries.length > 0
      ? seed.linked_garden_summaries
      : seed.meta.linked_gardens.map((garden) => ({ garden, status: 'unknown' as const }));

    for (const garden of linked) {
      const item = document.createElement('li');
      item.className = 'seed-linked-garden-item';

      const pathLabel = document.createElement('span');
      pathLabel.textContent = garden.status === 'ok' ? garden.garden : `${garden.garden} (unknown)`;

      const unlinkButton = document.createElement('button');
      unlinkButton.type = 'button';
      unlinkButton.className = 'button ghost';
      unlinkButton.textContent = 'Unlink';
      unlinkButton.addEventListener('click', () => {
        if (!this.seed) {
          return;
        }
        this.onUnlinkGarden(this.seed.meta.id, garden.garden);
      });

      item.append(pathLabel, unlinkButton);
      this.linkedGardenList.append(item);
    }

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = linked.length > 1 ? 'Select linked garden' : 'No linked gardens';
    this.runGardenSelect.append(defaultOption);

    for (const gardenPath of seed.meta.linked_gardens) {
      const option = document.createElement('option');
      option.value = gardenPath;
      option.textContent = gardenPath;
      this.runGardenSelect.append(option);
    }

    this.runGardenSelect.disabled = seed.meta.linked_gardens.length <= 1;
    this.runGardenButton.disabled = seed.meta.linked_gardens.length === 0;
  }

  private renderLinkedRuns(seed: SeedDetailPayload): void {
    this.linkedRunsList.innerHTML = '';

    if (seed.linked_run_summaries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'hive-subtitle';
      empty.textContent = 'No linked runs yet.';
      this.linkedRunsList.append(empty);
      return;
    }

    for (const run of seed.linked_run_summaries.slice(0, 8)) {
      const item = document.createElement('li');
      item.className = 'seed-linked-run-item';

      const label = document.createElement('span');
      const updated = run.updated_at ? ` • ${formatDate(run.updated_at)}` : '';
      label.textContent = `${run.run_id} • ${run.status}${updated}`;
      item.append(label);

      if (run.status === 'interrupted') {
        const resumeButton = document.createElement('button');
        resumeButton.type = 'button';
        resumeButton.className = 'button secondary';
        resumeButton.textContent = 'Resume';
        resumeButton.addEventListener('click', () => {
          if (!this.seed) {
            return;
          }
          this.onRunLinkedGarden(this.seed.meta.id, {
            run_id: run.run_id,
            garden_path: run.seed_garden || (this.seed.meta.linked_gardens[0] ?? undefined),
          });
        });
        item.append(resumeButton);
      }

      this.linkedRunsList.append(item);
    }
  }

  setStatus(message: string): void {
    this.statusLine.textContent = message;
  }

  setEmpty(message = 'Select a seed card to inspect and edit it.'): void {
    this.setSeed(null, null);
    this.statusLine.textContent = message;
  }

  private renderAttachments(seed: SeedDetailPayload): void {
    this.attachmentsList.innerHTML = '';

    const heading = document.createElement('h3');
    heading.className = 'seed-detail-subtitle';
    heading.textContent = 'Attachments';
    this.attachmentsList.append(heading);

    if (seed.attachments.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hive-subtitle';
      empty.textContent = 'No attachments';
      this.attachmentsList.append(empty);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'seed-attachment-list';

    for (const attachment of seed.attachments) {
      const item = document.createElement('li');
      item.className = 'seed-attachment-item';

      const link = document.createElement('a');
      link.href = attachment.url;
      link.textContent = `${attachment.filename} (${formatBytes(attachment.size)})`;
      link.target = '_blank';
      link.rel = 'noreferrer';

      item.append(link);

      if (attachment.is_image) {
        const img = document.createElement('img');
        img.src = attachment.url;
        img.alt = attachment.filename;
        img.loading = 'lazy';
        img.className = 'seed-attachment-thumb';
        item.append(img);
      }

      list.append(item);
    }

    this.attachmentsList.append(list);
  }

  private submitPatch(): void {
    if (!this.seed) {
      return;
    }

    this.onSave(this.seed.meta.id, {
      title: this.titleInput.value.trim(),
      body: this.bodyInput.value,
      priority: this.priorityInput.value as SeedPriority,
      tags: parseTags(this.tagsInput.value),
    });
  }
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.startsWith('# ')) {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      html.push(`<h1>${renderInline(line.slice(2).trim())}</h1>`);
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      html.push(`<h2>${renderInline(line.slice(3).trim())}</h2>`);
      continue;
    }
    if (line.startsWith('- ')) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderInline(line.slice(2).trim())}</li>`);
      continue;
    }
    if (line.trim().length === 0) {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      continue;
    }

    if (inList) {
      html.push('</ul>');
      inList = false;
    }
    html.push(`<p>${renderInline(line)}</p>`);
  }

  if (inList) {
    html.push('</ul>');
  }

  return html.join('\n');
}

function renderInline(value: string): string {
  const escaped = escapeHtml(value);
  return escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
    const safeHref = href.trim();
    if (!safeHref.startsWith('/') && !safeHref.startsWith('http://') && !safeHref.startsWith('https://')) {
      return text;
    }
    return `<a href="${escapeHtmlAttr(safeHref)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/\"/g, '&quot;');
}

function extractBody(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n');
  if (lines[0]?.startsWith('# ')) {
    const withoutTitle = lines.slice(1);
    if (withoutTitle[0]?.trim() === '') {
      withoutTitle.shift();
    }
    return withoutTitle.join('\n').trim();
  }
  return normalized;
}

function parseTags(input: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of input.split(',')) {
    const tag = part.trim();
    if (!tag) {
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return tags;
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

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

function toTitleCase(value: string): string {
  return value
    .split('_')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
