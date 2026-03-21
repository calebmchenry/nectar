import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PipelineEngine } from '../engine/engine.js';
import type { RunEvent } from '../engine/events.js';
import type { RunResult, RunStatus } from '../engine/types.js';
import type { CompletedNodeState } from '../engine/types.js';
import { RunStore } from '../checkpoint/run-store.js';
import type { Cocoon } from '../checkpoint/types.js';
import {
  PipelineConflictError,
  PipelineDiagnosticsError,
  PipelineNotFoundError,
  PipelineLoadResult,
  PipelineService,
} from '../runtime/pipeline-service.js';
import { AutoApproveInterviewer } from '../interviewer/auto-approve.js';
import type { Answer } from '../interviewer/types.js';
import { EventJournal } from './event-journal.js';
import { HttpInterviewer } from './http-interviewer.js';
import { QuestionStore, type StoredQuestion } from './question-store.js';
import type { EventEnvelope, PipelineStatusResponse } from './types.js';

const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const DEFAULT_COMPLETED_TTL_MS = 60 * 60_000;
type RunLaunchOrigin = 'seedbed' | 'seed_cli' | 'pipeline_api' | 'garden_hive';

export interface RunManagerOptions {
  workspace_root: string;
  pipeline_service: PipelineService;
  max_concurrent_runs?: number;
  completed_ttl_ms?: number;
}

export interface StartPipelineInput {
  dot_path?: string;
  dot_source?: string;
  auto_approve?: boolean;
  seed_id?: number;
  seed_dir?: string;
  seed_garden?: string;
  launch_origin?: RunLaunchOrigin;
}

export interface ResumePipelineInput {
  run_id: string;
  auto_approve?: boolean;
  force?: boolean;
  seed_id?: number;
  seed_dir?: string;
  seed_garden?: string;
  launch_origin?: RunLaunchOrigin;
}

export interface StartPipelineResult {
  run_id: string;
  status: 'running';
}

export interface ResumePipelineResult {
  run_id: string;
  status: 'running';
}

export interface CancelPipelineResult extends PipelineStatusResponse {
  checkpoint_id: string;
}

type EnvelopeSubscriber = (envelope: EventEnvelope) => void;
type ActiveLifecycle = 'booting' | 'running' | 'cancelling' | 'terminal';

interface ActiveRunEntry {
  run_id: string;
  run_dir: string;
  dot_file: string;
  dot_source?: string;
  status: RunStatus;
  started_at: string;
  updated_at: string;
  current_node?: string;
  completed_nodes: string[];
  interruption_reason?: string;
  journal: EventJournal;
  question_store: QuestionStore;
  subscribers: Set<EnvelopeSubscriber>;
  event_chain: Promise<void>;
  completion?: Promise<RunResult>;
  engine?: PipelineEngine;
  lifecycle: ActiveLifecycle;
  pending_abort_reason?: string;
  cleanup_timer?: ReturnType<typeof setTimeout>;
}

export class RunManager {
  private readonly workspaceRoot: string;
  private readonly pipelineService: PipelineService;
  private readonly maxConcurrentRuns: number;
  private readonly completedTtlMs: number;
  private readonly activeRuns = new Map<string, ActiveRunEntry>();

  constructor(options: RunManagerOptions) {
    this.workspaceRoot = options.workspace_root;
    this.pipelineService = options.pipeline_service;
    this.maxConcurrentRuns = options.max_concurrent_runs ?? DEFAULT_MAX_CONCURRENT_RUNS;
    this.completedTtlMs = options.completed_ttl_ms ?? DEFAULT_COMPLETED_TTL_MS;
  }

