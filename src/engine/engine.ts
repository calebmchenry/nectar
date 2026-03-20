import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Cocoon, PendingTransition } from '../checkpoint/types.js';
import { cocoonRoot, ensureCocoonRoot, writeCocoon, writeNodeAttemptLogs } from '../checkpoint/cocoon.js';
import { RunStore, ManifestData } from '../checkpoint/run-store.js';
import { GardenGraph, GardenNode } from '../garden/types.js';
import { HandlerRegistry } from '../handlers/registry.js';
import { Interviewer } from '../interviewer/types.js';
import type { LLMClient } from '../llm/types.js';
import type { UnifiedClient } from '../llm/client.js';
import { parseAccelerator } from '../interviewer/types.js';
import { selectNextEdge } from './edge-selector.js';
import { RunEvent, RunEventListener } from './events.js';
import { ExecutionContext } from './context.js';
import { getRetryDelayMs, sleep } from './retry.js';
import { CompletedNodeState, NodeOutcome, RunResult, RunState } from './types.js';
import { ParallelHandler } from '../handlers/parallel.js';
import { FanInHandler } from '../handlers/fan-in.js';
import { ManagerLoopHandler } from '../handlers/manager-loop.js';
import { resolveFidelity, getFidelityBudget } from './fidelity.js';
import type { FidelityMode, ResolvedFidelityPlan } from './fidelity.js';
import { resolveThreadId } from './thread-resolver.js';
import { SessionRegistry } from './session-registry.js';
import { buildPreamble } from './preamble.js';
import type { CompletedNodeRecord } from './preamble.js';

const DEFAULT_GOAL_GATE_MAX_RETRIES = 5;

export interface PipelineEngineOptions {
  graph: GardenGraph;
  graph_hash: string;
  workspace_root?: string;
  initial_cocoon?: Cocoon;
  run_id?: string;
  llm_client?: UnifiedClient | LLMClient;
  interviewer?: Interviewer;
  /** Seed context for restart successor runs */
  initial_context?: Record<string, string>;
  /** Override start node (for restart successor runs) */
  start_node_override?: string;
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
  private readonly sessionRegistry: SessionRegistry;
  private runStore?: RunStore;
  private pendingTransition?: PendingTransition;
  private resumeRequiresDegradedFidelity: boolean;
  private previousThreadId: string | null = null;
  private goalGateRetries = 0;
  private interruptedReason: string | null = null;
  private abortController: AbortController | null = null;

