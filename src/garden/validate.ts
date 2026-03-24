import path from 'node:path';
import { evaluateConditionAst, parseConditionAst } from '../engine/conditions.js';
import { collectVariableReferences, ConditionExpr } from '../engine/condition-parser.js';
import { getRetryPreset, listRetryPresetNames } from '../engine/retry.js';
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
import {
  detectPortabilityRisks,
  extractToolCommandHead,
  isExecutableOnPath,
  isPathLikeCommandHead,
  isShellBuiltin,
} from './tool-command-lint.js';

const EMPTY_ARTIFACT_SCOPE = {
  has: (_key: string) => false,
  get: (_key: string) => undefined as string | undefined,
};

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
      file: duplicateNode?.provenance?.dotPath ?? graph.dotPath,
      location: duplicateNode?.location
    });
  }

  const startNodes = graph.nodes.filter((node) => node.kind === 'start');
  const rootStartNodes = startNodes.filter((node) => !node.provenance);
  if (rootStartNodes.length !== 1) {
    diagnostics.push({
      severity: 'error',
      code: 'START_NODE_COUNT',
      message: `Expected exactly one start node (Mdiamond), found ${rootStartNodes.length}.`,
      file: graph.dotPath,
      location: rootStartNodes[0]?.location
    });
  }

  const exitNodes = graph.nodes.filter((node) => node.kind === 'exit');
  const rootExitNodes = exitNodes.filter((node) => !node.provenance);
  if (rootExitNodes.length !== 1) {
    diagnostics.push({
      severity: 'error',
      code: 'EXIT_NODE_COUNT',
      message: `Expected exactly one root exit node (Msquare), found ${rootExitNodes.length}.`,
      file: graph.dotPath,
      location: rootExitNodes[0]?.location
    });
  }

  // start_no_incoming: start nodes must have no incoming edges
  for (const startNode of rootStartNodes) {
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
  for (const exitNode of rootExitNodes) {
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
    const nodeFile = node.provenance?.dotPath ?? graph.dotPath;
    validateNodeShape(graph, node, diagnostics);
    validateNodeRetries(graph, node, diagnostics);
    validateNodeRetryPolicy(graph, node, diagnostics);

    const explicitToolCommand = node.attributes.tool_command?.trim();
    const script = node.attributes.script?.trim();
    const effectiveToolCommand = node.toolCommand ?? explicitToolCommand ?? script;
    const hasShapeMismatchToolCommand = node.kind === 'codergen' && Boolean(effectiveToolCommand);

    if (hasShapeMismatchToolCommand) {
      diagnostics.push({
        severity: 'warning',
        code: 'SHAPE_MISMATCH_TOOL_COMMAND',
        message: `Node '${node.id}' has tool_command but box shape — did you mean shape=parallelogram?`,
        file: nodeFile,
        location: node.location,
        node_id: node.id,
        fix: 'Change shape to parallelogram, or remove tool_command and use prompt instead.',
      });
    }

    if (script) {
      diagnostics.push({
        severity: 'warning',
        code: 'SCRIPT_DEPRECATED',
        message: `The 'script' attribute is deprecated. Use 'tool_command' instead.`,
        file: nodeFile,
        location: node.location,
        node_id: node.id,
        fix: `Replace script=... with tool_command=... on node '${node.id}'.`,
      });
    }

    if (node.kind === 'tool') {
      if (!effectiveToolCommand) {
        diagnostics.push({
          severity: 'error',
          code: 'TOOL_SCRIPT_REQUIRED',
          message: `Tool node '${node.id}' must define a non-empty tool_command (or legacy script) attribute.`,
          file: nodeFile,
          location: node.location,
          node_id: node.id,
          fix: `Set ${node.id} [tool_command="echo hello"] (or add legacy script).`,
        });
      } else {
        diagnostics.push({
          severity: 'info',
          code: 'SHELL_ALIAS_INFO',
          message: 'Note: tool_command runs in a non-interactive shell. Shell aliases are not available. Use full command paths and flags.',
          file: nodeFile,
          location: node.location,
          node_id: node.id,
        });

        const head = extractToolCommandHead(effectiveToolCommand);
        if (
          head
          && !isPathLikeCommandHead(head)
          && !isShellBuiltin(head)
          && !isExecutableOnPath(head)
        ) {
          diagnostics.push({
            severity: 'info',
            code: 'TOOL_COMMAND_NOT_FOUND',
            message: `tool_command executable '${head}' not found on PATH.`,
            file: nodeFile,
            location: node.location,
            node_id: node.id,
          });
        }

        const portabilityRisks = detectPortabilityRisks(effectiveToolCommand);
        if (portabilityRisks.length > 0) {
          diagnostics.push({
            severity: 'info',
            code: 'TOOL_COMMAND_PORTABILITY',
            message: `tool_command in node '${node.id}' may use GNU-specific flags. These may not work on macOS/BSD.`,
            file: nodeFile,
            location: node.location,
            node_id: node.id,
            fix: `Review flags: ${portabilityRisks.join(', ')}.`,
          });
        }
      }
    }

    const assertExistsRaw = node.attributes.assert_exists;
    if (assertExistsRaw !== undefined) {
      const parsed = parseAssertExists(assertExistsRaw);
      if (parsed.hasEmptySegments || parsed.paths.length === 0) {
        diagnostics.push({
          severity: 'error',
          code: 'ASSERT_EXISTS_INVALID',
          message: `Node '${node.id}' has invalid assert_exists syntax. Provide a comma-separated list of non-empty paths.`,
          file: nodeFile,
          location: node.location,
          node_id: node.id,
          fix: `Set assert_exists="path/to/file.ext" (or a comma-separated list).`,
        });
      }

      const escaping = parsed.paths.filter((entry) => pathEscapesWorkspace(entry));
      if (escaping.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'ASSERT_EXISTS_PATH_ESCAPE',
          message: `Node '${node.id}' has assert_exists path(s) that escape workspace boundaries: ${escaping.join(', ')}.`,
          file: nodeFile,
          location: node.location,
          node_id: node.id,
          fix: `Use workspace-relative assert_exists paths without '..' traversal.`,
        });
      }
    }

    // type_known: node types are recognized
    if (node.kind === 'unknown') {
      diagnostics.push({
        severity: 'warning',
        code: 'TYPE_UNKNOWN',
        message: `Node '${node.id}' has unrecognized type (shape='${node.shape ?? '<missing>'}').`,
        file: nodeFile,
        location: node.location,
        node_id: node.id,
        fix: `Use a supported shape or set type override (start, exit, tool).`,
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
          file: nodeFile,
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
        file: nodeFile,
        location: node.location,
        node_id: node.id,
        fix: `Create node '${node.retryTarget}' or update retry_target on '${node.id}'.`,
      });
    }
    if (node.fallbackRetryTarget && !graph.nodeMap.has(node.fallbackRetryTarget)) {
      diagnostics.push({
        severity: 'warning',
        code: 'RETRY_TARGET_MISSING',
        message: `Node '${node.id}' has fallback_retry_target '${node.fallbackRetryTarget}' which does not exist in the graph.`,
        file: nodeFile,
        location: node.location,
        node_id: node.id,
        fix: `Create node '${node.fallbackRetryTarget}' or update fallback_retry_target on '${node.id}'.`,
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
          file: nodeFile,
          location: node.location,
          node_id: node.id,
          fix: `Set retry_target on '${node.id}' or graph-level retry_target/fallback_retry_target.`,
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
          file: nodeFile,
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
          file: nodeFile,
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
          file: nodeFile,
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
          file: nodeFile,
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
          file: nodeFile,
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
          file: nodeFile,
          location: node.location
        });
      }
    }

    // llm_provider validation
    if (node.llmProvider !== undefined) {
      const knownProviders = new Set(['anthropic', 'openai', 'openai_compatible', 'gemini', 'simulation']);
      if (!knownProviders.has(node.llmProvider)) {
        diagnostics.push({
          severity: 'warning',
          code: 'UNKNOWN_LLM_PROVIDER',
          message: `Node '${node.id}' has unknown llm_provider '${node.llmProvider}'. Known providers: anthropic, openai, openai_compatible, gemini, simulation.`,
          file: nodeFile,
          location: node.location
        });
      }
    }

    if (node.kind === 'conditional' && (node.prompt?.trim() || node.attributes.prompt?.trim())) {
      diagnostics.push({
        severity: 'error',
        code: 'PROMPT_UNSUPPORTED_FOR_CONDITIONAL',
        message: `Conditional node '${node.id}' does not support the prompt attribute. Diamond nodes are edge routers — use edge conditions for routing, or change to shape=box for LLM evaluation.`,
        file: nodeFile,
        location: node.location,
        node_id: node.id,
      });
    }

    // prompt_on_llm_nodes: box nodes should have prompt attribute
    if (node.kind === 'codergen' && !hasShapeMismatchToolCommand && !node.prompt && !node.attributes.prompt) {
      diagnostics.push({
        severity: 'warning',
        code: 'PROMPT_MISSING',
        message: `LLM node '${node.id}' (box shape) has no prompt attribute defined.`,
        file: nodeFile,
        location: node.location,
        node_id: node.id,
        fix: `Set ${node.id} [prompt="..."] for LLM execution, or change shape to parallelogram for tool_command execution.`,
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
              file: nodeFile,
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
            file: nodeFile,
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
            file: nodeFile,
            location: node.location
          });
        }
      }

      // manager.stop_condition must parse with condition evaluator
      if (node.managerStopCondition) {
        try {
          const parsed = parseConditionAst(node.managerStopCondition);
          evaluateConditionAst(parsed, {
            outcome: 'success',
            preferred_label: '',
            context: {},
            steps: {},
            artifacts: EMPTY_ARTIFACT_SCOPE,
          });
          addUnknownStepReferenceWarnings(parsed, graph, diagnostics, {
            expression: node.managerStopCondition,
            file: nodeFile,
            location: node.location,
            contextLabel: `manager.stop_condition on node '${node.id}'`,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown condition syntax error.';
          diagnostics.push({
            severity: 'error',
            code: 'INVALID_MANAGER_STOP_CONDITION',
            message: `Manager node '${node.id}' has invalid manager.stop_condition '${node.managerStopCondition}': ${message}`,
            file: nodeFile,
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
          file: nodeFile,
          location: node.location
        });
      }

      // manager.poll_interval minimum 1s enforced
      if (node.managerPollIntervalMs !== undefined && node.managerPollIntervalMs < 1000) {
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_MANAGER_POLL_INTERVAL',
          message: `Manager node '${node.id}' has manager.poll_interval less than minimum 1s.`,
          file: nodeFile,
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
          file: nodeFile,
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
          file: nodeFile,
          location: node.location
        });
      }
    }
  }

  for (const edge of graph.edges) {
    const edgeFile = edge.provenance?.dotPath ?? graph.dotPath;
    if (!graph.nodeMap.has(edge.source)) {
      diagnostics.push({
        severity: 'error',
        code: 'UNKNOWN_EDGE_SOURCE',
        message: `Edge source '${edge.source}' does not reference an existing node.`,
        file: edgeFile,
        location: edge.location,
        edge: {
          source: edge.source,
          target: edge.target,
          label: edge.label,
          condition: edge.condition,
        },
      });
    }

    if (!graph.nodeMap.has(edge.target)) {
      diagnostics.push({
        severity: 'error',
        code: 'UNKNOWN_EDGE_TARGET',
        message: `Edge target '${edge.target}' does not reference an existing node.`,
        file: edgeFile,
        location: edge.location,
        edge: {
          source: edge.source,
          target: edge.target,
          label: edge.label,
          condition: edge.condition,
        },
      });
    }

    if (edge.condition) {
      try {
        const parsed = parseConditionAst(edge.condition);
        evaluateConditionAst(parsed, {
          outcome: 'success',
          preferred_label: '',
          context: {},
          steps: {},
          artifacts: EMPTY_ARTIFACT_SCOPE,
        });
        addUnknownStepReferenceWarnings(parsed, graph, diagnostics, {
          expression: edge.condition,
          file: edgeFile,
          location: edge.location,
          contextLabel: `edge condition from '${edge.source}' to '${edge.target}'`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown condition syntax error.';
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_CONDITION',
          message: `Invalid edge condition '${edge.condition}': ${message}`,
          file: edgeFile,
          location: edge.location,
          edge: {
            source: edge.source,
            target: edge.target,
            label: edge.label,
            condition: edge.condition,
          },
          fix: `Update the condition syntax or remove the condition from edge '${edge.source}' -> '${edge.target}'.`,
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
          file: edgeFile,
          location: edge.location,
          edge: {
            source: edge.source,
            target: edge.target,
            label: edge.label,
            condition: edge.condition,
          },
        });
      }
      // Invalid target node
      if (!graph.nodeMap.has(edge.target)) {
        diagnostics.push({
          severity: 'error',
          code: 'LOOP_RESTART_INVALID_TARGET',
          message: `loop_restart edge target '${edge.target}' does not exist in the graph.`,
          file: edgeFile,
          location: edge.location,
          edge: {
            source: edge.source,
            target: edge.target,
            label: edge.label,
            condition: edge.condition,
          },
          fix: `Create target node '${edge.target}' or point loop_restart to an existing node.`,
        });
      }
      // Unconditional loop_restart — likely infinite loop
      if (!edge.condition) {
        diagnostics.push({
          severity: 'warning',
          code: 'LOOP_RESTART_UNCONDITIONAL',
          message: `Edge from '${edge.source}' to '${edge.target}' has loop_restart=true but no condition (likely infinite loop).`,
          file: edgeFile,
          location: edge.location,
          edge: {
            source: edge.source,
            target: edge.target,
            label: edge.label,
            condition: edge.condition,
          },
          fix: `Add a loop_restart condition or remove loop_restart=true on edge '${edge.source}' -> '${edge.target}'.`,
        });
      }
    }
  }

  // reachability: all nodes reachable from start via BFS
  if (rootStartNodes.length === 1 && rootStartNodes[0]) {
    const unreachable = findUnreachableNodes(graph, rootStartNodes[0].id);
    for (const node of unreachable) {
      diagnostics.push({
        severity: 'error',
        code: 'UNREACHABLE_NODE',
        message: `Node '${node.id}' is unreachable from the start node.`,
        file: node.provenance?.dotPath ?? graph.dotPath,
        location: node.location,
        node_id: node.id,
        fix: `Add an incoming path to '${node.id}' from the start node or remove the node.`,
      });
    }
  }

  const cyclesWithoutExitPath = findCyclesWithoutExitPath(graph, rootExitNodes.map((node) => node.id));
  for (const cycleNodeId of cyclesWithoutExitPath) {
    const node = graph.nodeMap.get(cycleNodeId);
    diagnostics.push({
      severity: 'error',
      code: 'CYCLE_WITHOUT_EXIT',
      message: `Cycle containing node '${cycleNodeId}' cannot reach an exit node.`,
      file: node?.provenance?.dotPath ?? graph.dotPath,
      location: node?.location,
      node_id: cycleNodeId,
      fix: `Add an edge from the cycle to an exit node.`,
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
      file: node.provenance?.dotPath ?? graph.dotPath,
      location: node.location,
      node_id: node.id,
      fix: `Choose one of the supported shapes for node '${node.id}'.`,
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
      file: node.provenance?.dotPath ?? graph.dotPath,
      location: node.location,
      node_id: node.id,
      fix: `Set max_retries to a non-negative integer (for example, max_retries="3").`,
    });
    return;
  }

  const value = Number.parseInt(rawRetries, 10);
  if (value < 0) {
    diagnostics.push({
      severity: 'error',
      code: 'INVALID_MAX_RETRIES',
      message: `Node '${node.id}' has invalid max_retries '${rawRetries}'. Expected a non-negative integer.`,
      file: node.provenance?.dotPath ?? graph.dotPath,
      location: node.location,
      node_id: node.id,
      fix: `Set max_retries to 0 or greater.`,
    });
  }
}

