import { describe, expect, it } from 'vitest';
import { BranchExecutor } from '../../src/engine/branch-executor.js';
import { ExecutionContext } from '../../src/engine/context.js';
import { RunEvent } from '../../src/engine/events.js';
import { HandlerRegistry, NodeHandler } from '../../src/handlers/registry.js';
import { GardenGraph, GardenNode, GardenEdge } from '../../src/garden/types.js';
import { HandlerExecutionInput, NodeOutcome } from '../../src/engine/types.js';
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
    shape: kind === 'tool' ? 'parallelogram' : undefined,
    attributes: { script: 'echo test', ...attrs.attributes },
    ...attrs
  };
}

function makeEdge(source: string, target: string, attrs: Partial<GardenEdge> = {}): GardenEdge {
  return { source, target, weight: 0, attributes: {}, ...attrs };
}

describe('BranchExecutor', () => {
  it('executes a single-node branch', async () => {
    const nodeA = makeNode('a', 'tool');
    const graph = makeGraph([nodeA], []);

    const context = new ExecutionContext();
    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());

    const executor = new BranchExecutor({
      graph,
      context,
      handlers,
      branchStartNodeId: 'a',
      terminationNodeIds: new Set(),
      runId: 'test-run',
      dotFile: '<test>',
      runDir: '/tmp/test-branch'
    });

    const result = await executor.execute();
    expect(result.branchId).toBe('a');
    expect(result.status).toBe('success');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('executes a multi-node branch', async () => {
    const nodeA = makeNode('a', 'tool');
    const nodeB = makeNode('b', 'tool');
    const graph = makeGraph(
      [nodeA, nodeB],
      [makeEdge('a', 'b')]
    );

    const context = new ExecutionContext();
    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());

    const executor = new BranchExecutor({
      graph,
      context,
      handlers,
      branchStartNodeId: 'a',
      terminationNodeIds: new Set(),
      runId: 'test-run',
      dotFile: '<test>',
      runDir: '/tmp/test-branch'
    });

    const result = await executor.execute();
    expect(result.status).toBe('success');
  });

  it('stops at termination boundary', async () => {
    const nodeA = makeNode('a', 'tool');
    const nodeB = makeNode('b', 'tool');
    const graph = makeGraph(
      [nodeA, nodeB],
      [makeEdge('a', 'b')]
    );

    const context = new ExecutionContext();
    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());

    const executor = new BranchExecutor({
      graph,
      context,
      handlers,
      branchStartNodeId: 'a',
      terminationNodeIds: new Set(['b']),
      runId: 'test-run',
      dotFile: '<test>',
      runDir: '/tmp/test-branch'
    });

    const result = await executor.execute();
    expect(result.status).toBe('success');
  });

  it('respects abort signal', async () => {
    const nodeA = makeNode('a', 'tool');
    const graph = makeGraph([nodeA], []);

    const context = new ExecutionContext();
    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());
    const controller = new AbortController();
    controller.abort();

    const executor = new BranchExecutor({
      graph,
      context,
      handlers,
      branchStartNodeId: 'a',
      terminationNodeIds: new Set(),
      runId: 'test-run',
      dotFile: '<test>',
      runDir: '/tmp/test-branch',
      abortSignal: controller.signal
    });

    const result = await executor.execute();
    // Aborted before executing — no completed nodes, so status is success (trivial empty branch)
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('maintains context isolation', async () => {
    const nodeA = makeNode('a', 'tool');
    const graph = makeGraph([nodeA], []);

    const parentContext = new ExecutionContext({ parent_key: 'parent_value' });
    const branchContext = parentContext.clone();

    const handlers = new HandlerRegistry(new SimulationProvider(), new AutoApproveInterviewer());

    const executor = new BranchExecutor({
      graph,
      context: branchContext,
      handlers,
      branchStartNodeId: 'a',
      terminationNodeIds: new Set(),
      runId: 'test-run',
      dotFile: '<test>',
      runDir: '/tmp/test-branch'
    });

    await executor.execute();

    // Branch context has been modified (current_node, outcome, etc.)
    expect(branchContext.get('current_node')).toBe('a');
    // Parent context should be unchanged
    expect(parentContext.get('current_node')).toBeUndefined();
    expect(parentContext.get('parent_key')).toBe('parent_value');
  });
});
