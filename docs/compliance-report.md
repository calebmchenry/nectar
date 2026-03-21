NO GAPS REMAINING

# Nectar Compliance Report

**Generated:** 2026-03-21
**Specs reviewed:** attractor-spec.md, coding-agent-loop-spec.md, unified-llm-spec.md
**Source directory:** src/

---

## IMPLEMENTED

### Attractor Spec — DOT Parsing (Section 2)

- **DOT subset parser** — `src/garden/parse.ts` parses `digraph` with directed edges, node/edge attributes, comments (`//` and `/* */`), quoted/unquoted values, subgraphs, node/edge default blocks, chained edges, multi-line attribute blocks
- **Graph-level attributes** — goal, label, model_stylesheet, default_max_retries, retry_target, fallback_retry_target, default_fidelity, stack.child_dotfile, stack.child_workdir, tool_hooks.pre/post all parsed in `parse.ts`
- **Legacy alias** — `default_max_retry` accepted as alias for `default_max_retries` (`parse.ts:298`)
- **Node attributes** — label, shape, type, prompt, max_retries, goal_gate, retry_target, fallback_retry_target, fidelity, thread_id, class, timeout, llm_model, llm_provider, reasoning_effort, auto_status, allow_partial all defined in `src/garden/types.ts` GardenNode
- **Edge attributes** — label, condition, weight, fidelity, thread_id, loop_restart all defined in GardenEdge
- **Shape-to-handler mapping** — All 9 shapes mapped: Mdiamond→start, Msquare→exit, box→codergen, hexagon→wait.human, diamond→conditional, component→parallel, tripleoctagon→parallel.fan_in, parallelogram→tool, house→stack.manager_loop (`src/garden/types.ts` normalizeShape/normalizeNodeKind)
- **Subgraph scoping** — Class derivation from subgraph labels implemented (label="Loop A" → class "loop-a"); scope stacks for defaults in `parse.ts`
- **Value types** — String, Integer, Boolean, Duration (parseTimeoutMs supports s, m, h, d, ms) all supported
- **Chained edges** — `A -> B -> C` expands to two edges with shared attributes (`parse.ts:238-267`)
- **Graph hashing** — `hashDotSource()` for versioning/change detection
- **Graph serialization** — `src/garden/serialize.ts` serializes graph back to DOT format with sorted nodes/edges/attributes, subgraph rendering, proper DOT escaping

### Attractor Spec — Validation and Linting (Section 7)

- **start_node** (ERROR) — Exactly one start node required (`validate.ts:40`)
- **terminal_node** (ERROR) — At least one exit node required (`validate.ts:52`)
- **start_no_incoming** (ERROR) — Start must have no incoming edges (`validate.ts:64`)
- **exit_no_outgoing** (ERROR) — Exit must have no outgoing edges (`validate.ts:78`)
- **reachability** (ERROR) — All nodes reachable from start via BFS (`validate.ts` findUnreachableNodes)
- **edge_target_exists** (ERROR) — Validated during parsing
- **condition_syntax** (ERROR) — Edge conditions validated via `validateConditionExpression()` (`validate.ts:419`)
- **stylesheet_syntax** (ERROR) — model_stylesheet validated (`validate.ts:16`)
- **type_known** (WARNING) — Node types checked against known set (`validate.ts:109`)
- **fidelity_valid** (WARNING) — Fidelity modes checked against enum (`validate.ts:120`)
- **retry_target_exists** (WARNING) — retry_target/fallback_retry_target reference existing nodes (`validate.ts:138`)
- **goal_gate_has_retry** (WARNING) — Goal gate nodes warned if no retry target (`validate.ts:158`)
- **prompt_on_llm_nodes** (WARNING) — Codergen nodes warned if missing prompt (`validate.ts:272`)
- **Diagnostic model** — rule, severity, message, node_id, edge, fix fields all present (`src/garden/types.ts:15-19`)
- **Severity levels** — ERROR, WARNING, INFO all defined (`src/garden/types.ts:3`)
- **validate_or_raise** semantics — `loadAndValidate()` in `cli/commands/shared.ts` checks for errors
- **Cycle detection** — Tarjan's SCC and findCyclesWithoutExitPath in validate.ts
- **Parallel topology** — Parallel nodes need 2+ edges; fan-in must have parallel ancestor
- **join_policy validation** — Validated against allowed values (`validate.ts:228`)
- **max_parallel validation** — Validated (`validate.ts:242`)
- **reasoning_effort validation** — Validated against low/medium/high (`validate.ts:257`)
- **llm_provider validation** — Validated against known providers (`validate.ts:271`)
- **Manager node validation** — stack.child_dotfile, stop_condition, etc. (`validate.ts:297`)
- **Tool hook validation** — Pre/post hook expressions validated (`validate.ts:395`)

### Attractor Spec — Execution Engine (Section 3)

