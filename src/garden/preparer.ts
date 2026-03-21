import { createHash } from 'node:crypto';
import path from 'node:path';
import { GardenParseError, parseGardenFile, parseGardenSource } from './parse.js';
import { serializeGardenGraph } from './serialize.js';
import type { Diagnostic, GardenGraph } from './types.js';
import { validateGarden } from './validate.js';
import { GoalExpansionTransform } from '../transforms/goal-expansion.js';
import { StylesheetApplyTransform } from '../transforms/stylesheet-apply.js';
import { ComposeImportsTransform } from '../transforms/compose-imports.js';
import { TransformRegistry } from '../transforms/registry.js';
import type { Transform, TransformContext, TransformResult } from '../transforms/types.js';

export interface PipelinePreparerOptions {
  workspaceRoot?: string;
}

export interface PreparedGardenResult {
  graph: GardenGraph;
  diagnostics: Diagnostic[];
  prepared_dot: string;
  graph_hash: string;
  source_files: string[];
}

interface PrepareGraphOptions {
  currentDotPath: string;
  importStack: string[];
  sourceFiles: Set<string>;
  includeCustomTransforms: boolean;
}

export class PipelinePreparer {
  private readonly workspaceRoot: string;
  private readonly customTransforms = new TransformRegistry();
  private readonly builtInTransforms: Transform[];

  constructor(options: PipelinePreparerOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.builtInTransforms = [
      new GoalExpansionTransform(),
      new StylesheetApplyTransform(),
      new ComposeImportsTransform(),
    ];
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  registerTransform(transform: Transform): void {
    this.customTransforms.register(transform);
  }

  unregisterTransform(name: string): boolean {
    return this.customTransforms.unregister(name);
  }

  clearTransforms(): void {
    this.customTransforms.clear();
  }

  listTransforms(): Transform[] {
    return this.customTransforms.getAll();
  }

  async prepareFromPath(dotPath: string): Promise<PreparedGardenResult> {
    const sourceFiles = new Set<string>();
    const absolutePath = this.resolveWorkspacePath(dotPath);
    const graph = await parseGardenFile(absolutePath);
    sourceFiles.add(graph.dotPath);

    return this.prepareGraph(graph, {
      currentDotPath: graph.dotPath,
      importStack: [],
      sourceFiles,
      includeCustomTransforms: true,
    });
  }

  async prepareFromSource(dotSource: string, dotPath = '<memory>'): Promise<PreparedGardenResult> {
    const sourceFiles = new Set<string>();
    const normalizedDotPath = this.normalizeDotPath(dotPath);
    const graph = parseGardenSource(dotSource, normalizedDotPath);
    if (path.isAbsolute(normalizedDotPath)) {
      sourceFiles.add(normalizedDotPath);
    }

    return this.prepareGraph(graph, {
      currentDotPath: normalizedDotPath,
      importStack: [],
      sourceFiles,
      includeCustomTransforms: true,
    });
  }

  private async prepareGraph(graph: GardenGraph, options: PrepareGraphOptions): Promise<PreparedGardenResult> {
    const diagnostics: Diagnostic[] = [];
    let currentGraph = graph;

    for (const transform of this.builtInTransforms) {
      const result = await this.applyTransform(transform, currentGraph, options);
      currentGraph = result.graph;
      diagnostics.push(...result.diagnostics);
    }

    if (options.includeCustomTransforms) {
      for (const transform of this.customTransforms.getAll()) {
        const result = await this.applyTransform(transform, currentGraph, options);
        currentGraph = result.graph;
        diagnostics.push(...result.diagnostics);
      }
    }

    diagnostics.push(...validateGarden(currentGraph));

    const preparedDot = serializeGardenGraph(currentGraph);
    const graphHash = createHash('sha256').update(preparedDot).digest('hex');

    return {
      graph: currentGraph,
      diagnostics,
      prepared_dot: preparedDot,
      graph_hash: graphHash,
      source_files: Array.from(options.sourceFiles).sort((a, b) => a.localeCompare(b)),
    };
  }

  private async applyTransform(
    transform: Transform,
    graph: GardenGraph,
    options: PrepareGraphOptions,
  ): Promise<TransformResult> {
    const context = this.createContext(options.currentDotPath, options.importStack, options.sourceFiles);
    return transform.apply(graph, context);
  }

  private createContext(currentDotPath: string, importStack: string[], sourceFiles: Set<string>): TransformContext {
    return {
      workspaceRoot: this.workspaceRoot,
      currentDotPath,
      importStack,
      sourceFiles,
      parseFile: async (dotPath: string): Promise<GardenGraph> => {
        const absolutePath = this.resolveWorkspacePath(dotPath);
        const parsed = await parseGardenFile(absolutePath);
        sourceFiles.add(parsed.dotPath);
        return parsed;
      },
      prepareBuiltIns: async (dotPath: string, nestedImportStack: string[]): Promise<TransformResult> => {
        const absolutePath = this.resolveWorkspacePath(dotPath);
        const childGraph = await parseGardenFile(absolutePath);
        sourceFiles.add(childGraph.dotPath);

        const prepared = await this.prepareGraph(childGraph, {
          currentDotPath: childGraph.dotPath,
          importStack: nestedImportStack,
          sourceFiles,
          includeCustomTransforms: false,
        });

        return {
          graph: prepared.graph,
          diagnostics: prepared.diagnostics,
        };
      },
    };
  }

  private resolveWorkspacePath(dotPath: string): string {
    const absolutePath = path.isAbsolute(dotPath)
      ? path.resolve(dotPath)
      : path.resolve(this.workspaceRoot, dotPath);

    const relative = path.relative(this.workspaceRoot, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path '${dotPath}' resolves outside workspace root '${this.workspaceRoot}'.`);
    }

    return absolutePath;
  }

  private normalizeDotPath(dotPath: string): string {
    if (isVirtualPath(dotPath)) {
      return dotPath;
    }

    return this.resolveWorkspacePath(dotPath);
  }
}

function isVirtualPath(dotPath: string): boolean {
  return /^<[^>]+>$/.test(dotPath);
}

export { GardenParseError };
