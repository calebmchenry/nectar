import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Cocoon, PendingTransition } from '../checkpoint/types.js';
import { cocoonRoot, ensureCocoonRoot, writeCocoon, writeNodeAttemptLogs } from '../checkpoint/cocoon.js';
import { RunStore, ManifestData } from '../checkpoint/run-store.js';
import { GardenEdge, GardenGraph, GardenNode } from '../garden/types.js';
import { HandlerRegistry } from '../handlers/registry.js';
import { Interviewer } from '../interviewer/types.js';
import type { LLMClient } from '../llm/types.js';
import type { UnifiedClient } from '../llm/client.js';
import { parseAccelerator } from '../interviewer/types.js';
import { selectNextEdge } from './edge-selector.js';
import { RunEvent, RunEventListener } from './events.js';
import { ExecutionContext } from './context.js';
import { computeBackoff, getRetryPreset, RETRY_PRESETS, shouldRetry, sleep, type RetryPreset } from './retry.js';
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
import {
  buildLegacyStepResults,
  createStepResultState,
  stepResultsToConditionState,
  toOutputPreview,
} from './step-state.js';

const DEFAULT_GOAL_GATE_MAX_RETRIES = 5;

export interface PipelineEngineOptions {
  graph: GardenGraph;
  graph_hash: string;
  graph_hash_kind?: 'source' | 'prepared';
  workspace_root?: string;
  initial_cocoon?: Cocoon;
  run_id?: string;
  llm_client?: UnifiedClient | LLMClient;
  interviewer?: Interviewer;
  /** Seed context for restart successor runs */
  initial_context?: Record<string, string>;
  /** Override start node (for restart successor runs) */
  start_node_override?: string;
  /** Disable process-level SIGINT/SIGTERM registration (server mode). */
  register_signal_handlers?: boolean;
  seed_id?: number;
  seed_dir?: string;
  seed_garden?: string;
  launch_origin?: 'seedbed' | 'seed_cli' | 'pipeline_api' | 'garden_hive';
}

export class PipelineEngine {
  private readonly graph: GardenGraph;
  private readonly graphHash: string;
  private readonly graphHashKind: 'source' | 'prepared';
  private readonly workspaceRoot: string;
  private readonly handlers: HandlerRegistry;
  private readonly listeners: RunEventListener[] = [];
  private readonly context: ExecutionContext;
  private readonly runState: RunState;
  private readonly retryState: Record<string, number>;
  private readonly sessionRegistry: SessionRegistry;
  private readonly registerSignalHandlersEnabled: boolean;
  private readonly seedId?: number;
  private readonly seedDir?: string;
  private readonly seedGarden?: string;
  private readonly launchOrigin?: 'seedbed' | 'seed_cli' | 'pipeline_api' | 'garden_hive';
  private pipelineFailedEmitted = false;
  private readonly failureMessages = new Map<string, string>();
  private terminalFailure: { failed_node_id: string; message: string } | null = null;
  private runStore?: RunStore;
  private pendingTransition?: PendingTransition;
  private resumeRequiresDegradedFidelity: boolean;
  private previousThreadId: string | null = null;
  private goalGateRetries = 0;
  private interruptedReason: string | null = null;
  private abortController: AbortController | null = null;
  private readonly artifactValueCache = new Map<string, string | null>();
  private logs: string[] = [];
  private nodeStartIndex = 0;