- **Run lifecycle** — PARSE → TRANSFORM → VALIDATE → INITIALIZE → EXECUTE → FINALIZE in `src/garden/pipeline.ts` and `src/engine/engine.ts`
- **Core execution loop** — Engine resolves start node, executes handlers, selects edges, advances, repeats (`engine.ts`)
- **Edge selection 5-step algorithm** — Condition matching → preferred label → suggested next IDs → highest weight → lexical tiebreak (`src/engine/edge-selector.ts`)
- **Preferred label normalization** — Strips accelerator prefixes [K], K), K -; case-insensitive comparison (`edge-selector.ts`)
- **Goal gate enforcement** — Visited goal gates checked before exit; jumps to retry_target if unsatisfied; graph-level fallback retry targets supported (`engine.ts`)
- **Retry logic** — Per-node retry with exponential and linear backoff, jitter range [0.5, 1.5) matching spec (`src/engine/retry.ts`)
- **Named retry presets** — `none`, `standard`, `aggressive`, `linear`, `patient` all implemented with lookup by name (`src/engine/retry.ts` RETRY_PRESETS)
- **should_retry predicate** — Error category classification: non-retryable for http_400, http_401, http_403; retryable for network, http_429, http_5xx (`src/engine/retry.ts:120-150`)
- **Failure routing** — fail edge → retry_target → fallback_retry_target → graph-level → terminate (`engine.ts`)
- **loop_restart edge** — Supported; RunRestartedEvent emitted; creates fresh run with new log directory (`engine.ts`)
- **auto_status** — Engine synthesizes SUCCESS when handler writes no status and auto_status=true (`engine.ts`)
- **allow_partial** — Node attribute parsed and used in retry exhaustion logic to convert to partial_success (`engine.ts`)
- **Checkpoint save/resume** — Checkpoint saved after each node; resume restores context, completed_nodes, retry counters (`src/checkpoint/cocoon.ts`, `src/checkpoint/run-store.ts`)
- **Run directory structure** — `{logs_root}/checkpoint.json`, `manifest.json`, `{node_id}/status.json`, `{node_id}/prompt.md`, `{node_id}/response.md`, `artifacts/` all created
- **Status file contract** — Per-node `status.json` written with outcome, preferred_label, suggested_next_ids, context_updates, notes (`engine.ts:1089`)
- **Signal handlers** — Graceful shutdown on SIGINT/SIGTERM
- **Single-threaded traversal** — One node at a time in top-level graph; parallelism only within parallel/fan-in handlers
- **Isolated branch contexts** — Each parallel branch receives cloned context; branch changes don't merge to parent
- **Context keys set** — `outcome`, `preferred_label`, `current_node`, `graph.goal`, `internal.retry_count.<node_id>` all set at appropriate points

### Attractor Spec — Node Handlers (Section 4)

- **Start handler** — No-op, returns SUCCESS (`src/handlers/start.ts`)
- **Exit handler** — No-op, returns SUCCESS (`src/handlers/exit.ts`)
- **Codergen handler** — Builds prompt with $goal expansion, calls LLM backend (via AgentSession or UnifiedClient), writes prompt.md/response.md/status.json, returns context_updates with `last_stage` and `last_response` (`src/handlers/codergen.ts:231-232`)
- **Wait.human handler** — Derives choices from outgoing edge labels, parses accelerator keys, presents via Interviewer, returns preferred_label/suggested_next_ids, sets `human.gate.selected` and `human.gate.label` context keys (`src/handlers/wait-human.ts:158-159`)
- **Conditional handler** — No-op returning SUCCESS; routing via engine edge selection (`src/handlers/conditional.ts`)
- **Parallel handler** — Fans out branches concurrently with bounded parallelism (maxParallel default 4), isolated context clones, supports wait_all and first_success join policies, stores results at `parallel.results` key (`src/handlers/parallel.ts`)
- **Fan-in handler** — Heuristic ranking path (success > partial_success > retry > failure > skipped) plus LLM-prompted selection path when `node.prompt` is set; records best branch in `parallel.fan_in.best_id`, `parallel.fan_in.best_outcome`, `parallel.fan_in.rationale` (`src/handlers/fan-in.ts`)
- **Tool handler** — Executes shell script from node `tool_command` attribute with timeout, passes NECTAR_* env vars, writes `tool.output` context key (`src/handlers/tool.ts`)
- **Manager loop handler** — Polls child pipeline, supports observe/steer/wait actions, evaluates stop conditions, steering cooldown, max_cycles limit, mirrors child state into parent context (`src/handlers/manager-loop.ts`)
- **Handler registry** — Resolution by explicit type → shape mapping → default; custom registration supported (`src/handlers/registry.ts`)

### Attractor Spec — State and Context (Section 5)

- **Context** — Key-value store with get/set/clone/snapshot/restore methods (`src/engine/context.ts`)
- **Outcome model** — status, preferred_label, suggested_next, context_updates, notes, error_message, error_category (`src/engine/types.ts`)
- **StageStatus values** — success, failure, partial_success, retry, skipped
- **Checkpoint** — Serializable with timestamp, current_node, completed_nodes, node_retries, context_values (`src/checkpoint/types.ts`)
- **Resume** — Loads checkpoint, restores state, follows restart chain, validates graph hash (`cli/commands/resume.ts`)
- **Fidelity modes** — full, truncate, compact, summary:low/medium/high all supported with token budgets (`src/engine/fidelity.ts`)
- **Fidelity resolution precedence** — edge → node → graph default → compact (`fidelity.ts`)
- **Resume fidelity degradation** — Resuming from full fidelity degrades to summary:high for first node (`engine.ts`)
- **Thread resolution** — node thread_id → edge thread_id → graph default → subgraph class → previous node ID → None (`src/engine/thread-resolver.ts`)
- **Session registry** — FIFO-locked sessions per thread key with provider/model consistency (`src/engine/session-registry.ts`)
- **Preamble generation** — Mode-specific context summaries for LLM nodes (full/truncate/compact/summary:*) with token budgets (`src/engine/preamble.ts`)
- **Artifact store** — Named typed storage with file-backing threshold (100KB), store/retrieve/has/list/remove/clear (`src/artifacts/store.ts`, `src/artifacts/types.ts`)
- **Step result state** — Per-node step results with output preview and condition scope conversion (`src/engine/step-state.ts`)

