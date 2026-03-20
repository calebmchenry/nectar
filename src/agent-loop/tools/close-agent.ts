import type { ToolHandler } from '../tool-registry.js';

export const closeAgentSchema = {
  properties: {
    agent_id: { type: 'string', description: 'The agent_id of the child to close' },
  },
  required: ['agent_id'],
  additionalProperties: false,
};

export const closeAgentDescription = 'Terminate a child agent session. Aborts if still processing.';

export const closeAgentHandler: ToolHandler = async () => {
  return JSON.stringify({ error: 'close_agent not wired — this should not happen' });
};