  async startPipeline(input: StartPipelineInput): Promise<StartPipelineResult> {
    this.enforceConcurrencyLimit();

    const hasPath = typeof input.dot_path === 'string' && input.dot_path.trim().length > 0;
    const hasSource = typeof input.dot_source === 'string' && input.dot_source.trim().length > 0;
    if (hasPath === hasSource) {
      throw new PipelineDiagnosticsError('Exactly one of dot_path or dot_source is required.', []);
    }

    const runId = randomUUID();
    const runDir = this.runDirectory(runId);
    await mkdir(runDir, { recursive: true });

    let load;
    let dotFile: string;
    if (hasPath) {
      const safePath = this.pipelineService.resolvePathWithinWorkspace(input.dot_path!.trim());
      load = await this.pipelineService.loadFromPath(safePath);
      dotFile = safePath;
    } else {
      dotFile = path.join(runDir, 'input.dot');
      load = await this.pipelineService.loadFromSource(input.dot_source!, dotFile);
      await writeFile(dotFile, input.dot_source!, 'utf8');
    }

    if (!load.graph || hasErrors(load.diagnostics)) {
      throw new PipelineDiagnosticsError('Pipeline validation failed.', load.diagnostics);
    }
    await this.writePreparedArtifacts(runDir, load);

    const entry = await this.createEntry({
      run_id: runId,
      run_dir: runDir,
      dot_file: dotFile,
      dot_source: load.prepared_dot ?? load.graph.dotSource,
      auto_approve: input.auto_approve,
    });

    entry.completion = this.pipelineService
      .executePipeline({
        graph: load.graph,
        graph_hash: load.graph_hash ?? '',
        graph_hash_kind: load.graph_hash_kind,
        prepared_dot: load.prepared_dot,
        source_files: load.source_files,
        interviewer: input.auto_approve ? new AutoApproveInterviewer() : this.createHttpInterviewer(entry),
        on_event: (event) => this.enqueueEvent(entry, event),
        run_id: runId,
        register_signal_handlers: false,
        on_engine: (engine) => {
          this.attachEngine(entry, engine);
        },
        seed_id: input.seed_id,
        seed_dir: input.seed_dir,
        seed_garden: input.seed_garden,
        launch_origin: input.launch_origin,
      })
      .then(async (result) => {
        await this.completeEntry(entry, result);
        return result;
      })
      .catch(async (error) => {
        await this.failEntry(entry, error);
        throw error;
      });

    return { run_id: runId, status: 'running' };
  }

  async resumePipeline(input: ResumePipelineInput): Promise<ResumePipelineResult> {
    this.enforceConcurrencyLimit();

    const resolvedRunId = await this.pipelineService.resolveLatestRunId(input.run_id);
    const existing = this.activeRuns.get(resolvedRunId);
    if (existing && existing.lifecycle !== 'terminal') {
      throw new PipelineConflictError(`Run '${resolvedRunId}' is already running.`);
    }

    const cocoon = await RunStore.readCocoon(resolvedRunId, this.workspaceRoot);
    if (!cocoon) {
      throw new PipelineNotFoundError(`Run '${resolvedRunId}' not found.`);
    }

    const entry = await this.createEntry({
      run_id: resolvedRunId,
      run_dir: this.runDirectory(resolvedRunId),
      dot_file: cocoon.dot_file,
      auto_approve: input.auto_approve,
      started_at: cocoon.started_at,
      status: 'running',
      current_node: cocoon.current_node,
      completed_nodes: cocoon.completed_nodes.map((node) => node.node_id),
    });
    await entry.question_store.close({
      disposition: 'interrupted',
      reason: 'Run resumed; stale pending questions were archived.',
    });

    entry.completion = this.pipelineService
      .resumePipeline({
        run_id: resolvedRunId,
        force: input.force,
        interviewer: input.auto_approve ? new AutoApproveInterviewer() : this.createHttpInterviewer(entry),
        on_event: (event) => this.enqueueEvent(entry, event),
        register_signal_handlers: false,
        on_engine: (engine) => {
          this.attachEngine(entry, engine);
        },
        seed_id: input.seed_id,
        seed_dir: input.seed_dir,
        seed_garden: input.seed_garden,
        launch_origin: input.launch_origin,
      })
      .then(async (result) => {
        await this.completeEntry(entry, result.run_result);
        return result.run_result;
      })
      .catch(async (error) => {
        await this.failEntry(entry, error);
        throw error;
      });

    return { run_id: resolvedRunId, status: 'running' };
  }

  getActive(runId: string): ActiveRunEntry | undefined {
    return this.activeRuns.get(runId);
  }

  listActive(): PipelineStatusResponse[] {
    return Array.from(this.activeRuns.values()).map((entry) => toStatusResponse(entry));
  }

