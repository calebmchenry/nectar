export type SwarmProvider = 'claude' | 'codex' | 'gemini';

export type AnalysisOutcomeStatus = 'complete' | 'failed' | 'skipped';

export interface SeedCreatedEvent {
  type: 'seed_created';
  seed_id: number;
  status: string;
  priority: string;
  timestamp: string;
}

export interface SeedUpdatedEvent {
  type: 'seed_updated';
  seed_id: number;
  status: string;
  priority: string;
  timestamp: string;
}

export interface SeedAnalysisStartedEvent {
  type: 'seed_analysis_started';
  seed_id: number;
  providers: SwarmProvider[];
  timestamp: string;
}

export interface SeedAnalysisProviderCompletedEvent {
  type: 'seed_analysis_provider_completed';
  seed_id: number;
  provider: SwarmProvider;
  status: AnalysisOutcomeStatus;
  message?: string;
  timestamp: string;
}

export interface SeedAnalysisCompletedEvent {
  type: 'seed_analysis_completed';
  seed_id: number;
  statuses: Partial<Record<SwarmProvider, AnalysisOutcomeStatus>>;
  timestamp: string;
}

export interface SeedAnalysisFailedEvent {
  type: 'seed_analysis_failed';
  seed_id: number;
  error: string;
  timestamp: string;
}

export type WorkspaceSemanticEvent =
  | SeedCreatedEvent
  | SeedUpdatedEvent
  | SeedAnalysisStartedEvent
  | SeedAnalysisProviderCompletedEvent
  | SeedAnalysisCompletedEvent
  | SeedAnalysisFailedEvent;

type Listener = (event: WorkspaceSemanticEvent) => void;
type EmittableEvent =
  | Omit<SeedCreatedEvent, 'timestamp'>
  | Omit<SeedUpdatedEvent, 'timestamp'>
  | Omit<SeedAnalysisStartedEvent, 'timestamp'>
  | Omit<SeedAnalysisProviderCompletedEvent, 'timestamp'>
  | Omit<SeedAnalysisCompletedEvent, 'timestamp'>
  | Omit<SeedAnalysisFailedEvent, 'timestamp'>;

export class WorkspaceEventBus {
  private readonly listeners = new Set<Listener>();

  emit(event: EmittableEvent & { timestamp?: string }): void {
    const enriched = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    } as unknown as WorkspaceSemanticEvent;

    for (const listener of this.listeners) {
      listener(enriched);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onEvent(listener: Listener): () => void {
    return this.subscribe(listener);
  }
}
