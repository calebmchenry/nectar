import type { ToolHandler } from '../tool-registry.js';

export const sendInputSchema = {
  properties: {
    agent_id: { type: 'string', description: 'The agent_id of the child to send input to' },
    message: { type: 'string', description: 'The message to send to the child agent' },
  },
  required: ['agent_id', 'message'],
  additionalProperties: false,
};

export const sendInputDescription = 'Send a steering message to a running child agent, or a follow-up to an idle child.';

export const sendInputHandler: ToolHandler = async () => {
  return JSON.stringify({ error: 'send_input not wired — this should not happen' });
};