  async cancel(runId: string): Promise<CancelPipelineResult> {
    const entry = this.activeRuns.get(runId);
    if (!entry) {
      const checkpoint = await RunStore.readCocoon(runId, this.workspaceRoot);
      if (!checkpoint) {
        throw new PipelineNotFoundError(`Run '${runId}' not found.`);
      }
      if (checkpoint.status === 'interrupted') {
        return {
          ...cocoonToStatus(checkpoint),
          checkpoint_id: runId,
        };
      }
      throw new PipelineConflictError(`Run '${runId}' is already ${checkpoint.status}.`);
    }

    if (entry.status === 'interrupted') {
      return {
        ...toStatusResponse(entry),
        checkpoint_id: runId,
      };
    }

    if (entry.lifecycle === 'terminal' || entry.status !== 'running') {
      throw new PipelineConflictError(`Run '${runId}' is already ${entry.status}.`);
    }

    if (!entry.engine || entry.lifecycle === 'booting') {
      // Root cause note (Sprint 025 Phase 1): cancel could race engine bootstrap.
      // Queueing the abort reason here ensures resume never waits on a never-aborted run.
      entry.pending_abort_reason = 'api_cancel';
      entry.lifecycle = 'cancelling';
    } else if (entry.lifecycle !== 'cancelling') {
      entry.lifecycle = 'cancelling';
      entry.engine.abort('api_cancel');
    }

    await entry.question_store.close({
      disposition: 'interrupted',
      reason: 'Run cancelled via API.',
    });

    try {
      await entry.completion;
    } catch {
      // completion status is persisted by the engine path; surface latest status below
    }

    const status = (await this.getStatus(runId)) ?? toStatusResponse(entry);
    if (status.status !== 'interrupted') {
      throw new PipelineConflictError(`Run '${runId}' is already ${status.status}.`);
    }
    return {
      ...status,
      checkpoint_id: runId,
    };
  }

  async getStatus(runId: string): Promise<PipelineStatusResponse | null> {
    const active = this.activeRuns.get(runId);
    if (active) {
      const checkpoint = await RunStore.readCocoon(runId, this.workspaceRoot);
      const completedNodes = mergeCompletedNodeIds(checkpoint?.completed_nodes, active.completed_nodes);
      const currentNode = resolveCurrentNode(active, checkpoint?.current_node);
      const base = toStatusResponse(active);
      const updatedAt = latestIsoTimestamp(base.updated_at, checkpoint?.updated_at);

      return {
        ...base,
        updated_at: updatedAt,
        current_node: currentNode,
        completed_nodes: completedNodes,
        completed_count: completedNodes.length,
        interruption_reason: active.interruption_reason ?? checkpoint?.interruption_reason,
      };
    }

    const cocoon = await RunStore.readCocoon(runId, this.workspaceRoot);
    if (!cocoon) {
      return null;
    }

    return cocoonToStatus(cocoon);
  }

  async getCheckpoint(runId: string): Promise<Cocoon | null> {
    return RunStore.readCocoon(runId, this.workspaceRoot);
  }

  async getContext(runId: string): Promise<Record<string, string> | null> {
    const active = this.activeRuns.get(runId);
    if (active) {
      const inFlightCheckpoint = await RunStore.readCocoon(runId, this.workspaceRoot);
      const liveContext = active.engine?.getContextSnapshot();
      const baseContext = liveContext ?? inFlightCheckpoint?.context ?? {};
      return withLiveCurrentNode(baseContext, resolveCurrentNode(active, inFlightCheckpoint?.current_node));
    }

    const cocoon = await RunStore.readCocoon(runId, this.workspaceRoot);
    if (!cocoon) {
      return null;
    }
    return withLiveCurrentNode(cocoon.context, cocoon.current_node);
  }

  async getGraphExecutionState(runId: string): Promise<{ status: RunStatus; current_node?: string; completed_nodes: CompletedNodeState[] } | null> {
    const active = this.activeRuns.get(runId);
    if (active) {
      const inFlightCheckpoint = await RunStore.readCocoon(runId, this.workspaceRoot);
      return {
        status: active.status,
        current_node: resolveCurrentNode(active, inFlightCheckpoint?.current_node),
        completed_nodes: mergeCompletedNodeStates(inFlightCheckpoint?.completed_nodes, active.completed_nodes),
      };
    }

    const cocoon = await RunStore.readCocoon(runId, this.workspaceRoot);
    if (cocoon) {
      return {
        status: cocoon.status,
        current_node: cocoon.current_node,
        completed_nodes: cocoon.completed_nodes,
      };
    }
    return null;
  }

  async getPendingQuestions(runId: string): Promise<StoredQuestion[]> {
    const entry = this.activeRuns.get(runId);
    if (entry) {
      return entry.question_store.listPending();
    }

    const questionStore = new QuestionStore(this.runDirectory(runId));
    return questionStore.listPending();
  }

