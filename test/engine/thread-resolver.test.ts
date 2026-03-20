import { describe, expect, it } from 'vitest';
import { resolveThreadId } from '../../src/engine/thread-resolver.js';
import type { GardenGraph, GardenNode } from '../../src/garden/types.js';

function makeNode(overrides: Partial<GardenNode> = {}): GardenNode {
  return {
    id: 'test-node',
    kind: 'codergen',
    classes: [],
    attributes: {},
    ...overrides,
  };
}

function makeGraph(): GardenGraph {
  return {
    dotPath: 'test.dot',
    dotSource: '',
    graphAttributes: {},
    nodes: [],
    edges: [],
    subgraphs: [],
    nodeMap: new Map(),
    outgoing: new Map(),
    incoming: new Map(),
  };
}

describe('resolveThreadId', () => {
  it('node attr wins over everything', () => {
    const node = makeNode({ threadId: 'node-thread', classes: ['class-thread'] });
    const edge = { thread_id: 'edge-thread' };
    const result = resolveThreadId(node, edge, makeGraph(), 'prev-thread');
    expect(result).toBe('node-thread');
  });

  it('edge attr wins over subgraph class', () => {
    const node = makeNode({ classes: ['class-thread'] });
    const edge = { thread_id: 'edge-thread' };
    const result = resolveThreadId(node, edge, makeGraph(), 'prev-thread');
    expect(result).toBe('edge-thread');
  });

  it('graph-level thread_id default wins over subgraph class', () => {
    const graph = makeGraph();
    graph.graphAttributes.thread_id = 'graph-default';
    const node = makeNode({ classes: ['class-thread'] });
    const result = resolveThreadId(node, undefined, graph, 'prev-thread');
    expect(result).toBe('graph-default');
  });

  it('edge attr wins over graph-level thread_id default', () => {
    const graph = makeGraph();
    graph.graphAttributes.thread_id = 'graph-default';
    const node = makeNode();
    const edge = { thread_id: 'edge-thread' };
    const result = resolveThreadId(node, edge, graph, null);
    expect(result).toBe('edge-thread');
  });

  it('subgraph class wins over previous node', () => {
    const node = makeNode({ classes: ['my-subgraph'] });
    const result = resolveThreadId(node, undefined, makeGraph(), 'prev-thread');
    expect(result).toBe('my-subgraph');
  });

  it('previous node thread inherited when nothing else specified', () => {
    const node = makeNode();
    const result = resolveThreadId(node, undefined, makeGraph(), 'prev-thread');
    expect(result).toBe('prev-thread');
  });

  it('returns null when no thread anywhere', () => {
    const node = makeNode();
    const result = resolveThreadId(node, undefined, makeGraph(), null);
    expect(result).toBeNull();
  });

  it('edge without thread_id falls through to node classes', () => {
    const node = makeNode({ classes: ['analytics'] });
    const edge = {};
    const result = resolveThreadId(node, edge, makeGraph(), null);
    expect(result).toBe('analytics');
  });

  it('first class used when multiple classes exist', () => {
    const node = makeNode({ classes: ['first-class', 'second-class'] });
    const result = resolveThreadId(node, undefined, makeGraph(), null);
    expect(result).toBe('first-class');
  });

  it('empty classes array falls through to previous', () => {
    const node = makeNode({ classes: [] });
    const result = resolveThreadId(node, undefined, makeGraph(), 'inherited');
    expect(result).toBe('inherited');
  });
});
