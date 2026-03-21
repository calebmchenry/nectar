import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderAdapter } from './adapters/types.js';
import {
  GenerateResponse,
  GenerateResult,
  Message,
  normalizeContent,
  toUsage,
} from './types.js';
import type {
  ContentPart,
  GenerateOptions,
  GenerateRequest,
  StepResult,
  JsonSchemaDefinition,
  LLMClient,
  LLMRequest,
  LLMResponse,
  StopCondition,
  ToolCallContentPart,
  ToolResultContentPart,
  Usage,
} from './types.js';
import type { StreamEvent } from './streaming.js';
import type { Middleware, GenerateFn, StreamFn } from './middleware.js';
import { composeGenerateChain, composeStreamChain } from './middleware.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { SimulationProvider } from './simulation.js';
import { createRetryMiddleware } from './retry.js';
import { ConfigurationError, InvalidRequestError, StreamError, StructuredOutputError } from './errors.js';
import { extractJsonText, validateAgainstSchema, buildValidationRetryMessages } from './structured.js';
import { IncrementalJsonParser } from './incremental-json.js';
import { isActiveTool, type ToolContext, type ToolDefinition } from './tools.js';
import { StreamAccumulator } from './stream-accumulator.js';

const PROVIDER_PRIORITY = ['anthropic', 'openai', 'openai_compatible', 'gemini', 'simulation'] as const;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
};

export interface GenerateObjectRequest extends GenerateRequest {
  response_format: { type: 'json_schema'; json_schema: JsonSchemaDefinition };
  max_validation_retries?: number;
}

export interface GenerateObjectResponse<T> extends GenerateResponse {
  object: T;
  raw_text: string;
}

export type StreamObjectEvent<T> =
  | { type: 'partial'; object: Partial<T>; text_so_far: string }
  | { type: 'complete'; object: T; raw_text: string; usage: Usage }
  | { type: 'error'; error: StructuredOutputError };

function addUsage(a: Usage, b: Usage): Usage {
  return toUsage({
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    reasoning_tokens: (a.reasoning_tokens ?? 0) + (b.reasoning_tokens ?? 0) || undefined,
    cache_read_tokens: (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0) || undefined,
    cache_write_tokens: (a.cache_write_tokens ?? 0) + (b.cache_write_tokens ?? 0) || undefined,
  });
}

function toUsageOrZero(usage: Usage | undefined): Usage {
  if (!usage) {
    return toUsage({ input_tokens: 0, output_tokens: 0 });
  }
  return toUsage(usage);
}

function ensureGenerateResponse(response: GenerateResponse | Record<string, unknown>): GenerateResponse {
  if (response instanceof GenerateResponse) {
    return response;
  }

  const raw = response as Record<string, unknown>;
  return new GenerateResponse({
    message: raw['message'] as GenerateResponse['message'],
    usage: toUsageOrZero(raw['usage'] as Usage | undefined),
    finish_reason: (raw['finish_reason'] ?? raw['stop_reason']) as string | undefined,
    model: String(raw['model'] ?? 'unknown'),
    provider: String(raw['provider'] ?? 'unknown'),
    id: typeof raw['id'] === 'string' ? raw['id'] : undefined,
    raw: raw['raw'],
    warnings: Array.isArray(raw['warnings']) ? raw['warnings'] as GenerateResponse['warnings'] : [],
    rate_limit: raw['rate_limit'] as GenerateResponse['rate_limit'],
  });
}

function normalizePromptRequest(request: GenerateRequest): GenerateRequest {
  if (typeof request.prompt === 'string' && request.messages && request.messages.length > 0) {
    throw new InvalidRequestError(
      request.provider ?? 'unified',
      'generate() cannot include both prompt and messages. Provide exactly one.',
    );
  }
  if (request.messages && request.messages.length > 0) {
    return request;
  }
  if (typeof request.prompt !== 'string') {
    throw new InvalidRequestError(request.provider ?? 'unified', 'generate() requires either messages or prompt.');
  }
  return {
    ...request,
    messages: [Message.user(request.prompt)],
  };
}

