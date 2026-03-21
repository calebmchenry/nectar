import { InvalidRequestError } from './errors.js';

export interface ModelInfo {
  id: string;
  provider: string;
  display_name: string;
  knowledge_cutoff?: string;
  context_window: number;
  max_output_tokens: number;
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_structured_output: boolean;
  supports_vision: boolean;
  supports_reasoning: boolean;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
  cache_read_cost_per_million?: number;
  // Compatibility aliases for one sprint.
  capabilities: {
    streaming: boolean;
    tool_calling: boolean;
    structured_output: boolean;
    vision: boolean;
    thinking: boolean;
  };
  // Compatibility aliases for one sprint.
  cost?: {
    input_per_million: number;
    output_per_million: number;
    cache_read_per_million?: number;
  };
  aliases: string[];
  release_date: string;
  deprecated: boolean;
}

interface RawModelInfo {
  id: string;
  provider: string;
  display_name: string;
  knowledge_cutoff?: string;
  context_window: number;
  max_output_tokens: number;
  capabilities: {
    streaming: boolean;
    tool_calling: boolean;
    structured_output: boolean;
    vision: boolean;
    thinking: boolean;
  };
  cost?: {
    input_per_million: number;
    output_per_million: number;
    cache_read_per_million?: number;
  };
  aliases: string[];
  release_date: string;
  deprecated: boolean;
}

type CapabilitySelector =
  | keyof ModelInfo['capabilities']
  | 'supports_streaming'
  | 'supports_tools'
  | 'supports_structured_output'
  | 'supports_vision'
  | 'supports_reasoning';

// ── Static catalog ──────────────────────────────────────────────────────────

