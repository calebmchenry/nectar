import path from 'node:path';
import { GardenParseError } from '../garden/parse.js';
import type { Diagnostic, GardenEdge, GardenGraph, GardenNode, SourceLocation, Subgraph } from '../garden/types.js';
import type { Transform, TransformContext, TransformResult } from './types.js';

const PLACEHOLDER_ATTRIBUTE = 'compose.dotfile';
const PREFIX_ATTRIBUTE = 'compose.prefix';
const UNSUPPORTED_CHILD_GLOBALS = ['stack.child_dotfile', 'stack.child_workdir', 'max_restart_depth'] as const;

export class ComposeImportsTransform implements Transform {
  readonly name = 'compose-imports';

  async apply(graph: GardenGraph, context: TransformContext): Promise<TransformResult> {
    const diagnostics: Diagnostic[] = [];
    const placeholderIds = graph.nodes
      .filter((node) => hasComposeImport(node))
      .map((node) => node.id);

    for (const placeholderId of placeholderIds) {
      const placeholder = graph.nodeMap.get(placeholderId);
      if (!placeholder) {
        continue;
      }

      const childDotfile = placeholder.attributes[PLACEHOLDER_ATTRIBUTE]?.trim();
      if (!childDotfile) {
        continue;
      }

      const prefix = placeholder.attributes[PREFIX_ATTRIBUTE]?.trim() || placeholder.id;
      if (prefix.length === 0) {
        diagnostics.push(buildPlaceholderDiagnostic({
          code: 'COMPOSE_PREFIX_EMPTY',
          message: `Node '${placeholder.id}' must define a non-empty ${PREFIX_ATTRIBUTE}.`,
          currentDotPath: context.currentDotPath,
          location: placeholder.location,
        }));
        continue;
      }

      const resolved = resolveChildPath(childDotfile, context.currentDotPath, context.workspaceRoot);
      if (!resolved.ok) {
        diagnostics.push(buildPlaceholderDiagnostic({
          code: resolved.code,
          message: `Node '${placeholder.id}' has invalid ${PLACEHOLDER_ATTRIBUTE} '${childDotfile}': ${resolved.message}`,
          currentDotPath: context.currentDotPath,
          location: placeholder.location,
        }));
        continue;
      }

      const childPath = resolved.path;
      if (context.importStack.includes(childPath) || childPath === context.currentDotPath) {
        const cyclePath = [...context.importStack, context.currentDotPath, childPath];
        diagnostics.push(buildPlaceholderDiagnostic({
          code: 'COMPOSE_IMPORT_CYCLE',
          message: `Import cycle detected while composing '${childPath}': ${cyclePath.join(' -> ')}`,
          currentDotPath: context.currentDotPath,
          location: placeholder.location,
        }));
        continue;
      }

      let childResult: TransformResult;
      try {
        childResult = await context.prepareBuiltIns(childPath, [...context.importStack, context.currentDotPath]);
      } catch (error) {
        diagnostics.push(buildChildLoadDiagnostic(error, childPath, placeholder, context.currentDotPath));
        continue;
      }

      diagnostics.push(...childResult.diagnostics);
      if (childResult.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        diagnostics.push(buildPlaceholderDiagnostic({
          code: 'COMPOSE_CHILD_INVALID',
          message: `Cannot compose '${childPath}' into node '${placeholder.id}' because the child graph has validation errors.`,
          currentDotPath: context.currentDotPath,
          location: placeholder.location,
        }));
        continue;
      }

      const childGraph = childResult.graph;
      const unsupportedGlobals = collectUnsupportedChildGlobals(childGraph);
      if (unsupportedGlobals.length > 0) {
        diagnostics.push(buildPlaceholderDiagnostic({
          code: 'COMPOSE_UNSUPPORTED_CHILD_GLOBALS',
          message: `Child graph '${childGraph.dotPath}' uses unsupported graph attributes: ${unsupportedGlobals.join(', ')}.`,
          currentDotPath: context.currentDotPath,
          location: placeholder.location,
        }));
        continue;
      }

      const startNodes = childGraph.nodes.filter((node) => node.kind === 'start' && !node.provenance);
      if (startNodes.length !== 1 || !startNodes[0]) {
        diagnostics.push(buildPlaceholderDiagnostic({
          code: 'COMPOSE_CHILD_START_COUNT',
          message: `Child graph '${childGraph.dotPath}' must have exactly one start node for composition, found ${startNodes.length}.`,
          currentDotPath: context.currentDotPath,
          location: placeholder.location,
        }));
        continue;
      }

      const exitNodes = childGraph.nodes.filter((node) => node.kind === 'exit' && !node.provenance);
      if (exitNodes.length !== 1 || !exitNodes[0]) {
        diagnostics.push(buildPlaceholderDiagnostic({
          code: 'COMPOSE_CHILD_EXIT_COUNT',
          message: `Child graph '${childGraph.dotPath}' must have exactly one exit node for composition, found ${exitNodes.length}.`,
          currentDotPath: context.currentDotPath,
          location: placeholder.location,
        }));
        continue;
      }

      const namespacedNodes = childGraph.nodes.map((node) => namespaceNode(node, prefix, childGraph.dotPath));
      materializeChildDefaults(childGraph, namespacedNodes);
      const namespacedEdges = childGraph.edges.map((edge) => namespaceEdge(edge, prefix, childGraph.dotPath));
      const namespacedSubgraphs = childGraph.subgraphs.map((subgraph) => namespaceSubgraph(subgraph, prefix, childGraph.dotPath));

      const collision = namespacedNodes.find((node) => graph.nodeMap.has(node.id) && node.id !== placeholder.id);
      if (collision) {
        diagnostics.push(buildPlaceholderDiagnostic({
          code: 'COMPOSE_PREFIX_COLLISION',
          message: `Composed node '${collision.id}' collides with an existing node. Adjust ${PREFIX_ATTRIBUTE} on '${placeholder.id}'.`,
          currentDotPath: context.currentDotPath,
          location: placeholder.location,
        }));
        continue;
      }

      const existingSubgraphIds = new Set(graph.subgraphs.map((subgraph) => subgraph.id));
      const subgraphCollision = namespacedSubgraphs.find((subgraph) => existingSubgraphIds.has(subgraph.id));
      if (subgraphCollision) {
        diagnostics.push(buildPlaceholderDiagnostic({
          code: 'COMPOSE_PREFIX_COLLISION',
          message: `Composed subgraph '${subgraphCollision.id}' collides with an existing subgraph. Adjust ${PREFIX_ATTRIBUTE} on '${placeholder.id}'.`,
          currentDotPath: context.currentDotPath,
          location: placeholder.location,
        }));
        continue;
      }

      const startNode = startNodes[0];
      const exitNode = exitNodes[0];
      if (!startNode || !exitNode) {
        continue;
      }

      mergeComposedChild(graph, {
        placeholderId: placeholder.id,
        childStartId: `${prefix}__${startNode.id}`,
        childExitId: `${prefix}__${exitNode.id}`,
        importedNodes: namespacedNodes,
        importedEdges: namespacedEdges,
        importedSubgraphs: namespacedSubgraphs,
      });
    }

    rebuildIndexes(graph);
    return { graph, diagnostics };
  }
}

