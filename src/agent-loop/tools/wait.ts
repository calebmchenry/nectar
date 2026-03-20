import type { ToolHandler } from '../tool-registry.js';

export const waitSchema = {
  properties: {
    agent_ids: {
      oneOf: [
        { type: 'string', description: 'Single agent_id' },
        { type: 'array', items: { type: 'string' }, description: 'Multiple agent_ids' },
      ],
    },
  },
  required: ['agent_ids'],
  additionalProperties: false,
};

export const waitDescription = 'Wait for one or more child agents to complete. Returns their results.';

export const waitHandler: ToolHandler = async () => {
  return JSON.stringify({ error: 'wait not wired — this should not happen' });
};