  constructor(options: PipelineEngineOptions) {
    this.graph = options.graph;
    this.graphHash = options.graph_hash;
    this.workspaceRoot = options.workspace_root ?? process.cwd();
    this.handlers = new HandlerRegistry(options.llm_client, options.interviewer);
    this.sessionRegistry = new SessionRegistry();

    // Register parallel and fan-in handlers with access to graph and events
    const parallelHandler = new ParallelHandler(
      this.graph,
      this.handlers,
      (event) => this.emit(event)
    );
    this.handlers.register('parallel', parallelHandler);
    this.handlers.register('parallel.fan_in', new FanInHandler());
    this.handlers.register('stack.manager_loop', new ManagerLoopHandler(this.graph));

    if (options.initial_cocoon) {
      const cocoon = options.initial_cocoon;
      this.context = new ExecutionContext(cocoon.context);
      this.retryState = { ...cocoon.retry_state };
      this.pendingTransition = cocoon.pending_transition;
      this.resumeRequiresDegradedFidelity = cocoon.resume_requires_degraded_fidelity ?? false;

      // Detect degraded resume: if last codergen used full fidelity and was interrupted
      if (!this.resumeRequiresDegradedFidelity) {
        const lastCodergen = this.findLastCodergenNode(cocoon.completed_nodes);
        if (lastCodergen) {
          const lastNode = this.graph.nodeMap.get(lastCodergen.node_id);
          if (lastNode) {
            const fidelity = resolveFidelity(lastNode, undefined, this.graph);
            if (fidelity === 'full') {
              this.resumeRequiresDegradedFidelity = true;
            }
          }
        }
      }

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
      // Determine start node: override (for restart successors) or graph start
      const startNodeId = options.start_node_override
        ?? this.graph.nodes.find((node) => node.kind === 'start')?.id;
      if (!startNodeId) {
        throw new Error('Cannot start run: no start node found.');
      }

      const now = new Date().toISOString();
      const runId = options.run_id ?? randomUUID();
      this.context = new ExecutionContext(options.initial_context);
      this.resumeRequiresDegradedFidelity = false;
      // GAP-11: Set built-in context key graph.goal at initialization
      const graphGoal = this.graph.graphAttributes.goal;
      if (graphGoal) {
        this.context.set('graph.goal', graphGoal);
      }
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
        current_node: startNodeId,
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

    // Initialize RunStore and write manifest, preserving lineage if already set
    this.runStore = new RunStore(this.runState.run_id, this.workspaceRoot);
    const existingManifest = await this.runStore.readManifest();
    const manifest: ManifestData = {
      run_id: this.runState.run_id,
      dot_file: this.runState.dot_file,
      graph_hash: this.graphHash,
      graph_label: this.graph.graphAttributes.label,
      goal: this.graph.graphAttributes.goal,
      started_at: this.runState.started_at,
      workspace_root: this.workspaceRoot,
      // Preserve lineage fields from pre-existing manifest (set by CLI for successor runs)
      restart_of: existingManifest?.restart_of,
      restarted_to: existingManifest?.restarted_to,
      restart_depth: existingManifest?.restart_depth,
      parent_run_id: existingManifest?.parent_run_id,
      parent_node_id: existingManifest?.parent_node_id,
    };
    await this.runStore.initialize(manifest);

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

        // Goal gate enforcement: before processing an exit node, check goal gates
        if (node.kind === 'exit') {
          const reroute = this.checkGoalGates();
          if (reroute) {
            if (reroute.error) {
              return await this.finishError(reroute.error);
            }
            this.runState.current_node = reroute.target;
            continue;
          }
        }

        const retryCount = this.retryState[node.id] ?? 0;
        const attempt = retryCount + 1;
        const nodeStartedAt = new Date().toISOString();
        const nodeStartTime = Date.now();

        // GAP-11: Set current_node context key before execution
        this.context.set('current_node', node.id);

        this.emit({
          type: 'node_started',
          run_id: this.runState.run_id,
          node_id: node.id,
          attempt,
          started_at: nodeStartedAt
        });

        const runDir = this.runStore.getRunDir();
        const outgoingEdges = this.graph.outgoing.get(node.id) ?? [];

        // Emit human_question event before wait.human handler executes
        if (node.kind === 'wait.human') {
          const labeledEdges = outgoingEdges.filter((e) => e.label && e.label.trim().length > 0);
          this.emit({
            type: 'human_question',
            run_id: this.runState.run_id,
            node_id: node.id,
            text: node.label ?? node.id,
            choices: labeledEdges.map((e) => {
              const { accelerator } = parseAccelerator(e.label!);
              return { label: e.label!, accelerator: accelerator ?? undefined };
            }),
            default_choice: node.humanDefaultChoice,
            timeout_ms: node.timeoutMs
          });
        }

        // Resolve fidelity and thread for codergen nodes
        let fidelityPlan: ResolvedFidelityPlan | undefined;
        let preamble: string | undefined;
        if (node.kind === 'codergen') {
          fidelityPlan = this.resolveFidelityPlan(node);

          // Build preamble for non-full modes
          if (fidelityPlan.mode !== 'full') {
            const completedRecords: CompletedNodeRecord[] = this.runState.completed_nodes.map(cn => {
              const contextSnippet = this.context.snapshot()[`${cn.node_id}.response`]?.slice(0, 100);
              const isHuman = this.graph.nodeMap.get(cn.node_id)?.kind === 'wait.human';
              const humanAnswer = isHuman
                ? this.context.snapshot()['preferred_label'] || undefined
                : undefined;
              return {
                node_id: cn.node_id,
                status: cn.status,
                started_at: cn.started_at,
                completed_at: cn.completed_at,
                retries: cn.retries,
                context_snippet: contextSnippet,
                is_human_answer: isHuman || undefined,
                human_answer: humanAnswer,
              };
            });

            preamble = buildPreamble({
              mode: fidelityPlan.mode,
              goal: this.graph.graphAttributes.goal,
              run_id: this.runState.run_id,
              completed_nodes: completedRecords,
              context: this.context.snapshot(),
            });

            // Store preamble as artifact for inspection
            if (this.runStore) {
              try {
                const artId = this.runStore.nextArtifactId(node.id, 'preamble');
                await this.runStore.artifactStore().store(artId, `${node.id} preamble`, preamble);
              } catch { /* best-effort */ }
            }
          }
        }

        // Consume steering note if present
        const steerNote = await this.consumeSteerNote();
        if (steerNote) {
          if (node.kind === 'codergen') {
            // Prepend to prompt — will be picked up via context
            this.context.set('stack.manager.note', steerNote);
          } else {
            this.context.set('stack.manager.note', steerNote);
          }
        }

        let outcome = await this.handlers.resolve(node).execute({
          node,
          run_id: this.runState.run_id,
          dot_file: this.graph.dotPath,
          attempt,
          run_dir: runDir,
          context: this.context.snapshot(),
          abort_signal: this.abortController.signal,
          outgoing_edges: outgoingEdges,
          workspace_root: this.workspaceRoot,
          emitEvent: (event) => this.emit(event),
          fidelity_plan: fidelityPlan,
          preamble,
          session_registry: node.kind === 'codergen' ? this.sessionRegistry : undefined,
          graph_tool_hooks_pre: this.graph.toolHooksPre,
          graph_tool_hooks_post: this.graph.toolHooksPost,
        });

        // Emit human_answer event after wait.human handler completes
        if (node.kind === 'wait.human' && outcome.status === 'success' && outcome.preferred_label) {
          this.emit({
            type: 'human_answer',
            run_id: this.runState.run_id,
            node_id: node.id,
            selected_label: outcome.preferred_label,
            source: 'user'
          });
        }

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

        // auto_status: if handler returns no explicit status and auto_status=true, default to success
        if (outcome.status === undefined || outcome.status === null) {
          if (node.autoStatus) {
            (outcome as NodeOutcome).status = 'success';
            this.emit({
              type: 'auto_status_applied',
              run_id: this.runState.run_id,
              node_id: node.id,
              message: `auto_status applied: defaulting to 'success' for node '${node.id}'`,
            });
          }
        }

        // Write per-node status.json for all node types
        await this.writeNodeStatus(runDir, node.id, outcome.status, nodeStartedAt, nodeStartTime);

        // If codergen completed with full fidelity, track for degraded resume
        if (node.kind === 'codergen' && fidelityPlan?.mode === 'full') {
          // Clear degraded flag after successful codergen hop
          if (this.resumeRequiresDegradedFidelity && fidelityPlan.downgraded_from_resume) {
            this.resumeRequiresDegradedFidelity = false;
          }
        }

        // Track thread ID for continuity
        if (fidelityPlan?.thread_key) {
          this.previousThreadId = fidelityPlan.thread_key;
        }

        if (this.interruptedReason) {
          this.runState.current_node = node.id;
          return await this.finishInterrupted(this.interruptedReason);
        }

        // GAP-10: Inherit default_max_retries from graph when node has no explicit max_retries
        const maxRetries = node.maxRetries ?? this.graph.defaultMaxRetries ?? 0;
        // GAP-26: Only retry on 'retry' status (not 'failure')
        if (outcome.status === 'retry' && retryCount < maxRetries) {
          const nextRetryCount = retryCount + 1;
          this.retryState[node.id] = nextRetryCount;
          this.runState.retry_state[node.id] = nextRetryCount;
          // GAP-11: Set internal.retry_count.<node_id> context key
          this.context.set(`internal.retry_count.${node.id}`, String(nextRetryCount));

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

        // GAP-09: allow_partial — on retry exhaustion, convert to partial_success
        if (outcome.status === 'retry' && retryCount >= maxRetries && node.allowPartial) {
          outcome = { ...outcome, status: 'partial_success' };
        }

        if (outcome.context_updates) {
          this.context.setMany(outcome.context_updates);
        }

        // GAP-11: Set outcome and preferred_label context keys after node completes
        this.context.set('outcome', outcome.status);
        this.context.set('preferred_label', outcome.preferred_label ?? '');

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
          await this.writeCanonicalCheckpoint();
          await this.sessionRegistry.closeAll();
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

        // Handle loop_restart edge
        if (selected.loopRestart) {
          return await this.performLoopRestart(selected.target);
        }

        // Persist pending_transition before advancing
        this.pendingTransition = {
          source_node_id: node.id,
          target_node_id: selected.target,
          edge: {
            label: selected.label,
            condition: selected.condition,
            weight: selected.weight,
            fidelity: selected.fidelity,
            thread_id: selected.threadId,
          },
        };

        this.runState.current_node = selected.target;
        this.runState.status = 'running';
        this.runState.context = this.context.snapshot();
        this.runState.updated_at = new Date().toISOString();
        this.runState.retry_state = { ...this.retryState };
        await this.writeCanonicalCheckpoint();
      }

      await this.sessionRegistry.closeAll();
      return this.finishCompleted(started);
    } finally {
      clearSignals();
    }
  }