function hasComposeImport(node: GardenNode): boolean {
  const value = node.attributes[PLACEHOLDER_ATTRIBUTE];
  return typeof value === 'string' && value.trim().length > 0;
}

function namespaceNode(node: GardenNode, prefix: string, dotPath: string): GardenNode {
  const namespacedId = `${prefix}__${node.id}`;
  return {
    ...node,
    id: namespacedId,
    classes: node.classes.slice(),
    attributes: { ...node.attributes },
    location: node.location ? { ...node.location } : undefined,
    provenance: {
      dotPath,
      originalId: node.id,
    },
  };
}

function namespaceEdge(edge: GardenEdge, prefix: string, dotPath: string): GardenEdge {
  return {
    ...edge,
    source: `${prefix}__${edge.source}`,
    target: `${prefix}__${edge.target}`,
    attributes: { ...edge.attributes },
    location: edge.location ? { ...edge.location } : undefined,
    provenance: {
      dotPath,
      originalSource: edge.source,
      originalTarget: edge.target,
    },
  };
}

function namespaceSubgraph(subgraph: Subgraph, prefix: string, dotPath: string): Subgraph {
  return {
    ...subgraph,
    id: `${prefix}__${subgraph.id}`,
    nodeIds: subgraph.nodeIds.map((nodeId) => `${prefix}__${nodeId}`),
    provenance: {
      dotPath,
      originalId: subgraph.id,
    },
  };
}

