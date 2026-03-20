import type { ProviderAdapter } from './adapters/types.js';
import type { GenerateRequest, GenerateResponse, JsonSchemaDefinition, LLMClient, LLMRequest, LLMResponse, ResponseFormat, Usage } from './types.js';
import type { StreamEvent } from './streaming.js';
import type { Middleware, GenerateFn, StreamFn } from './middleware.js';
import { composeGenerateChain, composeStreamChain } from './middleware.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { SimulationProvider } from './simulation.js';
import { withRetry, createRetryMiddleware } from './retry.js';
import { ConfigurationError, InvalidRequestError, StructuredOutputError } from './errors.js';
import { extractJsonText, validateAgainstSchema, buildValidationRetryMessages } from './structured.js';

const PROVIDER_PRIORITY = ['anthropic', 'openai', 'gemini', 'simulation'] as const;

export interface GenerateObjectRequest extends GenerateRequest {
  response_format: { type: 'json_schema'; json_schema: JsonSchemaDefinition };
  max_validation_retries?: number;
}

export interface GenerateObjectResponse<T> extends GenerateResponse {
  object: T;
  raw_text: string;
}

export type StreamObjectEvent<T> =
  | { type: 'partial'; text_so_far: string }
  | { type: 'object'; object: T; raw_text: string; usage: Usage }
  | { type: 'error'; error: StructuredOutputError };

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    reasoning_tokens: (a.reasoning_tokens ?? 0) + (b.reasoning_tokens ?? 0) || undefined,
    cache_read_tokens: (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0) || undefined,
    cache_write_tokens: (a.cache_write_tokens ?? 0) + (b.cache_write_tokens ?? 0) || undefined,
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
      const terminal: GenerateFn = (request) => {
        const adapter = this.resolveProvider(request.provider);
        return adapter.generate(request);
      };
      this.composedGenerate = composeGenerateChain(this.middlewares, terminal);
    }
    return this.composedGenerate;
  }

  private getStreamChain(): StreamFn {
    if (!this.composedStream) {
      const terminal: StreamFn = (request) => {
        const adapter = this.resolveProvider(request.provider);
        return adapter.stream(request);
      };
      this.composedStream = composeStreamChain(this.middlewares, terminal);
    }
    return this.composedStream;
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
    let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
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
        return {
          ...response,
          usage: totalUsage,
          object: parsed as T,
          raw_text: rawText,
        };
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
    let finalUsage: Usage = { input_tokens: 0, output_tokens: 0 };

    for await (const event of this.stream(request)) {
      if (event.type === 'content_delta') {
        textBuffer += event.text;
        yield { type: 'partial', text_so_far: textBuffer };
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
            type: 'object',
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

/**
 * Module-level generate — delegates to the default client.
 */
export async function generate(
  request: GenerateRequest,
  opts?: { client?: UnifiedClient }
): Promise<GenerateResponse> {
  const client = opts?.client ?? getDefaultClient();
  return client.generateUnified(request);
}

/**
 * Module-level stream — delegates to the default client.
 */
export function stream(
  request: GenerateRequest,
  opts?: { client?: UnifiedClient }
): AsyncIterable<StreamEvent> {
  const client = opts?.client ?? getDefaultClient();
  return client.stream(request);
}

// Re-export for backward compat — tests import AnthropicProvider from client.ts
export { AnthropicAdapter as AnthropicProvider } from './adapters/anthropic.js';
