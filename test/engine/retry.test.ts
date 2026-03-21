import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext } from '../../src/engine/context.js';
import { PipelineEngine, executeNodeSequence, resolveFailureTarget } from '../../src/engine/engine.js';
import { computeBackoff, getRetryPreset, RETRY_PRESETS, shouldRetry } from '../../src/engine/retry.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { NodeOutcome } from '../../src/engine/types.js';
import { hashDotSource, parseGardenFile, parseGardenSource } from '../../src/garden/parse.js';
import { HandlerRegistry } from '../../src/handlers/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

function retryDelays(events: RunEvent[]): number[] {
  return events
    .filter((event): event is Extract<RunEvent, { type: 'node_retrying' }> => event.type === 'node_retrying')
    .map((event) => event.delay_ms);
}

async function executeWithToolStatuses(dotSource: string, statuses: Array<'retry' | 'failure' | 'success'>): Promise<{
  events: RunEvent[];
  toolAttempts: number;
}> {
  const graph = parseGardenSource(dotSource, '/tmp/retry-test.dot');
  const handlers = new HandlerRegistry();
  let toolAttempts = 0;
  handlers.register('tool', {
    async execute() {
      const index = Math.min(toolAttempts, statuses.length - 1);
      const status = statuses[index] ?? 'success';
      toolAttempts += 1;
      return { status };
    },
  });

  const events: RunEvent[] = [];
  const runPromise = executeNodeSequence({
    graph,
    context: new ExecutionContext(),
    handlers,
    startNodeId: 'start',
    terminationNodeIds: new Set(),
    runId: 'retry-test-run',
    dotFile: '/tmp/retry-test.dot',
    runDir: '/tmp',
    onEvent: (event) => events.push(event),
    defaultMaxRetries: graph.defaultMaxRetries,
  });

  await vi.runAllTimersAsync();
  await runPromise;
  return { events, toolAttempts };
}

async function executeWithToolOutcomes(dotSource: string, outcomes: NodeOutcome[]): Promise<{
  events: RunEvent[];
  toolAttempts: number;
}> {
  const graph = parseGardenSource(dotSource, '/tmp/retry-test.dot');
  const handlers = new HandlerRegistry();
  let toolAttempts = 0;
  handlers.register('tool', {
    async execute() {
      const index = Math.min(toolAttempts, outcomes.length - 1);
      const outcome = outcomes[index] ?? { status: 'success' };
      toolAttempts += 1;
      return { ...outcome };
    },
  });

  const events: RunEvent[] = [];
  const runPromise = executeNodeSequence({
    graph,
    context: new ExecutionContext(),
    handlers,
    startNodeId: 'start',
    terminationNodeIds: new Set(),
    runId: 'retry-test-run',
    dotFile: '/tmp/retry-test.dot',
    runDir: '/tmp',
    onEvent: (event) => events.push(event),
    defaultMaxRetries: graph.defaultMaxRetries,
  });

  await vi.runAllTimersAsync();
  await runPromise;
  return { events, toolAttempts };
}

