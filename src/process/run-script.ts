import { execaCommand } from 'execa';

export interface RunScriptInput {
  script: string;
  timeout_ms: number;
  env: Record<string, string>;
  abort_signal?: AbortSignal;
}

export interface RunScriptResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export async function runScript(input: RunScriptInput): Promise<RunScriptResult> {
  try {
    const result = await execaCommand(input.script, {
      shell: true,
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...input.env
      },
      timeout: input.timeout_ms,
      reject: false,
      cancelSignal: input.abort_signal,
      all: false
    });

    return {
      exit_code: typeof result.exitCode === 'number' ? result.exitCode : null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timed_out: Boolean(result.timedOut)
    };
  } catch (error) {
    const err = error as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
      shortMessage?: string;
      message?: string;
    };

    return {
      exit_code: typeof err.exitCode === 'number' ? err.exitCode : null,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.shortMessage ?? err.message ?? '',
      timed_out: Boolean(err.timedOut)
    };
  }
}
