GAPS REMAINING

# Nectar Compliance Report

**Generated:** 2026-03-21
**Specs reviewed:** attractor-spec.md, coding-agent-loop-spec.md, unified-llm-spec.md
**Source directory:** src/

---

## IMPLEMENTED

### Attractor Spec — DOT Parsing (Section 2)

- **DOT subset parser** — `src/garden/parse.ts` parses digraph with directed edges, node/edge attributes, comments (`//` and `/* */`), quoted/unquoted values, subgraphs, node/edge default blocks, chained edges
- **Graph-level attributes** — goal, label, model_stylesheet, default_max_retries (with legacy alias `default_max_retry`), retry_target, fallback_retry_target, default_fidelity all in `src/garden/types.ts` GardenGraph
- **Node attributes** — label, shape, type, prompt, max_retries, goal_gate, retry_target, fallback_retry_target, fidelity, thread_id, class, timeout, llm_model, llm_provider, reasoning_effort, auto_status, allow_partial all in GardenNode
- **Edge attributes** — label, condition, weight, fidelity, thread_id, loop_restart all in GardenEdge
- **Shape-to-handler mapping** — All 9 shapes: Mdiamond->start, Msquare->exit, box->codergen, hexagon->wait.human, diamond->conditional, component->parallel, tripleoctagon->parallel.fan_in, parallelogram->tool, house->stack.manager_loop (`src/garden/types.ts` normalizeNodeKind)
- **Value types** — String, Integer, Float, Boolean, Duration (ms/s/m/h/d) all parsed (`src/garden/parse.ts`)
- **Subgraph scoping** — Subgraph stack with class derivation and default merging (`src/garden/parse.ts`)
- **Node/edge default blocks** — AttributeScope with scopeStack (`src/garden/parse.ts`)
- **Class attribute** — Comma-separated classes merged from subgraph and explicit declaration (`src/garden/parse.ts`)
- **Chained edges** — `A -> B -> C` produces one edge per pair (`src/garden/parse.ts`)
- **Semicolons optional** — Statement-terminating semicolons accepted but not required
- **Bare identifiers** — Node IDs enforced as `[A-Za-z_][A-Za-z0-9_]*`

### Attractor Spec — Pipeline Execution Engine (Section 3)

- **Run lifecycle** — PARSE->TRANSFORM->VALIDATE->INITIALIZE->EXECUTE->FINALIZE (`src/garden/preparer.ts`, `src/engine/engine.ts`)
- **Core execution loop** — Graph traversal from start, handler execution, edge selection, checkpoints (`src/engine/engine.ts` run())
- **Edge selection algorithm** — All 5 priority steps: condition->preferred_label->suggested_ids->weight->lexical (`src/engine/edge-selector.ts`)
- **Label normalization** — Lowercase, trim, strip accelerator prefixes (`src/engine/edge-selector.ts`)
- **Goal gate enforcement** — Exit blocked when unsatisfied goal gates; retry target resolution (node->graph->fallback) (`src/engine/engine.ts` checkGoalGates, resolveFailureTarget)
- **Retry logic** — max_retries with execute_with_retry loop, backoff with jitter (`src/engine/engine.ts`, `src/engine/retry.ts`)
- **Retry policy presets** — none, standard, aggressive, linear, patient (`src/engine/retry.ts`)
- **allow_partial on retry exhaustion** — PARTIAL_SUCCESS accepted when retries exhausted (`src/engine/engine.ts`)
- **Failure routing** — fail edge->retry_target->fallback->terminate (`src/engine/engine.ts` resolveFailureTarget)
- **loop_restart handling** — Edge attribute terminates run and re-launches (`src/engine/engine.ts`)
- **Context keys mirrored** — graph.goal, current_node, outcome, preferred_label, last_stage, last_response, internal.retry_count all set by engine

### Attractor Spec — Node Handlers (Section 4)

