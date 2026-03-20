import type { GardenGraph, GardenNode } from '../garden/types.js';

export function resolveThreadId(
  node: GardenNode,
  incomingEdge: { thread_id?: string; threadId?: string } | undefined,
  graph: GardenGraph,
  previousThreadId: string | null
): string | null {
  // 1. Target node thread_id attribute
  if (node.threadId) {
    return node.threadId;
  }

  // 2. Incoming edge thread_id attribute
  const edgeThreadId = incomingEdge?.thread_id ?? incomingEdge?.threadId;
  if (edgeThreadId) {
    return edgeThreadId;
  }

  // 3. Graph-level thread_id default
  const graphThreadId = graph.graphAttributes.thread_id?.trim();
  if (graphThreadId) {
    return graphThreadId;
  }

  // 4. First class in node.classes (subgraph class derivation)
  if (node.classes.length > 0) {
    return node.classes[0]!;
  }

  // 5. Previous completed node's thread ID (continuity default)
  if (previousThreadId) {
    return previousThreadId;
  }

  // No thread — fresh ephemeral session
  return null;
}
