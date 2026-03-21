import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { SeedPriority, ANALYSIS_STATUSES } from './types.js';

export type AnalysisComplexity = 'low' | 'medium' | 'high';
export type AnalysisFeasibility = 'low' | 'medium' | 'high';
export type AnalysisFrontMatterStatus = typeof ANALYSIS_STATUSES[number];
export type AnalysisDocumentStatus = AnalysisFrontMatterStatus | 'parse_error';

export interface AnalysisDocument {
  provider: string;
  generated_at: string;
  status: AnalysisDocumentStatus;
  recommended_priority?: SeedPriority;
  estimated_complexity?: AnalysisComplexity;
  feasibility?: AnalysisFeasibility;
  error?: string;
  summary: string;
  implementation_approach: string;
  risks: string;
  open_questions: string;
  body_md: string;
}

export interface RenderAnalysisDocumentInput {
  provider: string;
  generated_at?: string;
  status: AnalysisFrontMatterStatus;
  recommended_priority?: SeedPriority;
  estimated_complexity?: AnalysisComplexity;
  feasibility?: AnalysisFeasibility;
  error?: string;
  summary?: string;
  implementation_approach?: string;
  risks?: string;
  open_questions?: string;
}

const REQUIRED_SECTION_HEADERS = [
  'summary',
  'implementation approach',
  'risks',
  'open questions',
] as const;

export function parseAnalysisDocument(markdown: string): AnalysisDocument {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const frontMatterMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontMatterMatch) {
    throw new Error('Analysis document must start with YAML front matter.');
  }

  const frontMatterRaw = frontMatterMatch[1] ?? '';
  const body = (frontMatterMatch[2] ?? '').trim();
  const parsed = yamlParse(frontMatterRaw) as Record<string, unknown>;

  const provider = asNonEmptyString(parsed['provider'], 'provider');
  const generatedAt = asNonEmptyString(parsed['generated_at'], 'generated_at');
  const status = asAnalysisStatus(parsed['status']);
  const sections = parseSections(body);

  const summary = sectionBody(sections, 'summary');
  const implementationApproach = sectionBody(sections, 'implementation approach');
  const risks = sectionBody(sections, 'risks');
  const openQuestions = sectionBody(sections, 'open questions');

  return {
    provider,
    generated_at: generatedAt,
    status,
    recommended_priority: asSeedPriority(parsed['recommended_priority']),
    estimated_complexity: asComplexity(parsed['estimated_complexity']),
    feasibility: asFeasibility(parsed['feasibility']),
    error: asOptionalString(parsed['error']),
    summary,
    implementation_approach: implementationApproach,
    risks,
    open_questions: openQuestions,
    body_md: body,
  };
}

export function renderAnalysisDocument(input: RenderAnalysisDocumentInput): string {
  const status = input.status;
  const generatedAt = input.generated_at ?? new Date().toISOString();
  const normalized = normalizeBodySections(input);

  const frontMatter: Record<string, unknown> = {
    provider: input.provider,
    generated_at: generatedAt,
    status,
  };

  if (input.recommended_priority) {
    frontMatter['recommended_priority'] = input.recommended_priority;
  }
  if (input.estimated_complexity) {
    frontMatter['estimated_complexity'] = input.estimated_complexity;
  }
  if (input.feasibility) {
    frontMatter['feasibility'] = input.feasibility;
  }
  if (input.error) {
    frontMatter['error'] = input.error;
  }

  const frontMatterBlock = yamlStringify(frontMatter).trimEnd();
  return [
    '---',
    frontMatterBlock,
    '---',
    '',
    '# Summary',
    '',
    normalized.summary,
    '',
    '# Implementation Approach',
    '',
    normalized.implementation_approach,
    '',
    '# Risks',
    '',
    normalized.risks,
    '',
    '# Open Questions',
    '',
    normalized.open_questions,
    '',
  ].join('\n');
}

function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string[]>();
  let activeHeader: string | null = null;

  for (const rawLine of body.split('\n')) {
    const headerMatch = rawLine.match(/^#\s+(.+)\s*$/);
    if (headerMatch?.[1]) {
      const normalizedHeader = headerMatch[1].trim().toLowerCase();
      if (REQUIRED_SECTION_HEADERS.includes(normalizedHeader as typeof REQUIRED_SECTION_HEADERS[number])) {
        activeHeader = normalizedHeader;
        if (!sections.has(activeHeader)) {
          sections.set(activeHeader, []);
        }
      } else {
        activeHeader = null;
      }
      continue;
    }

    if (activeHeader) {
      sections.get(activeHeader)?.push(rawLine);
    }
  }

  const normalized = new Map<string, string>();
  for (const header of REQUIRED_SECTION_HEADERS) {
    const lines = sections.get(header) ?? [];
    normalized.set(header, lines.join('\n').trim());
  }
  return normalized;
}

function sectionBody(sections: Map<string, string>, header: string): string {
  const value = sections.get(header)?.trim() ?? '';
  if (!value) {
    throw new Error(`Missing required section '# ${toHeaderCase(header)}'.`);
  }
  return value;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Analysis front matter field '${field}' is required.`);
  }
  return value.trim();
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function asAnalysisStatus(value: unknown): AnalysisFrontMatterStatus {
  if (typeof value !== 'string' || !(ANALYSIS_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Invalid analysis status '${String(value)}'.`);
  }
  return value as AnalysisFrontMatterStatus;
}

function asSeedPriority(value: unknown): SeedPriority | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value === 'low' || value === 'normal' || value === 'high' || value === 'queens_order') {
    return value;
  }
  return undefined;
}

function asComplexity(value: unknown): AnalysisComplexity | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return undefined;
}

function asFeasibility(value: unknown): AnalysisFeasibility | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return undefined;
}

function normalizeBodySections(input: RenderAnalysisDocumentInput): {
  summary: string;
  implementation_approach: string;
  risks: string;
  open_questions: string;
} {
  const fallback = fallbackSummary(input.status, input.error);
  return {
    summary: normalizeSection(input.summary, fallback),
    implementation_approach: normalizeSection(input.implementation_approach, 'Not available.'),
    risks: normalizeSection(input.risks, 'Not available.'),
    open_questions: normalizeSection(input.open_questions, 'Not available.'),
  };
}

function normalizeSection(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  return normalized;
}

function fallbackSummary(status: AnalysisDocumentStatus, error: string | undefined): string {
  if (status === 'parse_error') {
    return `Analysis could not be parsed. ${error ?? ''}`.trim();
  }
  if (status === 'failed') {
    return `Analysis failed. ${error ?? 'Unknown error.'}`.trim();
  }
  if (status === 'skipped') {
    return `Analysis skipped. ${error ?? 'Provider not configured.'}`.trim();
  }
  if (status === 'running') {
    return 'Analysis is currently running.';
  }
  if (status === 'pending') {
    return 'Analysis is pending.';
  }
  return 'Summary unavailable.';
}

function toHeaderCase(input: string): string {
  return input
    .split(' ')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
