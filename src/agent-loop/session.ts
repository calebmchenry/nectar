import { randomUUID } from 'node:crypto';
import type { UnifiedClient } from '../llm/client.js';
import type { ContentPart, Message, ProviderOptions, Usage } from '../llm/types.js';
import { executeToolsBatch } from '../llm/tools.js';
import type { ToolDefinition } from '../llm/tools.js';
import { ToolRegistry } from './tool-registry.js';
import type { ProviderProfile, ProfileContext } from './provider-profiles.js';
import { buildEnvironmentContext, buildGitSnapshot } from './environment-context.js';
import type { ExecutionEnvironment } from './execution-environment.js';
import type { SessionConfig, SessionResult, SessionState, WorkItem, ToolCallEnvelope, ToolResultEnvelope, SubagentConfig, SubAgentHandle, SubAgentResult } from './types.js';
import { DEFAULT_SESSION_CONFIG, DEFAULT_SUBAGENT_CONFIG } from './types.js';
import { canContinueWithLimit, isLimitReached } from './types.js';
import type { AgentEventListener } from './events.js';
import { LoopDetector } from './loop-detection.js';
import type { TranscriptWriter } from './transcript.js';
import { SubagentManager } from './subagent-manager.js';
import { ToolHookRunner, resolveHooks } from './tool-hooks.js';
import type { ResolvedHooks, ToolHookMetadata, PostHookMetadata } from './tool-hooks.js';
import { getModelInfo } from '../llm/catalog.js';
import { AccessDeniedError, AuthenticationError, ContextLengthError } from '../llm/errors.js';
import { repairToolCall } from '../llm/tool-repair.js';
import { discoverInstructions } from './project-instructions.js';

export interface SessionOverrides {
  provider?: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  providerOptions?: ProviderOptions;
}

export class AgentSession {
  private readonly client: UnifiedClient;
  private readonly registry: ToolRegistry;
  private readonly profile: ProviderProfile;
  private readonly env: ExecutionEnvironment;
  private readonly config: SessionConfig;
  private readonly onEvent?: AgentEventListener;
  private readonly transcriptWriter?: TranscriptWriter;
  private readonly overrides: SessionOverrides;
  private readonly sessionId: string;
  private readonly maxFollowUps: number;
  private readonly depth: number;
  private readonly subagentConfig: SubagentConfig;
  private readonly hookRunner?: ToolHookRunner;
  private readonly hookContext?: { run_id: string; node_id: string };

  // Subagent management (lazy)
  private subagentManager?: SubagentManager;
  private readonly childSessions = new Map<string, AgentSession>();

  // State machine
  private state: SessionState = 'IDLE';

  // Persistent conversation
  private conversation: Message[] = [];

  // Queues
  private pendingInputs: WorkItem[] = [];
  private pendingSteers: string[] = [];

  // Active processing state
  private activeItem?: WorkItem;
  private aborted = false;
  private abortController?: AbortController;
  private followUpCount = 0;
  private contextWindowWarningEmitted = false;
  private loopSteeringCount = 0;
  private sessionEndedEmitted = false;
  private sessionStartedEmitted = false;
  private lifetimeTurnCount = 0;
  private turnLimitExhausted = false;

  // Cached git snapshot (computed once per session)
  private cachedGitSnapshot: string | null | undefined = undefined;
  // Cached auto-discovered instructions (computed once per session)
  private cachedDiscoveredInstructions: string | null | undefined = undefined;

  constructor(
    client: UnifiedClient,
    registry: ToolRegistry,
    profile: ProviderProfile,
    env: ExecutionEnvironment,
    config: SessionConfig,
    options?: {
      onEvent?: AgentEventListener;
      transcriptWriter?: TranscriptWriter;
      overrides?: SessionOverrides;
      depth?: number;
      subagentConfig?: SubagentConfig;
      hooks?: ResolvedHooks;
      hookContext?: { run_id: string; node_id: string };
    }
  ) {
    const normalizedConfig: SessionConfig = {
      max_turns: config.max_turns ?? DEFAULT_SESSION_CONFIG.max_turns,
      max_tool_rounds_per_input: config.max_tool_rounds_per_input ?? DEFAULT_SESSION_CONFIG.max_tool_rounds_per_input,
      default_command_timeout_ms: config.default_command_timeout_ms ?? DEFAULT_SESSION_CONFIG.default_command_timeout_ms,
      workspace_root: config.workspace_root,
      max_follow_ups: config.max_follow_ups ?? DEFAULT_SESSION_CONFIG.max_follow_ups,
      max_command_timeout_ms: config.max_command_timeout_ms ?? DEFAULT_SESSION_CONFIG.max_command_timeout_ms,
      reasoning_effort: config.reasoning_effort,
      tool_output_limits: {
        ...(DEFAULT_SESSION_CONFIG.tool_output_limits ?? {}),
        ...(config.tool_output_limits ?? {}),
      },
      tool_line_limits: {
        ...(DEFAULT_SESSION_CONFIG.tool_line_limits ?? {}),
        ...(config.tool_line_limits ?? {}),
      },
      enable_loop_detection: config.enable_loop_detection ?? DEFAULT_SESSION_CONFIG.enable_loop_detection,
      loop_detection_window: config.loop_detection_window ?? DEFAULT_SESSION_CONFIG.loop_detection_window,
      require_tool_calls_for_success: config.require_tool_calls_for_success
        ?? DEFAULT_SESSION_CONFIG.require_tool_calls_for_success,
    };

    this.client = client;
    this.registry = registry;
    this.profile = profile;
    this.env = env;
    this.config = normalizedConfig;
    this.onEvent = options?.onEvent;
    this.transcriptWriter = options?.transcriptWriter;
    this.overrides = { ...(options?.overrides ?? {}) };
    if (!this.overrides.reasoningEffort && normalizedConfig.reasoning_effort) {
      this.overrides.reasoningEffort = normalizedConfig.reasoning_effort;
    }
    this.sessionId = randomUUID();
    this.maxFollowUps = normalizedConfig.max_follow_ups ?? 10;
    this.depth = options?.depth ?? 0;
    this.subagentConfig = options?.subagentConfig ?? DEFAULT_SUBAGENT_CONFIG;

    // Tool hooks
    if (options?.hooks && (options.hooks.pre || options.hooks.post)) {
      this.hookRunner = new ToolHookRunner(options.hooks);
      this.hookContext = options.hookContext;
    }
  }

