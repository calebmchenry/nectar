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
import type { AgentEvent } from '../../src/agent-loop/events.js';
import { ScriptedAdapter } from '../helpers/scripted-adapter.js';
import { readFileHandler, readFileSchema, readFileDescription } from '../../src/agent-loop/tools/read-file.js';
import { writeFileHandler, writeFileSchema, writeFileDescription } from '../../src/agent-loop/tools/write-file.js';
import { editFileHandler, editFileSchema, editFileDescription } from '../../src/agent-loop/tools/edit-file.js';

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
    expect(types).toContain('agent_turn_started');
    expect(types).toContain('agent_tool_call_started');
    expect(types).toContain('agent_tool_call_completed');
    expect(types).toContain('agent_session_completed');
  });
});
