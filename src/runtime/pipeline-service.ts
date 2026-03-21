import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Cocoon, CocoonSummary } from '../checkpoint/types.js';
import { ManifestData, RunLaunchOrigin, RunStore } from '../checkpoint/run-store.js';
import { PipelineEngine } from '../engine/engine.js';
import type { RunEventListener } from '../engine/events.js';
import type { RunResult } from '../engine/types.js';
import { GardenParseError, hashDotSource } from '../garden/parse.js';
import { PipelinePreparer } from '../garden/preparer.js';
import type { Diagnostic, GardenGraph } from '../garden/types.js';
import type { Interviewer } from '../interviewer/types.js';
import type { UnifiedClient } from '../llm/client.js';
import type { LLMClient } from '../llm/types.js';

export interface PipelineLoadResult {
  graph: GardenGraph | null;
  diagnostics: Diagnostic[];
  graph_hash?: string;
  graph_hash_kind?: 'source' | 'prepared';
  source_hash?: string;
  prepared_dot?: string;
  source_files?: string[];
}

export interface ExecutePipelineOptions {
  graph: GardenGraph;
  graph_hash: string;
  graph_hash_kind?: 'source' | 'prepared';
  prepared_dot?: string;
  source_files?: string[];
  interviewer?: Interviewer;
  llm_client?: UnifiedClient | LLMClient;
  on_event?: RunEventListener;
  initial_cocoon?: Cocoon;
  run_id?: string;
  initial_context?: Record<string, string>;
  start_node_override?: string;
  register_signal_handlers?: boolean;
  on_engine?: (engine: PipelineEngine) => void;
  seed_id?: number;
  seed_dir?: string;
  seed_garden?: string;
  launch_origin?: RunLaunchOrigin;
}

export interface ResumePipelineOptions {
  run_id: string;
  force?: boolean;
  interviewer?: Interviewer;
  llm_client?: UnifiedClient | LLMClient;
  on_event?: RunEventListener;
  register_signal_handlers?: boolean;
  on_engine?: (engine: PipelineEngine) => void;
  seed_id?: number;
  seed_dir?: string;
  seed_garden?: string;
  launch_origin?: RunLaunchOrigin;
}

export interface ResumePipelineResult {
  run_result: RunResult;
  run_id: string;
  cocoon: Cocoon;
  graph: GardenGraph;
  graph_hash: string;
  graph_hash_kind: 'source' | 'prepared';
}

export class PipelineDiagnosticsError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message);
    this.name = 'PipelineDiagnosticsError';
    this.diagnostics = diagnostics;
  }
}

export class PipelineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineNotFoundError';
  }
}

export class PipelineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineConflictError';
  }
}

export class PipelineService {
  private readonly workspaceRoot: string;
  private readonly preparer: PipelinePreparer;

  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
    this.preparer = new PipelinePreparer({ workspaceRoot: this.workspaceRoot });
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  resolvePathWithinWorkspace(relPath: string): string {
    const absolutePath = path.resolve(this.workspaceRoot, relPath);
    const relative = path.relative(this.workspaceRoot, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new PipelineConflictError(`Path '${relPath}' resolves outside workspace root.`);
    }
    return absolutePath;
  }

  async loadFromPath(dotPath: string): Promise<PipelineLoadResult> {
    try {
      const absolutePath = path.resolve(this.workspaceRoot, dotPath);
      const prepared = await this.preparer.prepareFromPath(absolutePath);
      return {
        graph: prepared.graph,
        diagnostics: prepared.diagnostics,
        graph_hash: prepared.graph_hash,
        graph_hash_kind: 'prepared',
        source_hash: hashDotSource(prepared.graph.dotSource),
        prepared_dot: prepared.prepared_dot,
        source_files: prepared.source_files,
      };
    } catch (error) {
      if (error instanceof GardenParseError) {
        return {
          graph: null,
          diagnostics: [
            {
              severity: 'error',
              code: 'DOT_PARSE_ERROR',
              message: error.message,
              file: path.resolve(this.workspaceRoot, dotPath),
              location: error.location,
            },
          ],
        };
      }
      throw error;
    }
  }

