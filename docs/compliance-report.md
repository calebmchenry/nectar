GAPS REMAINING

# Nectar Compliance Report

**Generated:** 2026-03-20
**Specs Compared:** attractor-spec.md, coding-agent-loop-spec.md, unified-llm-spec.md
**Source Inventory:** 111 source files across 13 modules

---

## IMPLEMENTED

### Attractor Spec (attractor-spec.md)

#### DOT Parsing (Spec §2, DoD §11.1)
- **Digraph subset:** Parser accepts `digraph ID { ... }` with graph/node/edge attribute blocks (`src/garden/parse.ts`)
- **Comments:** Both `//` line and `/* */` block comments stripped before parsing
- **Chained edges:** `A -> B -> C` expanded to individual edges via `splitEdgePath()`
- **Subgraphs:** Full support with scoped defaults and class derivation from labels via `normalizeClassName()`
- **Node/edge defaults:** `node [...]` and `edge [...]` blocks parsed and merged via scope stacks
- **Value types:** String, Integer, Float, Boolean, Duration (`parseTimeoutMs()` supporting ms/s/m/h/d)
- **Graph attributes:** `goal`, `label`, `model_stylesheet`, `default_max_retries` (with `default_max_retry` legacy alias), `retry_target`, `fallback_retry_target`, `default_fidelity`, `stack.child_dotfile`, `stack.child_workdir`, `tool_hooks.pre`, `tool_hooks.post` extracted
- **Node attributes:** `label`, `shape`, `type`, `prompt`, `max_retries`, `goal_gate`, `retry_target`, `fallback_retry_target`, `fidelity`, `thread_id`, `class`, `timeout`, `llm_model`, `llm_provider`, `reasoning_effort`, `auto_status`, `allow_partial`, `join_policy`, `max_parallel`, `human.default_choice`, manager attributes (`manager.poll_interval`, `manager.max_cycles`, `manager.stop_condition`, `manager.actions`, `stack.child_autostart`) all parsed
- **Edge attributes:** `label`, `condition`, `weight`, `fidelity`, `thread_id`, `loop_restart` parsed
- **Quoted/unquoted values:** Both work correctly
- **Class attribute:** Comma-separated class names parsed and used for stylesheet targeting
- **SHA256 hashing:** Source hashed for graph version tracking

#### Validation and Linting (Spec §7, DoD §11.2)
- **Start node:** Exactly one required (shape=Mdiamond or id matching start/Start) — ERROR severity (`src/garden/validate.ts`)
- **Exit node:** At least one required (shape=Msquare or id matching exit/end) — ERROR severity
- **Start no incoming edges:** Validated — ERROR severity
- **Exit no outgoing edges:** Validated — ERROR severity
- **Reachability:** BFS from start node via `findUnreachableNodes()`; unreachable nodes reported — ERROR severity
- **Edge targets exist:** Both source and target IDs validated (`UNKNOWN_EDGE_SOURCE`, `UNKNOWN_EDGE_TARGET`) — ERROR severity
- **Condition syntax:** Edge conditions parsed and validated — ERROR severity
- **Stylesheet syntax:** `model_stylesheet` parsed and validated — ERROR severity
- **Prompt on LLM nodes:** Warning if codergen nodes lack prompt attribute (`PROMPT_MISSING`) — WARNING severity
- **Fidelity valid:** Values validated against allowed modes — WARNING severity
- **Retry target exists:** Both `retry_target` and `fallback_retry_target` validated — WARNING severity
- **Goal gate has retry:** Warning if `goal_gate=true` without retry_target at node or graph level — WARNING severity
- **Type known:** Unrecognized node types flagged (`TYPE_UNKNOWN`) — WARNING severity
- **validate_or_raise:** Throws on error-severity violations
- **Diagnostic model:** Full rule name, severity (error/warning), node/edge ID, message, source location
- **Cycle detection:** Cycles without exit path detected via Tarjan's SCC algorithm
- **Parallel topology:** Parallel nodes require ≥2 outgoing edges; fan-in needs upstream parallel ancestor
- **Manager validation:** Actions, max_cycles, poll_interval, stop_condition, child_dotfile all validated
- **Additional checks:** Duplicate node IDs, join_policy values, max_parallel values, reasoning_effort values, llm_provider recognition, tool_hooks on non-codergen nodes

#### Execution Engine (Spec §3, DoD §11.3)
- **Start node resolution:** Engine finds start node by shape=Mdiamond or id matching (`src/engine/engine.ts`)
- **Handler dispatch:** Shape-to-handler-type mapping via `normalizeNodeKind()` with explicit `type` override (`src/handlers/registry.ts`)
- **Handler interface:** Common `execute(HandlerExecutionInput) -> NodeOutcome` contract
- **Edge selection:** Full 5-step priority algorithm — condition match → preferred label → suggested IDs → weight → lexical tiebreak (`src/engine/edge-selector.ts`)
- **Label normalization:** Accelerator prefix stripping ([X], X), X -) for label matching
- **Core loop:** Execute node → apply context updates → save checkpoint → select edge → advance
- **Terminal node:** shape=Msquare stops execution; goal gate check performed before exit
- **Pipeline outcome:** SUCCESS if all goal gates satisfied, FAIL otherwise
- **Status file contract:** `status.json` written per node in `{logs_root}/{node_id}/`
- **auto_status:** When handler returns no explicit status and auto_status=true, engine defaults to success
- **loop_restart:** Edge attribute `loop_restart=true` terminates current run and re-launches with fresh log directory; restart chains tracked via `RunResult.restart` with predecessor/successor fields

