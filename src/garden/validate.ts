import { evaluateConditionExpression, validateConditionExpression } from '../engine/conditions.js';
import {
  Diagnostic,
  GardenEdge,
  GardenGraph,
  GardenNode,
  SUPPORTED_SHAPES,
  normalizeShape
} from './types.js';

export function validateGarden(graph: GardenGraph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const duplicateIds = findDuplicateNodeIds(graph.nodes);
  for (const duplicateId of duplicateIds) {
    const duplicateNode = graph.nodes.find((node) => node.id === duplicateId);
    diagnostics.push({
      severity: 'error',
      code: 'DUPLICATE_NODE_ID',
      message: `Duplicate node id '${duplicateId}'.`,
      file: graph.dotPath,
      location: duplicateNode?.location
    });
  }

  const startNodes = graph.nodes.filter((node) => node.kind === 'start');
  if (startNodes.length !== 1) {
    diagnostics.push({
      severity: 'error',
      code: 'START_NODE_COUNT',
      message: `Expected exactly one start node (Mdiamond), found ${startNodes.length}.`,
      file: graph.dotPath,
      location: startNodes[0]?.location
    });
  }

  const exitNodes = graph.nodes.filter((node) => node.kind === 'exit');
  if (exitNodes.length < 1) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_EXIT',
      message: 'Expected at least one exit node (Msquare).',
      file: graph.dotPath
    });
  }

  for (const node of graph.nodes) {
    validateNodeShape(graph, node, diagnostics);
    validateNodeRetries(graph, node, diagnostics);

    if (node.kind === 'tool') {
      const script = node.attributes.script?.trim();
      if (!script) {
        diagnostics.push({
          severity: 'error',
          code: 'TOOL_SCRIPT_REQUIRED',
          message: `Tool node '${node.id}' must define a non-empty script attribute.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }
  }

  for (const edge of graph.edges) {
    if (!graph.nodeMap.has(edge.source)) {
      diagnostics.push({
        severity: 'error',
        code: 'UNKNOWN_EDGE_SOURCE',
        message: `Edge source '${edge.source}' does not reference an existing node.`,
        file: graph.dotPath,
        location: edge.location
      });
    }

    if (!graph.nodeMap.has(edge.target)) {
      diagnostics.push({
        severity: 'error',
        code: 'UNKNOWN_EDGE_TARGET',
        message: `Edge target '${edge.target}' does not reference an existing node.`,
        file: graph.dotPath,
        location: edge.location
      });
    }

    if (edge.condition) {
      try {
        validateConditionExpression(edge.condition);
        evaluateConditionExpression(edge.condition, { outcome: 'success', context: {} });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown condition syntax error.';
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_CONDITION',
          message: `Invalid edge condition '${edge.condition}': ${message}`,
          file: graph.dotPath,
          location: edge.location
        });
      }
    }
  }

  if (startNodes.length === 1 && startNodes[0]) {
    const unreachable = findUnreachableNodes(graph, startNodes[0].id);
    for (const node of unreachable) {
      diagnostics.push({
        severity: 'error',
        code: 'UNREACHABLE_NODE',
        message: `Node '${node.id}' is unreachable from the start node.`,
        file: graph.dotPath,
        location: node.location
      });
    }
  }

  const cyclesWithoutExitPath = findCyclesWithoutExitPath(graph, exitNodes.map((node) => node.id));
  for (const cycleNodeId of cyclesWithoutExitPath) {
    const node = graph.nodeMap.get(cycleNodeId);
    diagnostics.push({
      severity: 'error',
      code: 'CYCLE_WITHOUT_EXIT',
      message: `Cycle containing node '${cycleNodeId}' cannot reach an exit node.`,
      file: graph.dotPath,
      location: node?.location
    });
  }

  return sortDiagnostics(diagnostics);
}

function validateNodeShape(graph: GardenGraph, node: GardenNode, diagnostics: Diagnostic[]): void {
  const shape = normalizeShape(node.shape);
  if (!shape || !SUPPORTED_SHAPES.has(shape)) {
    diagnostics.push({
      severity: 'error',
      code: 'UNSUPPORTED_SHAPE',
      message: `Node '${node.id}' uses unsupported shape '${node.shape ?? '<missing>'}'. Supported shapes: Mdiamond, Msquare, parallelogram.`,
      file: graph.dotPath,
      location: node.location
    });
  }
}

function validateNodeRetries(graph: GardenGraph, node: GardenNode, diagnostics: Diagnostic[]): void {
  const rawRetries = node.attributes.max_retries;
  if (rawRetries === undefined) {
    return;
  }

  if (!/^\d+$/.test(rawRetries.trim())) {
    diagnostics.push({
      severity: 'error',
      code: 'INVALID_MAX_RETRIES',
      message: `Node '${node.id}' has invalid max_retries '${rawRetries}'. Expected a non-negative integer.`,
      file: graph.dotPath,
      location: node.location
    });
    return;
  }

  const value = Number.parseInt(rawRetries, 10);
  if (value < 0) {
    diagnostics.push({
      severity: 'error',
      code: 'INVALID_MAX_RETRIES',
      message: `Node '${node.id}' has invalid max_retries '${rawRetries}'. Expected a non-negative integer.`,
      file: graph.dotPath,
      location: node.location
    });
  }
}

function findDuplicateNodeIds(nodes: GardenNode[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const node of nodes) {
    if (seen.has(node.id)) {
      duplicates.add(node.id);
      continue;
    }
    seen.add(node.id);
  }

  return Array.from(duplicates);
}

function findUnreachableNodes(graph: GardenGraph, startNodeId: string): GardenNode[] {
  const reachable = new Set<string>();
  const queue: string[] = [startNodeId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    const outgoing = graph.outgoing.get(current) ?? [];
    for (const edge of outgoing) {
      if (graph.nodeMap.has(edge.target) && !reachable.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return graph.nodes.filter((node) => !reachable.has(node.id));
}

function findCyclesWithoutExitPath(graph: GardenGraph, exitNodeIds: string[]): string[] {
  const validEdges = graph.edges.filter((edge) => graph.nodeMap.has(edge.source) && graph.nodeMap.has(edge.target));
  const adjacency = new Map<string, string[]>();

  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of validEdges) {
    adjacency.get(edge.source)?.push(edge.target);
  }

  const components = stronglyConnectedComponents(adjacency);
  const cycleComponents = components.filter((component) => {
    if (component.length > 1) {
      return true;
    }
    const nodeId = component[0]!;
    return (adjacency.get(nodeId) ?? []).includes(nodeId);
  });

  if (cycleComponents.length === 0) {
    return [];
  }

  const reverseAdjacency = new Map<string, string[]>();
  for (const node of graph.nodes) {
    reverseAdjacency.set(node.id, []);
  }

  for (const edge of validEdges) {
    reverseAdjacency.get(edge.target)?.push(edge.source);
  }

  const canReachExit = new Set<string>();
  const queue = [...exitNodeIds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || canReachExit.has(current)) {
      continue;
    }

    canReachExit.add(current);
    for (const predecessor of reverseAdjacency.get(current) ?? []) {
      if (!canReachExit.has(predecessor)) {
        queue.push(predecessor);
      }
    }
  }

  const brokenCycles: string[] = [];
  for (const component of cycleComponents) {
    const hasExitPath = component.some((nodeId) => canReachExit.has(nodeId));
    if (!hasExitPath) {
      brokenCycles.push(component.slice().sort()[0]!);
    }
  }

  return brokenCycles;
}

function stronglyConnectedComponents(adjacency: Map<string, string[]>): string[][] {
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const components: string[][] = [];
  let index = 0;

  function visit(nodeId: string): void {
    indices.set(nodeId, index);
    lowLink.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const neighbor of adjacency.get(nodeId) ?? []) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        const lowNode = lowLink.get(nodeId) ?? 0;
        const lowNeighbor = lowLink.get(neighbor) ?? 0;
        lowLink.set(nodeId, Math.min(lowNode, lowNeighbor));
      } else if (onStack.has(neighbor)) {
        const lowNode = lowLink.get(nodeId) ?? 0;
        const neighborIndex = indices.get(neighbor) ?? 0;
        lowLink.set(nodeId, Math.min(lowNode, neighborIndex));
      }
    }

    if (lowLink.get(nodeId) === indices.get(nodeId)) {
      const component: string[] = [];
      while (stack.length > 0) {
        const member = stack.pop();
        if (!member) {
          break;
        }
        onStack.delete(member);
        component.push(member);
        if (member === nodeId) {
          break;
        }
      }
      components.push(component);
    }
  }

  for (const nodeId of adjacency.keys()) {
    if (!indices.has(nodeId)) {
      visit(nodeId);
    }
  }

  return components;
}

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.slice().sort((a, b) => {
    const aLine = a.location?.line ?? Number.MAX_SAFE_INTEGER;
    const bLine = b.location?.line ?? Number.MAX_SAFE_INTEGER;
    if (aLine !== bLine) {
      return aLine - bLine;
    }

    const aCol = a.location?.col ?? Number.MAX_SAFE_INTEGER;
    const bCol = b.location?.col ?? Number.MAX_SAFE_INTEGER;
    if (aCol !== bCol) {
      return aCol - bCol;
    }

    return a.code.localeCompare(b.code);
  });
}