  async loadFromSource(dotSource: string, dotPath: string): Promise<PipelineLoadResult> {
    try {
      const prepared = await this.preparer.prepareFromSource(dotSource, dotPath);
      return {
        graph: prepared.graph,
        diagnostics: prepared.diagnostics,
        graph_hash: prepared.graph_hash,
        graph_hash_kind: 'prepared',
        source_hash: hashDotSource(prepared.graph.dotSource),
        prepared_dot: prepared.prepared_dot,
        source_files: prepared.source_files,
      };
    } catch (error) {
      if (error instanceof GardenParseError) {
        return {
          graph: null,
          diagnostics: [
            {
              severity: 'error',
              code: 'DOT_PARSE_ERROR',
              message: error.message,
              file: dotPath,
              location: error.location,
            },
          ],
        };
      }
      throw error;
    }
  }

  async listRuns(): Promise<CocoonSummary[]> {
    return RunStore.listRuns(this.workspaceRoot);
  }

  async resolveLatestRunId(runId: string): Promise<string> {
    let resolvedRunId = runId;
    for (let depth = 0; depth < 100; depth += 1) {
      const store = new RunStore(resolvedRunId, this.workspaceRoot);
      const manifest = await store.readManifest();
      if (!manifest?.restarted_to) {
        return resolvedRunId;
      }
      resolvedRunId = manifest.restarted_to;
    }
    return resolvedRunId;
  }

  async executePipeline(options: ExecutePipelineOptions): Promise<RunResult> {
    const graphHashKind = options.graph_hash_kind ?? 'prepared';
    const initialRunId = options.run_id ?? randomUUID();
    await this.writePreparedArtifacts({
      runId: initialRunId,
      graphHash: options.graph_hash,
      graphHashKind,
      preparedDot: options.prepared_dot,
      sourceFiles: options.source_files,
    });

    let runResult = await this.runEngine({
      ...options,
      graph_hash_kind: graphHashKind,
      run_id: initialRunId,
    });

    while (runResult.restart) {
      const restart = runResult.restart;
      const successorStore = new RunStore(restart.successor_run_id, this.workspaceRoot);
      const successorManifest: ManifestData = {
        run_id: restart.successor_run_id,
        dot_file: options.graph.dotPath,
        graph_hash: options.graph_hash,
        graph_hash_kind: graphHashKind,
        graph_label: options.graph.graphAttributes.label,
        goal: options.graph.graphAttributes.goal,
        started_at: new Date().toISOString(),
        workspace_root: this.workspaceRoot,
        restart_of: runResult.run_id,
        restart_depth: restart.restart_depth,
        seed_id: options.seed_id,
        seed_dir: options.seed_dir,
        seed_garden: options.seed_garden,
        launch_origin: options.launch_origin,
      };
      await successorStore.initialize(successorManifest);
      await this.writePreparedArtifacts({
        runId: restart.successor_run_id,
        graphHash: options.graph_hash,
        graphHashKind,
        preparedDot: options.prepared_dot,
        sourceFiles: options.source_files,
      });

      runResult = await this.runEngine({
        graph: options.graph,
        graph_hash: options.graph_hash,
        graph_hash_kind: graphHashKind,
        interviewer: options.interviewer,
        llm_client: options.llm_client,
        on_event: options.on_event,
        run_id: restart.successor_run_id,
        initial_context: restart.filtered_context,
        start_node_override: restart.target_node,
        register_signal_handlers: options.register_signal_handlers,
        on_engine: options.on_engine,
        seed_id: options.seed_id,
        seed_dir: options.seed_dir,
        seed_garden: options.seed_garden,
        launch_origin: options.launch_origin,
      });
    }

    return runResult;
  }

