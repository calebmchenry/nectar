import { buildEnvironmentContext, buildGitSnapshot } from './environment-context.js';
import { getModelInfo, resolveModelSelector } from '../llm/catalog.js';
import type { ExecutionEnvironment } from './execution-environment.js';

export interface ProfileContext {
  workspace_root: string;
  project_instructions: string;
  tool_names: string[];
  node_prompt: string;
}

export interface ProviderProfile {
  name: string;
  systemPrompt(context: ProfileContext): string;
  providerOptions(): Record<string, unknown>;
  defaultModel?: string;
  context_window_size: number;
  supports_reasoning: boolean;
  supports_streaming: boolean;
  parallel_tool_execution: boolean;
  max_parallel_tools: number;
  /** Tools this profile exposes to the model */
  visibleTools?: string[];
  /** Override for command timeout (ms). If unset, uses DEFAULT_SESSION_CONFIG. */
  command_timeout_ms?: number;
}

function baseSystemPrompt(context: ProfileContext, providerNote: string): string {
  const toolList = context.tool_names.length > 0
    ? `Available tools: ${context.tool_names.join(', ')}`
    : 'No tools are available.';

  const instructionBlock = context.project_instructions
    ? `\n\n## Project Instructions\n\n${context.project_instructions}`
    : '';

  return `You are a coding agent working in a local repository at: ${context.workspace_root}

Your task is to complete the requested work by reading files, making edits, and running commands.

## Guidelines

- Read files before editing them. Use read_file to understand the current state.
- Use edit_file for precise changes with exact string matching. The old_string must match exactly.
- Use write_file for creating new files or complete rewrites.
- Use shell to run tests, build commands, and other terminal operations.
- Use grep and glob to search and find files in the workspace.
- Tool errors are not fatal — read the error message and try a different approach.
- When you have completed the task, respond with a summary of what you did.

${providerNote}

${toolList}${instructionBlock}`;
}

export class AnthropicProfile implements ProviderProfile {
  readonly name = 'anthropic';
  readonly defaultModel = resolveModelSelector('anthropic', 'default');
  readonly context_window_size = readContextWindow(this.defaultModel, 'anthropic');
  readonly supports_reasoning = readSupportsReasoning(this.defaultModel, 'anthropic');
  readonly supports_streaming = readSupportsStreaming(this.defaultModel, 'anthropic');
  readonly parallel_tool_execution = true;
  readonly max_parallel_tools = 8;
  readonly visibleTools = ['read_file', 'write_file', 'edit_file', 'shell', 'grep', 'glob'];
  readonly command_timeout_ms = 120_000; // Anthropic keeps 120s

  systemPrompt(context: ProfileContext): string {
    return baseSystemPrompt(context,
      'When using edit_file, provide enough context in old_string to ensure a unique match. Include surrounding lines if the target text is not unique.');
  }

  providerOptions(): Record<string, unknown> {
    return {
      anthropic: {
        betas: ['prompt-caching-2024-07-31'],
      },
    };
  }
}

export class OpenAIProfile implements ProviderProfile {
  readonly name = 'openai';
  readonly defaultModel = resolveModelSelector('openai', 'default');
  readonly context_window_size = readContextWindow(this.defaultModel, 'openai');
  readonly supports_reasoning = readSupportsReasoning(this.defaultModel, 'openai');
  readonly supports_streaming = readSupportsStreaming(this.defaultModel, 'openai');
  readonly parallel_tool_execution = true;
  readonly max_parallel_tools = 8;
  readonly visibleTools = ['read_file', 'write_file', 'apply_patch', 'shell', 'grep', 'glob'];

  systemPrompt(context: ProfileContext): string {
    return baseSystemPrompt(context,
      'Use apply_patch to make targeted edits to existing files. Use the v4a patch format wrapped in "*** Begin Patch" / "*** End Patch". Use function calls to interact with the codebase. Each function call should have well-formed JSON arguments.');
  }

  providerOptions(): Record<string, unknown> {
    return {};
  }
}

export class GeminiProfile implements ProviderProfile {
  readonly name = 'gemini';
  readonly defaultModel = resolveModelSelector('gemini', 'default');
  readonly context_window_size = readContextWindow(this.defaultModel, 'gemini');
  readonly supports_reasoning = readSupportsReasoning(this.defaultModel, 'gemini');
  readonly supports_streaming = readSupportsStreaming(this.defaultModel, 'gemini');
  readonly parallel_tool_execution = false;
  readonly max_parallel_tools = 8;
  readonly visibleTools = [
    'read_file',
    'read_many_files',
    'list_dir',
    'write_file',
    'edit_file',
    'shell',
    'grep',
    'glob',
  ];

  systemPrompt(context: ProfileContext): string {
    return baseSystemPrompt(context,
      'Use function calling to interact with the codebase. Provide all required parameters for each function call.');
  }

  providerOptions(): Record<string, unknown> {
    return {
      gemini: {
        safety_settings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      },
    };
  }
}

const profiles: Record<string, ProviderProfile> = {
  anthropic: new AnthropicProfile(),
  openai: new OpenAIProfile(),
  gemini: new GeminiProfile(),
};

export function selectProfile(providerName?: string): ProviderProfile {
  if (providerName && profiles[providerName]) {
    return profiles[providerName]!;
  }
  // Default to Anthropic profile
  return profiles.anthropic!;
}

/**
 * Build a full system prompt with environment context and git snapshot.
 */
export async function buildFullSystemPrompt(
  profile: ProviderProfile,
  context: ProfileContext,
  opts?: { provider?: string; model?: string; env?: ExecutionEnvironment }
): Promise<string> {
  const base = profile.systemPrompt(context);

  const envBlock = await buildEnvironmentContext({
    env: opts?.env,
    workspaceRoot: context.workspace_root,
    provider: opts?.provider ?? profile.name,
    model: opts?.model ?? profile.defaultModel,
    visibleToolNames: context.tool_names,
  });

  let gitBlock: string | null = null;
  try {
    gitBlock = await buildGitSnapshot(context.workspace_root);
  } catch {
    // Silently omit
  }

  const parts = [base, envBlock];
  if (gitBlock) parts.push(gitBlock);

  return parts.join('\n\n');
}

function readContextWindow(modelId: string | undefined, provider: string): number {
  if (!modelId) {
    return 0;
  }
  return getModelInfo(modelId, provider)?.context_window ?? 0;
}

function readSupportsReasoning(modelId: string | undefined, provider: string): boolean {
  if (!modelId) {
    return false;
  }
  return getModelInfo(modelId, provider)?.supports_reasoning ?? false;
}

function readSupportsStreaming(modelId: string | undefined, provider: string): boolean {
  if (!modelId) {
    return true;
  }
  return getModelInfo(modelId, provider)?.supports_streaming ?? true;
}
