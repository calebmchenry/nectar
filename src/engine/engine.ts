import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Cocoon } from '../checkpoint/types.js';
import { cocoonRoot, ensureCocoonRoot, writeCocoon, writeNodeAttemptLogs } from '../checkpoint/cocoon.js';
import { GardenGraph } from '../garden/types.js';
import { HandlerRegistry } from '../handlers/registry.js';
import { selectNextEdge } from './edge-selector.js';
import { RunEvent, RunEventListener } from './events.js';
import { ExecutionContext } from './context.js';
import { getRetryDelayMs, sleep } from './retry.js';
import { CompletedNodeState, RunResult, RunState } from './types.js';

export interface PipelineEngineOptions {
  graph: GardenGraph;
  graph_hash: string;
  workspace_root?: string;
  initial_cocoon?: Cocoon;
  run_id?: string;
}

export class PipelineEngine {
  private readonly graph: GardenGraph;
  private readonly graphHash: string;
  private readonly workspaceRoot: string;
  private readonly handlers: HandlerRegistry;
  private readonly listeners: RunEventListener[] = [];
  private readonly context: ExecutionContext;
  private readonly runState: RunState;
  private readonly retryState: Record<string, number>;
  private interruptedReason: string | null = null;
  private abortController: AbortController | null = null;

  constructor(options: PipelineEngineOptions) {
    this.graph = options.graph;
    this.graphHash = options.graph_hash;
    this.workspaceRoot = options.workspace_root ?? process.cwd();
    this.handlers = new HandlerRegistry();

    if (options.initial_cocoon) {
      const cocoon = options.initial_cocoon;
      this.context = new ExecutionContext(cocoon.context);
      this.retryState = { ...cocoon.retry_state };
      this.runState = {
        run_id: cocoon.run_id,
        dot_file: cocoon.dot_file,
        graph_hash: cocoon.graph_hash,
        started_at: cocoon.started_at,
        updated_at: cocoon.updated_at,
        status: 'running',
        completed_nodes: cocoon.completed_nodes.slice(),
        current_node: cocoon.current_node,
        interruption_reason: cocoon.interruption_reason,
        context: { ...cocoon.context },
        retry_state: { ...cocoon.retry_state }
      };
    } else {
      const startNode = this.graph.nodes.find((node) => node.kind === 'start');
      if (!startNode) {
        throw new Error('Cannot start run: no start node found.');
      }

      const now = new Date().toISOString();
      const runId = options.run_id ?? randomUUID();
      this.context = new ExecutionContext();
      this.retryState = {};
      this.runState = {
        run_id: runId,
        dot_file: this.graph.dotPath,
        graph_hash: this.graphHash,
        started_at: now,
        updated_at: now,
        status: 'running',
        interruption_reason: undefined,
        completed_nodes: [],
        current_node: startNode.id,
        context: {},
        retry_state: {}
      };
    }
  }

  onEvent(listener: RunEventListener): void {
    this.listeners.push(listener);
  }

