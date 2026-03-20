import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ToolHookMetadata {
  run_id: string;
  node_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface PostHookMetadata extends ToolHookMetadata {
  is_error: boolean;
  content_preview: string;
  duration_ms: number;
  blocked_by_pre_hook: boolean;
}

export interface PreHookResult {
  allowed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PostHookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ResolvedHooks {
  pre?: string;
  post?: string;
}

const HOOK_TIMEOUT_MS = 15_000;

export class ToolHookRunner {
  private readonly hooks: ResolvedHooks;
  private readonly artifactDir?: string;

  constructor(hooks: ResolvedHooks, artifactDir?: string) {
    this.hooks = hooks;
    this.artifactDir = artifactDir;
  }

  hasPreHook(): boolean {
    return !!this.hooks.pre;
  }

  hasPostHook(): boolean {
    return !!this.hooks.post;
  }

  hasAnyHook(): boolean {
    return this.hasPreHook() || this.hasPostHook();
  }

  async runPreHook(metadata: ToolHookMetadata, toolCallDir?: string): Promise<PreHookResult> {
    if (!this.hooks.pre) {
      return { allowed: true, exitCode: 0, stdout: '', stderr: '' };
    }

    const env = buildHookEnv(metadata, 'pre');
    const stdin = JSON.stringify(metadata);

    const result = await executeHook(this.hooks.pre, stdin, env);

    // Persist artifacts
    if (toolCallDir) {
      await persistHookArtifact(toolCallDir, 'pre-hook', {
        hook_command: this.hooks.pre,
        phase: 'pre',
        exit_code: result.exitCode,
        allowed: result.exitCode === 0,
        tool_name: metadata.tool_name,
        tool_call_id: metadata.tool_call_id,
      }, result.stdout, result.stderr);
    }

    return {
      allowed: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async runPostHook(metadata: PostHookMetadata, toolCallDir?: string): Promise<PostHookResult> {
    if (!this.hooks.post) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const env = buildHookEnv(metadata, 'post');
    const stdin = JSON.stringify(metadata);

    const result = await executeHook(this.hooks.post, stdin, env);

    // Persist artifacts
    if (toolCallDir) {
      await persistHookArtifact(toolCallDir, 'post-hook', {
        hook_command: this.hooks.post,
        phase: 'post',
        exit_code: result.exitCode,
        tool_name: metadata.tool_name,
        tool_call_id: metadata.tool_call_id,
        blocked_by_pre_hook: metadata.blocked_by_pre_hook,
      }, result.stdout, result.stderr);
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

/**
 * Resolve effective hooks: node-level overrides graph-level.
 */
export function resolveHooks(
  nodeHooksPre: string | undefined,
  nodeHooksPost: string | undefined,
  graphHooksPre: string | undefined,
  graphHooksPost: string | undefined,
): ResolvedHooks {
  return {
    pre: nodeHooksPre ?? graphHooksPre,
    post: nodeHooksPost ?? graphHooksPost,
  };
}

function buildHookEnv(metadata: ToolHookMetadata | PostHookMetadata, phase: string): Record<string, string> {
  return {
    NECTAR_RUN_ID: metadata.run_id,
    NECTAR_NODE_ID: metadata.node_id,
    NECTAR_SESSION_ID: metadata.session_id,
    NECTAR_TOOL_CALL_ID: metadata.tool_call_id,
    NECTAR_TOOL_NAME: metadata.tool_name,
    NECTAR_HOOK_PHASE: phase,
  };
}

interface HookExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function executeHook(command: string, stdin: string, env: Record<string, string>): Promise<HookExecResult> {
  try {
    const { execaCommand } = await import('execa');
    const result = await execaCommand(command, {
      input: stdin,
      env: { ...process.env, ...env },
      timeout: HOOK_TIMEOUT_MS,
      shell: true,
      reject: false,
    });

    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    // Timeout or other execution error
    const msg = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 124, // convention for timeout
      stdout: '',
      stderr: `Hook execution failed: ${msg}`,
    };
  }
}

async function persistHookArtifact(
  toolCallDir: string,
  prefix: string,
  metadata: Record<string, unknown>,
  stdout: string,
  stderr: string,
): Promise<void> {
  try {
    await mkdir(toolCallDir, { recursive: true });
    await writeFile(path.join(toolCallDir, `${prefix}.json`), JSON.stringify(metadata, null, 2), 'utf8');
    if (stdout) {
      await writeFile(path.join(toolCallDir, `${prefix}.stdout.log`), stdout, 'utf8');
    }
    if (stderr) {
      await writeFile(path.join(toolCallDir, `${prefix}.stderr.log`), stderr, 'utf8');
    }
  } catch {
    // Best-effort artifact persistence
  }
}
