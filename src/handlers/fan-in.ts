import { HandlerExecutionInput, NodeOutcome, NodeStatus } from '../engine/types.js';
import { deserializeParallelResults, ParallelResults } from '../engine/parallel-results.js';
import { NodeHandler } from './registry.js';

const STATUS_RANK: Record<string, number> = {
  success: 0,
  partial_success: 1,
  retry: 2,
  failure: 3,
  skipped: 4
};

export class FanInHandler implements NodeHandler {
  async execute(input: HandlerExecutionInput): Promise<NodeOutcome> {
    // Find parallel.results.* keys in context
    const resultKeys = Object.keys(input.context).filter((k) => k.startsWith('parallel.results.'));

    if (resultKeys.length === 0) {
      return {
        status: 'failure',
        error_message: 'Fan-in node found no parallel.results.* in context.'
      };
    }

    // Collect all branches from all parallel result sets
    const allBranches: Array<{ branchId: string; status: NodeStatus }> = [];
    for (const key of resultKeys) {
      const serialized = input.context[key];
      if (!serialized) {
        continue;
      }
      try {
        const results: ParallelResults = deserializeParallelResults(serialized);
        for (const branch of results.branches) {
          allBranches.push({ branchId: branch.branchId, status: branch.status });
        }
      } catch {
        // Skip malformed results
      }
    }

    if (allBranches.length === 0) {
      return {
        status: 'failure',
        error_message: 'Fan-in node found no branches in parallel results.'
      };
    }

    // Heuristic ranking: best status wins, tiebreak by branch ID (lexical)
    allBranches.sort((a, b) => {
      const rankA = STATUS_RANK[a.status] ?? 99;
      const rankB = STATUS_RANK[b.status] ?? 99;
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return a.branchId.localeCompare(b.branchId);
    });

    const best = allBranches[0]!;

    // If all candidates failed, fan-in fails
    if (best.status === 'failure') {
      return {
        status: 'failure',
        context_updates: {
          'parallel.fan_in.best_id': best.branchId,
          'parallel.fan_in.best_outcome': best.status
        },
        error_message: 'All parallel branches failed.'
      };
    }

    return {
      status: 'success',
      context_updates: {
        'parallel.fan_in.best_id': best.branchId,
        'parallel.fan_in.best_outcome': best.status
      }
    };
  }
}
