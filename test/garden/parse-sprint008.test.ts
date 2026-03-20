import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGardenFile, parseGardenSource, parseTimeoutMs, stripBlockComments, GardenParseError } from '../../src/garden/parse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

describe('block comments', () => {
  it('strips single-line block comment', () => {
    const result = stripBlockComments('hello /* comment */ world');
    // Block comment replaced with single space for token separation
    expect(result.trim()).toBe('hello   world');
    expect(result).not.toContain('comment');
  });

  it('strips multi-line block comment', () => {
    const result = stripBlockComments('before\n/* line1\nline2 */\nafter');
    expect(result).toContain('before');
    expect(result).toContain('after');
    expect(result).not.toContain('line1');
  });

  it('does not strip /* inside string literals', () => {
    const result = stripBlockComments('name="hello /* not a comment */" end');
    expect(result).toContain('hello /* not a comment */');
  });

  it('throws on unclosed block comment at EOF', () => {
    expect(() => stripBlockComments('hello /* unclosed')).toThrow('Unclosed block comment');
  });

  it('handles block comments in DOT parsing', () => {
    const graph = parseGardenSource(`
      digraph T {
        /* This is a block comment */
        start [shape=Mdiamond]
        end [shape=Msquare]
        start -> end
      }
    `);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodeMap.has('start')).toBe(true);
    expect(graph.nodeMap.has('end')).toBe(true);
  });

  it('handles multi-line block comments in DOT', () => {
    const graph = parseGardenSource(`
      digraph T {
        /* This pipeline implements
           a multi-line comment test
           across several lines */
        start [shape=Mdiamond]
        end [shape=Msquare]
        start -> end
      }
    `);
    expect(graph.nodes).toHaveLength(2);
  });
});

describe('default blocks', () => {
  it('applies node defaults to subsequent nodes', () => {
    const graph = parseGardenSource(`
      digraph T {
        node [shape=box, timeout="120s"]
        start [shape=Mdiamond]
        plan [prompt="Plan"]
        implement [prompt="Code"]
        end [shape=Msquare]
        start -> plan -> implement -> end
      }
    `);

    const plan = graph.nodeMap.get('plan');
    expect(plan?.shape).toBe('box');
    expect(plan?.timeoutMs).toBe(120_000);
    expect(plan?.prompt).toBe('Plan');

    const implement = graph.nodeMap.get('implement');
    expect(implement?.shape).toBe('box');
    expect(implement?.timeoutMs).toBe(120_000);
  });

  it('explicit attributes override defaults', () => {
    const graph = parseGardenSource(`
      digraph T {
        node [shape=box, timeout="120s"]
        start [shape=Mdiamond]
        test [shape=parallelogram, script="npm test"]
        end [shape=Msquare]
        start -> test -> end
      }
    `);

    const test = graph.nodeMap.get('test');
    expect(test?.shape).toBe('parallelogram');
    expect(test?.kind).toBe('tool');
    // timeout still inherited from default
    expect(test?.timeoutMs).toBe(120_000);
  });

  it('applies edge defaults to subsequent edges', () => {
    const graph = parseGardenSource(`
      digraph T {
        edge [weight=5]
        start [shape=Mdiamond]
        mid [shape=box, prompt="work"]
        end [shape=Msquare]
        start -> mid -> end
      }
    `);

    expect(graph.edges[0]?.weight).toBe(5);
    expect(graph.edges[1]?.weight).toBe(5);
  });

  it('does not create spurious node entries for node/edge keywords', () => {
    const graph = parseGardenSource(`
      digraph T {
        node [shape=box]
        edge [weight=1]
        start [shape=Mdiamond]
        end [shape=Msquare]
        start -> end
      }
    `);

    expect(graph.nodeMap.has('node')).toBe(false);
    expect(graph.nodeMap.has('edge')).toBe(false);
    expect(graph.nodes).toHaveLength(2);
  });

  it('parses default-blocks.dot fixture', async () => {
    const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'default-blocks.dot'));

    expect(graph.nodes).toHaveLength(6);

    const plan = graph.nodeMap.get('plan');
    expect(plan?.shape).toBe('box');
    expect(plan?.timeoutMs).toBe(120_000);
    expect(plan?.kind).toBe('codergen');

    const test = graph.nodeMap.get('test');
    expect(test?.shape).toBe('parallelogram');
    expect(test?.kind).toBe('tool');

    // Edge defaults
    for (const edge of graph.edges) {
      expect(edge.weight).toBe(2);
    }
  });
});

