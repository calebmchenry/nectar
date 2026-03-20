import { randomUUID } from 'node:crypto';
import type { UnifiedClient } from '../llm/client.js';
import type { ContentPart, Message, Usage } from '../llm/types.js';
import { executeToolsBatch } from '../llm/tools.js';
import type { ToolDefinition } from '../llm/tools.js';
import { ToolRegistry } from './tool-registry.js';
import type { ProviderProfile, ProfileContext } from './provider-profiles.js';
import { buildEnvironmentContext, buildGitSnapshot } from './environment-context.js';
import type { ExecutionEnvironment } from './execution-environment.js';
import type { SessionConfig, SessionResult, SessionState, WorkItem, ToolCallEnvelope, ToolResultEnvelope, SubagentConfig, SubAgentHandle, SubAgentResult } from './types.js';
import { DEFAULT_SUBAGENT_CONFIG } from './types.js';
import type { AgentEventListener } from './events.js';
import { LoopDetector } from './loop-detection.js';
import type { TranscriptWriter } from './transcript.js';
import { SubagentManager } from './subagent-manager.js';
import { ToolHookRunner, resolveHooks } from './tool-hooks.js';
import type { ResolvedHooks, ToolHookMetadata, PostHookMetadata } from './tool-hooks.js';

export interface SessionOverrides {
  provider?: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
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

  // Cached git snapshot (computed once per session)
  private cachedGitSnapshot: string | null | undefined = undefined;

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
    this.client = client;
    this.registry = registry;
    this.profile = profile;
    this.env = env;
    this.config = config;
    this.onEvent = options?.onEvent;
    this.transcriptWriter = options?.transcriptWriter;
    this.overrides = options?.overrides ?? {};
    this.sessionId = randomUUID();
    this.maxFollowUps = config.max_follow_ups ?? 10;
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
  submit(prompt: string): Promise<SessionResult> {
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
    if (this.state === 'PROCESSING') {
      return Promise.reject(new Error('Cannot submit while session is PROCESSING. Use steer() or followUp() instead.'));
    }

    return new Promise<SessionResult>((resolve, reject) => {
      const item: WorkItem = { prompt, resolve, reject, isFollowUp: false };
      this.pendingInputs.push(item);
      this.drainQueue();
    });
  }

  /**
   * Enqueue a follow-up that reuses the existing conversation.
   */
  followUp(prompt: string): Promise<SessionResult> {
    if (this.state === 'CLOSED') {
      return Promise.reject(new Error('Cannot follow up on a CLOSED session'));
    }

    if (this.followUpCount >= this.maxFollowUps) {
      return Promise.reject(new Error(`Follow-up limit (${this.maxFollowUps}) exceeded`));
    }

    // Record follow-up in transcript
    this.transcriptWriter?.appendTranscript({ role: 'user', text: `[follow-up] ${prompt}` });

    return new Promise<SessionResult>((resolve, reject) => {
      const item: WorkItem = { prompt, resolve, reject, isFollowUp: true };
      this.pendingInputs.push(item);
      if (this.state === 'AWAITING_INPUT') {
        this.drainQueue();
      }
    });
  }

  /**
   * Inject a developer-role steering message before the next LLM call.
   * Only valid while PROCESSING.
   */
  steer(message: string): void {
    if (this.state !== 'PROCESSING') {
      throw new Error(`Cannot steer a session in ${this.state} state`);
    }
    this.pendingSteers.push(message);
    this.transcriptWriter?.appendTranscript({ role: 'steer', text: message });
  }