  async submitAnswer(
    runId: string,
    questionId: string,
    answer: string | (Partial<Answer> & { selected_label?: string; selected_option?: number | string; text?: string })
  ): Promise<StoredQuestion> {
    const entry = this.activeRuns.get(runId);
    if (!entry) {
      throw new PipelineConflictError(`Run '${runId}' is not active.`);
    }

    try {
      return await entry.question_store.submitAnswer(questionId, answer, 'user');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not found')) {
        throw new PipelineNotFoundError(message);
      }
      if (message.includes('already') || message.includes('no active waiter') || message.includes('not currently awaiting')) {
        throw new PipelineConflictError(message);
      }
      throw error;
    }
  }

  subscribe(runId: string, callback: EnvelopeSubscriber): (() => void) | null {
    const entry = this.activeRuns.get(runId);
    if (!entry) {
      return null;
    }
    entry.subscribers.add(callback);
    return () => {
      entry.subscribers.delete(callback);
    };
  }

  async openJournal(runId: string): Promise<EventJournal> {
    return EventJournal.open(path.join(this.runDirectory(runId), 'events.ndjson'));
  }

  async readDotSource(runId: string): Promise<string | null> {
    const active = this.activeRuns.get(runId);
    if (active?.dot_source) {
      return active.dot_source;
    }

    const runDir = this.runDirectory(runId);
    const preparedDotPath = path.join(runDir, 'prepared.dot');
    try {
      return await readFile(preparedDotPath, 'utf8');
    } catch {
      // fall through
    }

    const inputDotPath = path.join(runDir, 'input.dot');
    try {
      return await readFile(inputDotPath, 'utf8');
    } catch {
      // fall through
    }

    const cocoon = await RunStore.readCocoon(runId, this.workspaceRoot);
    if (!cocoon) {
      return null;
    }

    try {
      return await readFile(cocoon.dot_file, 'utf8');
    } catch {
      return null;
    }
  }

  async markOrphanedRuns(): Promise<number> {
    const cocoonsRoot = path.join(this.workspaceRoot, '.nectar', 'cocoons');
    let entries;
    try {
      entries = await readdir(cocoonsRoot, { withFileTypes: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return 0;
      }
      throw error;
    }

    let marked = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const runId = entry.name;
      const cocoon = await RunStore.readCocoon(runId, this.workspaceRoot);
      if (!cocoon || cocoon.status !== 'running') {
        continue;
      }

      const store = new RunStore(runId, this.workspaceRoot);
      await store.writeCheckpoint({
        ...cocoon,
        status: 'interrupted',
        interruption_reason: 'server_startup_orphaned',
        updated_at: new Date().toISOString(),
      });
      marked += 1;
    }

    return marked;
  }

  async shutdown(reason = 'server_shutdown'): Promise<void> {
    const entries = Array.from(this.activeRuns.values());
    for (const entry of entries) {
      if (entry.status === 'running') {
        entry.engine?.abort(reason);
      }
    }

    await Promise.allSettled(entries.map((entry) => entry.completion));

    for (const entry of entries) {
      await Promise.allSettled([
        entry.event_chain,
        entry.journal.flush(),
        entry.question_store.close({
          disposition: 'interrupted',
          reason: `Run manager shutdown (${reason}).`,
        }),
      ]);
      if (entry.cleanup_timer) {
        clearTimeout(entry.cleanup_timer);
      }
    }

    this.activeRuns.clear();
  }

  private async createEntry(input: {
    run_id: string;
    run_dir: string;
    dot_file: string;
    dot_source?: string;
    auto_approve?: boolean;
    started_at?: string;
    status?: RunStatus;
    current_node?: string;
    completed_nodes?: string[];
  }): Promise<ActiveRunEntry> {
    await mkdir(input.run_dir, { recursive: true });

    const journal = await EventJournal.open(path.join(input.run_dir, 'events.ndjson'));
    const questionStore = new QuestionStore(input.run_dir);
    await questionStore.initialize();

    const now = new Date().toISOString();
    const entry: ActiveRunEntry = {
      run_id: input.run_id,
      run_dir: input.run_dir,
      dot_file: input.dot_file,
      dot_source: input.dot_source,
      status: input.status ?? 'running',
      started_at: input.started_at ?? now,
      updated_at: now,
      current_node: input.current_node,
      completed_nodes: input.completed_nodes ?? [],
      journal,
      question_store: questionStore,
      subscribers: new Set(),
      event_chain: Promise.resolve(),
      lifecycle: 'booting',
    };

    if (entry.cleanup_timer) {
      clearTimeout(entry.cleanup_timer);
    }

    this.activeRuns.set(entry.run_id, entry);
    return entry;
  }

  private createHttpInterviewer(entry: ActiveRunEntry): HttpInterviewer {
    return new HttpInterviewer(entry.question_store);
  }

  private attachEngine(entry: ActiveRunEntry, engine: PipelineEngine): void {
    entry.engine = engine;
    if (entry.pending_abort_reason) {
      entry.lifecycle = 'cancelling';
      engine.abort(entry.pending_abort_reason);
      return;
    }
    if (entry.lifecycle === 'booting') {
      entry.lifecycle = 'running';
    }
  }

  private enqueueEvent(entry: ActiveRunEntry, event: RunEvent): void {
    entry.event_chain = entry.event_chain
      .then(async () => {
        const envelope = await entry.journal.append(event);
        applyEventToEntry(entry, envelope);
        for (const subscriber of entry.subscribers) {
          subscriber(envelope);
        }
      })
      .catch(() => {
        // Keep the chain alive if a previous append failed.
      });
  }

  private async completeEntry(entry: ActiveRunEntry, result: RunResult): Promise<void> {
    await entry.event_chain;
    await entry.journal.flush();
    entry.status = result.status;
    entry.lifecycle = 'terminal';
    entry.updated_at = new Date().toISOString();
    entry.interruption_reason = result.interruption_reason;
    entry.current_node = undefined;
    await entry.question_store.close({
      disposition: result.status === 'interrupted' ? 'interrupted' : 'timed_out',
      reason: `Run finished with status '${result.status}'.`,
    });
    this.scheduleCleanup(entry);
  }

  private async failEntry(entry: ActiveRunEntry, _error: unknown): Promise<void> {
    await entry.event_chain;
    await entry.journal.flush();
    entry.status = 'failed';
    entry.lifecycle = 'terminal';
    entry.updated_at = new Date().toISOString();
    await entry.question_store.close({
      disposition: 'timed_out',
      reason: 'Run failed.',
    });
    this.scheduleCleanup(entry);
  }

  private scheduleCleanup(entry: ActiveRunEntry): void {
    if (entry.cleanup_timer) {
      clearTimeout(entry.cleanup_timer);
    }

    if (this.completedTtlMs <= 0) {
      this.activeRuns.delete(entry.run_id);
      return;
    }

    entry.cleanup_timer = setTimeout(() => {
      this.activeRuns.delete(entry.run_id);
    }, this.completedTtlMs);
    entry.cleanup_timer.unref?.();
  }

  private enforceConcurrencyLimit(): void {
    let runningCount = 0;
    for (const entry of this.activeRuns.values()) {
      if (entry.status === 'running') {
        runningCount += 1;
      }
    }
    if (runningCount >= this.maxConcurrentRuns) {
      throw new PipelineConflictError(
        `Max concurrent runs exceeded (${this.maxConcurrentRuns}). Wait for an active run to finish.`
      );
    }
  }

  private runDirectory(runId: string): string {
    return path.join(this.workspaceRoot, '.nectar', 'cocoons', runId);
  }

  private async writePreparedArtifacts(runDir: string, load: PipelineLoadResult): Promise<void> {
    if (!load.prepared_dot) {
      return;
    }

    const preparedDotPath = path.join(runDir, 'prepared.dot');
    await writeFile(preparedDotPath, load.prepared_dot, 'utf8');

    const sourceManifest = {
      graph_hash: load.graph_hash ?? '',
      graph_hash_kind: load.graph_hash_kind ?? 'prepared',
      source_files: load.source_files ?? [],
    };
    await writeFile(
      path.join(runDir, 'source-manifest.json'),
      `${JSON.stringify(sourceManifest, null, 2)}\n`,
      'utf8',
    );
  }
}