  async run(): Promise<RunResult> {
    await ensureCocoonRoot(this.workspaceRoot);
    const started = Date.now();

    this.emit({
      type: 'run_started',
      run_id: this.runState.run_id,
      dot_file: this.runState.dot_file,
      started_at: this.runState.started_at
    });

    this.abortController = new AbortController();
    const clearSignals = this.registerSignalHandlers();

    try {
      if (!this.runState.current_node) {
        return this.finishCompleted(started);
      }

      while (this.runState.current_node) {
        if (this.interruptedReason) {
          return await this.finishInterrupted(this.interruptedReason);
        }

        const node = this.graph.nodeMap.get(this.runState.current_node);
        if (!node) {
          return await this.finishError(`Node '${this.runState.current_node}' does not exist in graph.`);
        }

        const retryCount = this.retryState[node.id] ?? 0;
        const attempt = retryCount + 1;
        const nodeStartedAt = new Date().toISOString();
        const nodeStartTime = Date.now();

        this.emit({
          type: 'node_started',
          run_id: this.runState.run_id,
          node_id: node.id,
          attempt,
          started_at: nodeStartedAt
        });

        const outcome = await this.handlers.resolve(node).execute({
          node,
          run_id: this.runState.run_id,
          dot_file: this.graph.dotPath,
          attempt,
          run_dir: path.join(cocoonRoot(this.workspaceRoot), this.runState.run_id),
          context: this.context.snapshot(),
          abort_signal: this.abortController.signal
        });

        if (node.kind === 'tool') {
          await writeNodeAttemptLogs(
            this.runState.run_id,
            node.id,
            attempt,
            outcome.stdout ?? '',
            outcome.stderr ?? '',
            this.workspaceRoot
          );
        }

        if (this.interruptedReason) {
          this.runState.current_node = node.id;
          return await this.finishInterrupted(this.interruptedReason);
        }

        const maxRetries = node.maxRetries ?? 0;
        if (outcome.status === 'failure' && retryCount < maxRetries) {
          const nextRetryCount = retryCount + 1;
          this.retryState[node.id] = nextRetryCount;
          this.runState.retry_state[node.id] = nextRetryCount;

          const delayMs = getRetryDelayMs(nextRetryCount);
          this.emit({
            type: 'node_retrying',
            run_id: this.runState.run_id,
            node_id: node.id,
            attempt: nextRetryCount,
            max_retries: maxRetries,
            delay_ms: delayMs
          });

          await sleep(delayMs);
          continue;
        }

        if (outcome.context_updates) {
          this.context.setMany(outcome.context_updates);
        }

        const completedAt = new Date().toISOString();
        const completedNode: CompletedNodeState = {
          node_id: node.id,
          status: outcome.status,
          started_at: nodeStartedAt,
          completed_at: completedAt,
          retries: retryCount
        };

        this.runState.completed_nodes.push(completedNode);
        this.retryState[node.id] = 0;
        this.runState.retry_state[node.id] = 0;

        this.emit({
          type: 'node_completed',
          run_id: this.runState.run_id,
          node_id: node.id,
          outcome,
          completed_at: completedAt,
          duration_ms: Date.now() - nodeStartTime
        });

        if (node.kind === 'exit') {
          this.runState.current_node = undefined;
          this.runState.status = 'completed';
          this.runState.context = this.context.snapshot();
          this.runState.updated_at = new Date().toISOString();
          await writeCocoon(this.toCocoon(), this.workspaceRoot);
          return this.finishCompleted(started);
        }

        const outgoing = this.graph.outgoing.get(node.id) ?? [];
        const selected = selectNextEdge({
          edges: outgoing,
          outcome,
          context: this.context.snapshot()
        });

        if (!selected) {
          return await this.finishError(
            `No next edge found after node '${node.id}' with outcome '${outcome.status}'.`
          );
        }

        this.emit({
          type: 'edge_selected',
          run_id: this.runState.run_id,
          node_id: node.id,
          edge: selected
        });

        this.runState.current_node = selected.target;
        this.runState.status = 'running';
        this.runState.context = this.context.snapshot();
        this.runState.updated_at = new Date().toISOString();
        this.runState.retry_state = { ...this.retryState };
        await writeCocoon(this.toCocoon(), this.workspaceRoot);
      }

      return this.finishCompleted(started);
    } finally {
      clearSignals();
    }
  }

  private registerSignalHandlers(): () => void {
    const onInterrupt = (signal: NodeJS.Signals): void => {
      if (this.interruptedReason) {
        return;
      }

      this.interruptedReason = signal;
      this.abortController?.abort();
    };

    const onSigint = () => onInterrupt('SIGINT');
    const onSigterm = () => onInterrupt('SIGTERM');

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    return () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
  }

  private async finishInterrupted(reason: string): Promise<RunResult> {
    this.runState.status = 'interrupted';
    this.runState.interruption_reason = reason;
    this.runState.context = this.context.snapshot();
    this.runState.updated_at = new Date().toISOString();
    this.runState.retry_state = { ...this.retryState };

    await writeCocoon(this.toCocoon(), this.workspaceRoot);

    this.emit({
      type: 'run_interrupted',
      run_id: this.runState.run_id,
      reason
    });

    return {
      status: 'interrupted',
      run_id: this.runState.run_id,
      completed_nodes: this.runState.completed_nodes.slice(),
      interruption_reason: reason
    };
  }

  private async finishError(message: string): Promise<RunResult> {
    this.runState.status = 'failed';
    this.runState.context = this.context.snapshot();
    this.runState.updated_at = new Date().toISOString();
    this.runState.retry_state = { ...this.retryState };

    await writeCocoon(this.toCocoon(), this.workspaceRoot);

    this.emit({
      type: 'run_error',
      run_id: this.runState.run_id,
      status: 'failed',
      message
    });

    return {
      status: 'failed',
      run_id: this.runState.run_id,
      completed_nodes: this.runState.completed_nodes.slice(),
      error: message
    };
  }

  private finishCompleted(startedMs: number): RunResult {
    const completedAt = new Date().toISOString();
    this.emit({
      type: 'run_completed',
      run_id: this.runState.run_id,
      completed_at: completedAt,
      duration_ms: Date.now() - startedMs,
      completed_nodes: this.runState.completed_nodes.length
    });

    return {
      status: 'completed',
      run_id: this.runState.run_id,
      completed_nodes: this.runState.completed_nodes.slice()
    };
  }

  private toCocoon(): Cocoon {
    return {
      version: 1,
      run_id: this.runState.run_id,
      dot_file: this.runState.dot_file,
      graph_hash: this.graphHash,
      started_at: this.runState.started_at,
      updated_at: this.runState.updated_at,
      status: this.runState.status,
      interruption_reason: this.runState.interruption_reason,
      completed_nodes: this.runState.completed_nodes.slice(),
      current_node: this.runState.current_node,
      context: this.context.snapshot(),
      retry_state: { ...this.retryState }
    };
  }

  private emit(event: RunEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
