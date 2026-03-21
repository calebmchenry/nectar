import { describe, expect, it } from 'vitest';
import { GraphRenderer } from '../../src/server/graph-renderer.js';

describe('GraphRenderer', () => {
  it('returns valid svg markup with node labels', async () => {
    const renderer = new GraphRenderer();
    const svg = await renderer.render(
      `digraph G {
        start [shape=Mdiamond, label="Start"]
        work [shape=parallelogram, label="Work"]
        done [shape=Msquare, label="Done"]
        start -> work
        work -> done
      }`,
      {
        status: 'running',
        current_node: 'work',
        completed_nodes: [
          {
            node_id: 'start',
            status: 'success',
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            retries: 0,
          },
        ],
      }
    );

    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('<svg');
    expect(svg).toContain('Work');
    expect(svg).toContain('marker-end="url(#arrow)"');
  });
});