function isImageMediaType(mediaType: string | undefined): boolean {
  return Boolean(mediaType && /^image\/[a-z0-9.+-]+$/i.test(mediaType));
}

function isRemoteImageUri(value: string): boolean {
  return /^(https?:\/\/|gs:\/\/|s3:\/\/|data:)/i.test(value);
}

function resolveImageMimeFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[ext];
}

async function normalizeImagePart(part: Extract<ContentPart, { type: 'image' }>, provider = 'unified'): Promise<ContentPart> {
  if (part.source.type === 'base64') {
    if (!isImageMediaType(part.source.media_type)) {
      throw new InvalidRequestError(provider, `Image base64 media_type must be image/*, received '${part.source.media_type}'.`);
    }
    if (!part.source.data || part.source.data.trim().length === 0) {
      throw new InvalidRequestError(provider, 'Image base64 source is empty.');
    }
    return part;
  }

  const sourceUrl = part.source.url.trim();
  if (!sourceUrl) {
    throw new InvalidRequestError(provider, 'Image URL source is empty.');
  }

  if (isRemoteImageUri(sourceUrl)) {
    return part;
  }

  // Root cause note (Sprint 026): local file image paths were previously passed as
  // opaque URLs, which caused provider-specific failures or silent drops.
  const absolutePath = path.resolve(sourceUrl);
  let fileInfo;
  try {
    fileInfo = await stat(absolutePath);
  } catch (error) {
    throw new InvalidRequestError(provider, `Image file '${sourceUrl}' was not found.`, error);
  }

  if (!fileInfo.isFile()) {
    throw new InvalidRequestError(provider, `Image path '${sourceUrl}' is not a file.`);
  }
  if (fileInfo.size > MAX_INLINE_IMAGE_BYTES) {
    throw new InvalidRequestError(
      provider,
      `Image file '${sourceUrl}' exceeds ${MAX_INLINE_IMAGE_BYTES} byte inline limit.`,
    );
  }

  const mediaType = resolveImageMimeFromPath(absolutePath);
  if (!isImageMediaType(mediaType)) {
    throw new InvalidRequestError(provider, `Unsupported image file type for '${sourceUrl}'.`);
  }

  const bytes = await readFile(absolutePath);
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType!,
      data: bytes.toString('base64'),
    },
  };
}

async function normalizeRequestImages(request: GenerateRequest): Promise<GenerateRequest> {
  if (!request.messages || request.messages.length === 0) {
    return request;
  }
  let mutated = false;
  const provider = request.provider ?? 'unified';
  const normalizedMessages = await Promise.all(request.messages.map(async (message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    let contentMutated = false;
    const normalizedParts = await Promise.all(message.content.map(async (part) => {
      if (part.type !== 'image') {
        return part;
      }
      const normalized = await normalizeImagePart(part, provider);
      if (normalized !== part) {
        contentMutated = true;
      }
      return normalized;
    }));

    if (!contentMutated) {
      return message;
    }

    mutated = true;
    return {
      ...message,
      content: normalizedParts,
    };
  }));

  if (!mutated) {
    return request;
  }

  return {
    ...request,
    messages: normalizedMessages,
  };
}

export class UnifiedClient implements LLMClient {
  private readonly providers: Map<string, ProviderAdapter>;
  private readonly defaultProvider: string;
  private readonly middlewares: Middleware[] = [];
  private composedGenerate: GenerateFn | null = null;
  private composedStream: StreamFn | null = null;

  constructor(providers: Map<string, ProviderAdapter>) {
    this.providers = providers;

    // Default: first available in priority order
    this.defaultProvider = 'simulation';
    for (const name of PROVIDER_PRIORITY) {
      if (this.providers.has(name)) {
        this.defaultProvider = name;
        break;
      }
    }
  }

