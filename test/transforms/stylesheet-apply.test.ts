import { describe, expect, it } from 'vitest';
import { parseGardenSource } from '../../src/garden/parse.js';
import { applyStylesheet } from '../../src/transforms/stylesheet-apply.js';
import { transformAndValidate } from '../../src/garden/pipeline.js';

describe('applyStylesheet transform', () => {
  it('applies universal rule to all nodes', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="* { llm_model: gpt-4o }"
      start [shape=Mdiamond]
      impl [shape=box, prompt="Do work"]
      end [shape=Msquare]
      start -> impl -> end
    }`);

    const { diagnostics } = applyStylesheet(graph);
    expect(diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);

    const impl = graph.nodeMap.get('impl');
    expect(impl?.llmModel).toBe('gpt-4o');
  });

  it('applies shape selector to matching nodes', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_model: claude-sonnet-4-20250514 }"
      start [shape=Mdiamond]
      impl [shape=box, prompt="Do work"]
      check [shape=diamond]
      end [shape=Msquare]
      start -> impl -> check -> end
    }`);

    const { diagnostics } = applyStylesheet(graph);
    expect(diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);

    expect(graph.nodeMap.get('impl')?.llmModel).toBe('claude-sonnet-4-20250514');
    expect(graph.nodeMap.get('check')?.llmModel).toBeUndefined();
  });

  it('applies class selector to nodes with matching class', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet=".drafts { llm_provider: openai }"
      start [shape=Mdiamond]
      impl [shape=box, prompt="Do work", class="drafts"]
      end [shape=Msquare]
      start -> impl -> end
    }`);

    applyStylesheet(graph);
    expect(graph.nodeMap.get('impl')?.llmProvider).toBe('openai');
  });

  it('applies id selector to specific node', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="#deep_review { reasoning_effort: high }"
      start [shape=Mdiamond]
      deep_review [shape=box, prompt="Review"]
      other [shape=box, prompt="Other"]
      end [shape=Msquare]
      start -> deep_review -> end
      start -> other -> end
    }`);

    applyStylesheet(graph);
    expect(graph.nodeMap.get('deep_review')?.reasoningEffort).toBe('high');
    expect(graph.nodeMap.get('other')?.reasoningEffort).toBeUndefined();
  });

  it('inline node attributes override stylesheet', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_model: default-model }"
      start [shape=Mdiamond]
      impl [shape=box, prompt="Do work", llm_model="override-model"]
      end [shape=Msquare]
      start -> impl -> end
    }`);

    applyStylesheet(graph);
    // The inline llm_model should NOT be overwritten
    expect(graph.nodeMap.get('impl')?.llmModel).toBe('override-model');
  });

  it('returns no diagnostics for absent stylesheet', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      end [shape=Msquare]
      start -> end
    }`);

    const { diagnostics } = applyStylesheet(graph);
    expect(diagnostics).toHaveLength(0);
  });

  it('reports stylesheet syntax errors as diagnostics', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_model }"
      start [shape=Mdiamond]
      end [shape=Msquare]
      start -> end
    }`);

    const { diagnostics } = applyStylesheet(graph);
    expect(diagnostics.some(d => d.severity === 'error')).toBe(true);
  });

  it('partial parse: valid rules apply even with syntax errors', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_model } #review { reasoning_effort: high }"
      start [shape=Mdiamond]
      review [shape=box, prompt="Review"]
      end [shape=Msquare]
      start -> review -> end
    }`);

    const { diagnostics } = applyStylesheet(graph);
    // There should be an error from the first rule
    expect(diagnostics.some(d => d.severity === 'error')).toBe(true);
    // But the second rule should still apply
    expect(graph.nodeMap.get('review')?.reasoningEffort).toBe('high');
  });

  it('integrates into pipeline: runs between goal expansion and validation', async () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_model: claude-sonnet-4-20250514; llm_provider: simulation }"
      start [shape=Mdiamond]
      impl [shape=box, prompt="Do work"]
      end [shape=Msquare]
      start -> impl -> end
    }`);

    const result = await transformAndValidate(graph);
    expect(result.graph.nodeMap.get('impl')?.llmModel).toBe('claude-sonnet-4-20250514');
    expect(result.graph.nodeMap.get('impl')?.llmProvider).toBe('simulation');
  });
});
