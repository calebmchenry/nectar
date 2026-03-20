import { evaluateConditionExpression, validateConditionExpression } from '../engine/conditions.js';
import {
  Diagnostic,
  GardenEdge,
  GardenGraph,
  GardenNode,
  SUPPORTED_SHAPES,
  normalizeShape
} from './types.js';
import { parseStylesheet } from './stylesheet.js';
import { parseTimeoutMs } from './parse.js';

export function validateGarden(graph: GardenGraph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // stylesheet_syntax: validate model_stylesheet if present
  if (graph.modelStylesheet) {
    const { errors } = parseStylesheet(graph.modelStylesheet, graph.dotPath);
    for (const err of errors) {
      if (err.severity === 'error') {
        diagnostics.push({
          severity: 'error',
          code: 'STYLESHEET_SYNTAX',
          message: err.message,
          file: graph.dotPath,
        });
      }
    }
  }

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

  // start_no_incoming: start nodes must have no incoming edges
  for (const startNode of startNodes) {
    const incoming = graph.incoming.get(startNode.id) ?? [];
    if (incoming.length > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'START_NO_INCOMING',
        message: `Start node '${startNode.id}' must have no incoming edges, found ${incoming.length}.`,
        file: graph.dotPath,
        location: startNode.location
      });
    }
  }

  // exit_no_outgoing: exit nodes must have no outgoing edges
  for (const exitNode of exitNodes) {
    const outgoing = graph.outgoing.get(exitNode.id) ?? [];
    if (outgoing.length > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'EXIT_NO_OUTGOING',
        message: `Exit node '${exitNode.id}' must have no outgoing edges, found ${outgoing.length}.`,
        file: graph.dotPath,
        location: exitNode.location
      });
    }
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

    // type_known: node types are recognized
    if (node.kind === 'unknown') {
      diagnostics.push({
        severity: 'warning',
        code: 'TYPE_UNKNOWN',
        message: `Node '${node.id}' has unrecognized type (shape='${node.shape ?? '<missing>'}').`,
        file: graph.dotPath,
        location: node.location
      });
    }

    // fidelity_valid: fidelity values are spec-defined string enums
    const fidelity = node.attributes.fidelity;
    if (fidelity !== undefined) {
      const validFidelityValues = new Set([
        'full', 'truncate', 'compact',
        'summary:low', 'summary:medium', 'summary:high'
      ]);
      if (!validFidelityValues.has(fidelity.trim())) {
        diagnostics.push({
          severity: 'warning',
          code: 'FIDELITY_INVALID',
          message: `Node '${node.id}' has invalid fidelity '${fidelity}'. Expected one of: full, truncate, compact, summary:low, summary:medium, summary:high.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // retry_target_exists: retry_target references existing nodes
    if (node.retryTarget && !graph.nodeMap.has(node.retryTarget)) {
      diagnostics.push({
        severity: 'warning',
        code: 'RETRY_TARGET_MISSING',
        message: `Node '${node.id}' has retry_target '${node.retryTarget}' which does not exist in the graph.`,
        file: graph.dotPath,
        location: node.location
      });
    }
    if (node.fallbackRetryTarget && !graph.nodeMap.has(node.fallbackRetryTarget)) {
      diagnostics.push({
        severity: 'warning',
        code: 'RETRY_TARGET_MISSING',
        message: `Node '${node.id}' has fallback_retry_target '${node.fallbackRetryTarget}' which does not exist in the graph.`,
        file: graph.dotPath,
        location: node.location
      });
    }

    // goal_gate_has_retry: goal_gate nodes should have retry_target
    if (node.goalGate && !node.retryTarget && !node.fallbackRetryTarget) {
      const graphRetry = graph.graphAttributes.retry_target ?? graph.graphAttributes.fallback_retry_target;
      if (!graphRetry) {
        diagnostics.push({
          severity: 'warning',
          code: 'GOAL_GATE_NO_RETRY',
          message: `Goal gate node '${node.id}' has no retry_target defined (node-level or graph-level).`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // parallel_has_outgoing: component nodes must have >= 2 outgoing edges
    if (node.kind === 'parallel') {
      const outgoing = graph.outgoing.get(node.id) ?? [];
      if (outgoing.length < 2) {
        diagnostics.push({
          severity: 'warning',
          code: 'PARALLEL_HAS_OUTGOING',
          message: `Parallel node '${node.id}' (component shape) should have at least 2 outgoing edges, found ${outgoing.length}.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // fan_in_topology: warn if tripleoctagon has no component ancestor
    if (node.kind === 'parallel.fan_in') {
      const hasParallelAncestor = hasAncestorOfKind(graph, node.id, 'parallel');
      if (!hasParallelAncestor) {
        diagnostics.push({
          severity: 'warning',
          code: 'FAN_IN_TOPOLOGY',
          message: `Fan-in node '${node.id}' (tripleoctagon shape) has no upstream parallel (component) ancestor.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // parallel_has_fan_in: warn if component has no reachable tripleoctagon downstream
    if (node.kind === 'parallel') {
      const fanInNodes = graph.nodes.filter((n) => n.kind === 'parallel.fan_in');
      const hasReachableFanIn = fanInNodes.some((fi) => canReachNode(graph, node.id, fi.id));
      if (!hasReachableFanIn) {
        diagnostics.push({
          severity: 'warning',
          code: 'PARALLEL_HAS_FAN_IN',
          message: `Parallel node '${node.id}' (component shape) has no reachable fan-in (tripleoctagon) downstream.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // Validate join_policy values
    if (node.attributes.join_policy !== undefined) {
      const policy = node.attributes.join_policy.trim();
      if (policy !== 'wait_all' && policy !== 'first_success') {
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_JOIN_POLICY',
          message: `Node '${node.id}' has invalid join_policy '${policy}'. Expected 'wait_all' or 'first_success'.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // Validate max_parallel values
    if (node.attributes.max_parallel !== undefined) {
      const raw = node.attributes.max_parallel.trim();
      const val = Number.parseInt(raw, 10);
      if (!/^\d+$/.test(raw) || val <= 0) {
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_MAX_PARALLEL',
          message: `Node '${node.id}' has invalid max_parallel '${raw}'. Expected a positive integer.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // reasoning_effort validation
    if (node.reasoningEffort !== undefined) {
      const validEfforts = new Set(['low', 'medium', 'high']);
      if (!validEfforts.has(node.reasoningEffort)) {
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_REASONING_EFFORT',
          message: `Node '${node.id}' has invalid reasoning_effort '${node.reasoningEffort}'. Expected one of: low, medium, high.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // llm_provider validation
    if (node.llmProvider !== undefined) {
      const knownProviders = new Set(['anthropic', 'openai', 'gemini', 'simulation']);
      if (!knownProviders.has(node.llmProvider)) {
        diagnostics.push({
          severity: 'warning',
          code: 'UNKNOWN_LLM_PROVIDER',
          message: `Node '${node.id}' has unknown llm_provider '${node.llmProvider}'. Known providers: anthropic, openai, gemini, simulation.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // prompt_on_llm_nodes: box nodes should have prompt attribute
    if (node.kind === 'codergen' && !node.prompt && !node.attributes.prompt) {
      diagnostics.push({
        severity: 'warning',
        code: 'PROMPT_MISSING',
        message: `LLM node '${node.id}' (box shape) has no prompt attribute defined.`,
        file: graph.dotPath,
        location: node.location
      });
    }

    // Manager node validation
    if (node.kind === 'stack.manager_loop') {
      // manager.actions must be subset of {observe, steer, wait}
      if (node.managerActions) {
        const validActions = new Set(['observe', 'steer', 'wait']);
        for (const action of node.managerActions) {
          if (!validActions.has(action)) {
            diagnostics.push({
              severity: 'error',
              code: 'INVALID_MANAGER_ACTIONS',
              message: `Manager node '${node.id}' has invalid action '${action}'. Valid actions: observe, steer, wait.`,
              file: graph.dotPath,
              location: node.location
            });
          }
        }
      }

      // manager.max_cycles must be a positive integer
      const rawMaxCycles = node.attributes['manager.max_cycles'];
      if (rawMaxCycles !== undefined) {
        const val = Number.parseInt(rawMaxCycles.trim(), 10);
        if (!/^\d+$/.test(rawMaxCycles.trim()) || val <= 0) {
          diagnostics.push({
            severity: 'error',
            code: 'INVALID_MANAGER_MAX_CYCLES',
            message: `Manager node '${node.id}' has invalid manager.max_cycles '${rawMaxCycles}'. Expected a positive integer.`,
            file: graph.dotPath,
            location: node.location
          });
        }
      }

      // manager.poll_interval must parse as a duration
      const rawPollInterval = node.attributes['manager.poll_interval'];
      if (rawPollInterval !== undefined) {
        const parsed = parseTimeoutMs(rawPollInterval);
        if (parsed === undefined) {
          diagnostics.push({
            severity: 'error',
            code: 'INVALID_MANAGER_POLL_INTERVAL',
            message: `Manager node '${node.id}' has invalid manager.poll_interval '${rawPollInterval}'. Expected a duration (e.g. 5s, 1m).`,
            file: graph.dotPath,
            location: node.location
          });
        }
      }

      // manager.stop_condition must parse with condition evaluator
      if (node.managerStopCondition) {
        try {
          validateConditionExpression(node.managerStopCondition);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown condition syntax error.';
          diagnostics.push({
            severity: 'error',
            code: 'INVALID_MANAGER_STOP_CONDITION',
            message: `Manager node '${node.id}' has invalid manager.stop_condition '${node.managerStopCondition}': ${message}`,
            file: graph.dotPath,
            location: node.location
          });
        }
      }

      // steer in actions requires non-empty prompt — ERROR per spec
      if (node.managerActions?.includes('steer') && !node.prompt) {
        diagnostics.push({
          severity: 'error',
          code: 'MANAGER_STEER_NO_PROMPT',
          message: `Manager node '${node.id}' has 'steer' action but no prompt attribute.`,
          file: graph.dotPath,
          location: node.location
        });
      }

      // manager.poll_interval minimum 1s enforced
      if (node.managerPollIntervalMs !== undefined && node.managerPollIntervalMs < 1000) {
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_MANAGER_POLL_INTERVAL',
          message: `Manager node '${node.id}' has manager.poll_interval less than minimum 1s.`,
          file: graph.dotPath,
          location: node.location
        });
      }

      // child_autostart true or absent requires stack.child_dotfile
      const autostart = node.childAutostart !== false;
      if (autostart && !graph.childDotfile) {
        diagnostics.push({
          severity: 'error',
          code: 'MANAGER_MISSING_CHILD_DOTFILE',
          message: `Manager node '${node.id}' with child_autostart requires graph-level stack.child_dotfile.`,
          file: graph.dotPath,
          location: node.location
        });
      }
    }

    // tool_hooks on non-codergen nodes
    if (node.toolHooksPre || node.toolHooksPost) {
      if (node.kind !== 'codergen' && node.kind !== 'stack.manager_loop') {
        diagnostics.push({
          severity: 'warning',
          code: 'TOOL_HOOKS_NON_CODERGEN',
          message: `Node '${node.id}' has tool_hooks but is not a codergen node (no runtime effect).`,
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

    // loop_restart on edge from exit node is nonsensical
    if (edge.loopRestart) {
      const sourceNode = graph.nodeMap.get(edge.source);
      if (sourceNode?.kind === 'exit') {
        diagnostics.push({
          severity: 'warning',
          code: 'LOOP_RESTART_FROM_EXIT',
          message: `Edge from exit node '${edge.source}' has loop_restart=true, which is nonsensical.`,
          file: graph.dotPath,
          location: edge.location
        });
      }
      // Invalid target node
      if (!graph.nodeMap.has(edge.target)) {
        diagnostics.push({
          severity: 'error',
          code: 'LOOP_RESTART_INVALID_TARGET',
          message: `loop_restart edge target '${edge.target}' does not exist in the graph.`,
          file: graph.dotPath,
          location: edge.location
        });
      }
      // Unconditional loop_restart — likely infinite loop
      if (!edge.condition) {
        diagnostics.push({
          severity: 'warning',
          code: 'LOOP_RESTART_UNCONDITIONAL',
          message: `Edge from '${edge.source}' to '${edge.target}' has loop_restart=true but no condition (likely infinite loop).`,
          file: graph.dotPath,
          location: edge.location
        });
      }
    }
  }

  // reachability: all nodes reachable from start via BFS
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
      message: `Node '${node.id}' uses unsupported shape '${node.shape ?? '<missing>'}'. Supported shapes: Mdiamond, Msquare, parallelogram, box, diamond, hexagon, component, tripleoctagon, house.`,
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

function hasAncestorOfKind(graph: GardenGraph, nodeId: string, kind: string): boolean {
  const visited = new Set<string>();
  const queue: string[] = [];

  // Walk backwards via incoming edges
  for (const edge of graph.incoming.get(nodeId) ?? []) {
    queue.push(edge.source);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const node = graph.nodeMap.get(current);
    if (node && node.kind === kind) {
      return true;
    }

    for (const edge of graph.incoming.get(current) ?? []) {
      if (!visited.has(edge.source)) {
        queue.push(edge.source);
      }
    }
  }

  return false;
}

function canReachNode(graph: GardenGraph, fromId: string, toId: string): boolean {
  const visited = new Set<string>();
  const queue = [fromId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const edge of graph.outgoing.get(current) ?? []) {
      if (!visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return false;
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