  static from_env(): UnifiedClient {
    const providers = new Map<string, ProviderAdapter>();

    const anthropicKey = process.env['ANTHROPIC_API_KEY'];
    if (anthropicKey) {
      providers.set('anthropic', new AnthropicAdapter(anthropicKey));
    }

    const openaiKey = process.env['OPENAI_API_KEY'];
    if (openaiKey) {
      providers.set('openai', new OpenAIAdapter(openaiKey));
    }

    const openAICompatibleBaseUrl = process.env['OPENAI_COMPATIBLE_BASE_URL'];
    if (openAICompatibleBaseUrl) {
      providers.set(
        'openai_compatible',
        new OpenAICompatibleAdapter(process.env['OPENAI_COMPATIBLE_API_KEY'] ?? '', openAICompatibleBaseUrl),
      );
    }

    const geminiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
    if (geminiKey) {
      providers.set('gemini', new GeminiAdapter(geminiKey));
    }

    // Always include simulation as fallback
    providers.set('simulation', new SimulationProvider());

    const client = new UnifiedClient(providers);
    // Register retry middleware automatically
    client.use(createRetryMiddleware());
    return client;
  }

  /**
   * Register a middleware. Returns `this` for chaining.
   */
  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    // Invalidate composed chains so they're rebuilt on next call
    this.composedGenerate = null;
    this.composedStream = null;
    return this;
  }

  private resolveProvider(providerName?: string): ProviderAdapter {
    const name = providerName ?? this.defaultProvider;
    const adapter = this.providers.get(name);
    if (!adapter) {
      throw new InvalidRequestError(
        name,
        `Provider '${name}' is not configured. Available: ${[...this.providers.keys()].join(', ')}`
      );
    }
    return adapter;
  }

  private getGenerateChain(): GenerateFn {
    if (!this.composedGenerate) {
      const terminal: GenerateFn = async (request) => {
        const normalized = await normalizeRequestImages(request);
        const adapter = this.resolveProvider(normalized.provider);
        const response = await adapter.generate(normalized);
        return ensureGenerateResponse(response as GenerateResponse | Record<string, unknown>);
      };
      this.composedGenerate = composeGenerateChain(this.middlewares, terminal);
    }
    return this.composedGenerate;
  }

  private getStreamChain(): StreamFn {
    if (!this.composedStream) {
      const terminal: StreamFn = (request) => {
        return this.streamWithNormalizedRequest(request);
      };
      this.composedStream = composeStreamChain(this.middlewares, terminal);
    }
    return this.composedStream;
  }

  private async *streamWithNormalizedRequest(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const normalized = await normalizeRequestImages(request);
    const adapter = this.resolveProvider(normalized.provider);
    for await (const event of adapter.stream(normalized)) {
      yield event;
    }
  }

  available_providers(): string[] {
    return [...this.providers.keys()];
  }

  // New unified generate — routes through middleware chain
  async generateUnified(request: GenerateRequest): Promise<GenerateResponse> {
    return this.getGenerateChain()(request);
  }

  // Streaming — routes through middleware chain
  stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    return this.getStreamChain()(request);
  }

  // Structured output: generate and validate a typed object
  async generateObject<T>(request: GenerateObjectRequest): Promise<GenerateObjectResponse<T>> {
    if (request.response_format.type !== 'json_schema') {
      throw new InvalidRequestError(
        request.provider ?? this.defaultProvider,
        'generateObject() requires response_format.type === "json_schema"'
      );
    }

    const maxRetries = request.max_validation_retries ?? 2;
    const schema = request.response_format.json_schema.schema;
    let currentMessages = request.messages;
    let totalUsage: Usage = toUsage({ input_tokens: 0, output_tokens: 0 });
    let lastResponse: GenerateResponse | undefined;
    let lastRawText = '';
    let lastErrors: string[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.generateUnified({
        ...request,
        messages: currentMessages,
      });

      lastResponse = response;
      totalUsage = addUsage(totalUsage, response.usage);

      const rawText = extractJsonText(response);
      lastRawText = rawText;

      // Try parsing JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch (e) {
        const parseErr = e instanceof Error ? e.message : String(e);
        lastErrors = [`JSON parse error: ${parseErr}`];

        if (attempt < maxRetries) {
          currentMessages = buildValidationRetryMessages(
            currentMessages,
            rawText,
            lastErrors
          );
          continue;
        }

        throw new StructuredOutputError({
          provider: response.provider,
          rawText,
          validationErrors: lastErrors,
          schema,
          parseError: parseErr,
        });
      }

      // Validate against schema
      const validation = validateAgainstSchema(parsed, schema);
      if (validation.valid) {
        const finalResponse = new GenerateResponse({
          message: response.message,
          usage: totalUsage,
          finish_reason: response.finish_reason,
          model: response.model,
          provider: response.provider,
          id: response.id,
          raw: response.raw,
          warnings: response.warnings,
          rate_limit: response.rate_limit,
        });
        return Object.assign(finalResponse, {
          object: parsed as T,
          raw_text: rawText,
        }) as GenerateObjectResponse<T>;
      }

      lastErrors = validation.errors;

      if (attempt < maxRetries) {
        currentMessages = buildValidationRetryMessages(
          currentMessages,
          rawText,
          validation.errors
        );
        continue;
      }
    }

    throw new StructuredOutputError({
      provider: lastResponse?.provider ?? request.provider ?? this.defaultProvider,
      rawText: lastRawText,
      validationErrors: lastErrors,
      schema,
    });
  }

  // Streaming structured output
  async *streamObject<T>(request: GenerateObjectRequest): AsyncIterable<StreamObjectEvent<T>> {
    if (request.response_format.type !== 'json_schema') {
      throw new InvalidRequestError(
        request.provider ?? this.defaultProvider,
        'streamObject() requires response_format.type === "json_schema"'
      );
    }

    const schema = request.response_format.json_schema.schema;
    let textBuffer = '';
    let finalUsage: Usage = toUsage({ input_tokens: 0, output_tokens: 0 });
    const parser = new IncrementalJsonParser<T & Record<string, unknown>>();
    let parserFailed = false;

    for await (const event of this.stream(request)) {
      if (event.type === 'content_delta') {
        textBuffer += event.text;
        if (!parserFailed) {
          try {
            const partials = parser.feed(event.text);
            for (const partial of partials) {
              yield { type: 'partial', object: partial as Partial<T>, text_so_far: textBuffer };
            }
          } catch {
            // Root cause note (Sprint 025 GAP-4): malformed/extra stream bytes should not
            // break structured streaming; we fall back to buffered parsing on stream_end.
            parserFailed = true;
          }
        } else {
          yield { type: 'partial', object: {} as Partial<T>, text_so_far: textBuffer };
        }
      } else if (event.type === 'usage') {
        finalUsage = event.usage;
      } else if (event.type === 'stream_end') {
        // Parse and validate
        let text = textBuffer.trim();
        const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
        if (fenceMatch) {
          text = fenceMatch[1]!.trim();
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          const parseErr = e instanceof Error ? e.message : String(e);
          yield {
            type: 'error',
            error: new StructuredOutputError({
              provider: request.provider ?? this.defaultProvider,
              rawText: text,
              validationErrors: [`JSON parse error: ${parseErr}`],
              schema,
              parseError: parseErr,
            }),
          };
          return;
        }

        const validation = validateAgainstSchema(parsed, schema);
        if (validation.valid) {
          yield {
            type: 'complete',
            object: parsed as T,
            raw_text: text,
            usage: finalUsage,
          };
        } else {
          yield {
            type: 'error',
            error: new StructuredOutputError({
              provider: request.provider ?? this.defaultProvider,
              rawText: text,
              validationErrors: validation.errors,
              schema,
            }),
          };
        }
      }
    }
  }

  // Legacy LLMClient.generate — keeps backward compat with existing CodergenHandler
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const adapter = this.resolveProvider(undefined);
    const response = await adapter.generate({
      model: request.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.max_tokens,
      system: request.system
    });

    // Extract text from response
    const text = typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content
          .filter((p) => p.type === 'text')
          .map((p) => ('text' in p ? p.text : ''))
          .join('');

    return {
      content: text,
      model: response.model,
      usage: response.usage
        ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens }
        : undefined,
      stop_reason: response.stop_reason
    };
  }
}

