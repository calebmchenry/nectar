import { getToolSafety } from '../agent-loop/types.js';
import type { ToolCallEnvelope, ToolResultEnvelope } from '../agent-loop/types.js';
import type { Message } from './types.js';

export interface ToolContext {
  messages: Message[];
  abort_signal?: AbortSignal;
  tool_call_id: string;
}

export type ToolExecuteHandler = (
  args: Record<string, unknown>,
  context?: ToolContext,
) => Promise<string>;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute?: ToolExecuteHandler;
}

export interface ToolChoice {
  type: 'auto' | 'none' | 'required' | 'named';
  name?: string;
}

export type ActiveToolDefinition = ToolDefinition & { execute: ToolExecuteHandler };
export type PassiveToolDefinition = ToolDefinition & { execute?: undefined };

export function isActiveTool(tool: ToolDefinition): tool is ActiveToolDefinition {
  return typeof tool.execute === 'function';
}

export function isPassiveTool(tool: ToolDefinition): tool is PassiveToolDefinition {
  return !isActiveTool(tool);
}

/**
 * Execute a batch of tool calls with order-preserving partitioned dispatch.
 *
 * Contiguous read-only calls run concurrently (bounded by maxParallel).
 * Mutating calls run sequentially in their original position.
 * Results are returned in original call order regardless of completion order.
 */
export async function executeToolsBatch(
  calls: ToolCallEnvelope[],
  executor: (call: ToolCallEnvelope) => Promise<ToolResultEnvelope>,
  maxParallel: number = 8,
  abortSignal?: AbortSignal,
): Promise<ToolResultEnvelope[]> {
  if (calls.length === 0) return [];
  if (calls.length === 1) return [await executor(calls[0]!)];

  // Partition into contiguous runs of same safety class
  const runs: { startIndex: number; calls: ToolCallEnvelope[]; safety: 'read_only' | 'mutating' }[] = [];

  let currentRun: typeof runs[number] | null = null;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const safety = getToolSafety(call.name);

    if (!currentRun || currentRun.safety !== safety) {
      currentRun = { startIndex: i, calls: [call], safety };
      runs.push(currentRun);
    } else {
      currentRun.calls.push(call);
    }
  }

  // Execute each run
  const results: ToolResultEnvelope[] = new Array(calls.length);

  for (const run of runs) {
    if (abortSignal?.aborted) {
      // Fill remaining with abort results
      for (let i = run.startIndex; i < run.startIndex + run.calls.length; i++) {
        results[i] = {
          call_id: calls[i]!.call_id,
          content: 'Execution aborted',
          is_error: true,
        };
      }
      continue;
    }

    if (run.safety === 'mutating') {
      // Execute sequentially
      for (let i = 0; i < run.calls.length; i++) {
        if (abortSignal?.aborted) {
          results[run.startIndex + i] = {
            call_id: run.calls[i]!.call_id,
            content: 'Execution aborted',
            is_error: true,
          };
          continue;
        }
        results[run.startIndex + i] = await executor(run.calls[i]!);
      }
    } else {
      // Execute concurrently with semaphore
      const runResults = await executeWithSemaphore(
        run.calls,
        executor,
        maxParallel,
      );
      for (let i = 0; i < runResults.length; i++) {
        results[run.startIndex + i] = runResults[i]!;
      }
    }
  }

  return results;
}

async function executeWithSemaphore(
  calls: ToolCallEnvelope[],
  executor: (call: ToolCallEnvelope) => Promise<ToolResultEnvelope>,
  maxParallel: number,
): Promise<ToolResultEnvelope[]> {
  const results: ToolResultEnvelope[] = new Array(calls.length);
  let running = 0;
  let nextIndex = 0;

  return new Promise((resolve) => {
    function startNext(): void {
      while (running < maxParallel && nextIndex < calls.length) {
        const idx = nextIndex++;
        const call = calls[idx]!;
        running++;

        Promise.resolve()
          .then(() => executor(call))
          .then(
            (result) => {
              results[idx] = result;
            },
            (error) => {
              results[idx] = {
                call_id: call.call_id,
                content: error instanceof Error ? error.message : String(error),
                is_error: true,
              };
            },
          )
          .finally(() => {
            running--;
            if (nextIndex >= calls.length && running === 0) {
              resolve(results);
            } else {
              startNext();
            }
          });
      }
    }

    startNext();
    // Handle edge case: empty calls array
    if (calls.length === 0) {
      resolve(results);
    }
  });
}
