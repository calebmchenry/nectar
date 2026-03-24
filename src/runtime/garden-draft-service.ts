import { GardenParseError } from '../garden/parse.js';
import { PipelinePreparer } from '../garden/preparer.js';
import type { Diagnostic } from '../garden/types.js';
import type { WorkspaceConfigLoader } from '../config/workspace.js';
import { UnifiedClient } from '../llm/client.js';
import type { Message, Usage } from '../llm/types.js';

const DRAFT_SYSTEM_PROMPT = [
  'You write DOT graphs for Nectar pipelines.',
  'Output only valid DOT source for one digraph.',
  'Do not include markdown, code fences, or commentary.',
  'Do not wrap the result in backticks.',
  'Start with "digraph" and end with "}".',
  'Include exactly one start node (Mdiamond) and exactly one root exit node (Msquare).',
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

export class DraftValidationError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message);
    this.name = 'DraftValidationError';
    this.diagnostics = diagnostics;
  }
}

export class GardenDraftService {
  private readonly client: UnifiedClient;
  private readonly preparer: PipelinePreparer;
  private readonly configLoader?: WorkspaceConfigLoader;

  constructor(client?: UnifiedClient, preparer?: PipelinePreparer, configLoader?: WorkspaceConfigLoader) {
    this.client = client ?? UnifiedClient.from_env();
    this.preparer = preparer ?? new PipelinePreparer();
    this.configLoader = configLoader;
  }

  async *streamDraft(input: GardenDraftInput, abortSignal?: AbortSignal): AsyncIterable<GardenDraftEvent> {
    const prompt = input.prompt?.trim();
    if (!prompt) {
      throw new Error('prompt is required.');
    }

    const loadedConfig = await this.configLoader?.load();
    const resolved = this.resolveSelection(input, loadedConfig?.resolved.draft);
    const provider = resolved.provider;
    const model = resolved.model;
    const messages: Message[] = [{ role: 'user', content: prompt }];

    yield {
      type: 'draft_start',
      provider,
      model,
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
      await this.validateDraftDot(simulatedDot);
      yield {
        type: 'draft_complete',
        provider,
        model,
        dot_source: simulatedDot,
      };
      return;
    }

    let usage: Usage | undefined;
    let text = '';

    const requestModel = model === 'default' ? undefined : model;
    for await (const event of this.client.stream({
      provider,
      model: requestModel,
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
        await this.validateDraftDot(text);
        yield {
          type: 'draft_complete',
          provider,
          model,
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

  private resolveSelection(
    input: GardenDraftInput,
    configDraft?: { provider: string; model: string },
  ): { provider: string; model: string } {
    const available = this.client.available_providers();
    const requestedProvider = normalizeString(input.provider);
    const requestedModel = normalizeString(input.model);

    const provider = requestedProvider
      ?? normalizeString(configDraft?.provider)
      ?? 'simulation';

    if (!available.includes(provider)) {
      throw new Error(
        `Provider '${provider}' is not configured. Available providers: ${available.join(', ')}`
      );
    }

    const configModel = normalizeString(configDraft?.model);
    const model = requestedModel
      ?? (requestedProvider ? undefined : configModel)
      ?? (provider === 'simulation' ? 'simulation' : 'default');

    return {
      provider,
      model,
    };
  }

  private async validateDraftDot(dotSource: string): Promise<void> {
    try {
      const prepared = await this.preparer.prepareFromSource(dotSource, '<draft>');
      const errors = prepared.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      if (errors.length === 0) {
        return;
      }
      const preview = errors
        .slice(0, 3)
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join('; ');
      throw new DraftValidationError(
        `Draft DOT failed validation (${errors.length} error${errors.length === 1 ? '' : 's'}). ${preview}`,
        errors,
      );
    } catch (error) {
      if (error instanceof DraftValidationError) {
        throw error;
      }
      if (error instanceof GardenParseError) {
        throw new DraftValidationError('Draft DOT failed to parse.', [
          {
            severity: 'error',
            code: 'DOT_PARSE_ERROR',
            message: error.message,
            file: '<draft>',
            location: error.location,
          },
        ]);
      }
      throw error;
    }
  }
}

function normalizeString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized;
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
  return `digraph Drafted {\n  graph [label="${label}"]\n\n  start [shape=Mdiamond, label="Start"]\n  plan [shape=box, label="Plan", prompt="Create a concise implementation plan."]\n  implement [shape=parallelogram, label="Implement", tool_command="echo Implementing plan"]\n  test [shape=parallelogram, label="Test", tool_command="echo Running tests"]\n  done [shape=Msquare, label="Done"]\n\n  start -> plan\n  plan -> implement\n  implement -> test\n  test -> done\n}\n`;
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
