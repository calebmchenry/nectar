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
  index: number;
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

export interface StageFailedEvent {
  type: 'stage_failed';
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
  artifact_count: number;
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

export interface PipelineFailedEvent {
  type: 'pipeline_failed';
  run_id: string;
  status: 'failed';
  final_status: 'failed';
  failed_node_id: string;
  message: string;
  failed_at: string;
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

export interface InterviewStartedEvent {
  type: 'interview_started';
  run_id: string;
  node_id: string;
  question_id: string;
  question_text: string;
  stage: string;
}

export interface InterviewCompletedEvent {
  type: 'interview_completed';
  run_id: string;
  node_id: string;
  question_id: string;
  answer: string;
  duration_ms: number;
}

export interface InterviewTimeoutEvent {
  type: 'interview_timeout';
  run_id: string;
  node_id: string;
  question_id: string;
  stage: string;
  duration_ms: number;
}

export interface InterviewInformEvent {
  type: 'interview_inform';
  run_id: string;
  stage: string;
  message: string;
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

export interface AgentUserInputRunEvent {
  type: 'agent_user_input';
  run_id: string;
  node_id: string;
  session_id: string;
  source: 'submit' | 'follow_up';
  text: string;
}

export interface AgentSteeringInjectedRunEvent {
  type: 'agent_steering_injected';
  run_id: string;
  node_id: string;
  session_id: string;
  message: string;
}

export interface AgentAssistantTextStartRunEvent {
  type: 'agent_assistant_text_start';
  run_id: string;
  node_id: string;
  turn_number: number;
}

export interface AgentAssistantTextEndRunEvent {
  type: 'agent_assistant_text_end';
  run_id: string;
  node_id: string;
  turn_number: number;
  char_count: number;
}

export interface AgentToolCalledRunEvent {
  type: 'agent_tool_called';
  run_id: string;
  node_id: string;
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolCallOutputDeltaRunEvent {
  type: 'agent_tool_call_output_delta';
  run_id: string;
  node_id: string;
  call_id: string;
  tool_name: string;
  delta: string;
  chunk_index: number;
  chunk_count: number;
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
  full_content?: string;
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

export interface AgentProcessingEndedRunEvent {
  type: 'agent_processing_ended';
  run_id: string;
  node_id: string;
  session_id: string;
  state: string;
  pending_inputs: number;
}

export interface AgentSessionEndedRunEvent {
  type: 'agent_session_ended';
  run_id: string;
  node_id: string;
  session_id: string;
  reason: 'closed' | 'aborted';
  final_state: string;
}

export interface AgentTurnLimitReachedRunEvent {
  type: 'agent_turn_limit_reached';
  run_id: string;
  node_id: string;
  session_id: string;
  max_turns: number;
}

export interface AgentWarningRunEvent {
  type: 'agent_warning';
  run_id: string;
  node_id: string;
  session_id: string;
  code: 'context_window_pressure' | 'tool_output_truncated' | 'tool_call_repaired';
  message: string;
}

export interface AgentErrorRunEvent {
  type: 'agent_error';
  run_id: string;
  node_id: string;
  session_id: string;
  message: string;
}

export interface ContextWindowWarningRunEvent {
  type: 'context_window_warning';
  run_id: string;
  node_id: string;
  session_id: string;
  usage_pct: number;
  estimated_tokens: number;
  context_window: number;
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
  | StageFailedEvent
  | NodeRetryingEvent
  | EdgeSelectedEvent
  | RunCompletedEvent
  | RunInterruptedEvent
  | PipelineFailedEvent
  | RunErrorEvent
  | HumanQuestionEvent
  | HumanAnswerEvent
  | InterviewStartedEvent
  | InterviewCompletedEvent
  | InterviewTimeoutEvent
  | InterviewInformEvent
  | ParallelStartedEvent
  | ParallelBranchStartedEvent
  | ParallelBranchCompletedEvent
  | ParallelCompletedEvent
  | CheckpointSavedEvent
  | AutoStatusAppliedEvent
  | AgentSessionStartedRunEvent
  | AgentUserInputRunEvent
  | AgentSteeringInjectedRunEvent
  | AgentAssistantTextStartRunEvent
  | AgentAssistantTextEndRunEvent
  | AgentToolCalledRunEvent
  | AgentToolCallOutputDeltaRunEvent
  | AgentToolCompletedRunEvent
  | AgentLoopDetectedRunEvent
  | AgentProcessingEndedRunEvent
  | AgentSessionEndedRunEvent
  | AgentTurnLimitReachedRunEvent
  | AgentWarningRunEvent
  | AgentErrorRunEvent
  | AgentSessionCompletedRunEvent
  | ContextWindowWarningRunEvent
  | SubagentSpawnedRunEvent
  | SubagentCompletedRunEvent
  | SubagentMessageRunEvent
  | ChildRunStartedEvent
  | ChildSnapshotEvent
  | ChildSteerEvent
  | RunRestartedEvent
  | ToolHookBlockedEvent;

export const ENGINE_EVENT_NAME_ALIASES = {
  run_started: 'RunStarted',
  node_started: 'NodeStarted',
  node_completed: 'NodeCompleted',
  stage_failed: 'StageFailed',
  node_retrying: 'NodeRetrying',
  edge_selected: 'EdgeSelected',
  run_completed: 'RunCompleted',
  run_interrupted: 'RunInterrupted',
  pipeline_failed: 'PipelineFailed',
  run_error: 'RunError',
  human_question: 'HumanQuestion',
  human_answer: 'HumanAnswer',
  interview_started: 'InterviewStarted',
  interview_completed: 'InterviewCompleted',
  interview_timeout: 'InterviewTimeout',
  interview_inform: 'InterviewInform',
  parallel_started: 'ParallelStarted',
  parallel_branch_started: 'ParallelBranchStarted',
  parallel_branch_completed: 'ParallelBranchCompleted',
  parallel_completed: 'ParallelCompleted',
  checkpoint_saved: 'CheckpointSaved',
  auto_status_applied: 'AutoStatusApplied',
  agent_session_started: 'AgentSessionStarted',
  agent_user_input: 'AgentUserInput',
  agent_steering_injected: 'AgentSteeringInjected',
  agent_assistant_text_start: 'AgentAssistantTextStart',
  agent_assistant_text_end: 'AgentAssistantTextEnd',
  agent_tool_called: 'AgentToolCalled',
  agent_tool_call_output_delta: 'AgentToolCallOutputDelta',
  agent_tool_completed: 'AgentToolCompleted',
  agent_loop_detected: 'AgentLoopDetected',
  agent_processing_ended: 'AgentProcessingEnded',
  agent_session_ended: 'AgentSessionEnded',
  agent_turn_limit_reached: 'AgentTurnLimitReached',
  agent_warning: 'AgentWarning',
  agent_error: 'AgentError',
  agent_session_completed: 'AgentSessionCompleted',
  context_window_warning: 'ContextWindowWarning',
  subagent_spawned: 'SubagentSpawned',
  subagent_completed: 'SubagentCompleted',
  subagent_message: 'SubagentMessage',
  child_run_started: 'ChildRunStarted',
  child_snapshot_observed: 'ChildSnapshotObserved',
  child_steer_note_written: 'ChildSteerNoteWritten',
  run_restarted: 'RunRestarted',
  tool_hook_blocked: 'ToolHookBlocked',
} as const;

export type SnakeCaseRunEventName = keyof typeof ENGINE_EVENT_NAME_ALIASES;
export type PascalCaseRunEventName = (typeof ENGINE_EVENT_NAME_ALIASES)[SnakeCaseRunEventName];

export const ENGINE_EVENT_NAME_ALIASES_REVERSE = Object.fromEntries(
  Object.entries(ENGINE_EVENT_NAME_ALIASES).map(([snake, pascal]) => [pascal, snake]),
) as Record<PascalCaseRunEventName, SnakeCaseRunEventName>;

export function toPascalCaseEventName(name: SnakeCaseRunEventName): PascalCaseRunEventName {
  return ENGINE_EVENT_NAME_ALIASES[name];
}

export function toSnakeCaseEventName(name: string): SnakeCaseRunEventName | undefined {
  if (name in ENGINE_EVENT_NAME_ALIASES) {
    return name as SnakeCaseRunEventName;
  }
  if (name in ENGINE_EVENT_NAME_ALIASES_REVERSE) {
    return ENGINE_EVENT_NAME_ALIASES_REVERSE[name as PascalCaseRunEventName];
  }
  return undefined;
}

export type RunEventListener = (event: RunEvent) => void;