  private resolveFidelityPlan(node: GardenNode): ResolvedFidelityPlan {
    // Get incoming edge info from pending transition
    const incomingEdge = this.pendingTransition?.target_node_id === node.id
      ? this.pendingTransition.edge
      : undefined;

    let mode = resolveFidelity(node, incomingEdge, this.graph);
    let downgraded = false;

    // Check degraded resume
    if (this.resumeRequiresDegradedFidelity && mode === 'full') {
      mode = 'summary:high';
      downgraded = true;
    }

    // Resolve thread ID
    const threadKey = resolveThreadId(node, incomingEdge, this.graph, this.previousThreadId);

    return {
      mode,
      thread_key: threadKey ?? undefined,
      downgraded_from_resume: downgraded,
      approximate_char_budget: getFidelityBudget(mode),
    };
  }

  private findLastCodergenNode(completedNodes: CompletedNodeState[]): CompletedNodeState | undefined {
    for (let i = completedNodes.length - 1; i >= 0; i--) {
      const cn = completedNodes[i]!;
      const node = this.graph.nodeMap.get(cn.node_id);
      if (node?.kind === 'codergen') return cn;
    }
    return undefined;
  }

  private async consumeSteerNote(): Promise<string | null> {
    if (!this.runStore) return null;
    try {
      const steerPath = path.join(this.runStore.getRunDir(), 'control', 'manager-steer.json');
      const raw = await readFile(steerPath, 'utf8');
      const note = JSON.parse(raw) as { message?: string };
      // Delete after consumption
      await unlink(steerPath).catch(() => {});
      return note.message ?? null;
    } catch {
      return null;
    }
  }

