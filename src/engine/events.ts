import { GardenEdge } from '../garden/types.js';
import { NodeOutcome, RunStatus } from './types.js';

export interface RunStartedEvent {
  type: 'run_started';
  run_id: string;
  dot_file: string;
  started_at: string;
}

export interface NodeStartedEvent {
  type: 'node_started';
  run_id: string;
  node_id: string;
  attempt: number;
  started_at: string;
}

export interface NodeCompletedEvent {
  type: 'node_completed';
  run_id: string;
  node_id: string;
  outcome: NodeOutcome;
  completed_at: string;
  duration_ms: number;
}

export interface NodeRetryingEvent {
  type: 'node_retrying';
  run_id: string;
  node_id: string;
  attempt: number;
  max_retries: number;
  delay_ms: number;
}

export interface EdgeSelectedEvent {
  type: 'edge_selected';
  run_id: string;
  node_id: string;
  edge: GardenEdge;
}

export interface RunCompletedEvent {
  type: 'run_completed';
  run_id: string;
  completed_at: string;
  duration_ms: number;
  completed_nodes: number;
}

export interface RunInterruptedEvent {
  type: 'run_interrupted';
  run_id: string;
  reason: string;
}

export interface RunErrorEvent {
  type: 'run_error';
  run_id: string;
  status: Exclude<RunStatus, 'running' | 'completed'>;
  message: string;
}

export interface HumanQuestionEvent {
  type: 'human_question';
  run_id: string;
  node_id: string;
  text: string;
  choices: Array<{ label: string; accelerator?: string }>;
  default_choice?: string;
  timeout_ms?: number;
}

export interface HumanAnswerEvent {
  type: 'human_answer';
  run_id: string;
  node_id: string;
  selected_label: string;
  source: 'user' | 'timeout' | 'auto' | 'queue';
}

export interface ParallelStartedEvent {
  type: 'parallel_started';
  run_id: string;
  node_id: string;
  branch_count: number;
  branch_ids: string[];
  join_policy: string;
  max_parallel: number;
}

export interface ParallelBranchStartedEvent {
  type: 'parallel_branch_started';
  run_id: string;
  node_id: string;
  branch_id: string;
}

export interface ParallelBranchCompletedEvent {
  type: 'parallel_branch_completed';
  run_id: string;
  node_id: string;
  branch_id: string;
  status: string;
  duration_ms: number;
}

export interface ParallelCompletedEvent {
  type: 'parallel_completed';
  run_id: string;
  node_id: string;
  status: string;
  total_branches: number;
  succeeded: number;
  failed: number;
  duration_ms: number;
}

// Agent session events (bridged from agent-loop)
export interface AgentSessionStartedRunEvent {
  type: 'agent_session_started';
  run_id: string;
  node_id: string;
  provider: string;
  model: string;
  session_id?: string;
  workspace_root?: string;
  state?: string;
}

export interface AgentToolCalledRunEvent {
  type: 'agent_tool_called';
  run_id: string;
  node_id: string;
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolCompletedRunEvent {
  type: 'agent_tool_completed';
  run_id: string;
  node_id: string;
  call_id: string;
  tool_name: string;
  duration_ms: number;
  is_error: boolean;
  content_preview?: string;
  truncated?: boolean;
  artifact_path?: string;
}

export interface AgentLoopDetectedRunEvent {
  type: 'agent_loop_detected';
  run_id: string;
  node_id: string;
  fingerprint: string;
  repetitions: number;
}

export interface AgentSessionCompletedRunEvent {
  type: 'agent_session_completed';
  run_id: string;
  node_id: string;
  status: string;
  turn_count: number;
  tool_call_count: number;
  duration_ms: number;
  session_id?: string;
  final_state?: string;
}

// Subagent events (bridged from agent-loop)
export interface SubagentSpawnedRunEvent {
  type: 'subagent_spawned';
  run_id: string;
  node_id: string;
  parent_session_id: string;
  child_session_id: string;
  agent_id: string;
  task: string;
  depth: number;
  timestamp: string;
}

export interface SubagentCompletedRunEvent {
  type: 'subagent_completed';
  run_id: string;
  node_id: string;
  parent_session_id: string;
  child_session_id: string;
  agent_id: string;
  status: string;
  timestamp: string;
}

export interface SubagentMessageRunEvent {
  type: 'subagent_message';
  run_id: string;
  node_id: string;
  parent_session_id: string;
  agent_id: string;
  direction: string;
  message_type: string;
  timestamp: string;
}

export interface CheckpointSavedEvent {
  type: 'checkpoint_saved';
  run_id: string;
  checkpoint_path: string;
  timestamp: string;
}

export interface AutoStatusAppliedEvent {
  type: 'auto_status_applied';
  run_id: string;
  node_id: string;
  message: string;
}

// Manager loop events (Sprint 017)
export interface ChildRunStartedEvent {
  type: 'child_run_started';
  parent_node_id: string;
  child_run_id: string;
  child_dotfile: string;
}

export interface ChildSnapshotEvent {
  type: 'child_snapshot_observed';
  child_run_id: string;
  child_status: string;
  child_current_node?: string;
  completed_count: number;
  cycle: number;
}

export interface ChildSteerEvent {
  type: 'child_steer_note_written';
  child_run_id: string;
  tuple_key: string;
}

// Restart events (Sprint 017)
export interface RunRestartedEvent {
  type: 'run_restarted';
  predecessor_run_id: string;
  successor_run_id: string;
  restart_depth: number;
  target_node: string;
}

// Tool hook events (Sprint 017)
export interface ToolHookBlockedEvent {
  type: 'tool_hook_blocked';
  tool_name: string;
  tool_call_id: string;
  hook_exit_code: number;
}

export type RunEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeRetryingEvent
  | EdgeSelectedEvent
  | RunCompletedEvent
  | RunInterruptedEvent
  | RunErrorEvent
  | HumanQuestionEvent
  | HumanAnswerEvent
  | ParallelStartedEvent
  | ParallelBranchStartedEvent
  | ParallelBranchCompletedEvent
  | ParallelCompletedEvent
  | CheckpointSavedEvent
  | AutoStatusAppliedEvent
  | AgentSessionStartedRunEvent
  | AgentToolCalledRunEvent
  | AgentToolCompletedRunEvent
  | AgentLoopDetectedRunEvent
  | AgentSessionCompletedRunEvent
  | SubagentSpawnedRunEvent
  | SubagentCompletedRunEvent
  | SubagentMessageRunEvent
  | ChildRunStartedEvent
  | ChildSnapshotEvent
  | ChildSteerEvent
  | RunRestartedEvent
  | ToolHookBlockedEvent;

export type RunEventListener = (event: RunEvent) => void;
