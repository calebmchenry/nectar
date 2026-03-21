import { execaCommand } from 'execa';
import os from 'node:os';
import { getModelInfo } from '../llm/catalog.js';
import type { ExecutionEnvironment } from './execution-environment.js';

const GIT_TIMEOUT_MS = 2000;

export interface EnvironmentContextOptions {
  workspaceRoot?: string;
  env?: ExecutionEnvironment;
  provider?: string;
  model?: string;
  visibleToolNames?: string[];
  today?: Date;
}

interface GitState {
  is_repo: boolean;
  branch: string;
}

export async function buildEnvironmentContext(opts: EnvironmentContextOptions): Promise<string> {
  const workingDirectory = opts.env?.cwd ?? opts.workspaceRoot ?? process.cwd();
  const gitState = await resolveGitState(workingDirectory, opts.env);

  const hasPlatform = typeof (opts.env as Partial<ExecutionEnvironment> | undefined)?.platform === 'function';
  const hasOsVersion = typeof (opts.env as Partial<ExecutionEnvironment> | undefined)?.os_version === 'function';

  const platformValue = hasPlatform
    ? await (opts.env as ExecutionEnvironment).platform()
    : `${os.platform()} ${os.arch()}`;
  const osVersionValue = hasOsVersion
    ? await (opts.env as ExecutionEnvironment).os_version()
    : os.release();

  const today = (opts.today ?? new Date()).toISOString().slice(0, 10);
  const modelLabel = opts.model ?? 'unknown';
  const modelInfo = opts.model ? getModelInfo(opts.model, opts.provider) : undefined;
  const knowledgeCutoff = modelInfo?.knowledge_cutoff ?? 'unknown';

  const lines = [
    '## Environment',
    '',
    `- Working directory: ${workingDirectory}`,
    `- Is git repository: ${gitState.is_repo ? 'yes' : 'no'}`,
    `- Git branch: ${gitState.branch}`,
    `- Platform: ${platformValue || 'unknown'}`,
    `- OS version: ${osVersionValue || 'unknown'}`,
    `- Today's date: ${today}`,
    `- Model: ${modelLabel}`,
    `- Knowledge cutoff: ${knowledgeCutoff}`,
  ];

  if (opts.visibleToolNames && opts.visibleToolNames.length > 0) {
    lines.push(`- Tools: ${opts.visibleToolNames.join(', ')}`);
  }

  return lines.join('\n');
}

async function resolveGitState(workspaceRoot: string, env?: ExecutionEnvironment): Promise<GitState> {
  const insideRepo = await runGitCommand(workspaceRoot, 'git rev-parse --is-inside-work-tree', env);
  if (insideRepo.exitCode !== 0) {
    return { is_repo: false, branch: 'unknown' };
  }

  const isRepo = insideRepo.stdout.trim() === 'true';
  if (!isRepo) {
    return { is_repo: false, branch: 'unknown' };
  }

  const branchResult = await runGitCommand(workspaceRoot, 'git rev-parse --abbrev-ref HEAD', env);
  const branch = branchResult.exitCode === 0
    ? (branchResult.stdout.trim() || 'detached')
    : 'unknown';

  return {
    is_repo: true,
    branch,
  };
}

async function runGitCommand(
  workspaceRoot: string,
  command: string,
  env?: ExecutionEnvironment,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (env) {
    const result = await env.exec(command, { timeout_ms: GIT_TIMEOUT_MS });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  try {
    const result = await execaCommand(command, {
      cwd: workspaceRoot,
      timeout: GIT_TIMEOUT_MS,
      reject: false,
      shell: true,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildGitSnapshot(workspaceRoot: string): Promise<string | null> {
  try {
    const inside = await execaCommand('git rev-parse --is-inside-work-tree', {
      cwd: workspaceRoot,
      timeout: GIT_TIMEOUT_MS,
      reject: false,
      shell: true,
    });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      return null;
    }

    const lines = ['## Git Status', ''];

    const branch = await execaCommand('git rev-parse --abbrev-ref HEAD', {
      cwd: workspaceRoot,
      timeout: GIT_TIMEOUT_MS,
      reject: false,
      shell: true,
    });
    lines.push(`- Branch: ${branch.stdout?.trim() || 'unknown'}`);

    const status = await execaCommand('git status --porcelain', {
      cwd: workspaceRoot,
      timeout: GIT_TIMEOUT_MS,
      reject: false,
      shell: true,
    });
    const statusLines = (status.stdout ?? '').trim().split('\n').filter(Boolean);
    lines.push(`- Changed files: ${statusLines.length}`);

    const commits = await execaCommand('git log --oneline -5', {
      cwd: workspaceRoot,
      timeout: GIT_TIMEOUT_MS,
      reject: false,
      shell: true,
    });
    if (commits.exitCode === 0) {
      const recentCommits = (commits.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => (line.length > 120 ? `${line.slice(0, 117)}...` : line));
      if (recentCommits.length > 0) {
        lines.push('- Recent commits:');
        for (const commit of recentCommits) {
          lines.push(`  - ${commit}`);
        }
      }
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}
