import type { StreamEvent } from './streaming.js';
import {
  GenerateResponse,
  type ContentPart,
  type FinishReason,
  type FinishReasonValue,
  type Message,
  type StopReason,
  toUsage,
  type Usage,
  normalizeFinishReason,
} from './types.js';

function emptyUsage(): Usage {
  return toUsage({ input_tokens: 0, output_tokens: 0 });
}

function cloneUsage(usage: Usage): Usage {
  return toUsage({
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.reasoning_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
  });
}

function finishFromStreamStopReason(stopReason: StopReason | FinishReasonValue | undefined): FinishReason {
  return normalizeFinishReason(stopReason ?? 'other');
}

export interface StreamAccumulatorOptions {
  provider?: string;
  model?: string;
}

export class StreamAccumulator {
  private readonly provider: string;
  private model: string;
  private usage: Usage = emptyUsage();
  private finishReason: FinishReason = { reason: 'other', raw: 'in_progress' };
  private explicitResponse?: GenerateResponse;
  private explicitMessage?: Message;
  private readonly parts: ContentPart[] = [];
  private readonly toolCallOrder: string[] = [];
  private readonly toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  private activeThinking = '';
  private streamEnded = false;

  constructor(options?: StreamAccumulatorOptions) {
    this.provider = options?.provider ?? 'unknown';
    this.model = options?.model ?? 'unknown';
  }

  push(event: StreamEvent): void {
    switch (event.type) {
      case 'stream_start':
        this.model = event.model || this.model;
        break;
      case 'text_start':
      case 'text_end':
        break;
      case 'content_delta':
        this.parts.push({ type: 'text', text: event.text });
        break;
      case 'tool_call_start': {
        if (!this.toolCalls.has(event.id)) {
          this.toolCalls.set(event.id, { id: event.id, name: event.name, arguments: '' });
          this.toolCallOrder.push(event.id);
        }
        break;
      }
      case 'tool_call_delta': {
        let existing = this.toolCalls.get(event.id);
        if (!existing) {
          existing = { id: event.id, name: event.name ?? '', arguments: '' };
          this.toolCalls.set(event.id, existing);
          this.toolCallOrder.push(event.id);
        }
        if (event.name) {
          existing.name = event.name;
        }
        existing.arguments += event.arguments_delta;
        break;
      }
      case 'tool_call_end': {
        let existing = this.toolCalls.get(event.id);
        if (!existing) {
          existing = { id: event.id, name: event.name, arguments: '' };
          this.toolCalls.set(event.id, existing);
          this.toolCallOrder.push(event.id);
        }
        existing.name = event.name;
        existing.arguments = event.arguments;
        break;
      }
      case 'thinking_start':
        this.activeThinking = '';
        break;
      case 'thinking_delta':
        this.activeThinking += event.text;
        break;
      case 'thinking_end':
        if (this.activeThinking.length > 0) {
          this.parts.push({ type: 'thinking', thinking: this.activeThinking });
        }
        this.activeThinking = '';
        break;
      case 'usage':
        this.usage = cloneUsage(event.usage);
        break;
      case 'stream_end':
        this.streamEnded = true;
        this.explicitResponse = event.response;
        this.explicitMessage = event.message;
        this.finishReason = event.response?.finish_reason ?? finishFromStreamStopReason(event.stop_reason);
        if (event.response?.usage) {
          this.usage = cloneUsage(event.response.usage);
        }
        break;
      case 'step_finish':
      case 'error':
        break;
    }
  }

  get partial_response(): GenerateResponse {
    return this.buildResponse(false);
  }

  response(): GenerateResponse {
    return this.buildResponse(this.streamEnded);
  }

  private buildResponse(final: boolean): GenerateResponse {
    if (final && this.explicitResponse) {
      return this.explicitResponse;
    }

    const message = this.explicitMessage ?? this.syntheticMessage();
    const finishReason = final ? this.finishReason : { reason: 'other' as const, raw: 'in_progress' };

    return new GenerateResponse({
      id: this.extractIdFromRawMessage(message),
      message,
      usage: cloneUsage(this.usage),
      finish_reason: finishReason,
      model: this.model,
      provider: this.provider,
    });
  }

  private syntheticMessage(): Message {
    const content: ContentPart[] = [...this.parts];
    for (const toolCallId of this.toolCallOrder) {
      const toolCall = this.toolCalls.get(toolCallId);
      if (!toolCall) {
        continue;
      }
      content.push({
        type: 'tool_call',
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
    }

    if (content.length === 0) {
      return { role: 'assistant', content: '' };
    }

    return {
      role: 'assistant',
      content,
    };
  }

  private extractIdFromRawMessage(message: Message): string | undefined {
    if (!Array.isArray(message.content)) {
      return undefined;
    }
    const firstToolCall = message.content.find((part) => part.type === 'tool_call');
    return firstToolCall && firstToolCall.type === 'tool_call' ? firstToolCall.id : undefined;
  }
}
