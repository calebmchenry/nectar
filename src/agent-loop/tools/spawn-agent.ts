import type { ToolHandler } from '../tool-registry.js';

export const spawnAgentSchema = {
  properties: {
    task: { type: 'string', description: 'The task prompt for the child agent' },
    model: { type: 'string', description: 'Optional model override for the child session' },
    working_dir: { type: 'string', description: 'Working directory for the child (default: parent\'s cwd)' },
    max_tool_rounds: { type: 'integer', description: 'Max tool rounds for the child (default: 20)' },
    max_turns: { type: 'integer', description: 'Max turns for the child (0 = unlimited, default: child_max_turns)' },
    timeout_ms: { type: 'integer', description: 'Timeout in ms for the child session (default: 300000 / 5 min)' },
  },
  required: ['task'],
  additionalProperties: false,
};

export const spawnAgentDescription = 'Spawn a child agent to work on a subtask in parallel. Returns an agent_id for tracking.';

/**
 * The actual handler is wired up by the session since it needs access to the SubagentManager.
 * This is a placeholder that gets replaced at registration time.
 */
export const spawnAgentHandler: ToolHandler = async () => {
  return JSON.stringify({ error: 'spawn_agent not wired — this should not happen' });
};
