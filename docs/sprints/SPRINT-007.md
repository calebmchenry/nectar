# Sprint 007: Coding Agent Loop — Codergen Nodes That Actually Code

## Overview

**Goal:** Transform `box` / `codergen` nodes from single-turn prompt wrappers into bounded local coding agents. After this sprint, a codergen node receives a prompt, reads files, edits code, runs commands, iterates through tool calls, and returns a final answer — all within bounded turn limits and with full artifact preservation.

**Why this sprint, why now:**

The compliance report (2026-03-19) tells a clear story:

| Area | Completion | Trend |
|------|-----------|-------|
| Attractor engine | ~75% | Sprints 001-004 |
| Unified LLM client | ~40% | Sprints 005-006 |
| **Coding Agent Loop** | **0%** | **Never started** |

The LLM client now supports Anthropic, OpenAI, and Gemini with streaming, tool calling, retry, and error handling. But codergen nodes still can't *do* anything — they generate text and stop. Every real-world pipeline needs codergen to read code, edit files, and run tests. This is the gap between "demo" and "useful."

GAP-40 is massive (the entire `coding-agent-loop-spec.md`). This sprint takes the critical foundation slice: the parts that make codergen nodes work as local coding agents. Everything else (subagents, steering, remote environments) builds on top of this foundation.

**Scope — what ships:**

