export interface DraftRequest {
  prompt: string;
  provider?: string;
  model?: string;
}

export interface DraftEventBase {
  type: string;
}

export interface DraftStartEvent extends DraftEventBase {
  type: 'draft_start';
  provider: string;
  model?: string;
  timestamp: string;
}

export interface DraftDeltaEvent extends DraftEventBase {
  type: 'content_delta';
  text: string;
}

export interface DraftCompleteEvent extends DraftEventBase {
  type: 'draft_complete';
  dot_source: string;
  provider: string;
  model: string;
}

export interface DraftErrorEvent extends DraftEventBase {
  type: 'draft_error';
  error: string;
}

export type DraftStreamEvent = DraftStartEvent | DraftDeltaEvent | DraftCompleteEvent | DraftErrorEvent;

export interface DraftHandlers {
  onEvent(event: DraftStreamEvent): void;
  onError(error: Error): void;
  onDone(): void;
}

export class DraftStreamer {
  private active?: AbortController;
  private readonly tabId: string;

  constructor(tabId: string) {
    this.tabId = tabId;
  }

  start(request: DraftRequest, handlers: DraftHandlers): void {
    this.active?.abort();

    const controller = new AbortController();
    this.active = controller;

    void this.run(request, handlers, controller).finally(() => {
      if (this.active === controller) {
        this.active = undefined;
      }
    });
  }

  stop(): void {
    this.active?.abort();
    this.active = undefined;
  }

  private async run(request: DraftRequest, handlers: DraftHandlers, controller: AbortController): Promise<void> {
    try {
      const response = await fetch('/gardens/draft', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hive-tab-id': this.tabId,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Draft request failed (${response.status}).`);
      }
      if (!response.body) {
        throw new Error('Draft response has no stream body.');
      }

      for await (const frame of parseSseFrames(response.body, controller.signal)) {
        if (!frame.event || !frame.data) {
          continue;
        }

        let payload: DraftStreamEvent;
        try {
          payload = JSON.parse(frame.data) as DraftStreamEvent;
        } catch {
          continue;
        }

        handlers.onEvent(payload);

        if (payload.type === 'draft_error') {
          throw new Error(payload.error || 'Draft failed.');
        }

        if (payload.type === 'draft_complete') {
          handlers.onDone();
          return;
        }
      }

      handlers.onDone();
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

async function* parseSseFrames(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<{ event?: string; data?: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line.length === 0) {
          if (dataLines.length > 0) {
            yield {
              event: eventName,
              data: dataLines.join('\n'),
            };
          }
          eventName = undefined;
          dataLines = [];
          continue;
        }

        if (line.startsWith(':')) {
          continue;
        }

        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          continue;
        }

        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }
    }

    if (dataLines.length > 0) {
      yield {
        event: eventName,
        data: dataLines.join('\n'),
      };
    }
  } finally {
    reader.releaseLock();
  }
}
