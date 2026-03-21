import type { SessionState } from './types.js';

// Agent-loop events — additive lifecycle + observability contract.

export interface AgentSessionStartedEvent {
  type: 'agent_session_started';
  node_id: string;
  provider: string;
  model: string;
  session_id?: string;
  workspace_root?: string;
  state?: string;
}

export interface AgentUserInputEvent {
  type: 'agent_user_input';
  session_id: string;
  source: 'submit' | 'follow_up';
  text: string;
}

export interface AgentTurnStartedEvent {
  type: 'agent_turn_started';
  turn_number: number;
}

export interface AgentSteeringInjectedEvent {
  type: 'agent_steering_injected';
  session_id: string;
  message: string;
}

export interface AgentAssistantTextStartEvent {
  type: 'agent_assistant_text_start';
  turn_number: number;
}

export interface AgentTextDeltaEvent {
  type: 'agent_text_delta';
  text: string;
}

export interface AgentAssistantTextEndEvent {
  type: 'agent_assistant_text_end';
  turn_number: number;
  char_count: number;
}

export interface AgentToolCallStartedEvent {
  type: 'agent_tool_call_started';
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolCallOutputDeltaEvent {
  type: 'agent_tool_call_output_delta';
  call_id: string;
  tool_name: string;
  delta: string;
  chunk_index: number;
  chunk_count: number;
}

export interface AgentToolCallCompletedEvent {
  type: 'agent_tool_call_completed';
  call_id: string;
  tool_name: string;
  duration_ms: number;
  is_error: boolean;
  content_preview?: string;
  full_content?: string;
  truncated?: boolean;
  artifact_path?: string;
}

export interface AgentLoopDetectedEvent {
  type: 'agent_loop_detected';
  fingerprint: string;
  repetitions: number;
}

export interface AgentProcessingEndedEvent {
  type: 'agent_processing_ended';
  session_id: string;
  state: SessionState;
  pending_inputs: number;
}

export interface AgentTurnLimitReachedEvent {
  type: 'agent_turn_limit_reached';
  session_id: string;
  max_turns: number;
}

export type AgentWarningCode = 'context_window_pressure' | 'tool_output_truncated';

export interface AgentWarningEvent {
  type: 'agent_warning';
  session_id: string;
  code: AgentWarningCode;
  message: string;
}

export interface AgentErrorEvent {
  type: 'agent_error';
  session_id: string;
  message: string;
}

export interface AgentSessionCompletedEvent {
  type: 'agent_session_completed';
  status: string;
  turn_count: number;
  tool_call_count: number;
  duration_ms: number;
  session_id?: string;
  final_state?: string;
}

export interface AgentSessionEndedEvent {
  type: 'agent_session_ended';
  session_id: string;
  reason: 'closed' | 'aborted';
  final_state: SessionState;
}

export interface ContextWindowWarningEvent {
  type: 'context_window_warning';
  session_id: string;
  usage_pct: number;
  estimated_tokens: number;
  context_window: number;
}

// Subagent lifecycle events

export interface SubagentSpawnedEvent {
  type: 'subagent_spawned';
  parent_session_id: string;
  child_session_id: string;
  agent_id: string;
  task: string;
  depth: number;
  timestamp: string;
}

export interface SubagentCompletedEvent {
  type: 'subagent_completed';
  parent_session_id: string;
  child_session_id: string;
  agent_id: string;
  status: 'success' | 'failure' | 'timeout' | 'aborted';
  usage: { input_tokens: number; output_tokens: number };
  timestamp: string;
}

export interface SubagentMessageEvent {
  type: 'subagent_message';
  parent_session_id: string;
  agent_id: string;
  direction: 'parent_to_child' | 'child_to_parent';
  message_type: 'steer' | 'follow_up' | 'result';
  timestamp: string;
}

export type AgentEvent =
  | AgentSessionStartedEvent
  | AgentUserInputEvent
  | AgentTurnStartedEvent
  | AgentSteeringInjectedEvent
  | AgentAssistantTextStartEvent
  | AgentTextDeltaEvent
  | AgentAssistantTextEndEvent
  | AgentToolCallStartedEvent
  | AgentToolCallOutputDeltaEvent
  | AgentToolCallCompletedEvent
  | AgentLoopDetectedEvent
  | AgentProcessingEndedEvent
  | AgentTurnLimitReachedEvent
  | AgentWarningEvent
  | AgentErrorEvent
  | AgentSessionCompletedEvent
  | AgentSessionEndedEvent
  | ContextWindowWarningEvent
  | SubagentSpawnedEvent
  | SubagentCompletedEvent
  | SubagentMessageEvent;

export type AgentEventListener = (event: AgentEvent) => void;
