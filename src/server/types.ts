import type { CompletedNodeState, RunStatus } from '../engine/types.js';
import type { RunEvent } from '../engine/events.js';
import type { Answer } from '../interviewer/types.js';
import type { RunLaunchOrigin } from '../seedbed/types.js';

export interface ErrorResponse {
  error: string;
  code: string;
  details?: unknown;
}

export interface PipelineCreateRequest {
  dot_path?: string;
  dot_source?: string;
  auto_approve?: boolean;
}

export interface PipelineCreateResponse {
  run_id: string;
  status: 'running';
}

export interface PipelineResumeResponse {
  run_id: string;
  status: 'running';
}

export interface PipelineCancelResponse extends PipelineStatusResponse {
  checkpoint_id: string;
}

export interface SeedRunRequest {
  garden_path?: string;
  run_id?: string;
  auto_approve?: boolean;
  force?: boolean;
  launch_origin?: RunLaunchOrigin;
}

export interface SeedRunResponse {
  run_id: string;
  status: 'running';
  seed_id: number;
  garden_path: string;
  resumed: boolean;
}

export interface PipelineStatusResponse {
  run_id: string;
  status: RunStatus;
  dot_file: string;
  started_at: string;
  updated_at: string;
  duration_ms: number;
  current_node?: string;
  completed_nodes: string[];
  completed_count: number;
  interruption_reason?: string;
}

export interface EventEnvelope {
  seq: number;
  timestamp: string;
  event: RunEvent;
}

export type StoredQuestionStatus = 'pending' | 'answered' | 'timed_out' | 'interrupted';

export interface StoredQuestionResource {
  question_id: string;
  run_id: string;
  node_id: string;
  stage: string;
  text: string;
  choices: Array<{ label: string; accelerator?: string; edge_target?: string }>;
  default_choice?: string;
  timeout_ms?: number;
  status: StoredQuestionStatus;
  created_at: string;
  updated_at: string;
  answered_at?: string;
  answer?: Answer;
}

export interface GraphExecutionState {
  status: RunStatus;
  current_node?: string;
  completed_nodes: CompletedNodeState[];
}

export type DraftTerminalEventType = 'draft_complete' | 'draft_error';
export const DRAFT_TERMINAL_EVENT_TYPES: ReadonlySet<DraftTerminalEventType> = new Set([
  'draft_complete',
  'draft_error',
]);

export type PipelineTerminalEventType =
  | 'run_completed'
  | 'pipeline_failed'
  | 'run_interrupted'
  | 'run_error';
export const PIPELINE_TERMINAL_EVENT_TYPES: ReadonlySet<PipelineTerminalEventType> = new Set([
  'run_completed',
  'pipeline_failed',
  'run_interrupted',
  'run_error',
]);
