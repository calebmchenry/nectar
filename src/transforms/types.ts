import type { Diagnostic, GardenGraph } from '../garden/types.js';

export interface TransformResult {
  graph: GardenGraph;
  diagnostics: Diagnostic[];
}

export interface TransformContext {
  readonly workspaceRoot: string;
  readonly currentDotPath: string;
  readonly importStack: string[];
  readonly sourceFiles: Set<string>;
  parseFile(dotPath: string): Promise<GardenGraph>;
  prepareBuiltIns(dotPath: string, importStack: string[]): Promise<TransformResult>;
}

export interface Transform {
  readonly name: string;
  apply(graph: GardenGraph, context: TransformContext): Promise<TransformResult> | TransformResult;
}
