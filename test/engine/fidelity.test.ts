import { describe, expect, it } from 'vitest';
import { resolveFidelity, isFidelityMode, getFidelityBudget } from '../../src/engine/fidelity.js';
import type { FidelityMode } from '../../src/engine/fidelity.js';
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

function makeGraph(overrides: Partial<GardenGraph> = {}): GardenGraph {
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
    ...overrides,
  };
}

describe('fidelity resolution', () => {
  it('edge fidelity overrides node fidelity', () => {
    const node = makeNode({ fidelity: 'compact' });
    const edge = { fidelity: 'full' };
    const graph = makeGraph();
    expect(resolveFidelity(node, edge, graph)).toBe('full');
  });

  it('node fidelity overrides graph default_fidelity', () => {
    const node = makeNode({ fidelity: 'truncate' });
    const graph = makeGraph({ defaultFidelity: 'compact' });
    expect(resolveFidelity(node, undefined, graph)).toBe('truncate');
  });

  it('graph default_fidelity used when no node or edge fidelity', () => {
    const node = makeNode();
    const graph = makeGraph({ defaultFidelity: 'summary:medium' });
    expect(resolveFidelity(node, undefined, graph)).toBe('summary:medium');
  });

  it('system default is compact when nothing specified', () => {
    const node = makeNode();
    const graph = makeGraph();
    expect(resolveFidelity(node, undefined, graph)).toBe('compact');
  });

  it('edge with no fidelity falls through to node', () => {
    const node = makeNode({ fidelity: 'full' });
    const edge = {};
    const graph = makeGraph();
    expect(resolveFidelity(node, edge, graph)).toBe('full');
  });

  it('invalid fidelity on edge falls through', () => {
    const node = makeNode({ fidelity: 'compact' });
    const edge = { fidelity: 'bogus' };
    const graph = makeGraph();
    expect(resolveFidelity(node, edge, graph)).toBe('compact');
  });

  it('invalid fidelity on node falls through to graph default', () => {
    const node = makeNode({ fidelity: 'invalid-mode' });
    const graph = makeGraph({ defaultFidelity: 'truncate' });
    expect(resolveFidelity(node, undefined, graph)).toBe('truncate');
  });

  it('invalid fidelity everywhere falls back to compact', () => {
    const node = makeNode({ fidelity: 'bad' });
    const graph = makeGraph({ defaultFidelity: 'also-bad' });
    expect(resolveFidelity(node, { fidelity: 'nope' }, graph)).toBe('compact');
  });
});

describe('isFidelityMode', () => {
  it('recognizes all 6 valid modes', () => {
    const modes: string[] = ['full', 'truncate', 'compact', 'summary:low', 'summary:medium', 'summary:high'];
    for (const mode of modes) {
      expect(isFidelityMode(mode)).toBe(true);
    }
  });

  it('rejects invalid modes', () => {
    expect(isFidelityMode('bogus')).toBe(false);
    expect(isFidelityMode('')).toBe(false);
    expect(isFidelityMode('summary')).toBe(false);
  });
});

describe('getFidelityBudget', () => {
  it('full has no budget', () => {
    expect(getFidelityBudget('full')).toBeUndefined();
  });

  it('truncate budget is 400', () => {
    expect(getFidelityBudget('truncate')).toBe(400);
  });

  it('compact budget is 3200', () => {
    expect(getFidelityBudget('compact')).toBe(3200);
  });

  it('summary:low budget is 2400', () => {
    expect(getFidelityBudget('summary:low')).toBe(2400);
  });

  it('summary:medium budget is 6000', () => {
    expect(getFidelityBudget('summary:medium')).toBe(6000);
  });

  it('summary:high budget is 12000', () => {
    expect(getFidelityBudget('summary:high')).toBe(12000);
  });
});