function materializeChildDefaults(childGraph: GardenGraph, nodes: GardenNode[]): void {
  for (const node of nodes) {
    if (node.maxRetries === undefined && childGraph.defaultMaxRetries !== undefined) {
      node.maxRetries = childGraph.defaultMaxRetries;
      node.attributes.max_retries = String(childGraph.defaultMaxRetries);
    }

    if (node.fidelity === undefined && childGraph.defaultFidelity) {
      node.fidelity = childGraph.defaultFidelity;
      node.attributes.fidelity = childGraph.defaultFidelity;
    }

    if (!node.toolHooksPre && childGraph.toolHooksPre) {
      node.toolHooksPre = childGraph.toolHooksPre;
      node.attributes['tool_hooks.pre'] = childGraph.toolHooksPre;
    }

    if (!node.toolHooksPost && childGraph.toolHooksPost) {
      node.toolHooksPost = childGraph.toolHooksPost;
      node.attributes['tool_hooks.post'] = childGraph.toolHooksPost;
    }

    if (childGraph.graphAttributes.goal && node.attributes.goal === undefined) {
      node.attributes.goal = childGraph.graphAttributes.goal;
    }

    if (childGraph.modelStylesheet && node.attributes.model_stylesheet === undefined) {
      node.attributes.model_stylesheet = childGraph.modelStylesheet;
    }
  }
}

function collectUnsupportedChildGlobals(graph: GardenGraph): string[] {
  const unsupported: string[] = [];
  if (graph.childDotfile) {
    unsupported.push('stack.child_dotfile');
  }
  if (graph.childWorkdir) {
    unsupported.push('stack.child_workdir');
  }
  if (graph.maxRestartDepth !== undefined) {
    unsupported.push('max_restart_depth');
  }
  return unsupported;
}

function mergeComposedChild(
  graph: GardenGraph,
  input: {
    placeholderId: string;
    childStartId: string;
    childExitId: string;
    importedNodes: GardenNode[];
    importedEdges: GardenEdge[];
    importedSubgraphs: Subgraph[];
  },
): void {
  const retainedNodes: GardenNode[] = [];
  for (const node of graph.nodes) {
    if (node.id !== input.placeholderId) {
      retainedNodes.push(node);
    }
  }
  graph.nodes = [...retainedNodes, ...input.importedNodes];

  const rewiredEdges: GardenEdge[] = [];
  const retainedEdges: GardenEdge[] = [];
  for (const edge of graph.edges) {
    const touchesSource = edge.source === input.placeholderId;
    const touchesTarget = edge.target === input.placeholderId;
    if (!touchesSource && !touchesTarget) {
      retainedEdges.push(edge);
      continue;
    }

    if (touchesSource && touchesTarget) {
      rewiredEdges.push({ ...edge, source: input.childExitId, target: input.childStartId, attributes: { ...edge.attributes } });
      continue;
    }

    if (touchesSource) {
      rewiredEdges.push({ ...edge, source: input.childExitId, attributes: { ...edge.attributes } });
      continue;
    }

    rewiredEdges.push({ ...edge, target: input.childStartId, attributes: { ...edge.attributes } });
  }

  graph.edges = [...retainedEdges, ...rewiredEdges, ...input.importedEdges];

  const importedNodeIds = input.importedNodes.map((node) => node.id);
  const rewrittenSubgraphs = graph.subgraphs.map((subgraph) => {
    const rewrittenNodeIds: string[] = [];
    for (const nodeId of subgraph.nodeIds) {
      if (nodeId === input.placeholderId) {
        rewrittenNodeIds.push(...importedNodeIds);
      } else {
        rewrittenNodeIds.push(nodeId);
      }
    }

    return {
      ...subgraph,
      nodeIds: dedupeStable(rewrittenNodeIds),
    };
  });

  graph.subgraphs = [...rewrittenSubgraphs, ...input.importedSubgraphs];
  rebuildIndexes(graph);
}

