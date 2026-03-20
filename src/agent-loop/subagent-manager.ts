import { randomUUID } from 'node:crypto';
import type { AgentSession } from './session.js';
import type { AgentEventListener, SubagentSpawnedEvent, SubagentCompletedEvent, SubagentMessageEvent } from './events.js';
import type { SubagentConfig, SubAgentHandle, SubAgentResult, SubagentHandleStatus } from './types.js';
import { DEFAULT_SUBAGENT_CONFIG } from './types.js';

export interface SpawnOptions {
  working_dir?: string;
  max_tool_rounds?: number;
  max_turns?: number;
  timeout_ms?: number;
}

export interface SubagentManagerDeps {
  parentSessionId: string;
  depth: number;
  config: SubagentConfig;
  onEvent?: AgentEventListener;
  createChildSession: (opts: {
    agentId: string;
    task: string;
    depth: number;
    workingDir?: string;
    maxToolRounds: number;
    maxTurns: number;
  }) => { session: AgentSession; sessionId: string };
}

export class SubagentManager {
  private readonly children = new Map<string, SubAgentHandle>();
  private readonly deps: SubagentManagerDeps;

  constructor(deps: SubagentManagerDeps) {
    this.deps = deps;
  }

  get config(): SubagentConfig {
    return this.deps.config;
  }

  spawn(task: string, opts?: SpawnOptions): SubAgentResult | SubAgentHandle {
    const config = this.deps.config;

    // Enforce depth limit
    if (this.deps.depth + 1 > config.max_subagent_depth) {
      return {
        agent_id: '',
        status: 'FAILED',
        output: '',
        error: 'Maximum subagent depth reached. Complete this task directly.',
        usage: { input_tokens: 0, output_tokens: 0 },
        turns_used: 0,
      };
    }

    // Enforce concurrency limit
    const activeCount = this.getActiveCount();
    if (activeCount >= config.max_concurrent_children) {
      return {
        agent_id: '',
        status: 'FAILED',
        output: '',
        error: `Maximum concurrent children (${config.max_concurrent_children}) reached. Wait for existing children to complete or close them.`,
        usage: { input_tokens: 0, output_tokens: 0 },
        turns_used: 0,
      };
    }

    const agentId = randomUUID();
    const maxToolRounds = opts?.max_tool_rounds ?? config.child_max_tool_rounds;
    const maxTurns = opts?.max_turns ?? config.child_max_turns;
    const timeoutMs = opts?.timeout_ms ?? config.child_timeout_ms;

    const { session, sessionId } = this.deps.createChildSession({
      agentId,
      task,
      depth: this.deps.depth + 1,
      workingDir: opts?.working_dir,
      maxToolRounds,
      maxTurns,
    });

    // Create result promise that wraps submit + timeout
    const resultPromise = this.runChild(agentId, session, task, timeoutMs);

    const handle: SubAgentHandle = {
      id: agentId,
      task,
      status: 'RUNNING',
      working_dir: opts?.working_dir ?? '',
      started_at: new Date().toISOString(),
      result_promise: resultPromise,
    };

    this.children.set(agentId, handle);

    // Emit spawn event
    this.deps.onEvent?.({
      type: 'subagent_spawned',
      parent_session_id: this.deps.parentSessionId,
      child_session_id: sessionId,
      agent_id: agentId,
      task,
      depth: this.deps.depth + 1,
      timestamp: new Date().toISOString(),
    } satisfies SubagentSpawnedEvent);

    // Wire up completion tracking
    resultPromise.then((result) => {
      handle.status = result.status;
      handle.result = result;

      this.deps.onEvent?.({
        type: 'subagent_completed',
        parent_session_id: this.deps.parentSessionId,
        child_session_id: sessionId,
        agent_id: agentId,
        status: result.status === 'COMPLETED' ? 'success'
          : result.status === 'TIMEOUT' ? 'timeout'
          : result.status === 'CLOSED' ? 'aborted'
          : 'failure',
        usage: result.usage,
        timestamp: new Date().toISOString(),
      } satisfies SubagentCompletedEvent);
    });

    return handle;
  }

