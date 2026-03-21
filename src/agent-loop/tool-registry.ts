import AjvModule from 'ajv';
import type { ToolDefinition } from '../llm/tools.js';
import { validateToolName } from '../llm/tool-repair.js';
import type { ExecutionEnvironment } from './execution-environment.js';
import type { ToolCallEnvelope, ToolResultEnvelope } from './types.js';
import { TOOL_LINE_CAPS, truncateToolOutput } from './truncation.js';
import { TOOL_OUTPUT_LIMITS } from './types.js';

export type ToolHandler = (
  args: Record<string, unknown>,
  env: ExecutionEnvironment
) => Promise<string>;

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

// Handle both ESM default and CJS-style imports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = ((AjvModule as any).default ?? AjvModule) as any;
const ajv = new Ajv({ allErrors: true, strict: false });

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: ToolHandler
  ): void {
    const validation = validateToolName(name);
    if (!validation.valid) {
      throw new Error(validation.error ?? `Invalid tool name '${name}'.`);
    }
    this.tools.set(name, { name, description, schema, handler });
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        ...t.schema,
      },
    }));
  }

  /**
   * Return definitions filtered to only the specified tool names.
   */
  definitionsForProfile(visibleTools: string[]): ToolDefinition[] {
    const visible = new Set(visibleTools);
    return [...this.tools.values()]
      .filter((t) => visible.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: 'object',
          ...t.schema,
        },
      }));
  }

  async execute(
    call: ToolCallEnvelope,
    env: ExecutionEnvironment,
    options?: {
      output_limits?: Record<string, number>;
      line_limits?: Record<string, number>;
    }
  ): Promise<ToolResultEnvelope> {
    const nameValidation = validateToolName(call.name);
    if (!nameValidation.valid) {
      return {
        call_id: call.call_id,
        content: nameValidation.error ?? `Invalid tool name '${call.name}'.`,
        is_error: true,
      };
    }

    const tool = this.tools.get(call.name);
    if (!tool) {
      const message = `Unknown tool: '${call.name}'. Available tools: ${[...this.tools.keys()].join(', ')}`;
      return {
        call_id: call.call_id,
        content: message,
        is_error: true,
        full_content: message,
        truncated: false,
      };
    }

    // Validate arguments against schema
    const validate = ajv.compile({
      type: 'object',
      ...tool.schema,
    });

    if (!validate(call.arguments)) {
      const errors = validate.errors?.map((e: { instancePath?: string; message?: string }) => `${e.instancePath || '/'}: ${e.message}`).join('; ');
      const message = `Invalid arguments for tool '${call.name}': ${errors}`;
      return {
        call_id: call.call_id,
        content: message,
        is_error: true,
        full_content: message,
        truncated: false,
      };
    }

    try {
      const result = await tool.handler(call.arguments, env);
      const outputLimits = {
        ...TOOL_OUTPUT_LIMITS,
        ...(options?.output_limits ?? {}),
      };
      const lineLimits = {
        ...TOOL_LINE_CAPS,
        ...(options?.line_limits ?? {}),
      };
      const charLimit = outputLimits[call.name] ?? 30_000;
      const { preview, truncated } = truncateToolOutput(call.name, result, charLimit, lineLimits);

      return {
        call_id: call.call_id,
        content: preview,
        is_error: false,
        full_content: result,
        truncated,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        call_id: call.call_id,
        content: message,
        is_error: true,
        full_content: message,
        truncated: false,
      };
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  definition(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    if (!tool) {
      return undefined;
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        ...tool.schema,
      },
    };
  }

  /**
   * Clone all registered tools into a target registry, excluding specified tool names.
   */
  cloneCoreTo(target: ToolRegistry, exclude: string[]): ToolRegistry {
    const excludeSet = new Set(exclude);
    for (const [name, tool] of this.tools.entries()) {
      if (!excludeSet.has(name)) {
        target.register(name, tool.description, tool.schema, tool.handler);
      }
    }
    return target;
  }
}