- `AgentSession` with bounded multi-turn tool loop (`processInput()` -> stream -> execute tools -> loop)
- 6 core tools: `read_file`, `write_file`, `edit_file`, `shell`, `grep`, `glob`
- `LocalExecutionEnvironment` with workspace sandboxing, path escape prevention, timeout handling, env-var filtering
- `ToolRegistry` with JSON Schema argument validation, dispatch, structured error returns
- Tool output truncation (character-based head/tail split, per-tool limits, full output to disk)
- Provider profiles for Anthropic, OpenAI, and Gemini (shared tool contract, provider-specific system prompts)
- Project instruction discovery (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.codex/instructions.md`) with 32KB budget
- Runaway loop detection (repeated tool-call fingerprinting)
- Full artifact trail: `transcript.jsonl`, per-tool request/result files, `response.md`, `status.json`
- Agent-aware engine events and CLI rendering

**Scope — what doesn't ship:**

- `steer()` and `follow_up()` — mid-session injection is a separate concern
- Subagents (`spawn_agent`, `send_input`, `wait`, `close_agent`) — requires depth limiting, independent sessions
- Remote execution environments (Docker, K8s, WASM, SSH)
- Provider-specific patch DSLs (Codex `apply_patch` v4a, etc.) — one `edit_file` contract for all providers
- Parallel tool execution within a single model turn — sequential only
- Mid-node session resume — interruption preserves artifacts, resume restarts the node
- Model stylesheet (GAP-06), context fidelity (GAP-07), manager loop (GAP-04), HTTP server, web UI, seedbed

---

## Use Cases

1. **Multi-step code task:** A pipeline reaches the `implement` codergen node with prompt `"Fix the failing parser tests."` The agent calls `grep` to find test failures, `read_file` to inspect the test and source, `edit_file` to fix the bug, `shell` to run `npm test`, sees green, and returns success with a summary of what it changed.

2. **Tool error recovery:** The model calls `edit_file` with an `old_string` that doesn't match. The tool returns a structured error result — not an exception. The model reads the file again, finds the correct text, and retries the edit. This is critical: tool errors are recoverable information, not fatal crashes.

3. **Large output stays bounded:** The model runs `npm test` and gets 80KB of output. The full stdout/stderr are written to `tool-calls/003-shell/stdout.log`. Only a truncated head/tail view (30K chars) goes back to the model. The context window stays manageable.

4. **Provider-specific instructions:** A node sets `llm_provider="openai"`. The session loads `AGENTS.md` + `.codex/instructions.md`, combines them with the OpenAI provider profile's system prompt, and the model follows repo-specific conventions without them being hardcoded in the garden prompt.

5. **Clean abort:** User hits Ctrl+C during a shell command inside a codergen node. The session aborts the active stream/tool, sends SIGTERM to the child process (escalating to SIGKILL after 5s), writes partial artifacts, and the pipeline checkpoints cleanly. `pollinator resume` restarts the codergen node from scratch.

6. **Loop detection:** A model calls `grep "TODO" src/` -> `read_file src/main.ts` -> `grep "TODO" src/` -> `read_file src/main.ts` three times without editing anything. The loop detector fires, fails the session with reason `loop_detected`, and the pipeline engine can retry or route to a failure edge.

7. **No-tool completion:** A simple codergen node with prompt `"Summarize the architecture of this project"` reads some files and returns text. No tools needed — the session completes on the first `end_turn` stop reason.

---

## Architecture

### Design Principles

**One tool contract, all providers.** All three providers use the exact same six tools with the same JSON schemas. Provider differences live exclusively in system prompt framing. This keeps the sprint finishable and behavior testable.

**Tools return errors, never throw.** Every tool execution is wrapped in try/catch. Errors become structured `tool_result` messages with `is_error: true`. The model sees them and can recover. Only session-level failures (abort, turn limit) terminate the loop.

**Truncation is invisible to tools, visible to the model.** Tool implementations return full output. The session truncates before appending to the message history. Full output is persisted in artifacts for debugging.

**Sequential tool execution.** When a model response contains multiple tool calls, they execute sequentially in declaration order. This is simpler, deterministic, and sufficient for this sprint. Parallel tool execution is a future optimization.

### Module Layout

```text
src/agent-loop/
├── types.ts                    # SessionConfig, SessionResult, ToolCallEnvelope
├── events.ts                   # AgentEvent discriminated union
├── session.ts                  # AgentSession: processInput() bounded loop
├── tool-registry.ts            # Schema validation, dispatch, error wrapping
├── execution-environment.ts    # ExecutionEnvironment interface + LocalExecutionEnvironment
├── provider-profiles.ts        # Anthropic/OpenAI/Gemini prompt profiles
├── project-instructions.ts     # AGENTS.md / CLAUDE.md / GEMINI.md discovery
├── truncation.ts               # Head/tail character truncation with markers
├── loop-detection.ts           # Fingerprint-based repeated-round detection
├── transcript.ts               # JSONL + per-tool artifact writer
└── tools/
    ├── read-file.ts
    ├── write-file.ts
    ├── edit-file.ts            # Exact-match replacement, zero/multi match = error
    ├── shell.ts                # execa with timeout, env filtering, SIGTERM->SIGKILL
    ├── grep.ts                 # In-process regex search, respects .gitignore
    └── glob.ts                 # In-process workspace file matching, respects .gitignore
```

### Key Abstractions

**`AgentSession`** — The core loop. Takes a `UnifiedClient`, `ToolRegistry`, `ProviderProfile`, and config. `processInput(prompt)` iterates: stream model output -> collect tool calls -> execute tools -> append results -> stream again -> until `end_turn` or limit reached. Returns `SessionResult` with status, final text, usage stats, and turn count.

**`ExecutionEnvironment`** — Interface for file I/O, path resolution, and shell execution. `LocalExecutionEnvironment` implements it with workspace-root enforcement (all paths resolved through `realpath()`, rejected if outside root), environment variable filtering (drop `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`), and SIGTERM->SIGKILL escalation on timeout/abort.

**`ToolRegistry`** — Maps tool names to implementations. Validates arguments against JSON Schema before dispatch. Wraps execution in try/catch and returns structured error results. Exposes tool definitions for the `GenerateRequest.tools` field.

**`ProviderProfile`** — Supplies the system prompt preamble and any provider-specific behavioral tuning. Not a separate execution stack — all providers share the same session core and tools.

**`TranscriptWriter`** — Persists the session as structured artifacts under the node run directory. `response.md` contains the final assistant answer; `transcript.jsonl` contains the full turn-by-turn record; each tool call gets its own request/result files.

### Tool Contracts

- `read_file(path, offset?, limit?)` — returns line-numbered text; detects and rejects binary files (null-byte check in first 8KB)
- `write_file(path, content)` — creates file with parent directories, always writes (overwrite is the normal workflow for coding agents; `edit_file` handles the careful-change case)
- `edit_file(path, old_string, new_string)` — exact literal string match replacement; zero matches or multiple matches is an error with line numbers and helpful diagnostic message; no fuzzy patching
- `shell(command, timeout_ms?)` — runs inside workspace root only, with filtered environment and deterministic timeout; SIGTERM then SIGKILL (5s grace) on timeout/abort
- `grep(pattern, path?, include?, max_results?)` — in-process regex search; optional `path` to scope to a subdirectory; optional `include` glob filter; respects `.gitignore`; returns `file:line:content` format, capped at max_results (default 200)
- `glob(pattern, max_results?)` — in-process file matching; returns workspace-relative paths; respects `.gitignore`; capped at max_results (default 200)

### Artifact Layout

```text
<run_dir>/<node_id>/
├── prompt.md                   # Initial task prompt
├── response.md                 # Final assistant response text
├── status.json                 # Extended: provider, model, turns, tool_calls, stop_reason
├── transcript.jsonl            # Full turn-by-turn record
└── tool-calls/
    ├── 001-read_file/
    │   ├── request.json
    │   └── result.json
    ├── 002-edit_file/
    │   ├── request.json
    │   └── result.json
    └── 003-shell/
        ├── request.json
        ├── result.json
        ├── stdout.log          # Full untruncated stdout
        └── stderr.log          # Full untruncated stderr
```

### Data Flow

```text
PipelineEngine
   │
   ▼
CodergenHandler
   ├── loads project instructions (AGENTS.md + provider-specific)
   ├── selects ProviderProfile from node llm_provider
   ├── creates AgentSession with ToolRegistry + LocalExecutionEnvironment
   └── calls session.processInput(expanded_prompt)
            │
            ▼
      ┌──> UnifiedClient.stream()
      │        │
      │   assistant text / tool_calls
      │        │
      │        ▼
      │   ToolRegistry.execute(tool_call)
      │        │
      │        ▼
      │   LocalExecutionEnvironment
      │        │
      │   result -> truncate -> append to messages
      │        │
      └────────┘  (loop until end_turn or limit)
            │
            ▼
      SessionResult -> CodergenHandler -> NodeOutcome
```

---

## Implementation

### Phase 1: Types, Execution Environment, and Tool Registry (~25%)

**Files:** `src/agent-loop/types.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/tool-registry.ts`, `src/agent-loop/truncation.ts`, `test/agent-loop/tool-registry.test.ts`, `test/agent-loop/truncation.test.ts`

**Tasks:**
- [ ] Define `SessionConfig`: max_turns (default 12), max_tool_rounds_per_input (default 10), default_command_timeout_ms (default 120_000), workspace_root
- [ ] Define `SessionResult`: status (`success` | `failure` | `aborted`), final_text, usage (aggregated across turns), turn_count, tool_call_count, stop_reason, error_message?
- [ ] Define `ToolCallEnvelope`: name, arguments (parsed JSON), call_id
- [ ] Define `ToolResultEnvelope`: call_id, content (string), is_error (boolean), full_content? (pre-truncation)
- [ ] Implement `ExecutionEnvironment` interface: `readFile(path)`, `writeFile(path, content)`, `fileExists(path)`, `resolvePath(path)` (returns absolute, rejects escapes), `exec(command, options)` (returns {stdout, stderr, exitCode}), `glob(pattern)`, `grep(pattern, options)`
- [ ] Implement `LocalExecutionEnvironment`:
  - Constructor takes `workspace_root: string`, resolves workspace root via `realpath()` at creation time
  - `resolvePath()`: join with workspace root, call `fs.realpath()`, reject if resolved path is outside root
  - `exec()`: `execa` with `cwd` inside workspace, filtered env, configurable timeout, SIGTERM then SIGKILL (5s grace)
  - Environment filter: keep PATH, HOME, USER, TMPDIR, LANG, LC_*, CI, NODE_ENV, POLLINATOR_*; drop everything matching `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_CREDENTIAL*`
- [ ] Implement `ToolRegistry`:
  - `register(name, schema, handler)` — handler is `(args, env) => Promise<string>`
  - `definitions()` -> `ToolDefinition[]` for GenerateRequest
  - `execute(call: ToolCallEnvelope, env: ExecutionEnvironment)` -> `ToolResultEnvelope`
  - Validate arguments with `ajv` before dispatch
  - Wrap handler in try/catch: caught errors -> `{ content: error.message, is_error: true }`
- [ ] Implement character-based truncation:
  - `truncateForModel(text: string, limit: number)` -> string
  - If `text.length <= limit`, return as-is
  - Otherwise: take first `limit * 0.8` chars as head, last `limit * 0.2` chars as tail
  - Insert `\n\n[... truncated ${omitted} characters ...]\n\n` between head and tail
  - Secondary pass: if result is still a single enormous line, apply line-based splitting
- [ ] Per-tool default model-visible limits: read_file 50K, shell 30K, grep 20K, glob 10K, write_file 1K (just confirmation), edit_file 5K
- [ ] Tests: path escape rejection (../../etc/passwd, symlinks), env filtering, truncation boundary conditions, registry validation errors

### Phase 2: Core Tools (~25%)

**Files:** `src/agent-loop/tools/read-file.ts`, `src/agent-loop/tools/write-file.ts`, `src/agent-loop/tools/edit-file.ts`, `src/agent-loop/tools/shell.ts`, `src/agent-loop/tools/grep.ts`, `src/agent-loop/tools/glob.ts`, `test/agent-loop/tools/*.test.ts`

**Tasks:**
- [ ] `read_file(path, offset?, limit?)`:
  - Resolve path through environment
  - Read file content
  - Detect binary files via null-byte check in first 8KB; return error if binary
  - Apply optional line offset and limit
  - Return line-numbered text (`  1\tline content`)
  - Error if file doesn't exist
  - Schema: `{ path: string (required), offset: integer (optional, min 1), limit: integer (optional, min 1) }`

- [ ] `write_file(path, content)`:
  - Resolve path through environment
  - Create parent directories if needed
  - Write content to file
  - Return confirmation with byte count
  - Schema: `{ path: string (required), content: string (required) }`

- [ ] `edit_file(path, old_string, new_string)`:
  - Resolve path through environment
  - Read current file content
  - Literal string match (not regex) for `old_string`
  - If zero matches, return error: "old_string not found in file — did the content change? Try read_file first"
  - If multiple matches, return error with match count and line numbers: "found N matches for old_string at lines X, Y, Z — provide more context to make the match unique"
  - If exactly one match, replace and write
  - Return diff-style summary showing changed region
  - Schema: `{ path: string (required), old_string: string (required), new_string: string (required) }`

- [ ] `shell(command, timeout_ms?)`:
  - Execute via environment's `exec()`
  - Default timeout from session config (120s)
  - Return formatted output: `Exit code: N\n\nSTDOUT:\n...\n\nSTDERR:\n...`
  - On timeout: return `Command timed out after ${ms}ms` as error result
  - Schema: `{ command: string (required), timeout_ms: integer (optional, min 1000, max 600000) }`

- [ ] `grep(pattern, path?, include?, max_results?)`:
  - In-process implementation using Node.js `fs` and regex
  - Search workspace recursively from `path` (default: workspace root)
  - Optional `include` glob filter (e.g., `"*.ts"`)
  - Respect `.gitignore` patterns (use the `ignore` npm package for robust parsing)
  - Return: `file:line:content` format, capped at max_results (default 200)
  - Schema: `{ pattern: string (required), path: string (optional), include: string (optional), max_results: integer (optional, default 200) }`

- [ ] `glob(pattern, max_results?)`:
  - In-process implementation
  - Return workspace-relative paths, sorted by path
  - Respect `.gitignore` patterns
  - Capped at max_results (default 200)
  - Schema: `{ pattern: string (required), max_results: integer (optional, default 200) }`

- [ ] Tests per tool: happy path, error cases, path escape, binary file detection, timeout behavior

### Phase 3: Provider Profiles and Project Instructions (~15%)

**Files:** `src/agent-loop/provider-profiles.ts`, `src/agent-loop/project-instructions.ts`, `test/agent-loop/provider-profiles.test.ts`, `test/agent-loop/project-instructions.test.ts`

**Tasks:**
- [ ] Define `ProviderProfile` interface:
  - `name: string` — provider identifier
  - `systemPrompt(context: ProfileContext): string` — returns the full system prompt
  - `defaultModel?: string` — fallback model when node doesn't specify one
- [ ] `ProfileContext` includes: workspace_root, project_instructions (discovered text), tool_names (registered tools), node_prompt (the user task)
- [ ] Implement `AnthropicProfile`:
  - System prompt: role framing, capabilities list, tool usage guidelines emphasizing exact-match edits, response format expectations
  - Default model: `claude-sonnet-4-20250514`
- [ ] Implement `OpenAIProfile`:
  - System prompt: similar role framing tuned to OpenAI's strengths, tool usage guidelines
  - Default model: `gpt-4o`
- [ ] Implement `GeminiProfile`:
  - System prompt: tuned for Gemini's function-calling patterns
  - Default model: `gemini-2.5-pro`
  - Note: if the Gemini adapter does not yet exist in `src/llm/adapters/`, this profile serves as forward-compatible preparation. The sprint does not include implementing the Gemini adapter itself.
- [ ] Profile selection: match on `node.llm_provider` attribute -> corresponding profile; fallback to Anthropic profile for the default provider
- [ ] Implement project instruction discovery:
  - Walk from workspace root upward (stop at filesystem root)
  - Always look for `AGENTS.md`
  - Based on provider: also look for `CLAUDE.md` (anthropic), `GEMINI.md` (gemini), `.codex/instructions.md` (openai)
  - Concatenate discovered files, most-specific first
  - Apply 32KB budget: if total exceeds budget, truncate least-specific files first (generic `AGENTS.md` gets cut before provider-specific file)
  - Return concatenated text with file-boundary markers
- [ ] Tests: profile selection, instruction file discovery with mock filesystem, budget truncation

### Phase 4: Agent Session Loop and Loop Detection (~20%)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/events.ts`, `src/agent-loop/loop-detection.ts`, `test/agent-loop/session.test.ts`, `test/agent-loop/loop-detection.test.ts`, `test/helpers/scripted-adapter.ts`

**Tasks:**
- [ ] Create a `ScriptedAdapter` test helper: a deterministic fake `ProviderAdapter` that yields pre-programmed sequences of assistant text and tool calls. This is the foundation for all session tests — no real LLM calls.
- [ ] Implement `AgentSession`:
  - Constructor: `(client: UnifiedClient, registry: ToolRegistry, profile: ProviderProfile, env: ExecutionEnvironment, config: SessionConfig)`
  - `processInput(prompt: string): Promise<SessionResult>`
  - Build initial messages: system prompt (from profile with project instructions) + user message (prompt)
  - Main loop iteration:
    1. Call `client.stream()` with current messages
    2. Accumulate assistant response (text + tool calls) from stream events
    3. If `stop_reason === 'end_turn'` or `stop_reason === 'max_tokens'`: break — session complete
    4. If `stop_reason === 'tool_use'`: execute each tool call sequentially via registry
    5. Truncate tool results, append tool_result messages
    6. Check turn limit — if exceeded, fail with `turn_limit_exceeded`
    7. Check loop detection — if triggered, fail with `loop_detected`
    8. Continue to next iteration
  - `abort()`: set abort flag, propagate to active stream and active tool execution
  - Aggregate `Usage` across all turns
- [ ] Parse node attributes for session config:
  - `agent.max_turns` (overrides default 12)
  - `agent.max_tool_rounds` (overrides default 10)
  - `agent.command_timeout_ms` (overrides default 120_000)
  - `llm_provider`, `llm_model`, `reasoning_effort`
- [ ] Implement `AgentEvent` discriminated union:
  - `agent_session_started`: { node_id, provider, model }
  - `agent_turn_started`: { turn_number }
  - `agent_text_delta`: { text } (for streaming visibility)
  - `agent_tool_call_started`: { call_id, tool_name, arguments }
  - `agent_tool_call_completed`: { call_id, tool_name, duration_ms, is_error }
  - `agent_loop_detected`: { fingerprint, repetitions }
  - `agent_session_completed`: { status, turn_count, tool_call_count, duration_ms }
- [ ] Session accepts an `onEvent` callback for event emission
- [ ] Implement loop detection:
  - After each tool-execution round, compute a fingerprint: `hash(tool_calls.map(c => c.name + c.arguments).join('|'))`
  - Track last N fingerprints (N=5)
  - If the same fingerprint appears 3 consecutive times AND no file was successfully mutated (written/edited) during those rounds: trigger loop detection
  - The "no mutation" check prevents false positives on legitimate retry patterns (e.g., edit -> test -> edit -> test)
- [ ] Tests:
  - Single-turn completion (no tools)
  - Multi-turn with tools -> success
  - Turn limit enforcement
  - Tool round limit enforcement
  - Tool error -> model recovery -> success
  - Loop detection fires on 3 identical rounds
  - Loop detection does NOT fire when files are being mutated
  - Abort mid-stream
  - Abort mid-tool-execution
  - Usage aggregation across turns

### Phase 5: Codergen Integration, Artifacts, and CLI (~15%)

**Files:** `src/agent-loop/transcript.ts`, `src/handlers/codergen.ts`, `src/engine/types.ts`, `src/engine/events.ts`, `src/engine/engine.ts`, `src/cli/ui/renderer.ts`, `test/handlers/codergen.test.ts`, `test/integration/agent-loop.test.ts`

**Tasks:**
- [ ] Implement `TranscriptWriter`:
  - `writeToolCall(index, name, request, result, fullResult?)` — writes to `tool-calls/<NNN>-<name>/`
  - `appendTranscript(entry)` — appends JSONL line to `transcript.jsonl`
  - `writeResponse(text)` — writes `response.md`
  - `writeStatus(result)` — writes extended `status.json`
- [ ] Update codergen handler to use `AgentSession`:
  - Create `LocalExecutionEnvironment` with workspace root from handler input
  - Create `ToolRegistry` with all 6 core tools
  - Select `ProviderProfile` based on `node.llm_provider` (or default)
  - Load project instructions
  - Create `AgentSession` with the above
  - Expand `$goal` in prompt, inject execution context snapshot as system context
  - Call `session.processInput(prompt)`
  - Wire session events to transcript writer and engine event bridge
  - Map `SessionResult` to `NodeOutcome`: success -> success, failure -> retry (let engine handle), aborted -> failure
- [ ] Extend `HandlerExecutionInput` with `workspace_root: string` and `emitEvent: (event: RunEvent) => void`
- [ ] Engine passes `process.cwd()` as default workspace root (configurable via `--workspace` CLI flag or `POLLINATOR_WORKSPACE` env var) and an event bridge into handler input
- [ ] Add agent event variants to `RunEvent`:
  - `agent_session_started`, `agent_tool_called`, `agent_tool_completed`, `agent_loop_detected`, `agent_session_completed`
- [ ] Update CLI renderer for agent events:
  - `agent_session_started`: `Agent session started (provider, model)`
  - `agent_tool_called`: `  tool_name(args_summary)` (indented, concise)
  - `agent_tool_completed`: `  tool_name (Xs)` or `  tool_name: error`
  - `agent_loop_detected`: `  Loop detected — aborting session`
  - `agent_session_completed`: `Agent finished: N turns, M tool calls (Xs)`
  - When piped (no TTY): suppress agent_text_delta, keep tool summaries as plain text
- [ ] Extended `status.json` fields: provider, model, turn_count, tool_call_count, stop_reason, agent_duration_ms
- [ ] Add `ajv` and `ignore` to `package.json` dependencies
- [ ] Integration test: run a garden with a codergen node against a fixture workspace using the ScriptedAdapter. Verify the agent reads a file, edits it, runs a command, and completes. Verify all artifacts are written.
- [ ] Integration test: abort during shell execution, verify clean shutdown and partial artifact preservation.

---

## Priority Tiers

Given the scope (17+ new files, 6 modified files), a tiered approach reduces delivery risk:

**Tier 1 — Must Ship:**
- AgentSession core loop with processInput(), abort(), turn limits
- ToolRegistry with JSON Schema validation
- 4 core tools: `read_file`, `write_file`, `edit_file`, `shell`
- LocalExecutionEnvironment with workspace sandboxing and env filtering
- Truncation (head/tail character-based)
- Codergen handler integration

**Tier 2 — Should Ship:**
- `grep` and `glob` tools (with `.gitignore` support)
- Provider profiles (Anthropic, OpenAI, Gemini)
- Project instruction discovery and budgeting
- Loop detection
- Agent events and CLI rendering

**Tier 3 — Stretch:**
- Full artifact system (`transcript.jsonl`, per-tool artifact files)
- Abort integration test
- Binary file detection in `read_file`

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add `ajv` for JSON Schema validation, `ignore` for .gitignore parsing |
| `src/agent-loop/types.ts` | Create | SessionConfig, SessionResult, ToolCallEnvelope, ToolResultEnvelope |
| `src/agent-loop/events.ts` | Create | AgentEvent discriminated union |
| `src/agent-loop/session.ts` | Create | Core bounded processInput() loop |
| `src/agent-loop/tool-registry.ts` | Create | Tool schema validation, dispatch, error wrapping |
| `src/agent-loop/execution-environment.ts` | Create | ExecutionEnvironment + LocalExecutionEnvironment |
| `src/agent-loop/provider-profiles.ts` | Create | Anthropic/OpenAI/Gemini system prompt profiles |
| `src/agent-loop/project-instructions.ts` | Create | Instruction file discovery and budget enforcement |
| `src/agent-loop/truncation.ts` | Create | Head/tail character truncation |
| `src/agent-loop/loop-detection.ts` | Create | Fingerprint-based repeated-round detection |
| `src/agent-loop/transcript.ts` | Create | JSONL transcript and per-tool artifact writer |
| `src/agent-loop/tools/read-file.ts` | Create | File reading with line numbers, binary detection |
| `src/agent-loop/tools/write-file.ts` | Create | File writing with parent dir creation |
| `src/agent-loop/tools/edit-file.ts` | Create | Exact-match replacement with error diagnostics |
| `src/agent-loop/tools/shell.ts` | Create | Shell execution with timeout and env filtering |
| `src/agent-loop/tools/grep.ts` | Create | In-process regex search with .gitignore respect |
| `src/agent-loop/tools/glob.ts` | Create | In-process file matching with .gitignore respect |
| `src/handlers/codergen.ts` | Modify | Replace one-shot generation with AgentSession |
| `src/engine/types.ts` | Modify | Add workspace_root and emitEvent to HandlerExecutionInput |
| `src/engine/events.ts` | Modify | Add agent-session event variants |
| `src/engine/engine.ts` | Modify | Pass workspace root and event bridge into handlers |
| `src/cli/ui/renderer.ts` | Modify | Render agent progress events |
| `test/helpers/scripted-adapter.ts` | Create | Deterministic fake provider for agent tests |
| `test/agent-loop/tool-registry.test.ts` | Create | Registry validation, dispatch, error wrapping |
| `test/agent-loop/truncation.test.ts` | Create | Truncation boundary conditions |
| `test/agent-loop/session.test.ts` | Create | Loop, limits, abort, multi-turn |
| `test/agent-loop/loop-detection.test.ts` | Create | Fingerprinting and mutation tracking |
| `test/agent-loop/provider-profiles.test.ts` | Create | Profile selection and system prompt generation |
| `test/agent-loop/project-instructions.test.ts` | Create | Discovery and budget enforcement |
| `test/agent-loop/tools/*.test.ts` | Create | Per-tool unit tests |
| `test/handlers/codergen.test.ts` | Modify | Update for session-based execution |
| `test/integration/agent-loop.test.ts` | Create | End-to-end agent in a garden |
| `test/fixtures/agent-workspace/*` | Create | Small fixture repo for integration tests |

---

## Definition of Done

### Build & Tests
- [ ] `npm install && npm run build` succeeds on a clean checkout
- [ ] `npm test` passes all existing tests (no regressions) plus all new agent-loop tests
- [ ] All agent-loop tests use the ScriptedAdapter — zero real LLM calls in `npm test`

### Agent Session
- [ ] `AgentSession.processInput()` drives a multi-turn tool loop to completion
- [ ] A session with no tool calls completes successfully in a single turn
- [ ] `max_turns` limit triggers `turn_limit_exceeded` failure
- [ ] `max_tool_rounds_per_input` limit triggers failure
- [ ] `abort()` cancels active stream and active tool execution, preserves partial artifacts
- [ ] Usage is aggregated correctly across all turns

### Tools
- [ ] `read_file` returns line-numbered content with optional offset/limit
- [ ] `read_file` detects and rejects binary files
- [ ] `write_file` creates files with parent directories
- [ ] `edit_file` performs exact literal string match replacement on unique matches
- [ ] `edit_file` returns clear error with line numbers on zero or multiple matches
- [ ] `shell` executes commands with timeout and kills cleanly on timeout/abort
- [ ] `shell` filters sensitive environment variables (API keys, secrets, tokens, passwords)
- [ ] `grep` and `glob` work in-process without requiring external CLI tools
- [ ] `grep` and `glob` respect `.gitignore` patterns
- [ ] All tools reject paths outside workspace root, including symlink escapes

### Tool Output & Truncation
- [ ] Tool outputs exceeding per-tool limits are truncated with head/tail split and clear markers
- [ ] Full untruncated output is written to per-tool artifact files on disk
- [ ] Shell stdout and stderr are saved as separate `.log` files

### Provider Profiles & Instructions
- [ ] Three provider profiles (Anthropic, OpenAI, Gemini) with distinct system prompts
- [ ] Profile selection works from node `llm_provider` attribute
- [ ] Project instruction discovery finds provider-specific files
- [ ] Instruction content respects 32KB total budget with least-specific-first truncation

### Loop Detection
- [ ] 3 consecutive identical tool rounds with no file mutation -> `loop_detected` failure
- [ ] Legitimate patterns (edit -> test -> edit -> test) do NOT trigger false positives

### Artifacts & Observability
- [ ] Every codergen session writes `prompt.md`, `response.md`, `status.json`, `transcript.jsonl`
- [ ] Each tool call is persisted under `tool-calls/<NNN>-<name>/`
- [ ] `status.json` includes provider, model, turn_count, tool_call_count, stop_reason, timestamps
- [ ] CLI renderer shows concise agent progress in TTY mode
- [ ] Piped output remains clean (no streaming text deltas, just tool summaries)

### Codergen Integration
- [ ] Codergen handler creates a session with the correct provider, tools, and workspace root
- [ ] Session events bridge through to the pipeline engine's event system
- [ ] Session failure maps to `retry` status (engine can retry the node if max_retries allows)
- [ ] Session abort maps to `failure` status (no retry on abort)
- [ ] Existing pipelines without tool-calling codergen still work (simple prompt -> response)

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Models vary in tool-calling reliability across providers | Medium | High | One shared tool contract, one shared session core. Provider differences live only in system prompt profiles. Deterministic scripted-adapter tests ensure the loop logic works regardless of vendor. |
| Scope creeps into "full Claude Code parity" | High | High | Explicit, opinionated scope cuts: no steer/follow_up, no subagents, no remote environments, no provider-specific edit DSLs, no parallel tool execution. Ship the smallest complete local agent loop. Priority tiers ensure the core ships even if stretch items don't. |
| edit_file is too fragile for real use | Medium | Medium | Return helpful error messages with line numbers. Models can recover by re-reading the file. This is the same contract Claude Code uses. Literal string match (not regex) avoids regex-special-character issues. |
| Shell commands damage the repo | Medium | High | Same threat model as Makefile — user explicitly runs `pollinator run`. Workspace sandboxing prevents path escapes. Env filtering prevents secret leakage. |
| Shell output overwhelms context window | High | Medium | Strict per-tool truncation limits (30K chars for shell). Full output persisted to disk. Head/tail split preserves both the beginning (headers, errors) and end (results, summaries). |
| Loop detection false positives | Medium | Medium | Narrow rule: only fire after 3 identical consecutive fingerprints with NO successful file mutation. Track mutations explicitly. Persist fingerprints in transcript for debugging. |
| ajv + ignore dependencies add bloat | Low | Low | Both are mature, well-maintained, standard packages. The alternative (hand-rolled validation and gitignore parsing) is more error-prone. |
| Gemini adapter may not exist yet | Medium | Low | Gemini provider profile is implemented as forward-compatible preparation. If the adapter doesn't exist in `src/llm/adapters/`, the profile is ready for when it does. Sprint does not include implementing the adapter. |
| Mid-node resume is not supported | Medium | Medium | Documented as out of scope. Interrupted codergen nodes restart from scratch on resume. Artifact preservation means the user can see what happened before interruption. |
| TOCTOU in edit_file | Low | Low | Between read and write, another process could modify the file. Not critical for sequential-only execution. Worth noting for when parallel tool execution is added in a future sprint. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `src/llm/client.ts` (UnifiedClient) | Multi-provider streaming and tool calling | Exists (Sprint 005-006) |
| `execa` | Shell execution with signal handling | Exists (Sprint 001) |
| `ajv` | JSON Schema validation for tool arguments | **New runtime dependency** |
| `ignore` | .gitignore pattern parsing for grep/glob | **New runtime dependency** |
| `vitest` | Test framework | Exists |
| Node.js 22 | fs, path, realpath, AbortController, crypto | Exists |

No new HTTP client, database, or external service required. All agent-loop tests run offline via ScriptedAdapter.
