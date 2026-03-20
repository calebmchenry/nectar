import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { GardenGraph } from '../garden/types.js';
import { BranchExecutor } from '../engine/branch-executor.js';
import { ExecutionContext } from '../engine/context.js';
import { RunEventListener } from '../engine/events.js';
import { serializeParallelResults, ParallelResults } from '../engine/parallel-results.js';
import { BranchResult, HandlerExecutionInput, NodeOutcome, NodeStatus } from '../engine/types.js';
import { HandlerRegistry } from './registry.js';
import { NodeHandler } from './registry.js';

export class ParallelHandler implements NodeHandler {
  private readonly graph: GardenGraph;
  private readonly handlers: HandlerRegistry;
  private readonly onEvent?: RunEventListener;

  constructor(graph: GardenGraph, handlers: HandlerRegistry, onEvent?: RunEventListener) {
    this.graph = graph;
    this.handlers = handlers;
    this.onEvent = onEvent;
  }

  async execute(input: HandlerExecutionInput): Promise<NodeOutcome> {
    const joinPolicy = input.node.joinPolicy ?? 'wait_all';
    const maxParallel = input.node.maxParallel ?? 4;

    const outgoingEdges = this.graph.outgoing.get(input.node.id) ?? [];
    const branchStartIds = outgoingEdges.map((e) => e.target);

    if (branchStartIds.length === 0) {
      return { status: 'failure', error_message: 'Parallel node has no outgoing edges.' };
    }

    // Find convergence node (first tripleoctagon reachable from all branch starts)
    const convergenceNode = this.findConvergenceNode(branchStartIds);
    const terminationNodeIds = new Set<string>();
    if (convergenceNode) {
      terminationNodeIds.add(convergenceNode);
    }

    // Also add exit nodes as termination boundaries
    for (const node of this.graph.nodes) {
      if (node.kind === 'exit') {
        terminationNodeIds.add(node.id);
      }
    }

    const startTime = Date.now();

    this.onEvent?.({
      type: 'parallel_started',
      run_id: input.run_id,
      node_id: input.node.id,
      branch_count: branchStartIds.length,
      branch_ids: branchStartIds,
      join_policy: joinPolicy,
      max_parallel: maxParallel
    });

    // Create parent abort controller that can cancel all branches
    const parentController = new AbortController();
    if (input.abort_signal) {
      input.abort_signal.addEventListener('abort', () => parentController.abort(), { once: true });
    }

    // Execute branches with bounded concurrency
    const results = await this.executeBranches(
      input,
      branchStartIds,
      terminationNodeIds,
      maxParallel,
      joinPolicy,
      parentController
    );

    // Apply join policy
    const { status, succeeded, failed } = this.applyJoinPolicy(joinPolicy, results);

    // Build parallel results
    const parallelResults: ParallelResults = {
      branches: results,
      joinPolicy,
      convergenceNode
    };

    const contextUpdates: Record<string, string> = {
      [`parallel.results.${input.node.id}`]: serializeParallelResults(parallelResults)
    };

    this.onEvent?.({
      type: 'parallel_completed',
      run_id: input.run_id,
      node_id: input.node.id,
      status,
      total_branches: results.length,
      succeeded,
      failed,
      duration_ms: Date.now() - startTime
    });

    return {
      status,
      context_updates: contextUpdates
    };
  }

