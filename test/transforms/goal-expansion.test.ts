import { describe, expect, it } from 'vitest';
import { parseGardenSource } from '../../src/garden/parse.js';
import { expandGoalVariables } from '../../src/transforms/goal-expansion.js';

describe('goal expansion transform', () => {
  it('replaces $goal in prompt attributes', () => {
    const graph = parseGardenSource(`digraph G {
      graph [goal="Build a web app"]
      start [shape=Mdiamond]
      work [shape=box, prompt="Your goal is: $goal. Do it well."]
      end [shape=Msquare]
      start -> work
      work -> end
    }`);

    const result = expandGoalVariables(graph);
    const workNode = result.graph.nodeMap.get('work');
    expect(workNode?.prompt).toBe('Your goal is: Build a web app. Do it well.');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('warns when $goal used but graph has no goal attribute', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      work [shape=box, prompt="Do this: $goal"]
      end [shape=Msquare]
      start -> work
      work -> end
    }`);

    const result = expandGoalVariables(graph);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('GOAL_UNDEFINED');
  });

  it('leaves prompts without $goal unchanged', () => {
    const graph = parseGardenSource(`digraph G {
      graph [goal="Something"]
      start [shape=Mdiamond]
      work [shape=box, prompt="Do something specific"]
      end [shape=Msquare]
      start -> work
      work -> end
    }`);

    const result = expandGoalVariables(graph);
    const workNode = result.graph.nodeMap.get('work');
    expect(workNode?.prompt).toBe('Do something specific');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('replaces multiple $goal occurrences in same prompt', () => {
    const graph = parseGardenSource(`digraph G {
      graph [goal="test"]
      start [shape=Mdiamond]
      work [shape=box, prompt="Goal: $goal. Remember: $goal."]
      end [shape=Msquare]
      start -> work
      work -> end
    }`);

    const result = expandGoalVariables(graph);
    const workNode = result.graph.nodeMap.get('work');
    expect(workNode?.prompt).toBe('Goal: test. Remember: test.');
  });
});
