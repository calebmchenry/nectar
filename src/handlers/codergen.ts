import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { HandlerExecutionInput, NodeOutcome } from '../engine/types.js';
import { UnifiedClient } from '../llm/client.js';
import type { LLMClient } from '../llm/types.js';
import type { ContentPart, GenerateRequest, Message, Usage } from '../llm/types.js';
import { normalizeContent, getTextContent } from '../llm/types.js';
import { NodeHandler } from './registry.js';
import { AgentSession } from '../agent-loop/session.js';
import { ToolRegistry } from '../agent-loop/tool-registry.js';
import { LocalExecutionEnvironment } from '../agent-loop/execution-environment.js';
import { selectProfile } from '../agent-loop/provider-profiles.js';
import { discoverInstructions } from '../agent-loop/project-instructions.js';
import { TranscriptWriter } from '../agent-loop/transcript.js';
import { DEFAULT_SESSION_CONFIG } from '../agent-loop/types.js';
import type { AgentEvent } from '../agent-loop/events.js';
import type { RunEvent } from '../engine/events.js';
import { resolveHooks } from '../agent-loop/tool-hooks.js';
import { readFileHandler, readFileSchema, readFileDescription } from '../agent-loop/tools/read-file.js';
import { writeFileHandler, writeFileSchema, writeFileDescription } from '../agent-loop/tools/write-file.js';
import { editFileHandler, editFileSchema, editFileDescription } from '../agent-loop/tools/edit-file.js';
import { shellHandler, shellSchema, shellDescription } from '../agent-loop/tools/shell.js';
import { grepHandler, grepSchema, grepDescription } from '../agent-loop/tools/grep.js';
import { globHandler, globSchema, globDescription } from '../agent-loop/tools/glob.js';
import { applyPatchHandler, applyPatchSchema, applyPatchDescription } from '../agent-loop/tools/apply-patch.js';
import { spawnAgentHandler, spawnAgentSchema, spawnAgentDescription } from '../agent-loop/tools/spawn-agent.js';
import { sendInputHandler, sendInputSchema, sendInputDescription } from '../agent-loop/tools/send-input.js';
import { waitHandler, waitSchema, waitDescription } from '../agent-loop/tools/wait.js';
import { closeAgentHandler, closeAgentSchema, closeAgentDescription } from '../agent-loop/tools/close-agent.js';

export class CodergenHandler implements NodeHandler {
  private readonly client: UnifiedClient | LLMClient;

  constructor(client: UnifiedClient | LLMClient) {
    this.client = client;
  }

  async execute(input: HandlerExecutionInput): Promise<NodeOutcome> {
    const prompt = input.node.prompt ?? input.node.attributes.prompt?.trim();
    if (!prompt) {
      return {
        status: 'failure',
        error_message: `Codergen node '${input.node.id}' is missing a prompt attribute.`
      };
    }

    const nodeDir = path.join(input.run_dir, input.node.id);
    await mkdir(nodeDir, { recursive: true });

    // Write the actual rendered prompt: preamble + prompt for non-full modes
    const renderedPrompt = input.preamble
      ? `${input.preamble}\n\n---\n\n${prompt}`
      : prompt;
    await writeFile(path.join(nodeDir, 'prompt.md'), renderedPrompt, 'utf8');

    // If we have a UnifiedClient, use the agent session loop
    if (this.client instanceof UnifiedClient) {
      return this.executeWithAgentSession(input, prompt, nodeDir);
    }

    // Legacy path for plain LLMClient
    return this.executeWithLegacyClient(input, prompt, nodeDir);
  }