  private async executeBranches(
    input: HandlerExecutionInput,
    branchStartIds: string[],
    terminationNodeIds: Set<string>,
    maxParallel: number,
    joinPolicy: string,
    parentController: AbortController
  ): Promise<BranchResult[]> {
    const results: BranchResult[] = [];
    let activeCount = 0;
    let branchIndex = 0;
    let hasSucceeded = false;

    return new Promise<BranchResult[]>((resolve) => {
      const tryStartNext = (): void => {
        while (branchIndex < branchStartIds.length && activeCount < maxParallel) {
          if (parentController.signal.aborted) {
            break;
          }

          const branchId = branchStartIds[branchIndex]!;
          branchIndex++;
          activeCount++;

          const branchContext = new ExecutionContext(input.context);
          const branchAbortController = new AbortController();
          parentController.signal.addEventListener('abort', () => branchAbortController.abort(), { once: true });

          const branchRunDir = path.join(input.run_dir, `branch_${branchId}`);

          this.onEvent?.({
            type: 'parallel_branch_started',
            run_id: input.run_id,
            node_id: input.node.id,
            branch_id: branchId
          });

          const executor = new BranchExecutor({
            graph: this.graph,
            context: branchContext,
            handlers: this.handlers,
            branchStartNodeId: branchId,
            terminationNodeIds,
            runId: input.run_id,
            dotFile: input.dot_file,
            runDir: branchRunDir,
            abortSignal: branchAbortController.signal,
            onEvent: this.onEvent,
            defaultMaxRetries: this.graph.defaultMaxRetries
          });

          // Create branch run dir (best-effort)
          mkdir(branchRunDir, { recursive: true }).catch(() => {});

          executor.execute().then((result) => {
            results.push(result);
            activeCount--;

            this.onEvent?.({
              type: 'parallel_branch_completed',
              run_id: input.run_id,
              node_id: input.node.id,
              branch_id: branchId,
              status: result.status,
              duration_ms: result.durationMs
            });

            // For first_success: cancel remaining when one succeeds
            if (joinPolicy === 'first_success' && (result.status === 'success' || result.status === 'partial_success') && !hasSucceeded) {
              hasSucceeded = true;
              parentController.abort();
            }

            if (results.length === branchStartIds.length || (hasSucceeded && activeCount === 0)) {
              resolve(results);
              return;
            }

            tryStartNext();
          }).catch(() => {
            results.push({
              branchId,
              status: 'failure',
              contextSnapshot: {},
              durationMs: Date.now() - Date.now()
            });
            activeCount--;

            if (results.length === branchStartIds.length || (hasSucceeded && activeCount === 0)) {
              resolve(results);
              return;
            }

            tryStartNext();
          });
        }

        // All branches started or aborted, and nothing active
        if (activeCount === 0 && (branchIndex >= branchStartIds.length || parentController.signal.aborted)) {
          if (results.length > 0 || branchStartIds.length === 0) {
            resolve(results);
          }
        }
      };

      tryStartNext();
    });
  }

  private applyJoinPolicy(
    joinPolicy: string,
    results: BranchResult[]
  ): { status: NodeStatus; succeeded: number; failed: number } {
    const succeeded = results.filter((r) => r.status === 'success' || r.status === 'partial_success').length;
    const failed = results.length - succeeded;

    if (joinPolicy === 'first_success') {
      if (succeeded > 0) {
        return { status: 'success', succeeded, failed };
      }
      return { status: 'failure', succeeded: 0, failed: results.length };
    }

    // wait_all (default)
    if (failed === 0) {
      return { status: 'success', succeeded, failed: 0 };
    }
    if (succeeded === 0) {
      return { status: 'failure', succeeded: 0, failed };
    }
    return { status: 'partial_success', succeeded, failed };
  }

  private findConvergenceNode(branchStartIds: string[]): string | undefined {
    // Check for explicit convergence_node attribute first
    // (handled by caller if needed)

    // Find first tripleoctagon reachable from all branch starts
    const fanInNodes = this.graph.nodes.filter((n) => n.kind === 'parallel.fan_in');
    if (fanInNodes.length === 0) {
      return undefined;
    }

    for (const fanIn of fanInNodes) {
      const allReach = branchStartIds.every((startId) =>
        this.canReach(startId, fanIn.id)
      );
      if (allReach) {
        return fanIn.id;
      }
    }

    return undefined;
  }

  private canReach(fromId: string, toId: string): boolean {
    const visited = new Set<string>();
    const queue = [fromId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === toId) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      const edges = this.graph.outgoing.get(current) ?? [];
      for (const edge of edges) {
        if (!visited.has(edge.target)) {
          queue.push(edge.target);
        }
      }
    }

    return false;
  }
}