- **Handler interface** — NodeHandler with register/resolve (`src/handlers/registry.ts`)
- **Start handler** — No-op, returns SUCCESS (`src/handlers/start.ts`)
- **Exit handler** — No-op, returns SUCCESS (`src/handlers/exit.ts`)
- **Codergen handler** — $goal expansion, prompt.md/response.md/agent-status.json, accepts UnifiedClient or LLMClient backend (`src/handlers/codergen.ts`)
- **Wait.human handler** — Choices from edges, accelerator key parsing ([K], K), K -) (`src/handlers/wait-human.ts`, `src/interviewer/types.ts`)
- **Conditional handler** — No-op routing point, returns SUCCESS (`src/handlers/conditional.ts`)
- **Parallel handler** — Fan-out with bounded concurrency, wait_all and first_success join policies (`src/handlers/parallel.ts`)
- **Fan-in handler** — Heuristic selection by status rank + LLM-prompted selection path (`src/handlers/fan-in.ts`)
- **Tool handler** — Shell execution with timeout, env vars, exit code handling (`src/handlers/tool.ts`)
- **Manager loop handler** — Observe/steer/wait cycles over child pipeline, poll/stop condition (`src/handlers/manager-loop.ts`)
- **Custom handler registration** — register() adds new handlers (`src/handlers/registry.ts`)
- **Handler panics caught** — Engine catches handler errors and converts to failure outcome (`src/engine/engine.ts`)

### Attractor Spec — State and Context (Section 5)

- **Context model** — Key-value store with get/set/clone/snapshot/append_log (`src/engine/context.ts`)
- **Outcome model** — status, preferred_label, suggested_next_ids, context_updates, notes, failure_reason (`src/engine/types.ts` NodeOutcome)
- **Canonical node status artifacts** — Engine `status.json` includes outcome, preferred_label, suggested_next_ids, context_updates, notes, node_id, started_at, completed_at, duration_ms; notes also mirrored into `steps.<node_id>.notes` context (`src/engine/engine.ts`)
- **StageStatus values** — SUCCESS, FAIL, PARTIAL_SUCCESS, RETRY, SKIPPED (`src/engine/types.ts`)
- **Checkpoint/resume** — Save after each node via cocoon system; resume from last checkpoint (`src/checkpoint/cocoon.ts`, `src/engine/engine.ts`)
- **Degraded fidelity on resume** — full->summary:high on checkpoint restore (`src/engine/engine.ts`)
- **Context fidelity modes** — full, truncate, compact, summary:low/medium/high (`src/engine/fidelity.ts`)
- **Fidelity resolution precedence** — edge->node->graph->compact default (`src/engine/fidelity.ts`)
- **Thread resolution** — node->edge->graph->class->previous for full fidelity (`src/engine/thread-resolver.ts`)
- **Artifact store** — store/retrieve/has/list/remove/clear with 100KB file-backed threshold (`src/artifacts/store.ts`)
- **Run directory structure** — Checkpoint, node dirs, artifacts via RunStore (`src/checkpoint/run-store.ts`)

### Attractor Spec — Human-in-the-Loop (Section 6)

- **Interviewer interface** — ask, ask_multiple, inform (`src/interviewer/types.ts`)
- **Question model** — text, type, options, default, timeout, stage (`src/interviewer/types.ts`)
- **QuestionType** — YES_NO, MULTIPLE_CHOICE, FREEFORM, CONFIRMATION (`src/interviewer/types.ts`)
- **CONFIRMATION behavior** — Auto-approve treats CONFIRMATION as affirmative by default; wait.human renders confirmation-specific affirmative/decline prompts (`src/interviewer/auto-approve.ts`, `src/handlers/wait-human.ts`)
- **Answer model** — selected_label, source, answer_value, selected_option, text (`src/interviewer/types.ts`)
- **AnswerValue** — YES, NO, SKIPPED, TIMEOUT (`src/interviewer/types.ts`)
- **All interviewer implementations** — AutoApprove, Console, Callback, Queue, Recording (`src/interviewer/`)
- **Timeout handling** — Default answer or TIMEOUT on expiry (`src/interviewer/console.ts`, `src/handlers/wait-human.ts`)

### Attractor Spec — Validation and Linting (Section 7)

- **Diagnostic model** — rule, severity, message, node_id, edge, fix (`src/garden/types.ts`)
- **All lint rules** — start_node, terminal_node, reachability, edge_target_exists, start_no_incoming, exit_no_outgoing, condition_syntax, stylesheet_syntax, type_known, fidelity_valid, retry_target_exists, goal_gate_has_retry, prompt_on_llm_nodes (`src/garden/validate.ts`)
- **Validation API** — validateGarden returns Diagnostic[], errors reject pipeline (`src/garden/validate.ts`, `src/garden/preparer.ts`)

### Attractor Spec — Model Stylesheet (Section 8)