const CATALOG: RawModelInfo[] = [
  // ── Anthropic ─────────────────────────────────────────────────────────────
  {
    id: 'claude-opus-4-6-20260115',
    provider: 'anthropic',
    display_name: 'Claude Opus 4.6',
    knowledge_cutoff: '2025-01',
    context_window: 200_000,
    max_output_tokens: 32_768,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 15, output_per_million: 75, cache_read_per_million: 1.5 },
    aliases: ['claude-opus', 'claude-opus-4.6', 'opus-4.6', 'claude-opus-4-20250514', 'opus-4'],
    release_date: '2026-01-15',
    deprecated: false,
  },
  {
    id: 'claude-sonnet-4-6-20260115',
    provider: 'anthropic',
    display_name: 'Claude Sonnet 4.6',
    knowledge_cutoff: '2025-01',
    context_window: 200_000,
    max_output_tokens: 16_384,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3 },
    aliases: ['claude-sonnet', 'claude-sonnet-4.6', 'sonnet-4.6', 'claude-sonnet-4-20250514', 'sonnet-4'],
    release_date: '2026-01-15',
    deprecated: false,
  },
  {
    id: 'claude-sonnet-4-5-20250514',
    provider: 'anthropic',
    display_name: 'Claude Sonnet 4.5',
    knowledge_cutoff: '2025-01',
    context_window: 200_000,
    max_output_tokens: 16_384,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3 },
    aliases: ['claude-sonnet-4-5', 'sonnet-4.5'],
    release_date: '2025-05-14',
    deprecated: false,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    display_name: 'Claude Haiku 4.5',
    knowledge_cutoff: '2025-01',
    context_window: 200_000,
    max_output_tokens: 8_192,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: false },
    cost: { input_per_million: 0.8, output_per_million: 4, cache_read_per_million: 0.08 },
    aliases: ['claude-haiku', 'haiku-4.5'],
    release_date: '2025-10-01',
    deprecated: false,
  },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    id: 'gpt-5.2',
    provider: 'openai',
    display_name: 'GPT-5.2',
    knowledge_cutoff: '2025-10',
    context_window: 400_000,
    max_output_tokens: 128_000,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 10, output_per_million: 30 },
    aliases: ['gpt-5.2-latest', 'gpt5.2', 'gpt-5.2-reasoning'],
    release_date: '2026-01-20',
    deprecated: false,
  },
  {
    id: 'gpt-5.2-mini',
    provider: 'openai',
    display_name: 'GPT-5.2 Mini',
    knowledge_cutoff: '2025-10',
    context_window: 400_000,
    max_output_tokens: 128_000,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 2.2, output_per_million: 6.6 },
    aliases: ['gpt5.2-mini', 'gpt-5-mini'],
    release_date: '2026-01-20',
    deprecated: false,
  },
  {
    id: 'gpt-5.2-nano',
    provider: 'openai',
    display_name: 'GPT-5.2 Nano',
    knowledge_cutoff: '2025-10',
    context_window: 400_000,
    max_output_tokens: 64_000,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: false },
    cost: { input_per_million: 0.5, output_per_million: 1.5 },
    aliases: ['gpt5.2-nano', 'gpt-5-nano'],
    release_date: '2026-01-20',
    deprecated: false,
  },
  {
    id: 'o3',
    provider: 'openai',
    display_name: 'O3',
    knowledge_cutoff: '2024-06',
    context_window: 200_000,
    max_output_tokens: 100_000,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 10, output_per_million: 40 },
    aliases: ['openai-o3'],
    release_date: '2025-04-16',
    deprecated: false,
  },
  {
    id: 'o3-mini',
    provider: 'openai',
    display_name: 'O3 Mini',
    knowledge_cutoff: '2024-06',
    context_window: 200_000,
    max_output_tokens: 100_000,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: false, thinking: true },
    cost: { input_per_million: 1.1, output_per_million: 4.4 },
    aliases: ['openai-o3-mini'],
    release_date: '2025-01-31',
    deprecated: false,
  },
  {
    id: 'o4-mini',
    provider: 'openai',
    display_name: 'O4 Mini',
    knowledge_cutoff: '2024-06',
    context_window: 200_000,
    max_output_tokens: 100_000,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 1.1, output_per_million: 4.4 },
    aliases: ['openai-o4-mini'],
    release_date: '2025-04-16',
    deprecated: false,
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    display_name: 'GPT-4.1',
    knowledge_cutoff: '2024-06',
    context_window: 1_000_000,
    max_output_tokens: 32_768,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: false },
    cost: { input_per_million: 2, output_per_million: 8 },
    aliases: ['gpt4.1'],
    release_date: '2025-04-14',
    deprecated: false,
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    display_name: 'GPT-4.1 Mini',
    knowledge_cutoff: '2024-06',
    context_window: 1_000_000,
    max_output_tokens: 32_768,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: false },
    cost: { input_per_million: 0.4, output_per_million: 1.6 },
    aliases: ['gpt4.1-mini'],
    release_date: '2025-04-14',
    deprecated: false,
  },
  {
    id: 'gpt-4.1-nano',
    provider: 'openai',
    display_name: 'GPT-4.1 Nano',
    knowledge_cutoff: '2024-06',
    context_window: 1_000_000,
    max_output_tokens: 32_768,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: false },
    cost: { input_per_million: 0.1, output_per_million: 0.4 },
    aliases: ['gpt4.1-nano'],
    release_date: '2025-04-14',
    deprecated: false,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    display_name: 'GPT-4o (Legacy)',
    knowledge_cutoff: '2023-10',
    context_window: 128_000,
    max_output_tokens: 16_384,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: false },
    cost: { input_per_million: 2.5, output_per_million: 10 },
    aliases: ['gpt-4o-2024-11-20'],
    release_date: '2024-11-20',
    deprecated: false,
  },

  // ── Gemini ────────────────────────────────────────────────────────────────
  {
    id: 'gemini-3-pro',
    provider: 'gemini',
    display_name: 'Gemini 3 Pro',
    knowledge_cutoff: '2025-10',
    context_window: 2_000_000,
    max_output_tokens: 65_536,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 3, output_per_million: 12 },
    aliases: ['gemini-3.0-pro', 'gemini3-pro'],
    release_date: '2026-02-05',
    deprecated: false,
  },
  {
    id: 'gemini-3-flash',
    provider: 'gemini',
    display_name: 'Gemini 3 Flash',
    knowledge_cutoff: '2025-10',
    context_window: 2_000_000,
    max_output_tokens: 65_536,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 0.5, output_per_million: 2 },
    aliases: ['gemini-3.0-flash', 'gemini3-flash'],
    release_date: '2026-02-05',
    deprecated: false,
  },
  {
    id: 'gemini-3-flash-lite',
    provider: 'gemini',
    display_name: 'Gemini 3 Flash Lite',
    knowledge_cutoff: '2025-10',
    context_window: 1_000_000,
    max_output_tokens: 32_768,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: false },
    cost: { input_per_million: 0.2, output_per_million: 0.8 },
    aliases: ['gemini3-flash-lite', 'gemini-3-lite'],
    release_date: '2026-02-05',
    deprecated: false,
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    display_name: 'Gemini 2.5 Pro',
    knowledge_cutoff: '2025-01',
    context_window: 1_000_000,
    max_output_tokens: 65_536,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 1.25, output_per_million: 10 },
    aliases: ['gemini-pro', 'gemini-2.5-pro-preview-05-06'],
    release_date: '2025-03-25',
    deprecated: false,
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    display_name: 'Gemini 2.5 Flash',
    knowledge_cutoff: '2025-01',
    context_window: 1_000_000,
    max_output_tokens: 65_536,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 0.15, output_per_million: 0.6 },
    aliases: ['gemini-flash', 'gemini-2.5-flash-preview-04-17'],
    release_date: '2025-04-17',
    deprecated: false,
  },
  {
    id: 'ollama/llama3.2',
    provider: 'openai_compatible',
    display_name: 'Ollama Llama 3.2',
    context_window: 128_000,
    max_output_tokens: 8_192,
    capabilities: { streaming: true, tool_calling: true, structured_output: false, vision: false, thinking: false },
    aliases: ['ollama-llama3.2', 'llama3.2'],
    release_date: '2025-01-01',
    deprecated: false,
  },
  {
    id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo',
    provider: 'openai_compatible',
    display_name: 'Together Llama 3.3 70B Turbo',
    context_window: 131_072,
    max_output_tokens: 8_192,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: false, thinking: false },
    aliases: ['together-llama-3.3-70b', 'llama-3.3-70b-turbo'],
    release_date: '2025-02-01',
    deprecated: false,
  },
  {
    id: 'groq/llama-3.3-70b-versatile',
    provider: 'openai_compatible',
    display_name: 'Groq Llama 3.3 70B Versatile',
    context_window: 131_072,
    max_output_tokens: 8_192,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: false, thinking: false },
    aliases: ['groq-llama-3.3-70b', 'llama-3.3-70b-versatile'],
    release_date: '2025-02-01',
    deprecated: false,
  },
];

