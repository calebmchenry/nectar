import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGardenFile, parseGardenSource } from '../../src/garden/parse.js';
import { transformAndValidate } from '../../src/garden/pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(__dirname, '../fixtures');

describe('stylesheet runtime integration', () => {
  it('parses stylesheet-basic.dot fixture and applies stylesheet', async () => {
    const graph = await parseGardenFile(path.join(FIXTURES, 'stylesheet-basic.dot'));
    const result = transformAndValidate(graph);

    // No errors (warnings OK)
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);

    // claude_draft: in cluster_drafts subgraph → has class "drafts"
    // .drafts rule: llm_provider: openai; llm_model: gpt-4o (higher specificity than box rule)
    const claudeDraft = result.graph.nodeMap.get('claude_draft');
    expect(claudeDraft?.llmModel).toBe('gpt-4o');
    expect(claudeDraft?.llmProvider).toBe('openai');

    // deep_review: #id selector → highest specificity
    const deepReview = result.graph.nodeMap.get('deep_review');
    expect(deepReview?.llmModel).toBe('claude-opus-4-20250514');
    expect(deepReview?.reasoningEffort).toBe('high');
  });

  it('inline attributes override stylesheet values', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_model: default; llm_provider: simulation }"
      start [shape=Mdiamond]
      impl [shape=box, prompt="Do work", llm_model="my-override"]
      end [shape=Msquare]
      start -> impl -> end
    }`);

    const result = transformAndValidate(graph);
    const impl = result.graph.nodeMap.get('impl');
    expect(impl?.llmModel).toBe('my-override');
    // llm_provider should come from stylesheet since not set inline
    expect(impl?.llmProvider).toBe('simulation');
  });

  it('end-to-end: stylesheet sets simulation provider, validation accepts it', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_provider: simulation; llm_model: sim-model }"
      start [shape=Mdiamond]
      impl [shape=box, prompt="Do work"]
      end [shape=Msquare]
      start -> impl -> end
    }`);

    const result = transformAndValidate(graph);
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);

    const impl = result.graph.nodeMap.get('impl');
    expect(impl?.llmProvider).toBe('simulation');
    expect(impl?.llmModel).toBe('sim-model');
  });

  it('existing DOT fixtures still parse and validate identically', async () => {
    const graph = await parseGardenFile(path.join(FIXTURES, 'compliance-loop.dot'));
    const result = transformAndValidate(graph);
    // Should have no stylesheet-related errors
    const stylesheetErrors = result.diagnostics.filter(d => d.code === 'STYLESHEET_SYNTAX');
    expect(stylesheetErrors).toHaveLength(0);
  });

  it('specificity: id > class > shape > universal', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="* { llm_model: universal } box { llm_model: shape } .special { llm_model: class } #target { llm_model: id }"
      start [shape=Mdiamond]
      target [shape=box, prompt="Do work", class="special"]
      end [shape=Msquare]
      start -> target -> end
    }`);

    const result = transformAndValidate(graph);
    const target = result.graph.nodeMap.get('target');
    expect(target?.llmModel).toBe('id');
  });

  it('stylesheet syntax error produces STYLESHEET_SYNTAX diagnostic in validation', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { bad_syntax }"
      start [shape=Mdiamond]
      end [shape=Msquare]
      start -> end
    }`);

    const result = transformAndValidate(graph);
    const stylesheetErrors = result.diagnostics.filter(d => d.code === 'STYLESHEET_SYNTAX');
    expect(stylesheetErrors.length).toBeGreaterThan(0);
  });
});
