import { describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../../src/agent-loop/subagent-manager.js';
import type { SubagentManagerDeps } from '../../src/agent-loop/subagent-manager.js';
import type { AgentSession } from '../../src/agent-loop/session.js';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/agent-loop/types.js';

function mockSession(overrides?: Record<string, any>): AgentSession {
  return {
    getState: () => overrides?.state ?? 'AWAITING_INPUT',
    getSessionId: () => 'child-session-id',
    getDepth: () => 1,
    submit: vi.fn().mockResolvedValue({
      status: 'success',
      final_text: 'child result',
      usage: { input_tokens: 10, output_tokens: 20 },
      turn_count: 1,
      tool_call_count: 0,
      stop_reason: 'end_turn',
    }),
    abort: vi.fn(),
    close: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn().mockResolvedValue({
      status: 'success',
      final_text: 'follow up result',
      usage: { input_tokens: 5, output_tokens: 10 },
      turn_count: 1,
      tool_call_count: 0,
      stop_reason: 'end_turn',
    }),
    ...overrides,
  } as unknown as AgentSession;
}

function makeDeps(overrides?: Partial<SubagentManagerDeps>): SubagentManagerDeps {
  return {
    parentSessionId: 'parent-session-id',
    depth: 0,
    config: { ...DEFAULT_SUBAGENT_CONFIG },
    onEvent: undefined,
    createChildSession: vi.fn().mockReturnValue({
      session: mockSession(),
      sessionId: 'child-session-id',
    }),
    ...overrides,
  };
}

describe('SubagentManager.sendInput', () => {
  it('returns error for unknown agent_id', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    const session = mockSession();

    const result = await manager.sendInput('nonexistent', 'hello', session);
    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('Unknown agent_id');
  });

  it('returns error for terminal child', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;
    await handle.result_promise;

    const session = mockSession();
    const result = await manager.sendInput(handle.id, 'hello', session);
    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('Cannot send input');
  });

  it('steers a PROCESSING child', async () => {
    const childSession = mockSession({ state: 'PROCESSING' });
    const deps = makeDeps();
    // Use a longer-running child that won't complete immediately
    let resolveChild: any;
    (childSession as any).submit = vi.fn().mockReturnValue(new Promise(r => { resolveChild = r; }));
    (deps.createChildSession as any).mockReturnValue({
      session: childSession,
      sessionId: 'child-session-id',
    });
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;

    const result = await manager.sendInput(handle.id, 'change direction', childSession);
    expect(result).toEqual({ status: 'steered' });
    expect(childSession.steer).toHaveBeenCalledWith('change direction');

    // Cleanup
    resolveChild({
      status: 'success', final_text: '', usage: { input_tokens: 0, output_tokens: 0 },
      turn_count: 1, tool_call_count: 0, stop_reason: 'end_turn',
    });
  });

  it('follows up on an AWAITING_INPUT child', async () => {
    const childSession = mockSession({ state: 'AWAITING_INPUT' });
    let resolveChild: any;
    (childSession as any).submit = vi.fn().mockReturnValue(new Promise(r => { resolveChild = r; }));
    const deps = makeDeps();
    (deps.createChildSession as any).mockReturnValue({
      session: childSession,
      sessionId: 'child-session-id',
    });
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;

    const result = await manager.sendInput(handle.id, 'continue', childSession);
    expect(result).toEqual({ status: 'follow_up_queued' });
    expect(childSession.followUp).toHaveBeenCalledWith('continue');

    resolveChild({
      status: 'success', final_text: '', usage: { input_tokens: 0, output_tokens: 0 },
      turn_count: 1, tool_call_count: 0, stop_reason: 'end_turn',
    });
  });

  it('emits subagent_message event on sendInput', async () => {
    const events: any[] = [];
    const childSession = mockSession({ state: 'PROCESSING' });
    let resolveChild: any;
    (childSession as any).submit = vi.fn().mockReturnValue(new Promise(r => { resolveChild = r; }));
    const deps = makeDeps({
      onEvent: (e) => events.push(e),
      createChildSession: vi.fn().mockReturnValue({
        session: childSession,
        sessionId: 'child-session-id',
      }),
    });
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;

    await manager.sendInput(handle.id, 'steer me', childSession);

    const msgEvent = events.find(e => e.type === 'subagent_message');
    expect(msgEvent).toBeDefined();
    expect(msgEvent.direction).toBe('parent_to_child');
    expect(msgEvent.message_type).toBe('steer');

    resolveChild({
      status: 'success', final_text: '', usage: { input_tokens: 0, output_tokens: 0 },
      turn_count: 1, tool_call_count: 0, stop_reason: 'end_turn',
    });
  });
});