  constructor(options: PipelineEngineOptions) {
    this.graph = options.graph;
    this.graphHash = options.graph_hash;
    this.graphHashKind = options.graph_hash_kind ?? options.initial_cocoon?.graph_hash_kind ?? 'source';
    this.workspaceRoot = options.workspace_root ?? process.cwd();
    this.registerSignalHandlersEnabled = options.register_signal_handlers !== false;
    this.seedId = options.seed_id;
    this.seedDir = options.seed_dir;
    this.seedGarden = options.seed_garden;
    this.launchOrigin = options.launch_origin;
    this.handlers = new HandlerRegistry(options.llm_client, options.interviewer);
    this.sessionRegistry = new SessionRegistry();

    // Register parallel and fan-in handlers with access to graph and events
    const parallelHandler = new ParallelHandler(
      this.graph,
      this.handlers,
      (event) => this.emit(event)
    );
    this.handlers.register('parallel', parallelHandler);
    this.handlers.register('parallel.fan_in', new FanInHandler(options.llm_client));
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
        retry_state: { ...cocoon.retry_state },
        step_results: cocoon.step_results
          ? { ...cocoon.step_results }
          : buildLegacyStepResults(cocoon.completed_nodes, cocoon.context),
        artifact_aliases: { ...(cocoon.artifact_aliases ?? {}) },
      };
      this.logs = Array.isArray(cocoon.logs) ? cocoon.logs.slice() : [];
      this.seedArtifactCacheFromContext();
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
        retry_state: {},
        step_results: {},
        artifact_aliases: {},
      };
      this.logs = [];
    }
  }

  onEvent(listener: RunEventListener): void {
    this.listeners.push(listener);
  }

  getContextSnapshot(): Record<string, string> {
    return this.context.snapshot();
  }

  abort(reason = 'aborted'): void {
    if (this.interruptedReason) {
      return;
    }
    this.interruptedReason = reason;
    this.abortController?.abort();
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
      graph_hash_kind: this.graphHashKind,
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
      seed_id: this.seedId ?? existingManifest?.seed_id,
      seed_dir: this.seedDir ?? existingManifest?.seed_dir,
      seed_garden: this.seedGarden ?? existingManifest?.seed_garden,
      launch_origin: this.launchOrigin ?? existingManifest?.launch_origin,
    };
    await this.runStore.initialize(manifest);

    this.emit({
      type: 'run_started',
      run_id: this.runState.run_id,
      dot_file: this.runState.dot_file,
      started_at: this.runState.started_at
    });

    this.abortController = new AbortController();
    const clearSignals = this.registerSignalHandlersEnabled
      ? this.registerSignalHandlers()
      : () => {};

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
          return await this.finishError(
            `Node '${this.runState.current_node}' does not exist in graph.`,
            this.runState.current_node,
          );
        }

        // Goal gate enforcement: before processing an exit node, check goal gates
        const isTerminalExit = node.kind === 'exit' && (this.graph.outgoing.get(node.id) ?? []).length === 0;
        if (isTerminalExit) {
          const reroute = await this.checkGoalGates();
          if (reroute) {
            if (reroute.error) {
              return await this.finishError(reroute.error, node.id);
            }
            if ('terminal_failure' in reroute && reroute.terminal_failure) {
              this.terminalFailure = reroute.terminal_failure;
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
          index: ++this.nodeStartIndex,
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

        let outcome: NodeOutcome;
        try {
          outcome = await this.handlers.resolve(node).execute({
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
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Root cause note (Sprint 026): handler exceptions must share the same retry
          // and failure-routing contract as explicit failure outcomes.
          outcome = {
            status: 'failure',
            error_message: `Node '${node.id}' threw an unhandled error: ${message}`,
          };
        }

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
          const logPaths = await writeNodeAttemptLogs(
            this.runState.run_id,
            node.id,
            attempt,
            outcome.stdout ?? '',
            outcome.stderr ?? '',
            this.workspaceRoot
          );
          this.logs.push(logPaths.stdout_path);
        }

        // auto_status: if handler returns no explicit status and auto_status=true, default to success
        if (outcome.status === undefined || outcome.status === null) {
          if (node.autoStatus) {
            (outcome as NodeOutcome).status = 'success';
            this.emit({
              type: 'auto_status_applied',
              run_id: this.runState.run_id,
              node_id: node.id,
              message: 'auto-status: handler completed without writing status',
            });
          }
        }

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

        const retryConfig = resolveRetryConfig(node, this.graph);
        const maxRetries = retryConfig.max_retries;
        const eligibleForRetry = retryCount < maxRetries && shouldRetry(outcome);
        if (eligibleForRetry) {
          const nextRetryCount = retryCount + 1;
          this.retryState[node.id] = nextRetryCount;
          this.runState.retry_state[node.id] = nextRetryCount;
          // GAP-11: Set internal.retry_count.<node_id> context key
          this.context.set(`internal.retry_count.${node.id}`, String(nextRetryCount));

          const delayMs = retryConfig.preset ? computeBackoff(nextRetryCount, retryConfig.preset) : 0;
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
        outcome = this.withSynthesizedOutcomeNotes(node, outcome);

        // Write canonical per-node status.json for all node types
        await this.writeNodeStatus(runDir, node.id, outcome, nodeStartedAt, nodeStartTime);

        if (outcome.context_updates) {
          this.context.setMany(outcome.context_updates);
        }

        // GAP-11: Set outcome and preferred_label context keys after node completes
        this.context.set('outcome', outcome.status);
        this.context.set('preferred_label', outcome.preferred_label ?? '');
        this.context.set(`steps.${node.id}.notes`, outcome.notes ?? '');

        const completedAt = new Date().toISOString();
        await this.recordStepResult(node, outcome, completedAt);
        const durationMs = Date.now() - nodeStartTime;
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
          duration_ms: durationMs
        });

        if (outcome.status === 'failure') {
          if (outcome.error_message) {
            this.failureMessages.set(node.id, outcome.error_message);
          }
          this.emit({
            type: 'stage_failed',
            run_id: this.runState.run_id,
            node_id: node.id,
            outcome,
            completed_at: completedAt,
            duration_ms: durationMs,
          });
        }

        const parallelConvergenceTarget = this.resolveParallelConvergenceTarget(node, outcome);
        if (parallelConvergenceTarget && outcome.status !== 'failure') {
          // Root cause note: parallel nodes execute branches internally; the main
          // engine must advance directly to convergence rather than replay branches.
          await this.advanceToNode(node.id, parallelConvergenceTarget);
          continue;
        }

        if (outcome.status === 'failure' && !isTerminalExit) {
          const artifactScope = await this.buildConditionArtifactsScope();
          const failureResolution = resolveFailureTarget({
            node,
            graph: this.graph,
            context: this.context.snapshot(),
            steps: stepResultsToConditionState(this.runState.step_results),
            artifacts: artifactScope,
          });

          if (failureResolution.error) {
            return await this.finishError(failureResolution.error, node.id);
          }

          if (failureResolution.target) {
            // Root cause note (Sprint 026): retry_target/fallback failure cleanup paths
            // can reach Msquare; preserve failed terminal state explicitly.
            if (failureResolution.source !== 'edge') {
              this.terminalFailure = {
                failed_node_id: node.id,
                message: this.buildFailureMessage(node.id, outcome),
              };
            }

            if (failureResolution.edge) {
              this.emit({
                type: 'edge_selected',
                run_id: this.runState.run_id,
                node_id: node.id,
                edge: failureResolution.edge,
              });

              if (failureResolution.edge.loopRestart) {
                return await this.performLoopRestart(failureResolution.edge.target);
              }
            }

            await this.advanceToNode(node.id, failureResolution.target, failureResolution.edge);
            continue;
          }

          return await this.finishError(this.buildFailureMessage(node.id, outcome), node.id);
        }

        if (isTerminalExit) {
          // Root cause note (Sprint 025 Phase 1): terminal exits previously forced
          // run_completed even after upstream stage failures, so pipeline_failed was never emitted.
          const terminalFailure = this.resolveTerminalFailure(node.id);
          if (terminalFailure) {
            this.runState.current_node = undefined;
            return await this.finishError(terminalFailure.message, terminalFailure.failed_node_id);
          }
          this.runState.current_node = undefined;
          this.runState.status = 'completed';
          this.runState.context = this.context.snapshot();
          this.runState.updated_at = new Date().toISOString();
          await this.writeCanonicalCheckpoint();
          await this.sessionRegistry.closeAll();
          return this.finishCompleted(started);
        }

        const outgoing = this.graph.outgoing.get(node.id) ?? [];
        const artifactScope = await this.buildConditionArtifactsScope();
        const selected = selectNextEdge({
          edges: outgoing,
          outcome,
          context: this.context.snapshot(),
          preferred_label: outcome.preferred_label,
          steps: stepResultsToConditionState(this.runState.step_results),
          artifacts: artifactScope,
        });

        if (!selected) {
          return await this.finishError(
            `No next edge found after node '${node.id}' with outcome '${outcome.status}'.`,
            node.id,
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

        await this.advanceToNode(node.id, selected.target, selected);
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

  private seedArtifactCacheFromContext(): void {
    for (const alias of Object.keys(this.runState.artifact_aliases)) {
      const value = this.runState.context[alias];
      if (value !== undefined) {
        this.artifactValueCache.set(alias, value);
      }
    }
  }

  private async recordStepResult(node: GardenNode, outcome: NodeOutcome, updatedAt: string): Promise<void> {
    const aliasOutputs = new Map<string, { purpose: string; value: string; primary: boolean }>();

    const addAliasOutput = (
      alias: string,
      purpose: string,
      value: string | undefined,
      primary = false,
    ): void => {
      const preview = toOutputPreview(value);
      if (preview === undefined || preview.length === 0) {
        return;
      }
      aliasOutputs.set(alias, { purpose, value: preview, primary });
    };

    const contextUpdates = outcome.context_updates ?? {};
    const contextSnapshot = this.context.snapshot();

    if (node.kind === 'codergen') {
      addAliasOutput(
        `${node.id}.response`,
        'response',
        contextUpdates[`${node.id}.response`] ?? contextSnapshot[`${node.id}.response`],
        true,
      );
    }

    if (node.kind === 'tool') {
      addAliasOutput(`${node.id}.stdout`, 'stdout', outcome.stdout, true);
      addAliasOutput(`${node.id}.stderr`, 'stderr', outcome.stderr, true);
    }

    if (node.kind === 'wait.human') {
      addAliasOutput(`${node.id}.selection`, 'selection', outcome.preferred_label, true);
    }

    if (node.kind === 'parallel.fan_in') {
      addAliasOutput(
        `${node.id}.rationale`,
        'rationale',
        contextUpdates[`${node.id}.rationale`] ?? contextUpdates['parallel.fan_in.rationale'],
        true,
      );
    }

    for (const [key, value] of Object.entries(contextUpdates)) {
      if (!key.startsWith(`${node.id}.`)) {
        continue;
      }
      if (aliasOutputs.has(key)) {
        continue;
      }
      const suffix = key.slice(node.id.length + 1);
      addAliasOutput(key, suffix, value, false);
    }

    let primaryPreview: string | undefined;
    let primaryArtifactId: string | undefined;
    for (const [alias, output] of aliasOutputs.entries()) {
      const artifactId = await this.storeArtifactAlias(node.id, alias, output.purpose, output.value);
      if (output.primary && primaryPreview === undefined) {
        primaryPreview = output.value;
        primaryArtifactId = artifactId;
      }
    }

    if (primaryPreview === undefined) {
      primaryPreview = toOutputPreview(
        outcome.preferred_label
        ?? contextUpdates[`${node.id}.response`]
        ?? contextUpdates[`${node.id}.rationale`]
        ?? contextUpdates['parallel.fan_in.rationale']
        ?? outcome.stdout
        ?? outcome.stderr,
      );
    }

    this.runState.step_results[node.id] = createStepResultState({
      node_id: node.id,
      status: outcome.status,
      output_preview: primaryPreview,
      output_artifact_id: primaryArtifactId,
      updated_at: updatedAt,
    });
  }

  private async storeArtifactAlias(
    nodeId: string,
    alias: string,
    purpose: string,
    value: string,
  ): Promise<string | undefined> {
    if (!this.runStore) {
      return undefined;
    }

    const safePurpose = purpose.replace(/[^a-zA-Z0-9_-]+/g, '-');
    try {
      const artifactId = this.runStore.nextArtifactId(nodeId, safePurpose);
      await this.runStore.artifactStore().store(artifactId, alias, value);
      this.runState.artifact_aliases[alias] = artifactId;
      this.artifactValueCache.set(alias, value);
      return artifactId;
    } catch {
      return undefined;
    }
  }

  private async ensureArtifactAliasValuesLoaded(): Promise<void> {
    if (!this.runStore) {
      return;
    }

    const entries = Object.entries(this.runState.artifact_aliases);
    await Promise.all(entries.map(async ([alias, artifactId]) => {
      if (this.artifactValueCache.has(alias)) {
        return;
      }
      const value = await this.runStore!.artifactStore().retrieve(artifactId);
      this.artifactValueCache.set(alias, value ?? null);
    }));
  }

  private resolveArtifactAliasKey(key: string): string | undefined {
    if (Object.prototype.hasOwnProperty.call(this.runState.artifact_aliases, key)) {
      return key;
    }

    const candidates = [
      `${key}.response`,
      `${key}.stdout`,
      `${key}.stderr`,
      `${key}.selection`,
      `${key}.rationale`,
      `${key}.output`,
    ];
    for (const candidate of candidates) {
      if (Object.prototype.hasOwnProperty.call(this.runState.artifact_aliases, candidate)) {
        return candidate;
      }
    }

    const prefix = `${key}.`;
    const prefixed = Object.keys(this.runState.artifact_aliases).filter((alias) => alias.startsWith(prefix));
    if (prefixed.length === 0) {
      return undefined;
    }
    return prefixed.slice().sort()[0];
  }

  private async buildConditionArtifactsScope(): Promise<{
    has(key: string): boolean;
    get(key: string): string | undefined;
  }> {
    await this.ensureArtifactAliasValuesLoaded();
    return {
      has: (key: string): boolean => this.resolveArtifactAliasKey(key) !== undefined,
      get: (key: string): string | undefined => {
        const alias = this.resolveArtifactAliasKey(key);
        if (!alias) {
          return undefined;
        }
        const cached = this.artifactValueCache.get(alias);
        return cached === null ? undefined : cached;
      },
    };
  }

  private async performLoopRestart(targetNodeId: string): Promise<RunResult> {
    const DEFAULT_MAX_RESTART_DEPTH = 25;
    const maxRestartDepth = this.graph.maxRestartDepth ?? DEFAULT_MAX_RESTART_DEPTH;

    // Read current manifest to get restart depth
    const currentManifest = await this.runStore?.readManifest();
    const currentDepth = currentManifest?.restart_depth ?? 0;

    if (currentDepth + 1 > maxRestartDepth) {
      return await this.finishError(
        `Restart depth cap (${maxRestartDepth}) exceeded. Current depth: ${currentDepth}.`,
        targetNodeId,
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

  private async advanceToNode(sourceNodeId: string, targetNodeId: string, edge?: GardenEdge): Promise<void> {
    this.pendingTransition = {
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      edge: edge
        ? {
          label: edge.label,
          condition: edge.condition,
          weight: edge.weight,
          fidelity: edge.fidelity,
          thread_id: edge.threadId,
        }
        : {
          label: undefined,
          condition: undefined,
          weight: 0,
          fidelity: undefined,
          thread_id: undefined,
        },
    };

    this.runState.current_node = targetNodeId;
    this.runState.status = 'running';
    this.runState.context = this.context.snapshot();
    this.runState.updated_at = new Date().toISOString();
    this.runState.retry_state = { ...this.retryState };
    await this.writeCanonicalCheckpoint();
  }

  private buildFailureMessage(nodeId: string, outcome: NodeOutcome): string {
    const message = outcome.error_message
      ?? this.failureMessages.get(nodeId)
      ?? this.context.get(`${nodeId}.stderr`)
      ?? this.context.get('tool.stderr')
      ?? this.context.get(`${nodeId}.response`)
      ?? this.context.get(`${nodeId}.rationale`);
    return message
      ? `Node '${nodeId}' failed: ${message}`
      : `Node '${nodeId}' failed.`;
  }

  private resolveParallelConvergenceTarget(node: GardenNode, outcome: NodeOutcome): string | null {
    if (node.kind !== 'parallel') {
      return null;
    }

    const serialized = outcome.context_updates?.['parallel.results']
      ?? this.context.get('parallel.results')
      ?? outcome.context_updates?.[`parallel.results.${node.id}`]
      ?? this.context.get(`parallel.results.${node.id}`);
    if (!serialized) {
      return null;
    }

    try {
      const parsed = JSON.parse(serialized) as { convergenceNode?: string };
      if (!parsed.convergenceNode || !this.graph.nodeMap.has(parsed.convergenceNode)) {
        return null;
      }
      return parsed.convergenceNode;
    } catch {
      return null;
    }
  }

  private async checkGoalGates():
    Promise<{ target: string; terminal_failure?: { failed_node_id: string; message: string }; error?: undefined } | { error: string; target?: undefined } | null> {
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

    const firstFailed = failedGates[0]!;
    const artifactScope = await this.buildConditionArtifactsScope();
    const failureResolution = resolveFailureTarget({
      node: firstFailed,
      graph: this.graph,
      context: this.context.snapshot(),
      steps: stepResultsToConditionState(this.runState.step_results),
      artifacts: artifactScope,
    });

    if (failureResolution.error) {
      return { error: failureResolution.error };
    }

    if (!failureResolution.target) {
      return { error: `Goal gate '${firstFailed.id}' failed but no retry_target is defined.` };
    }

    if (failureResolution.source !== 'edge') {
      return {
        target: failureResolution.target,
        terminal_failure: {
          failed_node_id: firstFailed.id,
          message: `Goal gate '${firstFailed.id}' failed.`,
        },
      };
    }

    return { target: failureResolution.target };
  }

  private async writeNodeStatus(
    runDir: string,
    nodeId: string,
    outcome: NodeOutcome,
    startedAt: string,
    startTimeMs: number
  ): Promise<void> {
    try {
      const nodeDir = path.join(runDir, nodeId);
      await mkdir(nodeDir, { recursive: true });
      const completedAt = new Date().toISOString();
      const statusData = {
        outcome: outcome.status,
        status: outcome.status,
        node_id: nodeId,
        preferred_label: outcome.preferred_label ?? null,
        suggested_next_ids: outcome.suggested_next ?? [],
        context_updates: outcome.context_updates ?? {},
        notes: outcome.notes ?? '',
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: Date.now() - startTimeMs
      };
      await writeFile(path.join(nodeDir, 'status.json'), JSON.stringify(statusData, null, 2), 'utf8');
    } catch {
      // Best-effort status writing — don't fail the run
    }
  }

  private withSynthesizedOutcomeNotes(node: GardenNode, outcome: NodeOutcome): NodeOutcome {
    if (typeof outcome.notes === 'string' && outcome.notes.trim().length > 0) {
      return { ...outcome, notes: outcome.notes.trim() };
    }

    if (outcome.error_message && outcome.error_message.trim().length > 0) {
      return { ...outcome, notes: outcome.error_message.trim() };
    }

    if (node.kind === 'tool' && typeof outcome.exit_code === 'number') {
      return { ...outcome, notes: `Exit code ${outcome.exit_code}` };
    }

    return { ...outcome, notes: `Node '${node.id}' completed with outcome '${outcome.status}'.` };
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

  private async finishError(message: string, failedNodeId?: string): Promise<RunResult> {
    this.runState.status = 'failed';
    this.runState.context = this.context.snapshot();
    this.runState.updated_at = new Date().toISOString();
    this.runState.retry_state = { ...this.retryState };

    await this.writeCanonicalCheckpoint();
    await this.sessionRegistry.closeAll();

    const failedAt = new Date().toISOString();
    const resolvedFailedNodeId =
      failedNodeId
      ?? this.runState.current_node
      ?? this.runState.completed_nodes.at(-1)?.node_id
      ?? 'unknown';
    this.emit({
      type: 'run_error',
      run_id: this.runState.run_id,
      status: 'failed',
      message
    });
    this.emitPipelineFailed({
      failed_at: failedAt,
      failed_node_id: resolvedFailedNodeId,
      message,
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
      completed_nodes: this.runState.completed_nodes.length,
      artifact_count: this.countTrackedArtifacts(),
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
      graph_hash_kind: this.graphHashKind,
      started_at: this.runState.started_at,
      updated_at: this.runState.updated_at,
      status: this.runState.status,
      interruption_reason: this.runState.interruption_reason,
      completed_nodes: this.runState.completed_nodes.slice(),
      current_node: this.runState.current_node,
      context: this.context.snapshot(),
      retry_state: { ...this.retryState },
      logs: this.logs.slice(),
      pending_transition: this.pendingTransition,
      resume_requires_degraded_fidelity: this.resumeRequiresDegradedFidelity || undefined,
      thread_registry_keys: this.sessionRegistry.getKeys().length > 0
        ? this.sessionRegistry.getKeys()
        : undefined,
      step_results: Object.keys(this.runState.step_results).length > 0
        ? { ...this.runState.step_results }
        : undefined,
      artifact_aliases: Object.keys(this.runState.artifact_aliases).length > 0
        ? { ...this.runState.artifact_aliases }
        : undefined,
    };
  }

  private countTrackedArtifacts(): number {
    return new Set(Object.values(this.runState.artifact_aliases)).size;
  }

  private resolveTerminalFailure(terminalNodeId: string): { failed_node_id: string; message: string } | null {
    if (this.terminalFailure) {
      return this.terminalFailure;
    }

    // Root cause: failure edges can still land on a terminal exit node; without this
    // check the run finalized as completed and skipped pipeline_failed emission.
    const terminalCompletion = this.runState.completed_nodes.at(-1);
    if (!terminalCompletion || terminalCompletion.node_id !== terminalNodeId || terminalCompletion.status !== 'failure') {
      return null;
    }

    const failureMessage = this.failureMessages.get(terminalNodeId)
      ?? this.context.get(`${terminalNodeId}.stderr`)
      ?? this.context.get('tool.stderr')
      ?? this.context.get(`${terminalNodeId}.response`)
      ?? this.context.get(`${terminalNodeId}.rationale`);

    return {
      failed_node_id: terminalNodeId,
      message: failureMessage
        ? `Terminal node '${terminalNodeId}' failed: ${failureMessage}`
        : `Terminal node '${terminalNodeId}' failed.`,
    };
  }

  private emitPipelineFailed(payload: { failed_at: string; failed_node_id: string; message: string }): void {
    if (this.pipelineFailedEmitted) {
      return;
    }
    this.pipelineFailedEmitted = true;

    this.emit({
      type: 'pipeline_failed',
      run_id: this.runState.run_id,
      status: 'failed',
      final_status: 'failed',
      failed_node_id: payload.failed_node_id,
      message: payload.message,
      failed_at: payload.failed_at,
    });
  }

  private emit(event: RunEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

interface ResolvedRetryConfig {
  max_retries: number;
  preset?: RetryPreset;
}

export interface ResolveFailureTargetInput {
  node: GardenNode;
  graph: GardenGraph;
  context: Record<string, string>;
  steps?: Record<string, { status: string; output?: string }>;
  artifacts?: {
    has(key: string): boolean;
    get(key: string): string | undefined;
  };
  edge_selector?: typeof selectNextEdge;
}

export interface ResolvedFailureTarget {
  target: string | null;
  edge?: GardenEdge;
  source: 'edge' | 'node_retry_target' | 'node_fallback_retry_target' | 'graph_retry_target' | 'graph_fallback_retry_target' | 'none';
  error?: string;
}

function resolveRetryConfig(
  node: GardenNode,
  graph: GardenGraph,
  fallbackDefaultMaxRetries?: number,
): ResolvedRetryConfig {
  const nodePreset = node.retryPolicy ? getRetryPreset(node.retryPolicy) : undefined;
  const graphPreset = graph.defaultRetryPolicy ? getRetryPreset(graph.defaultRetryPolicy) : undefined;

  let maxRetries: number;
  if (node.maxRetries !== undefined) {
    maxRetries = node.maxRetries;
  } else if (nodePreset) {
    maxRetries = nodePreset.max_retries;
  } else if (graphPreset) {
    maxRetries = graphPreset.max_retries;
  } else if (graph.defaultMaxRetries !== undefined) {
    maxRetries = graph.defaultMaxRetries;
  } else {
    maxRetries = fallbackDefaultMaxRetries ?? 0;
  }

  if (maxRetries <= 0) {
    return { max_retries: 0 };
  }

  return {
    max_retries: maxRetries,
    preset: nodePreset ?? graphPreset ?? RETRY_PRESETS.standard,
  };
}

function isFailureConditionExpression(condition: string | undefined): boolean {
  if (!condition) {
    return false;
  }
  return /\boutcome\s*=\s*(["'])?(?:fail|failure)\1/i.test(condition);
}

function validateFailureTarget(graph: GardenGraph, owner: string, attrName: string, target: string): string | undefined {
  if (!graph.nodeMap.has(target)) {
    return `Node '${owner}' has ${attrName} '${target}' which does not exist in the graph.`;
  }
  return undefined;
}

export function resolveFailureTarget(input: ResolveFailureTargetInput): ResolvedFailureTarget {
  const edgeSelector = input.edge_selector ?? selectNextEdge;
  const failureOutcome: NodeOutcome = { status: 'failure' };
  const outgoing = input.graph.outgoing.get(input.node.id) ?? [];
  const failureConditionEdges = outgoing.filter((edge) => isFailureConditionExpression(edge.condition));

  if (failureConditionEdges.length > 0) {
    const selected = edgeSelector({
      edges: failureConditionEdges,
      outcome: failureOutcome,
      context: input.context,
      steps: input.steps,
      artifacts: input.artifacts,
    });
    if (selected) {
      return {
        target: selected.target,
        edge: selected,
        source: 'edge',
      };
    }
  }

  if (input.node.retryTarget) {
    const error = validateFailureTarget(input.graph, input.node.id, 'retry_target', input.node.retryTarget);
    if (error) {
      return {
        target: null,
        source: 'none',
        error,
      };
    }
    return {
      target: input.node.retryTarget,
      source: 'node_retry_target',
    };
  }

  if (input.node.fallbackRetryTarget) {
    const error = validateFailureTarget(
      input.graph,
      input.node.id,
      'fallback_retry_target',
      input.node.fallbackRetryTarget,
    );
    if (error) {
      return {
        target: null,
        source: 'none',
        error,
      };
    }
    return {
      target: input.node.fallbackRetryTarget,
      source: 'node_fallback_retry_target',
    };
  }

  const graphRetryTarget = input.graph.graphAttributes.retry_target?.trim();
  if (graphRetryTarget) {
    const error = validateFailureTarget(input.graph, 'graph', 'retry_target', graphRetryTarget);
    if (error) {
      return {
        target: null,
        source: 'none',
        error,
      };
    }
    return {
      target: graphRetryTarget,
      source: 'graph_retry_target',
    };
  }

  const graphFallbackRetryTarget = input.graph.graphAttributes.fallback_retry_target?.trim();
  if (graphFallbackRetryTarget) {
    const error = validateFailureTarget(input.graph, 'graph', 'fallback_retry_target', graphFallbackRetryTarget);
    if (error) {
      return {
        target: null,
        source: 'none',
        error,
      };
    }
    return {
      target: graphFallbackRetryTarget,
      source: 'graph_fallback_retry_target',
    };
  }

  return {
    target: null,
    source: 'none',
  };
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
  const stepResults: Record<string, import('./step-state.js').StepResultState> = {};
  let nodeStartIndex = 0;
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
      index: ++nodeStartIndex,
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

    let outcome: NodeOutcome;
    try {
      outcome = await handlers.resolve(node).execute({
        node,
        run_id: runId,
        dot_file: dotFile,
        attempt,
        run_dir: runDir,
        context: context.snapshot(),
        abort_signal: abortSignal,
        outgoing_edges: outgoingEdges,
        emitEvent: (event) => emit(event),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = {
        status: 'failure',
        error_message: `Node '${node.id}' threw an unhandled error: ${message}`,
      };
    }

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

    const retryConfig = resolveRetryConfig(node, graph, defaultMaxRetries);
    const maxRetries = retryConfig.max_retries;
    const eligibleForRetry = retryCount < maxRetries && shouldRetry(outcome);
    if (eligibleForRetry) {
      const nextRetryCount = retryCount + 1;
      retryState[node.id] = nextRetryCount;
      context.set(`internal.retry_count.${node.id}`, String(nextRetryCount));

      const delayMs = retryConfig.preset ? computeBackoff(nextRetryCount, retryConfig.preset) : 0;
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
    const sequencePreview = toOutputPreview(
      outcome.preferred_label
      ?? outcome.context_updates?.[`${node.id}.response`]
      ?? outcome.stdout
      ?? outcome.stderr
      ?? outcome.context_updates?.[`${node.id}.rationale`]
      ?? outcome.context_updates?.['parallel.fan_in.rationale'],
    );
    stepResults[node.id] = createStepResultState({
      node_id: node.id,
      status: outcome.status,
      output_preview: sequencePreview,
      updated_at: completedAt,
    });
    const durationMs = Date.now() - nodeStartTime;
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
      duration_ms: durationMs
    });

    if (outcome.status === 'failure') {
      emit({
        type: 'stage_failed',
        run_id: runId,
        node_id: node.id,
        outcome,
        completed_at: completedAt,
        duration_ms: durationMs,
      });
    }

    const outgoing = graph.outgoing.get(node.id) ?? [];
    if (outgoing.length === 0) {
      // Dead end
      return { completedNodes, lastOutcome: outcome };
    }

    const selected = selectNextEdge({
      edges: outgoing,
      outcome,
      context: context.snapshot(),
      preferred_label: outcome.preferred_label,
      steps: stepResultsToConditionState(stepResults),
      artifacts: {
        has: (_key: string) => false,
        get: (_key: string) => undefined,
      },
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