// ── Selector maps ─────────────────────────────────────────────────────────

const SELECTORS: Record<string, Record<string, string>> = {
  anthropic: {
    default: 'claude-sonnet-4-6-20260115',
    fast: 'claude-haiku-4-5-20251001',
    reasoning: 'claude-opus-4-6-20260115',
  },
  openai: {
    default: 'gpt-5.2',
    fast: 'gpt-5.2-mini',
    reasoning: 'gpt-5.2',
  },
  gemini: {
    default: 'gemini-3-flash',
    fast: 'gemini-3-flash',
    reasoning: 'gemini-3-pro',
  },
  openai_compatible: {
    default: 'groq/llama-3.3-70b-versatile',
    fast: 'ollama/llama3.2',
    reasoning: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
};

function toModelInfo(raw: RawModelInfo): ModelInfo {
  return {
    ...raw,
    supports_streaming: raw.capabilities.streaming,
    supports_tools: raw.capabilities.tool_calling,
    supports_structured_output: raw.capabilities.structured_output,
    supports_vision: raw.capabilities.vision,
    supports_reasoning: raw.capabilities.thinking,
    input_cost_per_million: raw.cost?.input_per_million,
    output_cost_per_million: raw.cost?.output_per_million,
    cache_read_cost_per_million: raw.cost?.cache_read_per_million,
    capabilities: { ...raw.capabilities },
    cost: raw.cost ? { ...raw.cost } : undefined,
    aliases: [...raw.aliases],
  };
}

function supportsCapability(model: ModelInfo, capability: CapabilitySelector): boolean {
  switch (capability) {
    case 'streaming':
      return model.capabilities.streaming;
    case 'tool_calling':
      return model.capabilities.tool_calling;
    case 'structured_output':
      return model.capabilities.structured_output;
    case 'vision':
      return model.capabilities.vision;
    case 'thinking':
      return model.capabilities.thinking;
    case 'supports_streaming':
      return model.supports_streaming;
    case 'supports_tools':
      return model.supports_tools;
    case 'supports_structured_output':
      return model.supports_structured_output;
    case 'supports_vision':
      return model.supports_vision;
    case 'supports_reasoning':
      return model.supports_reasoning;
    default:
      return false;
  }
}

// ── Lookup functions ────────────────────────────────────────────────────────

/**
 * Find a model by exact ID or alias. Provider narrows search when specified.
 */
export function getModelInfo(id: string, provider?: string): ModelInfo | undefined {
  const pool = provider ? CATALOG.filter(m => m.provider === provider) : CATALOG;

  // Exact ID match first
  const exact = pool.find(m => m.id === id);
  if (exact) return toModelInfo(exact);

  // Alias match
  const alias = pool.find(m => m.aliases.includes(id));
  return alias ? toModelInfo(alias) : undefined;
}

/**
 * List non-deprecated models, optionally filtered by provider.
 * Sorted by release_date descending.
 */
export function listModels(provider?: string): ModelInfo[] {
  let models = CATALOG.filter(m => !m.deprecated);
  if (provider) {
    models = models.filter(m => m.provider === provider);
  }
  return models
    .sort((a, b) => b.release_date.localeCompare(a.release_date))
    .map(toModelInfo);
}

/**
 * Get the most recent non-deprecated model for a provider,
 * optionally filtered by capability.
 */
export function getLatestModel(
  provider: string,
  capability?: CapabilitySelector
): ModelInfo | undefined {
  let models = CATALOG
    .filter(m => m.provider === provider && !m.deprecated)
    .map(toModelInfo);
  if (capability) {
    models = models.filter(m => supportsCapability(m, capability));
  }
  if (models.length === 0) return undefined;
  return models.sort((a, b) => b.release_date.localeCompare(a.release_date))[0];
}

/**
 * Resolve a logical selector ("default", "fast", "reasoning") to a concrete model ID.
 * Throws InvalidRequestError if the selector cannot resolve.
 */
export function resolveModelSelector(provider: string, selector: string): string {
  const providerSelectors = SELECTORS[provider];
  if (!providerSelectors) {
    throw new InvalidRequestError(
      provider,
      `No model selectors defined for provider '${provider}'`
    );
  }

  const modelId = providerSelectors[selector];
  if (!modelId) {
    throw new InvalidRequestError(
      provider,
      `Unknown model selector '${selector}' for provider '${provider}'. Available: ${Object.keys(providerSelectors).join(', ')}`
    );
  }

  return modelId;
}
