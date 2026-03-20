import { CompletedNodeState, RunStatus } from '../engine/types.js';

export interface PendingTransition {
  source_node_id: string;
  target_node_id: string;
  edge: {
    label?: string;
    condition?: string;
    weight: number;
    fidelity?: string;
    thread_id?: string;
  };
}

export interface Cocoon {
  version: 1;
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
  pending_transition?: PendingTransition;
  resume_requires_degraded_fidelity?: boolean;
  thread_registry_keys?: string[];
  restarted_to?: string;
}

export interface CocoonSummary {
  run_id: string;
  dot_file: string;
  status: RunStatus;
  updated_at: string;
  current_node: string | undefined;
  completed_count: number;
}
