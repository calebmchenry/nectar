import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGardenFile, parseGardenSource } from '../../src/garden/parse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

describe('garden parse', () => {
  it('parses compliance-loop graph', async () => {
    const graph = await parseGardenFile(path.join(ROOT, 'gardens', 'compliance-loop.dot'));

    expect(graph.nodes).toHaveLength(13);
    expect(graph.edges).toHaveLength(16);

    const implement = graph.nodeMap.get('implement');
    expect(implement?.kind).toBe('tool');
    expect(implement?.maxRetries).toBe(2);
    expect(implement?.attributes.script).toContain('node scripts/compliance_loop.mjs implement');

    const fallbackEdge = graph.edges.find(
      (edge) => edge.source === 'compliance_check' && edge.target === 'claude_draft' && edge.label === 'Fallback'
    );
    expect(fallbackEdge).toBeTruthy();
  });

  it('normalizes chained edges into individual edges', () => {
    const graph = parseGardenSource(`digraph T { start [shape=Mdiamond]\nend [shape=Msquare]\nstart -> mid -> end }`);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0].source).toBe('start');
    expect(graph.edges[0].target).toBe('mid');
    expect(graph.edges[1].source).toBe('mid');
    expect(graph.edges[1].target).toBe('end');
  });
});