function dedupeStable(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function rebuildIndexes(graph: GardenGraph): void {
  graph.nodeMap.clear();
  graph.outgoing.clear();
  graph.incoming.clear();

  for (const node of graph.nodes) {
    graph.nodeMap.set(node.id, node);
    graph.outgoing.set(node.id, []);
    graph.incoming.set(node.id, []);
  }

  for (const edge of graph.edges) {
    const outgoing = graph.outgoing.get(edge.source);
    if (outgoing) {
      outgoing.push(edge);
    }
    const incoming = graph.incoming.get(edge.target);
    if (incoming) {
      incoming.push(edge);
    }
  }
}

function buildPlaceholderDiagnostic(input: {
  code: string;
  message: string;
  currentDotPath: string;
  location?: SourceLocation;
}): Diagnostic {
  return {
    severity: 'error',
    code: input.code,
    message: input.message,
    file: input.currentDotPath,
    location: input.location,
  };
}

function buildChildLoadDiagnostic(error: unknown, childPath: string, placeholder: GardenNode, currentDotPath: string): Diagnostic {
  if (error instanceof GardenParseError) {
    return {
      severity: 'error',
      code: 'COMPOSE_CHILD_PARSE_ERROR',
      message: `Failed to parse composed child '${childPath}': ${error.message}`,
      file: childPath,
      location: error.location,
    };
  }

  const err = error as NodeJS.ErrnoException;
  if (err?.code === 'ENOENT') {
    return {
      severity: 'error',
      code: 'COMPOSE_CHILD_MISSING',
      message: `Composed child '${childPath}' does not exist for node '${placeholder.id}'.`,
      file: currentDotPath,
      location: placeholder.location,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    severity: 'error',
    code: 'COMPOSE_CHILD_LOAD_ERROR',
    message: `Failed to load composed child '${childPath}': ${message}`,
    file: currentDotPath,
    location: placeholder.location,
  };
}

function resolveChildPath(
  childDotfile: string,
  currentDotPath: string,
  workspaceRoot: string,
):
  | { ok: true; path: string }
  | { ok: false; code: string; message: string } {
  if (path.isAbsolute(childDotfile)) {
    return {
      ok: false,
      code: 'COMPOSE_OUTSIDE_WORKSPACE',
      message: 'absolute paths are not allowed',
    };
  }

  const baseDir = path.dirname(currentDotPath);
  const resolvedPath = path.resolve(baseDir, childDotfile);
  const relativeToWorkspace = path.relative(workspaceRoot, resolvedPath);
  if (relativeToWorkspace.startsWith('..') || path.isAbsolute(relativeToWorkspace)) {
    return {
      ok: false,
      code: 'COMPOSE_OUTSIDE_WORKSPACE',
      message: 'resolved path escapes the workspace root',
    };
  }

  return { ok: true, path: resolvedPath };
}

export function isUnsupportedChildGlobal(attribute: string): boolean {
  return UNSUPPORTED_CHILD_GLOBALS.includes(attribute as (typeof UNSUPPORTED_CHILD_GLOBALS)[number]);
}
