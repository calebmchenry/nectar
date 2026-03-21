import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnifiedClient } from '../../src/llm/client.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import { AgentSession } from '../../src/agent-loop/session.js';
import { ToolRegistry } from '../../src/agent-loop/tool-registry.js';
import { LocalExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';
import { AnthropicProfile } from '../../src/agent-loop/provider-profiles.js';
import type { SessionConfig } from '../../src/agent-loop/types.js';
import { DEFAULT_SESSION_CONFIG } from '../../src/agent-loop/types.js';
import type { AgentEvent } from '../../src/agent-loop/events.js';
import { ScriptedAdapter } from '../helpers/scripted-adapter.js';
import { readFileHandler, readFileSchema, readFileDescription } from '../../src/agent-loop/tools/read-file.js';
import { writeFileHandler, writeFileSchema, writeFileDescription } from '../../src/agent-loop/tools/write-file.js';
import { editFileHandler, editFileSchema, editFileDescription } from '../../src/agent-loop/tools/edit-file.js';
import { shellHandler, shellSchema, shellDescription } from '../../src/agent-loop/tools/shell.js';
import type { ExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';
import type { StreamEvent } from '../../src/llm/streaming.js';
import { ContextLengthError } from '../../src/llm/errors.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-session-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(workspace: string, overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    ...overrides,
    max_turns: overrides?.max_turns ?? 12,
    max_tool_rounds_per_input: overrides?.max_tool_rounds_per_input ?? 10,
    default_command_timeout_ms: overrides?.default_command_timeout_ms ?? 120_000,
    workspace_root: workspace,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register('read_file', readFileDescription, readFileSchema, readFileHandler);
  registry.register('write_file', writeFileDescription, writeFileSchema, writeFileHandler);
  registry.register('edit_file', editFileDescription, editFileSchema, editFileHandler);
  return registry;
}

describe('AgentSession', () => {
  it('completes single turn with no tools', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([
      { text: 'Hello! Task complete.' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace)
    );

    const result = await session.processInput('Say hello');
    expect(result.status).toBe('success');
    expect(result.final_text).toBe('Hello! Task complete.');
    expect(result.turn_count).toBe(1);
    expect(result.tool_call_count).toBe(0);
  });

  it('drives multi-turn tool loop to completion', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'hello world', 'utf8');

    const adapter = new ScriptedAdapter([
      // Turn 1: read the file
      {
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'test.txt' } }],
      },
      // Turn 2: done
      { text: 'I read the file. It says hello world.' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace)
    );

    const result = await session.processInput('Read test.txt');
    expect(result.status).toBe('success');
    expect(result.turn_count).toBe(2);
    expect(result.tool_call_count).toBe(1);
  });

  it('enforces max_turns limit', async () => {
    const workspace = await createWorkspace();

    // Create adapter that always calls a tool (never finishes)
    // Use different file paths so loop detector doesn't fire before max_turns
    const turns = Array.from({ length: 5 }, (_, i) => ({
      tool_calls: [{ id: `tc-${i}`, name: 'read_file', arguments: { path: `test${i}.txt` } }],
    }));
    const adapter = new ScriptedAdapter(turns);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(workspace, `test${i}.txt`), `content ${i}`, 'utf8');
    }

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, { max_turns: 3 })
    );

    const result = await session.processInput('Do something');
    expect(result.status).toBe('failure');
    expect(result.stop_reason).toBe('turn_limit_exceeded');
  });

  it('counts max_turns across session lifetime and rejects subsequent inputs once exhausted', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      { tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { text: 'first complete' },
      { tool_calls: [{ id: 'tc-2', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { tool_calls: [{ id: 'tc-3', name: 'read_file', arguments: { path: 'test.txt' } }] },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, { max_turns: 3 }),
      { onEvent: (event) => events.push(event) },
    );

    const first = await session.submit('first');
    expect(first.status).toBe('success');
    expect(first.turn_count).toBe(2);

    const second = await session.submit('second');
    expect(second.status).toBe('failure');
    expect(second.stop_reason).toBe('turn_limit_exceeded');
    expect(second.turn_count).toBe(1);

    await expect(session.submit('third')).rejects.toThrow(/turn limit/i);
    expect(events.filter((event) => event.type === 'agent_turn_limit_reached')).toHaveLength(1);
  });

  it('enforces max_tool_rounds_per_input limit', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');

    const turns = Array.from({ length: 5 }, () => ({
      tool_calls: [{ id: `tc-${Math.random()}`, name: 'read_file', arguments: { path: 'test.txt' } }],
    }));
    const adapter = new ScriptedAdapter(turns);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, { max_tool_rounds_per_input: 2 })
    );

    const result = await session.processInput('Do something');
    expect(result.status).toBe('failure');
    expect(result.stop_reason).toBe('tool_round_limit_exceeded');
  });

  it('default 0 limits allow sessions to exceed 12 turns and 10 tool rounds', async () => {
    const workspace = await createWorkspace();
    for (let i = 0; i < 13; i += 1) {
      await writeFile(path.join(workspace, `file-${i}.txt`), `content ${i}`, 'utf8');
    }

    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 13 }, (_, i) => ({
        tool_calls: [{ id: `tc-${i}`, name: 'read_file', arguments: { path: `file-${i}.txt` } }],
      })),
      { text: 'done' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client,
      makeRegistry(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      {
        max_turns: DEFAULT_SESSION_CONFIG.max_turns,
        max_tool_rounds_per_input: DEFAULT_SESSION_CONFIG.max_tool_rounds_per_input,
        default_command_timeout_ms: 120_000,
        workspace_root: workspace,
      },
    );

    const result = await session.processInput('keep reading files');
    expect(DEFAULT_SESSION_CONFIG.max_turns).toBe(0);
    expect(DEFAULT_SESSION_CONFIG.max_tool_rounds_per_input).toBe(0);
    expect(result.status).toBe('success');
    expect(result.turn_count).toBe(14);
    expect(result.tool_call_count).toBe(13);
  });

  it('handles tool error and model recovery', async () => {
    const workspace = await createWorkspace();
    // File doesn't exist — first tool call will error, second succeeds
    await writeFile(path.join(workspace, 'exists.txt'), 'found it', 'utf8');

    const adapter = new ScriptedAdapter([
      // Turn 1: try to read missing file
      {
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'missing.txt' } }],
      },
      // Turn 2: read existing file
      {
        tool_calls: [{ id: 'tc2', name: 'read_file', arguments: { path: 'exists.txt' } }],
      },
      // Turn 3: success
      { text: 'Found the file with content: found it' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace)
    );

    const result = await session.processInput('Find and read a file');
    expect(result.status).toBe('success');
    expect(result.turn_count).toBe(3);
    expect(result.tool_call_count).toBe(2);
  });

  it('abort cancels session', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'test.txt' } }],
      },
      { text: 'Done' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace)
    );

    // Abort immediately
    session.abort();
    const result = await session.processInput('Do something');
    expect(result.status).toBe('aborted');
  });

  it('aggregates usage across turns', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'test.txt' } }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      {
        text: 'Done',
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace)
    );

    const result = await session.processInput('Read something');
    expect(result.usage.input_tokens).toBe(300);
    expect(result.usage.output_tokens).toBe(150);
  });

  it('emits events through onEvent callback', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'test.txt' } }],
      },
      { text: 'Done' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
      { onEvent: (e) => events.push(e) }
    );

    await session.processInput('Read test.txt');

    const types = events.map((e) => e.type);
    expect(types).toContain('agent_user_input');
    expect(types).toContain('agent_turn_started');
    expect(types).toContain('agent_assistant_text_start');
    expect(types).toContain('agent_assistant_text_end');
    expect(types).toContain('agent_tool_call_started');
    expect(types).toContain('agent_tool_call_output_delta');
    expect(types).toContain('agent_tool_call_completed');
    expect(types).toContain('agent_processing_ended');
    expect(types).toContain('agent_session_completed');
  });

  it('respects enable_loop_detection=false by allowing repeated rounds until limits', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');

    const adapter = new ScriptedAdapter([
      { tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { tool_calls: [{ id: 'tc2', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { tool_calls: [{ id: 'tc3', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { tool_calls: [{ id: 'tc4', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { tool_calls: [{ id: 'tc5', name: 'read_file', arguments: { path: 'test.txt' } }] },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, { max_turns: 4, enable_loop_detection: false })
    );

    const result = await session.processInput('repeat read_file');
    expect(result.status).toBe('failure');
    expect(result.stop_reason).toBe('turn_limit_exceeded');
  });

  it('first loop detection injects steering and allows recovery', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');
    const events: AgentEvent[] = [];

    let turn = 0;
    let sawSteering = false;
    const adapter: ProviderAdapter = {
      provider_name: 'loop-steer',
      async generate() {
        return {
          message: { role: 'assistant', content: 'unused' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'loop-steer',
          provider: 'loop-steer',
        };
      },
      async *stream(request): AsyncIterable<StreamEvent> {
        turn += 1;
        sawSteering = request.messages.some((message) => {
          if (message.role !== 'user') {
            return false;
          }
          const content = Array.isArray(message.content)
            ? message.content.map((part) => ('text' in part ? String(part.text ?? '') : '')).join('\n')
            : String(message.content);
          return content.includes('Loop detected');
        });

        yield { type: 'stream_start', model: 'loop-steer' };
        if (turn <= 3) {
          yield { type: 'tool_call_delta', id: `tc-${turn}`, name: 'read_file', arguments_delta: JSON.stringify({ path: 'test.txt' }) };
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
          yield {
            type: 'stream_end',
            stop_reason: 'tool_use',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_call', id: `tc-${turn}`, name: 'read_file', arguments: JSON.stringify({ path: 'test.txt' }) }],
            },
          };
          return;
        }

        yield { type: 'content_delta', text: 'Recovered after steering.' };
        yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
        yield {
          type: 'stream_end',
          stop_reason: 'end_turn',
          message: { role: 'assistant', content: 'Recovered after steering.' },
        };
      },
    };

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, { max_turns: 8 }),
      { onEvent: (event) => events.push(event) },
    );

    const result = await session.processInput('keep reading test.txt');
    expect(result.status).toBe('success');
    expect(result.final_text).toContain('Recovered');
    expect(sawSteering).toBe(true);
    expect(events.filter((event) => event.type === 'agent_loop_detected')).toHaveLength(1);
  });

  it('loop detection reset allows progress after steering', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(workspace, 'b.txt'), 'b', 'utf8');

    let turn = 0;
    const adapter: ProviderAdapter = {
      provider_name: 'loop-reset',
      async generate() {
        return {
          message: { role: 'assistant', content: 'unused' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'loop-reset',
          provider: 'loop-reset',
        };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        turn += 1;
        yield { type: 'stream_start', model: 'loop-reset' };
        if (turn <= 3) {
          yield { type: 'tool_call_delta', id: `tc-${turn}`, name: 'read_file', arguments_delta: JSON.stringify({ path: 'a.txt' }) };
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
          yield {
            type: 'stream_end',
            stop_reason: 'tool_use',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_call', id: `tc-${turn}`, name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }],
            },
          };
          return;
        }
        if (turn === 4) {
          yield { type: 'tool_call_delta', id: 'tc-4', name: 'read_file', arguments_delta: JSON.stringify({ path: 'b.txt' }) };
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
          yield {
            type: 'stream_end',
            stop_reason: 'tool_use',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_call', id: 'tc-4', name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) }],
            },
          };
          return;
        }
        yield { type: 'content_delta', text: 'done' };
        yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'done' } };
      },
    };

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, { max_turns: 10 }),
    );

    const result = await session.processInput('try files');
    expect(result.status).toBe('success');
    expect(result.tool_call_count).toBe(4);
  });

  it('fails after 3 loop detections despite steering attempts', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');
    const events: AgentEvent[] = [];

    let turn = 0;
    const adapter: ProviderAdapter = {
      provider_name: 'loop-fail',
      async generate() {
        return {
          message: { role: 'assistant', content: 'unused' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'loop-fail',
          provider: 'loop-fail',
        };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        turn += 1;
        yield { type: 'stream_start', model: 'loop-fail' };
        yield { type: 'tool_call_delta', id: `tc-${turn}`, name: 'read_file', arguments_delta: JSON.stringify({ path: 'test.txt' }) };
        yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
        yield {
          type: 'stream_end',
          stop_reason: 'tool_use',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_call', id: `tc-${turn}`, name: 'read_file', arguments: JSON.stringify({ path: 'test.txt' }) }],
          },
        };
      },
    };

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, { max_turns: 12 }),
      { onEvent: (event) => events.push(event) },
    );

    const result = await session.processInput('stuck loop');
    expect(result.status).toBe('failure');
    expect(result.stop_reason).toBe('loop_detected');
    expect(result.error_message).toContain('Loop detected 3 times');
    expect(events.filter((event) => event.type === 'agent_loop_detected')).toHaveLength(3);
  });

  it('applies max_command_timeout_ms cap to shell execution', async () => {
    const workspace = await createWorkspace();
    let observedTimeout: number | undefined;
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [{
          id: 'tc1',
          name: 'shell',
          arguments: {
            command: 'echo hi',
            description: 'Run hello check',
            timeout_ms: 5000,
          },
        }],
      },
      { text: 'done' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const registry = new ToolRegistry();
    registry.register('shell', shellDescription, shellSchema, shellHandler);

    const env: ExecutionEnvironment = {
      workspaceRoot: workspace,
      cwd: workspace,
      readFile: async () => '',
      writeFile: async () => {},
      fileExists: async () => true,
      deleteFile: async () => {},
      renameFile: async () => {},
      resolvePath: async (filePath: string) => path.join(workspace, filePath),
      exec: async (_command, options) => {
        observedTimeout = options?.timeout_ms;
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
      glob: async () => [],
      grep: async () => [],
      scoped: () => env,
    };

    const session = new AgentSession(
      client, registry, new AnthropicProfile(),
      env,
      makeConfig(workspace, {
        default_command_timeout_ms: 1000,
        max_command_timeout_ms: 2000,
      }),
      { onEvent: (event) => events.push(event) }
    );

    const result = await session.processInput('run shell');
    expect(result.status).toBe('success');
    expect(observedTimeout).toBe(2000);
    const started = events.find(
      (event) => event.type === 'agent_tool_call_started' && (event as any).tool_name === 'shell'
    );
    expect(started?.type).toBe('agent_tool_call_started');
    if (started?.type === 'agent_tool_call_started') {
      expect(started.arguments.description).toBe('Run hello check');
    }
  });

  it('uses SessionConfig.reasoning_effort as the initial model override', async () => {
    const workspace = await createWorkspace();
    let capturedReasoning: string | undefined;

    const adapter: ProviderAdapter = {
      provider_name: 'capture',
      generate: async () => ({
        message: { role: 'assistant', content: 'done' },
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
        model: 'capture-model',
        provider: 'capture',
      }),
      async *stream(request): AsyncIterable<StreamEvent> {
        capturedReasoning = request.reasoning_effort;
        yield { type: 'stream_start', model: 'capture-model' };
        yield { type: 'content_delta', text: 'done' };
        yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'done' } };
      },
    };
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, { reasoning_effort: 'high' })
    );

    const result = await session.processInput('hello');
    expect(result.status).toBe('success');
    expect(capturedReasoning).toBe('high');
  });

  it('applies tool_output_limits and tool_line_limits overrides', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      { tool_calls: [{ id: 'tc1', name: 'grep', arguments: { pattern: 'x' } }] },
      { text: 'done' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const registry = new ToolRegistry();
    registry.register('grep', 'Fake grep', { properties: { pattern: { type: 'string' } }, required: ['pattern'] }, async () => {
      return Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
    });

    const session = new AgentSession(
      client, registry, new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, {
        tool_output_limits: { grep: 120 },
        tool_line_limits: { grep: 4 },
      }),
      { onEvent: (event) => events.push(event) }
    );

    const result = await session.processInput('run grep');
    expect(result.status).toBe('success');
    const warning = events.find((event) => event.type === 'agent_warning');
    expect(warning?.type).toBe('agent_warning');
    if (warning?.type === 'agent_warning') {
      expect(warning.code).toBe('tool_output_truncated');
    }
    const completed = events.find((event) => event.type === 'agent_tool_call_completed');
    expect(completed?.type).toBe('agent_tool_call_completed');
    if (completed?.type === 'agent_tool_call_completed') {
      expect(completed.content_preview).toContain('lines omitted');
      expect(completed.full_content).toBeDefined();
      expect(completed.truncated).toBe(true);
    }
  });

  it('recovers from ContextLengthError and remains available for follow-up input', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];
    let streamCalls = 0;

    const adapter: ProviderAdapter = {
      provider_name: 'context-overflow-test',
      async generate() {
        return {
          message: { role: 'assistant', content: 'unused' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'context-overflow-test',
          provider: 'context-overflow-test',
        };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        streamCalls += 1;
        if (streamCalls === 1) {
          throw new ContextLengthError('context-overflow-test', 'context too long');
        }
        yield { type: 'stream_start', model: 'context-overflow-test' };
        yield { type: 'content_delta', text: 'Recovered response' };
        yield {
          type: 'stream_end',
          stop_reason: 'end_turn',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered response' }] },
        };
      },
      supports_tool_choice() {
        return true;
      },
    };

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client,
      makeRegistry(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
      { onEvent: (event) => events.push(event) },
    );

    const first = await session.processInput('long input');
    expect(first.status).toBe('failure');
    expect(first.stop_reason).toBe('context_length_exceeded');
    expect(session.getState()).toBe('AWAITING_INPUT');
    expect(events.some((event) => event.type === 'agent_warning')).toBe(true);
    expect(events.some((event) => event.type === 'context_window_warning')).toBe(true);

    const second = await session.processInput('short input');
    expect(second.status).toBe('success');
    expect(second.final_text).toContain('Recovered response');
  });

  it('emits agent_turn_limit_reached and agent_error when max_turns is exhausted', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      { tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { tool_calls: [{ id: 'tc-2', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { tool_calls: [{ id: 'tc-3', name: 'read_file', arguments: { path: 'test.txt' } }] },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace, { max_turns: 2 }),
      { onEvent: (event) => events.push(event) },
    );

    const result = await session.processInput('loop forever');
    expect(result.status).toBe('failure');
    expect(result.stop_reason).toBe('turn_limit_exceeded');
    expect(events.some((event) => event.type === 'agent_turn_limit_reached')).toBe(true);
    expect(events.some((event) => event.type === 'agent_error')).toBe(true);
  });
});
