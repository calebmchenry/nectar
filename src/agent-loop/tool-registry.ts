import AjvModule from 'ajv';
import type { ToolDefinition } from '../llm/tools.js';
import type { ExecutionEnvironment } from './execution-environment.js';
import type { ToolCallEnvelope, ToolResultEnvelope } from './types.js';
import { truncateToolOutput } from './truncation.js';
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
    env: ExecutionEnvironment
  ): Promise<ToolResultEnvelope> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        call_id: call.call_id,
        content: `Unknown tool: '${call.name}'. Available tools: ${[...this.tools.keys()].join(', ')}`,
        is_error: true,
      };
    }

    // Validate arguments against schema
    const validate = ajv.compile({
      type: 'object',
      ...tool.schema,
    });

    if (!validate(call.arguments)) {
      const errors = validate.errors?.map((e: { instancePath?: string; message?: string }) => `${e.instancePath || '/'}: ${e.message}`).join('; ');
      return {
        call_id: call.call_id,
        content: `Invalid arguments for tool '${call.name}': ${errors}`,
        is_error: true,
      };
    }

    try {
      const result = await tool.handler(call.arguments, env);
      const charLimit = TOOL_OUTPUT_LIMITS[call.name] ?? 30_000;
      const { preview, truncated } = truncateToolOutput(call.name, result, charLimit);

      return {
        call_id: call.call_id,
        content: preview,
        is_error: false,
        full_content: truncated ? result : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        call_id: call.call_id,
        content: message,
        is_error: true,
      };
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
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
