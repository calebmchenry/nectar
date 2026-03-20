import type { GardenEdge, GardenGraph, GardenNode } from '../garden/types.js';

export type FidelityMode = 'full' | 'truncate' | 'compact' | 'summary:low' | 'summary:medium' | 'summary:high';

export interface ResolvedFidelityPlan {
  mode: FidelityMode;
  thread_key?: string;
  downgraded_from_resume: boolean;
  approximate_char_budget?: number;
}

const FIDELITY_BUDGETS: Record<FidelityMode, number | undefined> = {
  'full': undefined,
  'truncate': 400,
  'compact': 3200,
  'summary:low': 2400,
  'summary:medium': 6000,
  'summary:high': 12000,
};

const VALID_FIDELITY_MODES = new Set<string>(['full', 'truncate', 'compact', 'summary:low', 'summary:medium', 'summary:high']);

export function isFidelityMode(value: string): value is FidelityMode {
  return VALID_FIDELITY_MODES.has(value);
}

export function resolveFidelity(
  node: GardenNode,
  incomingEdge: { fidelity?: string } | undefined,
  graph: GardenGraph
): FidelityMode {
  // 1. Edge fidelity (highest precedence)
  if (incomingEdge?.fidelity && isFidelityMode(incomingEdge.fidelity)) {
    return incomingEdge.fidelity;
  }
  // 2. Node fidelity
  if (node.fidelity && isFidelityMode(node.fidelity)) {
    return node.fidelity;
  }
  // 3. Graph default_fidelity
  if (graph.defaultFidelity && isFidelityMode(graph.defaultFidelity)) {
    return graph.defaultFidelity;
  }
  // 4. Fallback: compact
  return 'compact';
}

export function getFidelityBudget(mode: FidelityMode): number | undefined {
  return FIDELITY_BUDGETS[mode];
}
