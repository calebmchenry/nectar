import { describe, expect, it } from 'vitest';
import {
  getModelInfo,
  listModels,
  getLatestModel,
  resolveModelSelector,
} from '../../src/llm/catalog.js';
import type { ModelInfo } from '../../src/llm/catalog.js';
import { InvalidRequestError } from '../../src/llm/errors.js';

describe('getModelInfo', () => {
  it('finds claude-sonnet-4-6-20260115 by exact ID', () => {
    const info = getModelInfo('claude-sonnet-4-6-20260115');
    expect(info).toBeDefined();
    expect(info!.id).toBe('claude-sonnet-4-6-20260115');
    expect(info!.provider).toBe('anthropic');
    expect(info!.display_name).toBe('Claude Sonnet 4.6');
  });

  it('finds by alias: sonnet-4', () => {
    const info = getModelInfo('sonnet-4');
    expect(info).toBeDefined();
    expect(info!.id).toBe('claude-sonnet-4-6-20260115');
  });

  it('returns undefined for nonexistent model', () => {
    expect(getModelInfo('nonexistent')).toBeUndefined();
  });

  it('narrows by provider', () => {
    const info = getModelInfo('claude-sonnet-4-6-20260115', 'anthropic');
    expect(info).toBeDefined();

    const wrong = getModelInfo('claude-sonnet-4-6-20260115', 'openai');
    expect(wrong).toBeUndefined();
  });

  it('finds gpt-5.2 by exact ID', () => {
    const info = getModelInfo('gpt-5.2');
    expect(info).toBeDefined();
    expect(info!.provider).toBe('openai');
  });

  it('finds gemini-3-flash by exact ID', () => {
    const info = getModelInfo('gemini-3-flash');
    expect(info).toBeDefined();
    expect(info!.provider).toBe('gemini');
  });
});

describe('listModels', () => {
  it('returns all non-deprecated models', () => {
    const models = listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every(m => !m.deprecated)).toBe(true);
  });

  it('filters by provider', () => {
    const anthropicModels = listModels('anthropic');
    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(anthropicModels.every(m => m.provider === 'anthropic')).toBe(true);
  });

  it('sorts by release_date descending', () => {
    const models = listModels();
    for (let i = 1; i < models.length; i++) {
      expect(models[i - 1]!.release_date >= models[i]!.release_date).toBe(true);
    }
  });

  it('returns empty array for unknown provider', () => {
    expect(listModels('nonexistent')).toEqual([]);
  });
});

describe('getLatestModel', () => {
  it('returns most recent anthropic model', () => {
    const latest = getLatestModel('anthropic');
    expect(latest).toBeDefined();
    expect(latest!.provider).toBe('anthropic');
  });

  it('returns most recent openai model with vision', () => {
    const latest = getLatestModel('openai', 'vision');
    expect(latest).toBeDefined();
    expect(latest!.provider).toBe('openai');
    expect(latest!.capabilities.vision).toBe(true);
  });

  it('returns undefined for nonexistent provider', () => {
    expect(getLatestModel('nonexistent')).toBeUndefined();
  });

  it('filters by thinking capability', () => {
    const latest = getLatestModel('anthropic', 'thinking');
    expect(latest).toBeDefined();
    expect(latest!.capabilities.thinking).toBe(true);
  });
});

describe('resolveModelSelector', () => {
  it('resolves default for anthropic', () => {
    const id = resolveModelSelector('anthropic', 'default');
    expect(id).toBe('claude-sonnet-4-6-20260115');
  });

  it('resolves fast for openai', () => {
    const id = resolveModelSelector('openai', 'fast');
    expect(id).toBe('gpt-5.2-mini');
  });

  it('resolves reasoning for gemini', () => {
    const id = resolveModelSelector('gemini', 'reasoning');
    expect(id).toBe('gemini-3-pro');
  });

  it('throws InvalidRequestError for bogus selector', () => {
    expect(() => resolveModelSelector('anthropic', 'bogus')).toThrow(InvalidRequestError);
  });

  it('throws InvalidRequestError for unknown provider', () => {
    expect(() => resolveModelSelector('nonexistent', 'default')).toThrow(InvalidRequestError);
  });
});

describe('catalog data integrity', () => {
  it('includes GPT-5.2, Claude 4.6, and Gemini 3.x families (U3)', () => {
    expect(getModelInfo('gpt-5.2')).toBeDefined();
    expect(getModelInfo('claude-sonnet-4-6-20260115')).toBeDefined();
    expect(getModelInfo('claude-opus-4-6-20260115')).toBeDefined();
    expect(getModelInfo('gemini-3-flash')).toBeDefined();
    expect(getModelInfo('gemini-3-pro')).toBeDefined();
  });

  it('every catalog entry has all required fields', () => {
    const models = listModels();
    for (const m of models) {
      expect(m.id).toBeTruthy();
      expect(m.provider).toBeTruthy();
      expect(m.display_name).toBeTruthy();
      expect(m.context_window).toBeGreaterThan(0);
      expect(m.max_output_tokens).toBeGreaterThan(0);
      expect(m.capabilities).toBeDefined();
      expect(typeof m.capabilities.streaming).toBe('boolean');
      expect(typeof m.capabilities.tool_calling).toBe('boolean');
      expect(typeof m.capabilities.structured_output).toBe('boolean');
      expect(typeof m.capabilities.vision).toBe('boolean');
      expect(typeof m.capabilities.thinking).toBe('boolean');
      expect(Array.isArray(m.aliases)).toBe(true);
      expect(m.release_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof m.deprecated).toBe('boolean');
    }
  });

  it('covers all three providers', () => {
    const providers = new Set(listModels().map(m => m.provider));
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('gemini')).toBe(true);
  });
});
