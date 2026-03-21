import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../../src/agent-loop/session.js';
import { LocalExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';
import { AnthropicProfile } from '../../src/agent-loop/provider-profiles.js';
import { ToolRegistry } from '../../src/agent-loop/tool-registry.js';
import { UnifiedClient, generate as generateWithToolLoop } from '../../src/llm/client.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import type { GenerateRequest, GenerateResponse } from '../../src/llm/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';
import { repairToolCall, validateToolName } from '../../src/llm/tool-repair.js';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

describe('tool repair', () => {
  it('validates tool names against the allowlist pattern and length', () => {
    expect(validateToolName('read_file').valid).toBe(true);
    expect(validateToolName('bad-name').valid).toBe(false);
    expect(validateToolName('a'.repeat(65)).valid).toBe(false);
  });

  it('repairs safe JSON issues, strips unknown keys, and coerces losslessly', () => {
    const repaired = repairToolCall({
      tool_name: 'count_tool',
      raw_arguments: '{"count":"2","extra":"drop-me",}',
      schema: {
        properties: {
          count: { type: 'integer' },
        },
        required: ['count'],
        additionalProperties: false,
      },
    });

    expect(repaired.ok).toBe(true);
    if (repaired.ok) {
      expect(repaired.call.changed).toBe(true);
      expect(repaired.call.arguments).toEqual({ count: 2 });
    }
  });

  it('rejects lossy coercions and fails closed', () => {
    const repaired = repairToolCall({
      tool_name: 'count_tool',
      raw_arguments: '{"count":"1.2"}',
      schema: {
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false,
      },
    });

    expect(repaired.ok).toBe(false);
  });

  it('fails closed for unrecoverable malformed JSON', () => {
    const repaired = repairToolCall({
      tool_name: 'count_tool',
      raw_arguments: '{"count":',
      schema: {
        properties: { count: { type: 'integer' } },
        required: ['count'],
      },
    });

    expect(repaired.ok).toBe(false);
    if (!repaired.ok) {
      expect(repaired.error.code).toBe('invalid_tool_call');
    }
  });
});

describe('tool repair integration', () => {
  it('repaired calls execute exactly once in UnifiedClient tool loop', async () => {
    const executeSpy = vi.fn(async () => 'ok');
    const adapter = twoTurnToolCallAdapter('{"count":"2","extra":"drop",}');
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['mock', adapter]]));

    const result = await generateWithToolLoop(
      {
        provider: 'mock',
        messages: [{ role: 'user', content: 'run the tool' }],
        tools: [
          {
            name: 'count_tool',
            description: 'Count',
            input_schema: {
              properties: {
                count: { type: 'integer' },
              },
              required: ['count'],
              additionalProperties: false,
            },
            execute: executeSpy,
          },
        ],
      },
      { client },
    );

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith({ count: 2 }, expect.any(Object));
    expect(result.output.warnings.some((warning) => warning.code === 'tool_call_repaired')).toBe(true);
  });

  it('failed repair never executes the underlying tool in UnifiedClient tool loop', async () => {
    const executeSpy = vi.fn(async () => 'should-not-run');
    const adapter = twoTurnToolCallAdapter('{"count":"1.2"}');
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['mock', adapter]]));

    await generateWithToolLoop(
      {
        provider: 'mock',
        messages: [{ role: 'user', content: 'run the tool' }],
        tools: [
          {
            name: 'count_tool',
            description: 'Count',
            input_schema: {
              properties: {
                count: { type: 'integer' },
              },
              required: ['count'],
              additionalProperties: false,
            },
            execute: executeSpy,
          },
        ],
      },
      { client },
    );

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('repaired calls execute exactly once in AgentSession', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-tool-repair-session-'));
    let streamCalls = 0;
    const adapter: ProviderAdapter = {
      provider_name: 'mock',
      async generate(): Promise<GenerateResponse> {
        return {
          message: { role: 'assistant', content: 'unused' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'mock-model',
          provider: 'mock',
        };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        streamCalls += 1;
        if (streamCalls === 1) {
          yield { type: 'stream_start', model: 'mock-model' };
          yield {
            type: 'tool_call_delta',
            id: 'tc-1',
            name: 'count_tool',
            arguments_delta: '{"count":"2","extra":"drop",}',
          };
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
          yield {
            type: 'stream_end',
            stop_reason: 'tool_use',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_call', id: 'tc-1', name: 'count_tool', arguments: '{"count":"2","extra":"drop",}' }],
            },
          };
          return;
        }

        yield { type: 'stream_start', model: 'mock-model' };
        yield { type: 'content_delta', text: 'done' };
        yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'done' } };
      },
    };

    try {
      const client = new UnifiedClient(new Map<string, ProviderAdapter>([['mock', adapter]]));
      const registry = new ToolRegistry();
      const executeSpy = vi.fn(async (args: Record<string, unknown>) => `count=${args.count as number}`);
      registry.register(
        'count_tool',
        'Count',
        {
          properties: { count: { type: 'integer' } },
          required: ['count'],
          additionalProperties: false,
        },
        executeSpy,
      );

      const session = new AgentSession(
        client,
        registry,
        new AnthropicProfile(),
        new LocalExecutionEnvironment(workspace),
        {
          max_turns: 4,
          max_tool_rounds_per_input: 4,
          default_command_timeout_ms: 30_000,
          workspace_root: workspace,
        },
        {
          overrides: { provider: 'mock' },
        },
      );

      const result = await session.processInput('repair and run');
      expect(result.status).toBe('success');
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledWith({ count: 2 }, expect.any(Object));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function twoTurnToolCallAdapter(rawArguments: string): ProviderAdapter {
  let callCount = 0;
  return {
    provider_name: 'mock',
    async generate(_request: GenerateRequest): Promise<GenerateResponse> {
      callCount += 1;
      if (callCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'tc-1', name: 'count_tool', arguments: rawArguments }],
          },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'tool_use',
          model: 'mock-model',
          provider: 'mock',
        };
      }

      return {
        message: { role: 'assistant', content: 'done' },
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
        model: 'mock-model',
        provider: 'mock',
      };
    },
    async *stream(): AsyncIterable<StreamEvent> {
      throw new Error('stream not used in this test adapter');
    },
  };
}
