import { describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../../src/agent-loop/subagent-manager.js';
import type { SubagentManagerDeps } from '../../src/agent-loop/subagent-manager.js';
import type { AgentSession } from '../../src/agent-loop/session.js';
import type { SubagentConfig } from '../../src/agent-loop/types.js';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/agent-loop/types.js';

function mockSession(overrides?: Partial<AgentSession>): AgentSession {
  return {
    getState: () => 'IDLE',
    getSessionId: () => 'child-session-id',
    getDepth: () => 1,
    submit: vi.fn().mockResolvedValue({
      status: 'success',
      final_text: 'done',
      usage: { input_tokens: 10, output_tokens: 20 },
      turn_count: 1,
      tool_call_count: 0,
      stop_reason: 'end_turn',
    }),
    abort: vi.fn(),
    close: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    ...overrides,
  } as unknown as AgentSession;
}

function makeDeps(overrides?: Partial<SubagentManagerDeps>): SubagentManagerDeps {
  const session = mockSession();
  return {
    parentSessionId: 'parent-session-id',
    depth: 0,
    config: { ...DEFAULT_SUBAGENT_CONFIG },
    onEvent: undefined,
    createChildSession: vi.fn().mockReturnValue({
      session,
      sessionId: 'child-session-id',
    }),
    ...overrides,
  };
}

describe('SubagentManager', () => {
  it('spawn creates a child with correct depth', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    const result = manager.spawn('do something');

    // Should have called createChildSession with depth + 1
    expect(deps.createChildSession).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 1, task: 'do something' })
    );

    // Should return a handle (has result_promise)
    expect(result).toHaveProperty('result_promise');
    expect(result).toHaveProperty('id');
    expect((result as any).status).toBe('RUNNING');
  });

  it('spawn returns unique agent_ids for multiple spawns', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    const r1 = manager.spawn('task 1') as any;
    const r2 = manager.spawn('task 2') as any;

    expect(r1.id).toBeDefined();
    expect(r2.id).toBeDefined();
    expect(r1.id).not.toBe(r2.id);
  });

  it('enforces depth limit', () => {
    const deps = makeDeps({
      depth: 1,
      config: { ...DEFAULT_SUBAGENT_CONFIG, max_subagent_depth: 1 },
    });
    const manager = new SubagentManager(deps);

    const result = manager.spawn('deep task');

    // Should return error (no result_promise)
    expect(result).not.toHaveProperty('result_promise');
    expect((result as any).error).toContain('Maximum subagent depth');
    expect(deps.createChildSession).not.toHaveBeenCalled();
  });

  it('enforces concurrency limit', () => {
    const deps = makeDeps({
      config: { ...DEFAULT_SUBAGENT_CONFIG, max_concurrent_children: 2 },
    });
    const manager = new SubagentManager(deps);

    manager.spawn('task 1');
    manager.spawn('task 2');
    const result = manager.spawn('task 3');

    // Third spawn should fail
    expect(result).not.toHaveProperty('result_promise');
    expect((result as any).error).toContain('Maximum concurrent children');
  });

  it('completed children free concurrency slots', async () => {
    const deps = makeDeps({
      config: { ...DEFAULT_SUBAGENT_CONFIG, max_concurrent_children: 1 },
    });
    const manager = new SubagentManager(deps);

    const handle1 = manager.spawn('task 1') as any;
    // Wait for child to complete
    await handle1.result_promise;

    // Now should be able to spawn another
    const handle2 = manager.spawn('task 2');
    expect(handle2).toHaveProperty('result_promise');
  });

  it('getChild returns handle for valid id', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;

    expect(manager.getChild(handle.id)).toBe(handle);
  });

  it('getChild returns undefined for unknown id', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    expect(manager.getChild('nonexistent')).toBeUndefined();
  });

  it('hasChildren returns false when empty', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    expect(manager.hasChildren()).toBe(false);
  });

  it('hasChildren returns true after spawn', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    manager.spawn('task');
    expect(manager.hasChildren()).toBe(true);
  });

  it('getActiveCount tracks running children', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    expect(manager.getActiveCount()).toBe(0);
    const h = manager.spawn('task') as any;
    expect(manager.getActiveCount()).toBe(1);

    await h.result_promise;
    expect(manager.getActiveCount()).toBe(0);
  });

  it('child inherits parent config defaults', () => {
    const config: SubagentConfig = {
      ...DEFAULT_SUBAGENT_CONFIG,
      child_max_tool_rounds: 15,
      child_max_turns: 3,
    };
    const deps = makeDeps({ config });
    const manager = new SubagentManager(deps);

    manager.spawn('task');

    expect(deps.createChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        maxToolRounds: 15,
        maxTurns: 3,
      })
    );
  });

  it('spawn allows overriding child defaults', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    manager.spawn('task', {
      max_tool_rounds: 5,
      max_turns: 2,
    });

    expect(deps.createChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        maxToolRounds: 5,
        maxTurns: 2,
      })
    );
  });

  it('spawn_agent max_turns=0 passes explicit unlimited to child', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    manager.spawn('task', { max_turns: 0 });

    expect(deps.createChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 0,
      }),
    );
  });

  it('omitting max_turns keeps finite child_max_turns default', () => {
    const deps = makeDeps({
      config: { ...DEFAULT_SUBAGENT_CONFIG, child_max_turns: 4 },
    });
    const manager = new SubagentManager(deps);

    manager.spawn('task');

    expect(deps.createChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 4,
      }),
    );
  });

  it('spawn passes working_dir to createChildSession', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    manager.spawn('task', { working_dir: 'packages/cli' });

    expect(deps.createChildSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: 'packages/cli' })
    );
  });

  it('spawn passes model override to createChildSession and handle', () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    const handle = manager.spawn('task', { model: 'gemini-2.5-flash' }) as any;

    expect(deps.createChildSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.5-flash' })
    );
    expect(handle.model).toBe('gemini-2.5-flash');
  });

  it('emits subagent_spawned event', () => {
    const events: any[] = [];
    const deps = makeDeps({
      onEvent: (e) => events.push(e),
    });
    const manager = new SubagentManager(deps);

    manager.spawn('task');

    const spawnEvent = events.find(e => e.type === 'subagent_spawned');
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent.parent_session_id).toBe('parent-session-id');
    expect(spawnEvent.child_session_id).toBe('child-session-id');
    expect(spawnEvent.depth).toBe(1);
    expect(spawnEvent.task).toBe('task');
  });

  it('emits subagent_completed event on child completion', async () => {
    const events: any[] = [];
    const deps = makeDeps({
      onEvent: (e) => events.push(e),
    });
    const manager = new SubagentManager(deps);

    const handle = manager.spawn('task') as any;
    await handle.result_promise;

    // Allow microtask to flush
    await new Promise(r => setTimeout(r, 10));

    const completeEvent = events.find(e => e.type === 'subagent_completed');
    expect(completeEvent).toBeDefined();
    expect(completeEvent.status).toBe('success');
  });

  it('preserves long child output up to spawn_agent limit', async () => {
    const longOutput = 'x'.repeat(15_000);
    const session = mockSession({
      submit: vi.fn().mockResolvedValue({
        status: 'success',
        final_text: longOutput,
        usage: { input_tokens: 1, output_tokens: 1 },
        turn_count: 1,
        tool_call_count: 0,
        stop_reason: 'end_turn',
      }),
    });
    const deps = makeDeps({
      createChildSession: vi.fn().mockReturnValue({
        session,
        sessionId: 'child-session-id',
      }),
    });
    const manager = new SubagentManager(deps);

    const handle = manager.spawn('task') as any;
    const result = await handle.result_promise;

    expect(result.status).toBe('COMPLETED');
    expect(result.output.length).toBe(15_000);
    expect(result.output).toBe(longOutput);
  });
});
