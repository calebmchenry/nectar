import type { AnalysisStatus, SeedAnalysis, SeedSynthesis, SwarmProvider } from '../lib/api';

export interface SwarmCompareOptions {
  onRetry(provider: SwarmProvider): void;
}

export class SwarmCompare {
  readonly element: HTMLElement;

  private readonly banner: HTMLDivElement;
  private readonly cards: HTMLDivElement;
  private readonly onRetry: (provider: SwarmProvider) => void;

  constructor(options: SwarmCompareOptions) {
    this.onRetry = options.onRetry;

    this.element = document.createElement('section');
    this.element.className = 'swarm-compare';

    this.banner = document.createElement('div');
    this.banner.className = 'synthesis-banner';

    this.cards = document.createElement('div');
    this.cards.className = 'swarm-card-grid';

    this.element.append(this.banner, this.cards);
  }

  setData(input: {
    analyses: SeedAnalysis[];
    analysis_status: Record<string, AnalysisStatus>;
    synthesis: SeedSynthesis | null;
  }): void {
    this.renderSynthesis(input.synthesis);
    this.cards.innerHTML = '';

    for (const provider of ['claude', 'codex', 'gemini'] as const) {
      const analysis = input.analyses.find((candidate) => candidate.provider === provider);
      this.cards.append(this.renderProviderCard(provider, analysis, input.analysis_status[provider] ?? 'pending'));
    }
  }

  private renderSynthesis(synthesis: SeedSynthesis | null): void {
    if (!synthesis) {
      this.banner.hidden = true;
      return;
    }

    const consensus = Object.entries(synthesis.consensus);
    const majorities = synthesis.majorities;
    const divergences = synthesis.divergences;

    if (consensus.length === 0 && majorities.length === 0 && divergences.length === 0) {
      this.banner.hidden = true;
      return;
    }

    this.banner.hidden = false;
    this.banner.innerHTML = '';

    if (consensus.length > 0) {
      const line = document.createElement('p');
      line.className = 'swarm-synthesis-line consensus';
      line.textContent = `Consensus: ${consensus.map(([field, value]) => `${field}=${value}`).join(', ')}`;
      this.banner.append(line);
    }

    for (const majority of majorities) {
      const line = document.createElement('p');
      line.className = 'swarm-synthesis-line majority';
      line.textContent = `Majority: ${majority.field}=${majority.value} (outliers: ${formatMap(majority.outliers)})`;
      this.banner.append(line);
    }

    for (const divergence of divergences) {
      const line = document.createElement('p');
      line.className = 'swarm-synthesis-line divergence';
      line.textContent = `Divergence: ${divergence.field} -> ${formatMap(divergence.values)}`;
      this.banner.append(line);
    }
  }

  private renderProviderCard(
    provider: SwarmProvider,
    analysis: SeedAnalysis | undefined,
    fallbackStatus: AnalysisStatus
  ): HTMLElement {
    const status = analysis?.status ?? fallbackStatus;

    const card = document.createElement('article');
    card.className = `swarm-card status-${status}`;

    const header = document.createElement('header');
    header.className = 'swarm-card-header';

    const title = document.createElement('h4');
    title.className = 'swarm-card-title';
    title.textContent = provider.toUpperCase();

    const badge = document.createElement('span');
    badge.className = `swarm-status status-${status}`;
    badge.textContent = status;

    header.append(title, badge);
    card.append(header);

    if (analysis && analysis.status === 'complete') {
      const fields = document.createElement('dl');
      fields.className = 'swarm-fields';
      appendField(fields, 'Priority', analysis.recommended_priority ?? 'n/a');
      appendField(fields, 'Complexity', analysis.estimated_complexity ?? 'n/a');
      appendField(fields, 'Feasibility', analysis.feasibility ?? 'n/a');
      card.append(fields);
    }

    const summary = document.createElement('p');
    summary.className = 'swarm-summary';
    summary.textContent = analysis?.summary ?? fallbackSummary(status, analysis?.error);
    card.append(summary);

    if (analysis && analysis.status === 'complete') {
      card.append(createSectionDetails('Implementation Approach', analysis.implementation_approach));
      card.append(createSectionDetails('Risks', analysis.risks));
      card.append(createSectionDetails('Open Questions', analysis.open_questions));
    } else if (analysis?.error) {
      const error = document.createElement('p');
      error.className = 'swarm-error';
      error.textContent = analysis.error;
      card.append(error);
    }

    if (status === 'failed' || status === 'parse_error') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'button secondary';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => this.onRetry(provider));
      card.append(retry);
    }

    return card;
  }
}

function appendField(target: HTMLElement, key: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.textContent = value;
  target.append(dt, dd);
}

function createSectionDetails(title: string, body: string): HTMLElement {
  const details = document.createElement('details');
  details.className = 'swarm-section';
  details.open = false;

  const summary = document.createElement('summary');
  summary.textContent = title;

  const content = document.createElement('p');
  content.textContent = body;

  details.append(summary, content);
  return details;
}

function fallbackSummary(status: string, error?: string): string {
  if (status === 'failed') {
    return `Analysis failed. ${error ?? 'Unknown failure.'}`;
  }
  if (status === 'skipped') {
    return `Analysis skipped. ${error ?? 'Provider not configured.'}`;
  }
  if (status === 'parse_error') {
    return `Analysis parse error. ${error ?? ''}`.trim();
  }
  if (status === 'running') {
    return 'Analysis is running.';
  }
  return 'Analysis has not started.';
}

function formatMap(map: Record<string, string>): string {
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return 'none';
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}
