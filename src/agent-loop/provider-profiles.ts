import { buildEnvironmentContext, buildGitSnapshot } from './environment-context.js';
import { resolveModelSelector } from '../llm/catalog.js';

export interface ProfileContext {
  workspace_root: string;
  project_instructions: string;
  tool_names: string[];
  node_prompt: string;
}

export interface ProviderProfile {
  name: string;
  systemPrompt(context: ProfileContext): string;
  defaultModel?: string;
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
  readonly parallel_tool_execution = true;
  readonly max_parallel_tools = 8;
  readonly visibleTools = ['read_file', 'write_file', 'edit_file', 'shell', 'grep', 'glob'];
  readonly command_timeout_ms = 120_000; // Anthropic keeps 120s

  systemPrompt(context: ProfileContext): string {
    return baseSystemPrompt(context,
      'When using edit_file, provide enough context in old_string to ensure a unique match. Include surrounding lines if the target text is not unique.');
  }
}

export class OpenAIProfile implements ProviderProfile {
  readonly name = 'openai';
  readonly defaultModel = resolveModelSelector('openai', 'default');
  readonly parallel_tool_execution = true;
  readonly max_parallel_tools = 8;
  readonly visibleTools = ['read_file', 'write_file', 'apply_patch', 'shell', 'grep', 'glob'];

  systemPrompt(context: ProfileContext): string {
    return baseSystemPrompt(context,
      'Use apply_patch to make targeted edits to existing files. Use the v4a patch format wrapped in "*** Begin Patch" / "*** End Patch". Use function calls to interact with the codebase. Each function call should have well-formed JSON arguments.');
  }
}

export class GeminiProfile implements ProviderProfile {
  readonly name = 'gemini';
  readonly defaultModel = resolveModelSelector('gemini', 'default');
  readonly parallel_tool_execution = false;
  readonly max_parallel_tools = 8;
  readonly visibleTools = ['read_file', 'write_file', 'edit_file', 'shell', 'grep', 'glob'];

  systemPrompt(context: ProfileContext): string {
    return baseSystemPrompt(context,
      'Use function calling to interact with the codebase. Provide all required parameters for each function call.');
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
  opts?: { provider?: string; model?: string }
): Promise<string> {
  const base = profile.systemPrompt(context);

  const envBlock = buildEnvironmentContext({
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
