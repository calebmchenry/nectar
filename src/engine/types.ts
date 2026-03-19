import { GardenNode } from '../garden/types.js';

export type NodeStatus = 'success' | 'failure';
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
}

export interface HandlerExecutionInput {
  node: GardenNode;
  run_id: string;
  dot_file: string;
  attempt: number;
  run_dir: string;
  context: Record<string, string>;
  abort_signal?: AbortSignal;
}