- **Stylesheet grammar** — Full tokenizer/parser for `selector { property: value }` (`src/garden/stylesheet.ts`)
- **Selectors** — * (universal), shape, .class, #id with specificity ordering (`src/garden/stylesheet.ts`)
- **Properties** — llm_model, llm_provider, reasoning_effort (`src/garden/stylesheet.ts`)
- **Application order** — explicit inline > stylesheet > graph default > handler default (`src/transforms/stylesheet-apply.ts`)

### Attractor Spec — Transforms and Extensibility (Section 9)

- **AST transforms** — Modify graph after parsing, before validation (`src/transforms/types.ts`, `src/garden/preparer.ts`)
- **Built-in transforms** — $goal variable expansion (`src/transforms/goal-expansion.ts`), stylesheet application (`src/transforms/stylesheet-apply.ts`)
- **Custom transforms** — Register and run in order (`src/transforms/registry.ts`)
- **HTTP server mode** — POST /pipelines, GET /pipelines/:id, GET /pipelines/:id/events (SSE), POST /pipelines/:id/cancel, GET /pipelines/:id/graph, GET /pipelines/:id/questions, POST /pipelines/:id/questions/:qid/answer, GET /pipelines/:id/checkpoint, GET /pipelines/:id/context (`src/server/routes/pipelines.ts`)
- **Observability events** — RunStarted, NodeStarted, NodeCompleted, StageFailed, NodeRetrying, EdgeSelected, RunCompleted, PipelineFailed, HumanQuestion, HumanAnswer, InterviewStarted/Completed/Timeout, ParallelStarted/BranchStarted/BranchCompleted/Completed (`src/engine/events.ts`)
- **Tool call hooks** — tool_hooks.pre and tool_hooks.post on nodes and graph level (`src/garden/parse.ts`, `src/handlers/codergen.ts`)

### Attractor Spec — Condition Expression Language (Section 10)

- **Grammar** — Full parser with =, !=, AND (&&), OR (||), NOT, CONTAINS, STARTS_WITH, ENDS_WITH, <, >, <=, >= (`src/engine/condition-parser.ts`)
- **Variable resolution** — outcome, preferred_label, context.*, steps.*, artifacts, plus unqualified context-key fallback with reserved-root precedence (`src/engine/conditions.ts`)
- **Extended operators** — Implemented beyond spec baseline with CONTAINS, STARTS_WITH, ENDS_WITH, numeric comparisons

### Coding Agent Loop — Session and Agentic Loop (Sections 1-2)

- **Session model** — id (UUID), provider_profile, execution_env, history, event_emitter, config, state, llm_client, steering_queue, followup_queue, subagents (`src/agent-loop/session.ts`)
- **SessionConfig** — max_turns (session-lifetime), max_tool_rounds_per_input, default_command_timeout_ms (10s), max_command_timeout_ms (10min), reasoning_effort, tool_output_limits, tool_line_limits, enable_loop_detection, loop_detection_window (`src/agent-loop/types.ts`)
- **Session lifecycle** — IDLE, PROCESSING, AWAITING_INPUT, CLOSED with correct state transitions (`src/agent-loop/session.ts`)
- **Core agentic loop** — Limit checks, abort signal, system prompt build, LLM stream call, assistant turn recording, tool execution, steering drain, loop detection, follow-up processing (`src/agent-loop/session.ts` processWorkItem)
- **Steering queue** — steer() queues messages injected between tool rounds as user-role messages (`src/agent-loop/session.ts`)
- **Follow-up queue** — followUp() queues work items processed after current input completes (`src/agent-loop/session.ts`)
- **Reasoning effort** — Passed through to LLM, changeable mid-session via overrides
- **Stop conditions** — Natural completion (no tool calls), round limit, session-lifetime turn limit, abort signal, unrecoverable error (AuthenticationError)
- **Context-length recovery** — ContextLengthError emits warning events, fails only the active work item, and leaves session recoverable in `AWAITING_INPUT` (`src/agent-loop/session.ts`)
- **Loop detection** — Pattern detection (length 1, 2, 3 with MIN_PATTERN_REPEATS=3), steering injection, three-strike termination (`src/agent-loop/loop-detection.ts`)
- **Library design** — Programmable AgentSession with submit/steer/followUp/abort/close APIs; event-driven via callback

### Coding Agent Loop — Event System (Section 2.9)