### Attractor Spec — Human-in-the-Loop (Section 6)

- **Interviewer interface** — `ask()`, `ask_multiple()`, `inform()` methods (`src/interviewer/types.ts:25-29`)
- **Question model** — id, type, text, choices, default_choice, timeout_ms, node_id, run_id (`src/interviewer/types.ts:9-18`)
- **QuestionType enum** — YES_NO, MULTIPLE_CHOICE, FREEFORM, CONFIRMATION (`src/interviewer/types.ts:1`)
- **Answer model** — canonical shape includes `answer_value` (YES/NO/SKIPPED/TIMEOUT), `selected_option`, and `text`, with `selected_label`/`source` compatibility fields (`src/interviewer/types.ts`)
- **AutoApproveInterviewer** — Returns default_choice or first option (`src/interviewer/auto-approve.ts`)
- **ConsoleInterviewer** — stdin-based with timeout and accelerator key matching (`src/interviewer/console.ts`)
- **CallbackInterviewer** — Delegate to callback with timeout support (`src/interviewer/callback.ts`)
- **QueueInterviewer** — Pre-loaded answer queue; exhausted queue normalizes to `AnswerValue.SKIPPED` (`src/interviewer/queue.ts`)
- **RecordingInterviewer** — Wraps inner interviewer, records question-answer pairs (`src/interviewer/recording.ts`)
- **Accelerator key parsing** — [X], X), X - patterns all supported (`src/interviewer/types.ts:46-66`)
- **Timeout handling** — default_choice on timeout in console and auto-approve interviewers

### Attractor Spec — Model Stylesheet (Section 8)

- **Stylesheet grammar** — Selectors: *, shape, .class, #id (`src/garden/stylesheet.ts:143-165`)
- **Specificity order** — universal=0, shape=1, class=2, id=3 (`src/garden/stylesheet.ts:33-38`)
- **Recognized properties** — llm_model, llm_provider, reasoning_effort (`src/garden/stylesheet.ts:40`)
- **Application precedence** — explicit node attr > stylesheet > graph default (`src/transforms/stylesheet-apply.ts`)
- **Resolver** — Sort by specificity ASC, source order ASC, later/higher wins (`src/garden/stylesheet.ts:357-384`)

### Attractor Spec — Transforms (Section 9)

- **Transform interface** — name, apply(graph, context) → TransformResult (`src/transforms/types.ts:17-20`)
- **TransformRegistry** — register, unregister, getAll, clear (`src/transforms/registry.ts`)
- **PipelinePreparer** — Built-ins first (compose-imports, goal-expansion, stylesheet-apply), then custom (`src/garden/preparer.ts`)
- **Goal expansion** — $goal replacement in prompts (`src/transforms/goal-expansion.ts`)
- **Stylesheet apply** — Applies stylesheet declarations to nodes (`src/transforms/stylesheet-apply.ts`)
- **Compose imports** — Pipeline composition via subgraph imports (`src/transforms/compose-imports.ts`)
- **Custom transform registration** — Supported via preparer options

### Attractor Spec — Condition Expression Language (Section 10)

- **Grammar** — Clauses with AND/OR, =, != operators (`src/engine/condition-parser.ts`)
- **Variable resolution** — `outcome`, `preferred_label`, `context.*`, `steps.*`, `artifacts.*` (`src/engine/conditions.ts`)
- **Empty condition** — Returns true (`src/engine/conditions.ts:48-49`)
- **Extended operators** — CONTAINS, STARTS_WITH, ENDS_WITH, <, >, <=, >=, NOT, EXISTS, || (`src/engine/condition-parser.ts`, `src/engine/conditions.ts`)
- **Missing key behavior** — Compare as empty string (`src/engine/conditions.ts:148`)

### Attractor Spec — Events (Section 9.6)

- **Pipeline lifecycle** — `run_started`, `run_completed`, `pipeline_failed`, `run_interrupted`, `run_error` (`src/engine/events.ts`)
- **Stage lifecycle** — `node_started`, `node_completed`, `stage_failed`, `node_retrying` (`src/engine/events.ts`)
- **Parallel events** — `parallel_started`, `parallel_branch_started`, `parallel_branch_completed`, `parallel_completed` (`src/engine/events.ts`)
- **Human interaction events** — `interview_started`, `interview_completed`, `interview_timeout`, `human_question`, `human_answer` (`src/engine/events.ts`)
- **Checkpoint events** — `checkpoint_saved` (`src/engine/events.ts`)
- **Goal gate events** — `goal_gate_activated` (`src/engine/events.ts`)
- **Loop restart events** — `loop_restart` (`src/engine/events.ts`)
- **Tool hook events** — `tool_hook_blocked` (`src/engine/events.ts`)
- **Event listener pattern** — Supported via engine constructor

