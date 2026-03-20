// Unified LLM content model — Sprint 005

export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'developer';

export type ImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; tool_call_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking' };

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

export interface Message {
  role: Role;
  content: string | ContentPart[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
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
  gemini?: GeminiOptions;
}

export interface AnthropicOptions {
  betas?: string[];
  cache_control?: boolean;
  metadata?: { user_id?: string };
}

export interface OpenAIOptions {
  store?: boolean;
  metadata?: Record<string, string>;
}

export interface GeminiOptions {
  safety_settings?: Array<{ category: string; threshold: string }>;
  generation_config?: Record<string, unknown>;
}

export interface GenerateRequest {
  messages: Message[];
  model?: string;
  provider?: string;
  tools?: import('./tools.js').ToolDefinition[];
  tool_choice?: import('./tools.js').ToolChoice;
  max_tokens?: number;
  temperature?: number;
  stop_sequences?: string[];
  reasoning_effort?: 'low' | 'medium' | 'high';
  system?: string;
  abort_signal?: AbortSignal;
  timeout_ms?: number;
  cache_control?: boolean;
  provider_options?: ProviderOptions;
  response_format?: ResponseFormat;
}

export interface RateLimitInfo {
  requests_remaining?: number;
  requests_limit?: number;
  tokens_remaining?: number;
  tokens_limit?: number;
  reset_at?: Date;
}

export interface GenerateResponse {
  message: Message;
  usage: Usage;
  stop_reason: StopReason;
  model: string;
  provider: string;
  rate_limit?: RateLimitInfo;
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

// Legacy compat — these types are used by the old code and kept as aliases
// so existing imports don't break during the transition.
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