describe('subgraphs', () => {
  it('detects subgraph boundaries and records Subgraph', () => {
    const graph = parseGardenSource(`
      digraph T {
        start [shape=Mdiamond]
        end [shape=Msquare]
        subgraph cluster_fast {
          quick_lint [shape=parallelogram, script="lint"]
        }
        start -> quick_lint -> end
      }
    `);

    expect(graph.subgraphs).toHaveLength(1);
    expect(graph.subgraphs[0]?.id).toBe('cluster_fast');
    expect(graph.subgraphs[0]?.nodeIds).toContain('quick_lint');
  });

  it('derives class from cluster_ prefix', () => {
    const graph = parseGardenSource(`
      digraph T {
        start [shape=Mdiamond]
        end [shape=Msquare]
        subgraph cluster_fast {
          quick [shape=parallelogram, script="lint"]
        }
        start -> quick -> end
      }
    `);

    const quick = graph.nodeMap.get('quick');
    expect(quick?.classes).toContain('fast');
  });

  it('uses label for class when present', () => {
    const graph = parseGardenSource(`
      digraph T {
        start [shape=Mdiamond]
        end [shape=Msquare]
        subgraph cluster_fast {
          label="Quick Checks"
          quick [shape=parallelogram, script="lint"]
        }
        start -> quick -> end
      }
    `);

    const quick = graph.nodeMap.get('quick');
    expect(quick?.classes).toContain('quick-checks');
  });

  it('scoped defaults do not leak out', () => {
    const graph = parseGardenSource(`
      digraph T {
        start [shape=Mdiamond]
        end [shape=Msquare]
        subgraph cluster_fast {
          node [timeout="30s"]
          quick [shape=parallelogram, script="lint"]
        }
        outside [shape=box, prompt="work"]
        start -> quick -> outside -> end
      }
    `);

    const quick = graph.nodeMap.get('quick');
    expect(quick?.timeoutMs).toBe(30_000);

    const outside = graph.nodeMap.get('outside');
    expect(outside?.timeoutMs).toBeUndefined();
  });

  it('nested subgraphs accumulate classes', () => {
    const graph = parseGardenSource(`
      digraph T {
        start [shape=Mdiamond]
        end [shape=Msquare]
        subgraph cluster_outer {
          subgraph cluster_inner {
            deep [shape=parallelogram, script="test"]
          }
        }
        start -> deep -> end
      }
    `);

    const deep = graph.nodeMap.get('deep');
    expect(deep?.classes).toContain('outer');
    expect(deep?.classes).toContain('inner');
  });

  it('parses subgraph-classes.dot fixture', async () => {
    const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'subgraph-classes.dot'));

    expect(graph.subgraphs.length).toBeGreaterThanOrEqual(2);

    const quickLint = graph.nodeMap.get('quick_lint');
    expect(quickLint?.timeoutMs).toBe(30_000);
    expect(quickLint?.classes).toContain('quick-checks');

    const deepReview = graph.nodeMap.get('deep_review');
    expect(deepReview?.timeoutMs).toBe(600_000);
    expect(deepReview?.classes).toContain('deep');
  });
});

describe('duration units', () => {
  it('parses hours', () => {
    expect(parseTimeoutMs('2h')).toBe(7_200_000);
  });

  it('parses days', () => {
    expect(parseTimeoutMs('1d')).toBe(86_400_000);
  });

  it('still parses existing units', () => {
    expect(parseTimeoutMs('500ms')).toBe(500);
    expect(parseTimeoutMs('30s')).toBe(30_000);
    expect(parseTimeoutMs('5m')).toBe(300_000);
  });

  it('parses plain number as seconds', () => {
    expect(parseTimeoutMs('120')).toBe(120_000);
  });
});

describe('existing fixture compatibility', () => {
  it('compliance-loop.dot still parses identically', async () => {
    const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'compliance-loop.dot'));
    expect(graph.nodes).toHaveLength(14);
    expect(graph.edges).toHaveLength(17);

    const implement = graph.nodeMap.get('implement');
    expect(implement?.kind).toBe('tool');
    expect(implement?.maxRetries).toBe(2);
  });
});
