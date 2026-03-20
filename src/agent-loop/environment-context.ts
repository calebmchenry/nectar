import { execaCommand } from 'execa';
import os from 'node:os';

const GIT_TIMEOUT_MS = 2000;

export interface EnvironmentContextOptions {
  workspaceRoot: string;
  provider?: string;
  model?: string;
  visibleToolNames?: string[];
}

/**
 * Build the environment context block for the system prompt.
 */
export function buildEnvironmentContext(opts: EnvironmentContextOptions): string {
  const lines = [
    '## Environment',
    '',
    `- Platform: ${os.platform()} ${os.arch()}`,
    `- Shell: ${process.env['SHELL'] ?? 'unknown'}`,
    `- Workspace: ${opts.workspaceRoot}`,
    `- Date: ${new Date().toISOString()}`,
  ];

  if (opts.provider) {
    lines.push(`- Provider: ${opts.provider}`);
  }
  if (opts.model) {
    lines.push(`- Model: ${opts.model}`);
  }
  if (opts.visibleToolNames && opts.visibleToolNames.length > 0) {
    lines.push(`- Tools: ${opts.visibleToolNames.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Build a git snapshot block for the system prompt.
 * Returns null if not a git repo or git is unavailable.
 * Each git command has an independent 2s timeout.
 */
export async function buildGitSnapshot(workspaceRoot: string): Promise<string | null> {
  try {
    // Check if it's a git repo
    const { exitCode } = await execaCommand('git rev-parse --is-inside-work-tree', {
      cwd: workspaceRoot,
      timeout: GIT_TIMEOUT_MS,
      reject: false,
      shell: true,
    });
    if (exitCode !== 0) return null;

    const lines = ['## Git Status', ''];

    // Current branch
    try {
      const branch = await execaCommand('git rev-parse --abbrev-ref HEAD', {
        cwd: workspaceRoot,
        timeout: GIT_TIMEOUT_MS,
        reject: false,
        shell: true,
      });
      const branchName = branch.stdout?.trim() || 'detached HEAD';
      lines.push(`- Branch: ${branchName}`);
    } catch {
      lines.push('- Branch: unknown');
    }

    // File counts
    try {
      const status = await execaCommand('git status --porcelain', {
        cwd: workspaceRoot,
        timeout: GIT_TIMEOUT_MS,
        reject: false,
        shell: true,
      });
      const statusLines = (status.stdout ?? '').trim().split('\n').filter(Boolean);
      let staged = 0;
      let unstaged = 0;
      let untracked = 0;
      for (const line of statusLines) {
        const x = line[0];
        const y = line[1];
        if (x === '?') {
          untracked++;
        } else {
          if (x && x !== ' ') staged++;
          if (y && y !== ' ') unstaged++;
        }
      }
      lines.push(`- Staged: ${staged}, Unstaged: ${unstaged}, Untracked: ${untracked}`);
    } catch {
      // skip
    }

    // Recent commits
    try {
      const log = await execaCommand('git log --oneline -3', {
        cwd: workspaceRoot,
        timeout: GIT_TIMEOUT_MS,
        reject: false,
        shell: true,
      });
      const commits = (log.stdout ?? '').trim();
      if (commits) {
        lines.push('- Recent commits:');
        for (const c of commits.split('\n').slice(0, 3)) {
          lines.push(`  ${c.trim()}`);
        }
      }
    } catch {
      // skip
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}
