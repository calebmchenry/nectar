import { GardenNode } from '../garden/types.js';
import { HandlerExecutionInput, NodeOutcome } from '../engine/types.js';
import { ExitHandler } from './exit.js';
import { StartHandler } from './start.js';
import { ToolHandler } from './tool.js';

export interface NodeHandler {
  execute(input: HandlerExecutionInput): Promise<NodeOutcome>;
}

export class HandlerRegistry {
  private readonly startHandler: StartHandler;
  private readonly exitHandler: ExitHandler;
  private readonly toolHandler: ToolHandler;

  constructor() {
    this.startHandler = new StartHandler();
    this.exitHandler = new ExitHandler();
    this.toolHandler = new ToolHandler();
  }

  resolve(node: GardenNode): NodeHandler {
    if (node.kind === 'start') {
      return this.startHandler;
    }

    if (node.kind === 'exit') {
      return this.exitHandler;
    }

    if (node.kind === 'tool') {
      return this.toolHandler;
    }

    throw new Error(`No handler available for node '${node.id}' with kind '${node.kind}'.`);
  }
}
