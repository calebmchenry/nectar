import { describe, expect, it } from 'vitest';
import { executeToolsBatch } from '../../src/llm/tools.js';
import type { ToolCallEnvelope, ToolResultEnvelope } from '../../src/agent-loop/types.js';

function call(id: string, name: string): ToolCallEnvelope {
  return { name, arguments: {}, call_id: id };
}

function okResult(callId: string, content = 'ok'): ToolResultEnvelope {
  return { call_id: callId, content, is_error: false };
}

async function delayExecutor(envelope: ToolCallEnvelope): Promise<ToolResultEnvelope> {
  await new Promise((r) => setTimeout(r, 10));
  return okResult(envelope.call_id, `result-${envelope.call_id}`);
}

describe('executeToolsBatch', () => {
  it('returns empty array for zero calls', async () => {
    const results = await executeToolsBatch([], delayExecutor);
    expect(results).toEqual([]);
  });

  it('executes single call directly', async () => {
    const results = await executeToolsBatch(
      [call('c1', 'read_file')],
      delayExecutor,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.call_id).toBe('c1');
  });

  it('runs consecutive read-only calls concurrently', async () => {
    const order: string[] = [];
    const executor = async (env: ToolCallEnvelope): Promise<ToolResultEnvelope> => {
      order.push(`start-${env.call_id}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end-${env.call_id}`);
      return okResult(env.call_id);
    };

    const results = await executeToolsBatch(
      [call('c1', 'read_file'), call('c2', 'grep'), call('c3', 'glob')],
      executor,
    );

    expect(results).toHaveLength(3);
    // All should have started before any finished (concurrent)
    expect(order.indexOf('start-c1')).toBeLessThan(order.indexOf('end-c1'));
    expect(order.indexOf('start-c2')).toBeLessThan(order.indexOf('end-c2'));
    // Results are in original call order
    expect(results[0]!.call_id).toBe('c1');
    expect(results[1]!.call_id).toBe('c2');
    expect(results[2]!.call_id).toBe('c3');
  });

  it('mutating calls act as sequential fences', async () => {
    const order: string[] = [];
    const executor = async (env: ToolCallEnvelope): Promise<ToolResultEnvelope> => {
      order.push(`start-${env.call_id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end-${env.call_id}`);
      return okResult(env.call_id);
    };

    // [read, write, read] -- write is a fence
    const results = await executeToolsBatch(
      [call('c1', 'read_file'), call('c2', 'write_file'), call('c3', 'read_file')],
      executor,
    );

    expect(results).toHaveLength(3);
    // write must start after read finishes
    expect(order.indexOf('end-c1')).toBeLessThan(order.indexOf('start-c2'));
    // second read must start after write finishes
    expect(order.indexOf('end-c2')).toBeLessThan(order.indexOf('start-c3'));
  });

  it('interleaved [read, write, read] — second read does NOT race with write', async () => {
    const timestamps: Record<string, { start: number; end: number }> = {};
    const executor = async (env: ToolCallEnvelope): Promise<ToolResultEnvelope> => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 15));
      timestamps[env.call_id] = { start, end: Date.now() };
      return okResult(env.call_id);
    };

    await executeToolsBatch(
      [call('r1', 'read_file'), call('w1', 'write_file'), call('r2', 'read_file')],
      executor,
    );

    // write started after first read ended
    expect(timestamps['w1']!.start).toBeGreaterThanOrEqual(timestamps['r1']!.end - 2);
    // second read started after write ended
    expect(timestamps['r2']!.start).toBeGreaterThanOrEqual(timestamps['w1']!.end - 2);
  });

  it('respects maxParallel semaphore', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const executor = async (env: ToolCallEnvelope): Promise<ToolResultEnvelope> => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return okResult(env.call_id);
    };

    // 5 read-only calls with max 2 parallel
    const calls = Array.from({ length: 5 }, (_, i) => call(`c${i}`, 'read_file'));
    await executeToolsBatch(calls, executor, 2);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('one tool failure does not prevent others from completing', async () => {
    const executor = async (env: ToolCallEnvelope): Promise<ToolResultEnvelope> => {
      if (env.call_id === 'fail') {
        throw new Error('Tool exploded');
      }
      return okResult(env.call_id);
    };

    const results = await executeToolsBatch(
      [call('ok1', 'read_file'), call('fail', 'read_file'), call('ok2', 'read_file')],
      executor,
    );

    expect(results[0]!.is_error).toBe(false);
    expect(results[1]!.is_error).toBe(true);
    expect(results[1]!.content).toContain('Tool exploded');
    expect(results[2]!.is_error).toBe(false);
  });

  it('results are in original call order regardless of completion order', async () => {
    const executor = async (env: ToolCallEnvelope): Promise<ToolResultEnvelope> => {
      // c3 finishes fastest, c1 slowest
      const delays: Record<string, number> = { c1: 30, c2: 20, c3: 10 };
      await new Promise((r) => setTimeout(r, delays[env.call_id] ?? 10));
      return okResult(env.call_id, `result-${env.call_id}`);
    };

    const results = await executeToolsBatch(
      [call('c1', 'read_file'), call('c2', 'glob'), call('c3', 'grep')],
      executor,
    );

    expect(results[0]!.call_id).toBe('c1');
    expect(results[1]!.call_id).toBe('c2');
    expect(results[2]!.call_id).toBe('c3');
  });

  it('abort signal fills remaining with abort results', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const results = await executeToolsBatch(
      [call('c1', 'read_file'), call('c2', 'read_file')],
      delayExecutor,
      8,
      abortController.signal,
    );

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain('aborted');
    expect(results[1]!.is_error).toBe(true);
  });

  it('single mutating call goes through fast path', async () => {
    const results = await executeToolsBatch(
      [call('c1', 'write_file')],
      delayExecutor,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.call_id).toBe('c1');
  });

  it('consecutive mutating calls run sequentially', async () => {
    const order: string[] = [];
    const executor = async (env: ToolCallEnvelope): Promise<ToolResultEnvelope> => {
      order.push(`start-${env.call_id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end-${env.call_id}`);
      return okResult(env.call_id);
    };

    await executeToolsBatch(
      [call('w1', 'write_file'), call('w2', 'edit_file'), call('w3', 'shell')],
      executor,
    );

    // Each must complete before next starts
    expect(order.indexOf('end-w1')).toBeLessThan(order.indexOf('start-w2'));
    expect(order.indexOf('end-w2')).toBeLessThan(order.indexOf('start-w3'));
  });

  it('mixed batch: read group, mutating fence, read group', async () => {
    const order: string[] = [];
    const executor = async (env: ToolCallEnvelope): Promise<ToolResultEnvelope> => {
      order.push(`start-${env.call_id}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end-${env.call_id}`);
      return okResult(env.call_id);
    };

    await executeToolsBatch(
      [
        call('r1', 'read_file'), call('r2', 'grep'),
        call('w1', 'write_file'),
        call('r3', 'read_file'), call('r4', 'glob'),
      ],
      executor,
    );

    // r1 and r2 run concurrently (both start before either ends)
    expect(order.indexOf('start-r2')).toBeLessThan(order.indexOf('end-r1'));
    // w1 starts after both reads finish
    expect(order.indexOf('start-w1')).toBeGreaterThan(order.indexOf('end-r1'));
    expect(order.indexOf('start-w1')).toBeGreaterThan(order.indexOf('end-r2'));
    // r3 and r4 start after w1 finishes
    expect(order.indexOf('start-r3')).toBeGreaterThan(order.indexOf('end-w1'));
    expect(order.indexOf('start-r4')).toBeGreaterThan(order.indexOf('end-w1'));
  });
});
