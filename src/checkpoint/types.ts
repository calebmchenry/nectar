import { CompletedNodeState, RunStatus } from '../engine/types.js';

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
}

export interface CocoonSummary {
  run_id: string;
  dot_file: string;
  status: RunStatus;
  updated_at: string;
  current_node: string | undefined;
  completed_count: number;
}