- **All event types** — agent_session_started, agent_session_completed, agent_session_ended, agent_user_input, agent_processing_ended, agent_assistant_text_start, agent_text_delta, agent_assistant_text_end, agent_tool_call_started, agent_tool_call_output_delta, agent_tool_call_completed (always with full_content), agent_steering_injected, agent_turn_limit_reached, agent_loop_detected, agent_warning, agent_error, context_window_warning (`src/agent-loop/events.ts`, `src/agent-loop/session.ts`)

### Coding Agent Loop — Provider-Aligned Toolsets (Section 3)

- **Three provider profiles** — AnthropicProfile, OpenAIProfile, GeminiProfile with distinct tool sets and system prompts (`src/agent-loop/provider-profiles.ts`)
- **ProviderProfile interface** — name, systemPrompt(), providerOptions(), defaultModel, context_window_size, supports_reasoning, supports_streaming, parallel_tool_execution, max_parallel_tools, visibleTools
- **Shared core tools** — read_file (line-numbered, offset/limit, binary detection), write_file (parent dirs, bytes), edit_file (old_string/new_string, replace_all, fuzzy fallback), shell (timeout, env filtering), grep (pattern/path/glob/case), glob (pattern/path/max_results) (`src/agent-loop/tools/`)
- **OpenAI profile** — Includes apply_patch tool, v4a format in system prompt (`src/agent-loop/tools/apply-patch.ts`)
- **Anthropic profile** — Uses edit_file, 120s command timeout override, beta headers
- **Gemini profile** — Includes read_many_files, list_dir, safety settings via providerOptions
- **Tool registry** — register/unregister/get/definitions/names with latest-wins override (`src/agent-loop/tool-registry.ts`)

### Coding Agent Loop — Tool Execution Environment (Section 4)

- **ExecutionEnvironment interface** — File ops (readFile, writeFile, fileExists, deleteFile, renameFile, resolvePath), exec (command, options->ExecResult), search (grep, glob), lifecycle (initialize, cleanup), metadata (workspaceRoot, cwd, platform, os_version) (`src/agent-loop/execution-environment.ts`)
- **LocalExecutionEnvironment** — Process group spawning (detached), shell execution, SIGTERM->2s->SIGKILL, env var filtering (drops *_API_KEY, *_SECRET, *_TOKEN, *_PASSWORD, *_CREDENTIAL; keeps PATH, HOME, USER, SHELL, LANG, TERM)
- **Scoped environments** — scoped() method for subdirectory scoping

### Coding Agent Loop — Tool Output and Context Management (Section 5)

- **Truncation** — Head/tail split with explicit marker: "WARNING: Tool output was truncated..." (`src/agent-loop/truncation.ts`)
- **Default char limits** — read_file: 50K, shell: 30K, grep: 20K, glob: 20K, edit_file: 10K, apply_patch: 10K, write_file: 1K, spawn_agent: 20K (`src/agent-loop/types.ts`)
- **Line limits** — shell: 256, grep: 200, glob: 500 (`src/agent-loop/truncation.ts`)
- **Truncation order** — Character-based first, then line-based
- **Command timeouts** — default 10s, max 10min, SIGTERM->2s->SIGKILL with timeout message
- **Context window awareness** — 1 token ~ 4 chars heuristic, 80% threshold warning event (`src/agent-loop/session.ts`)

### Coding Agent Loop — System Prompts (Section 6)

- **Layered construction** — Layer 1: provider base + Layer 2: environment context + Layer 3: tool descriptions + Layer 4: project instructions (`src/agent-loop/session.ts`)
- **Environment context** — Working dir, git repo/branch, platform, OS version, date, model, knowledge cutoff (`src/agent-loop/execution-environment.ts` buildEnvironmentContext)
- **Git context** — Branch, changed file count, last 5 commits
- **Project instruction discovery** — Walks git root to CWD; recognizes AGENTS.md (universal), CLAUDE.md (anthropic), GEMINI.md (gemini), .codex/instructions.md (openai); 32KB budget with truncation (`src/agent-loop/project-instructions.ts`)

### Coding Agent Loop — Subagents (Section 7)