#### Goal Gate Enforcement (Spec §3.4, DoD §11.4)
- **Goal gate tracking:** Nodes with `goal_gate=true` tracked throughout execution
- **Exit check:** Before allowing exit, engine checks all goal gate nodes have SUCCESS or PARTIAL_SUCCESS
- **Retry routing:** If unsatisfied, engine routes to `retry_target` → `fallback_retry_target` → graph-level targets
- **Fail on no target:** Pipeline outcome FAIL if no retry target and goal gates unsatisfied
- **Goal gate max retries:** Configurable limit (default 5) on goal gate retry cycles

#### Retry Logic (Spec §3.5-3.6, DoD §11.5)
- **max_retries:** Nodes retried on RETRY or FAIL outcomes up to limit (`src/engine/engine.ts`)
- **Retry count:** Tracked per-node in context and cocoon
- **Exponential backoff:** Base 200ms, factor 2x, max 60s (`src/engine/retry.ts`)
- **Jitter:** Random 0.5-1.5x multiplier applied
- **allow_partial:** On retry exhaustion with `allow_partial=true`, converts to PARTIAL_SUCCESS
- **Failure routing:** Fail edge → retry_target → fallback_retry_target → pipeline termination (Spec §3.7)

#### Node Handlers (Spec §4, DoD §11.6)
- **Start handler:** Returns SUCCESS immediately (`src/handlers/start.ts`)
- **Exit handler:** Returns SUCCESS immediately; goal gate enforcement in engine (`src/handlers/exit.ts`)
- **Codergen handler:** Expands `$goal` in prompt, calls LLM backend (AgentSession or legacy), writes prompt.md/response.md/status.json to stage dir (`src/handlers/codergen.ts`)
- **CodergenBackend interface:** Supports both `UnifiedClient` (AgentSession path) and legacy `LLMClient` — backend-agnostic per Spec §1.4
- **Wait.human handler:** Derives choices from outgoing edges with accelerator key parsing, presents via Interviewer, returns selected edge as suggested_next; auto-detects question type (YES_NO, MULTIPLE_CHOICE, FREEFORM, CONFIRMATION); validates default_choice, duplicate labels, duplicate accelerators (`src/handlers/wait-human.ts`)
- **Conditional handler:** No-op returning SUCCESS; routing via engine's edge selection (`src/handlers/conditional.ts`)
- **Parallel handler:** Fan-out to multiple branches with bounded concurrency (`max_parallel`, default 4), configurable join policy (wait_all/first_success), stores results in context; finds convergence node (tripleoctagon); abort propagation to branches (`src/handlers/parallel.ts`)
- **Fan-in handler:** Consolidates parallel results, heuristic ranking by status (success > partial_success > retry > failure > skipped), returns best candidate with context updates (`src/handlers/fan-in.ts`)
- **Tool handler:** Executes shell command via `runScript()`, environment variables injected (NECTAR_RUN_ID, NECTAR_NODE_ID, etc.), timeout support (`src/handlers/tool.ts`)
- **Manager loop handler:** Orchestrates child pipeline via ChildRunController; autostart or attach mode; poll loop with observe/steer/wait actions; stop condition evaluation; context propagation; abort signal handling (`src/handlers/manager-loop.ts`)
- **Custom handlers:** Registerable by type string via `registry.register(kind, handler)` (`src/handlers/registry.ts`)
- **Handler contract:** Handlers return `NodeOutcome`; exceptions caught by engine and converted to FAIL outcomes

#### Shape-to-Handler Mapping (Spec §2.8, Appendix B)
- Mdiamond → start ✓
- Msquare → exit ✓
- box → codergen ✓ (default)
- hexagon → wait.human ✓
- diamond → conditional ✓
- component → parallel ✓
- tripleoctagon → parallel.fan_in ✓
- parallelogram → tool ✓
- house → stack.manager_loop ✓

