import type { LLMError } from './errors.js';
import type { Message, StopReason, Usage } from './types.js';

export type StreamEvent =
  | { type: 'stream_start'; model: string }
  | { type: 'content_delta'; text: string }
  | { type: 'tool_call_delta'; id: string; name?: string; arguments_delta: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'stream_end'; stop_reason: StopReason; message: Message }
  | { type: 'error'; error: LLMError };

export async function* parseSSEStream(
  response: Response,
  signal?: AbortSignal
): AsyncIterable<{ event?: string; data: string }> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
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
