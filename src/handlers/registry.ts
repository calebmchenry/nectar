import { GardenNode } from '../garden/types.js';
import { HandlerExecutionInput, NodeOutcome } from '../engine/types.js';
import { ExitHandler } from './exit.js';
import { StartHandler } from './start.js';
import { ToolHandler } from './tool.js';
import { CodergenHandler } from './codergen.js';
import { ConditionalHandler } from './conditional.js';
import { WaitHumanHandler } from './wait-human.js';
import { UnifiedClient, createLLMClient } from '../llm/client.js';
import type { LLMClient } from '../llm/types.js';
import { Interviewer } from '../interviewer/types.js';
import { AutoApproveInterviewer } from '../interviewer/auto-approve.js';

export interface NodeHandler {
  execute(input: HandlerExecutionInput): Promise<NodeOutcome>;
}

export class HandlerRegistry {
  private readonly startHandler: StartHandler;
  private readonly exitHandler: ExitHandler;
  private readonly toolHandler: ToolHandler;
  private readonly codergenHandler: CodergenHandler;
  private readonly conditionalHandler: ConditionalHandler;
  private readonly waitHumanHandler: WaitHumanHandler;
  private readonly customHandlers = new Map<string, NodeHandler>();

  constructor(llmClient?: UnifiedClient | LLMClient, interviewer?: Interviewer) {
    this.startHandler = new StartHandler();
    this.exitHandler = new ExitHandler();
    this.toolHandler = new ToolHandler();
    this.codergenHandler = new CodergenHandler(llmClient ?? createLLMClient());
    this.conditionalHandler = new ConditionalHandler();
    this.waitHumanHandler = new WaitHumanHandler(interviewer ?? new AutoApproveInterviewer());
  }

  register(kind: string, handler: NodeHandler): void {
    this.customHandlers.set(kind, handler);
  }

  resolve(node: GardenNode): NodeHandler {
    // Check custom handlers first (allows overriding built-ins)
    const custom = this.customHandlers.get(node.kind);
    if (custom) {
      return custom;
    }

    if (node.kind === 'start') {
      return this.startHandler;
    }

    if (node.kind === 'exit') {
      return this.exitHandler;
    }

    if (node.kind === 'tool') {
      return this.toolHandler;
    }

    if (node.kind === 'codergen') {
      return this.codergenHandler;
    }

    if (node.kind === 'conditional') {
      return this.conditionalHandler;
    }

    if (node.kind === 'wait.human') {
      return this.waitHumanHandler;
    }

    if (node.kind === 'stack.manager_loop') {
      const custom = this.customHandlers.get('stack.manager_loop');
      if (custom) return custom;
      throw new Error(`No handler available for manager node '${node.id}'. Register a 'stack.manager_loop' handler.`);
    }

    throw new Error(`No handler available for node '${node.id}' with kind '${node.kind}'.`);
  }
}