### Attractor Spec — Tool Call Hooks (Section 9.7)

- **Pre/post hook execution** — Around tool calls in agent sessions (`src/agent-loop/tool-hooks.ts`)
- **Pre-hook gating** — Exit code 0 = proceed, non-zero = skip (`tool-hooks.ts:84-88`)
- **Hook resolution** — Node-level overrides graph-level (`tool-hooks.ts:124-134`)

### Attractor Spec — HTTP Server (Section 9.5)

- **POST /pipelines** — Create and start a pipeline run (`src/server/routes/pipelines.ts`)
- **GET /pipelines/:id** — Get pipeline status (`src/server/routes/pipelines.ts`)
- **GET /pipelines/:id/events** — SSE event stream (`src/server/routes/pipelines.ts`)
- **POST /pipelines/:id/cancel** — Cancel running pipeline (`src/server/routes/pipelines.ts:119`)
- **GET /pipelines/:id/graph** — Graph visualization (`src/server/routes/pipelines.ts`)
- **GET /pipelines/:id/questions** — Pending human questions (`src/server/routes/pipelines.ts`)
- **POST /pipelines/:id/questions/:qid/answer** — Submit answer (`src/server/routes/pipelines.ts`)
- **GET /pipelines/:id/checkpoint** — Current checkpoint (`src/server/routes/pipelines.ts:172`)
- **GET /pipelines/:id/context** — Current context (`src/server/routes/pipelines.ts:180`)
- **POST /pipelines/:id/resume** — Resume from checkpoint (`src/server/routes/pipelines.ts`)

---

### Coding Agent Loop Spec — Session Architecture (Section 1-2)

- **Programmable-first library** — `AgentSession` class is standalone, instantiated with `UnifiedClient`, `ToolRegistry`, `ProviderProfile`, `ExecutionEnvironment`, and `SessionConfig` (`src/agent-loop/session.ts`)
- **Session record fields** — sessionId (UUID), profile, env, config, onEvent, state, conversation, pendingSteers, pendingInputs, subagentManager
- **SessionConfig** — max_turns (12), max_tool_rounds_per_input (10), default_command_timeout_ms (10000), max_command_timeout_ms (600000), reasoning_effort, tool_output_limits, tool_line_limits, enable_loop_detection (true), loop_detection_window (10) (`src/agent-loop/types.ts`)
- **Session lifecycle states** — IDLE, PROCESSING, AWAITING_INPUT, CLOSED (`src/agent-loop/types.ts:3`)
- **Core agentic loop** — `processWorkItem()` implements: check limits → build LLM request → call client.stream() → record assistant turn → check tool calls → execute tools → drain steering → loop detection (`src/agent-loop/session.ts`)
- **Steering** — `steer()` queues messages without state restriction; drained before each LLM call as user-role messages (`session.ts:209-211, 460-462`)
- **Follow-up** — `followUp()` queues work items processed after current input completes
- **Reasoning effort** — Passed to client.stream() via overrides; changeable mid-session
- **Stop conditions** — Natural completion (no tool calls), round limit, turn limit, abort signal all implemented
- **Low-level streaming** — Session directly calls `client.stream()` and processes events manually
- **Authentication error handling** — Auth/access errors transition session to CLOSED and reject queued follow-ups (`session.ts:577-584`)

### Coding Agent Loop Spec — Events (Section 2.9)

- **agent_session_started** — Emitted by `AgentSession` exactly once per session; codergen bridges session events (`src/agent-loop/session.ts`, `src/handlers/codergen.ts`)
- **agent_user_input** — Emitted on submit with source (submit/follow_up) (`events.ts:15-20`)
- **agent_turn_started** — Emitted on each LLM call
- **agent_steering_injected** — Emitted when steering message added (`events.ts:27-31`)
- **agent_assistant_text_start** — Emitted when model starts text generation (`events.ts:33-36`)
- **agent_text_delta** — Streaming text deltas (`events.ts:38-41`)
- **agent_assistant_text_end** — Emitted when text generation completes (`events.ts:43-47`)
- **agent_tool_call_started** — Before tool execution with call_id and tool_name (`events.ts:49-54`)
- **agent_tool_call_output_delta** — Streaming tool output (`events.ts:56-63`)
- **agent_tool_call_completed** — With `full_content` (untruncated) and `truncated` flag (`events.ts:65-75`)
- **agent_loop_detected** — On loop detection (`events.ts:77-81`)
- **agent_processing_ended** — When processing cycle finishes (`events.ts:83-88`)
- **agent_turn_limit_reached** — When turn limit hit (`events.ts:90-94`)
- **agent_warning** — For context_window_pressure and tool_output_truncated (`events.ts:96-103`)
- **agent_error** — Error events (`events.ts:105-109`)
- **agent_session_completed** — End of work item processing (`events.ts:111-119`)
- **agent_session_ended** — On session close/abort (`events.ts:121-126`)
- **context_window_warning** — At 80% threshold (`events.ts:128-134`)
- **Subagent events** — subagent_spawned, subagent_completed, subagent_message (`events.ts:136-165`)