describe('SubagentManager.wait', () => {
  it('returns result for single child', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;

    const results = await manager.wait([handle.id]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('COMPLETED');
    expect(results[0].output).toBe('child result');
  });

  it('returns results for multiple children', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    const h1 = manager.spawn('task 1') as any;
    const h2 = manager.spawn('task 2') as any;

    const results = await manager.wait([h1.id, h2.id]);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('COMPLETED');
    expect(results[1].status).toBe('COMPLETED');
  });

  it('returns error for unknown agent_id', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    const results = await manager.wait(['nonexistent']);
    expect(results).toHaveLength(1);
    expect(results[0].error).toContain('Unknown agent_id');
  });

  it('returns cached result on repeated wait', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;

    const r1 = await manager.wait([handle.id]);
    const r2 = await manager.wait([handle.id]);
    expect(r1).toEqual(r2);
  });

  it('handles mixed success and failure', async () => {
    const failSession = mockSession();
    (failSession as any).submit = vi.fn().mockResolvedValue({
      status: 'failure',
      final_text: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      turn_count: 1,
      tool_call_count: 0,
      stop_reason: 'error',
      error_message: 'something broke',
    });

    let callCount = 0;
    const deps = makeDeps({
      createChildSession: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return { session: failSession, sessionId: 'fail-session' };
        }
        return { session: mockSession(), sessionId: 'ok-session' };
      }),
    });
    const manager = new SubagentManager(deps);

    const h1 = manager.spawn('good task') as any;
    const h2 = manager.spawn('bad task') as any;

    const results = await manager.wait([h1.id, h2.id]);
    expect(results[0].status).toBe('COMPLETED');
    expect(results[1].status).toBe('FAILED');
    expect(results[1].error).toBe('something broke');
  });
});

describe('SubagentManager.wait edge cases', () => {
  it('handles empty array', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);

    const results = await manager.wait([]);
    expect(results).toEqual([]);
  });

  it('handles duplicate IDs', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;

    const results = await manager.wait([handle.id, handle.id]);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('COMPLETED');
    expect(results[1].status).toBe('COMPLETED');
  });

  it('returns immediately for already-completed child', async () => {
    const deps = makeDeps();
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;
    await handle.result_promise;

    const start = Date.now();
    const results = await manager.wait([handle.id]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(results[0].status).toBe('COMPLETED');
  });
});

describe('SubagentManager.sendInput to closed child', () => {
  it('returns error when child is CLOSED', async () => {
    const closedSession = mockSession({ state: 'CLOSED' });
    (closedSession as any).submit = vi.fn().mockResolvedValue({
      status: 'aborted',
      final_text: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      turn_count: 0,
      tool_call_count: 0,
      stop_reason: 'aborted',
      error_message: 'Aborted',
    });
    const deps = makeDeps({
      createChildSession: vi.fn().mockReturnValue({
        session: closedSession,
        sessionId: 'child-session-id',
      }),
    });
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;

    // Wait for completion (status transitions to non-RUNNING)
    await handle.result_promise;

    const result = await manager.sendInput(handle.id, 'hello', closedSession);
    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('Cannot send input');
  });
});

describe('SubagentManager.wait with timeout', () => {
  it('times out and aborts child', async () => {
    const slowSession = mockSession();
    (slowSession as any).submit = vi.fn().mockReturnValue(
      new Promise(resolve => setTimeout(() => resolve({
        status: 'success',
        final_text: 'late',
        usage: { input_tokens: 0, output_tokens: 0 },
        turn_count: 1,
        tool_call_count: 0,
        stop_reason: 'end_turn',
      }), 5000))
    );

    const deps = makeDeps({
      config: { ...DEFAULT_SUBAGENT_CONFIG, child_timeout_ms: 50 },
      createChildSession: vi.fn().mockReturnValue({
        session: slowSession,
        sessionId: 'slow-session',
      }),
    });
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('slow task') as any;

    const results = await manager.wait([handle.id]);
    expect(results[0].status).toBe('TIMEOUT');
    expect(results[0].error).toContain('timed out');
    expect(slowSession.abort).toHaveBeenCalled();
  });
});