#### State and Context (Spec §5, DoD §11.7)
- **Context:** Key-value store with get/set/setMany/snapshot/clone/applyUpdates/appendLog (`src/engine/context.ts`)
- **Context updates:** Merged after each node from outcome.context_updates
- **Built-in keys:** `outcome`, `preferred_label`, `graph.goal`, `current_node`, `last_stage`, `last_response`, `internal.retry_count.*` set by engine
- **Checkpoint:** Serializable cocoon saved after each node — timestamp, current_node, completed_nodes, context, retry_state, pending_transition, thread_registry_keys (`src/checkpoint/types.ts`)
- **Resume:** Load checkpoint → restore context → restore completed_nodes → continue from current_node; follows restart chains to latest run (`src/cli/commands/resume.ts`, `src/engine/engine.ts`)
- **Degraded fidelity on resume:** When previous node used `full` fidelity, first resumed node degrades to `summary:high` (`src/engine/fidelity.ts`, `src/checkpoint/types.ts:resume_requires_degraded_fidelity`)
- **Run directory structure:** `{logs_root}/manifest.json`, `{logs_root}/checkpoint.json`, `{logs_root}/{node_id}/status.json|prompt.md|response.md`, `{logs_root}/artifacts/` (`src/checkpoint/run-store.ts`)
- **Artifact store:** Named, typed storage with inline (≤100KB) and file-backed modes; store/retrieve/has/list/remove/clear (`src/artifacts/store.ts`, `src/artifacts/types.ts`)
- **Atomic writes:** Cocoon/manifest writes use temp→rename pattern for crash safety

#### Context Fidelity (Spec §5.4)
- **Modes:** `full`, `truncate`, `compact`, `summary:low`, `summary:medium`, `summary:high` all implemented (`src/engine/fidelity.ts`)
- **Token budgets:** full=unbounded, truncate=400, compact=3200, summary:low=2400, summary:medium=6000, summary:high=12000
- **Resolution precedence:** Edge fidelity → node fidelity → graph default_fidelity → compact fallback
- **Thread resolution:** Node thread_id → edge thread_id → graph default → derived class → previous node (`src/engine/thread-resolver.ts`)
- **Session registry:** Thread-based session reuse with FIFO locking and configurable timeout (`src/engine/session-registry.ts`)
- **Preamble builders:** Mode-specific context preambles with priority-based truncation; includes goal, run ID, node completion table, context snippets, human answers (`src/engine/preamble.ts`)

#### Human-in-the-Loop (Spec §6, DoD §11.8)
- **Interviewer interface:** `ask(question: Question) -> Answer` (`src/interviewer/types.ts`)
- **Question types:** YES_NO, MULTIPLE_CHOICE, FREEFORM, CONFIRMATION
- **Accelerator key parsing:** `[X] Label`, `X) Label`, `X - Label`, and first character fallback
- **AutoApproveInterviewer:** Selects default_choice or first option (`src/interviewer/auto-approve.ts`)
- **ConsoleInterviewer:** Terminal prompting with number/accelerator/label matching, timeout support, non-TTY guard (`src/interviewer/console.ts`)
- **CallbackInterviewer:** Delegates to provided callback function with timeout support (`src/interviewer/callback.ts`)
- **QueueInterviewer:** Pre-filled answer queue for deterministic testing (`src/interviewer/queue.ts`)
- **RecordingInterviewer:** Wraps inner interviewer and records all Q&A pairs including errors (`src/interviewer/recording.ts`)

#### Condition Expressions (Spec §10, DoD §11.9)
- **= operator:** Exact string comparison ✓
- **!= operator:** Not-equals comparison ✓
- **&& conjunction:** AND with multiple clauses ✓
- **|| disjunction:** OR support (extension beyond spec) ✓
- **outcome variable:** Resolves to current node's status ✓
- **preferred_label variable:** Resolves to outcome's preferred label ✓
- **context.\* variables:** Lookup with fallback (missing keys = empty string) ✓
- **Empty condition:** Always true ✓
- **Quoted string literals:** Supported with escape sequences ✓ (`src/engine/conditions.ts`)

#### Model Stylesheet (Spec §8, DoD §11.10)
- **Parsing:** From graph `model_stylesheet` attribute (`src/garden/stylesheet.ts`)
- **Selectors:** Universal (`*`), shape name, class (`.name`), ID (`#id`) all supported
- **Specificity:** Universal (0) < shape (1) < class (2) < ID (3)
- **Properties:** `llm_model`, `llm_provider`, `reasoning_effort`
- **Application order:** Explicit node attribute > stylesheet by specificity > graph default > system default
- **Transform:** Applied after parsing, before validation (`src/transforms/stylesheet-apply.ts`)

#### Transforms and Extensibility (Spec §9, DoD §11.11)
- **Pipeline:** parse → transform → validate sequence (`src/garden/pipeline.ts:transformAndValidate`)
- **Variable expansion:** `$goal` replaced in prompts (`src/transforms/goal-expansion.ts`)
- **Stylesheet application:** Model stylesheet applied as transform (`src/transforms/stylesheet-apply.ts`)

#### Observability and Events (Spec §9.6)
- **Pipeline lifecycle:** run_started, run_completed, run_interrupted, run_error events (`src/engine/events.ts`)
- **Stage lifecycle:** node_started, node_completed, node_retrying events
- **Edge events:** edge_selected with source, target, label, condition
- **Parallel events:** parallel_started, parallel_branch_started, parallel_branch_completed, parallel_completed
- **Human interaction:** human_question_presented, human_answer_received (with source: user|timeout|auto|queue)
- **Checkpoint:** checkpoint_saved events
- **Agent integration:** agent_session_started, agent_tool_call_started, agent_tool_call_completed, agent_loop_detected events
- **Manager/child events:** child_run_started, child_snapshot, child_steer, run_restarted
- **Tool hooks:** tool_hook_blocked events
- **Auto-status:** auto_status_applied events
- **Event consumption:** Observer/callback pattern via `engine.onEvent()`

