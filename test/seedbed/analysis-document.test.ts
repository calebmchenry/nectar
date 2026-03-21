import { describe, expect, it } from 'vitest';
import { parseAnalysisDocument, renderAnalysisDocument } from '../../src/seedbed/analysis-document.js';

describe('analysis-document', () => {
  it('renders and parses complete analysis documents', () => {
    const markdown = renderAnalysisDocument({
      provider: 'claude',
      generated_at: '2026-03-21T16:00:00.000Z',
      status: 'complete',
      recommended_priority: 'high',
      estimated_complexity: 'medium',
      feasibility: 'high',
      summary: 'Ship this as a staged rollout.',
      implementation_approach: 'Start with API contracts, then implement handlers.',
      risks: 'Provider latency and attachment size.',
      open_questions: 'Should this run automatically on seed creation?',
    });

    const parsed = parseAnalysisDocument(markdown);
    expect(parsed.provider).toBe('claude');
    expect(parsed.status).toBe('complete');
    expect(parsed.recommended_priority).toBe('high');
    expect(parsed.estimated_complexity).toBe('medium');
    expect(parsed.feasibility).toBe('high');
    expect(parsed.summary).toContain('staged rollout');
    expect(parsed.implementation_approach).toContain('API contracts');
    expect(parsed.risks).toContain('latency');
    expect(parsed.open_questions).toContain('automatically');
  });

  it('throws when required sections are missing', () => {
    const broken = `---\nprovider: codex\ngenerated_at: 2026-03-21T16:00:00.000Z\nstatus: complete\n---\n\n# Summary\n\nHello\n`;
    expect(() => parseAnalysisDocument(broken)).toThrow(/Implementation Approach/i);
  });

  it('renders deterministic fallback sections for skipped/failed states', () => {
    const markdown = renderAnalysisDocument({
      provider: 'gemini',
      generated_at: '2026-03-21T16:00:00.000Z',
      status: 'skipped',
      error: 'Missing GEMINI_API_KEY',
    });

    const parsed = parseAnalysisDocument(markdown);
    expect(parsed.status).toBe('skipped');
    expect(parsed.error).toContain('Missing GEMINI_API_KEY');
    expect(parsed.summary).toContain('skipped');
    expect(parsed.implementation_approach).toBe('Not available.');
    expect(parsed.risks).toBe('Not available.');
    expect(parsed.open_questions).toBe('Not available.');
  });
});