// Legacy factory — now returns UnifiedClient which implements LLMClient
export function createLLMClient(): UnifiedClient {
  return UnifiedClient.from_env();
}

// ── Module-level default client (L2) ────────────────────────────────────────

let _defaultClient: UnifiedClient | null = null;

/**
 * Set the module-level default client. Overrides lazy initialization.
 */
export function setDefaultClient(client: UnifiedClient): void {
  _defaultClient = client;
}

/**
 * Get the module-level default client.
 * Returns a previously set client, or lazily initializes from `UnifiedClient.from_env()`.
 * Throws `ConfigurationError` if no providers are configured and no default set.
 */
export function getDefaultClient(): UnifiedClient {
  if (_defaultClient) return _defaultClient;

  const client = UnifiedClient.from_env();
  // Check that at least one real provider is available (not just simulation)
  const realProviders = client.available_providers().filter(p => p !== 'simulation');
  if (realProviders.length === 0) {
    throw new ConfigurationError();
  }

  _defaultClient = client;
  return _defaultClient;
}

/**
 * Clear the module-level default client. For test teardown.
 */
export function clearDefaultClient(): void {
  _defaultClient = null;
}

function extractToolCalls(response: GenerateResponse): Array<Extract<ContentPart, { type: 'tool_call' }>> {
  return normalizeContent(response.message.content)
    .filter((part): part is Extract<ContentPart, { type: 'tool_call' }> => part.type === 'tool_call');
}

function normalizeToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result === undefined) {
    return '';
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

async function executeToolCalls(
  toolCalls: ToolCallContentPart[],
  handlers: Map<string, (args: Record<string, unknown>, context: ToolContext) => Promise<string>>,
  contextMessages: Message[],
  abortSignal?: AbortSignal,
): Promise<ToolResultContentPart[]> {
  const calls = toolCalls.map(async (call): Promise<ToolResultContentPart> => {
    const handler = handlers.get(call.name);
    if (!handler) {
      return {
        type: 'tool_result',
        tool_call_id: call.id,
        content: `No execute handler registered for tool '${call.name}'.`,
        is_error: true,
      };
    }

    let parsedArgs: Record<string, unknown>;
    try {
      const parsed = call.arguments ? JSON.parse(call.arguments) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          type: 'tool_result',
          tool_call_id: call.id,
          content: `Invalid arguments for '${call.name}': expected a JSON object.`,
          is_error: true,
        };
      }
      parsedArgs = parsed as Record<string, unknown>;
    } catch (error) {
      return {
        type: 'tool_result',
        tool_call_id: call.id,
        content: `Invalid JSON arguments for '${call.name}': ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }

    try {
      const output = await handler(parsedArgs, {
        messages: contextMessages,
        abort_signal: abortSignal,
        tool_call_id: call.id,
      });
      return {
        type: 'tool_result',
        tool_call_id: call.id,
        content: output,
        is_error: false,
      };
    } catch (error) {
      return {
        type: 'tool_result',
        tool_call_id: call.id,
        content: error instanceof Error ? error.message : String(error),
        is_error: true,
      };
    }
  });

  return Promise.all(calls);
}

function resolveToolHandlers(
  requestTools: ToolDefinition[] | undefined,
  legacyTools: Map<string, (args: unknown) => Promise<unknown>> | undefined,
): Map<string, (args: Record<string, unknown>, context: ToolContext) => Promise<string>> {
  const handlers = new Map<string, (args: Record<string, unknown>, context: ToolContext) => Promise<string>>();

  for (const tool of requestTools ?? []) {
    if (!isActiveTool(tool)) {
      continue;
    }
    handlers.set(tool.name, async (args, context) => tool.execute(args, context));
  }

  for (const [name, handler] of legacyTools ?? []) {
    if (handlers.has(name)) {
      continue;
    }
    handlers.set(name, async (args) => normalizeToolResult(await handler(args)));
  }

  return handlers;
}

function shouldAutoExecuteAllCalls(
  toolCalls: ToolCallContentPart[],
  handlers: Map<string, (args: Record<string, unknown>, context: ToolContext) => Promise<string>>,
): boolean {
  return toolCalls.every((toolCall) => handlers.has(toolCall.name));
}

async function evaluateStopCondition(
  condition: StopCondition | undefined,
  response: GenerateResponse,
  steps: StepResult[],
): Promise<boolean> {
  if (!condition) {
    return false;
  }
  const step = steps.length;
  return Boolean(await condition(response, { step, steps }));
}

function resolveMaxToolRounds(request: GenerateRequest, opts?: GenerateOptions): number {
  if (request.max_tool_rounds !== undefined) {
    return Math.max(0, request.max_tool_rounds);
  }
  if (opts !== undefined) {
    return Math.max(0, opts.maxIterations ?? 10);
  }
  return 1;
}

/**
 * Module-level generate — delegates to the default client.
 */
export async function generate(
  request: GenerateRequest,
  opts?: GenerateOptions,
): Promise<GenerateResult> {
  const client = opts?.client ?? getDefaultClient();
  const normalizedRequest = normalizePromptRequest(request);
  const handlers = resolveToolHandlers(normalizedRequest.tools, opts?.tools);
  const maxIterations = resolveMaxToolRounds(normalizedRequest, opts);
  const steps: StepResult[] = [];
  let totalUsage: Usage = toUsage({ input_tokens: 0, output_tokens: 0 });
  let iteration = 0;
  let currentRequest = normalizedRequest;
  let response = await client.generateUnified(currentRequest);

  while (true) {
    const toolCalls = extractToolCalls(response);
    totalUsage = addUsage(totalUsage, response.usage);
    steps.push({
      step: steps.length + 1,
      output: response,
      usage: response.usage,
      tool_calls: toolCalls,
    });

    if (await evaluateStopCondition(normalizedRequest.stop_when, response, steps)) {
      break;
    }

    if (toolCalls.length === 0 || iteration >= maxIterations) {
      break;
    }

    // Passive tools are returned to the caller unchanged.
    if (!shouldAutoExecuteAllCalls(toolCalls, handlers)) {
      break;
    }

    const contextMessages = [...(currentRequest.messages ?? []), response.message];
    const toolResults = await executeToolCalls(toolCalls, handlers, contextMessages, currentRequest.abort_signal);
    steps[steps.length - 1]!.tool_results = toolResults;

    const toolMessage = {
      role: 'tool' as const,
      content: toolResults,
    };
    currentRequest = {
      ...currentRequest,
      messages: [...(currentRequest.messages ?? []), response.message, toolMessage],
    };

    response = await client.generateUnified(currentRequest);
    iteration += 1;
  }

  return new GenerateResult({
    output: response,
    steps,
    total_usage: totalUsage,
  });
}

/**
 * Backward-compatible stream wrapper with response accumulation and tool-loop support.
 */
export class StreamResult implements AsyncIterable<StreamEvent> {
  private readonly source: AsyncIterable<StreamEvent>;
  private readonly accumulator: StreamAccumulator;
  private consumeStarted = false;
  private consumed = false;
  private consumeError: unknown;
  private readonly done: Promise<void>;
  private doneResolve!: () => void;
  private doneReject!: (error: unknown) => void;

  constructor(source: AsyncIterable<StreamEvent>, options?: { provider?: string; model?: string }) {
    this.source = source;
    this.accumulator = new StreamAccumulator(options);
    this.done = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (this.consumeStarted) {
      throw new Error('StreamResult can only be iterated once.');
    }
    this.consumeStarted = true;
    return this.consumeGenerator()[Symbol.asyncIterator]();
  }

  get text_stream(): AsyncIterable<string> {
    const self = this;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<string> {
        for await (const event of self) {
          if (event.type === 'content_delta') {
            yield event.text;
          }
        }
      },
    };
  }

  get partial_response(): GenerateResponse {
    return this.accumulator.partial_response;
  }

  async response(): Promise<GenerateResponse> {
    if (!this.consumeStarted) {
      for await (const _event of this) {
        // Drain when caller requests response without iterating.
      }
    }
    await this.done;
    if (this.consumeError) {
      throw this.consumeError;
    }
    return this.accumulator.response();
  }

  private async *consumeGenerator(): AsyncGenerator<StreamEvent> {
    try {
      for await (const event of this.source) {
        this.accumulator.push(event);
        yield event;
      }
      this.consumed = true;
      this.doneResolve();
    } catch (error) {
      this.consumeError = error;
      this.doneReject(error);
      throw error;
    }
  }
}

async function* streamWithToolLoop(
  request: GenerateRequest,
  client: UnifiedClient,
  handlers: Map<string, (args: Record<string, unknown>, context: ToolContext) => Promise<string>>,
): AsyncIterable<StreamEvent> {
  let currentRequest = normalizePromptRequest(request);
  let step = 0;
  const maxIterations = resolveMaxToolRounds(currentRequest);
  let iteration = 0;

  while (true) {
    step += 1;
    const stepAccumulator = new StreamAccumulator({
      provider: currentRequest.provider,
      model: currentRequest.model,
    });

    for await (const event of client.stream(currentRequest)) {
      stepAccumulator.push(event);
      yield event;
    }

    if (!stepAccumulator.hasStreamEnd()) {
      yield {
        type: 'error',
        error: new StreamError(currentRequest.provider ?? 'unified', {
          phase: 'transport',
          message: 'Stream ended without a terminal stream_end event.',
        }),
      };
      return;
    }

    const response = stepAccumulator.response();
    yield { type: 'step_finish', step, response };

    const toolCalls = extractToolCalls(response);
    if (toolCalls.length === 0 || iteration >= maxIterations) {
      return;
    }

    if (!shouldAutoExecuteAllCalls(toolCalls, handlers)) {
      return;
    }

    const contextMessages = [...(currentRequest.messages ?? []), response.message];
    const toolResults = await executeToolCalls(toolCalls, handlers, contextMessages, currentRequest.abort_signal);
    currentRequest = {
      ...currentRequest,
      messages: [...(currentRequest.messages ?? []), response.message, { role: 'tool', content: toolResults }],
    };
    iteration += 1;
  }
}

export function stream(
  request: GenerateRequest,
  opts?: { client?: UnifiedClient; tools?: Map<string, (args: unknown) => Promise<unknown> > }
): StreamResult {
  const client = opts?.client ?? getDefaultClient();
  const normalizedRequest = normalizePromptRequest(request);
  const handlers = resolveToolHandlers(normalizedRequest.tools, opts?.tools);
  const source = streamWithToolLoop(normalizedRequest, client, handlers);
  return new StreamResult(source, {
    provider: normalizedRequest.provider,
    model: normalizedRequest.model,
  });
}

// Re-export for backward compat — tests import AnthropicProvider from client.ts
export { AnthropicAdapter as AnthropicProvider } from './adapters/anthropic.js';
