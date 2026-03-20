import { describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../../src/engine/session-registry.js';

// Minimal mock AgentSession
function mockSession(id = 'session-1'): any {
  return {
    _id: id,
    close: vi.fn(),
    submit: vi.fn().mockResolvedValue({ status: 'success', final_text: '' }),
    followUp: vi.fn().mockResolvedValue({ status: 'success', final_text: '' }),
    getState: vi.fn().mockReturnValue('IDLE'),
    getSessionId: vi.fn().mockReturnValue(id),
  };
}

describe('SessionRegistry', () => {
  it('first acquire creates a new session', async () => {
    const registry = new SessionRegistry();
    const session = mockSession();
    const result = await registry.acquire('thread-1', 'anthropic', 'claude-3', () => session);
    expect(result.isNew).toBe(true);
    expect(result.session).toBe(session);
    result.release();
  });

  it('second acquire returns same session', async () => {
    const registry = new SessionRegistry();
    const session = mockSession();
    const first = await registry.acquire('thread-1', 'anthropic', 'claude-3', () => session);
    first.release();
    const result2 = await registry.acquire('thread-1', 'anthropic', 'claude-3', () => mockSession('other'));
    expect(result2.isNew).toBe(false);
    expect(result2.session).toBe(session);
    result2.release();
  });

  it('provider/model mismatch fails fast', async () => {
    const registry = new SessionRegistry();
    const first = await registry.acquire('thread-1', 'anthropic', 'claude-3', () => mockSession());
    first.release();
    await expect(
      registry.acquire('thread-1', 'openai', 'gpt-4', () => mockSession())
    ).rejects.toThrow(/mismatch/);
  });

  it('has() returns true for existing thread', async () => {
    const registry = new SessionRegistry();
    const result = await registry.acquire('thread-1', 'anthropic', 'claude-3', () => mockSession());
    expect(registry.has('thread-1')).toBe(true);
    expect(registry.has('thread-2')).toBe(false);
    result.release();
  });

  it('getKeys() returns all thread keys', async () => {
    const registry = new SessionRegistry();
    const r1 = await registry.acquire('a', 'p', 'm', () => mockSession('1'));
    r1.release();
    const r2 = await registry.acquire('b', 'p', 'm', () => mockSession('2'));
    r2.release();
    expect(registry.getKeys().sort()).toEqual(['a', 'b']);
  });

  it('closeAll disposes all sessions', async () => {
    const registry = new SessionRegistry();
    const s1 = mockSession('1');
    const s2 = mockSession('2');
    const r1 = await registry.acquire('a', 'p', 'm', () => s1);
    r1.release();
    const r2 = await registry.acquire('b', 'p', 'm', () => s2);
    r2.release();
    await registry.closeAll();
    expect(s1.close).toHaveBeenCalled();
    expect(s2.close).toHaveBeenCalled();
    expect(registry.has('a')).toBe(false);
    expect(registry.has('b')).toBe(false);
  });

  it('FIFO lock serializes concurrent acquires', async () => {
    const registry = new SessionRegistry();
    const session = mockSession();
    const first = await registry.acquire('thread-1', 'p', 'm', () => session);

    // Don't release first — second acquire should wait
    let resolved = false;
    const acquirePromise = registry.acquire('thread-1', 'p', 'm', () => mockSession()).then((r) => {
      resolved = true;
      return r;
    });

    // Give a tick — should not be resolved yet
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Release the first lock
    first.release();
    const result = await acquirePromise;
    expect(resolved).toBe(true);
    expect(result.isNew).toBe(false);
    result.release();
  });

  it('FIFO lock timeout prevents deadlocks', async () => {
    const registry = new SessionRegistry(50); // 50ms timeout
    const session = mockSession();
    const first = await registry.acquire('thread-1', 'p', 'm', () => session);

    // Never release first — second acquire should timeout
    await expect(
      registry.acquire('thread-1', 'p', 'm', () => mockSession())
    ).rejects.toThrow(/timeout/i);

    // Clean up
    first.release();
  });
});
