import { InvalidRequestError } from './errors.js';

export interface ModelInfo {
  id: string;
  provider: string;
  display_name: string;
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

// ── Static catalog ──────────────────────────────────────────────────────────

const CATALOG: ModelInfo[] = [
  // ── Anthropic ─────────────────────────────────────────────────────────────
  {
    id: 'claude-opus-4-20250514',
    provider: 'anthropic',
    display_name: 'Claude Opus 4',
    context_window: 200_000,
    max_output_tokens: 32_768,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 15, output_per_million: 75, cache_read_per_million: 1.5 },
    aliases: ['claude-opus', 'opus-4'],
    release_date: '2025-05-14',
    deprecated: false,
  },
  {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    display_name: 'Claude Sonnet 4',
    context_window: 200_000,
    max_output_tokens: 16_384,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3 },
    aliases: ['claude-sonnet', 'sonnet-4'],
    release_date: '2025-05-14',
    deprecated: false,
  },
  {
    id: 'claude-sonnet-4-5-20250514',
    provider: 'anthropic',
    display_name: 'Claude Sonnet 4.5',
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
    id: 'o3',
    provider: 'openai',
    display_name: 'O3',
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
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    display_name: 'Gemini 2.5 Pro',
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
    context_window: 1_000_000,
    max_output_tokens: 65_536,
    capabilities: { streaming: true, tool_calling: true, structured_output: true, vision: true, thinking: true },
    cost: { input_per_million: 0.15, output_per_million: 0.6 },
    aliases: ['gemini-flash', 'gemini-2.5-flash-preview-04-17'],
    release_date: '2025-04-17',
    deprecated: false,
  },
];

// ── Selector maps ─────────────────────────────────────────────────────────

const SELECTORS: Record<string, Record<string, string>> = {
  anthropic: {
    default: 'claude-sonnet-4-20250514',
    fast: 'claude-haiku-4-5-20251001',
    reasoning: 'claude-opus-4-20250514',
  },
  openai: {
    default: 'gpt-4.1',
    fast: 'gpt-4.1-mini',
    reasoning: 'o3',
  },
  gemini: {
    default: 'gemini-2.5-flash',
    fast: 'gemini-2.5-flash',
    reasoning: 'gemini-2.5-pro',
  },
};

// ── Lookup functions ────────────────────────────────────────────────────────

/**
 * Find a model by exact ID or alias. Provider narrows search when specified.
 */
export function getModelInfo(id: string, provider?: string): ModelInfo | undefined {
  const pool = provider ? CATALOG.filter(m => m.provider === provider) : CATALOG;

  // Exact ID match first
  const exact = pool.find(m => m.id === id);
  if (exact) return exact;

  // Alias match
  return pool.find(m => m.aliases.includes(id));
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
  return models.sort((a, b) => b.release_date.localeCompare(a.release_date));
}

/**
 * Get the most recent non-deprecated model for a provider,
 * optionally filtered by capability.
 */
export function getLatestModel(
  provider: string,
  capability?: keyof ModelInfo['capabilities']
): ModelInfo | undefined {
  let models = CATALOG.filter(m => m.provider === provider && !m.deprecated);
  if (capability) {
    models = models.filter(m => m.capabilities[capability]);
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
