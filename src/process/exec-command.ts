import { execaCommand } from 'execa';

export interface ExecCommandInput {
  command: string;
  cwd: string;
  timeout_ms: number;
  env?: Record<string, string>;
  abort_signal?: AbortSignal;
  shell?: boolean;
}

export interface ExecCommandResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  aborted: boolean;
  duration_ms: number;
}

export async function execCommand(input: ExecCommandInput): Promise<ExecCommandResult> {
  if (input.abort_signal?.aborted) {
    return {
      exit_code: 130,
      stdout: '',
      stderr: 'Command cancelled',
      timed_out: false,
      aborted: true,
      duration_ms: 0,
    };
  }

  const supportsProcessGroups = process.platform === 'darwin' || process.platform === 'linux';
  const timeoutMs = Math.max(1, input.timeout_ms);
  const startedAt = Date.now();
  const subprocess = execaCommand(input.command, {
    cwd: input.cwd,
    env: input.env ?? {},
    extendEnv: false,
    shell: input.shell ?? true,
    reject: false,
    detached: supportsProcessGroups,
    timeout: undefined,
    cancelSignal: undefined,
    windowsHide: true,
  });

  let timedOut = false;
  let aborted = false;
  let completed = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;

  const terminateTree = (reason: 'timeout' | 'abort') => {
    if (completed) {
      return;
    }
    if (reason === 'timeout') {
      timedOut = true;
    } else {
      aborted = true;
    }

    const pid = typeof subprocess.pid === 'number' ? subprocess.pid : undefined;
    if (supportsProcessGroups && pid && pid > 0) {
      safeKillProcessGroup(pid, 'SIGTERM');
      hardKillTimer = setTimeout(() => {
        safeKillProcessGroup(pid, 'SIGKILL');
      }, 2000);
      hardKillTimer.unref?.();
      return;
    }

    safeKillProcess(subprocess, 'SIGTERM');
    hardKillTimer = setTimeout(() => {
      safeKillProcess(subprocess, 'SIGKILL');
    }, 2000);
    hardKillTimer.unref?.();
  };

  const timeoutTimer = setTimeout(() => {
    terminateTree('timeout');
  }, timeoutMs);
  timeoutTimer.unref?.();

  const onAbort = () => {
    terminateTree('abort');
  };
  input.abort_signal?.addEventListener('abort', onAbort, { once: true });

  let settled: unknown;
  try {
    settled = await subprocess;
  } catch (error) {
    settled = error;
  } finally {
    completed = true;
    clearTimeout(timeoutTimer);
    if (hardKillTimer) {
      clearTimeout(hardKillTimer);
    }
    input.abort_signal?.removeEventListener('abort', onAbort);
  }

  const stdout = String((settled as { stdout?: unknown })?.stdout ?? '');
  let stderr = String((settled as { stderr?: unknown })?.stderr ?? '');
  if (aborted && !timedOut && stderr.trim().length === 0) {
    stderr = 'Command cancelled';
  }

  return {
    exit_code: timedOut ? 124 : aborted ? 130 : resolveExitCode(settled),
    stdout,
    stderr,
    timed_out: timedOut,
    aborted,
    duration_ms: Math.max(0, Date.now() - startedAt),
  };
}

function resolveExitCode(result: unknown): number | null {
  if (
    result
    && typeof result === 'object'
    && 'exitCode' in result
    && typeof (result as { exitCode?: unknown }).exitCode === 'number'
  ) {
    return (result as { exitCode: number }).exitCode;
  }
  return null;
}

function safeKillProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // best-effort group kill
  }
}

function safeKillProcess(subprocess: { kill: (signal?: NodeJS.Signals | number) => boolean }, signal: NodeJS.Signals): void {
  try {
    subprocess.kill(signal);
  } catch {
    // best-effort process kill
  }
}