  private async performLoopRestart(targetNodeId: string): Promise<RunResult> {
    const DEFAULT_MAX_RESTART_DEPTH = 25;
    const maxRestartDepth = this.graph.maxRestartDepth ?? DEFAULT_MAX_RESTART_DEPTH;

    // Read current manifest to get restart depth
    const currentManifest = await this.runStore?.readManifest();
    const currentDepth = currentManifest?.restart_depth ?? 0;

    if (currentDepth + 1 > maxRestartDepth) {
      return await this.finishError(
        `Restart depth cap (${maxRestartDepth}) exceeded. Current depth: ${currentDepth}.`
      );
    }

    const successorRunId = randomUUID();

    // Close predecessor: mark as interrupted with loop_restart reason
    this.runState.status = 'interrupted';
    this.runState.interruption_reason = 'loop_restart';
    this.runState.context = this.context.snapshot();
    this.runState.updated_at = new Date().toISOString();
    await this.writeCanonicalCheckpoint();

    // Write restarted_to link in predecessor manifest
    if (this.runStore) {
      await this.runStore.updateManifest({ restarted_to: successorRunId });
    }

    // Filter context: copy all keys except internal/routing keys
    const filteredContext: Record<string, string> = {};
    const stripPrefixes = ['current_node', 'outcome', 'preferred_label', 'last_stage', 'last_response', '_run_log'];
    const stripPrefixPatterns = ['internal.', 'stack.child.', 'stack.manager.'];
    const snapshot = this.context.snapshot();
    for (const [key, value] of Object.entries(snapshot)) {
      if (stripPrefixes.includes(key)) continue;
      if (stripPrefixPatterns.some(p => key.startsWith(p))) continue;
      filteredContext[key] = value;
    }

    this.emit({
      type: 'run_restarted',
      predecessor_run_id: this.runState.run_id,
      successor_run_id: successorRunId,
      restart_depth: currentDepth + 1,
      target_node: targetNodeId,
    });

    await this.sessionRegistry.closeAll();

    // Return restart info — caller (CLI) is responsible for creating and running successor
    return {
      status: 'interrupted',
      run_id: this.runState.run_id,
      completed_nodes: this.runState.completed_nodes.slice(),
      interruption_reason: 'loop_restart',
      restart: {
        successor_run_id: successorRunId,
        restart_depth: currentDepth + 1,
        target_node: targetNodeId,
        filtered_context: filteredContext,
      },
    };
  }

