export type SeedStatus = 'seedling' | 'sprouting' | 'blooming' | 'honey' | 'wilted';
export type SeedPriority = 'low' | 'normal' | 'high' | 'queens_order';
export type AnalysisStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

export const SEED_STATUSES: readonly SeedStatus[] = ['seedling', 'sprouting', 'blooming', 'honey', 'wilted'];
export const SEED_PRIORITIES: readonly SeedPriority[] = ['low', 'normal', 'high', 'queens_order'];
export const ANALYSIS_STATUSES: readonly AnalysisStatus[] = ['pending', 'running', 'complete', 'failed', 'skipped'];

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

export function isValidStatus(value: string): value is SeedStatus {
  return (SEED_STATUSES as readonly string[]).includes(value);
}

export function isValidPriority(value: string): value is SeedPriority {
  return (SEED_PRIORITIES as readonly string[]).includes(value);
}
