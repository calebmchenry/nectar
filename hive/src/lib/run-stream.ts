import type { EventEnvelope } from './api';

export interface RunStreamCallbacks {
  onEnvelope(envelope: EventEnvelope, lastEventId: number): void;
  onError(error: Event): void;
}

const STREAM_EVENT_TYPES = [
  'run_started',
  'node_started',
  'node_completed',
  'node_retrying',
  'stage_failed',
  'edge_selected',
  'run_completed',
  'run_interrupted',
  'pipeline_failed',
  'run_error',
  'human_question',
  'human_answer',
  'parallel_started',
  'parallel_branch_started',
  'parallel_branch_completed',
  'parallel_completed',
  'checkpoint_saved',
  'auto_status_applied',
  'run_restarted',
] as const;

export class RunStream {
  private source: EventSource | null = null;
  private lastEventId = 0;
  private readonly runId: string;
  private readonly callbacks: RunStreamCallbacks;

  constructor(runId: string, callbacks: RunStreamCallbacks) {
    this.runId = runId;
    this.callbacks = callbacks;
  }

  getLastEventId(): number {
    return this.lastEventId;
  }

  connect(fromEventId?: number): void {
    this.close();

    const params = new URLSearchParams();
    if (typeof fromEventId === 'number' && fromEventId > 0) {
      params.set('last_event_id', String(fromEventId));
    }

    const query = params.toString();
    const endpoint = `/pipelines/${encodeURIComponent(this.runId)}/events${query ? `?${query}` : ''}`;
    const source = new EventSource(endpoint);
    this.source = source;

    const handleMessage = (messageEvent: MessageEvent<string>) => {
      let envelope: EventEnvelope;
      try {
        envelope = JSON.parse(messageEvent.data) as EventEnvelope;
      } catch {
        return;
      }

      const id = Number.parseInt(messageEvent.lastEventId, 10);
      if (Number.isFinite(id) && id > 0) {
        this.lastEventId = id;
      } else {
        this.lastEventId = Math.max(this.lastEventId, envelope.seq);
      }

      this.callbacks.onEnvelope(envelope, this.lastEventId);
    };

    for (const eventType of STREAM_EVENT_TYPES) {
      source.addEventListener(eventType, handleMessage as EventListener);
    }

    source.onerror = (event) => {
      this.callbacks.onError(event);
    };
  }

  close(): void {
    if (!this.source) {
      return;
    }
    this.source.close();
    this.source = null;
  }
}
