import { HandlerExecutionInput, NodeOutcome } from '../engine/types.js';
import { NodeHandler } from './registry.js';

export class ExitHandler implements NodeHandler {
  async execute(_input: HandlerExecutionInput): Promise<NodeOutcome> {
    return { status: 'success' };
  }
}
