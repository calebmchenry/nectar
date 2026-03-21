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
import type { GenerateRequest, GenerateResponse } from '../../src/llm/types.js';
import type { StreamEvent } from '../../src/llm/streaming.js';
import { AuthenticationError } from '../../src/llm/errors.js';

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
    const adapter = new ScriptedAdapter([{ text: 'done' }]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const events: AgentEvent[] = [];
    const session = new AgentSession(
      client,
      makeRegistry(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
      { onEvent: (event) => events.push(event) }
    );
    await session.submit('hello');
    session.close();
    session.close();
    expect(session.getState()).toBe('CLOSED');
    const ended = events.filter((event) => event.type === 'agent_session_ended');
    expect(ended).toHaveLength(1);
    if (ended[0]?.type === 'agent_session_ended') {
      expect(ended[0].reason).toBe('closed');
    }
  });

  it('rejects submit on CLOSED session', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));
    session.close();
    await expect(session.submit('hello')).rejects.toThrow('CLOSED');
  });

  it('abort() transitions to CLOSED and returns aborted result', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([{ text: 'done' }]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const events: AgentEvent[] = [];
    const session = new AgentSession(
      client,
      makeRegistry(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
      { onEvent: (event) => events.push(event) }
    );
    session.abort();
    session.abort();
    expect(session.getState()).toBe('CLOSED');

    const result = await session.processInput('hello');
    expect(result.status).toBe('aborted');
    const ended = events.filter((event) => event.type === 'agent_session_ended');
    expect(ended).toHaveLength(1);
    if (ended[0]?.type === 'agent_session_ended') {
      expect(ended[0].reason).toBe('aborted');
    }
  });

  it('transitions to CLOSED on authentication/access errors', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];
    const adapter: ProviderAdapter = {
      provider_name: 'auth-fail',
      async generate(): Promise<GenerateResponse> {
        throw new AuthenticationError('auth-fail', 'invalid key');
      },
      async *stream(): AsyncIterable<StreamEvent> {
        throw new AuthenticationError('auth-fail', 'invalid key');
      },
    };

    const session = new AgentSession(
      new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]])),
      makeRegistry(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
      { onEvent: (event) => events.push(event) },
    );

    const result = await session.submit('hello');
    expect(result.status).toBe('failure');
    expect(session.getState()).toBe('CLOSED');
    expect(events.some((event) => event.type === 'agent_session_ended')).toBe(true);
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
  it('queues in IDLE and injects on next submit as user-role message', async () => {
    const workspace = await createWorkspace();
    const captured: GenerateRequest[] = [];
    const adapter: ProviderAdapter = {
      provider_name: 'capture-steer',
      async generate(): Promise<GenerateResponse> {
        return {
          message: { role: 'assistant', content: 'done' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'capture-steer',
          provider: 'capture-steer',
        };
      },
      async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
        captured.push(request);
        yield { type: 'stream_start', model: 'capture-steer' };
        yield { type: 'content_delta', text: 'done' };
        yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'done' } };
      },
    };
    const session = new AgentSession(
      new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]])),
      makeRegistry(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
    );

    expect(() => session.steer('change direction')).not.toThrow();
    await session.submit('start');

    const firstCall = captured[0];
    expect(firstCall).toBeDefined();
    const steerMessage = firstCall?.messages.find((message) => {
      if (message.role !== 'user') {
        return false;
      }
      const content = Array.isArray(message.content)
        ? message.content.map((part) => ('text' in part ? String(part.text ?? '') : '')).join('\n')
        : String(message.content);
      return content.includes('change direction');
    });
    expect(steerMessage).toBeDefined();
  });

  it('queues in AWAITING_INPUT and delivers on subsequent submit', async () => {
    const workspace = await createWorkspace();
    const captured: GenerateRequest[] = [];
    const adapter: ProviderAdapter = {
      provider_name: 'capture-steer',
      async generate(): Promise<GenerateResponse> {
        return {
          message: { role: 'assistant', content: 'done' },
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
          model: 'capture-steer',
          provider: 'capture-steer',
        };
      },
      async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
        captured.push(request);
        yield { type: 'stream_start', model: 'capture-steer' };
        yield { type: 'content_delta', text: 'done' };
        yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'stream_end', stop_reason: 'end_turn', message: { role: 'assistant', content: 'done' } };
      },
    };
    const session = new AgentSession(
      new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]])),
      makeRegistry(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
    );
    await session.submit('start');
    session.steer('change direction');
    await session.submit('continue');

    const secondCall = captured[1];
    expect(secondCall).toBeDefined();
    const steerMessage = secondCall?.messages.find((message) => {
      if (message.role !== 'user') {
        return false;
      }
      const content = Array.isArray(message.content)
        ? message.content.map((part) => ('text' in part ? String(part.text ?? '') : '')).join('\n')
        : String(message.content);
      return content.includes('change direction');
    });
    expect(steerMessage).toBeDefined();
  });

  it('does not throw in CLOSED state', async () => {
    const workspace = await createWorkspace();
    const session = makeSession(workspace, new ScriptedAdapter([{ text: 'done' }]));
    session.close();
    expect(() => session.steer('change direction')).not.toThrow();
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
