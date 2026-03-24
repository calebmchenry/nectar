import { HandlerExecutionInput, NodeOutcome } from '../engine/types.js';
import { NodeHandler } from './registry.js';

export class ConditionalHandler implements NodeHandler {
  async execute(input: HandlerExecutionInput): Promise<NodeOutcome> {
    if (input.node.prompt?.trim()) {
      return {
        status: 'failure',
        error_message: 'Conditional nodes do not support prompt evaluation.',
      };
    }
    return { status: 'success' };
  }
}
