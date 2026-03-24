import { execCommand } from './exec-command.js';

export interface RunScriptInput {
  script: string;
  timeout_ms: number;
  env: Record<string, string>;
  cwd?: string;
  abort_signal?: AbortSignal;
}

export interface RunScriptResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export async function runScript(input: RunScriptInput): Promise<RunScriptResult> {
  const env = mergeEnv(input.env);
  const result = await execCommand({
    command: input.script,
    cwd: input.cwd ?? process.cwd(),
    env,
    timeout_ms: input.timeout_ms,
    abort_signal: input.abort_signal,
    shell: true,
  });

  return {
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    timed_out: result.timed_out,
  };
}

function mergeEnv(overrides: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value;
  }
  return merged;
}
