// Agent Loop types — Sprint 007 + Sprint 011

export type SessionState = 'IDLE' | 'PROCESSING' | 'AWAITING_INPUT' | 'CLOSED';

export interface SessionConfig {
  /** Session-lifetime turn limit (0 = unlimited). */
  max_turns: number;
  max_tool_rounds_per_input: number;
  default_command_timeout_ms: number;
  workspace_root: string;
  max_command_timeout_ms?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
  tool_output_limits?: Record<string, number>;
  tool_line_limits?: Record<string, number>;
  enable_loop_detection?: boolean;
  loop_detection_window?: number;
  max_follow_ups?: number;
  require_tool_calls_for_success?: boolean;
}

export const DEFAULT_SESSION_CONFIG: Omit<SessionConfig, 'workspace_root'> = {
  max_turns: 0,
  max_tool_rounds_per_input: 0,
  default_command_timeout_ms: 10_000,
  max_command_timeout_ms: 600_000,
  tool_output_limits: {},
  tool_line_limits: {},
  enable_loop_detection: true,
  loop_detection_window: 10,
  max_follow_ups: 10,
  require_tool_calls_for_success: false,
};

/**
 * Session/tool loop limits use a shared semantic:
 * - `0` means unlimited
 * - positive integers are hard caps
 */
export function isUnlimitedLimit(limit: number): boolean {
  return limit === 0;
}

export function hasFiniteLimit(limit: number): boolean {
  return Number.isFinite(limit) && limit > 0;
}

export function isLimitReached(count: number, limit: number): boolean {
  return hasFiniteLimit(limit) && count >= limit;
}

export function canContinueWithLimit(count: number, limit: number): boolean {
  return isUnlimitedLimit(limit) || count < limit;
}

export interface WorkItem {
  prompt: string;
  resolve: (r: SessionResult) => void;
  reject: (e: Error) => void;
  isFollowUp: boolean;
  provider_options?: Record<string, unknown>;
}

export type SessionStatus = 'success' | 'failure' | 'aborted';

export interface SessionResult {
  status: SessionStatus;
  final_text: string;
  usage: { input_tokens: number; output_tokens: number };
  turn_count: number;
  tool_call_count: number;
  stop_reason: string;
  error_message?: string;
}

export interface ToolCallEnvelope {
  name: string;
  arguments: Record<string, unknown>;
  call_id: string;
}

export interface ToolResultEnvelope {
  call_id: string;
  content: string;
  is_error: boolean;
  full_content?: string;
  truncated?: boolean;
}

/** Per-tool default character limits for model-visible output */
export const TOOL_OUTPUT_LIMITS: Record<string, number> = {
  read_file: 50_000,
  read_many_files: 120_000,
  list_dir: 40_000,
  shell: 30_000,
  grep: 20_000,
  glob: 20_000,
  write_file: 1_000,
  edit_file: 10_000,
  apply_patch: 10_000,
  spawn_agent: 20_000,
};

// --- Tool Safety Classification (GAP-45) ---

export type ToolSafety = 'read_only' | 'mutating';

export const TOOL_SAFETY: Record<string, ToolSafety> = {
  read_file: 'read_only',
  read_many_files: 'read_only',
  list_dir: 'read_only',
  grep: 'read_only',
  glob: 'read_only',
  write_file: 'mutating',
  edit_file: 'mutating',
  shell: 'mutating',
  apply_patch: 'mutating',
  spawn_agent: 'mutating',
  send_input: 'mutating',
  wait: 'read_only',
  close_agent: 'mutating',
};

export function getToolSafety(toolName: string): ToolSafety {
  return TOOL_SAFETY[toolName] ?? 'mutating';
}

// --- Parallel Tool Execution Config ---

export interface ParallelToolConfig {
  parallel_tool_execution: boolean;
  max_parallel_tools: number;
}

// --- Subagent Config ---

export interface SubagentConfig {
  max_subagent_depth: number;
  max_concurrent_children: number;
  child_max_tool_rounds: number;
  child_max_turns: number;
  child_timeout_ms: number;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  max_subagent_depth: 1,
  max_concurrent_children: 4,
  child_max_tool_rounds: 20,
  child_max_turns: 5,
  child_timeout_ms: 300_000,
};

export type SubagentHandleStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'CLOSED';

export interface SubAgentResult {
  agent_id: string;
  status: SubagentHandleStatus;
  output: string;
  error?: string;
  usage: { input_tokens: number; output_tokens: number };
  turns_used: number;
}

export interface SubAgentHandle {
  id: string;
  task: string;
  status: SubagentHandleStatus;
  working_dir: string;
  model?: string;
  started_at: string;
  result_promise: Promise<SubAgentResult>;
  result?: SubAgentResult;
}
