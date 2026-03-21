import { GardenEdge } from '../garden/types.js';
import { ConditionScope, evaluateConditionExpression } from './conditions.js';
import { NodeOutcome } from './types.js';

export interface EdgeSelectionInput {
  edges: GardenEdge[];
  outcome: NodeOutcome;
  context: Record<string, string>;
  preferred_label?: string;
  steps?: Record<string, { status: string; output?: string }>;
  artifacts?: ConditionScope['artifacts'];
}

export function selectNextEdge(input: EdgeSelectionInput): GardenEdge | null {
  if (input.edges.length === 0) {
    return null;
  }

  let candidates = applyConditionStep(input.edges, input);
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

function applyConditionStep(edges: GardenEdge[], input: EdgeSelectionInput): GardenEdge[] {
  const scope: ConditionScope = {
    outcome: input.outcome.status,
    preferred_label: input.preferred_label ?? input.outcome.preferred_label,
    context: input.context,
    steps: input.steps,
    artifacts: input.artifacts,
  };

  const conditionMatches = edges.filter((edge) => {
    if (!edge.condition) {
      return false;
    }

    try {
      return evaluateConditionExpression(edge.condition, scope);
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

  // GAP-15: Normalize both sides for comparison
  const normalizedPreferred = normalizeLabel(preferredLabel);
  const matched = edges.filter((edge) => normalizeLabel(edge.label ?? '') === normalizedPreferred);
  return matched.length > 0 ? matched : edges;
}

/**
 * GAP-15: Normalize a label for comparison.
 * Lowercase, trim whitespace, strip accelerator prefixes: [X] Rest, X) Rest, X - Rest
 */
export function normalizeLabel(label: string): string {
  let normalized = label.trim().toLowerCase();

  // Strip accelerator prefix patterns: [X] Rest, X) Rest, X - Rest
  // [X] prefix — single alphanumeric char in brackets
  const bracketMatch = normalized.match(/^\[([a-z0-9])\]\s*(.*)/);
  if (bracketMatch) {
    return bracketMatch[2]!.trim();
  }

  // X) prefix — single alphanumeric char followed by )
  const parenMatch = normalized.match(/^([a-z0-9])\)\s*(.*)/);
  if (parenMatch) {
    return parenMatch[2]!.trim();
  }

  // X - prefix — single alphanumeric char followed by space-dash-space
  const dashMatch = normalized.match(/^([a-z0-9])\s+-\s+(.*)/);
  if (dashMatch) {
    return dashMatch[2]!.trim();
  }

  return normalized;
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
