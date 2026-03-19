import { describe, expect, it } from 'vitest';
import { GardenEdge } from '../../src/garden/types.js';
import { selectNextEdge } from '../../src/engine/edge-selector.js';

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

describe('edge selector', () => {
  it('step 1: chooses condition matches before fallback', () => {
    const selected = selectNextEdge({
      edges: [
        edge({ target: 'success', condition: 'outcome=success' }),
        edge({ target: 'fallback', label: 'Fallback' })
      ],
      outcome: { status: 'success' },
      context: {}
    });

    expect(selected?.target).toBe('success');
  });

  it('step 1: uses fallback when no condition matches', () => {
    const selected = selectNextEdge({
      edges: [
        edge({ target: 'x', condition: 'outcome=success' }),
        edge({ target: 'fallback', label: 'Fallback' })
      ],
      outcome: { status: 'failure' },
      context: {}
    });

    expect(selected?.target).toBe('fallback');
  });

  it('step 2: applies preferred_label', () => {
    const selected = selectNextEdge({
      edges: [edge({ target: 'x', label: 'A' }), edge({ target: 'y', label: 'B' })],
      outcome: { status: 'success', preferred_label: 'B' },
      context: {}
    });

    expect(selected?.target).toBe('y');
  });

  it('step 3: applies suggested_next ids', () => {
    const selected = selectNextEdge({
      edges: [edge({ target: 'x' }), edge({ target: 'y' })],
      outcome: { status: 'success', suggested_next: ['y'] },
      context: {}
    });

    expect(selected?.target).toBe('y');
  });

  it('step 4: picks highest weight', () => {
    const selected = selectNextEdge({
      edges: [edge({ target: 'x', weight: 1 }), edge({ target: 'y', weight: 9 })],
      outcome: { status: 'success' },
      context: {}
    });

    expect(selected?.target).toBe('y');
  });

  it('step 5: breaks ties by lexical target id', () => {
    const selected = selectNextEdge({
      edges: [edge({ target: 'z' }), edge({ target: 'a' })],
      outcome: { status: 'success' },
      context: {}
    });

    expect(selected?.target).toBe('a');
  });

  it('returns null when no candidates remain', () => {
    const selected = selectNextEdge({
      edges: [edge({ target: 'x', condition: 'outcome=success' })],
      outcome: { status: 'failure' },
      context: {}
    });

    expect(selected).toBeNull();
  });
});
