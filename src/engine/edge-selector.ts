import { GardenEdge } from '../garden/types.js';
import { evaluateConditionExpression } from './conditions.js';
import { NodeOutcome } from './types.js';

export interface EdgeSelectionInput {
  edges: GardenEdge[];
  outcome: NodeOutcome;
  context: Record<string, string>;
}

export function selectNextEdge(input: EdgeSelectionInput): GardenEdge | null {
  if (input.edges.length === 0) {
    return null;
  }

  let candidates = applyConditionStep(input.edges, input.outcome, input.context);
  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }
  if (candidates.length === 0) {
    return null;
  }

  candidates = applyPreferredLabelStep(candidates, input.outcome.preferred_label);
  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }

  candidates = applySuggestedIdsStep(candidates, input.outcome.suggested_next);
  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }

  candidates = applyWeightStep(candidates);
  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }

  if (candidates.length === 0) {
    return null;
  }

  return candidates.slice().sort((a, b) => a.target.localeCompare(b.target))[0] ?? null;
}

function applyConditionStep(edges: GardenEdge[], outcome: NodeOutcome, context: Record<string, string>): GardenEdge[] {
  const conditionMatches = edges.filter((edge) => {
    if (!edge.condition) {
      return false;
    }

    try {
      return evaluateConditionExpression(edge.condition, {
        outcome: outcome.status === 'success' ? 'success' : 'failure',
        context
      });
    } catch {
      return false;
    }
  });

  if (conditionMatches.length > 0) {
    return conditionMatches;
  }

  return edges.filter((edge) => !edge.condition || isFallbackLabel(edge.label));
}

function applyPreferredLabelStep(edges: GardenEdge[], preferredLabel?: string): GardenEdge[] {
  if (!preferredLabel) {
    return edges;
  }

  const matched = edges.filter((edge) => edge.label === preferredLabel);
  return matched.length > 0 ? matched : edges;
}

function applySuggestedIdsStep(edges: GardenEdge[], suggestedNext?: string[]): GardenEdge[] {
  if (!suggestedNext || suggestedNext.length === 0) {
    return edges;
  }

  const suggested = new Set(suggestedNext);
  const matched = edges.filter((edge) => suggested.has(edge.target));
  return matched.length > 0 ? matched : edges;
}

function applyWeightStep(edges: GardenEdge[]): GardenEdge[] {
  if (edges.length === 0) {
    return [];
  }

  let highest = Number.NEGATIVE_INFINITY;
  for (const edge of edges) {
    if (edge.weight > highest) {
      highest = edge.weight;
    }
  }

  return edges.filter((edge) => edge.weight === highest);
}

function isFallbackLabel(label?: string): boolean {
  return label?.trim().toLowerCase() === 'fallback';
}
