import { describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../../src/agent-loop/subagent-manager.js';
import type { SubagentManagerDeps } from '../../src/agent-loop/subagent-manager.js';
import type { AgentSession } from '../../src/agent-loop/session.js';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/agent-loop/types.js';

function mockLongRunningSession(): { session: AgentSession; resolve: (v: any) => void } {
  let resolveSubmit: any;
  const submitPromise = new Promise<any>(r => { resolveSubmit = r; });
  const session = {
    getState: () => 'PROCESSING',
    getSessionId: () => 'child-session-id',
    getDepth: () => 1,
    submit: vi.fn().mockReturnValue(submitPromise),
    abort: vi.fn().mockImplementation(() => {
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
  } as unknown as AgentSession;
  return { session, resolve: resolveSubmit };
}

describe('Subagent abort propagation', () => {
  it('cascading abort: closeAll aborts all running children', async () => {
    const sessions = new Map<string, AgentSession>();
    const childSessions: AgentSession[] = [];

    const deps: SubagentManagerDeps = {
      parentSessionId: 'parent-id',
      depth: 0,
      config: { ...DEFAULT_SUBAGENT_CONFIG },
      onEvent: undefined,
      createChildSession: vi.fn().mockImplementation((opts) => {
        const { session } = mockLongRunningSession();
        sessions.set(opts.agentId, session);
        childSessions.push(session);
        return { session, sessionId: `child-${childSessions.length}` };
      }),
    };

    const manager = new SubagentManager(deps);
    manager.spawn('task 1');
    manager.spawn('task 2');

    expect(manager.getActiveCount()).toBe(2);

    await manager.closeAll(sessions);

    for (const session of childSessions) {
      expect(session.abort).toHaveBeenCalled();
    }
  });

  it('no orphaned sessions after closeAll', async () => {
    const sessions = new Map<string, AgentSession>();

    const deps: SubagentManagerDeps = {
      parentSessionId: 'parent-id',
      depth: 0,
      config: { ...DEFAULT_SUBAGENT_CONFIG },
      onEvent: undefined,
      createChildSession: vi.fn().mockImplementation((opts) => {
        const { session } = mockLongRunningSession();
        sessions.set(opts.agentId, session);
        return { session, sessionId: 'child' };
      }),
    };

    const manager = new SubagentManager(deps);
    const h1 = manager.spawn('task 1') as any;
    const h2 = manager.spawn('task 2') as any;

    await manager.closeAll(sessions);

    // All handles should be terminal
    const child1 = manager.getChild(h1.id);
    const child2 = manager.getChild(h2.id);
    expect(child1!.status).toBe('CLOSED');
    expect(child2!.status).toBe('CLOSED');

    expect(manager.getActiveCount()).toBe(0);
  });

  it('timeout aborts child and returns timeout status', async () => {
    const { session } = mockLongRunningSession();
    // Override abort to NOT resolve - simulate slow abort
    (session as any).abort = vi.fn();

    const deps: SubagentManagerDeps = {
      parentSessionId: 'parent-id',
      depth: 0,
      config: { ...DEFAULT_SUBAGENT_CONFIG, child_timeout_ms: 50 },
      onEvent: undefined,
      createChildSession: vi.fn().mockReturnValue({
        session,
        sessionId: 'child-session',
      }),
    };

    const manager = new SubagentManager(deps);
    const handle = manager.spawn('slow task') as any;

    const result = await handle.result_promise;
    expect(result.status).toBe('TIMEOUT');
    expect(result.error).toContain('timed out');
    expect(session.abort).toHaveBeenCalled();
  });
});
