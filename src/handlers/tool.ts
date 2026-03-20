import { HandlerExecutionInput, NodeOutcome } from '../engine/types.js';
import { runScript } from '../process/run-script.js';
import { NodeHandler } from './registry.js';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class ToolHandler implements NodeHandler {
  async execute(input: HandlerExecutionInput): Promise<NodeOutcome> {
    const script = input.node.attributes.script?.trim();
    if (!script) {
      return {
        status: 'failure',
        exit_code: 1,
        stderr: `Tool node '${input.node.id}' is missing script.`,
        error_message: 'Missing tool script.'
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
    return {
      status: success ? 'success' : 'failure',
      exit_code: result.exit_code ?? undefined,
      stdout: result.stdout,
      stderr: result.stderr,
      timed_out: result.timed_out,
      error_message: result.timed_out ? `Command timed out after ${timeoutMs}ms.` : undefined
    };
  }
}
