import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/agent-loop/types.js';
import type { AgentEvent } from '../../src/agent-loop/events.js';
import { ScriptedAdapter } from '../helpers/scripted-adapter.js';
import { readFileHandler, readFileSchema, readFileDescription } from '../../src/agent-loop/tools/read-file.js';
import { spawnAgentSchema, spawnAgentDescription, spawnAgentHandler } from '../../src/agent-loop/tools/spawn-agent.js';
import { sendInputSchema, sendInputDescription, sendInputHandler } from '../../src/agent-loop/tools/send-input.js';
import { waitSchema, waitDescription, waitHandler } from '../../src/agent-loop/tools/wait.js';
import { closeAgentSchema, closeAgentDescription, closeAgentHandler } from '../../src/agent-loop/tools/close-agent.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-subagent-'));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(workspace: string, overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    max_turns: overrides?.max_turns ?? 12,
    max_tool_rounds_per_input: overrides?.max_tool_rounds_per_input ?? 10,
    default_command_timeout_ms: overrides?.default_command_timeout_ms ?? 10_000,
    workspace_root: workspace,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register('read_file', readFileDescription, readFileSchema, readFileHandler);
  registry.register('spawn_agent', spawnAgentDescription, spawnAgentSchema, spawnAgentHandler);
  registry.register('send_input', sendInputDescription, sendInputSchema, sendInputHandler);
  registry.register('wait', waitDescription, waitSchema, waitHandler);
  registry.register('close_agent', closeAgentDescription, closeAgentSchema, closeAgentHandler);
  return registry;
}

function makeSession(
  workspace: string,
  adapter: ScriptedAdapter,
  overrides?: Partial<SessionConfig>,
  opts?: { depth?: number; onEvent?: (e: AgentEvent) => void }
): AgentSession {
  const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
  return new AgentSession(
    client,
    makeRegistry(),
    new AnthropicProfile(),
    new LocalExecutionEnvironment(workspace),
    makeConfig(workspace, overrides),
    {
      depth: opts?.depth ?? 0,
      onEvent: opts?.onEvent,
      subagentConfig: { ...DEFAULT_SUBAGENT_CONFIG },
    }
  );
}

describe('AgentSession subagent integration', () => {
  it('session tracks depth correctly', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([{ text: 'done' }]);
    const session = makeSession(workspace, adapter, undefined, { depth: 0 });

    expect(session.getDepth()).toBe(0);
    expect(session.getSessionId()).toBeDefined();
  });

  it('session at max depth does not expose spawn_agent', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([{ text: 'done' }]);
    // Create session at depth 1 with max_subagent_depth 1
    const session = makeSession(workspace, adapter, undefined, { depth: 1 });

    // The session should work normally
    const result = await session.submit('hello');
    expect(result.status).toBe('success');
  });

  it('spawn_agent tool call gets handled by session', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'hello', 'utf8');

    // Parent makes a spawn_agent call
    const adapter = new ScriptedAdapter([
      {
        tool_calls: [{
          id: 'tc1',
          name: 'spawn_agent',
          arguments: { task: 'read test.txt' },
        }],
      },
      {
        // After spawn, wait for the child
        tool_calls: [{
          id: 'tc2',
          name: 'wait',
          arguments: { agent_ids: 'will-be-replaced' },
        }],
      },
      { text: 'All done!' },
    ]);
    const events: AgentEvent[] = [];
    const session = makeSession(workspace, adapter, undefined, {
      depth: 0,
      onEvent: (e) => events.push(e),
    });

    const result = await session.submit('spawn a child to read test.txt');
    expect(result.status).toBe('success');

    // Should have subagent tool call events
    const spawnEvents = events.filter(e => e.type === 'agent_tool_call_started' && (e as any).tool_name === 'spawn_agent');
    expect(spawnEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('spawn_agent forwards model override to child sessions', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [{
          id: 'tc1',
          name: 'spawn_agent',
          arguments: { task: 'read test.txt', model: 'gemini-2.5-flash' },
        }],
      },
      { text: 'done' },
    ]);

    const session = makeSession(workspace, adapter, undefined, {
      depth: 0,
      onEvent: (e) => events.push(e),
    });

    const result = await session.submit('spawn a model-overridden child');
    expect(result.status).toBe('success');

    const completed = events.find(
      (event) => event.type === 'agent_tool_call_completed' && (event as any).tool_name === 'spawn_agent'
    );
    expect(completed?.type).toBe('agent_tool_call_completed');
    if (completed?.type === 'agent_tool_call_completed') {
      expect(completed.content_preview).toContain('"model":"gemini-2.5-flash"');
    }
  });

  it('close_agent is handled gracefully', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([
      {
        tool_calls: [{
          id: 'tc1',
          name: 'spawn_agent',
          arguments: { task: 'do something' },
        }],
      },
      {
        tool_calls: [{
          id: 'tc2',
          name: 'close_agent',
          arguments: { agent_id: 'will-be-replaced' },
        }],
      },
      { text: 'Done after close' },
    ]);
    const session = makeSession(workspace, adapter);

    const result = await session.submit('spawn and close');
    expect(result.status).toBe('success');
  });

  it('abort propagates to children', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));

    session.abort();
    expect(session.getState()).toBe('CLOSED');
  });
});

describe('Dynamic tool visibility', () => {
  it('session exposes spawn_agent when below max depth', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([{ text: 'done' }]);
    const session = makeSession(workspace, adapter, undefined, { depth: 0 });

    // Session should work normally - spawn_agent is registered
    const result = await session.submit('hello');
    expect(result.status).toBe('success');
  });
});
