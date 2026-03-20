import type { ToolHandler } from '../tool-registry.js';

export const shellSchema = {
  properties: {
    command: { type: 'string', description: 'Shell command to execute' },
    timeout_ms: {
      type: 'integer',
      minimum: 1000,
      maximum: 600000,
      description: 'Command timeout in milliseconds (default: session default)',
    },
  },
  required: ['command'],
  additionalProperties: false,
};

export const shellHandler: ToolHandler = async (args, env) => {
  const command = args.command as string;
  const timeoutMs = args.timeout_ms as number | undefined;

  const result = await env.exec(command, { timeout_ms: timeoutMs });

  // Format output
  const parts = [`Exit code: ${result.exitCode}`];
  if (result.stdout) {
    parts.push(`\nSTDOUT:\n${result.stdout}`);
  }
  if (result.stderr) {
    parts.push(`\nSTDERR:\n${result.stderr}`);
  }
  return parts.join('\n');
};

export const shellDescription = 'Execute a shell command in the workspace directory with timeout support and environment variable filtering.';

/** Separate function for getting raw exec result (used by transcript writer for stdout/stderr logs) */
export async function shellExecRaw(
  command: string,
  env: { exec: (cmd: string, opts?: { timeout_ms?: number; abort_signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; exitCode: number }> },
  options?: { timeout_ms?: number; abort_signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return env.exec(command, options);
}