#### Tool Call Hooks (Spec §9.7)
- **Parsing:** `tool_hooks.pre` and `tool_hooks.post` parsed at graph and node level (`src/garden/parse.ts`)
- **Pre-hook execution:** Shell commands run before each LLM tool call; exit code 0 = proceed, non-zero = block (`src/agent-loop/tool-hooks.ts`)
- **Post-hook execution:** Shell commands run after each LLM tool call for logging/auditing
- **Hook environment:** NECTAR_RUN_ID, NECTAR_NODE_ID, NECTAR_SESSION_ID, NECTAR_TOOL_CALL_ID, NECTAR_TOOL_NAME passed as environment variables
- **Hook timeout:** 15-second timeout per hook execution
- **Artifact persistence:** Hook metadata, stdout, stderr persisted for compliance/audit trails
- **Node-level override:** Node tool_hooks take precedence over graph-level tool_hooks

#### Concurrency Model (Spec §3.8)
- **Single-threaded graph traversal:** Only one node executes at a time in top-level graph ✓
- **Parallel within handlers:** Parallel/fan-in handlers manage concurrent branches internally ✓
- **Context isolation:** Each parallel branch receives a cloned context; only handler outcome merges back ✓

#### Child Runs and Manager Nodes (Spec §4.11)
- **ChildRunController:** start (launches child PipelineEngine), attach (reattaches to existing), readSnapshot, writeContext, abortOwnedChild (`src/engine/child-run-controller.ts`)
- **Manager loop:** Observe (polls child snapshot), steer (evaluates conditions, writes context notes), wait (delays between polls); cycle tracking; configurable poll interval and max cycles (`src/handlers/manager-loop.ts`)
- **Restart chains:** loop_restart edges terminate run and re-launch; chains tracked and auto-followed by CLI (`src/engine/engine.ts`, `src/cli/commands/run.ts`)
- **Restart depth:** max_restart_depth enforced to prevent infinite restart loops

---

### Coding Agent Loop Spec (coding-agent-loop-spec.md)

#### Core Agentic Loop (Spec §2, DoD §9.1)
- **Session:** Created with provider profile and execution environment (`src/agent-loop/session.ts:AgentSession`)
- **process_input:** Agentic loop — LLM call → tool execution → loop until natural completion
- **Natural completion:** Model responds text-only (no tool calls) → loop exits
- **Round limits:** `max_tool_rounds_per_input` stops loop when reached
- **Turn limits:** `max_turns` enforced across session
- **Abort signal:** Cancellation stops loop, kills processes, transitions to CLOSED via AbortController propagation
- **Loop detection:** SHA256 fingerprint-based detection of repeating tool call patterns; mutation tracking to distinguish progress from loops; configurable window (5 rounds) and threshold (3 repetitions) (`src/agent-loop/loop-detection.ts`)
- **Sequential inputs:** submit/followUp queue enables multiple inputs; follow-up limit enforced (default 10)
- **Steering:** `steer()` queues messages injected after current tool round; `followUp()` queues for after completion

#### Session State Machine (Spec §2.3)
- **States:** IDLE → PROCESSING → IDLE (normal); PROCESSING → AWAITING_INPUT; any → CLOSED
- **Transitions:** All specified transitions implemented (`src/agent-loop/types.ts:SessionState`)

#### Provider Profiles (Spec §3, DoD §9.2)
- **OpenAI profile:** codex-rs-aligned tools including `apply_patch` (v4a format), parallel execution enabled (`src/agent-loop/provider-profiles.ts:OpenAIProfile`)
- **Anthropic profile:** Claude Code-aligned tools including `edit_file` (old_string/new_string), parallel execution enabled (`src/agent-loop/provider-profiles.ts:AnthropicProfile`)
- **Gemini profile:** gemini-cli-aligned tools, sequential execution (`src/agent-loop/provider-profiles.ts:GeminiProfile`)
- **System prompts:** Provider-specific base prompts assembled with environment context, tool descriptions, and project docs
- **Custom tools:** Registerable on top of any profile via ToolRegistry
- **Name collision:** Latest registration wins
- **Provider-specific guidance:** Edit format instructions, tool usage patterns