  private async writeCanonicalCheckpoint(): Promise<void> {
    const cocoon = this.toCocoon();

    if (this.runStore) {
      // Canonical checkpoint
      await this.runStore.writeCheckpoint(cocoon);
      // Legacy mirror
      await this.runStore.writeLegacyMirror(cocoon);

      // Emit checkpoint_saved
      this.emit({
        type: 'checkpoint_saved',
        run_id: this.runState.run_id,
        checkpoint_path: path.join(this.runStore.getRunDir(), 'checkpoint.json'),
        timestamp: new Date().toISOString(),
      });
    } else {
      // Fallback to legacy-only write
      await writeCocoon(cocoon, this.workspaceRoot);
    }
  }

  private checkGoalGates(): { target: string; error?: undefined } | { error: string; target?: undefined } | null {
    const goalGateNodes = this.graph.nodes.filter((n) => n.goalGate);
    if (goalGateNodes.length === 0) {
      return null;
    }

    const failedGates: GardenNode[] = [];
    for (const gateNode of goalGateNodes) {
      const completions = this.runState.completed_nodes.filter((c) => c.node_id === gateNode.id);
      if (completions.length === 0) {
        continue;
      }
      const lastCompletion = completions[completions.length - 1];
      if (lastCompletion && lastCompletion.status !== 'success' && lastCompletion.status !== 'partial_success') {
        failedGates.push(gateNode);
      }
    }

    if (failedGates.length === 0) {
      return null;
    }

    // Infinite loop protection
    const maxGoalGateRetries = DEFAULT_GOAL_GATE_MAX_RETRIES;
    this.goalGateRetries++;
    if (this.goalGateRetries > maxGoalGateRetries) {
      return { error: `Goal gate retry limit exceeded (${maxGoalGateRetries}). Failed gates: ${failedGates.map((n) => n.id).join(', ')}` };
    }

    // Find retry target: first failed gate's retry_target, then fallback, then graph-level
    const firstFailed = failedGates[0]!;
    const retryTarget =
      firstFailed.retryTarget ??
      firstFailed.fallbackRetryTarget ??
      this.graph.graphAttributes.retry_target ??
      this.graph.graphAttributes.fallback_retry_target;

    if (!retryTarget) {
      return { error: `Goal gate '${firstFailed.id}' failed but no retry_target is defined.` };
    }

    if (!this.graph.nodeMap.has(retryTarget)) {
      return { error: `Goal gate '${firstFailed.id}' has retry_target '${retryTarget}' which does not exist in the graph.` };
    }

    return { target: retryTarget };
  }

  private async writeNodeStatus(
    runDir: string,
    nodeId: string,
    status: string,
    startedAt: string,
    startTimeMs: number
  ): Promise<void> {
    try {
      const nodeDir = path.join(runDir, nodeId);
      await mkdir(nodeDir, { recursive: true });
      const statusData = {
        status,
        node_id: nodeId,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTimeMs
      };
      await writeFile(path.join(nodeDir, 'status.json'), JSON.stringify(statusData, null, 2), 'utf8');
    } catch {
      // Best-effort status writing — don't fail the run
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

    await this.writeCanonicalCheckpoint();
    await this.sessionRegistry.closeAll();

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

    await this.writeCanonicalCheckpoint();
    await this.sessionRegistry.closeAll();

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
      retry_state: { ...this.retryState },
      pending_transition: this.pendingTransition,
      resume_requires_degraded_fidelity: this.resumeRequiresDegradedFidelity || undefined,
      thread_registry_keys: this.sessionRegistry.getKeys().length > 0
        ? this.sessionRegistry.getKeys()
        : undefined,
    };
  }

