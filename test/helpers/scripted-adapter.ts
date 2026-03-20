/**
 * ScriptedAdapter — deterministic fake ProviderAdapter for agent session tests.
 * No real LLM calls. Yields pre-programmed sequences of responses.
 */
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { GenerateRequest, GenerateResponse, Message, ContentPart, Usage } from '../../src/llm/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';

export interface ScriptedTurn {
  /** Text to return as assistant content */
  text?: string;
  /** Tool calls to return */
  tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Stop reason — defaults to 'end_turn' if no tool_calls, 'tool_use' if tool_calls present */
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens';
  /** Simulated usage */
  usage?: Usage;
}

export class ScriptedAdapter implements ProviderAdapter {
  readonly provider_name = 'scripted';
  private turns: ScriptedTurn[];
  private turnIndex = 0;

  constructor(turns: ScriptedTurn[]) {
    this.turns = turns;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const turn = this.nextTurn();
    const parts: ContentPart[] = [];
    if (turn.text) parts.push({ type: 'text', text: turn.text });
    for (const tc of turn.tool_calls ?? []) {
      parts.push({ type: 'tool_call', id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) });
    }

    const stopReason = turn.stop_reason ?? (turn.tool_calls?.length ? 'tool_use' : 'end_turn');

    return {
      message: { role: 'assistant', content: parts.length > 0 ? parts : (turn.text ?? '') },
      usage: turn.usage ?? { input_tokens: 10, output_tokens: 20 },
      stop_reason: stopReason,
      model: 'scripted-model',
      provider: 'scripted',
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const turn = this.nextTurn();
    const stopReason = turn.stop_reason ?? (turn.tool_calls?.length ? 'tool_use' : 'end_turn');
    const usage = turn.usage ?? { input_tokens: 10, output_tokens: 20 };

    yield { type: 'stream_start', model: 'scripted-model' };

    if (turn.text) {
      yield { type: 'content_delta', text: turn.text };
    }

    for (const tc of turn.tool_calls ?? []) {
      yield { type: 'tool_call_delta', id: tc.id, name: tc.name, arguments_delta: JSON.stringify(tc.arguments) };
    }

    yield { type: 'usage', usage };

    // Build final message
    const parts: ContentPart[] = [];
    if (turn.text) parts.push({ type: 'text', text: turn.text });
    for (const tc of turn.tool_calls ?? []) {
      parts.push({ type: 'tool_call', id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) });
    }
    const message: Message = { role: 'assistant', content: parts.length > 0 ? parts : (turn.text ?? '') };

    yield { type: 'stream_end', stop_reason: stopReason, message };
  }

  private nextTurn(): ScriptedTurn {
    if (this.turnIndex >= this.turns.length) {
      // Default: end turn with generic text
      return { text: 'No more scripted turns available.', stop_reason: 'end_turn' };
    }
    return this.turns[this.turnIndex++]!;
  }

  /** How many turns have been consumed */
  get consumedTurns(): number {
    return this.turnIndex;
  }
}