#### Shared Core Tools (Spec §3.3)
- **read_file:** Line-numbered content with offset/limit; binary detection; image support (`src/agent-loop/tools/read-file.ts`)
- **write_file:** Full file writes with parent directory creation, byte count return (`src/agent-loop/tools/write-file.ts`)
- **edit_file:** old_string/new_string exact replacement with uniqueness enforcement and diff summary (`src/agent-loop/tools/edit-file.ts`)
- **shell:** Command execution with configurable timeout, SIGTERM/SIGKILL timeout handling, exit code/stdout/stderr separation (`src/agent-loop/tools/shell.ts`)
- **grep:** Regex search with glob filter, .gitignore respect, binary skip (`src/agent-loop/tools/grep.ts`)
- **glob:** File pattern matching with .gitignore respect (`src/agent-loop/tools/glob.ts`)
- **apply_patch:** v4a format (OpenAI-specific) with add/delete/update/move operations; transactional application; context matching with fuzzy search; line ending preservation; path traversal prevention (`src/agent-loop/tools/apply-patch.ts`, `src/agent-loop/patch.ts`)

#### Subagent Tools (Spec §7, DoD §9.9)
- **spawn_agent:** Spawns child with scoped task, optional model override, turn limits, timeout (`src/agent-loop/tools/spawn-agent.ts`)
- **send_input:** Sends steering (PROCESSING state) or follow-up (IDLE state) to running child (`src/agent-loop/tools/send-input.ts`)
- **wait:** Blocks until child(ren) complete and returns results; supports single or array of agent_ids (`src/agent-loop/tools/wait.ts`)
- **close_agent:** Terminates a subagent and returns final status (`src/agent-loop/tools/close-agent.ts`)
- **Shared environment:** Children share parent's execution environment (same filesystem)
- **Independent history:** Each child gets own Session with independent conversation
- **Depth limiting:** `max_subagent_depth` prevents recursive spawning (default 1) (`src/agent-loop/subagent-manager.ts`)
- **Concurrency limiting:** `max_concurrent_children` prevents resource exhaustion (default 4)
- **Child tool isolation:** Subagent tools excluded from child registries

#### Tool Execution (Spec §3.8, DoD §9.3)
- **ToolRegistry dispatch:** Lookup by name → validate → execute → truncate → emit → return (`src/agent-loop/tool-registry.ts`)
- **Unknown tools:** Error result returned to LLM (not exception)
- **Argument validation:** JSON Schema validation via AJV
- **Error results:** Caught and returned as `is_error = true`
- **Parallel execution:** Supported when profile's `supports_parallel_tool_calls` is true; intelligent partitioning of read-only vs mutating calls; read-only concurrent, mutating sequential; order preserved (`src/llm/tools.ts:executeToolsBatch`)
- **Tool safety classification:** Read-only vs mutating categorization per tool

#### Execution Environment (Spec §4, DoD §9.4)
- **LocalExecutionEnvironment:** File operations, command execution, search, metadata (`src/agent-loop/execution-environment.ts`)
- **Command timeout:** Default configurable, overridable per-call
- **Timeout handling:** SIGTERM → wait → SIGKILL; exit code 124 for timeout, 130 for abort
- **Env var filtering:** Allowlist/denylist with sensitive variable exclusion (`*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`)
- **Interface:** Implementable by consumers for custom environments (Docker, K8s, WASM, SSH)
- **Workspace boundary:** Path resolution with symlink detection and escape prevention
- **Scoped environments:** Subdirectory isolation for child agents

#### Tool Output Truncation (Spec §5, DoD §9.5)
- **Character-based first:** Head/tail split runs on all tool outputs; 80/20 head/tail ratio (`src/agent-loop/truncation.ts`)
- **Line-based second:** Per-tool line caps (shell: 256, grep: 200, glob: 500) applied after character truncation
- **Truncation marker:** Visible `[... truncated N lines ...]` message
- **Full output preserved:** In artifacts and TOOL_CALL_END events via `full_content` field
- **Default character limits:** read_file: 50K, shell: 30K, grep: 20K, glob: 10K, edit_file: 10K, write_file: 1K (`src/agent-loop/types.ts:TOOL_OUTPUT_LIMITS`)
- **Overridable:** Via session config

#### System Prompts and Environment Context (Spec §6, DoD §9.8)
- **Provider-specific base:** Each profile supplies native base prompt with tool-specific guidance
- **Environment context:** Platform, shell, working dir, date, model info (`src/agent-loop/environment-context.ts:buildEnvironmentContext`)
- **Git context:** Branch, status summary (staged/unstaged/untracked counts), recent commits; cached once per session; 2-second timeout per git command (`src/agent-loop/environment-context.ts:buildGitSnapshot`)
- **Project docs:** AGENTS.md + provider-specific files (CLAUDE.md, GEMINI.md, .codex/instructions.md) discovered and loaded with 32KB budget (`src/agent-loop/project-instructions.ts`)
- **Provider-specific loading:** Only relevant docs loaded per profile (Anthropic loads CLAUDE.md, not GEMINI.md)
- **Budget enforcement:** Least-specific files removed first when exceeding 32KB

#### Reasoning Effort (Spec §2.7, DoD §9.7)
- **Passed through:** To LLM SDK Request via `reasoning_effort` field
- **Mid-session changes:** Take effect on next LLM call via session overrides
- **Valid values:** "low", "medium", "high", null (provider default)

