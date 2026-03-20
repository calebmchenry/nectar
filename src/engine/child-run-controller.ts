import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PipelineEngine, PipelineEngineOptions } from './engine.js';
import { RunStore, ManifestData } from '../checkpoint/run-store.js';
import { RunResult, RunStatus } from './types.js';
import { GardenGraph } from '../garden/types.js';
import { parseGardenFile, hashDotSource } from '../garden/parse.js';
import { RunEventListener } from './events.js';

export interface ChildSnapshot {
  run_id: string;
  status: RunStatus;
  current_node?: string;
  completed_count: number;
  last_completed_node?: string;
  last_outcome?: string;
  retry_count: number;
  updated_at: string;
}

export interface ChildRunConfig {
  parentRunId: string;
  parentNodeId: string;
  workspaceRoot: string;
  onEvent?: RunEventListener;
}

export class ChildRunController {
  private readonly config: ChildRunConfig;
  private childRunId?: string;
  private childEngine?: PipelineEngine;
  private childRunPromise?: Promise<RunResult>;
  private owned = false;
  private runStore?: RunStore;

  constructor(config: ChildRunConfig) {
    this.config = config;
  }

  getChildRunId(): string | undefined {
    return this.childRunId;
  }

  isOwned(): boolean {
    return this.owned;
  }

  async start(dotFile: string, workdir?: string): Promise<string> {
    const resolvedDotFile = workdir
      ? path.resolve(this.config.workspaceRoot, workdir, dotFile)
      : path.resolve(this.config.workspaceRoot, dotFile);

    const graph = await parseGardenFile(resolvedDotFile);
    const graphHash = hashDotSource(graph.dotSource);
    const runId = randomUUID();

    this.childRunId = runId;
    this.owned = true;

    const childWorkspaceRoot = workdir
      ? path.resolve(this.config.workspaceRoot, workdir)
      : this.config.workspaceRoot;

    this.runStore = new RunStore(runId, childWorkspaceRoot);

    this.childEngine = new PipelineEngine({
      graph,
      graph_hash: graphHash,
      workspace_root: childWorkspaceRoot,
      run_id: runId,
    });

    if (this.config.onEvent) {
      this.childEngine.onEvent(this.config.onEvent);
    }

    // Start child engine as background promise
    this.childRunPromise = this.childEngine.run();

    return runId;
  }

  async attach(runId: string): Promise<void> {
    this.childRunId = runId;
    this.owned = false;
    this.runStore = new RunStore(runId, this.config.workspaceRoot);
  }

  async readSnapshot(): Promise<ChildSnapshot | null> {
    if (!this.childRunId || !this.runStore) return null;

    const cocoon = await this.runStore.readCheckpoint();
    if (!cocoon) return null;

    const lastCompleted = cocoon.completed_nodes.length > 0
      ? cocoon.completed_nodes[cocoon.completed_nodes.length - 1]
      : undefined;

    const totalRetries = Object.values(cocoon.retry_state).reduce((sum, v) => sum + v, 0);

    return {
      run_id: cocoon.run_id,
      status: cocoon.status,
      current_node: cocoon.current_node,
      completed_count: cocoon.completed_nodes.length,
      last_completed_node: lastCompleted?.node_id,
      last_outcome: lastCompleted?.status,
      retry_count: totalRetries,
      updated_at: cocoon.updated_at,
    };
  }

  async writeSteerNote(message: string, tupleKey: string): Promise<boolean> {
    if (!this.childRunId || !this.runStore) return false;

    // Check if already steered for this tuple
    const existing = await this.runStore.readControlFile<{ tuple_key: string }>('manager-steer.json');
    if (existing && existing.tuple_key === tupleKey) {
      return false; // Already steered for this tuple
    }

    const note = {
      source_run_id: this.config.parentRunId,
      source_node_id: this.config.parentNodeId,
      tuple_key: tupleKey,
      message,
      created_at: new Date().toISOString(),
    };

    await this.runStore.writeControlFile('manager-steer.json', note);
    return true;
  }

  async abortOwnedChild(reason: string): Promise<void> {
    if (!this.owned || !this.childEngine) return;
    // The child engine responds to process signals, but we can't directly abort it
    // without a shared abort controller. For now, we wait for the promise to settle.
    // In a production implementation, the child engine would share an AbortController.
    try {
      await this.childRunPromise;
    } catch {
      // Child may have already errored
    }
  }

  async waitForCompletion(): Promise<RunResult | null> {
    if (!this.childRunPromise) return null;
    return this.childRunPromise;
  }
}