- **spawn_agent tool** — task, working_dir, model, max_turns (`src/agent-loop/tools/spawn-agent.ts`)
- **send_input tool** — agent_id, message (`src/agent-loop/tools/send-input.ts`)
- **wait tool** — agent_ids (single or array) (`src/agent-loop/tools/wait.ts`)
- **close_agent tool** — agent_id (`src/agent-loop/tools/close-agent.ts`)
- **Shared execution env** — Via env.scoped() for child sessions
- **Depth limiting** — max_subagent_depth=1 default, enforced (`src/agent-loop/subagent-manager.ts`)
- **Subagent lifecycle events** — Defined in events.ts
- **Timeout support** — Subagent timeout enforcement (`src/agent-loop/subagent-manager.ts`)

### Unified LLM Spec — Architecture (Section 2)

- **Four-layer architecture** — L1: ProviderAdapter interface (`src/llm/adapters/types.ts`), L2: Utilities (`src/llm/streaming.ts`, `src/llm/retry.ts`, `src/llm/timeouts.ts`), L3: UnifiedClient (`src/llm/client.ts`), L4: generate/stream/generateObject/streamObject
- **Client.from_env()** — Reads ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENAI_COMPATIBLE_BASE_URL, GEMINI_API_KEY/GOOGLE_API_KEY (`src/llm/client.ts`)
- **Programmatic setup** — `new UnifiedClient(providers)` constructor
- **Provider resolution** — Explicit provider field -> default_provider -> ConfigurationError (`src/llm/client.ts` resolveProvider)
- **Default provider priority** — anthropic, openai, openai_compatible, gemini, simulation
- **Model string convention** — Native provider IDs pass through, no mapping tables
- **Middleware/interceptor pattern** — Middleware interface with generate/stream hooks, onion-order composition (`src/llm/middleware.ts`)
- **Module-level default client** — setDefaultClient(), getDefaultClient(), clearDefaultClient() with lazy initialization (`src/llm/client.ts`)
- **Model catalog** — Anthropic (4), OpenAI (10), Gemini (5), OpenAI-compatible (3) models with ModelInfo (id, provider, display_name, context_window, max_output_tokens, supports_tools, supports_vision, supports_reasoning, costs, aliases) (`src/llm/catalog.ts`)

### Unified LLM Spec — Data Model (Section 3)

- **Message** — role, content, name, tool_call_id with convenience constructors (system, user, assistant, tool_result) and text accessor (`src/llm/types.ts`)
- **Roles** — system, user, assistant, tool, developer
- **ContentPart** — Tagged union with 8 kinds: TEXT, IMAGE, AUDIO, DOCUMENT, TOOL_CALL, TOOL_RESULT, THINKING, REDACTED_THINKING
- **ImageData** — base64 + URL via ImageSource type
- **AudioData, DocumentData** — Defined with proper fields
- **ToolCallData** — id, name, arguments, type
- **ToolResultData** — tool_call_id, content, is_error, image_data
- **ThinkingData** — thinking, signature
- **GenerateRequest** — All spec fields (model, messages, tools, tool_choice, max_tokens, temperature, top_p, stop, system, response_format, reasoning_effort, abort_signal, provider_options)
- **GenerateResponse** — message, usage, finish_reason, model, provider, id, raw, warnings, rate_limit
- **FinishReason** — Dual representation {reason, raw} with normalizeFinishReason covering all provider values (end_turn, stop, completed, STOP, max_tokens, tool_use, SAFETY)
- **Usage** — input_tokens, output_tokens, total_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, raw; addUsage() helper
- **StreamEvent types** — stream_start, text_start, content_delta, text_end, tool_call_start/delta/end, thinking_start/delta/end, provider_event, usage, step_finish, stream_end, error (`src/llm/streaming.ts`)
- **ResponseFormat** — text, json, json_schema
- **StopCondition, StepResult, GenerateResult** — All defined with output, steps, total_usage

### Unified LLM Spec — Generation and Streaming (Section 4)

- **Client.complete() / Client.stream()** — generateUnified() and stream() methods (`src/llm/client.ts`)
- **generate() high-level** — Tool execution loop with max_tool_rounds, StopCondition evaluation, returns GenerateResult (`src/llm/client.ts`)
- **stream() high-level** — Module-level stream() with tool loop, returns StreamResult with text_stream, partial_response, response() (`src/llm/client.ts`)
- **StreamResult** — AsyncIterable<StreamEvent> with text_stream getter, partial_response getter, response() promise (`src/llm/client.ts`)
- **Prompt standardization** — normalizePromptRequest() handles prompt vs messages (`src/llm/client.ts`)
- **streamWithToolLoop()** — Streaming with tool loop support
- **StreamAccumulator** — Collects stream events into GenerateResponse (`src/llm/stream-accumulator.ts`)
- **generateObject()** — JSON validation, retries on parse/validation failure (`src/llm/client.ts`)
- **streamObject()** — Incremental JSON parsing (`src/llm/client.ts`)
- **Cancellation** — abort_signal on GenerateRequest passed through to adapters and retry
- **Timeouts** — connect (10s), request (120s), stream_read (30s), per_step_ms (`src/llm/timeouts.ts`)