#### Event System (Spec §2.9, DoD §9.10)
- **Agent events:** session_started, turn_started, text_delta, tool_call_started, tool_call_completed, loop_detected, session_completed (`src/agent-loop/events.ts`)
- **Subagent events:** subagent_spawned, subagent_completed, subagent_message (with direction and message type)
- **TOOL_CALL_END:** Full untruncated output via artifact path and content preview
- **Session lifecycle:** Start/end events bracket sessions with metrics (turn count, tool call count, usage)
- **Delivery:** Via `AgentEventListener` callback

#### Tool Hooks (Spec §9.7 cross-ref)
- **Pre/post hooks:** Shell commands around each LLM tool call (`src/agent-loop/tool-hooks.ts`)
- **Pre-hook gating:** Non-zero exit blocks tool execution; event emitted
- **Post-hook auditing:** Runs after completion with result metadata
- **Metadata:** Run ID, node ID, session ID, tool call ID, tool name, arguments, duration, content preview
- **Artifact persistence:** Hook results persisted for compliance/audit

#### Transcript (Spec-adjacent)
- **Full recording:** Prompts, responses, tool calls, status persisted (`src/agent-loop/transcript.ts`)
- **Per-tool artifacts:** Each tool call stored with request.json, result.json, full-result.txt
- **Nested hierarchy:** Subagent transcripts nested under parent
- **Shell output:** STDOUT/STDERR split into separate log files

---

### Unified LLM Client Spec (unified-llm-spec.md)

#### Core Infrastructure (Spec §2, DoD §8.1)
- **Client from env:** `UnifiedClient.from_env()` reads standard env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY) (`src/llm/client.ts`)
- **Programmatic construction:** Explicit adapter registration with Map<string, ProviderAdapter>
- **Provider routing:** Requests dispatched to correct adapter based on provider field
- **Default provider:** Used when provider omitted; priority: anthropic > openai > gemini > simulation
- **ConfigurationError:** Raised when no provider configured and no default set (`src/llm/errors.ts`)
- **Middleware chain:** Full middleware interface with `generate()` and `stream()` hooks; registration-order execution for requests, reverse for responses; method chaining via `use()` (`src/llm/middleware.ts`)
- **Module-level default client:** `setDefaultClient()`, `getDefaultClient()`, `clearDefaultClient()`, lazy initialization from env on first use (`src/llm/client.ts`)
- **Model catalog:** Populated with current models across all providers (Anthropic, OpenAI, Gemini); `getModelInfo()`, `listModels()`, `getLatestModel()`, `resolveModelSelector()` (`src/llm/catalog.ts`)
- **Model capabilities:** Streaming, tool_calling, structured_output, vision, thinking tracked per model
- **Cost tracking:** Input/output per million tokens; cache read cost where applicable
- **Logical selectors:** default, fast, reasoning per provider

#### Provider Adapters (Spec §7, DoD §8.2)
- **OpenAI:** Uses native **Responses API** (`/v1/responses`) — NOT Chat Completions (`src/llm/adapters/openai.ts`)
- **Anthropic:** Uses native **Messages API** (`/v1/messages`) with version 2023-06-01 (`src/llm/adapters/anthropic.ts`)
- **Gemini:** Uses native **Gemini API** (`/v1beta/models/*/generateContent`) (`src/llm/adapters/gemini.ts`)
- **Authentication:** API keys from env vars or explicit config; per-provider header format (Bearer, x-api-key, query param)
- **complete():** Sends request, returns unified GenerateResponse
- **stream():** Returns async iterator of StreamEvent objects
- **System message handling:** Per-provider extraction (OpenAI: instructions param, Anthropic: system param, Gemini: systemInstruction)
- **Role translation:** All 5 roles (SYSTEM, USER, ASSISTANT, TOOL, DEVELOPER) translated correctly per provider
- **provider_options:** Escape hatch passes through provider-specific params (anthropic: thinking/beta_headers; openai: store/metadata; gemini: safetySettings)
- **Beta headers:** Anthropic `anthropic-beta` header built automatically for thinking and caching features
- **Error translation:** HTTP status codes mapped to error hierarchy per provider

#### Data Model (Spec §3, DoD §8.3)
- **Roles:** system, user, assistant, tool, developer (`src/llm/types.ts`)
- **ContentPart:** text, image (base64/url), tool_call, tool_result, thinking (with signature), redacted_thinking
- **Image input:** ImageSource type defined for multimodal support (base64 and URL)
- **Tool call round-trip:** assistant→tool_call→tool_result→assistant cycle works across all providers
- **Thinking blocks:** Anthropic thinking blocks preserved with signatures; redacted thinking passed through verbatim
- **Usage:** input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens
- **RateLimitInfo:** Parsed from response headers (`src/llm/rate-limit.ts`), included on GenerateResponse
- **ResponseFormat:** text, json, json_schema with strict flag

