import { NodeHandler } from './registry.js';
import { HandlerExecutionInput, NodeOutcome } from '../engine/types.js';
import { ChildRunController, ChildSnapshot } from '../engine/child-run-controller.js';
import { evaluateConditionExpression } from '../engine/conditions.js';
import { sleep } from '../engine/retry.js';
import { GardenGraph } from '../garden/types.js';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_CYCLES = 100;

export class ManagerLoopHandler implements NodeHandler {
  private readonly graph: GardenGraph;

  constructor(graph: GardenGraph) {
    this.graph = graph;
  }

  async execute(input: HandlerExecutionInput): Promise<NodeOutcome> {
    const node = input.node;
    const pollIntervalMs = node.managerPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxCycles = node.managerMaxCycles ?? DEFAULT_MAX_CYCLES;
    const stopCondition = node.managerStopCondition;
    const actions = node.managerActions ?? ['observe', 'wait'];
    const canSteer = actions.includes('steer');
    const steerPrompt = node.prompt ?? '';
    const autostart = node.childAutostart !== false;

    const controller = new ChildRunController({
      parentRunId: input.run_id,
      parentNodeId: node.id,
      workspaceRoot: input.workspace_root ?? process.cwd(),
      onEvent: input.emitEvent,
    });

    try {
      // Start or attach
      if (autostart) {
        const dotFile = this.graph.childDotfile;
        if (!dotFile) {
          return {
            status: 'failure',
            error_message: `Manager node '${node.id}': no stack.child_dotfile configured.`,
          };
        }

        const childRunId = await controller.start(dotFile, this.graph.childWorkdir);

        input.emitEvent?.({
          type: 'child_run_started',
          parent_node_id: node.id,
          child_run_id: childRunId,
          child_dotfile: dotFile,
        });
      } else {
        const existingRunId = input.context['stack.child.run_id'];
        if (!existingRunId) {
          return {
            status: 'failure',
            error_message: `Manager node '${node.id}': stack.child_autostart=false but no stack.child.run_id in context.`,
          };
        }
        await controller.attach(existingRunId);
      }

      // Poll loop
      const steeredTuples = new Set<string>();
      const contextUpdates: Record<string, string> = {};

      for (let cycle = 1; cycle <= maxCycles; cycle++) {
        if (input.abort_signal?.aborted) {
          await controller.abortOwnedChild('parent_interrupted');
          return {
            status: 'failure',
            error_message: 'Manager interrupted',
            context_updates: contextUpdates,
          };
        }

        // Wait before polling (except first cycle for immediate check)
        if (cycle > 1) {
          await sleep(pollIntervalMs);
        }

        const snapshot = await controller.readSnapshot();
        if (!snapshot) {
          // Child hasn't written a checkpoint yet, wait and retry
          if (cycle === 1) {
            await sleep(Math.min(pollIntervalMs, 1000));
            const retrySnapshot = await controller.readSnapshot();
            if (!retrySnapshot) {
              await sleep(pollIntervalMs);
              continue;
            }
          } else {
            continue;
          }
        }

        const snap = snapshot ?? await controller.readSnapshot();
        if (!snap) continue;

        // Mirror snapshot into parent context
        contextUpdates['stack.child.run_id'] = snap.run_id;
        contextUpdates['stack.child.status'] = snap.status;
        contextUpdates['stack.child.current_node'] = snap.current_node ?? '';
        contextUpdates['stack.child.completed_count'] = String(snap.completed_count);
        contextUpdates['stack.child.last_completed_node'] = snap.last_completed_node ?? '';
        contextUpdates['stack.child.last_outcome'] = snap.last_outcome ?? '';
        contextUpdates['stack.child.retry_count'] = String(snap.retry_count);
        contextUpdates['stack.child.updated_at'] = snap.updated_at;

        input.emitEvent?.({
          type: 'child_snapshot_observed',
          child_run_id: snap.run_id,
          child_status: snap.status,
          child_current_node: snap.current_node,
          completed_count: snap.completed_count,
          cycle,
        });

        // Steering: write at-most-once per (node_id, retry_count) tuple
        if (canSteer && steerPrompt && snap.current_node) {
          const tupleKey = `${snap.current_node}:${snap.retry_count}`;
          if (!steeredTuples.has(tupleKey)) {
            const written = await controller.writeSteerNote(steerPrompt, tupleKey);
            if (written) {
              steeredTuples.add(tupleKey);
              input.emitEvent?.({
                type: 'child_steer_note_written',
                child_run_id: snap.run_id,
                tuple_key: tupleKey,
              });
            }
          }
        }

        // Evaluate stop condition
        if (stopCondition) {
          const scope = {
            outcome: (snap.last_outcome ?? 'success') as 'success' | 'failure' | 'partial_success' | 'retry' | 'skipped',
            context: { ...input.context, ...contextUpdates },
          };
          try {
            if (evaluateConditionExpression(stopCondition, scope)) {
              return { status: 'success', context_updates: contextUpdates };
            }
          } catch {
            // Condition evaluation failure — continue polling
          }
        }

        // Check terminal states
        if (snap.status === 'completed') {
          return { status: 'success', context_updates: contextUpdates };
        }
        if (snap.status === 'failed') {
          return {
            status: 'failure',
            error_message: `Child run ${snap.run_id} failed.`,
            context_updates: contextUpdates,
          };
        }
        if (snap.status === 'interrupted') {
          return {
            status: 'failure',
            error_message: `Child run ${snap.run_id} was interrupted.`,
            context_updates: contextUpdates,
          };
        }
      }

      // Max cycles exceeded
      return {
        status: 'failure',
        error_message: `Manager node '${node.id}' exceeded max_cycles (${maxCycles}).`,
        context_updates: contextUpdates,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        status: 'failure',
        error_message: `Manager node '${node.id}' error: ${msg}`,
      };
    }
  }
}
