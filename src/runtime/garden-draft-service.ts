import { UnifiedClient } from '../llm/client.js';
import type { Message, Usage } from '../llm/types.js';

const DRAFT_SYSTEM_PROMPT = [
  'You write DOT graphs for Nectar pipelines.',
  'Output only valid DOT source for one digraph.',
  'Do not include markdown, code fences, or commentary.',
  'Do not wrap the result in backticks.',
  'Start with "digraph" and end with "}".',
].join(' ');

export interface GardenDraftInput {
  prompt: string;
  provider?: string;
  model?: string;
}

export interface DraftStartEvent {
  type: 'draft_start';
  provider: string;
  model?: string;
  timestamp: string;
}

export interface DraftDeltaEvent {
  type: 'content_delta';
  text: string;
}

export interface DraftCompleteEvent {
  type: 'draft_complete';
  provider: string;
  model: string;
  dot_source: string;
  usage?: Usage;
}

export type GardenDraftEvent = DraftStartEvent | DraftDeltaEvent | DraftCompleteEvent;

export class DraftFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftFormatError';
  }
}

export class GardenDraftService {
  private readonly client: UnifiedClient;

  constructor(client?: UnifiedClient) {
    this.client = client ?? UnifiedClient.from_env();
  }

  async *streamDraft(input: GardenDraftInput, abortSignal?: AbortSignal): AsyncIterable<GardenDraftEvent> {
    const prompt = input.prompt?.trim();
    if (!prompt) {
      throw new Error('prompt is required.');
    }

    const provider = this.resolveProvider(input.provider);
    const messages: Message[] = [{ role: 'user', content: prompt }];

    yield {
      type: 'draft_start',
      provider,
      model: input.model,
      timestamp: new Date().toISOString(),
    };

    if (provider === 'simulation') {
      const simulatedDot = buildSimulationDot(prompt);
      for (const chunk of chunkText(simulatedDot, 48)) {
        if (abortSignal?.aborted) {
          throw new Error('Draft request aborted.');
        }
        yield {
          type: 'content_delta',
          text: chunk,
        };
      }
      yield {
        type: 'draft_complete',
        provider,
        model: input.model ?? 'simulation',
        dot_source: simulatedDot,
      };
      return;
    }

    let usage: Usage | undefined;
    let text = '';

    for await (const event of this.client.stream({
      provider,
      model: input.model,
      system: DRAFT_SYSTEM_PROMPT,
      messages,
      reasoning_effort: 'low',
      timeout: { request_ms: 20_000 },
      abort_signal: abortSignal,
    })) {
      if (abortSignal?.aborted) {
        throw new Error('Draft request aborted.');
      }

      if (event.type === 'content_delta') {
        text += event.text;
        if (containsMarkdownFence(text)) {
          throw new DraftFormatError('Draft response contained markdown code fences.');
        }
        yield {
          type: 'content_delta',
          text: event.text,
        };
        continue;
      }

      if (event.type === 'usage') {
        usage = event.usage;
        continue;
      }

      if (event.type === 'stream_end') {
        if (containsMarkdownFence(text)) {
          throw new DraftFormatError('Draft response contained markdown code fences.');
        }
        if (!looksLikeDot(text)) {
          throw new DraftFormatError('Draft response was not DOT source.');
        }
        yield {
          type: 'draft_complete',
          provider,
          model: input.model ?? 'default',
          dot_source: text,
          usage,
        };
        return;
      }

      if (event.type === 'error') {
        throw new Error(event.error.message);
      }
    }

    throw new Error('Draft stream ended unexpectedly.');
  }

  private resolveProvider(requested?: string): string {
    const available = this.client.available_providers();
    const realProviders = available.filter((provider) => provider !== 'simulation');

    if (!requested || requested.trim().length === 0) {
      return realProviders[0] ?? 'simulation';
    }

    const normalized = requested.trim();
    if (available.includes(normalized)) {
      return normalized;
    }

    if (realProviders.length === 0) {
      return 'simulation';
    }

    throw new Error(
      `Provider '${normalized}' is not configured. Available providers: ${available.join(', ')}`
    );
  }
}

function containsMarkdownFence(text: string): boolean {
  return /```/.test(text);
}

function looksLikeDot(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (!/^digraph\b/i.test(trimmed)) {
    return false;
  }
  return trimmed.includes('{') && trimmed.includes('}');
}

function buildSimulationDot(prompt: string): string {
  const label = prompt.replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 120) || 'Drafted pipeline';
  return `digraph Drafted {\n  graph [label="${label}"]\n\n  start [shape=Mdiamond, label="Start"]\n  plan [shape=box, label="Plan", prompt="Create a concise implementation plan."]\n  implement [shape=parallelogram, label="Implement", script="echo Implementing plan"]\n  test [shape=parallelogram, label="Test", script="echo Running tests"]\n  done [shape=Msquare, label="Done"]\n\n  start -> plan\n  plan -> implement\n  implement -> test\n  test -> done\n}\n`;
}

function chunkText(value: string, chunkSize: number): string[] {
  if (chunkSize <= 0) {
    return [value];
  }
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += chunkSize) {
    chunks.push(value.slice(i, i + chunkSize));
  }
  return chunks;
}