#### Generation (Spec §4, DoD §8.4)
- **generate():** Non-streaming generation via `generateUnified()` (`src/llm/client.ts`)
- **stream():** Yields StreamEvent objects with content deltas
- **generateObject\<T\>():** Structured output with JSON Schema validation and retry loop (max_validation_retries, default 2) (`src/llm/client.ts`)
- **streamObject\<T\>():** Streaming structured output with on-the-fly JSON parsing (`src/llm/client.ts`)
- **Simulation provider:** Returns schema-minimal objects for testing; generates simulated thinking when reasoning_effort set (`src/llm/simulation.ts`)
- **Structured output per provider:** OpenAI: native json_schema; Anthropic: synthetic `__structured_output` tool with forced tool_choice; Gemini: responseMimeType + responseSchema

#### Streaming (Spec §3.13-3.14, §4.2)
- **StreamEvent types:** stream_start, content_delta, tool_call_delta, thinking_delta, usage, stream_end, error (`src/llm/streaming.ts`)
- **SSE parsing:** Shared SSE parser for all providers with proper line buffering and abort signal support (`src/llm/streaming.ts:parseSSEStream`)
- **OpenAI streaming:** Responses API events (response.created, output_text.delta, function_call_arguments.delta, output_item.done, response.completed)
- **Anthropic streaming:** content_block_start/delta/stop events for text, tool_use, and thinking
- **Gemini streaming:** SSE via `?alt=sse` query parameter; function calls emitted as complete objects

#### Reasoning Tokens (Spec §3.9, DoD §8.5)
- **OpenAI:** reasoning_effort mapped to `reasoning.effort` in Responses API; reasoning_tokens from `output_tokens_details.reasoning_tokens`
- **Anthropic:** Extended thinking via `thinking` parameter with budget mapping (low=1024, medium=4096, high=16384); thinking blocks returned as content parts with signature; cache breakpoints on thinking-enabled requests
- **Gemini:** thinkingConfig with thinkingBudget mapped from reasoning_effort; thoughtsTokenCount mapped to reasoning_tokens; thought parts (thought=true) tracked
- **Usage:** reasoning_tokens distinct from output_tokens across all providers

#### Prompt Caching (Spec §2.10, DoD §8.6)
- **OpenAI:** cache_read_tokens extracted from `usage.input_tokens_details.cached_tokens` (automatic, no client action)
- **Anthropic:** Explicit cache_control injection via `injectCacheBreakpoints()` on system prompt, tools, and conversation prefix; `prompt-caching-2024-07-31` beta header included automatically; cache_read_tokens and cache_write_tokens populated from usage (`src/llm/adapters/anthropic.ts`)
- **Gemini:** cache_read_tokens extracted from `usageMetadata.cachedContentTokenCount` (automatic)

#### Tool Calling (Spec §5, DoD §8.7)
- **Tool definitions:** Name, description, input_schema (JSON Schema) (`src/llm/tools.ts`)
- **ToolChoice:** auto, none, required, named modes; per-provider translation (Anthropic: none = omit tools; OpenAI: named = function wrapper; Gemini: named = ANY with allowed_function_names)
- **Parallel execution:** Concurrent execution with intelligent read-only/mutating partitioning; bounded parallelism (`src/llm/tools.ts:executeToolsBatch`)
- **Error handling:** Tool errors sent to model as error results (`is_error = true`)
- **Validation:** JSON Schema validation via AJV before execution (`src/llm/structured.ts`)
- **Per-provider translation:** Tool definition format translated per provider (OpenAI: function wrapper, Anthropic: input_schema, Gemini: functionDeclarations)

#### Error Handling and Retry (Spec §6, DoD §8.8)
- **Error hierarchy:** LLMError → AuthenticationError (401), RateLimitError (429), OverloadedError (503), InvalidRequestError (400), ContextWindowError, ContentFilterError, NetworkError, TimeoutError, ConfigurationError, StructuredOutputError (`src/llm/errors.ts`)
- **Retryable flags:** Set correctly per error type (429, 503, timeout = retryable; 401, 400, 403, 404 = non-retryable)
- **Exponential backoff:** Base 200ms, factor 2x, max 60s, jitter 0.5-1.0x (`src/llm/retry.ts`)
- **Retry-After:** Parsed from headers (seconds or HTTP-date), respected by retry middleware (`src/llm/errors.ts:parseRetryAfterMs`)
- **Retry middleware:** Wraps adapter; only retries retryable errors; streaming only retries before content delivery; configurable max_retries (default 3)
- **Rate limit headers:** Multi-provider format parsing (x-ratelimit-*, anthropic-ratelimit-*) (`src/llm/rate-limit.ts`)
- **StructuredOutputError:** Includes raw text, validation errors, schema, and parse error for debugging

---

## GAPS

### Attractor Spec Gaps

#### GAP-A1: Custom Transform Registration API — Spec §9.3

The pipeline uses a fixed transform chain (goal expansion → stylesheet application). There is no public API for registering custom transforms that run in defined order after built-in transforms. The spec states "Implementations may register custom transforms" with `runner.register_transform(MyCustomTransform())`.

