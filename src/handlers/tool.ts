import { HandlerExecutionInput, NodeOutcome } from '../engine/types.js';
import { runScript } from '../process/run-script.js';
import { NodeHandler } from './registry.js';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class ToolHandler implements NodeHandler {
  async execute(input: HandlerExecutionInput): Promise<NodeOutcome> {
    const script = input.node.toolCommand
      ?? input.node.attributes.tool_command?.trim()
      ?? input.node.attributes.script?.trim();
    if (!script) {
      return {
        status: 'failure',
        exit_code: 1,
        stderr: `Tool node '${input.node.id}' is missing tool_command.`,
        error_message: 'Missing tool command.'
      };
    }

    const timeoutMs = input.node.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = {
      NECTAR_RUN_ID: input.run_id,
      NECTAR_NODE_ID: input.node.id,
      NECTAR_ATTEMPT: String(input.attempt),
      NECTAR_RUN_DIR: input.run_dir,
      NECTAR_GARDEN_PATH: input.dot_file,
      // Legacy aliases for backward compatibility
      POLLINATOR_RUN_ID: input.run_id,
      POLLINATOR_RUN_DIR: input.run_dir,
    };

    const result = await runScript({
      script,
      timeout_ms: timeoutMs,
      env,
      abort_signal: input.abort_signal
    });

    const success = result.exit_code === 0 && !result.timed_out;
    const contextUpdates: Record<string, string> = {};
    if (result.stdout.trim().length > 0) {
      contextUpdates['tool.output'] = result.stdout.slice(0, 500);
    }
    if (result.stderr.trim().length > 0) {
      contextUpdates['tool.stderr'] = result.stderr.slice(0, 500);
    }
    if (typeof result.exit_code === 'number') {
      contextUpdates['tool.exit_code'] = String(result.exit_code);
    }

    return {
      status: success ? 'success' : 'failure',
      exit_code: result.exit_code ?? undefined,
      stdout: result.stdout,
      stderr: result.stderr,
      timed_out: result.timed_out,
      error_message: result.timed_out ? `Command timed out after ${timeoutMs}ms.` : undefined,
      error_category: !success ? classifyToolErrorCategory(result.stderr, result.timed_out) : undefined,
      context_updates: Object.keys(contextUpdates).length > 0 ? contextUpdates : undefined,
    };
  }
}

function classifyToolErrorCategory(stderr: string, timedOut: boolean): NodeOutcome['error_category'] {
  if (timedOut) {
    return 'network';
  }

  const text = stderr.trim();
  if (!text) {
    return undefined;
  }

  const statusMatch = text.match(/\b([45]\d{2})\b/);
  if (statusMatch) {
    const statusCode = Number.parseInt(statusMatch[1]!, 10);
    if (statusCode === 400) return 'http_400';
    if (statusCode === 401) return 'http_401';
    if (statusCode === 403) return 'http_403';
    if (statusCode === 429) return 'http_429';
    if (statusCode >= 500 && statusCode <= 599) return 'http_5xx';
  }

  if (/network|timeout|timed out|connection|socket|dns|econn|enotfound/i.test(text)) {
    return 'network';
  }

  return undefined;
}