### Coding Agent Loop Spec — Loop Detection (Section 2.10)

- **LoopDetector** — SHA256 fingerprinting of tool name + args, pattern detection for repeating sequences of length 1-3 within configurable window, steering injection on detection, termination after 3 detections (`src/agent-loop/loop-detection.ts`)

### Coding Agent Loop Spec — Provider Profiles (Section 3)

- **AnthropicProfile** — edit_file native, 120s timeout, read_file/write_file/edit_file/shell/grep/glob tools (`provider-profiles.ts`)
- **OpenAIProfile** — apply_patch instead of edit_file, read_file/write_file/apply_patch/shell/grep/glob (`provider-profiles.ts`)
- **GeminiProfile** — Extended with read_many_files/list_dir, sequential tool execution (`provider-profiles.ts`)
- **ProviderProfile interface** — name, systemPrompt(), defaultModel, parallel_tool_execution, max_parallel_tools, visibleTools, command_timeout_ms, `providerOptions()` (`provider-profiles.ts`)

### Coding Agent Loop Spec — Tool Definitions (Section 3.3-3.6)

- **read_file** — path (required), offset, limit; line-numbered output; binary detection (`src/agent-loop/tools/read-file.ts`)
- **write_file** — path, content; creates parent dirs; returns bytes written (`src/agent-loop/tools/write-file.ts`)
- **edit_file** — path, old_string, new_string, replace_all; exact match with fuzzy fallback; multiple-match error (`src/agent-loop/tools/edit-file.ts`)
- **shell** — command, timeout_ms, description; returns stdout/stderr/exit code; includes spec-matching timeout guidance message (`src/agent-loop/tools/shell.ts:41`)
- **grep** — pattern, path, include (glob filter), case_insensitive, max_results (`src/agent-loop/tools/grep.ts`)
- **glob** — pattern, path; gitignore-aware (`src/agent-loop/tools/glob.ts`)
- **apply_patch (OpenAI)** — v4a format parser/applier with Add/Update/Delete/Move (`src/agent-loop/tools/apply-patch.ts`, `src/agent-loop/patch.ts`)
- **read_many_files (Gemini)** — Batch reading up to 20 files (`src/agent-loop/tools/read-many-files.ts`)
- **list_dir (Gemini)** — Directory listing with configurable depth (`src/agent-loop/tools/list-dir.ts`)
- **spawn_agent** — Creates child session with task, working_dir, model override, max_tool_rounds, timeout_ms; result uses standard truncateToolOutput with 20k limit (`src/agent-loop/tools/spawn-agent.ts`, `src/agent-loop/subagent-manager.ts`)

### Coding Agent Loop Spec — Tool Registry (Section 3.8)

- **ToolRegistry** — register(), unregister(), definitions(), definitionsForProfile(), execute() with AJV validation (`src/agent-loop/tool-registry.ts`)
- **Unknown tool handling** — Returns error result
- **Validation failure** — Returns error result with details
- **Custom registration** — Latest registration wins (Map.set semantics)
- **Tool safety classification** — TOOL_SAFETY map classifies tools as read_only or mutating (`src/agent-loop/types.ts`)

### Coding Agent Loop Spec — Execution Environment (Section 4)

- **ExecutionEnvironment interface** — readFile, writeFile, fileExists, exec, glob, grep, list_directory, initialize(), cleanup(), platform(), os_version(), scoped(), workspaceRoot, cwd, resolvePath, deleteFile, renameFile (`src/agent-loop/execution-environment.ts`)
- **ExecResult** — stdout, stderr, exitCode, timed_out, duration_ms fields all present (`execution-environment.ts`)
- **LocalExecutionEnvironment** — All file ops, command execution with timeout, SIGTERM + 2s + SIGKILL via execa forceKillAfterDelay, abort signal support (`execution-environment.ts`)
- **Environment variable filtering** — Drops `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_CREDENTIAL`; keeps PATH, HOME, USER, SHELL, LANG, TERM, TMPDIR, LC_*, NECTAR_*, and language-specific paths (GOPATH, CARGO_HOME, RUSTUP_HOME, NVM_DIR, VOLTA_HOME, PYENV_ROOT, VIRTUAL_ENV, PNPM_HOME, ASDF_DIR) (`execution-environment.ts:32-64`)
- **Scoped environments** — `scoped(subdir)` returns new env with different cwd, same workspaceRoot
- **Command timeout defaults** — SessionConfig default 10s (`types.ts:22`); Anthropic profile overrides to 120s per Claude Code convention (`provider-profiles.ts:58`); max 600s (`types.ts:24`)

### Coding Agent Loop Spec — Truncation (Section 5)

