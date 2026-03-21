import { describe, expect, it } from 'vitest';
import { synthesizeAnalyses } from '../../src/seedbed/synthesis.js';
import type { AnalysisDocument } from '../../src/seedbed/analysis-document.js';

function analysis(overrides: Partial<AnalysisDocument>): AnalysisDocument {
  return {
    provider: 'claude',
    generated_at: '2026-03-21T16:00:00.000Z',
    status: 'complete',
    recommended_priority: 'normal',
    estimated_complexity: 'medium',
    feasibility: 'high',
    summary: 'summary',
    implementation_approach: 'approach',
    risks: 'risks',
    open_questions: 'questions',
    body_md: '# Summary\n\nsummary',
    ...overrides,
  };
}

describe('synthesizeAnalyses', () => {
  it('computes consensus when all providers agree', () => {
    const result = synthesizeAnalyses([
      analysis({ provider: 'claude', recommended_priority: 'high' }),
      analysis({ provider: 'codex', recommended_priority: 'high' }),
      analysis({ provider: 'gemini', recommended_priority: 'high' }),
    ]);

    expect(result.consensus.recommended_priority).toBe('high');
    expect(result.majorities).toHaveLength(0);
    expect(result.divergences).toHaveLength(0);
  });

  it('computes majority when two providers agree', () => {
    const result = synthesizeAnalyses([
      analysis({ provider: 'claude', estimated_complexity: 'medium' }),
      analysis({ provider: 'codex', estimated_complexity: 'medium' }),
      analysis({ provider: 'gemini', estimated_complexity: 'high' }),
    ]);

    const majority = result.majorities.find((entry) => entry.field === 'estimated_complexity');
    expect(majority?.value).toBe('medium');
    expect(majority?.outliers).toEqual({ gemini: 'high' });
  });

  it('computes divergence when no majority exists', () => {
    const result = synthesizeAnalyses([
      analysis({ provider: 'claude', feasibility: 'low' }),
      analysis({ provider: 'codex', feasibility: 'medium' }),
      analysis({ provider: 'gemini', feasibility: 'high' }),
    ]);

    const divergence = result.divergences.find((entry) => entry.field === 'feasibility');
    expect(divergence).toBeTruthy();
    expect(divergence?.values).toEqual({
      claude: 'low',
      codex: 'medium',
      gemini: 'high',
    });
  });

  it('ignores incomplete analyses in synthesis', () => {
    const result = synthesizeAnalyses([
      analysis({ provider: 'claude', status: 'complete', recommended_priority: 'high' }),
      analysis({ provider: 'codex', status: 'failed', recommended_priority: 'low' }),
    ]);

    expect(result.available_providers).toEqual(['claude']);
    expect(result.consensus.recommended_priority).toBe('high');
  });
});
