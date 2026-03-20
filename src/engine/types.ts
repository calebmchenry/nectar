import { GardenEdge, GardenNode } from '../garden/types.js';
import type { FidelityMode, ResolvedFidelityPlan } from './fidelity.js';

export type NodeStatus = 'success' | 'failure' | 'partial_success' | 'retry' | 'skipped';
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface NodeOutcome {
  status: NodeStatus;
  preferred_label?: string;
  suggested_next?: string[];
  context_updates?: Record<string, string>;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  timed_out?: boolean;
  error_message?: string;
}

export interface CompletedNodeState {
  node_id: string;
  status: NodeStatus;
  started_at: string;
  completed_at: string;
  retries: number;
}

export interface RunState {
  run_id: string;
  dot_file: string;
  graph_hash: string;
  started_at: string;
  updated_at: string;
  status: RunStatus;
  interruption_reason: string | undefined;
  completed_nodes: CompletedNodeState[];
  current_node: string | undefined;
  context: Record<string, string>;
  retry_state: Record<string, number>;
}

export interface RunResult {
  status: RunStatus;
  run_id: string;
  completed_nodes: CompletedNodeState[];
  interruption_reason?: string;
  error?: string;
  /** Set when run was interrupted by loop_restart */
  restart?: {
    successor_run_id: string;
    restart_depth: number;
    target_node: string;
    filtered_context: Record<string, string>;
  };
}

export interface BranchResult {
  branchId: string;
  status: NodeStatus;
  contextSnapshot: Record<string, string>;
  durationMs: number;
}

export interface HandlerExecutionInput {
  node: GardenNode;
  run_id: string;
  dot_file: string;
  attempt: number;
  run_dir: string;
  context: Record<string, string>;
  abort_signal?: AbortSignal;
  outgoing_edges?: GardenEdge[];
  workspace_root?: string;
  emitEvent?: (event: import('./events.js').RunEvent) => void;
  fidelity_plan?: ResolvedFidelityPlan;
  preamble?: string;
  session_registry?: import('./session-registry.js').SessionRegistry;
  /** Graph-level tool hooks */
  graph_tool_hooks_pre?: string;
  graph_tool_hooks_post?: string;
}
