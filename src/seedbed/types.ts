export type SeedStatus = 'seedling' | 'sprouting' | 'blooming' | 'honey' | 'wilted';
export type SeedPriority = 'low' | 'normal' | 'high' | 'queens_order';
export type AnalysisStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
export type RunLaunchOrigin = 'seedbed' | 'seed_cli' | 'pipeline_api' | 'garden_hive';
export type LinkedRunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type SeedActivityActor = 'user' | 'system' | 'agent';

export const SEED_STATUSES: readonly SeedStatus[] = ['seedling', 'sprouting', 'blooming', 'honey', 'wilted'];
export const SEED_PRIORITIES: readonly SeedPriority[] = ['low', 'normal', 'high', 'queens_order'];
export const ANALYSIS_STATUSES: readonly AnalysisStatus[] = ['pending', 'running', 'complete', 'failed', 'skipped'];
export const RUN_LAUNCH_ORIGINS: readonly RunLaunchOrigin[] = ['seedbed', 'seed_cli', 'pipeline_api', 'garden_hive'];
export const MAX_LINKED_RUNS = 25;

export interface SeedMeta {
  id: number;
  slug: string;
  title: string;
  status: SeedStatus;
  priority: SeedPriority;
  tags: string[];
  created_at: string;
  updated_at: string;
  linked_gardens: string[];
  linked_runs: string[];
  analysis_status: Record<string, AnalysisStatus>;
}

export interface ConsistencyIssue {
  seedId: number;
  directory: string;
  code: string;
  message: string;
}

export interface LinkedRunSummary {
  run_id: string;
  status: LinkedRunStatus;
  dot_file?: string;
  started_at?: string;
  updated_at?: string;
  seed_garden?: string;
  launch_origin?: RunLaunchOrigin;
}

export interface SeedStatusSuggestion {
  suggested_status: 'honey';
  reason: string;
  based_on_run_id: string;
}

interface SeedActivityEventBase {
  timestamp: string;
  seed_id: number;
  actor: SeedActivityActor;
  idempotency_key?: string;
}

export interface SeedCreatedActivityEvent extends SeedActivityEventBase {
  type: 'seed_created';
  title: string;
  status: SeedStatus;
  priority: SeedPriority;
}

export interface SeedUpdatedActivityEvent extends SeedActivityEventBase {
  type: 'seed_updated';
  fields: string[];
}

export interface SeedStatusChangedActivityEvent extends SeedActivityEventBase {
  type: 'status_changed';
  from: SeedStatus;
  to: SeedStatus;
  reason?: string;
}

export interface SeedGardenLinkedActivityEvent extends SeedActivityEventBase {
  type: 'garden_linked';
  garden: string;
}

export interface SeedGardenUnlinkedActivityEvent extends SeedActivityEventBase {
  type: 'garden_unlinked';
  garden: string;
}

interface SeedRunActivityEventBase extends SeedActivityEventBase {
  run_id: string;
  garden?: string;
  launch_origin?: RunLaunchOrigin;
}

export interface SeedRunStartedActivityEvent extends SeedRunActivityEventBase {
  type: 'run_started';
}

export interface SeedRunResumedActivityEvent extends SeedRunActivityEventBase {
  type: 'run_resumed';
}

export interface SeedRunInterruptedActivityEvent extends SeedRunActivityEventBase {
  type: 'run_interrupted';
  reason?: string;
}

export interface SeedRunCompletedActivityEvent extends SeedRunActivityEventBase {
  type: 'run_completed';
}

export interface SeedRunFailedActivityEvent extends SeedRunActivityEventBase {
  type: 'run_failed';
  status: 'failed';
  message: string;
}

export type SeedActivityEvent =
  | SeedCreatedActivityEvent
  | SeedUpdatedActivityEvent
  | SeedStatusChangedActivityEvent
  | SeedGardenLinkedActivityEvent
  | SeedGardenUnlinkedActivityEvent
  | SeedRunStartedActivityEvent
  | SeedRunResumedActivityEvent
  | SeedRunInterruptedActivityEvent
  | SeedRunCompletedActivityEvent
  | SeedRunFailedActivityEvent;

export function isValidStatus(value: string): value is SeedStatus {
  return (SEED_STATUSES as readonly string[]).includes(value);
}

export function isValidPriority(value: string): value is SeedPriority {
  return (SEED_PRIORITIES as readonly string[]).includes(value);
}

export function isValidRunLaunchOrigin(value: string): value is RunLaunchOrigin {
  return (RUN_LAUNCH_ORIGINS as readonly string[]).includes(value);
}