- **Character-based truncation** — 50/50 head/tail split with `[WARNING: Tool output was truncated. N characters were removed from the middle...]` marker (`src/agent-loop/truncation.ts:15-39`)
- **Two-pass truncation** — Character truncation first, then line cap second (`truncation.ts:46-77`)
- **Line truncation head/tail split** — Line cap uses head/tail split with `[... N lines omitted ...]` marker (`truncation.ts:66-71`)
- **Default char limits** — read_file: 50000, read_many_files: 120000, list_dir: 40000, shell: 30000, grep: 20000, glob: 20000, write_file: 1000, edit_file: 10000, apply_patch: 10000, spawn_agent: 20000 (`types.ts`)
- **Default line limits** — shell: 256, grep: 200, glob: 500, read_many_files: 1000, list_dir: 800 (`truncation.ts`)
- **Overridable limits** — Both tool_output_limits and tool_line_limits on SessionConfig merge with defaults
- **Command timeouts** — Default 10s, per-call override via timeout_ms, capped by max_command_timeout_ms; Anthropic profile 120s

### Coding Agent Loop Spec — Context Window Awareness (Section 5.5)

- **Token estimation** — chars/4 heuristic
- **Warning threshold** — 80% of context window triggers `context_window_warning` event (`session.ts`)

### Coding Agent Loop Spec — System Prompt (Section 6)

- **Layered system prompt** — Base instructions from profile + environment context block + git snapshot + project instructions
- **Environment context block** — Platform, shell, workspace, date, provider, model, tools, OS version, knowledge cutoff, "Is git repository" flag (`src/agent-loop/environment-context.ts`)
- **Project document discovery** — Discovers AGENTS.md (always) + provider-specific files (CLAUDE.md, GEMINI.md, .codex/instructions.md); 32KB budget; sorted by specificity (`src/agent-loop/project-instructions.ts`)

### Coding Agent Loop Spec — Subagents (Section 7)

- **spawn_agent tool** — Creates child session with task, working_dir, model override, max_tool_rounds, timeout_ms (`src/agent-loop/tools/spawn-agent.ts`)
- **send_input / wait / close_agent** — Full lifecycle management (`src/agent-loop/subagent-manager.ts`)
- **SubagentManager** — Depth limit (default: 1), concurrency limit, child gets own session sharing parent's execution environment (`src/agent-loop/subagent-manager.ts`)
- **Parallel tool execution** — `executeToolsBatch()` when profile.parallel_tool_execution is true (`session.ts`)

### Coding Agent Loop Spec — Tool Hooks

- **Pre/post execution hooks** — Metadata includes run_id, node_id, session_id, tool_call_id (`src/agent-loop/tool-hooks.ts`)

### Coding Agent Loop Spec — Transcript/Logging

- **TranscriptWriter** — Writes prompt, response, status, and per-tool-call artifacts to disk (`src/agent-loop/transcript.ts`)

---

### Unified LLM Spec — Architecture (Section 2)

- **Four-layer architecture** — Layer 1 (ProviderAdapter interface) in `src/llm/adapters/types.ts`, Layer 2 (utilities) in streaming/rate-limit/timeouts/errors, Layer 3 (UnifiedClient) in `src/llm/client.ts`, Layer 4 (high-level functions) generate/stream/generateObject/streamObject
- **Client.from_env()** — Reads ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENAI_COMPATIBLE_BASE_URL, GEMINI_API_KEY/GOOGLE_API_KEY (`client.ts`)
- **Programmatic setup** — Constructor accepts Map of providers (`client.ts`)
- **Provider resolution** — Resolves provider from model or uses defaultProvider; throws on misconfiguration (`client.ts`)
- **Model string convention** — Provider-native strings used directly (claude-opus-4-20250514, gpt-4.1, gemini-2.5-pro)
- **Module-level default client** — `setDefaultClient()`, `getDefaultClient()`, lazy initialization; throws `ConfigurationError` when no real providers configured (`client.ts:585-592`)
- **Native API usage** — OpenAI Responses API (`/v1/responses`), Anthropic Messages API (`/v1/messages`), Gemini native generateContent (`/v1beta/models/*/generateContent`)

### Unified LLM Spec — Middleware (Section 2.3)

- **Middleware/interceptor pattern** — `composeGenerateChain` and `composeStreamChain` with correct onion ordering, supports both generate and stream paths (`src/llm/middleware.ts`)

### Unified LLM Spec — Data Model (Section 3)

- **Role** — 5 roles: system, user, assistant, tool, developer (`types.ts:3`)
- **Role mapping completeness** — Anthropic: DEVELOPER→merged with system; Gemini: DEVELOPER→merged with systemInstruction; OpenAI: DEVELOPER→native developer role
- **ContentPart types** — TEXT, IMAGE, AUDIO, DOCUMENT, TOOL_CALL, TOOL_RESULT, THINKING, REDACTED_THINKING all defined as tagged unions (`types.ts`)
- **Message factory methods** — `Message.system()`, `Message.user()`, `Message.assistant()`, `Message.tool_result()` static constructors (`types.ts`)
- **FinishReason** — Unified `FinishReasonValue` enum ("stop", "length", "tool_calls", "content_filter", "error", "other") with `normalizeFinishReason()` mapping from provider-specific values (`types.ts`)
- **Content data structures** — ImageSource, AudioData, DocumentData, ToolCallContentPart, ToolResultContentPart, ThinkingContentPart, RedactedThinkingContentPart
- **GenerateRequest** — model, messages/prompt (mutually exclusive), provider, tools, tool_choice, `max_tool_rounds` (default 1), max_tokens, temperature, top_p, stop_sequences, reasoning_effort, system, abort_signal, timeout, provider_options, response_format (`types.ts`, `client.ts`)
- **Provider options escape hatch** — AnthropicOptions, OpenAIOptions, OpenAICompatibleOptions, GeminiOptions (`types.ts`)
- **GenerateResponse** — message, usage, stop_reason, model, provider, rate_limit, id, raw, warnings fields; `.text`, `.tool_calls`, `.reasoning` convenience accessors (`types.ts`)
- **Usage** — input_tokens, output_tokens, total_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens with addition utility (`types.ts`, `client.ts`)
- **ResponseFormat** — text, json, json_schema with JsonSchemaDefinition including strict mode (`types.ts`)
- **RateLimitInfo** — requests_remaining, requests_limit, tokens_remaining, tokens_limit, reset_at (`types.ts`)
- **ToolCallData** — id, name, arguments fields; Gemini adapter generates synthetic IDs (`call_N` pattern)
- **Thinking block preservation** — Anthropic thinking blocks round-tripped with signature; redacted thinking blocks passed through