  private async executeWithAgentSession(
    input: HandlerExecutionInput,
    prompt: string,
    nodeDir: string
  ): Promise<NodeOutcome> {
    const client = this.client as UnifiedClient;
    const provider = input.node.llmProvider ?? input.node.attributes.llm_provider?.trim();
    const model = input.node.llmModel ?? input.node.attributes.llm_model?.trim();
    const reasoningEffort = (input.node.reasoningEffort ?? input.node.attributes.reasoning_effort?.trim()) as 'low' | 'medium' | 'high' | undefined;

    // Parse agent config from node attributes
    const maxTurns = input.node.attributes['agent.max_turns']
      ? parseInt(input.node.attributes['agent.max_turns'], 10)
      : DEFAULT_SESSION_CONFIG.max_turns;
    const maxToolRounds = input.node.attributes['agent.max_tool_rounds']
      ? parseInt(input.node.attributes['agent.max_tool_rounds'], 10)
      : DEFAULT_SESSION_CONFIG.max_tool_rounds_per_input;
    const commandTimeoutMs = input.node.attributes['agent.command_timeout_ms']
      ? parseInt(input.node.attributes['agent.command_timeout_ms'], 10)
      : DEFAULT_SESSION_CONFIG.default_command_timeout_ms;

    const workspaceRoot = input.workspace_root ?? process.cwd();

    try {
      // Create execution environment
      const env = new LocalExecutionEnvironment(workspaceRoot);

      // Create tool registry with all 7 core tools + 4 subagent tools
      const registry = new ToolRegistry();
      registry.register('read_file', readFileDescription, readFileSchema, readFileHandler);
      registry.register('write_file', writeFileDescription, writeFileSchema, writeFileHandler);
      registry.register('edit_file', editFileDescription, editFileSchema, editFileHandler);
      registry.register('shell', shellDescription, shellSchema, shellHandler);
      registry.register('grep', grepDescription, grepSchema, grepHandler);
      registry.register('glob', globDescription, globSchema, globHandler);
      registry.register('apply_patch', applyPatchDescription, applyPatchSchema, applyPatchHandler);
      // Subagent tools (visibility controlled dynamically by session)
      registry.register('spawn_agent', spawnAgentDescription, spawnAgentSchema, spawnAgentHandler);
      registry.register('send_input', sendInputDescription, sendInputSchema, sendInputHandler);
      registry.register('wait', waitDescription, waitSchema, waitHandler);
      registry.register('close_agent', closeAgentDescription, closeAgentSchema, closeAgentHandler);

      // Select provider profile (never mutate the shared singleton)
      const profile = selectProfile(provider);

      // Load project instructions
      const projectInstructions = await discoverInstructions(workspaceRoot, profile.name);

      // Create transcript writer
      const transcriptWriter = new TranscriptWriter(nodeDir);

      // Bridge agent events to engine events
      const emitEvent = input.emitEvent;
      const onAgentEvent = emitEvent
        ? (event: AgentEvent) => {
            bridgeAgentEvent(event, input.run_id, input.node.id, emitEvent);
          }
        : undefined;

      // Resolve tool hooks (node-level overrides graph-level)
      const hooks = resolveHooks(
        input.node.toolHooksPre,
        input.node.toolHooksPost,
        input.graph_tool_hooks_pre,
        input.graph_tool_hooks_post,
      );

      // Create session with provider/model/reasoning overrides from node
      const session = new AgentSession(client, registry, profile, env, {
        max_turns: maxTurns,
        max_tool_rounds_per_input: maxToolRounds,
        default_command_timeout_ms: commandTimeoutMs,
        workspace_root: workspaceRoot,
      }, {
        onEvent: onAgentEvent,
        transcriptWriter,
        overrides: {
          provider,
          model,
          reasoningEffort: reasoningEffort as 'low' | 'medium' | 'high' | undefined,
        },
        depth: 0,
        hooks,
        hookContext: { run_id: input.run_id, node_id: input.node.id },
      });

      // Notify session started
      if (onAgentEvent) {
        onAgentEvent({
          type: 'agent_session_started',
          node_id: input.node.id,
          provider: profile.name,
          model: profile.defaultModel ?? 'default',
        });
      }

      // Handle abort signal
      if (input.abort_signal) {
        input.abort_signal.addEventListener('abort', () => session.abort(), { once: true });
      }

      // Expand $goal in prompt
      let expandedPrompt = prompt;
      if (input.context['graph.goal']) {
        expandedPrompt = expandedPrompt.replace(/\$goal/g, input.context['graph.goal']);
      }

      // Inject preamble for non-full fidelity modes
      if (input.preamble && input.fidelity_plan?.mode !== 'full') {
        expandedPrompt = `${input.preamble}\n\n---\n\n${expandedPrompt}`;
      }

      // Run session
      const result = await session.processInput(expandedPrompt, projectInstructions);

      // Write artifacts
      await transcriptWriter.writeResponse(result.final_text);
      await transcriptWriter.writeStatus({
        ...result,
        provider: profile.name,
        model: profile.defaultModel ?? 'default',
        agent_duration_ms: Date.now(),
      });

      // Map result to NodeOutcome
      if (result.status === 'aborted') {
        return {
          status: 'failure',
          error_message: result.error_message ?? 'Session aborted',
        };
      }

      if (result.status === 'failure') {
        return {
          status: 'retry',
          error_message: result.error_message ?? 'Agent session failed',
        };
      }

      return {
        status: 'success',
        context_updates: {
          [`${input.node.id}.response`]: result.final_text.slice(0, 500),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const status = { status: 'failure', error: errorMessage, node_id: input.node.id };
      await writeFile(path.join(nodeDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
      return {
        status: 'failure',
        error_message: `Codergen node '${input.node.id}' failed: ${errorMessage}`,
      };
    }
  }

  private async executeWithLegacyClient(
    input: HandlerExecutionInput,
    prompt: string,
    nodeDir: string
  ): Promise<NodeOutcome> {
    try {
      const response = await (this.client as LLMClient).generate({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096
      });

      if (!response.content || response.content.trim().length === 0) {
        const status = { status: 'failure', error: 'Empty LLM response', node_id: input.node.id };
        await writeFile(path.join(nodeDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
        return {
          status: 'failure',
          error_message: `Codergen node '${input.node.id}' received an empty LLM response.`
        };
      }

      await writeFile(path.join(nodeDir, 'response.md'), response.content, 'utf8');

      const status = {
        status: 'success',
        node_id: input.node.id,
        model: response.model,
        usage: response.usage,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      };
      await writeFile(path.join(nodeDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');

      return {
        status: 'success',
        context_updates: {
          [`${input.node.id}.response`]: response.content.slice(0, 500)
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown LLM error';
      const status = { status: 'failure', error: errorMessage, node_id: input.node.id };
      await writeFile(path.join(nodeDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
      return {
        status: 'failure',
        error_message: `Codergen node '${input.node.id}' failed: ${errorMessage}`
      };
    }
  }
}

/** Bridge AgentEvent into RunEvent for the engine event system */
function bridgeAgentEvent(
  event: AgentEvent,
  runId: string,
  nodeId: string,
  emitEvent: (event: RunEvent) => void
): void {
  switch (event.type) {
    case 'agent_session_started':
      emitEvent({
        type: 'agent_session_started',
        run_id: runId,
        node_id: nodeId,
        provider: event.provider,
        model: event.model,
        session_id: event.session_id,
        workspace_root: event.workspace_root,
        state: event.state,
      });
      break;
    case 'agent_tool_call_started':
      emitEvent({
        type: 'agent_tool_called',
        run_id: runId,
        node_id: nodeId,
        call_id: event.call_id,
        tool_name: event.tool_name,
        arguments: event.arguments,
      });
      break;
    case 'agent_tool_call_completed':
      emitEvent({
        type: 'agent_tool_completed',
        run_id: runId,
        node_id: nodeId,
        call_id: event.call_id,
        tool_name: event.tool_name,
        duration_ms: event.duration_ms,
        is_error: event.is_error,
        content_preview: event.content_preview,
        truncated: event.truncated,
        artifact_path: event.artifact_path,
      });
      break;
    case 'agent_loop_detected':
      emitEvent({
        type: 'agent_loop_detected',
        run_id: runId,
        node_id: nodeId,
        fingerprint: event.fingerprint,
        repetitions: event.repetitions,
      });
      break;
    case 'agent_session_completed':
      emitEvent({
        type: 'agent_session_completed',
        run_id: runId,
        node_id: nodeId,
        status: event.status,
        turn_count: event.turn_count,
        tool_call_count: event.tool_call_count,
        duration_ms: event.duration_ms,
        session_id: event.session_id,
        final_state: event.final_state,
      });
      break;
    case 'subagent_spawned':
      emitEvent({
        type: 'subagent_spawned',
        run_id: runId,
        node_id: nodeId,
        parent_session_id: event.parent_session_id,
        child_session_id: event.child_session_id,
        agent_id: event.agent_id,
        task: event.task,
        depth: event.depth,
        timestamp: event.timestamp,
      });
      break;
    case 'subagent_completed':
      emitEvent({
        type: 'subagent_completed',
        run_id: runId,
        node_id: nodeId,
        parent_session_id: event.parent_session_id,
        child_session_id: event.child_session_id,
        agent_id: event.agent_id,
        status: event.status,
        timestamp: event.timestamp,
      });
      break;
    case 'subagent_message':
      emitEvent({
        type: 'subagent_message',
        run_id: runId,
        node_id: nodeId,
        parent_session_id: event.parent_session_id,
        agent_id: event.agent_id,
        direction: event.direction,
        message_type: event.message_type,
        timestamp: event.timestamp,
      });
      break;
    // Silently ignore text deltas and turn started for engine-level events
  }
}
