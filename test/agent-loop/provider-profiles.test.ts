import { describe, expect, it } from 'vitest';
import {
  AnthropicProfile,
  OpenAIProfile,
  GeminiProfile,
  selectProfile,
} from '../../src/agent-loop/provider-profiles.js';

const baseContext = {
  workspace_root: '/tmp/test',
  project_instructions: '',
  tool_names: ['read_file', 'write_file', 'shell'],
  node_prompt: 'Fix the bug',
};

describe('ProviderProfiles', () => {
  it('AnthropicProfile generates system prompt with tools', () => {
    const profile = new AnthropicProfile();
    const prompt = profile.systemPrompt(baseContext);
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('/tmp/test');
    // Uses catalog-resolved default instead of hardcoded ID
    expect(profile.defaultModel).toBe('claude-sonnet-4-20250514');
  });

  it('OpenAIProfile generates system prompt', () => {
    const profile = new OpenAIProfile();
    const prompt = profile.systemPrompt(baseContext);
    expect(prompt).toContain('function call');
    // Uses catalog-resolved default (gpt-4.1) instead of stale gpt-4o
    expect(profile.defaultModel).toBe('gpt-4.1');
  });

  it('GeminiProfile generates system prompt', () => {
    const profile = new GeminiProfile();
    const prompt = profile.systemPrompt(baseContext);
    expect(prompt).toContain('function calling');
    // Uses catalog-resolved default
    expect(profile.defaultModel).toBe('gemini-2.5-flash');
  });

  it('provider profiles use logical selectors, not stale concrete IDs', () => {
    // Verify none of the profiles contain the old stale IDs directly
    // by checking they match the catalog's resolved defaults
    const anthropic = new AnthropicProfile();
    const openai = new OpenAIProfile();
    const gemini = new GeminiProfile();

    // OpenAI was the stale one: it used 'gpt-4o', now should be 'gpt-4.1'
    expect(openai.defaultModel).not.toBe('gpt-4o');
    expect(openai.defaultModel).toBe('gpt-4.1');

    // These should match catalog defaults
    expect(anthropic.defaultModel).toBeTruthy();
    expect(gemini.defaultModel).toBeTruthy();
  });

  it('includes project instructions in system prompt', () => {
    const profile = new AnthropicProfile();
    const prompt = profile.systemPrompt({
      ...baseContext,
      project_instructions: 'Always use TypeScript strict mode.',
    });
    expect(prompt).toContain('Always use TypeScript strict mode');
    expect(prompt).toContain('Project Instructions');
  });

  it('selectProfile returns correct profile by name', () => {
    expect(selectProfile('anthropic').name).toBe('anthropic');
    expect(selectProfile('openai').name).toBe('openai');
    expect(selectProfile('gemini').name).toBe('gemini');
  });

  it('selectProfile defaults to anthropic', () => {
    expect(selectProfile().name).toBe('anthropic');
    expect(selectProfile('unknown_provider').name).toBe('anthropic');
  });
});
