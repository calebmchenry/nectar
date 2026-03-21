import type { LLMError } from './errors.js';
import type { FinishReasonValue, GenerateResponse, Message, StopReason, Usage } from './types.js';
import { TimeoutAbortError } from './timeouts.js';

export type StreamEvent =
  | { type: 'stream_start'; model: string }
  | { type: 'text_start'; text_id?: string }
  | { type: 'content_delta'; text: string; text_id?: string }
  | { type: 'text_end'; text_id?: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; name?: string; arguments_delta: string }
  | { type: 'tool_call_end'; id: string; name: string; arguments: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_end' }
  | { type: 'provider_event'; provider: string; provider_event: { type: string; data: unknown } }
  | { type: 'usage'; usage: Usage }
  | { type: 'step_finish'; step: number; response: GenerateResponse }
  | { type: 'stream_end'; stop_reason: StopReason | FinishReasonValue; message: Message; response: GenerateResponse }
  | { type: 'error'; error: LLMError };

interface ParseSSEOptions {
  signal?: AbortSignal;
  stream_read_ms?: number;
}

export async function* parseSSEStream(
  response: Response,
  options?: AbortSignal | ParseSSEOptions
): AsyncIterable<{ event?: string; data: string }> {
  const body = response.body;
  if (!body) return;

  const signal = options instanceof AbortSignal ? options : options?.signal;
  const streamReadTimeoutMs = options instanceof AbortSignal ? undefined : options?.stream_read_ms;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal, streamReadTimeoutMs);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last incomplete line in buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          // Empty line = dispatch event
          if (currentData.length > 0) {
            yield { event: currentEvent, data: currentData.join('\n') };
          }
          currentEvent = undefined;
          currentData = [];
          continue;
        }

        if (line.startsWith(':')) continue; // Comment

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const field = line.slice(0, colonIdx);
        // Spec: skip single space after colon
        const value2 = line[colonIdx + 1] === ' ' ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1);

        if (field === 'event') {
          currentEvent = value2;
        } else if (field === 'data') {
          currentData.push(value2);
        }
      }
    }

    // Flush remaining
    if (currentData.length > 0) {
      yield { event: currentEvent, data: currentData.join('\n') };
    }
  } finally {
    reader.releaseLock();
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  streamReadTimeoutMs?: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const races: Array<Promise<ReadableStreamReadResult<Uint8Array>>> = [reader.read()];

    if (streamReadTimeoutMs !== undefined && streamReadTimeoutMs > 0) {
      races.push(new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new TimeoutAbortError('stream_read', streamReadTimeoutMs));
        }, streamReadTimeoutMs);
      }));
    }

    if (signal) {
      races.push(new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        onAbort = () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }));
    }

    return await Promise.race(races);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