  private emit(event: RunEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export interface SequenceOptions {
  graph: GardenGraph;
  context: ExecutionContext;
  handlers: HandlerRegistry;
  startNodeId: string;
  terminationNodeIds: Set<string>;
  runId: string;
  dotFile: string;
  runDir: string;
  abortSignal?: AbortSignal;
  onEvent?: RunEventListener;
  defaultMaxRetries?: number;
}

export interface SequenceResult {
  completedNodes: CompletedNodeState[];
  lastOutcome?: NodeOutcome;
  stoppedAtNodeId?: string;
  error?: string;
}

export async function executeNodeSequence(options: SequenceOptions): Promise<SequenceResult> {
  const {
    graph,
    context,
    handlers,
    startNodeId,
    terminationNodeIds,
    runId,
    dotFile,
    runDir,
    abortSignal,
    onEvent,
    defaultMaxRetries
  } = options;

  const emit = (event: RunEvent): void => {
    onEvent?.(event);
  };

  const completedNodes: CompletedNodeState[] = [];
  const retryState: Record<string, number> = {};
  let currentNodeId: string | undefined = startNodeId;

  while (currentNodeId) {
    if (abortSignal?.aborted) {
      return { completedNodes, stoppedAtNodeId: currentNodeId };
    }

    // Stop at termination boundary (e.g., fan-in node)
    if (terminationNodeIds.has(currentNodeId)) {
      return { completedNodes, stoppedAtNodeId: currentNodeId };
    }

    const node = graph.nodeMap.get(currentNodeId);
    if (!node) {
      return { completedNodes, error: `Node '${currentNodeId}' does not exist in graph.` };
    }

    // Stop at exit nodes — don't execute them in a branch context
    if (node.kind === 'exit') {
      return { completedNodes, stoppedAtNodeId: currentNodeId };
    }

    const retryCount = retryState[node.id] ?? 0;
    const attempt = retryCount + 1;
    const nodeStartedAt = new Date().toISOString();
    const nodeStartTime = Date.now();

    context.set('current_node', node.id);

    emit({
      type: 'node_started',
      run_id: runId,
      node_id: node.id,
      attempt,
      started_at: nodeStartedAt
    });

    const outgoingEdges = graph.outgoing.get(node.id) ?? [];

    if (node.kind === 'wait.human') {
      const labeledEdges = outgoingEdges.filter((e) => e.label && e.label.trim().length > 0);
      emit({
        type: 'human_question',
        run_id: runId,
        node_id: node.id,
        text: node.label ?? node.id,
        choices: labeledEdges.map((e) => {
          const { accelerator } = parseAccelerator(e.label!);
          return { label: e.label!, accelerator: accelerator ?? undefined };
        }),
        default_choice: node.humanDefaultChoice,
        timeout_ms: node.timeoutMs
      });
    }

    let outcome = await handlers.resolve(node).execute({
      node,
      run_id: runId,
      dot_file: dotFile,
      attempt,
      run_dir: runDir,
      context: context.snapshot(),
      abort_signal: abortSignal,
      outgoing_edges: outgoingEdges
    });

    if (node.kind === 'wait.human' && outcome.status === 'success' && outcome.preferred_label) {
      emit({
        type: 'human_answer',
        run_id: runId,
        node_id: node.id,
        selected_label: outcome.preferred_label,
        source: 'user'
      });
    }

    if (abortSignal?.aborted) {
      return { completedNodes, stoppedAtNodeId: currentNodeId };
    }

    const maxRetries = node.maxRetries ?? defaultMaxRetries ?? 0;
    if (outcome.status === 'retry' && retryCount < maxRetries) {
      const nextRetryCount = retryCount + 1;
      retryState[node.id] = nextRetryCount;
      context.set(`internal.retry_count.${node.id}`, String(nextRetryCount));

      const delayMs = getRetryDelayMs(nextRetryCount);
      emit({
        type: 'node_retrying',
        run_id: runId,
        node_id: node.id,
        attempt: nextRetryCount,
        max_retries: maxRetries,
        delay_ms: delayMs
      });

      await sleep(delayMs);
      continue;
    }

    if (outcome.status === 'retry' && retryCount >= maxRetries && node.allowPartial) {
      outcome = { ...outcome, status: 'partial_success' };
    }

    if (outcome.context_updates) {
      context.setMany(outcome.context_updates);
    }

    context.set('outcome', outcome.status);
    context.set('preferred_label', outcome.preferred_label ?? '');

    const completedAt = new Date().toISOString();
    const completedNode: CompletedNodeState = {
      node_id: node.id,
      status: outcome.status,
      started_at: nodeStartedAt,
      completed_at: completedAt,
      retries: retryCount
    };
    completedNodes.push(completedNode);
    retryState[node.id] = 0;

    emit({
      type: 'node_completed',
      run_id: runId,
      node_id: node.id,
      outcome,
      completed_at: completedAt,
      duration_ms: Date.now() - nodeStartTime
    });

    const outgoing = graph.outgoing.get(node.id) ?? [];
    if (outgoing.length === 0) {
      // Dead end
      return { completedNodes, lastOutcome: outcome };
    }

    const selected = selectNextEdge({
      edges: outgoing,
      outcome,
      context: context.snapshot()
    });

    if (!selected) {
      return {
        completedNodes,
        lastOutcome: outcome,
        error: `No next edge found after node '${node.id}' with outcome '${outcome.status}'.`
      };
    }

    emit({
      type: 'edge_selected',
      run_id: runId,
      node_id: node.id,
      edge: selected
    });

    currentNodeId = selected.target;
  }

  return { completedNodes };
}
