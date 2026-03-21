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
    expect(profile.defaultModel).toBe('claude-sonnet-4-6-20260115');
  });

  it('OpenAIProfile generates system prompt', () => {
    const profile = new OpenAIProfile();
    const prompt = profile.systemPrompt(baseContext);
    expect(prompt).toContain('function call');
    expect(profile.defaultModel).toBe('gpt-5.2');
  });

  it('GeminiProfile generates system prompt', () => {
    const profile = new GeminiProfile();
    const prompt = profile.systemPrompt(baseContext);
    expect(prompt).toContain('function calling');
    expect(profile.defaultModel).toBe('gemini-3-flash');
  });

  it('provider profiles use catalog defaults', () => {
    const anthropic = new AnthropicProfile();
    const openai = new OpenAIProfile();
    const gemini = new GeminiProfile();

    expect(anthropic.defaultModel).toBe('claude-sonnet-4-6-20260115');
    expect(openai.defaultModel).toBe('gpt-5.2');
    expect(gemini.defaultModel).toBe('gemini-3-flash');
  });

  it('exposes profile capability fields (C4, C5)', () => {
    const profile = new OpenAIProfile();
    expect(profile.context_window_size).toBeGreaterThan(0);
    expect(typeof profile.supports_reasoning).toBe('boolean');
    expect(typeof profile.supports_streaming).toBe('boolean');
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