### Unified LLM Spec — Streaming (Section 3.13-3.14)

- **StreamEvent types** — stream_start, text_start, content_delta, text_end, tool_call_start, tool_call_delta, tool_call_end, thinking_start, thinking_delta, thinking_end, usage, step_finish, stream_end (with required full response), error (`src/llm/streaming.ts`)
- **Start/delta/end pattern** — Full lifecycle for text (text_start → content_delta → text_end) and tool calls (tool_call_start → tool_call_delta → tool_call_end) (`streaming.ts`)
- **SSE parsing** — Handles event/data lines, comments, blank line boundaries, multi-line data (`streaming.ts`)

### Unified LLM Spec — Generation API (Section 4)

- **generate()** — Module-level function with tool execution loop and `prompt` string shorthand via `normalizePromptRequest()` (`client.ts`)
- **stream()** — Module-level function returning StreamResult with AsyncIterable<StreamEvent>, built-in tool loop via `streamWithToolLoop()` (`client.ts`)
- **generateObject()** — Structured output with JSON schema validation, validation retries, StructuredOutputError on failure (`client.ts` — `UnifiedClient.generateObject()`)
- **streamObject()** — Streaming structured output with incremental JSON parsing (`client.ts` — `UnifiedClient.streamObject()`)
- **Incremental JSON parsing** — Full implementation (`src/llm/incremental-json.ts`)
- **GenerateResult / StepResult** — `GenerateResult` with `total_usage`, `steps: List<StepResult>`, `output`; `StepResult` with response and usage (`client.ts`)
- **StreamResult wrapper** — `.response()`, `.text_stream`, `.partial_response` accessors (`client.ts`)
- **StreamAccumulator** — Collects stream events into a complete Response with `partial_response` getter and `response()` method (`src/llm/stream-accumulator.ts`)
- **stop_when / StopCondition** — Custom stop condition callback for the tool loop on GenerateRequest (`client.ts`)
- **Cancellation / abort signals** — Supported via abort_signal on GenerateRequest, threaded through all adapters
- **Image file path support** — Reads local files, infers MIME type, base64-encodes, validates size (`client.ts`)

### Unified LLM Spec — Timeouts (Section 4.7)

- **Timeout config** — connect (10s), request (120s), stream_read (30s) defaults matching spec (`src/llm/timeouts.ts`, `types.ts`)

### Unified LLM Spec — Tool Calling (Section 5)

- **ToolDefinition** — name, description, input_schema, optional `execute` handler (`ToolExecuteHandler`); `ActiveToolDefinition` (has execute) vs `PassiveToolDefinition` (no execute) with `isActiveTool()`/`isPassiveTool()` helpers (`src/llm/tools.ts`)
- **ToolContext injection** — Handlers receive `ToolContext` with `messages`, `abort_signal`, `tool_call_id` (`src/llm/tools.ts`)
- **ToolChoice** — auto, none, required, named with correct provider mappings across all adapters (`tools.ts`)
- **Parallel tool execution** — `executeToolsBatch` with concurrent execution, order preservation, bounded parallelism (`tools.ts`)
- **Tool error handling** — Unknown tools return error result, JSON parse errors return error, exceptions return is_error=true (`client.ts`)

### Unified LLM Spec — Error Handling (Section 6)

- **Error taxonomy** — LLMError base with error_code and raw fields, AuthenticationError (401), AccessDeniedError (403), NotFoundError (404), RateLimitError (429), QuotaExceededError, StreamError, OverloadedError (503), ServerError (500-504), InvalidRequestError (400), ContextWindowError, ContentFilterError, NetworkError, TimeoutError, AbortError, ConfigurationError, StructuredOutputError, InvalidToolCallError, UnsupportedToolChoiceError (`src/llm/errors.ts`)
- **Retryability classification** — Correct retryable flags per spec on each error class
- **Retry-After header parsing** — Handles both seconds and HTTP-date formats (`errors.ts`)
- **Error classification by provider** — All three adapters correctly classify 401→AuthenticationError, 403→AccessDeniedError, 404→NotFoundError, 429→RateLimitError, 5xx→ServerError, context window→ContextWindowError

### Unified LLM Spec — Retry Logic (Section 6.6)