  private async runChild(
    agentId: string,
    session: AgentSession,
    task: string,
    timeoutMs: number,
  ): Promise<SubAgentResult> {
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      const resultOrTimeout = await Promise.race([
        session.submit(task),
        timeoutPromise,
      ]);

      if (resultOrTimeout === 'timeout') {
        session.abort();
        return {
          agent_id: agentId,
          status: 'TIMEOUT',
          output: '',
          error: `Child agent timed out after ${timeoutMs}ms`,
          usage: { input_tokens: 0, output_tokens: 0 },
          turns_used: 0,
        };
      }

      const result = resultOrTimeout;
      const status: SubagentHandleStatus = result.status === 'success' ? 'COMPLETED'
        : result.status === 'aborted' ? 'CLOSED'
        : 'FAILED';

      return {
        agent_id: agentId,
        status,
        output: result.final_text.slice(0, 2000),
        error: result.error_message,
        usage: result.usage,
        turns_used: result.turn_count,
      };
    } catch (err) {
      return {
        agent_id: agentId,
        status: 'FAILED',
        output: '',
        error: err instanceof Error ? err.message : String(err),
        usage: { input_tokens: 0, output_tokens: 0 },
        turns_used: 0,
      };
    }
  }

  getChild(agentId: string): SubAgentHandle | undefined {
    return this.children.get(agentId);
  }

  getActiveCount(): number {
    let count = 0;
    for (const handle of this.children.values()) {
      if (handle.status === 'RUNNING') count++;
    }
    return count;
  }

  hasChildren(): boolean {
    return this.children.size > 0;
  }

  async sendInput(agentId: string, message: string, session: AgentSession): Promise<SubAgentResult | { status: string }> {
    const handle = this.children.get(agentId);
    if (!handle) {
      return {
        agent_id: agentId,
        status: 'FAILED',
        output: '',
        error: `Unknown agent_id: ${agentId}`,
        usage: { input_tokens: 0, output_tokens: 0 },
        turns_used: 0,
      } satisfies SubAgentResult;
    }

    if (handle.status !== 'RUNNING') {
      return {
        agent_id: agentId,
        status: handle.status,
        output: '',
        error: `Cannot send input to agent in ${handle.status} state`,
        usage: { input_tokens: 0, output_tokens: 0 },
        turns_used: 0,
      } satisfies SubAgentResult;
    }

    // Emit message event
    this.deps.onEvent?.({
      type: 'subagent_message',
      parent_session_id: this.deps.parentSessionId,
      agent_id: agentId,
      direction: 'parent_to_child',
      message_type: session.getState() === 'PROCESSING' ? 'steer' : 'follow_up',
      timestamp: new Date().toISOString(),
    } satisfies SubagentMessageEvent);

    try {
      if (session.getState() === 'PROCESSING') {
        session.steer(message);
        return { status: 'steered' };
      } else {
        // AWAITING_INPUT — follow up
        session.followUp(message);
        return { status: 'follow_up_queued' };
      }
    } catch (err) {
      return {
        agent_id: agentId,
        status: handle.status,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        usage: { input_tokens: 0, output_tokens: 0 },
        turns_used: 0,
      } satisfies SubAgentResult;
    }
  }

  async wait(agentIds: string[]): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = [];

    for (const id of agentIds) {
      const handle = this.children.get(id);
      if (!handle) {
        results.push({
          agent_id: id,
          status: 'FAILED',
          output: '',
          error: `Unknown agent_id: ${id}`,
          usage: { input_tokens: 0, output_tokens: 0 },
          turns_used: 0,
        });
        continue;
      }

      // If already terminal, return cached result
      if (handle.result) {
        results.push(handle.result);
        continue;
      }

      // Wait for completion
      try {
        const result = await handle.result_promise;
        results.push(result);
      } catch (err) {
        results.push({
          agent_id: id,
          status: 'FAILED',
          output: '',
          error: err instanceof Error ? err.message : String(err),
          usage: { input_tokens: 0, output_tokens: 0 },
          turns_used: 0,
        });
      }
    }

    return results;
  }

  async close(agentId: string, session: AgentSession): Promise<{ status: string }> {
    const handle = this.children.get(agentId);
    if (!handle) {
      return { status: 'not_found' };
    }

    // Already terminal
    if (handle.status !== 'RUNNING') {
      return { status: handle.status };
    }

    // Abort the session
    session.abort();
    handle.status = 'CLOSED';

    // Wait for cleanup
    try {
      await handle.result_promise;
    } catch {
      // Expected — abort causes rejection
    }

    handle.status = 'CLOSED';
    if (!handle.result) {
      handle.result = {
        agent_id: agentId,
        status: 'CLOSED',
        output: '',
        error: 'Agent closed by parent',
        usage: { input_tokens: 0, output_tokens: 0 },
        turns_used: 0,
      };
    }

    return { status: 'closed' };
  }

  async closeAll(sessions: Map<string, AgentSession>): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [agentId, handle] of this.children.entries()) {
      if (handle.status === 'RUNNING') {
        const session = sessions.get(agentId);
        if (session) {
          closePromises.push(this.close(agentId, session).then(() => {}));
        }
      }
    }
    await Promise.allSettled(closePromises);
  }
}