async function createWorkspace(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('engine retry presets', () => {
  it('computes first 3 delays for each preset', () => {
    const expected: Record<string, [number, number, number]> = {
      none: [0, 0, 0],
      standard: [200, 400, 800],
      aggressive: [500, 1000, 2000],
      linear: [500, 500, 500],
      patient: [2000, 6000, 18000],
    };

    for (const [name, delays] of Object.entries(expected)) {
      const preset = getRetryPreset(name);
      expect(preset).toBeDefined();
      expect(computeBackoff(1, preset!, false)).toBeCloseTo(delays[0]!);
      expect(computeBackoff(2, preset!, false)).toBeCloseTo(delays[1]!);
      expect(computeBackoff(3, preset!, false)).toBeCloseTo(delays[2]!);
    }
  });

  it('linear strategy uses constant delay', () => {
    const linear = getRetryPreset('linear');
    expect(linear).toBeDefined();
    expect(computeBackoff(1, linear!, false)).toBe(500);
    expect(computeBackoff(2, linear!, false)).toBe(500);
    expect(computeBackoff(5, linear!, false)).toBe(500);
  });

  it('applies jitter in [0.5, 1.5] and can produce different retry delays', () => {
    const aggressive = getRetryPreset('aggressive');
    expect(aggressive).toBeDefined();

    const randomSpy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0) // jitter factor = 0.5
      .mockReturnValueOnce(1); // jitter factor = 1.5
    try {
      const first = computeBackoff(1, aggressive!, true);
      const second = computeBackoff(1, aggressive!, true);
      expect(first).toBe(250);
      expect(second).toBe(750);
      expect(first).not.toBe(second);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('matches sprint-027 preset values', () => {
    expect(RETRY_PRESETS.aggressive.initial_delay_ms).toBe(500);
    expect(RETRY_PRESETS.aggressive.multiplier).toBe(2.0);
    expect(RETRY_PRESETS.linear.max_retries).toBe(3);
    expect(RETRY_PRESETS.linear.initial_delay_ms).toBe(500);
    expect(RETRY_PRESETS.patient.max_retries).toBe(3);
  });

  it('node max_retries overrides preset max_retries', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      const dot = `digraph RetryNodeOverride {
        graph [default_retry_policy="patient"]
        start [shape=Mdiamond]
        unstable [shape=parallelogram, script="echo unstable", retry_policy="aggressive", max_retries="2"]
        done [shape=Msquare]
        start -> unstable
        unstable -> done
      }`;

      const { events, toolAttempts } = await executeWithToolStatuses(dot, ['retry', 'retry', 'success']);
      const retryEvents = events.filter((event): event is Extract<RunEvent, { type: 'node_retrying' }> => event.type === 'node_retrying');

      expect(toolAttempts).toBe(3);
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents.every((event) => event.max_retries === 2)).toBe(true);
      expect(retryDelays(events)).toEqual([750, 1500]);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('inherits graph-level default_retry_policy for nodes without explicit policy', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      const dot = `digraph RetryGraphDefault {
        graph [default_retry_policy="aggressive"]
        start [shape=Mdiamond]
        unstable [shape=parallelogram, script="echo unstable"]
        done [shape=Msquare]
        start -> unstable
        unstable -> done
      }`;

      const { events } = await executeWithToolStatuses(dot, ['retry', 'success']);
      const retryEvents = events.filter((event): event is Extract<RunEvent, { type: 'node_retrying' }> => event.type === 'node_retrying');

      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0]?.max_retries).toBe(5);
      expect(retryEvents[0]?.delay_ms).toBe(750);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('integration fixture retry_policy="patient" emits patient backoff delays', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'retry-presets.dot'));
      const handlers = new HandlerRegistry();
      let attempts = 0;
      handlers.register('tool', {
        async execute() {
          attempts += 1;
          return { status: attempts <= 2 ? 'retry' : 'success' };
        },
      });

      const events: RunEvent[] = [];
      const runPromise = executeNodeSequence({
        graph,
        context: new ExecutionContext(),
        handlers,
        startNodeId: 'start',
        terminationNodeIds: new Set(),
        runId: 'retry-patient-fixture',
        dotFile: graph.dotPath,
        runDir: '/tmp',
        onEvent: (event) => events.push(event),
        defaultMaxRetries: graph.defaultMaxRetries,
      });

      await vi.runAllTimersAsync();
      await runPromise;

      const retryEvents = events.filter((event): event is Extract<RunEvent, { type: 'node_retrying' }> => event.type === 'node_retrying');
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0]?.max_retries).toBe(3);
      expect(retryDelays(events)).toEqual([3000, 9000]);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retries failure outcomes when retry budget remains', async () => {
    vi.useFakeTimers();
    try {
      const dot = `digraph RetryFailure {
        start [shape=Mdiamond]
        unstable [shape=parallelogram, script="echo unstable", max_retries="2"]
        done [shape=Msquare]
        start -> unstable
        unstable -> done
      }`;

      const { events, toolAttempts } = await executeWithToolStatuses(dot, ['failure', 'failure', 'success']);
      const retryEvents = events.filter((event): event is Extract<RunEvent, { type: 'node_retrying' }> => event.type === 'node_retrying');
      expect(toolAttempts).toBe(3);
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents.every((event) => event.max_retries === 2)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry failure outcomes when max_retries=0', async () => {
    vi.useFakeTimers();
    try {
      const dot = `digraph RetryFailureZero {
        start [shape=Mdiamond]
        unstable [shape=parallelogram, script="echo unstable", max_retries="0"]
        done [shape=Msquare]
        start -> unstable
        unstable -> done
      }`;

      const { events, toolAttempts } = await executeWithToolStatuses(dot, ['failure', 'success']);
      const retryEvents = events.filter((event): event is Extract<RunEvent, { type: 'node_retrying' }> => event.type === 'node_retrying');
      expect(toolAttempts).toBe(1);
      expect(retryEvents).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry non-retryable classified failures (400/401/403)', () => {
    expect(shouldRetry({ status: 'failure', error_category: 'http_400' })).toBe(false);
    expect(shouldRetry({ status: 'failure', error_category: 'http_401' })).toBe(false);
    expect(shouldRetry({ status: 'failure', error_category: 'http_403' })).toBe(false);
  });

  it('retries retryable classified failures (429/5xx/network)', () => {
    expect(shouldRetry({ status: 'failure', error_category: 'http_429' })).toBe(true);
    expect(shouldRetry({ status: 'failure', error_category: 'http_5xx' })).toBe(true);
    expect(shouldRetry({ status: 'failure', error_category: 'network' })).toBe(true);
  });

  it('defaults unclassified failures to retryable for backwards compatibility', () => {
    expect(shouldRetry({ status: 'failure' })).toBe(true);
  });

  it('engine skips retries for non-retryable 401/403/400 classified failures', async () => {
    vi.useFakeTimers();
    try {
      const dot = `digraph NoRetryAuth {
        start [shape=Mdiamond]
        auth [shape=parallelogram, script="echo auth", max_retries="3"]
        done [shape=Msquare]
        start -> auth -> done
      }`;

      const { events, toolAttempts } = await executeWithToolOutcomes(dot, [
        { status: 'failure', error_category: 'http_401', error_message: '401 unauthorized' },
        { status: 'success' },
      ]);
      const retryEvents = events.filter((event): event is Extract<RunEvent, { type: 'node_retrying' }> => event.type === 'node_retrying');
      expect(toolAttempts).toBe(1);
      expect(retryEvents).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('engine retries on retryable 429/5xx/network classified failures', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      const dot = `digraph RetryRateLimit {
        start [shape=Mdiamond]
        llm [shape=parallelogram, script="echo llm", max_retries="3"]
        done [shape=Msquare]
        start -> llm -> done
      }`;

      const { events, toolAttempts } = await executeWithToolOutcomes(dot, [
        { status: 'failure', error_category: 'http_429', error_message: '429 rate limit' },
        { status: 'failure', error_category: 'network', error_message: 'network timeout' },
        { status: 'success' },
      ]);
      const retryEvents = events.filter((event): event is Extract<RunEvent, { type: 'node_retrying' }> => event.type === 'node_retrying');
      expect(toolAttempts).toBe(3);
      expect(retryEvents).toHaveLength(2);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not retry shell failures for exit codes 1, 137, and 143', () => {
    expect(shouldRetry({ status: 'failure', exit_code: 1 })).toBe(false);
    expect(shouldRetry({ status: 'failure', exit_code: 137 })).toBe(false);
    expect(shouldRetry({ status: 'failure', exit_code: 143 })).toBe(false);
  });

  it('retries shell failures for timeout and other non-zero exit codes', () => {
    expect(shouldRetry({ status: 'failure', timed_out: true })).toBe(true);
    expect(shouldRetry({ status: 'failure', exit_code: 2 })).toBe(true);
  });

  it('resolveFailureTarget picks matching failure-condition edge first', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      a [shape=parallelogram, retry_target="fallbackNode"]
      b [shape=parallelogram]
      fallbackNode [shape=parallelogram]
      done [shape=Msquare]
      start -> a
      a -> b [condition="outcome=fail"]
      a -> done [label="Fallback"]
    }`, '/tmp/failure-edge.dot');

    const sourceNode = graph.nodeMap.get('a');
    expect(sourceNode).toBeDefined();
    const resolved = resolveFailureTarget({
      node: sourceNode!,
      graph,
      context: {},
      steps: {},
      artifacts: { has: () => false, get: () => undefined },
    });

    expect(resolved.source).toBe('edge');
    expect(resolved.target).toBe('b');
    expect(resolved.edge?.target).toBe('b');
  });

  it('resolveFailureTarget falls through node and graph retry targets', () => {
    const graph = parseGardenSource(`digraph G {
      graph [fallback_retry_target="graphFallback"]
      start [shape=Mdiamond]
      a [shape=parallelogram]
      graphFallback [shape=parallelogram]
      done [shape=Msquare]
      start -> a
      a -> done [label="Fallback"]
    }`, '/tmp/failure-targets.dot');

    const sourceNode = graph.nodeMap.get('a');
    expect(sourceNode).toBeDefined();
    const resolved = resolveFailureTarget({
      node: sourceNode!,
      graph,
      context: {},
      steps: {},
      artifacts: { has: () => false, get: () => undefined },
    });

    expect(resolved.source).toBe('graph_fallback_retry_target');
    expect(resolved.target).toBe('graphFallback');
  });

  it('resolveFailureTarget returns null target when no routing path exists', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      a [shape=parallelogram]
      done [shape=Msquare]
      start -> a
      a -> done [label="Fallback"]
    }`, '/tmp/failure-none.dot');

    const sourceNode = graph.nodeMap.get('a');
    expect(sourceNode).toBeDefined();
    const resolved = resolveFailureTarget({
      node: sourceNode!,
      graph,
      context: {},
      steps: {},
      artifacts: { has: () => false, get: () => undefined },
    });

    expect(resolved.source).toBe('none');
    expect(resolved.target).toBeNull();
    expect(resolved.error).toBeUndefined();
  });

  it('emits pipeline_failed when no failure target exists at any level', async () => {
    const workspace = await createWorkspace('nectar-retry-no-target-');
    const graph = parseGardenSource(`digraph NoFailureTarget {
      start [shape=Mdiamond]
      bad [shape=parallelogram, script="exit 4", max_retries="0"]
      done [shape=Msquare]
      start -> bad
      bad -> done [label="Fallback"]
    }`, path.join(workspace, 'no-target.dot'));

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'retry-no-target',
    });

    const events: RunEvent[] = [];
    engine.onEvent((event) => events.push(event));
    const result = await engine.run();

    expect(result.status).toBe('failed');
    const names = events.map((event) => event.type);
    expect(names).toContain('stage_failed');
    expect(names).toContain('pipeline_failed');
    expect(names).toContain('run_error');
  });

  it('preserves failed terminal status when cleanup path reaches Msquare', async () => {
    const workspace = await createWorkspace('nectar-retry-terminal-failure-');
    const graph = parseGardenSource(`digraph CleanupExit {
      start [shape=Mdiamond]
      bad [shape=parallelogram, script="exit 7", max_retries="0", retry_target="cleanup"]
      cleanup [shape=parallelogram, script="echo cleanup"]
      done [shape=Msquare]
      start -> bad
      cleanup -> done
    }`, path.join(workspace, 'cleanup-exit.dot'));

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'retry-cleanup-terminal',
    });

    const result = await engine.run();
    expect(result.status).toBe('failed');
    expect(result.completed_nodes.map((node) => node.node_id)).toContain('cleanup');
    expect(result.completed_nodes.map((node) => node.node_id)).toContain('done');
  });
});
