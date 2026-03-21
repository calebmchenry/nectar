// Unified LLM content model

export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'developer';

export enum ContentKind {
  TEXT = 'text',
  IMAGE = 'image',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  THINKING = 'thinking',
  REDACTED_THINKING = 'redacted_thinking',
}

export type ImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

export interface AudioData {
  url?: string;
  data?: string;
  media_type: string;
}

export interface DocumentData {
  url?: string;
  data?: string;
  media_type: string;
  file_name?: string;
}

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image';
  source: ImageSource;
}

export interface AudioContentPart {
  type: 'audio';
  source: AudioData;
}

export interface DocumentContentPart {
  type: 'document';
  source: DocumentData;
}

export interface ToolCallContentPart {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultContentPart {
  type: 'tool_result';
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

export interface ThinkingContentPart {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingContentPart {
  type: 'redacted_thinking';
}

export type ContentPart =
  | TextContentPart
  | ImageContentPart
  | AudioContentPart
  | DocumentContentPart
  | ToolCallContentPart
  | ToolResultContentPart
  | ThinkingContentPart
  | RedactedThinkingContentPart;

// Legacy stop reason values used in low-level stream_end events.
export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

export type FinishReasonValue = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'other';

export interface FinishReason {
  reason: FinishReasonValue;
  raw: string;
}

export interface Message {
  role: Role;
  content: string | ContentPart[];
  name?: string;
}

const MESSAGE_NAME_ALLOWED_RE = /[A-Za-z0-9_-]/g;

export function sanitizeMessageName(name?: string): string | undefined {
  if (typeof name !== 'string') {
    return undefined;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = (trimmed.match(MESSAGE_NAME_ALLOWED_RE) ?? []).join('');
  return sanitized.length > 0 ? sanitized.slice(0, 64) : undefined;
}

export namespace Message {
  export function system(content: string | ContentPart[]): Message {
    return { role: 'system', content };
  }

  export function user(content: string | ContentPart[]): Message {
    return { role: 'user', content };
  }

  export function assistant(content: string | ContentPart[]): Message {
    return { role: 'assistant', content };
  }

  export function tool_result(tool_call_id: string, content: string, is_error = false, name?: string): Message {
    const sanitizedName = sanitizeMessageName(name);
    const message: Message = {
      role: 'tool',
      content: [{ type: 'tool_result', tool_call_id, content, is_error }],
    };
    if (sanitizedName) {
      message.name = sanitizedName;
    }
    return message;
  }
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export function toUsage(usage: Omit<Usage, 'total_tokens'> & { total_tokens?: number }): Usage {
  return {
    ...usage,
    total_tokens: usage.total_tokens ?? (usage.input_tokens + usage.output_tokens),
  };
}

// Structured output types (L4)
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json' }
  | { type: 'json_schema'; json_schema: JsonSchemaDefinition };

export interface JsonSchemaDefinition {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

// Provider-specific options (L20)
export interface ProviderOptions {
  anthropic?: AnthropicOptions;
  openai?: OpenAIOptions;
  openai_compatible?: OpenAICompatibleOptions;
  gemini?: GeminiOptions;
}

export interface AnthropicOptions {
  betas?: string[];
  auto_cache?: boolean;
  /** @deprecated compatibility alias for one sprint; use auto_cache */
  cache_control?: boolean;
  metadata?: { user_id?: string };
}

export interface OpenAIOptions {
  store?: boolean;
  metadata?: Record<string, string>;
}

export interface OpenAICompatibleOptions {
  [key: string]: unknown;
}

export interface GeminiOptions {
  safety_settings?: Array<{ category: string; threshold: string }>;
  generation_config?: Record<string, unknown>;
}

export interface TimeoutConfig {
  /** Connection establishment timeout in milliseconds. */
  connect_ms?: number;
  /** Full request timeout in milliseconds. */
  request_ms?: number;
  /** Maximum interval between stream chunks in milliseconds. */
  stream_read_ms?: number;
}

export interface GenerateRequest {
  messages: Message[];
  prompt?: string;
  model?: string;
  provider?: string;
  tools?: import('./tools.js').ToolDefinition[];
  tool_choice?: import('./tools.js').ToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  reasoning_effort?: 'low' | 'medium' | 'high';
  system?: string;
  abort_signal?: AbortSignal;
  timeout?: number | TimeoutConfig;
  /** @deprecated Use timeout instead. */
  timeout_ms?: number;
  cache_control?: boolean;
  provider_options?: ProviderOptions;
  response_format?: ResponseFormat;
  stop_when?: StopCondition;
  max_tool_rounds?: number;
}

export interface GenerateOptions {
  client?: import('./client.js').UnifiedClient;
  tools?: Map<string, (args: unknown) => Promise<unknown>>;
  maxIterations?: number;
}

export interface RateLimitInfo {
  requests_remaining?: number;
  requests_limit?: number;
  tokens_remaining?: number;
  tokens_limit?: number;
  reset_at?: Date;
}

export interface Warning {
  code?: string;
  message: string;
}

export interface GenerateResponseInit {
  message: Message;
  usage: Omit<Usage, 'total_tokens'> & { total_tokens?: number };
  finish_reason?: FinishReason | FinishReasonValue | StopReason | string;
  stop_reason?: FinishReasonValue | StopReason | string;
  model: string;
  provider: string;
  id?: string;
  raw?: unknown;
  warnings?: Warning[];
  rate_limit?: RateLimitInfo;
}

function isFinishReasonValue(value: string): value is FinishReasonValue {
  return value === 'stop'
    || value === 'length'
    || value === 'tool_calls'
    || value === 'content_filter'
    || value === 'error'
    || value === 'other';
}

export function mapLegacyStopReason(reason: StopReason): FinishReasonValue {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    default:
      return 'other';
  }
}

export function normalizeFinishReason(value: FinishReason | FinishReasonValue | StopReason | string | undefined): FinishReason {
  if (value && typeof value === 'object' && 'reason' in value && 'raw' in value) {
    const rawValue = String(value.raw ?? 'other');
    const reasonValue = isFinishReasonValue(value.reason) ? value.reason : normalizeFinishReason(rawValue).reason;
    return { reason: reasonValue, raw: rawValue };
  }

  const raw = String(value ?? 'other');

  if (isFinishReasonValue(raw)) {
    return { reason: raw, raw };
  }

  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
    case 'completed':
    case 'STOP':
    case 'stop':
      return { reason: 'stop', raw };
    case 'max_tokens':
    case 'max_output_tokens':
    case 'MAX_TOKENS':
    case 'length':
      return { reason: 'length', raw };
    case 'tool_use':
    case 'tool_calls':
      return { reason: 'tool_calls', raw };
    case 'content_filter':
    case 'SAFETY':
      return { reason: 'content_filter', raw };
    case 'error':
      return { reason: 'error', raw };
    default:
      return { reason: 'other', raw };
  }
}

function syntheticResponseId(): string {
  return `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class GenerateResponse {
  readonly message: Message;
  readonly usage: Usage;
  readonly finish_reason: FinishReason;
  readonly model: string;
  readonly provider: string;
  readonly id: string;
  readonly raw?: unknown;
  readonly warnings: Warning[];
  readonly rate_limit?: RateLimitInfo;

  constructor(init: GenerateResponseInit) {
    this.message = init.message;
    this.usage = toUsage(init.usage);
    this.finish_reason = normalizeFinishReason(init.finish_reason ?? init.stop_reason);
    this.model = init.model;
    this.provider = init.provider;
    this.id = init.id ?? syntheticResponseId();
    this.raw = init.raw;
    this.warnings = [...(init.warnings ?? [])];
    this.rate_limit = init.rate_limit;
  }

  get text(): string {
    return getTextContent(this.message.content);
  }

  get tool_calls(): ToolCallContentPart[] {
    return normalizeContent(this.message.content)
      .filter((part): part is ToolCallContentPart => part.type === 'tool_call');
  }

  get reasoning(): Array<ThinkingContentPart | RedactedThinkingContentPart> {
    return normalizeContent(this.message.content)
      .filter((part): part is ThinkingContentPart | RedactedThinkingContentPart => (
        part.type === 'thinking' || part.type === 'redacted_thinking'
      ));
  }

  /** @deprecated Use finish_reason.reason. Planned removal in Sprint 030. */
  get stop_reason(): FinishReasonValue {
    return this.finish_reason.reason;
  }
}

export interface StepResult {
  step: number;
  output: GenerateResponse;
  usage: Usage;
  tool_calls: ToolCallContentPart[];
  tool_results?: ToolResultContentPart[];
}

export type StopCondition = (
  response: GenerateResponse,
  context: { step: number; steps: StepResult[] }
) => boolean | Promise<boolean>;

export interface GenerateResultInit {
  output: GenerateResponse;
  steps: StepResult[];
  total_usage: Usage;
}

export class GenerateResult {
  readonly output: GenerateResponse;
  readonly steps: StepResult[];
  readonly total_usage: Usage;

  constructor(init: GenerateResultInit) {
    this.output = init.output;
    this.steps = init.steps;
    this.total_usage = init.total_usage;
  }

  // Backward-compat accessors for call sites that expected GenerateResponse from generate().
  get message(): Message {
    return this.output.message;
  }

  get usage(): Usage {
    return this.output.usage;
  }

  get finish_reason(): FinishReason {
    return this.output.finish_reason;
  }

  /** @deprecated Use output.finish_reason.reason. */
  get stop_reason(): FinishReasonValue {
    return this.output.stop_reason;
  }

  get model(): string {
    return this.output.model;
  }

  get provider(): string {
    return this.output.provider;
  }

  get id(): string {
    return this.output.id;
  }

  get raw(): unknown {
    return this.output.raw;
  }

  get warnings(): Warning[] {
    return this.output.warnings;
  }

  get rate_limit(): RateLimitInfo | undefined {
    return this.output.rate_limit;
  }

  get text(): string {
    return this.output.text;
  }

  get tool_calls(): ToolCallContentPart[] {
    return this.output.tool_calls;
  }

  get reasoning(): Array<ThinkingContentPart | RedactedThinkingContentPart> {
    return this.output.reasoning;
  }
}

export function normalizeContent(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

export function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

// Legacy compat — these types are used by old call sites.
export interface LLMRequest {
  model: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  max_tokens?: number;
  system?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
}

export interface LLMClient {
  generate(request: LLMRequest): Promise<LLMResponse>;
}
