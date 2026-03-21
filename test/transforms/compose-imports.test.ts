import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PipelinePreparer } from '../../src/garden/preparer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(__dirname, '../fixtures/composed');

function createPreparer(): PipelinePreparer {
  return new PipelinePreparer({ workspaceRoot: FIXTURES });
}

function errorCodes(diagnostics: Array<{ severity: string; code: string }>): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.code);
}

describe('compose imports transform', () => {
  it('composes a child graph, rewires edges, and materializes child defaults', async () => {
    const result = await createPreparer().prepareFromPath('success-parent.dot');
    expect(errorCodes(result.diagnostics)).toEqual([]);

    const graph = result.graph;
    expect(graph.nodeMap.has('review')).toBe(false);
    expect(graph.nodeMap.has('review__c_start')).toBe(true);
    expect(graph.nodeMap.has('review__draft')).toBe(true);
    expect(graph.nodeMap.has('review__c_exit')).toBe(true);

    expect(graph.edges.some((edge) => edge.source === 'start' && edge.target === 'review__c_start')).toBe(true);
    expect(graph.edges.some((edge) => edge.source === 'review__c_exit' && edge.target === 'done')).toBe(true);

    const draft = graph.nodeMap.get('review__draft');
    expect(draft?.prompt).toBe('Draft for child review goal');
    expect(draft?.maxRetries).toBe(2);
    expect(draft?.fidelity).toBe('summary:high');
    expect(draft?.toolHooksPre).toBe('echo pre-hook');
    expect(draft?.toolHooksPost).toBe('echo post-hook');
    expect(draft?.attributes.goal).toBe('child review goal');
    expect(draft?.attributes.model_stylesheet).toBe('box { llm_provider: simulation }');

    const childPath = path.join(FIXTURES, 'success-child.dot');
    expect(draft?.provenance?.dotPath).toBe(childPath);
    expect(result.source_files).toEqual([
      path.join(FIXTURES, 'success-child.dot'),
      path.join(FIXTURES, 'success-parent.dot'),
    ]);
  });

  it('supports nested composition with deterministic namespacing', async () => {
    const result = await createPreparer().prepareFromPath('nested-parent.dot');
    expect(errorCodes(result.diagnostics)).toEqual([]);

    const graph = result.graph;
    expect(graph.nodeMap.has('mid_module__m_start')).toBe(true);
    expect(graph.nodeMap.has('mid_module__leaf_module__l_work')).toBe(true);
    expect(graph.nodeMap.has('mid_module__m_exit')).toBe(true);
    expect(graph.nodeMap.has('mid_module')).toBe(false);
    expect(graph.nodeMap.has('mid_module__leaf_module')).toBe(false);

    expect(graph.edges.some((edge) => edge.source === 'start' && edge.target === 'mid_module__m_start')).toBe(true);
    expect(graph.edges.some((edge) => edge.source === 'mid_module__m_exit' && edge.target === 'done')).toBe(true);
  });

  it('emits clear diagnostics for missing child files', async () => {
    const result = await createPreparer().prepareFromPath('missing-parent.dot');
    expect(errorCodes(result.diagnostics)).toContain('COMPOSE_CHILD_MISSING');
  });

  it('rejects compose paths that escape the workspace root', async () => {
    const result = await createPreparer().prepareFromPath('outside-workspace-parent.dot');
    expect(errorCodes(result.diagnostics)).toContain('COMPOSE_OUTSIDE_WORKSPACE');
  });

  it('fails deterministically on prefix collisions', async () => {
    const result = await createPreparer().prepareFromPath('collision-parent.dot');
    expect(errorCodes(result.diagnostics)).toContain('COMPOSE_PREFIX_COLLISION');
  });

  it('fails deterministically on import cycles', async () => {
    const result = await createPreparer().prepareFromPath('cycle-a.dot');
    const codes = errorCodes(result.diagnostics);
    expect(codes).toContain('COMPOSE_IMPORT_CYCLE');
    expect(codes).toContain('COMPOSE_CHILD_INVALID');
  });

  it('reports child validation errors against the child file path', async () => {
    const result = await createPreparer().prepareFromPath('invalid-parent.dot');
    const unsupportedShape = result.diagnostics.find(
      (diagnostic) => diagnostic.code === 'UNSUPPORTED_SHAPE' && diagnostic.severity === 'error',
    );
    expect(unsupportedShape?.file).toBe(path.join(FIXTURES, 'invalid-child.dot'));
    expect(errorCodes(result.diagnostics)).toContain('COMPOSE_CHILD_INVALID');
  });
});