  /**
   * Graceful close — transition to CLOSED, reject any pending items.
   */
  close(): void {
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSED';
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
      this.rejectPending(new AbortError('Session aborted'));
    }
  }

  /**
   * Compatibility wrapper: behaves like the old processInput().
   */
  async processInput(
    prompt: string,
    projectInstructions?: string
  ): Promise<SessionResult> {
    // Store project instructions for system prompt building
    this._projectInstructions = projectInstructions;
    return this.submit(prompt);
  }

  // Internal: project instructions stashed by processInput for system prompt
  private _projectInstructions?: string;

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
            },
            {
              onEvent: this.onEvent,
              overrides: this.overrides,
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
        this.state = 'AWAITING_INPUT';
      }
      return;
    }

    this.activeItem = next;
    this.state = 'PROCESSING';

    if (next.isFollowUp) {
      this.followUpCount++;
    }

    // Run the processing loop asynchronously
    this.processWorkItem(next).then(
      (result) => {
        this.activeItem = undefined;
        next.resolve(result);
        if (this.state !== 'CLOSED') {
          // Check if there are more items
          if (this.pendingInputs.length > 0) {
            this.drainQueue();
          } else {
            this.state = 'AWAITING_INPUT';
          }
        }
      },
      (err) => {
        this.activeItem = undefined;
        next.reject(err);
        if (this.state !== 'CLOSED') {
          this.state = 'AWAITING_INPUT';
        }
      }
    );
  }

  private async processWorkItem(item: WorkItem): Promise<SessionResult> {
    const startTime = Date.now();
    const loopDetector = new LoopDetector();
    let turnCount = 0;
    let toolCallCount = 0;
    let toolRoundCount = 0;
    const aggregatedUsage: Usage = { input_tokens: 0, output_tokens: 0 };
    let lastStopReason = 'end_turn';
    let lastText = '';

    // Add user message to persistent conversation
    this.conversation.push({ role: 'user', content: item.prompt });

    while (turnCount < this.config.max_turns) {
      if (this.aborted) {
        return this.buildResult('aborted', lastText, aggregatedUsage, turnCount, toolCallCount, lastStopReason, 'Session aborted', startTime);
      }

      turnCount++;
      this.onEvent?.({ type: 'agent_turn_started', turn_number: turnCount });

      this.abortController = new AbortController();
      if (this.aborted) {
        this.abortController.abort();
      }

      // Drain pending steers as developer-role messages before LLM call
      while (this.pendingSteers.length > 0) {
        const steerMsg = this.pendingSteers.shift()!;
        this.conversation.push({ role: 'developer' as Message['role'], content: steerMsg });
      }

      // Build dynamic tool definitions for this turn
      const visibleTools = this.getVisibleToolDefinitions();

      // Build system prompt with current tool visibility, environment context, and git snapshot
      const toolNames = visibleTools.map((d) => d.name);
      const profileContext: ProfileContext = {
        workspace_root: this.config.workspace_root,
        project_instructions: this._projectInstructions ?? '',
        tool_names: toolNames,
        node_prompt: item.prompt,
      };
      const basePrompt = this.profile.systemPrompt(profileContext);

      // Add environment context (per turn — includes current tool names)
      const envBlock = buildEnvironmentContext({
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
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let streamModel = '';
      let streamUsage: Usage = { input_tokens: 0, output_tokens: 0 };
      let stopReason = 'end_turn';

      try {
        const streamModel_ = this.overrides.model ?? this.profile.defaultModel;
        const streamProvider_ = this.overrides.provider;
        const stream = this.client.stream({
          messages: this.conversation,
          system: systemPrompt,
          model: streamModel_,
          provider: streamProvider_,
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
              break;
          }
        }
      } catch (err) {
        if (this.aborted) {
          return this.buildResult('aborted', lastText, aggregatedUsage, turnCount, toolCallCount, 'aborted', 'Session aborted', startTime);
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        return this.buildResult('failure', lastText, aggregatedUsage, turnCount, toolCallCount, 'error', errMsg, startTime);
      }

      // Aggregate usage
      aggregatedUsage.input_tokens += streamUsage.input_tokens;
      aggregatedUsage.output_tokens += streamUsage.output_tokens;
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

      // Write to transcript
      this.transcriptWriter?.appendTranscript({
        role: 'assistant',
        text: assistantText,
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
        usage: streamUsage,
        model: streamModel,
        stop_reason: stopReason,
      });

      // If no tool calls, work item is complete
      if (stopReason === 'end_turn' || stopReason === 'max_tokens' || toolCalls.length === 0) {
        // Auto-close live children on completion
        if (this.subagentManager) {
          await this.subagentManager.closeAll(this.childSessions);
        }
        return this.buildResult('success', lastText, aggregatedUsage, turnCount, toolCallCount, stopReason, undefined, startTime);
      }

      // Execute tool calls (parallel or sequential based on profile)
      if (stopReason === 'tool_use') {
        if (toolRoundCount >= this.config.max_tool_rounds_per_input) {
          return this.buildResult('failure', lastText, aggregatedUsage, turnCount, toolCallCount, 'tool_round_limit_exceeded', `Tool round limit (${this.config.max_tool_rounds_per_input}) exceeded`, startTime);
        }
        toolRoundCount++;

        const toolResults: ContentPart[] = [];
        const roundToolCalls: ToolCallEnvelope[] = [];

        // Build envelopes for all tool calls
        const envelopes: ToolCallEnvelope[] = [];
        for (const tc of toolCalls) {
          let parsedArgs: Record<string, unknown>;
          try {
            parsedArgs = JSON.parse(tc.arguments || '{}');
          } catch {
            parsedArgs = {};
          }
          const envelope: ToolCallEnvelope = {
            name: tc.name,
            arguments: parsedArgs,
            call_id: tc.id,
          };
          envelopes.push(envelope);
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
                    return this.env.exec(command, {
                      ...options,
                      abort_signal: options?.abort_signal ?? this.abortController?.signal,
                    });
                  },
                },
              })
            : this.env;
          const result = await this.registry.execute(envelope, toolEnv);
          const toolDuration = Date.now() - toolStartTime;

          // Track mutations for loop detection
          if (!result.is_error && (envelope.name === 'write_file' || envelope.name === 'edit_file' || envelope.name === 'apply_patch')) {
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
        const useParallel = this.profile.parallel_tool_execution && envelopes.length > 1;
        let results: ToolResultEnvelope[];

        if (useParallel) {
          results = await executeToolsBatch(
            envelopes,
            executeOne,
            this.profile.max_parallel_tools,
            this.aborted ? AbortSignal.abort() : undefined,
          );
        } else {
          // Sequential fallback
          results = [];
          for (const envelope of envelopes) {
            if (this.aborted) {
              return this.buildResult('aborted', lastText, aggregatedUsage, turnCount, toolCallCount, 'aborted', 'Session aborted during tool execution', startTime);
            }
            results.push(await executeOne(envelope));
          }
        }

        // Assemble results in original call order
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          const tc = toolCalls[i]!;
          toolCallCount++;

          // Write tool call artifacts and capture artifact path
          const artifactPath = await this.transcriptWriter?.writeToolCall(toolCallCount, tc.name, envelopes[i]!.arguments, result.content, result.full_content);

          // Emit tool completion event with artifact path
          const toolDuration = (result as ToolResultEnvelope & { _duration_ms?: number })._duration_ms ?? 0;
          this.onEvent?.({
            type: 'agent_tool_call_completed',
            call_id: tc.id,
            tool_name: tc.name,
            duration_ms: toolDuration,
            is_error: result.is_error,
            content_preview: result.content.slice(0, 500),
            full_content: result.full_content,
            truncated: result.full_content !== undefined,
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
        const loopFp = loopDetector.recordRound(roundToolCalls);
        if (loopFp) {
          this.onEvent?.({ type: 'agent_loop_detected', fingerprint: loopFp, repetitions: 3 });
          return this.buildResult('failure', lastText, aggregatedUsage, turnCount, toolCallCount, 'loop_detected', 'Agent loop detected: repeated identical tool calls without progress', startTime);
        }
      }
    }

    // Turn limit exceeded
    return this.buildResult('failure', lastText, aggregatedUsage, turnCount, toolCallCount, 'turn_limit_exceeded', `Turn limit (${this.config.max_turns}) exceeded`, startTime);
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
              model: this.overrides.model ?? this.profile.defaultModel ?? 'default',
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
    this.onEvent?.({
      type: 'agent_tool_call_completed',
      call_id: envelope.call_id,
      tool_name: envelope.name,
      duration_ms: toolDuration,
      is_error: isError,
      content_preview: content.slice(0, 500),
    });

    return {
      call_id: envelope.call_id,
      content,
      is_error: isError,
    };
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
}

export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}