function validateNodeRetryPolicy(graph: GardenGraph, node: GardenNode, diagnostics: Diagnostic[]): void {
  const rawPolicy = node.attributes.retry_policy;
  if (rawPolicy === undefined) {
    return;
  }

  const policy = rawPolicy.trim().toLowerCase();
  if (!policy) {
    return;
  }

  if (getRetryPreset(policy)) {
    return;
  }

  diagnostics.push({
    severity: 'warning',
    code: 'UNKNOWN_RETRY_POLICY',
    message: `Node '${node.id}' has unknown retry_policy '${rawPolicy}'. Expected one of: ${listRetryPresetNames().join(', ')}.`,
    file: node.provenance?.dotPath ?? graph.dotPath,
    location: node.location,
    node_id: node.id,
    fix: `Use a known retry_policy (${listRetryPresetNames().join(', ')}).`,
  });
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

function parseAssertExists(value: string): { paths: string[]; hasEmptySegments: boolean } {
  const segments = value.split(',');
  const paths: string[] = [];
  let hasEmptySegments = false;

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) {
      hasEmptySegments = true;
      continue;
    }
    paths.push(trimmed);
  }

  return { paths, hasEmptySegments };
}

function pathEscapesWorkspace(assertPath: string): boolean {
  const normalized = path.normalize(assertPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return true;
  }
  return normalized.split(/[\\/]+/).includes('..');
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

function addUnknownStepReferenceWarnings(
  expression: ConditionExpr,
  graph: GardenGraph,
  diagnostics: Diagnostic[],
  input: { expression: string; file: string; location?: { line: number; col: number }; contextLabel: string },
): void {
  const unknownNodeIds = new Set<string>();
  for (const ref of collectVariableReferences(expression)) {
    if (ref.path[0] !== 'steps' || ref.path.length < 3) {
      continue;
    }
    const nodeId = ref.path[1];
    const field = ref.path[2];
    if (!nodeId || (field !== 'status' && field !== 'output')) {
      continue;
    }
    if (!graph.nodeMap.has(nodeId)) {
      unknownNodeIds.add(nodeId);
    }
  }

  for (const nodeId of unknownNodeIds) {
    diagnostics.push({
      severity: 'warning',
      code: 'UNKNOWN_STEP_REFERENCE',
      message: `${input.contextLabel} references unknown step '${nodeId}' in '${input.expression}'.`,
      file: input.file,
      location: input.location,
    });
  }
}