### Unified LLM Spec — Tool Calling (Section 5)

- **Tool definition** — name, description, input_schema, execute (`src/llm/tools.ts`)
- **ToolChoice** — auto/none/required/named
- **Active vs passive tools** — isActiveTool, isPassiveTool helpers
- **Parallel tool execution** — Promise.all(calls) (`src/llm/client.ts`)
- **Error results** — Failed tools return is_error: true; unknown tools get error result
- **Tool call repair** — (`src/llm/tool-repair.ts`)
- **Tool name validation** — validateToolName(), assertValidToolDefinitions()
- **ToolChoice translation** — Per-provider: OpenAI, Anthropic (none=omit tools), Gemini
- **UnsupportedToolChoiceError** — Checked and raised when adapter doesn't support mode
- **Tool context injection** — messages, abort_signal, tool_call_id via ToolContext
- **Gemini synthetic tool call IDs** — `call_${toolCallCounter++}`

### Unified LLM Spec — Error Handling and Retry (Section 6)

- **Error hierarchy** — LLMError base with AuthenticationError(401), AccessDeniedError(403), NotFoundError(404), InvalidRequestError(400), RateLimitError(429), ServerError(500+), ContextLengthError(413), QuotaExceededError, ContentFilterError, StreamError, AbortError, NetworkError, RequestTimeoutError(408), ConfigurationError, StructuredOutputError, InvalidToolCallError, UnsupportedToolChoiceError, OverloadedError(503) (`src/llm/errors.ts`)
- **Retryable flags** — Correct: false for auth/denied/notfound/invalid/timeout/config; true for ratelimit/server/network/stream (with pre-output guard for stream retries)
- **ProviderError fields** — provider, status_code, error_code, raw, retry_after_ms
- **Retry-After parsing** — parseRetryAfterMs() (`src/llm/errors.ts`)
- **RetryConfig** — max_retries=2, base_delay_ms=1000, max_delay_ms=60000, jitter=true, on_retry callback (`src/llm/retry.ts`)
- **Exponential backoff with jitter** — computeDelay() (`src/llm/retry.ts`)
- **Retry-After overrides** — Uses Math.max(retryAfterMs, computed); validates against max_delay
- **max_retries=0 disables retries**
- **Streaming no retry after partial** — Aborts retry if content already yielded
- **Retry middleware auto-registered** — from_env() adds createRetryMiddleware()

### Unified LLM Spec — Provider Adapters (Section 7)

- **OpenAI adapter** — Responses API (`/v1/responses`), developer role, reasoning tokens, cache tokens, streaming with response.created/output_text.delta/completed (`src/llm/adapters/openai.ts`)
- **Anthropic adapter** — Messages API (`/v1/messages`), system message extraction, strict alternation (mergeConsecutiveSameRoleMessages), thinking config, prompt caching (cache_control ephemeral on system/tools/last user), beta headers (interleaved-thinking, prompt-caching, custom via provider_options), streaming with message_start/content_block_start/delta/stop/message_delta/stop, content/safety filtering mapped to ContentFilterError (`src/llm/adapters/anthropic.ts`)
- **Gemini adapter** — Native API (generateContent), systemInstruction, thinkingConfig, safety settings, RECITATION/SAFETY->content_filter, streaming with SSE chunks (`src/llm/adapters/gemini.ts`)
- **OpenAI-compatible adapter** — Chat Completions API (`/v1/chat/completions`) (`src/llm/adapters/openai-compatible.ts`)
- **reasoning_effort** — All adapters: OpenAI reasoning.effort, Anthropic thinking budget, Gemini thinkingBudget
- **close()** — All adapters implement close()
- **Error translation** — HTTP status->error type mapping with Retry-After parsing in all adapters
- **Rate limit headers** — parseRateLimitHeaders() used in all adapters