function hasErrors(diagnostics: Array<{ severity: string }>): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function applyEventToEntry(entry: ActiveRunEntry, envelope: EventEnvelope): void {
  entry.updated_at = envelope.timestamp;

  const event = envelope.event;
  if (event.type === 'run_started') {
    entry.started_at = event.started_at;
    entry.dot_file = event.dot_file;
    entry.status = 'running';
    if (entry.lifecycle === 'booting' && !entry.pending_abort_reason) {
      entry.lifecycle = 'running';
    }
    return;
  }
  if (event.type === 'node_started') {
    entry.current_node = event.node_id;
    return;
  }
  if (event.type === 'node_completed') {
    if (!entry.completed_nodes.includes(event.node_id)) {
      entry.completed_nodes.push(event.node_id);
    }
    if (entry.current_node === event.node_id) {
      entry.current_node = undefined;
    }
    return;
  }
  if (event.type === 'run_completed') {
    entry.status = 'completed';
    entry.current_node = undefined;
    return;
  }
  if (event.type === 'run_interrupted') {
    entry.status = 'interrupted';
    entry.interruption_reason = event.reason;
    entry.current_node = undefined;
    return;
  }
  if (event.type === 'run_error') {
    entry.status = 'failed';
    entry.current_node = undefined;
    return;
  }
}

