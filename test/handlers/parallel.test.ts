import { describe, expect, it } from 'vitest';
import { ParallelHandler } from '../../src/handlers/parallel.js';
import { HandlerRegistry } from '../../src/handlers/registry.js';
import { GardenGraph, GardenNode, GardenEdge } from '../../src/garden/types.js';
import { HandlerExecutionInput } from '../../src/engine/types.js';
import { RunEvent } from '../../src/engine/events.js';
import { SimulationProvider } from '../../src/llm/simulation.js';
import { AutoApproveInterviewer } from '../../src/interviewer/auto-approve.js';

function makeGraph(nodes: GardenNode[], edges: GardenEdge[]): GardenGraph {
  const nodeMap = new Map<string, GardenNode>();
  const outgoing = new Map<string, GardenEdge[]>();
  const incoming = new Map<string, GardenEdge[]>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }

  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge);
    incoming.get(edge.target)?.push(edge);
  }

  return {
    dotPath: '<test>',
    dotSource: '',
    graphAttributes: {},
    nodes,
    edges,
    nodeMap,
    outgoing,
    incoming
  };
}

function makeNode(id: string, kind: GardenNode['kind'] = 'tool', attrs: Partial<GardenNode> = {}): GardenNode {
  return {
    id,
    kind,
    shape: kind === 'tool' ? 'parallelogram' : kind === 'parallel' ? 'component' : kind === 'parallel.fan_in' ? 'tripleoctagon' : undefined,
    attributes: kind === 'tool' ? { script: 'echo test', ...attrs.attributes } : { ...attrs.attributes },
    ...attrs
  };
}

function makeEdge(source: string, target: string): GardenEdge {
  return { source, target, weight: 0, attributes: {} };
}

describe('ParallelHandler', () => {
  it('executes 3 branches all succeed (wait_all → success)', async () => {
    const fanOut = makeNode('fan_out', 'parallel', { joinPolicy: 'wait_all' });
    const a = makeNode('a', 'tool');
    const b = makeNode('b', 'tool');
    const c = makeNode('c', 'tool');
    const fanIn = makeNode('fan_in', 'parallel.fan_in');

    const graph = makeGraph(
      [fanOut, a, b, c, fanIn],
      [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b'), makeEdge('fan_out', 'c'),
       makeEdge('a', 'fan_in'), makeEdge('b', 'fan_in'), makeEdge('c', 'fan_in')]
    );

    const events: RunEvent[] = [];
    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());
    const handler = new ParallelHandler(graph, handlers, (e) => events.push(e));

    const input: HandlerExecutionInput = {
      node: fanOut,
      run_id: 'test-run',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test-parallel',
      context: {},
      outgoing_edges: [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b'), makeEdge('fan_out', 'c')]
    };

    const outcome = await handler.execute(input);
    expect(outcome.status).toBe('success');
    expect(outcome.context_updates).toBeDefined();
    expect(outcome.context_updates!['parallel.results.fan_out']).toBeDefined();

    // Check events
    const parallelStarted = events.find((e) => e.type === 'parallel_started');
    expect(parallelStarted).toBeDefined();
    const parallelCompleted = events.find((e) => e.type === 'parallel_completed');
    expect(parallelCompleted).toBeDefined();
  });

  it('returns partial_success when 1 of 3 fails (wait_all)', async () => {
    const fanOut = makeNode('fan_out', 'parallel', { joinPolicy: 'wait_all' });
    const a = makeNode('a', 'tool', { attributes: { script: 'echo ok' } });
    const b = makeNode('b', 'tool', { attributes: { script: 'exit 1' } });
    const fanIn = makeNode('fan_in', 'parallel.fan_in');

    const graph = makeGraph(
      [fanOut, a, b, fanIn],
      [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b'),
       makeEdge('a', 'fan_in'), makeEdge('b', 'fan_in')]
    );

    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());
    const handler = new ParallelHandler(graph, handlers);

    const input: HandlerExecutionInput = {
      node: fanOut,
      run_id: 'test-run',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test-parallel',
      context: {},
      outgoing_edges: [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b')]
    };

    const outcome = await handler.execute(input);
    expect(outcome.status).toBe('partial_success');
  });

  it('returns failure when all fail (wait_all)', async () => {
    const fanOut = makeNode('fan_out', 'parallel', { joinPolicy: 'wait_all' });
    const a = makeNode('a', 'tool', { attributes: { script: 'exit 1' } });
    const b = makeNode('b', 'tool', { attributes: { script: 'exit 1' } });
    const fanIn = makeNode('fan_in', 'parallel.fan_in');

    const graph = makeGraph(
      [fanOut, a, b, fanIn],
      [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b'),
       makeEdge('a', 'fan_in'), makeEdge('b', 'fan_in')]
    );

    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());
    const handler = new ParallelHandler(graph, handlers);

    const input: HandlerExecutionInput = {
      node: fanOut,
      run_id: 'test-run',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test-parallel',
      context: {},
      outgoing_edges: [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b')]
    };

    const outcome = await handler.execute(input);
    expect(outcome.status).toBe('failure');
  });

  it('first_success returns success on first completion', async () => {
    const fanOut = makeNode('fan_out', 'parallel', { joinPolicy: 'first_success' });
    const a = makeNode('a', 'tool', { attributes: { script: 'echo fast' } });
    const b = makeNode('b', 'tool', { attributes: { script: 'echo slow' } });
    const fanIn = makeNode('fan_in', 'parallel.fan_in');

    const graph = makeGraph(
      [fanOut, a, b, fanIn],
      [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b'),
       makeEdge('a', 'fan_in'), makeEdge('b', 'fan_in')]
    );

    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());
    const handler = new ParallelHandler(graph, handlers);

    const input: HandlerExecutionInput = {
      node: fanOut,
      run_id: 'test-run',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test-parallel',
      context: {},
      outgoing_edges: [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b')]
    };

    const outcome = await handler.execute(input);
    expect(outcome.status).toBe('success');
  });

  it('max_parallel=1 runs sequentially', async () => {
    const fanOut = makeNode('fan_out', 'parallel', { joinPolicy: 'wait_all', maxParallel: 1 });
    const a = makeNode('a', 'tool');
    const b = makeNode('b', 'tool');
    const fanIn = makeNode('fan_in', 'parallel.fan_in');

    const graph = makeGraph(
      [fanOut, a, b, fanIn],
      [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b'),
       makeEdge('a', 'fan_in'), makeEdge('b', 'fan_in')]
    );

    const events: RunEvent[] = [];
    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());
    const handler = new ParallelHandler(graph, handlers, (e) => events.push(e));

    const input: HandlerExecutionInput = {
      node: fanOut,
      run_id: 'test-run',
      dot_file: '<test>',
      attempt: 1,
      run_dir: '/tmp/test-parallel',
      context: {},
      outgoing_edges: [makeEdge('fan_out', 'a'), makeEdge('fan_out', 'b')]
    };

    const outcome = await handler.execute(input);
    expect(outcome.status).toBe('success');

    // With max_parallel=1, branch_started events should be sequential
    const branchStarted = events.filter((e) => e.type === 'parallel_branch_started');
    expect(branchStarted.length).toBe(2);
  });
});
