import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnifiedClient } from '../../src/llm/client.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import { AgentSession, AbortError } from '../../src/agent-loop/session.js';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-session-ctrl-'));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(workspace: string, overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    max_turns: overrides?.max_turns ?? 12,
    max_tool_rounds_per_input: overrides?.max_tool_rounds_per_input ?? 10,
    default_command_timeout_ms: overrides?.default_command_timeout_ms ?? 10_000,
    workspace_root: workspace,
    max_follow_ups: overrides?.max_follow_ups ?? 10,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register('read_file', readFileDescription, readFileSchema, readFileHandler);
  return registry;
}

function makeSession(
  workspace: string,
  adapter: ScriptedAdapter,
  overrides?: Partial<SessionConfig>
): AgentSession {
  const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
  return new AgentSession(
    client,
    makeRegistry(),
    new AnthropicProfile(),
    new LocalExecutionEnvironment(workspace),
    makeConfig(workspace, overrides)
  );
}

describe('AgentSession state machine', () => {
  it('starts in IDLE state', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));
    expect(session.getState()).toBe('IDLE');
  });

  it('transitions IDLE → PROCESSING → AWAITING_INPUT on submit', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));

    const result = await session.submit('hello');
    expect(result.status).toBe('success');
    expect(session.getState()).toBe('AWAITING_INPUT');
  });

  it('rejects submit while PROCESSING', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'test.txt'), 'content', 'utf8');

    // Use a tool call to keep session processing longer
    const adapter = new ScriptedAdapter([
      { tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'test.txt' } }] },
      { text: 'done' },
      { text: 'second done' },
    ]);
    const session = makeSession(workspace, adapter);

    const first = session.submit('do work');
    // Try to submit while processing
    await expect(session.submit('more work')).rejects.toThrow('PROCESSING');
    await first;
  });

  it('close() transitions to CLOSED', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));
    await session.submit('hello');
    session.close();
    expect(session.getState()).toBe('CLOSED');
  });

  it('rejects submit on CLOSED session', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));
    session.close();
    await expect(session.submit('hello')).rejects.toThrow('CLOSED');
  });

  it('abort() transitions to CLOSED and returns aborted result', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));
    session.abort();
    expect(session.getState()).toBe('CLOSED');

    const result = await session.processInput('hello');
    expect(result.status).toBe('aborted');
  });
});

describe('AgentSession followUp', () => {
  it('follows up reusing conversation', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([
      { text: 'first response' },
      { text: 'follow up response' },
    ]);
    const session = makeSession(workspace, adapter);

    const r1 = await session.submit('first task');
    expect(r1.status).toBe('success');
    expect(r1.final_text).toBe('first response');

    const r2 = await session.followUp('continue');
    expect(r2.status).toBe('success');
    expect(r2.final_text).toBe('follow up response');
  });

  it('enforces max_follow_ups limit', async () => {
    const workspace = await createWorkspace();
    const turns = Array.from({ length: 5 }, () => ({ text: 'ok' }));
    const adapter = new ScriptedAdapter(turns);
    const session = makeSession(workspace, adapter, { max_follow_ups: 2 });

    await session.submit('start');
    await session.followUp('first');
    await session.followUp('second');
    await expect(session.followUp('third')).rejects.toThrow('Follow-up limit');
  });

  it('rejects followUp on CLOSED session', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));
    session.close();
    await expect(session.followUp('hello')).rejects.toThrow('CLOSED');
  });
});

describe('AgentSession steer', () => {
  it('throws if session is not PROCESSING', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));
    expect(() => session.steer('change direction')).toThrow('IDLE');
  });

  it('throws if session is AWAITING_INPUT', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([{ text: 'done' }]);
    const session = makeSession(workspace, adapter);
    await session.submit('start');
    expect(session.getState()).toBe('AWAITING_INPUT');
    expect(() => session.steer('change direction')).toThrow('AWAITING_INPUT');
  });

  it('throws if session is CLOSED', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));
    session.close();
    expect(() => session.steer('change direction')).toThrow('CLOSED');
  });
});

describe('AgentSession processInput compatibility', () => {
  it('works the same as submit for single-input', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([{ text: 'Hello!' }]);
    const session = makeSession(workspace, adapter);

    const result = await session.processInput('Say hello');
    expect(result.status).toBe('success');
    expect(result.final_text).toBe('Hello!');
    expect(result.turn_count).toBe(1);
  });
});

describe('AbortError', () => {
  it('is an instance of Error', () => {
    const err = new AbortError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
    expect(err.message).toBe('test');
  });
});
