export type WorkspaceEventType =
  | 'garden_changed'
  | 'seed_created'
  | 'seed_updated'
  | 'seed_deleted'
  | 'seed_analysis_started'
  | 'seed_analysis_provider_completed'
  | 'seed_analysis_completed'
  | 'seed_analysis_failed';

export interface WorkspaceStreamEvent {
  id?: number;
  timestamp?: string;
  [key: string]: unknown;
}

export interface WorkspaceEvent {
  type: WorkspaceEventType;
  payload: WorkspaceStreamEvent;
  last_event_id: number;
}

export interface WorkspaceStreamCallbacks {
  onEvent(event: WorkspaceEvent): void;
  onError(error: Event): void;
}

const WORKSPACE_EVENT_TYPES: WorkspaceEventType[] = [
  'garden_changed',
  'seed_created',
  'seed_updated',
  'seed_deleted',
  'seed_analysis_started',
  'seed_analysis_provider_completed',
  'seed_analysis_completed',
  'seed_analysis_failed',
];

export class WorkspaceStream {
  private source: EventSource | null = null;
  private lastEventId = 0;
  private readonly callbacks: WorkspaceStreamCallbacks;

  constructor(callbacks: WorkspaceStreamCallbacks) {
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
    const endpoint = `/events${query ? `?${query}` : ''}`;
    const source = new EventSource(endpoint);
    this.source = source;

    for (const eventType of WORKSPACE_EVENT_TYPES) {
      source.addEventListener(eventType, (messageEvent) => {
        this.handleMessage(eventType, messageEvent as MessageEvent<string>);
      });
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

  private handleMessage(eventType: WorkspaceEventType, messageEvent: MessageEvent<string>): void {
    let payload: WorkspaceStreamEvent;
    try {
      payload = JSON.parse(messageEvent.data) as WorkspaceStreamEvent;
    } catch {
      return;
    }

    const messageEventId = Number.parseInt(messageEvent.lastEventId, 10);
    if (Number.isFinite(messageEventId) && messageEventId > 0) {
      this.lastEventId = messageEventId;
    } else if (typeof payload.id === 'number' && payload.id > 0) {
      this.lastEventId = Math.max(this.lastEventId, payload.id);
    }

    this.callbacks.onEvent({
      type: eventType,
      payload,
      last_event_id: this.lastEventId,
    });
  }
}