**Missing:**
- `registerTransform(transform)` API on pipeline or runner
- Custom transform ordering after built-in transforms

**Severity:** Low — extensibility point, not a core feature.

#### GAP-A2: HTTP Server Mode — Spec §9.5

The HTTP server mode with REST endpoints for remote pipeline management is not implemented. The spec defines endpoints for: POST /pipelines, GET /pipelines/{id}, GET /pipelines/{id}/events (SSE), POST /pipelines/{id}/cancel, GET /pipelines/{id}/graph (SVG), GET/POST /pipelines/{id}/questions, GET /pipelines/{id}/checkpoint, GET /pipelines/{id}/context.

**Note:** The spec qualifies this with "Implementations may expose..." and the DoD §11.11 says "HTTP server mode (if implemented)", making this explicitly optional.

**Severity:** Low — optional per spec.

#### GAP-A3: Interviewer `ask_multiple()` and `inform()` Methods — Spec §6.1

The Interviewer interface specifies three methods: `ask()`, `ask_multiple()`, and `inform()`. Only `ask()` is implemented. `ask_multiple()` (batch questions) and `inform()` (one-way status messages) are not present.

**Missing:**
- `ask_multiple(questions: List<Question>) -> List<Answer>` method on Interviewer interface
- `inform(message: String, stage: String) -> Void` method on Interviewer interface

**Severity:** Low — `ask()` covers the primary use case; `ask_multiple` is a convenience; `inform` is informational only.

---

### Unified LLM Client Spec Gaps

#### GAP-L1: OpenAI-Compatible Endpoints Adapter — Spec §7.10

No `OpenAICompatibleAdapter` for third-party Chat Completions endpoints (vLLM, Ollama, Together AI, Groq, etc.). The spec distinguishes this from the primary OpenAI adapter which uses the Responses API.

**Missing:**
- `OpenAICompatibleAdapter` class using Chat Completions endpoint (`/v1/chat/completions`)
- Chat Completions streaming format handling (`data: [DONE]`)

**Severity:** Medium — blocks third-party LLM endpoint support, but all three major providers (OpenAI, Anthropic, Gemini) work via their native APIs.

#### GAP-L2: High-Level `generate()` with Built-In Tool Execution Loop — Spec §4.3, DoD §8.7

The Unified LLM Client spec defines a Layer 4 `generate()` function with `max_tool_rounds` that automatically executes active tools and loops until natural completion. The current `generate()` is a simple delegation to `generateUnified()` without a built-in tool execution loop. The `GenerateResult` and `StepResult` types from the spec are not implemented in the LLM client.

**Note:** Tool execution looping is fully implemented in the agent-loop module (`src/agent-loop/session.ts`) which uses the lower-level `Client.complete()` directly — this is the architecture the coding-agent-loop-spec explicitly recommends ("The agent loop uses the SDK's low-level Client.complete() and Client.stream() methods directly, implementing its own turn loop"). The gap is only relevant for standalone LLM client use without the agent loop.

**Missing:**
- `max_tool_rounds` parameter on `generate()`
- Automatic tool execution loop in `generate()` for active tools
- `GenerateResult` and `StepResult` types

**Severity:** Low — the agent loop handles this at a higher level, which is the spec-recommended architecture. Standalone users can use `generateUnified()` in their own loop.

---

### Coding Agent Loop Spec Gaps

No material gaps identified. The agent-loop module (`src/agent-loop/`) implements all Definition of Done items from Spec §9.1-9.11:

- Core loop with all stop conditions ✓
- Three provider profiles (OpenAI/Anthropic/Gemini) with native toolsets ✓
- Full tool execution pipeline with registry, validation, truncation ✓
- LocalExecutionEnvironment with all file/command operations ✓
- Steering and follow-up queues ✓
- Subagent spawning with depth limiting ✓
- Complete event system ✓
- Tool output truncation (character-first, then line-based) ✓
- Project instruction discovery ✓
- System prompt construction ✓
- Reasoning effort support ✓
- Loop detection ✓
- Tool hooks (pre/post) ✓

---

## Summary

| Spec | Implemented | Gaps | Gap IDs |
|------|------------|------|---------|
| Attractor | ~99% | 3 | GAP-A1, GAP-A2, GAP-A3 |
| Coding Agent Loop | ~100% | 0 | — |
| Unified LLM Client | ~97% | 2 | GAP-L1, GAP-L2 |

**Total gaps: 5** (1 extensibility point, 1 optional server mode, 1 minor interface method, 1 third-party adapter, 1 convenience API layer)

**Highest priority gaps:**
1. GAP-L1 (OpenAI-Compatible Adapter) — blocks third-party LLM endpoint support
2. GAP-A1 (Custom Transform Registration) — blocks user-defined graph transforms
3. GAP-L2 (generate() tool loop) — standalone LLM client users lack built-in tool loop
4. GAP-A3 (Interviewer ask_multiple/inform) — minor interface completeness
5. GAP-A2 (HTTP Server Mode) — optional per spec
