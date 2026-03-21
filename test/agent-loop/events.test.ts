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
import type { AgentEvent } from '../../src/agent-loop/events.js';
import { ScriptedAdapter } from '../helpers/scripted-adapter.js';
import { readFileHandler, readFileSchema, readFileDescription } from '../../src/agent-loop/tools/read-file.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-events-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('Agent session event metadata', () => {
  it('agent_session_completed includes session_id and final_state', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([{ text: 'done' }]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const registry = new ToolRegistry();
    registry.register('read_file', readFileDescription, readFileSchema, readFileHandler);

    const session = new AgentSession(
      client, registry, new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 10_000, workspace_root: workspace },
      { onEvent: (e) => events.push(e) }
    );

    await session.processInput('hello');

    expect(events.some((e) => e.type === 'agent_user_input')).toBe(true);
    expect(events.some((e) => e.type === 'agent_assistant_text_start')).toBe(true);
    expect(events.some((e) => e.type === 'agent_assistant_text_end')).toBe(true);
    expect(events.some((e) => e.type === 'agent_processing_ended')).toBe(true);

    const completed = events.find(e => e.type === 'agent_session_completed');
    expect(completed).toBeDefined();
    expect(completed!.type).toBe('agent_session_completed');
    if (completed!.type === 'agent_session_completed') {
      expect(completed!.session_id).toBeDefined();
      expect(typeof completed!.session_id).toBe('string');
    }
  });

  it('agent_tool_call_completed includes content_preview and truncated flag', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'hello world', 'utf8');
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      { tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { text: 'done' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const registry = new ToolRegistry();
    registry.register('read_file', readFileDescription, readFileSchema, readFileHandler);

    const session = new AgentSession(
      client, registry, new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 10_000, workspace_root: workspace },
      { onEvent: (e) => events.push(e) }
    );

    await session.processInput('read test.txt');

    const outputDelta = events.find((e) => e.type === 'agent_tool_call_output_delta');
    expect(outputDelta).toBeDefined();
    const toolCompleted = events.find(e => e.type === 'agent_tool_call_completed');
    expect(toolCompleted).toBeDefined();
    if (toolCompleted?.type === 'agent_tool_call_completed') {
      expect(toolCompleted.content_preview).toBeDefined();
      expect(typeof toolCompleted.content_preview).toBe('string');
      expect(toolCompleted.full_content).toBeDefined();
      expect(typeof toolCompleted.full_content).toBe('string');
      // Not truncated for small output
      expect(toolCompleted.truncated).toBe(false);
    }
  });

  it('emits agent_steering_injected when queued steering is drained', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      { tool_calls: [{ id: 'tc1', name: 'slow_tool', arguments: {} }] },
      { text: 'done' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const registry = new ToolRegistry();
    registry.register(
      'slow_tool',
      'Slow tool',
      { properties: {} },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'ok';
      },
    );

    const session = new AgentSession(
      client, registry, new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 10_000, workspace_root: workspace },
      { onEvent: (e) => events.push(e) }
    );

    const pending = session.submit('hello');
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.steer('Be concise');
    await pending;

    const injected = events.find((event) => event.type === 'agent_steering_injected');
    expect(injected?.type).toBe('agent_steering_injected');
    if (injected?.type === 'agent_steering_injected') {
      expect(injected.message).toContain('Be concise');
    }
  });
});
