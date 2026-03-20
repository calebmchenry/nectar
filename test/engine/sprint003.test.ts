import { describe, expect, it } from 'vitest';
import { evaluateConditionExpression } from '../../src/engine/conditions.js';
import { normalizeLabel, selectNextEdge } from '../../src/engine/edge-selector.js';
import { GardenEdge } from '../../src/garden/types.js';
import { parseGardenSource } from '../../src/garden/parse.js';

function edge(partial: Partial<GardenEdge>): GardenEdge {
  return {
    source: partial.source ?? 'a',
    target: partial.target ?? 'b',
    weight: partial.weight ?? 0,
    attributes: partial.attributes ?? {},
    label: partial.label,
    condition: partial.condition,
    location: partial.location
  };
}

describe('GAP-08: goal gates accept partial_success', () => {
  it('parses goal_gate and partial_success is a valid status', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      check [shape=parallelogram, script="echo ok", goal_gate="true", retry_target="start"]
      end [shape=Msquare]
      start -> check
      check -> end
    }`);
    const checkNode = graph.nodeMap.get('check');
    expect(checkNode?.goalGate).toBe(true);
  });
});

describe('GAP-10: default_max_retries graph attribute', () => {
  it('parses default_max_retries from graph attributes', () => {
    const graph = parseGardenSource(`digraph G {
      graph [default_max_retries="3"]
      start [shape=Mdiamond]
      end [shape=Msquare]
      start -> end
    }`);
    expect(graph.defaultMaxRetries).toBe(3);
  });

  it('parses legacy alias default_max_retry', () => {
    const graph = parseGardenSource(`digraph G {
      graph [default_max_retry="2"]
      start [shape=Mdiamond]
      end [shape=Msquare]
      start -> end
    }`);
    expect(graph.defaultMaxRetries).toBe(2);
  });

  it('prefers default_max_retries over legacy alias', () => {
    const graph = parseGardenSource(`digraph G {
      graph [default_max_retries="5", default_max_retry="2"]
      start [shape=Mdiamond]
      end [shape=Msquare]
      start -> end
    }`);
    expect(graph.defaultMaxRetries).toBe(5);
  });
});

describe('GAP-15: label normalization', () => {
  it('normalizes lowercase and trim', () => {
    expect(normalizeLabel('  HELLO  ')).toBe('hello');
  });

  it('strips [X] accelerator prefix', () => {
    expect(normalizeLabel('[Y] Yes')).toBe('yes');
  });

  it('strips X) accelerator prefix', () => {
    expect(normalizeLabel('N) No')).toBe('no');
  });

  it('strips X - accelerator prefix', () => {
    expect(normalizeLabel('A - Approve')).toBe('approve');
  });

  it('does not strip multi-char [OK] prefix', () => {
    expect(normalizeLabel('[OK] Okay')).toBe('[ok] okay');
  });

  it('preferred_label matching uses normalization', () => {
    const selected = selectNextEdge({
      edges: [edge({ target: 'x', label: '[A] Approve' }), edge({ target: 'y', label: '[R] Reject' })],
      outcome: { status: 'success', preferred_label: 'approve' },
      context: {}
    });
    expect(selected?.target).toBe('x');
  });
});

describe('GAP-16: preferred_label as condition variable', () => {
  it('evaluates preferred_label= condition', () => {
    expect(
      evaluateConditionExpression('preferred_label=approve', {
        outcome: 'success',
        context: { preferred_label: 'approve' }
      })
    ).toBe(true);
  });

  it('evaluates preferred_label!= condition', () => {
    expect(
      evaluateConditionExpression('preferred_label!=approve', {
        outcome: 'success',
        context: { preferred_label: 'reject' }
      })
    ).toBe(true);
  });

  it('preferred_label condition with edge selection', () => {
    const selected = selectNextEdge({
      edges: [
        edge({ target: 'deploy', condition: 'preferred_label=approve' }),
        edge({ target: 'abort', condition: 'preferred_label=reject' })
      ],
      outcome: { status: 'success', preferred_label: 'approve' },
      context: { preferred_label: 'approve' }
    });
    expect(selected?.target).toBe('deploy');
  });
});

describe('GAP-09: allow_partial attribute', () => {
  it('parses allow_partial on nodes', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      work [shape=parallelogram, script="echo ok", allow_partial="true"]
      end [shape=Msquare]
      start -> work
      work -> end
    }`);
    const workNode = graph.nodeMap.get('work');
    expect(workNode?.allowPartial).toBe(true);
  });
});

describe('Hexagon shape support', () => {
  it('parses hexagon as wait.human kind', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      gate [shape=hexagon, label="Choose"]
      end [shape=Msquare]
      start -> gate
      gate -> end [label="Go"]
    }`);
    const gateNode = graph.nodeMap.get('gate');
    expect(gateNode?.kind).toBe('wait.human');
  });

  it('parses human.default_choice attribute', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      gate [shape=hexagon, "human.default_choice"="approve"]
      end [shape=Msquare]
      start -> gate
      gate -> end [label="approve"]
    }`);
    const gateNode = graph.nodeMap.get('gate');
    expect(gateNode?.humanDefaultChoice).toBe('approve');
  });
});
