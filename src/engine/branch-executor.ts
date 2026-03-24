import { GardenGraph } from '../garden/types.js';
import { HandlerRegistry } from '../handlers/registry.js';
import { RunEventListener } from './events.js';
import { ExecutionContext } from './context.js';
import { BranchResult } from './types.js';
import { executeNodeSequence } from './engine.js';

export class BranchExecutor {
  private readonly graph: GardenGraph;
  private readonly context: ExecutionContext;
  private readonly handlers: HandlerRegistry;
  private readonly branchStartNodeId: string;
  private readonly terminationNodeIds: Set<string>;
  private readonly runId: string;
  private readonly dotFile: string;
  private readonly runDir: string;
  private readonly abortSignal?: AbortSignal;
  private readonly onEvent?: RunEventListener;
  private readonly defaultMaxRetries?: number;

  constructor(options: {
    graph: GardenGraph;
    context: ExecutionContext;
    handlers: HandlerRegistry;
    branchStartNodeId: string;
    terminationNodeIds: Set<string>;
    runId: string;
    dotFile: string;
    runDir: string;
    abortSignal?: AbortSignal;
    onEvent?: RunEventListener;
    defaultMaxRetries?: number;
  }) {
    this.graph = options.graph;
    this.context = options.context;
    this.handlers = options.handlers;
    this.branchStartNodeId = options.branchStartNodeId;
    this.terminationNodeIds = options.terminationNodeIds;
    this.runId = options.runId;
    this.dotFile = options.dotFile;
    this.runDir = options.runDir;
    this.abortSignal = options.abortSignal;
    this.onEvent = options.onEvent;
    this.defaultMaxRetries = options.defaultMaxRetries;
  }

  async execute(): Promise<BranchResult> {
    const startTime = Date.now();

    const result = await executeNodeSequence({
      graph: this.graph,
      context: this.context,
      handlers: this.handlers,
      startNodeId: this.branchStartNodeId,
      terminationNodeIds: this.terminationNodeIds,
      runId: this.runId,
      dotFile: this.dotFile,
      runDir: this.runDir,
      abortSignal: this.abortSignal,
      onEvent: this.onEvent,
      defaultMaxRetries: this.defaultMaxRetries
    });

    const durationMs = Date.now() - startTime;

    // Determine overall branch status from completed nodes
    let status: BranchResult['status'] = 'success';
    if (result.error) {
      status = 'failure';
    } else if (result.lastOutcome) {
      status = result.lastOutcome.status;
    } else if (result.completedNodes.length === 0) {
      status = 'success'; // Empty branch (start == termination) succeeds trivially
    } else {
      const lastNode = result.completedNodes[result.completedNodes.length - 1];
      if (lastNode) {
        status = lastNode.status;
      }
    }

    return {
      branchId: this.branchStartNodeId,
      status,
      contextSnapshot: this.context.snapshot(),
      durationMs
    };
  }
}
