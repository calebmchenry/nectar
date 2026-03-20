import { describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../../src/agent-loop/subagent-manager.js';
import type { SubagentManagerDeps } from '../../src/agent-loop/subagent-manager.js';
import type { AgentSession } from '../../src/agent-loop/session.js';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/agent-loop/types.js';

function mockSession(overrides?: Record<string, any>): AgentSession {
  let resolveSubmit: any;
  const submitPromise = new Promise<any>(r => { resolveSubmit = r; });
  return {
    getState: () => overrides?.state ?? 'PROCESSING',
    getSessionId: () => 'child-session-id',
    getDepth: () => 1,
    submit: vi.fn().mockReturnValue(submitPromise),
    abort: vi.fn().mockImplementation(() => {
      // When aborted, resolve the submit promise as aborted
      resolveSubmit({
        status: 'aborted',
        final_text: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        turn_count: 0,
        tool_call_count: 0,
        stop_reason: 'aborted',
        error_message: 'Session aborted',
      });
    }),
    close: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    _resolveSubmit: resolveSubmit,
    ...overrides,
  } as unknown as AgentSession;
}

function makeDeps(childSession?: AgentSession): { deps: SubagentManagerDeps; childSession: AgentSession } {
  const session = childSession ?? mockSession();
  return {
    deps: {
      parentSessionId: 'parent-session-id',
      depth: 0,
      config: { ...DEFAULT_SUBAGENT_CONFIG },
      onEvent: undefined,
      createChildSession: vi.fn().mockReturnValue({
        session,
        sessionId: 'child-session-id',
      }),
    },
    childSession: session,
  };
}

describe('SubagentManager.close', () => {
  it('aborts a running child', async () => {
    const { deps, childSession } = makeDeps();
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;

    const result = await manager.close(handle.id, childSession);
    expect(result.status).toBe('closed');
    expect(childSession.abort).toHaveBeenCalled();
  });

  it('is idempotent for already-closed child', async () => {
    const completedSession = mockSession();
    (completedSession as any).submit = vi.fn().mockResolvedValue({
      status: 'success',
      final_text: 'done',
      usage: { input_tokens: 10, output_tokens: 20 },
      turn_count: 1,
      tool_call_count: 0,
      stop_reason: 'end_turn',
    });
    const { deps } = makeDeps(completedSession);
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;
    await handle.result_promise;

    // Close after completion — should be idempotent
    const result = await manager.close(handle.id, completedSession);
    expect(result.status).toBe('COMPLETED');
  });

  it('returns not_found for unknown agent_id', async () => {
    const { deps, childSession } = makeDeps();
    const manager = new SubagentManager(deps);

    const result = await manager.close('nonexistent', childSession);
    expect(result.status).toBe('not_found');
  });
});

describe('SubagentManager.closeAll', () => {
  it('aborts all running children', async () => {
    const sessions = new Map<string, AgentSession>();
    let callCount = 0;

    const deps: SubagentManagerDeps = {
      parentSessionId: 'parent-session-id',
      depth: 0,
      config: { ...DEFAULT_SUBAGENT_CONFIG },
      onEvent: undefined,
      createChildSession: vi.fn().mockImplementation((opts) => {
        const session = mockSession();
        sessions.set(opts.agentId, session);
        return { session, sessionId: `child-${callCount++}` };
      }),
    };

    const manager = new SubagentManager(deps);
    manager.spawn('task 1') as any;
    manager.spawn('task 2') as any;

    await manager.closeAll(sessions);

    // Both children should have been aborted
    for (const session of sessions.values()) {
      expect(session.abort).toHaveBeenCalled();
    }
  });

  it('does not abort already-completed children', async () => {
    const completedSession = mockSession();
    (completedSession as any).submit = vi.fn().mockResolvedValue({
      status: 'success',
      final_text: 'done',
      usage: { input_tokens: 10, output_tokens: 20 },
      turn_count: 1,
      tool_call_count: 0,
      stop_reason: 'end_turn',
    });

    const sessions = new Map<string, AgentSession>();
    const deps: SubagentManagerDeps = {
      parentSessionId: 'parent-session-id',
      depth: 0,
      config: { ...DEFAULT_SUBAGENT_CONFIG },
      onEvent: undefined,
      createChildSession: vi.fn().mockImplementation((opts) => {
        sessions.set(opts.agentId, completedSession);
        return { session: completedSession, sessionId: 'child-session' };
      }),
    };

    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;
    await handle.result_promise;

    // Reset abort mock after initial run
    (completedSession.abort as any).mockClear();

    await manager.closeAll(sessions);

    // Should not abort already-completed child
    expect(completedSession.abort).not.toHaveBeenCalled();
  });
});
