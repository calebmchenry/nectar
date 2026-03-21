import type { AnalysisDocument } from './analysis-document.js';

export type SynthesisField = 'recommended_priority' | 'estimated_complexity' | 'feasibility';

export interface SynthesisMajority {
  field: SynthesisField;
  value: string;
  outliers: Record<string, string>;
}

export interface SynthesisDivergence {
  field: SynthesisField;
  values: Record<string, string>;
}

export interface SynthesisResult {
  consensus: Partial<Record<SynthesisField, string>>;
  majorities: SynthesisMajority[];
  divergences: SynthesisDivergence[];
  available_providers: string[];
}

const SYNTHESIS_FIELDS: readonly SynthesisField[] = [
  'recommended_priority',
  'estimated_complexity',
  'feasibility',
];

export function synthesizeAnalyses(analyses: AnalysisDocument[]): SynthesisResult {
  const completed = analyses.filter((analysis) => analysis.status === 'complete');
  const availableProviders = completed.map((analysis) => analysis.provider);

  const consensus: Partial<Record<SynthesisField, string>> = {};
  const majorities: SynthesisMajority[] = [];
  const divergences: SynthesisDivergence[] = [];

  for (const field of SYNTHESIS_FIELDS) {
    const valuesByProvider = collectFieldValues(completed, field);
    const providers = Object.keys(valuesByProvider);
    if (providers.length === 0) {
      continue;
    }

    const distinctValues = [...new Set(Object.values(valuesByProvider))];
    if (distinctValues.length === 1) {
      consensus[field] = distinctValues[0];
      continue;
    }

    const tally = new Map<string, number>();
    for (const value of Object.values(valuesByProvider)) {
      tally.set(value, (tally.get(value) ?? 0) + 1);
    }

    let majorityValue: string | null = null;
    let majorityCount = 0;
    for (const [value, count] of tally.entries()) {
      if (count > majorityCount) {
        majorityCount = count;
        majorityValue = value;
      }
    }

    if (majorityValue && majorityCount > providers.length / 2) {
      const outliers: Record<string, string> = {};
      for (const [provider, value] of Object.entries(valuesByProvider)) {
        if (value !== majorityValue) {
          outliers[provider] = value;
        }
      }
      majorities.push({
        field,
        value: majorityValue,
        outliers,
      });
      continue;
    }

    divergences.push({
      field,
      values: valuesByProvider,
    });
  }

  return {
    consensus,
    majorities,
    divergences,
    available_providers: availableProviders,
  };
}

function collectFieldValues(
  analyses: AnalysisDocument[],
  field: SynthesisField
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const analysis of analyses) {
    const value = analysis[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      values[analysis.provider] = value;
    }
  }
  return values;
}
