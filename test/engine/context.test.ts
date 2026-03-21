import { describe, expect, it } from 'vitest';
import { ExecutionContext, NoOpContextLock } from '../../src/engine/context.js';

describe('ExecutionContext', () => {
  it('get/set works', () => {
    const ctx = new ExecutionContext();
    ctx.set('key', 'value');
    expect(ctx.get('key')).toBe('value');
  });

  it('setMany sets multiple values', () => {
    const ctx = new ExecutionContext();
    ctx.setMany({ a: '1', b: '2' });
    expect(ctx.get('a')).toBe('1');
    expect(ctx.get('b')).toBe('2');
  });

  it('clone creates independent copy', () => {
    const ctx = new ExecutionContext({ key: 'val' });
    const cloned = ctx.clone();
    cloned.set('key', 'changed');
    expect(ctx.get('key')).toBe('val');
    expect(cloned.get('key')).toBe('changed');
  });

  it('snapshot and restore round-trip', () => {
    const ctx = new ExecutionContext({ a: '1' });
    const snap = ctx.snapshot();
    const ctx2 = new ExecutionContext();
    ctx2.restore(snap);
    expect(ctx2.get('a')).toBe('1');
  });
});

describe('ExecutionContext.appendLog / getLog (A10)', () => {
  it('appendLog adds entries to an immutable log', () => {
    const ctx = new ExecutionContext();
    ctx.appendLog('spawned child-1');
    ctx.appendLog('child-1 completed');
    expect(ctx.getLog()).toEqual(['spawned child-1', 'child-1 completed']);
  });

  it('getLog returns readonly array', () => {
    const ctx = new ExecutionContext();
    ctx.appendLog('entry');
    const log = ctx.getLog();
    expect(log).toHaveLength(1);
    // Should be readonly
    expect(typeof log).toBe('object');
  });

  it('empty context has empty log', () => {
    const ctx = new ExecutionContext();
    expect(ctx.getLog()).toEqual([]);
  });

  it('clone preserves run_log', () => {
    const ctx = new ExecutionContext();
    ctx.appendLog('entry-1');
    ctx.appendLog('entry-2');

    const cloned = ctx.clone();
    expect(cloned.getLog()).toEqual(['entry-1', 'entry-2']);

    // Mutating clone doesn't affect original
    cloned.appendLog('entry-3');
    expect(ctx.getLog()).toHaveLength(2);
    expect(cloned.getLog()).toHaveLength(3);
  });

  it('snapshot/restore preserves run_log', () => {
    const ctx = new ExecutionContext();
    ctx.appendLog('log-a');
    ctx.set('key', 'val');

    const snap = ctx.snapshot();
    const ctx2 = new ExecutionContext();
    ctx2.restore(snap);

    expect(ctx2.getLog()).toEqual(['log-a']);
    expect(ctx2.get('key')).toBe('val');
  });
});

describe('NoOpContextLock (A2)', () => {
  it('implements the ContextLock interface as a no-op', async () => {
    const lock = new NoOpContextLock();
    await lock.acquireRead();
    await lock.acquireWrite();
    await lock.release();
    expect(lock).toBeInstanceOf(NoOpContextLock);
  });
});
