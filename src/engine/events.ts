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

export type RunEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeRetryingEvent
  | EdgeSelectedEvent
  | RunCompletedEvent
  | RunInterruptedEvent
  | RunErrorEvent;

export type RunEventListener = (event: RunEvent) => void;
