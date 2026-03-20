import { describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../../src/agent-loop/subagent-manager.js';
import type { SubagentManagerDeps } from '../../src/agent-loop/subagent-manager.js';
import type { AgentSession } from '../../src/agent-loop/session.js';
import type { AgentEvent } from '../../src/agent-loop/events.js';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/agent-loop/types.js';
import { TranscriptWriter } from '../../src/agent-loop/transcript.js';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

function mockSession(): AgentSession {
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
  } as unknown as AgentSession;
}

describe('Subagent event lineage metadata', () => {
  it('SubagentSpawned event carries correct lineage', () => {
    const events: AgentEvent[] = [];
    const deps: SubagentManagerDeps = {
      parentSessionId: 'parent-123',
      depth: 0,
      config: { ...DEFAULT_SUBAGENT_CONFIG },
      onEvent: (e) => events.push(e),
      createChildSession: vi.fn().mockReturnValue({
        session: mockSession(),
        sessionId: 'child-456',
      }),
    };
    const manager = new SubagentManager(deps);
    manager.spawn('build feature');

    const spawned = events.find(e => e.type === 'subagent_spawned') as any;
    expect(spawned).toBeDefined();
    expect(spawned.parent_session_id).toBe('parent-123');
    expect(spawned.child_session_id).toBe('child-456');
    expect(spawned.depth).toBe(1);
    expect(spawned.task).toBe('build feature');
    expect(spawned.timestamp).toBeDefined();
  });

  it('SubagentCompleted event carries correct status', async () => {
    const events: AgentEvent[] = [];
    const deps: SubagentManagerDeps = {
      parentSessionId: 'parent-123',
      depth: 0,
      config: { ...DEFAULT_SUBAGENT_CONFIG },
      onEvent: (e) => events.push(e),
      createChildSession: vi.fn().mockReturnValue({
        session: mockSession(),
        sessionId: 'child-456',
      }),
    };
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;
    await handle.result_promise;
    // Flush microtask
    await new Promise(r => setTimeout(r, 10));

    const completed = events.find(e => e.type === 'subagent_completed') as any;
    expect(completed).toBeDefined();
    expect(completed.parent_session_id).toBe('parent-123');
    expect(completed.child_session_id).toBe('child-456');
    expect(completed.status).toBe('success');
    expect(completed.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it('SubagentCompleted marks failure correctly', async () => {
    const failSession = mockSession();
    (failSession as any).submit = vi.fn().mockResolvedValue({
      status: 'failure',
      final_text: '',
      usage: { input_tokens: 5, output_tokens: 5 },
      turn_count: 1,
      tool_call_count: 0,
      stop_reason: 'error',
      error_message: 'oops',
    });

    const events: AgentEvent[] = [];
    const deps: SubagentManagerDeps = {
      parentSessionId: 'parent-123',
      depth: 0,
      config: { ...DEFAULT_SUBAGENT_CONFIG },
      onEvent: (e) => events.push(e),
      createChildSession: vi.fn().mockReturnValue({
        session: failSession,
        sessionId: 'child-456',
      }),
    };
    const manager = new SubagentManager(deps);
    const handle = manager.spawn('task') as any;
    await handle.result_promise;
    await new Promise(r => setTimeout(r, 10));

    const completed = events.find(e => e.type === 'subagent_completed') as any;
    expect(completed.status).toBe('failure');
  });
});

describe('TranscriptWriter nested subagent directories', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates subagent writer under subagents/<id>/', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-transcript-'));
    tempDirs.push(dir);

    const writer = new TranscriptWriter(dir);
    const childWriter = writer.createSubagentWriter('agent-abc');

    await childWriter.writePrompt('child task');
    await childWriter.writeResponse('child result');

    // Check nested directory exists
    const subagentsDir = path.join(dir, 'subagents', 'agent-abc');
    const files = await readdir(subagentsDir);
    expect(files).toContain('prompt.md');
    expect(files).toContain('response.md');
  });
});
