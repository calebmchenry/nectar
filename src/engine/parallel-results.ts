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
      durationMs: b.durationMs
    })),
    joinPolicy: results.joinPolicy,
    convergenceNode: results.convergenceNode
  };
  return JSON.stringify(summary);
}

export function deserializeParallelResults(serialized: string): ParallelResults {
  const parsed = JSON.parse(serialized) as {
    branches: Array<{ branchId: string; status: NodeStatus; durationMs: number }>;
    joinPolicy: string;
    convergenceNode?: string;
  };

  return {
    branches: parsed.branches.map((b) => ({
      branchId: b.branchId,
      status: b.status,
      contextSnapshot: {},
      durationMs: b.durationMs
    })),
    joinPolicy: parsed.joinPolicy,
    convergenceNode: parsed.convergenceNode
  };
}
