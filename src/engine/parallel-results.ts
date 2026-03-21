import { BranchResult, NodeStatus } from './types.js';

export interface ParallelResults {
  branches: BranchResult[];
  joinPolicy: string;
  convergenceNode?: string;
}

export function serializeParallelResults(results: ParallelResults): string {
  const summary = {
    branches: results.branches.map((b) => ({
      branchId: b.branchId,
      status: b.status,
      durationMs: b.durationMs,
      contextSnapshot: pruneContextSnapshot(b.contextSnapshot),
    })),
    joinPolicy: results.joinPolicy,
    convergenceNode: results.convergenceNode
  };
  return JSON.stringify(summary);
}

export function deserializeParallelResults(serialized: string): ParallelResults {
  const parsed = JSON.parse(serialized) as {
    branches: Array<{
      branchId: string;
      status: NodeStatus;
      durationMs: number;
      contextSnapshot?: Record<string, string>;
    }>;
    joinPolicy: string;
    convergenceNode?: string;
  };

  return {
    branches: parsed.branches.map((b) => ({
      branchId: b.branchId,
      status: b.status,
      contextSnapshot: b.contextSnapshot ?? {},
      durationMs: b.durationMs
    })),
    joinPolicy: parsed.joinPolicy,
    convergenceNode: parsed.convergenceNode
  };
}

function pruneContextSnapshot(snapshot: Record<string, string>): Record<string, string> {
  const pruned: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key.endsWith('.response')) {
      pruned[key] = value.slice(0, 600);
      continue;
    }
    if (key === 'outcome' || key === 'preferred_label' || key === 'last_response' || key === 'last_stage') {
      pruned[key] = value.slice(0, 300);
    }
  }
  return pruned;
}