---

## GAPS

### Closed in Sprint 035

- **GAP-A1 closed** — `NodeOutcome.notes` added and engine synthesizes fallback notes when handlers omit them (`src/engine/types.ts`, `src/engine/engine.ts`).
- **GAP-A2 closed** — Canonical per-node `status.json` now persists outcome, preferred_label, suggested_next_ids, context_updates, notes, node_id, and timing fields; handler-local conflicting status writes moved to `agent-status.json` (`src/engine/engine.ts`, `src/handlers/codergen.ts`, `src/agent-loop/transcript.ts`).
- **GAP-A3 closed** — Unqualified keys now resolve through context fallback with reserved-root precedence (`src/engine/conditions.ts`).
- **GAP-A5 closed** — CONFIRMATION prompts are handled deterministically in auto-approve and wait.human (`src/interviewer/auto-approve.ts`, `src/handlers/wait-human.ts`).
- **GAP-C1 closed** — `max_turns` is enforced across session lifetime, with single `agent_turn_limit_reached` emission and subsequent input rejection (`src/agent-loop/session.ts`).
- **GAP-C4 closed** — `agent_session_completed` is emitted from `buildResult()` with `{status, turn_count, tool_call_count, duration_ms}` (`src/agent-loop/session.ts`).
- **GAP-C5 closed** — `agent_tool_call_completed` always includes `full_content` for both normal tools and subagent tools (`src/agent-loop/session.ts`, `src/agent-loop/tool-registry.ts`, `src/engine/events.ts`).
- **GAP-C6 closed** — ContextLengthError emits warning events, fails the active work item, and leaves the session recoverable (`src/agent-loop/session.ts`).
- **GAP-C7 closed** — Anthropic beta headers now auto-injected: `interleaved-thinking-2025-05-14` when reasoning_effort set, `prompt-caching-2024-07-31` when caching enabled, plus custom betas via `provider_options.anthropic.betas` (`src/llm/adapters/anthropic.ts` buildBetaHeaders).
- **GAP-L1 closed** — `StreamError` is retryable and still protected by the pre-output retry guard (`src/llm/errors.ts`, `src/llm/retry.ts`).
- **GAP-L2 closed** — Anthropic content/safety filtered responses now raise `ContentFilterError` (`src/llm/adapters/anthropic.ts`).
- **GAP-L4 closed** — Module-level `stream()` with tool loop now exists, returns `StreamResult` with `text_stream`, `partial_response`, and `response()` (`src/llm/client.ts`).
- **GAP-L6 closed** — Base provider errors now carry optional `retry_after_ms` and retry middleware consults it generically (`src/llm/errors.ts`, `src/llm/retry.ts`, `src/llm/adapters/*.ts`).

### Deliberate Deferrals

#### Attractor Spec

**GAP-A4: Checkpoint file location differs from spec (Section 5.6)**
Nectar uses cocoon checkpoints at `.nectar/cocoons/{run_id}/checkpoint.json` with equivalent persisted data. The spec prescribes `{logs_root}/checkpoint.json`. Path migration requires compatibility planning and is deferred.

#### Coding Agent Loop

**GAP-C2: Native prompt/tool 1:1 mirroring (Section 3.1)**
Exact upstream prompts/tool schemas for all provider reference agents are proprietary and/or license-constrained. Current implementation keeps provider-specific prompts but not byte-for-byte mirrors.

**GAP-C3: Gemini `web_search` / `web_fetch` tools (Section 3.6)**
Spec language is optional ("optionally include"). Deferred pending product decision on external search backend and safety controls.

#### Unified LLM Spec

**GAP-L3: StreamEvent naming divergence (Section 3.14)**
Current event names are stable across Nectar consumers. Renames would be breaking; additive aliases can be introduced later.

**GAP-L5: No `detail` on image inputs (Section 3.5)**
Interface-shape enhancement with no current runtime blocker. Deferred.

**GAP-L7: No top-level `metadata` on `GenerateRequest` (Section 3.6)**
Provider-specific metadata is currently passed through `provider_options` (e.g., `AnthropicOptions.metadata`, `OpenAIOptions.metadata`); a dedicated top-level `metadata` field remains deferred.

**GAP-L8: Circuit breaker middleware not provided (Section 2.3)**
Middleware architecture supports it, but no built-in circuit breaker exists yet. Deferred as non-blocking.