function toStatusResponse(entry: ActiveRunEntry): PipelineStatusResponse {
  const nowMs = Date.now();
  const startedMs = Date.parse(entry.started_at);
  return {
    run_id: entry.run_id,
    status: entry.status,
    dot_file: entry.dot_file,
    started_at: entry.started_at,
    updated_at: entry.updated_at,
    duration_ms: Number.isNaN(startedMs) ? 0 : Math.max(0, nowMs - startedMs),
    current_node: entry.current_node,
    completed_nodes: entry.completed_nodes.slice(),
    completed_count: entry.completed_nodes.length,
    interruption_reason: entry.interruption_reason,
  };
}

function cocoonToStatus(cocoon: Cocoon): PipelineStatusResponse {
  const startedMs = Date.parse(cocoon.started_at);
  const updatedMs = Date.parse(cocoon.updated_at);
  const durationMs =
    Number.isNaN(startedMs) || Number.isNaN(updatedMs) ? 0 : Math.max(0, updatedMs - startedMs);

  return {
    run_id: cocoon.run_id,
    status: cocoon.status,
    dot_file: cocoon.dot_file,
    started_at: cocoon.started_at,
    updated_at: cocoon.updated_at,
    duration_ms: durationMs,
    current_node: cocoon.current_node,
    completed_nodes: cocoon.completed_nodes.map((node) => node.node_id),
    completed_count: cocoon.completed_nodes.length,
    interruption_reason: cocoon.interruption_reason,
  };
}

function withLiveCurrentNode(
  context: Record<string, string>,
  currentNode: string | undefined,
): Record<string, string> {
  if (!currentNode) {
    return context;
  }
  if (context.current_node) {
    return context;
  }
  return {
    ...context,
    current_node: currentNode,
  };
}

function resolveCurrentNode(entry: ActiveRunEntry, checkpointCurrentNode: string | undefined): string | undefined {
  const fromEngine = normalizeCurrentNode(entry.engine?.getContextSnapshot().current_node);
  if (fromEngine) {
    return fromEngine;
  }
  const fromCheckpoint = normalizeCurrentNode(checkpointCurrentNode);
  if (fromCheckpoint) {
    return fromCheckpoint;
  }
  return normalizeCurrentNode(entry.current_node);
}

function normalizeCurrentNode(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function mergeCompletedNodeStates(
  checkpointNodes: CompletedNodeState[] | undefined,
  entryNodeIds: string[],
): CompletedNodeState[] {
  const merged: CompletedNodeState[] = [];
  const seen = new Set<string>();

  for (const checkpointNode of checkpointNodes ?? []) {
    merged.push(checkpointNode);
    seen.add(checkpointNode.node_id);
  }

  const now = new Date().toISOString();
  for (const nodeId of entryNodeIds) {
    if (seen.has(nodeId)) {
      continue;
    }
    merged.push({
      node_id: nodeId,
      status: 'success',
      started_at: now,
      completed_at: now,
      retries: 0,
    });
    seen.add(nodeId);
  }

  return merged;
}

function mergeCompletedNodeIds(
  checkpointNodes: CompletedNodeState[] | undefined,
  entryNodeIds: string[],
): string[] {
  return mergeCompletedNodeStates(checkpointNodes, entryNodeIds).map((node) => node.node_id);
}

function latestIsoTimestamp(primary: string, secondary?: string): string {
  if (!secondary) {
    return primary;
  }
  return secondary > primary ? secondary : primary;
}
