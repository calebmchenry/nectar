import path from 'node:path';
import { PipelinePreparer } from './preparer.js';
import type { Diagnostic, GardenGraph } from './types.js';

export interface PipelineResult {
  graph: GardenGraph;
  diagnostics: Diagnostic[];
}

/**
 * Compatibility facade for older call sites.
 * New production code should use PipelinePreparer directly.
 */
export async function transformAndValidate(graph: GardenGraph): Promise<PipelineResult> {
  const preparer = new PipelinePreparer({
    workspaceRoot: inferWorkspaceRoot(graph.dotPath),
  });
  const prepared = await preparer.prepareFromSource(graph.dotSource, graph.dotPath);
  return {
    graph: prepared.graph,
    diagnostics: prepared.diagnostics,
  };
}

function inferWorkspaceRoot(dotPath: string): string {
  if (isVirtualPath(dotPath)) {
    return process.cwd();
  }
  return path.dirname(path.resolve(dotPath));
}

function isVirtualPath(dotPath: string): boolean {
  return /^<[^>]+>$/.test(dotPath);
}