  async resumePipeline(options: ResumePipelineOptions): Promise<ResumePipelineResult> {
    const resolvedRunId = await this.resolveLatestRunId(options.run_id);
    const cocoon = await RunStore.readCocoon(resolvedRunId, this.workspaceRoot);
    if (!cocoon) {
      throw new PipelineNotFoundError(`Run '${resolvedRunId}' not found.`);
    }

    const load = await this.loadFromPath(cocoon.dot_file);
    if (!load.graph || hasErrors(load.diagnostics)) {
      throw new PipelineDiagnosticsError('Cannot resume pipeline due to validation errors.', load.diagnostics);
    }

    const hashKind = cocoon.graph_hash_kind ?? 'source';
    const nextHash = hashKind === 'prepared'
      ? (load.graph_hash ?? '')
      : (load.source_hash ?? '');
    if (!options.force && nextHash !== cocoon.graph_hash) {
      throw new PipelineConflictError(
        `Graph hash mismatch for run '${options.run_id}'. Original ${cocoon.graph_hash}, current ${nextHash}. Re-run with --force to override.`
      );
    }

    if (options.force && cocoon.pending_transition) {
      const targetId = cocoon.pending_transition.target_node_id;
      if (!load.graph.nodeMap.has(targetId)) {
        throw new PipelineConflictError(
          `Cannot resume: pending transition target '${targetId}' no longer exists in the edited graph.`
        );
      }
    }

    const run_result = await this.executePipeline({
      graph: load.graph,
      graph_hash: nextHash,
      graph_hash_kind: hashKind,
      prepared_dot: load.prepared_dot,
      source_files: load.source_files,
      initial_cocoon: cocoon,
      interviewer: options.interviewer,
      llm_client: options.llm_client,
      on_event: options.on_event,
      register_signal_handlers: options.register_signal_handlers,
      on_engine: options.on_engine,
      seed_id: options.seed_id,
      seed_dir: options.seed_dir,
      seed_garden: options.seed_garden,
      launch_origin: options.launch_origin,
    });

    return {
      run_result,
      run_id: resolvedRunId,
      cocoon,
      graph: load.graph,
      graph_hash: nextHash,
      graph_hash_kind: hashKind,
    };
  }

  private runEngine(options: ExecutePipelineOptions): Promise<RunResult> {
    const engine = new PipelineEngine({
      graph: options.graph,
      graph_hash: options.graph_hash,
      graph_hash_kind: options.graph_hash_kind,
      workspace_root: this.workspaceRoot,
      interviewer: options.interviewer,
      llm_client: options.llm_client,
      initial_cocoon: options.initial_cocoon,
      run_id: options.run_id,
      initial_context: options.initial_context,
      start_node_override: options.start_node_override,
      register_signal_handlers: options.register_signal_handlers,
      seed_id: options.seed_id,
      seed_dir: options.seed_dir,
      seed_garden: options.seed_garden,
      launch_origin: options.launch_origin,
    });
    options.on_engine?.(engine);
    if (options.on_event) {
      engine.onEvent(options.on_event);
    }
    return engine.run();
  }

  private async writePreparedArtifacts(input: {
    runId: string;
    graphHash: string;
    graphHashKind: 'source' | 'prepared';
    preparedDot?: string;
    sourceFiles?: string[];
  }): Promise<void> {
    if (!input.preparedDot) {
      return;
    }

    const runDir = path.join(this.workspaceRoot, '.nectar', 'cocoons', input.runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'prepared.dot'), input.preparedDot, 'utf8');

    const sourceManifest = {
      graph_hash: input.graphHash,
      graph_hash_kind: input.graphHashKind,
      source_files: input.sourceFiles ?? [],
    };
    await writeFile(path.join(runDir, 'source-manifest.json'), `${JSON.stringify(sourceManifest, null, 2)}\n`, 'utf8');
  }
}

function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