  getState(): SessionState {
    return this.state;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getDepth(): number {
    return this.depth;
  }

  /**
   * Submit a new top-level work item. Compatibility wrapper around the queue-backed loop.
   */
  submit(prompt: string, options?: { provider_options?: ProviderOptions }): Promise<SessionResult> {
    if (this.state === 'CLOSED') {
      // If aborted before any work, return aborted result instead of rejecting
      if (this.aborted) {
        return Promise.resolve({
          status: 'aborted' as const,
          final_text: '',
          usage: { input_tokens: 0, output_tokens: 0 },
          turn_count: 0,
          tool_call_count: 0,
          stop_reason: 'aborted',
          error_message: 'Session aborted',
        });
      }
      return Promise.reject(new Error('Cannot submit to a CLOSED session'));
    }
    if (this.isSessionTurnLimitExhausted()) {
      return Promise.reject(new Error(`Session turn limit (${this.config.max_turns}) has been exhausted.`));
    }
    if (this.state === 'PROCESSING') {
      return Promise.reject(new Error('Cannot submit while session is PROCESSING. Use steer() or followUp() instead.'));
    }

    return new Promise<SessionResult>((resolve, reject) => {
      this.emitSessionStarted();
      const item: WorkItem = {
        prompt,
        resolve,
        reject,
        isFollowUp: false,
        provider_options: options?.provider_options as Record<string, unknown> | undefined,
      };
      this.pendingInputs.push(item);
      this.onEvent?.({
        type: 'agent_user_input',
        session_id: this.sessionId,
        source: 'submit',
        text: prompt,
      });
      this.drainQueue();
    });
  }

  /**
   * Enqueue a follow-up that reuses the existing conversation.
   */
  followUp(prompt: string, options?: { provider_options?: ProviderOptions }): Promise<SessionResult> {
    if (this.state === 'CLOSED') {
      return Promise.reject(new Error('Cannot follow up on a CLOSED session'));
    }
    if (this.isSessionTurnLimitExhausted()) {
      return Promise.reject(new Error(`Session turn limit (${this.config.max_turns}) has been exhausted.`));
    }

    if (this.followUpCount >= this.maxFollowUps) {
      return Promise.reject(new Error(`Follow-up limit (${this.maxFollowUps}) exceeded`));
    }

    // Record follow-up in transcript
    this.transcriptWriter?.appendTranscript({ role: 'user', text: `[follow-up] ${prompt}` });

    return new Promise<SessionResult>((resolve, reject) => {
      const item: WorkItem = {
        prompt,
        resolve,
        reject,
        isFollowUp: true,
        provider_options: options?.provider_options as Record<string, unknown> | undefined,
      };
      this.pendingInputs.push(item);
      this.onEvent?.({
        type: 'agent_user_input',
        session_id: this.sessionId,
        source: 'follow_up',
        text: prompt,
      });
      if (this.state === 'AWAITING_INPUT') {
        this.drainQueue();
      }
    });
  }

  /**
   * Queue a steering message for injection before the next LLM call.
   */
  steer(message: string): void {
    this.enqueueSteer(message);
  }

  private enqueueSteer(message: string): void {
    this.pendingSteers.push(message);
    this.transcriptWriter?.appendTranscript({ role: 'steer', text: message });
  }

  /**
   * Graceful close — transition to CLOSED, reject any pending items.
   */
  close(): void {
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSED';
    this.emitSessionEnded('closed');
    // Close all children
    if (this.subagentManager) {
      this.subagentManager.closeAll(this.childSessions);
    }
    this.rejectPending(new Error('Session closed'));
  }

  /**
   * Abort — transition to CLOSED, cancel in-flight work, reject pending promise.
   */
  abort(): void {
    this.aborted = true;
    this.abortController?.abort();
    // Propagate abort to all children
    if (this.subagentManager) {
      this.subagentManager.closeAll(this.childSessions);
    }
    if (this.state !== 'CLOSED') {
      this.state = 'CLOSED';
      this.emitSessionEnded('aborted');
      this.rejectPending(new AbortError('Session aborted'));
      return;
    }
    this.emitSessionEnded('aborted');
  }

  /**
   * Compatibility wrapper: behaves like the old processInput().
   */
  async processInput(
    prompt: string,
    projectInstructions?: string,
    options?: { provider_options?: ProviderOptions },
  ): Promise<SessionResult> {
    // Store project instructions for system prompt building
    this.explicitProjectInstructions = projectInstructions;
    return this.submit(prompt, options);
  }

  // Internal: project instructions stashed by processInput for system prompt
  private explicitProjectInstructions?: string;

  /**
   * Get the SubagentManager, creating it lazily if needed.
   */
  private getOrCreateManager(): SubagentManager {
    if (!this.subagentManager) {
      this.subagentManager = new SubagentManager({
        parentSessionId: this.sessionId,
        depth: this.depth,
        config: this.subagentConfig,
        onEvent: this.onEvent,
        createChildSession: (opts) => {
          const childEnv = opts.workingDir
            ? this.env.scoped(opts.workingDir)
            : this.env;

          const childRegistry = this.cloneRegistryWithoutSubagentTools();

          const childSession = new AgentSession(
            this.client,
            childRegistry,
            this.profile,
            childEnv,
            {
              max_turns: opts.maxTurns,
              max_tool_rounds_per_input: opts.maxToolRounds,
              default_command_timeout_ms: this.config.default_command_timeout_ms,
              workspace_root: this.config.workspace_root,
              max_command_timeout_ms: this.config.max_command_timeout_ms,
              reasoning_effort: this.config.reasoning_effort,
              tool_output_limits: this.config.tool_output_limits,
              tool_line_limits: this.config.tool_line_limits,
              enable_loop_detection: this.config.enable_loop_detection,
              loop_detection_window: this.config.loop_detection_window,
              max_follow_ups: this.config.max_follow_ups,
              require_tool_calls_for_success: this.config.require_tool_calls_for_success,
            },
            {
              onEvent: this.onEvent,
              overrides: {
                ...this.overrides,
                model: opts.model ?? this.overrides.model,
              },
              depth: opts.depth,
              subagentConfig: this.subagentConfig,
            }
          );

          // Store child session for management (send_input, close_agent)
          this.childSessions.set(opts.agentId, childSession);

          return { session: childSession, sessionId: childSession.getSessionId() };
        },
      });
    }
    return this.subagentManager;
  }

  /**
   * Clone the registry excluding subagent tools for child sessions.
   */
  private cloneRegistryWithoutSubagentTools(): ToolRegistry {
    return this.registry.cloneCoreTo(
      new ToolRegistry(),
      ['spawn_agent', 'send_input', 'wait', 'close_agent'],
    );
  }

  /**
   * Build the dynamic tool definitions for this turn.
   * spawn_agent is hidden when at max depth.
   * send_input, wait, close_agent are hidden when no children exist.
   */
  private getVisibleToolDefinitions(): ToolDefinition[] {
    const baseDefs = this.profile.visibleTools
      ? this.registry.definitionsForProfile(this.profile.visibleTools)
      : this.registry.definitions();

    const defs = [...baseDefs];

    // Add spawn_agent if below max depth
    if (this.depth < this.subagentConfig.max_subagent_depth) {
      const spawnDef = this.registry.definitions().find(d => d.name === 'spawn_agent');
      if (spawnDef && !defs.some(d => d.name === 'spawn_agent')) {
        defs.push(spawnDef);
      }
    }

    // Add management tools if children exist
    if (this.subagentManager?.hasChildren()) {
      for (const toolName of ['send_input', 'wait', 'close_agent']) {
        const def = this.registry.definitions().find(d => d.name === toolName);
        if (def && !defs.some(d => d.name === toolName)) {
          defs.push(def);
        }
      }
    }

    return defs;
  }

  private rejectPending(error: Error): void {
    for (const item of this.pendingInputs.splice(0)) {
      item.reject(error);
    }
    if (this.activeItem) {
      this.activeItem.reject(error);
      this.activeItem = undefined;
    }
  }

  private drainQueue(): void {
    if (this.state === 'PROCESSING' || this.state === 'CLOSED') return;
    const next = this.pendingInputs.shift();
    if (!next) {
      if (this.state !== 'IDLE') {
        this.transitionToAwaitingInput();
      }
      return;
    }

    this.activeItem = next;
    this.state = 'PROCESSING';

    if (next.isFollowUp) {
      this.followUpCount++;
    }

    const initializeEnv = typeof (this.env as Partial<ExecutionEnvironment>).initialize === 'function'
      ? () => (this.env as ExecutionEnvironment).initialize()
      : async () => {};
    const cleanupEnv = typeof (this.env as Partial<ExecutionEnvironment>).cleanup === 'function'
      ? () => (this.env as ExecutionEnvironment).cleanup()
      : async () => {};

    // Run the processing loop asynchronously.
    const runPromise = initializeEnv().then(() => this.processWorkItem(next));
    runPromise.then(
      (result) => {
        this.activeItem = undefined;
        next.resolve(result);
        if (this.state !== 'CLOSED') {
          // Check if there are more items
          if (this.pendingInputs.length > 0) {
            this.drainQueue();
          } else {
            this.transitionToAwaitingInput();
          }
        }
      },
      (err) => {
        this.activeItem = undefined;
        this.onEvent?.({
          type: 'agent_error',
          session_id: this.sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
        next.reject(err);
        if (this.state !== 'CLOSED') {
          this.transitionToAwaitingInput();
        }
      }
    ).finally(() => {
      void cleanupEnv();
    });
  }

  private async processWorkItem(item: WorkItem): Promise<SessionResult> {
    const startTime = Date.now();
    const loopDetector = this.config.enable_loop_detection === false
      ? null
      : new LoopDetector(this.config.loop_detection_window ?? 10);
    let turnCount = 0;
    let toolCallCount = 0;
    let toolRoundCount = 0;
    const aggregatedUsage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let lastStopReason = 'end_turn';
    let lastText = '';

    // Add user message to persistent conversation
    this.conversation.push({ role: 'user', content: item.prompt });

    while (canContinueWithLimit(this.lifetimeTurnCount, this.config.max_turns)) {
      if (this.aborted) {
        return this.buildResult('aborted', lastText, aggregatedUsage, turnCount, toolCallCount, lastStopReason, 'Session aborted', startTime);
      }

      this.lifetimeTurnCount++;
      turnCount++;
      this.onEvent?.({ type: 'agent_turn_started', turn_number: turnCount });

      this.abortController = new AbortController();
      if (this.aborted) {
        this.abortController.abort();
      }

      // Drain pending steers as user-role messages before LLM call
      while (this.pendingSteers.length > 0) {
        const steerMsg = this.pendingSteers.shift()!;
        this.conversation.push({ role: 'user', content: steerMsg });
        this.onEvent?.({
          type: 'agent_steering_injected',
          session_id: this.sessionId,
          message: steerMsg,
        });
      }

      // Build dynamic tool definitions for this turn
      const visibleTools = this.getVisibleToolDefinitions();
      const projectInstructions = await this.resolveProjectInstructions();

      // Build system prompt with current tool visibility, environment context, and git snapshot
      const toolNames = visibleTools.map((d) => d.name);
      const profileContext: ProfileContext = {
        workspace_root: this.config.workspace_root,
        project_instructions: projectInstructions,
        tool_names: toolNames,
        node_prompt: item.prompt,
      };
      const basePrompt = this.profile.systemPrompt(profileContext);

      // Add environment context (per turn — includes current tool names)
      const envBlock = await buildEnvironmentContext({
        env: this.env,
        workspaceRoot: this.config.workspace_root,
        provider: this.overrides.provider ?? this.profile.name,
        model: this.overrides.model ?? this.profile.defaultModel,
        visibleToolNames: toolNames,
      });

      // Cache git snapshot (once per session)
      if (this.cachedGitSnapshot === undefined) {
        try {
          this.cachedGitSnapshot = await buildGitSnapshot(this.config.workspace_root);
        } catch {
          this.cachedGitSnapshot = null;
        }
      }

      const promptParts = [basePrompt, envBlock];
      if (this.cachedGitSnapshot) promptParts.push(this.cachedGitSnapshot);
      const systemPrompt = promptParts.join('\n\n');

      // Stream model response
      let assistantText = '';
      let assistantTextStarted = false;
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let streamModel = '';
      let streamUsage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      let stopReason = 'end_turn';

      try {
        const streamModel_ = this.overrides.model ?? this.profile.defaultModel;
        const streamProvider_ = this.overrides.provider;
        const streamProviderOptions = mergeProviderOptions(
          this.profile.providerOptions() as ProviderOptions,
          this.overrides.providerOptions,
          item.provider_options as ProviderOptions | undefined,
        );
        const stream = this.client.stream({
          messages: this.conversation,
          system: systemPrompt,
          model: streamModel_,
          provider: streamProvider_,
          provider_options: streamProviderOptions,
          tools: visibleTools,
          max_tokens: 4096,
          abort_signal: this.abortController.signal,
          reasoning_effort: this.overrides.reasoningEffort,
        });

        for await (const event of stream) {
          if (this.aborted) break;

          switch (event.type) {
            case 'stream_start':
              streamModel = event.model;
              break;
            case 'content_delta':
              if (!assistantTextStarted) {
                assistantTextStarted = true;
                this.onEvent?.({
                  type: 'agent_assistant_text_start',
                  turn_number: turnCount,
                });
              }
              assistantText += event.text;
              this.onEvent?.({ type: 'agent_text_delta', text: event.text });
              break;
            case 'tool_call_delta': {
              if (event.name) {
                let existing = toolCalls.find((tc) => tc.id === event.id);
                if (!existing) {
                  existing = { id: event.id, name: event.name, arguments: '' };
                  toolCalls.push(existing);
                }
              }
              const tc = toolCalls.find((tc) => tc.id === event.id);
              if (tc) tc.arguments += event.arguments_delta;
              break;
            }
            case 'usage':
              streamUsage = event.usage;
              break;
            case 'stream_end':
              stopReason = event.stop_reason;
              if (assistantTextStarted) {
                this.onEvent?.({
                  type: 'agent_assistant_text_end',
                  turn_number: turnCount,
                  char_count: assistantText.length,
                });
              }
              break;
          }
        }
      } catch (err) {
        if (this.aborted) {
          return this.buildResult('aborted', lastText, aggregatedUsage, turnCount, toolCallCount, 'aborted', 'Session aborted', startTime);
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof ContextLengthError) {
          this.emitContextLengthRecoveryWarning(errMsg, streamModel);
          return this.buildResult(
            'failure',
            lastText,
            aggregatedUsage,
            turnCount,
            toolCallCount,
            'context_length_exceeded',
            errMsg,
            startTime,
          );
        }
        if (err instanceof AuthenticationError || err instanceof AccessDeniedError) {
          this.state = 'CLOSED';
          this.emitSessionEnded('closed');
          // Reject queued follow-ups because auth failures are terminal.
          const queued = this.pendingInputs.splice(0);
          for (const pending of queued) {
            pending.reject(new Error('Session closed due to authentication/access error.'));
          }
          if (this.subagentManager) {
            this.subagentManager.closeAll(this.childSessions);
          }
        }
        this.onEvent?.({
          type: 'agent_error',
          session_id: this.sessionId,
          message: errMsg,
        });
        return this.buildResult('failure', lastText, aggregatedUsage, turnCount, toolCallCount, 'error', errMsg, startTime);
      }

      // Aggregate usage
      aggregatedUsage.input_tokens += streamUsage.input_tokens;
      aggregatedUsage.output_tokens += streamUsage.output_tokens;
      aggregatedUsage.total_tokens = aggregatedUsage.input_tokens + aggregatedUsage.output_tokens;
      lastStopReason = stopReason;
      if (assistantText) lastText = assistantText;

      // Append assistant message to persistent conversation
      const assistantParts: ContentPart[] = [];
      if (assistantText) assistantParts.push({ type: 'text', text: assistantText });
      for (const tc of toolCalls) {
        assistantParts.push({ type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments });
      }
      this.conversation.push({
        role: 'assistant',
        content: assistantParts.length > 0 ? assistantParts : assistantText,
      });

      this.emitContextWindowWarningIfNeeded(streamModel);

      // Write to transcript
      this.transcriptWriter?.appendTranscript({
        role: 'assistant',
        text: assistantText,
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
        usage: streamUsage,
        model: streamModel,
        stop_reason: stopReason,
      });

      // If no tool calls, work item is complete.
      // Compatibility note: support both legacy and unified stop reasons.
      const isTerminalStop = stopReason === 'end_turn'
        || stopReason === 'max_tokens'
        || stopReason === 'stop'
        || stopReason === 'length';
      if (isTerminalStop || toolCalls.length === 0) {
        // Auto-close live children on completion
        if (this.subagentManager) {
          await this.subagentManager.closeAll(this.childSessions);
        }
        if (this.config.require_tool_calls_for_success && toolCallCount === 0) {
          return this.buildResult(
            'failure',
            lastText,
            aggregatedUsage,
            turnCount,
            toolCallCount,
            'no_tool_calls',
            'Agent produced no tool calls',
            startTime,
          );
        }
        return this.buildResult('success', lastText, aggregatedUsage, turnCount, toolCallCount, stopReason, undefined, startTime);
      }

      // Execute tool calls (parallel or sequential based on profile)
      const hasToolStopReason = stopReason === 'tool_use' || stopReason === 'tool_calls';
      if (hasToolStopReason || toolCalls.length > 0) {
        if (isLimitReached(toolRoundCount, this.config.max_tool_rounds_per_input)) {
          this.onEvent?.({
            type: 'agent_error',
            session_id: this.sessionId,
            message: `Tool round limit (${this.config.max_tool_rounds_per_input}) exceeded`,
          });
          return this.buildResult('failure', lastText, aggregatedUsage, turnCount, toolCallCount, 'tool_round_limit_exceeded', `Tool round limit (${this.config.max_tool_rounds_per_input}) exceeded`, startTime);
        }
        toolRoundCount++;

        const toolResults: ContentPart[] = [];
        const roundToolCalls: ToolCallEnvelope[] = [];
        const repairedArgsByIndex = new Map<number, Record<string, unknown>>();
        const resultByIndex = new Map<number, ToolResultEnvelope>();
        const executionEnvelopes: ToolCallEnvelope[] = [];
        const executionIndexes: number[] = [];

        // Build envelopes for executable calls and synthesize deterministic errors for invalid calls.
        for (let index = 0; index < toolCalls.length; index += 1) {
          const tc = toolCalls[index]!;
          const definition = this.registry.definition(tc.name);
          if (!definition) {
            this.onEvent?.({
              type: 'agent_tool_call_started',
              call_id: tc.id,
              tool_name: tc.name,
              arguments: {},
            });
            resultByIndex.set(index, {
              call_id: tc.id,
              content: `Unknown tool: '${tc.name}'.`,
              is_error: true,
            });
            continue;
          }

          const repaired = repairToolCall({
            tool_name: tc.name,
            raw_arguments: tc.arguments,
            schema: definition.input_schema,
          });

          if (!repaired.ok) {
            this.onEvent?.({
              type: 'agent_tool_call_started',
              call_id: tc.id,
              tool_name: tc.name,
              arguments: {},
            });
            resultByIndex.set(index, {
              call_id: tc.id,
              content: repaired.error.message,
              is_error: true,
            });
            continue;
          }

          if (repaired.call.changed && repaired.call.warning) {
            this.onEvent?.({
              type: 'agent_warning',
              session_id: this.sessionId,
              code: 'tool_call_repaired',
              message: repaired.call.warning,
            });
          }

          const envelope: ToolCallEnvelope = {
            name: repaired.call.tool_name,
            arguments: repaired.call.arguments,
            call_id: tc.id,
          };
          repairedArgsByIndex.set(index, envelope.arguments);
          executionEnvelopes.push(envelope);
          executionIndexes.push(index);
          roundToolCalls.push(envelope);
        }

        // Executor with event emission, loop tracking, and hook wrapping
        const executeOne = async (envelope: ToolCallEnvelope): Promise<ToolResultEnvelope> => {
          // Handle subagent tools — also wrapped by hooks
          const isSubagent = this.isSubagentTool(envelope.name);

          // Pre-hook
          if (this.hookRunner?.hasPreHook()) {
            const hookMeta: ToolHookMetadata = {
              run_id: this.hookContext?.run_id ?? '',
              node_id: this.hookContext?.node_id ?? '',
              session_id: this.sessionId,
              tool_call_id: envelope.call_id,
              tool_name: envelope.name,
              arguments: envelope.arguments,
            };
            const preResult = await this.hookRunner.runPreHook(hookMeta);
            if (!preResult.allowed) {
              // Blocked by pre-hook — emit event, run post-hook, return synthetic error
              this.onEvent?.({
                type: 'agent_tool_call_started',
                call_id: envelope.call_id,
                tool_name: envelope.name,
                arguments: envelope.arguments,
              });

              const blockedResult: ToolResultEnvelope = {
                call_id: envelope.call_id,
                content: `Tool call blocked by pre-hook (exit code ${preResult.exitCode})`,
                is_error: true,
              };

              // Run post-hook even for blocked calls
              if (this.hookRunner.hasPostHook()) {
                const postMeta: PostHookMetadata = {
                  ...hookMeta,
                  is_error: true,
                  content_preview: blockedResult.content.slice(0, 500),
                  duration_ms: 0,
                  blocked_by_pre_hook: true,
                };
                await this.hookRunner.runPostHook(postMeta);
              }

              (blockedResult as ToolResultEnvelope & { _duration_ms?: number })._duration_ms = 0;
              return blockedResult;
            }
          }

          if (isSubagent) {
            const result = await this.executeSubagentTool(envelope);

            // Post-hook for subagent tools
            if (this.hookRunner?.hasPostHook()) {
              const postMeta: PostHookMetadata = {
                run_id: this.hookContext?.run_id ?? '',
                node_id: this.hookContext?.node_id ?? '',
                session_id: this.sessionId,
                tool_call_id: envelope.call_id,
                tool_name: envelope.name,
                arguments: envelope.arguments,
                is_error: result.is_error,
                content_preview: result.content.slice(0, 500),
                duration_ms: (result as ToolResultEnvelope & { _duration_ms?: number })._duration_ms ?? 0,
                blocked_by_pre_hook: false,
              };
              await this.hookRunner.runPostHook(postMeta);
            }

            return result;
          }

          this.onEvent?.({
            type: 'agent_tool_call_started',
            call_id: envelope.call_id,
            tool_name: envelope.name,
            arguments: envelope.arguments,
          });

          const toolStartTime = Date.now();
          // Pass abort signal to tool execution for shell commands
          const toolEnv = this.abortController
            ? Object.create(this.env, {
                exec: {
                  value: (command: string, options?: { timeout_ms?: number; abort_signal?: AbortSignal }) => {
                    const requestedTimeout = options?.timeout_ms;
                    const defaultTimeout = this.config.default_command_timeout_ms;
                    const maxTimeout = this.config.max_command_timeout_ms ?? defaultTimeout;
                    const effectiveTimeout = Math.min(requestedTimeout ?? defaultTimeout, maxTimeout);
                    return this.env.exec(command, {
                      ...options,
                      timeout_ms: effectiveTimeout,
                      abort_signal: options?.abort_signal ?? this.abortController?.signal,
                    });
                  },
                },
              })
            : this.env;
          const result = await this.registry.execute(envelope, toolEnv, {
            output_limits: this.config.tool_output_limits,
            line_limits: this.config.tool_line_limits,
          });
          const toolDuration = Date.now() - toolStartTime;

          // Track mutations for loop detection
          if (
            loopDetector
            && !result.is_error
            && (envelope.name === 'write_file' || envelope.name === 'edit_file' || envelope.name === 'apply_patch')
          ) {
            loopDetector.markMutation();
          }

          // Store duration for later event emission (after artifact write)
          (result as ToolResultEnvelope & { _duration_ms?: number })._duration_ms = toolDuration;

          // Post-hook
          if (this.hookRunner?.hasPostHook()) {
            const postMeta: PostHookMetadata = {
              run_id: this.hookContext?.run_id ?? '',
              node_id: this.hookContext?.node_id ?? '',
              session_id: this.sessionId,
              tool_call_id: envelope.call_id,
              tool_name: envelope.name,
              arguments: envelope.arguments,
              is_error: result.is_error,
              content_preview: result.content.slice(0, 500),
              duration_ms: toolDuration,
              blocked_by_pre_hook: false,
            };
            await this.hookRunner.runPostHook(postMeta);
          }

          return result;
        };

        // Use parallel execution if enabled and multiple calls
        const useParallel = this.profile.parallel_tool_execution && executionEnvelopes.length > 1;
        let executedResults: ToolResultEnvelope[] = [];

        if (executionEnvelopes.length > 0) {
          if (useParallel) {
            executedResults = await executeToolsBatch(
              executionEnvelopes,
              executeOne,
              this.profile.max_parallel_tools,
              this.aborted ? AbortSignal.abort() : undefined,
            );
          } else {
            // Sequential fallback
            for (const envelope of executionEnvelopes) {
              if (this.aborted) {
                return this.buildResult('aborted', lastText, aggregatedUsage, turnCount, toolCallCount, 'aborted', 'Session aborted during tool execution', startTime);
              }
              executedResults.push(await executeOne(envelope));
            }
          }
        }

        for (let i = 0; i < executedResults.length; i += 1) {
          const index = executionIndexes[i]!;
          resultByIndex.set(index, executedResults[i]!);
        }

        // Assemble results in original call order
        for (let i = 0; i < toolCalls.length; i += 1) {
          const tc = toolCalls[i]!;
          const result = resultByIndex.get(i) ?? {
            call_id: tc.id,
            content: `Tool '${tc.name}' did not return a result.`,
            is_error: true,
            full_content: `Tool '${tc.name}' did not return a result.`,
            truncated: false,
          };
          toolCallCount++;

          // Write tool call artifacts and capture artifact path
          const artifactPath = await this.transcriptWriter?.writeToolCall(
            toolCallCount,
            tc.name,
            repairedArgsByIndex.get(i) ?? {},
            result.content,
            result.truncated ? result.full_content : undefined,
          );

          // Emit tool completion event with artifact path
          const toolDuration = (result as ToolResultEnvelope & { _duration_ms?: number })._duration_ms ?? 0;
          this.emitToolOutputDeltas(tc.id, tc.name, result.content);
          if (result.truncated) {
            this.onEvent?.({
              type: 'agent_warning',
              session_id: this.sessionId,
              code: 'tool_output_truncated',
              message: `Tool '${tc.name}' output was truncated for model preview.`,
            });
          }
          this.onEvent?.({
            type: 'agent_tool_call_completed',
            call_id: tc.id,
            tool_name: tc.name,
            duration_ms: toolDuration,
            is_error: result.is_error,
            content_preview: result.content.slice(0, 500),
            full_content: result.full_content ?? result.content,
            truncated: result.truncated ?? false,
            artifact_path: artifactPath,
          });

          toolResults.push({
            type: 'tool_result',
            tool_call_id: tc.id,
            content: result.content,
            is_error: result.is_error,
          });
        }

        this.conversation.push({ role: 'tool', content: toolResults });

        // Write tool round to transcript
        this.transcriptWriter?.appendTranscript({
          role: 'tool',
          results: toolResults.map((tr) => ({
            tool_call_id: (tr as Extract<ContentPart, { type: 'tool_result' }>).tool_call_id,
            content: (tr as Extract<ContentPart, { type: 'tool_result' }>).content,
            is_error: (tr as Extract<ContentPart, { type: 'tool_result' }>).is_error ?? false,
          })),
        });

        // Check for loops
        if (loopDetector) {
          const loopFp = loopDetector.recordRound(roundToolCalls);
          if (loopFp) {
            this.onEvent?.({ type: 'agent_loop_detected', fingerprint: loopFp, repetitions: 3 });
            this.loopSteeringCount += 1;
            if (this.loopSteeringCount >= 3) {
              this.onEvent?.({
                type: 'agent_error',
                session_id: this.sessionId,
                message: 'Loop detected 3 times after steering attempts',
              });
              return this.buildResult(
                'failure',
                lastText,
                aggregatedUsage,
                turnCount,
                toolCallCount,
                'loop_detected',
                'Loop detected 3 times after steering attempts',
                startTime,
              );
            }

            // Root cause note (Sprint 026): immediate termination prevented recovery.
            // We steer once, reset the loop window, and continue the turn loop.
            this.enqueueSteer(
              `Loop detected: you have repeated the same tool call pattern ${this.loopSteeringCount} time(s). `
              + 'Try a different approach - use different parameters, a different tool, or reconsider the problem.',
            );
            loopDetector.reset();
            continue;
          }
        }
      }
    }

    // Session-lifetime turn limit exceeded
    this.markTurnLimitExceeded();
    return this.buildResult('failure', lastText, aggregatedUsage, turnCount, toolCallCount, 'turn_limit_exceeded', `Turn limit (${this.config.max_turns}) exceeded`, startTime);
  }

  private isSessionTurnLimitExhausted(): boolean {
    return this.turnLimitExhausted && this.config.max_turns > 0;
  }

  private markTurnLimitExceeded(): void {
    if (this.turnLimitExhausted || this.config.max_turns <= 0) {
      return;
    }
    this.turnLimitExhausted = true;
    this.onEvent?.({
      type: 'agent_turn_limit_reached',
      session_id: this.sessionId,
      max_turns: this.config.max_turns,
    });
    this.onEvent?.({
      type: 'agent_error',
      session_id: this.sessionId,
      message: `Turn limit (${this.config.max_turns}) exceeded`,
    });

    const queued = this.pendingInputs.splice(0);
    const error = new Error(`Session turn limit (${this.config.max_turns}) has been exhausted.`);
    for (const pending of queued) {
      pending.reject(error);
    }
  }

  private isSubagentTool(name: string): boolean {
    return ['spawn_agent', 'send_input', 'wait', 'close_agent'].includes(name);
  }

  private async executeSubagentTool(envelope: ToolCallEnvelope): Promise<ToolResultEnvelope> {
    this.onEvent?.({
      type: 'agent_tool_call_started',
      call_id: envelope.call_id,
      tool_name: envelope.name,
      arguments: envelope.arguments,
    });

    const toolStartTime = Date.now();
    let content: string;
    let isError = false;

    try {
      switch (envelope.name) {
        case 'spawn_agent': {
          const manager = this.getOrCreateManager();
          const result = manager.spawn(
            envelope.arguments.task as string,
            {
              model: envelope.arguments.model as string | undefined,
              working_dir: envelope.arguments.working_dir as string | undefined,
              max_tool_rounds: envelope.arguments.max_tool_rounds as number | undefined,
              max_turns: envelope.arguments.max_turns as number | undefined,
              timeout_ms: envelope.arguments.timeout_ms as number | undefined,
            }
          );
          // If it's a SubAgentResult with error, it's a limit violation
          if ('error' in result && result.error && !('result_promise' in result)) {
            content = JSON.stringify({ error: result.error });
            isError = true;
          } else {
            const handle = result as SubAgentHandle;
            // Store child session for management
            const childEntry = (this.subagentManager as any)?.children?.get(handle.id);
            content = JSON.stringify({
              agent_id: handle.id,
              status: handle.status,
              working_dir: handle.working_dir,
              model: handle.model ?? this.overrides.model ?? this.profile.defaultModel ?? 'default',
            });
          }
          break;
        }
        case 'send_input': {
          const manager = this.subagentManager;
          if (!manager) {
            content = JSON.stringify({ error: 'No subagent manager — spawn a child first' });
            isError = true;
            break;
          }
          const handle = manager.getChild(envelope.arguments.agent_id as string);
          if (!handle) {
            content = JSON.stringify({ error: `Unknown agent_id: ${envelope.arguments.agent_id}` });
            isError = true;
            break;
          }
          const childSession = this.childSessions.get(envelope.arguments.agent_id as string);
          if (!childSession) {
            content = JSON.stringify({ error: `No session for agent_id: ${envelope.arguments.agent_id}` });
            isError = true;
            break;
          }
          const sendResult = await manager.sendInput(
            envelope.arguments.agent_id as string,
            envelope.arguments.message as string,
            childSession,
          );
          if ('error' in sendResult) {
            content = JSON.stringify(sendResult);
            isError = true;
          } else {
            content = JSON.stringify(sendResult);
          }
          break;
        }
        case 'wait': {
          const manager = this.subagentManager;
          if (!manager) {
            content = JSON.stringify({ error: 'No subagent manager — spawn a child first' });
            isError = true;
            break;
          }
          const rawIds = envelope.arguments.agent_ids;
          const ids = Array.isArray(rawIds) ? rawIds as string[] : [rawIds as string];
          const results = await manager.wait(ids);
          content = JSON.stringify({ results });
          break;
        }
        case 'close_agent': {
          const manager = this.subagentManager;
          if (!manager) {
            content = JSON.stringify({ error: 'No subagent manager — spawn a child first' });
            isError = true;
            break;
          }
          const childSession = this.childSessions.get(envelope.arguments.agent_id as string);
          if (!childSession) {
            content = JSON.stringify({ error: `No session for agent_id: ${envelope.arguments.agent_id}` });
            isError = true;
            break;
          }
          const closeResult = await manager.close(
            envelope.arguments.agent_id as string,
            childSession,
          );
          content = JSON.stringify(closeResult);
          break;
        }
        default:
          content = JSON.stringify({ error: `Unknown subagent tool: ${envelope.name}` });
          isError = true;
      }
    } catch (err) {
      content = err instanceof Error ? err.message : String(err);
      isError = true;
    }

    const toolDuration = Date.now() - toolStartTime;
    const result: ToolResultEnvelope & { _duration_ms?: number } = {
      call_id: envelope.call_id,
      content,
      is_error: isError,
      full_content: content,
      truncated: false,
    };
    result._duration_ms = toolDuration;
    return result;
  }

  private emitSessionStarted(): void {
    if (this.sessionStartedEmitted) {
      return;
    }
    this.sessionStartedEmitted = true;
    this.onEvent?.({
      type: 'agent_session_started',
      node_id: '',
      provider: this.overrides.provider ?? this.profile.name,
      model: this.overrides.model ?? this.profile.defaultModel ?? 'default',
      session_id: this.sessionId,
      workspace_root: this.config.workspace_root,
      state: this.state,
    });
  }

  private async resolveProjectInstructions(): Promise<string> {
    if (this.explicitProjectInstructions !== undefined) {
      return this.explicitProjectInstructions;
    }

    if (this.cachedDiscoveredInstructions === undefined) {
      try {
        this.cachedDiscoveredInstructions = await discoverInstructions(
          this.config.workspace_root,
          this.profile.name,
          this.env.cwd,
        );
      } catch {
        this.cachedDiscoveredInstructions = '';
      }
    }

    return this.cachedDiscoveredInstructions ?? '';
  }

  private transitionToAwaitingInput(): void {
    const shouldEmit = this.state !== 'AWAITING_INPUT';
    this.state = 'AWAITING_INPUT';
    if (!shouldEmit) {
      return;
    }
    this.onEvent?.({
      type: 'agent_processing_ended',
      session_id: this.sessionId,
      state: 'AWAITING_INPUT',
      pending_inputs: this.pendingInputs.length,
    });
  }

  private emitSessionEnded(reason: 'closed' | 'aborted'): void {
    if (this.sessionEndedEmitted) {
      return;
    }
    this.sessionEndedEmitted = true;
    this.onEvent?.({
      type: 'agent_session_ended',
      session_id: this.sessionId,
      reason,
      final_state: this.state,
    });
  }

  private emitToolOutputDeltas(callId: string, toolName: string, content: string): void {
    const chunkSize = 200;
    const chunks = splitIntoChunks(content, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
      this.onEvent?.({
        type: 'agent_tool_call_output_delta',
        call_id: callId,
        tool_name: toolName,
        delta: chunks[i]!,
        chunk_index: i + 1,
        chunk_count: chunks.length,
      });
    }
  }

  private buildResult(
    status: SessionResult['status'],
    finalText: string,
    usage: Usage,
    turnCount: number,
    toolCallCount: number,
    stopReason: string,
    errorMessage: string | undefined,
    startTime: number
  ): SessionResult {
    const duration = Date.now() - startTime;

    this.onEvent?.({
      type: 'agent_session_completed',
      status,
      turn_count: turnCount,
      tool_call_count: toolCallCount,
      duration_ms: duration,
      session_id: this.sessionId,
      final_state: this.state,
    });

    return {
      status,
      final_text: finalText,
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      turn_count: turnCount,
      tool_call_count: toolCallCount,
      stop_reason: stopReason,
      error_message: errorMessage,
    };
  }

  private emitContextLengthRecoveryWarning(message: string, streamModel: string): void {
    const estimatedTokens = Math.ceil(this.estimateConversationChars() / 4);
    const modelInfo = this.resolveModelInfo(streamModel);
    const contextWindow = modelInfo?.context_window ?? 0;
    const usagePct = contextWindow > 0
      ? Number(((estimatedTokens / contextWindow) * 100).toFixed(2))
      : 100;

    this.onEvent?.({
      type: 'agent_warning',
      session_id: this.sessionId,
      code: 'context_window_pressure',
      message: `${message}. Session remains recoverable; submit a shorter follow-up to continue.`,
    });
    this.onEvent?.({
      type: 'context_window_warning',
      session_id: this.sessionId,
      usage_pct: usagePct,
      estimated_tokens: estimatedTokens,
      context_window: contextWindow,
    });
  }

  private emitContextWindowWarningIfNeeded(streamModel: string): void {
    if (this.contextWindowWarningEmitted) {
      return;
    }

    const modelInfo = this.resolveModelInfo(streamModel);
    if (!modelInfo || modelInfo.context_window <= 0) {
      return;
    }

    const estimatedTokens = Math.ceil(this.estimateConversationChars() / 4);
    const usagePct = (estimatedTokens / modelInfo.context_window) * 100;
    if (usagePct < 80) {
      return;
    }

    this.contextWindowWarningEmitted = true;
    const warningMessage = `Context usage at ~${usagePct.toFixed(2)}% of context window`;
    this.onEvent?.({
      type: 'agent_warning',
      session_id: this.sessionId,
      code: 'context_window_pressure',
      message: warningMessage,
    });
    this.onEvent?.({
      type: 'context_window_warning',
      session_id: this.sessionId,
      usage_pct: Number(usagePct.toFixed(2)),
      estimated_tokens: estimatedTokens,
      context_window: modelInfo.context_window,
    });
  }

  private resolveModelInfo(streamModel: string): ReturnType<typeof getModelInfo> {
    const provider = this.overrides.provider ?? this.profile.name;
    const modelCandidates = [streamModel, this.overrides.model, this.profile.defaultModel].filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    return modelCandidates
      .map((candidate) => getModelInfo(candidate, provider) ?? getModelInfo(candidate))
      .find((candidate) => candidate !== undefined);
  }

  private estimateConversationChars(): number {
    let totalChars = 0;
    for (const message of this.conversation) {
      if (typeof message.content === 'string') {
        totalChars += message.content.length;
        continue;
      }

      for (const part of message.content) {
        if (part.type === 'text') {
          totalChars += part.text.length;
        } else if (part.type === 'tool_call') {
          totalChars += part.name.length + part.arguments.length;
        } else if (part.type === 'tool_result') {
          totalChars += part.content.length;
        } else if (part.type === 'thinking') {
          totalChars += part.thinking.length;
        }
      }
    }
    return totalChars;
  }
}

function mergeProviderOptions(...options: Array<ProviderOptions | undefined>): ProviderOptions {
  const merged: Record<string, unknown> = {};
  for (const entry of options) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    for (const [key, value] of Object.entries(entry)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        merged[key] = value;
        continue;
      }
      const existing = merged[key];
      merged[key] = {
        ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {}),
        ...value as Record<string, unknown>,
      };
    }
  }
  return merged as ProviderOptions;
}

function splitIntoChunks(value: string, size: number): string[] {
  if (!value) {
    return [];
  }
  if (size <= 0 || value.length <= size) {
    return [value];
  }

  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += size) {
    chunks.push(value.slice(i, i + size));
  }
  return chunks;
}

export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}