- **Exponential backoff with jitter** — `createRetryMiddleware` with max_retries=2, base_delay_ms=1000, max_delay_ms=60000, jitter=true matching spec defaults (`src/llm/retry.ts:15-20`)
- **Retry-After honor** — Retry-After overrides calculated backoff when within max_delay (`retry.ts:26-29`)
- **No retry after partial stream delivery** — yieldedContent flag checked before retry (`retry.ts:149`)
- **Rate limit header parsing** — Parses x-ratelimit- and anthropic-ratelimit- headers (`src/llm/rate-limit.ts`)

### Unified LLM Spec — Provider Adapters (Section 7)

- **OpenAI adapter** — Responses API format, reasoning_effort → reasoning.effort, cache tokens from input_tokens_details.cached_tokens, stop_sequences mapped to stop parameter (`src/llm/adapters/openai.ts:242`)
- **Anthropic adapter** — Messages API, system extraction, max_tokens default 4096, thinking block round-trip with signature, consecutive same-role message merging (`src/llm/adapters/anthropic.ts:90`), cache_control auto-injection, reasoning_effort → thinking.budget_tokens
- **Gemini adapter** — Native generateContent, synthetic tool call IDs, function response by name, reasoning_effort → thinkingConfig.thinkingBudget, thoughtsTokenCount → reasoning_tokens (`src/llm/adapters/gemini.ts`)
- **OpenAI-Compatible adapter** — Chat Completions format (/v1/chat/completions), structured output fallback, reasoning token extraction (`src/llm/adapters/openai-compatible.ts`)
- **Beta headers (Anthropic)** — Auto-adds interleaved-thinking and prompt-caching; configurable via provider_options.anthropic.betas

### Unified LLM Spec — Prompt Caching (Section 2.10)

- **OpenAI** — Automatic via Responses API; cache_read_tokens populated from cached_tokens (`openai.ts`)
- **Anthropic** — cache_control blocks auto-injected; prompt-caching beta header included; cache_read_tokens and cache_write_tokens populated (`anthropic.ts`)
- **Gemini** — Automatic prefix caching; cachedContentTokenCount mapped to cache_read_tokens (`gemini.ts`)

### Unified LLM Spec — Reasoning Tokens (Section 3.9)

- **OpenAI** — reasoning_tokens from output_tokens_details.reasoning_tokens via Responses API (`openai.ts`)
- **Anthropic** — Thinking blocks returned as THINKING content parts; signature preserved for round-trip (`anthropic.ts`)
- **Gemini** — thoughtsTokenCount mapped to reasoning_tokens (`gemini.ts`)
- **Usage.reasoning_tokens** — Distinct from output_tokens across all providers (`types.ts`)

### Unified LLM Spec — Model Catalog (Section 2.9)

- **ModelInfo record** — flat spec fields (`supports_*`, `input_cost_per_million`, `output_cost_per_million`, `cache_read_cost_per_million`) with one-sprint compatibility aliases for nested `capabilities`/`cost` (`src/llm/catalog.ts`)
- **Lookup functions** — `getModelInfo()`, `listModels()`, `getLatestModel()` all exported (`catalog.ts:269-291`)
- **Model entries** — Anthropic (claude-opus-4-20250514, claude-sonnet-4-20250514, claude-haiku-4-5-20251001), OpenAI (o3, o3-mini, o4-mini, gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o), Gemini (gemini-2.5-pro, gemini-2.5-flash)

### Unified LLM Spec — Other

- **Simulation provider** — Deterministic responses, schema-aware generation, streaming simulation (`src/llm/simulation.ts`)
- **Structured output validation** — AJV-based JSON schema validation (`src/llm/structured.ts`)

---

## GAPS

No remaining implementation gaps were identified against the pinned attractor, coding-agent-loop, and unified-llm specs in this sprint snapshot.

Sprint 031 closures:

1. Attractor: enriched canonical interviewer answer model (`answer_value`, `selected_option`, `text`) with legacy label compatibility and boundary normalization.
2. Attractor: cocoon `logs` field added and backfilled on legacy checkpoint load.
3. Attractor: event payload enrichment (`node_started.index`, `run_completed.artifact_count`).
4. Coding agent loop: `agent_session_started` emitted by `AgentSession` itself (exactly once per session).
5. Coding agent loop: `ProviderProfile.providerOptions()` added and merged into request provider options.
6. Coding agent loop: `ToolRegistry.unregister()` implemented.
7. Coding agent loop: real `glob()`/`grep()` on `LocalExecutionEnvironment` via shared search helpers.
8. Coding agent loop: `submit()` now auto-discovers project instructions with session-level caching.
9. Coding agent loop: git context includes recent commit messages.
10. Unified LLM: `stream_end.response` is required and premature termination emits `error`.
11. Unified LLM: `Message.name` support added and sanitized for provider constraints.
12. Unified LLM: `GenerateRequest.max_tool_rounds` added and honored (default 1, deprecated alias retained).
13. Unified LLM: prompt+messages conflict now throws `InvalidRequestError`.
14. Unified LLM: Anthropic `provider_options.anthropic.auto_cache = false` supported (legacy alias retained).
15. Unified LLM: model catalog exposes flat spec fields with one-sprint compatibility aliases.
