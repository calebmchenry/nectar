// Agent-loop events — Sprint 007 + Sprint 011

export interface AgentSessionStartedEvent {
  type: 'agent_session_started';
  node_id: string;
  provider: string;
  model: string;
  session_id?: string;
  workspace_root?: string;
  state?: string;
}

export interface AgentTurnStartedEvent {
  type: 'agent_turn_started';
  turn_number: number;
}

export interface AgentTextDeltaEvent {
  type: 'agent_text_delta';
  text: string;
}

export interface AgentToolCallStartedEvent {
  type: 'agent_tool_call_started';
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
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

export interface AgentSessionCompletedEvent {
  type: 'agent_session_completed';
  status: string;
  turn_count: number;
  tool_call_count: number;
  duration_ms: number;
  session_id?: string;
  final_state?: string;
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
  | AgentTurnStartedEvent
  | AgentTextDeltaEvent
  | AgentToolCallStartedEvent
  | AgentToolCallCompletedEvent
  | AgentLoopDetectedEvent
  | AgentSessionCompletedEvent
  | SubagentSpawnedEvent
  | SubagentCompletedEvent
  | SubagentMessageEvent;

export type AgentEventListener = (event: AgentEvent) => void;
