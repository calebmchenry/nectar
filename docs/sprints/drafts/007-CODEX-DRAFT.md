# Sprint 007: Coding Agent Loop — Core Local Sessions

## Overview

**Goal:** Turn `box` / `codergen` nodes from single-turn prompt wrappers into bounded local coding agents. After this sprint, a codergen node can inspect files, search the workspace, edit code, run commands, and iterate through tool calls until it reaches a natural completion or a hard turn limit.

**Why this sprint, why now:**

- The sprint-prioritization note in `docs/INTENT.md` is stale. The compliance report generated on **2026-03-19** shows `parallel` and `fan-in` are already implemented, so parallel execution is no longer the next critical-path gap.
- The highest-leverage remaining product gap is now the coding-agent loop. Nectar can parse and run complex gardens, and it has a real multi-provider LLM client, but `codergen` still behaves like a one-shot text generator with stubbed tool execution.
- This sprint closes the core of `GAP-40` and the practical codergen/tool-execution slice of `GAP-54` and `GAP-57` without pretending the full agent spec can be finished in one pass.

**Scope:**

- `AgentSession` with bounded multi-turn tool loop: `processInput()`, `abort()`, `max_turns`, `max_tool_rounds_per_input`
- Provider profiles for `openai`, `anthropic`, and `gemini`, all routed through the existing `UnifiedClient`
- Shared core tools: `read_file`, `write_file`, `edit_file`, `shell`, `grep`, `glob`
- `LocalExecutionEnvironment` with workspace-root path enforcement, timeout handling, and environment filtering
- Project instruction discovery: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.codex/instructions.md`, with a hard 32 KB budget
- Tool-output truncation for model context, with full untruncated output saved to disk
- Runaway-loop detection for repeated tool-call patterns
- Codergen integration, per-session artifacts, and minimal CLI visibility into agent activity

**Out of scope:**

- `steer()` and `follow_up()`
- Subagents: `spawn_agent`, `send_input`, `wait`, `close_agent`
- Remote execution environments: Docker, Kubernetes, WASM, SSH
- Provider-specific patch DSL parity with Claude Code, Codex CLI, and gemini-cli; this sprint uses one shared `edit_file` contract across all three profiles
- Parallel tool execution within a single model turn
- Mid-node session resume; interruption preserves artifacts, but resume still restarts the current codergen node
- Manager loop handler, model stylesheet, context fidelity, HTTP server, web UI, and seedbed work

---

## Use Cases

1. **Implement-fix-test inside one codergen node:** A pipeline reaches `implement` with prompt `"Fix the failing parser tests and stop when vitest passes."` The agent reads the failing files, edits them, runs `npm test -- test/garden/parse.test.ts`, and continues until it can return a final answer without more tool calls.

2. **Provider-specific project instructions:** A node sets `llm_provider="openai"`. The session loads `AGENTS.md` plus `.codex/instructions.md`, combines them with the OpenAI provider profile, and the agent follows repo-specific editing and testing instructions without hardcoding them into the garden prompt.

3. **Tool error recovery:** The model calls `edit_file` with an `old_string` that does not exist. The tool returns a structured error result to the model instead of crashing the node. The model can recover by reading the file again and trying a corrected edit.

4. **Large output stays debuggable but bounded:** The model runs `npm test` and the command prints 80 KB of output. The full stdout and stderr are written to disk under the node run directory, but only a truncated head/tail view is returned to the model so the session does not explode the context window.

5. **Abort behaves like engineering software, not a demo:** The user hits Ctrl+C while a long-running shell command is executing inside a codergen node. Nectar aborts the active model/tool loop, sends SIGTERM to the child process, escalates to SIGKILL if needed, writes partial artifacts, and checkpoints the pipeline cleanly.

6. **Runaway loop detection stops bad model behavior:** A model repeatedly issues the same `grep` and `read_file` sequence three turns in a row without changing any files. The session detects the repeated fingerprint, emits a loop-detected event, fails the node with a clear reason, and preserves the transcript for debugging.

---

## Architecture

### Module Layout

```text
nectar/
├── src/
│   ├── agent-loop/
│   │   ├── types.ts                    # Agent session config, results, tool result envelopes
│   │   ├── events.ts                   # AgentEvent union
│   │   ├── provider-profiles.ts        # openai / anthropic / gemini prompt profiles
│   │   ├── session.ts                  # Core processInput() loop
│   │   ├── tool-registry.ts            # ToolDefinition exposure + dispatch
│   │   ├── execution-environment.ts    # ExecutionEnvironment + LocalExecutionEnvironment
│   │   ├── project-instructions.ts     # AGENTS / CLAUDE / GEMINI / .codex discovery
│   │   ├── truncation.ts               # Head/tail truncation for model-visible tool output
│   │   ├── loop-detection.ts           # Repeated tool-pattern detection
│   │   ├── transcript.ts               # JSONL transcript + per-tool artifact writer
│   │   └── tools/
│   │       ├── read-file.ts
│   │       ├── write-file.ts
│   │       ├── edit-file.ts
│   │       ├── shell.ts
│   │       ├── grep.ts
│   │       └── glob.ts
│   ├── handlers/
│   │   └── codergen.ts                 # Switch from one-shot generation to AgentSession
│   ├── engine/
│   │   ├── types.ts                    # HandlerExecutionInput adds workspace_root + emit_event
│   │   ├── events.ts                   # Agent-session event variants
│   │   └── engine.ts                   # Pass event bridge + workspace root into handlers
│   └── cli/
│       └── ui/
│           └── renderer.ts             # Show concise agent progress in TTY mode
├── test/
│   ├── agent-loop/
│   │   ├── session.test.ts
│   │   ├── tool-registry.test.ts
│   │   ├── project-instructions.test.ts
│   │   ├── truncation.test.ts
│   │   └── loop-detection.test.ts
│   ├── helpers/
│   │   └── scripted-adapter.ts         # Deterministic fake provider for agent-loop tests
│   ├── handlers/
│   │   └── codergen.test.ts
│   └── integration/
│       └── agent-loop.test.ts
└── package.json
```

### Key Abstractions

**`AgentSession`** — Owns one bounded model/tool conversation for a codergen node. It builds the initial message set, streams model output, executes tool calls, appends tool results, enforces turn limits, and returns a terminal session result.

**`ProviderProfile`** — Supplies provider-specific system-prompt framing and defaults, but not a separate execution stack. All three providers share the same session core and the same six tools. That keeps the sprint finishable and behavior consistent.

**`ToolRegistry`** — Exposes tool schemas to the model and dispatches validated tool calls to concrete implementations. Tool calls are executed sequentially in declaration order for deterministic behavior.

**`ExecutionEnvironment`** — The abstraction between agent tools and the local machine. `LocalExecutionEnvironment` enforces the workspace root, resolves real paths to block `..` and symlink escapes, and runs shell commands with timeout and signal handling.

**`TranscriptWriter`** — Persists the session as structured artifacts under the node run directory. `response.md` contains the final assistant answer; `transcript.jsonl` contains the full turn-by-turn record; each tool call gets its own request/result files.

### Tool Contracts

This sprint is opinionated on tool behavior:

- `read_file(path, start_line?, end_line?)` returns line-numbered text.
- `write_file(path, content, overwrite=false)` creates a file by default and refuses silent overwrite.
- `edit_file(path, old_string, new_string)` performs an exact replacement. Zero matches or multiple matches is an error. There is no fuzzy patching in this sprint.
- `shell(command, cwd?, timeout_ms?)` runs inside the workspace root only, with a filtered environment and deterministic timeout behavior.
- `grep(pattern, include_glob?, max_results=200)` returns file, line, column, and matched text.
- `glob(pattern, max_results=200)` returns workspace-relative paths only.

### Artifact Layout

```text
<run_dir>/<node_id>/
├── prompt.md
├── response.md
├── status.json
├── transcript.jsonl
└── tool-calls/
    ├── 001-read_file/
    │   ├── request.json
    │   └── result.json
    └── 002-shell/
        ├── request.json
        ├── result.json
        ├── stdout.log
        └── stderr.log
```

### Data Flow

```text
PipelineEngine
   │
   ▼
CodergenHandler
   │
   ├── builds initial task from node prompt + execution context snapshot
   ├── loads project instruction bundle
   └── starts AgentSession
            │
            ▼
      UnifiedClient.stream()
            │
     assistant text / tool calls
            │
            ▼
       ToolRegistry.execute()
            │
            ▼
 LocalExecutionEnvironment
            │
   files / grep / shell / writes
            │
            ├── truncated result → model
            └── full result → transcript artifacts
```

---

## Implementation Phases

### Phase 1: Agent Session Core & Provider Profiles (~20%)

**Files:** `src/agent-loop/types.ts`, `src/agent-loop/events.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/session.ts`, `test/agent-loop/session.test.ts`, `test/helpers/scripted-adapter.ts`

**Tasks:**
- [ ] Define `AgentSessionOptions`, `AgentSessionResult`, `AgentToolCall`, `AgentTurn`, and structured tool-result envelopes.
- [ ] Implement `AgentSession.processInput()` as an iterative loop over model turns:
  - call `UnifiedClient.stream()`
  - accumulate assistant text and tool calls
  - stop on natural completion
  - execute tools when `stop_reason === 'tool_use'`
  - continue until completion or limits are reached
- [ ] Add `abort()` support so a session can stop an active model stream or active tool execution.
- [ ] Enforce hard defaults:
  - `max_turns = 12`
  - `max_tool_rounds_per_input = 8`
  - sequential tool execution only
- [ ] Add provider profiles for `openai`, `anthropic`, and `gemini`:
  - profile-specific system-prompt framing
  - default provider selection from node attributes or client default
  - shared tool contract across all profiles
- [ ] Parse these raw node attributes inside codergen/session config:
  - `llm_provider`
  - `llm_model`
  - `reasoning_effort`
  - `agent.max_turns`
  - `agent.max_tool_rounds`
  - `agent.command_timeout_ms`
- [ ] Emit `AgentEvent`s for session start, turn start, assistant delta, tool call start, tool call end, loop detected, session complete, and session failed.

### Phase 2: Tool Registry & Local Execution Environment (~30%)

**Files:** `src/agent-loop/tool-registry.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/tools/read-file.ts`, `src/agent-loop/tools/write-file.ts`, `src/agent-loop/tools/edit-file.ts`, `src/agent-loop/tools/shell.ts`, `src/agent-loop/tools/grep.ts`, `src/agent-loop/tools/glob.ts`, `test/agent-loop/tool-registry.test.ts`, `package.json`

**Tasks:**
- [ ] Define an `ExecutionEnvironment` interface that supports file IO, path resolution, directory walking, text search, and shell execution.
- [ ] Implement `LocalExecutionEnvironment`:
  - workspace-root sandboxing with `realpath()`
  - rejection of path escapes via `..` or symlink traversal
  - workspace-relative path normalization for all tool responses
- [ ] Add JSON Schema validation for tool arguments before execution.
- [ ] Implement `read_file` with optional line slicing and line-numbered output.
- [ ] Implement `write_file` with explicit overwrite guard.
- [ ] Implement `edit_file` with exact-match replacement and deterministic failure on zero or multiple matches.
- [ ] Implement `shell` via `execa`:
  - optional `cwd` constrained inside workspace root
  - default timeout from session config
  - SIGTERM then SIGKILL on timeout or abort
  - filtered environment that keeps `PATH`, `HOME`, `USER`, `TMPDIR`, `LANG`, `CI`, and `POLLINATOR_*`, while dropping obvious secret patterns like `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`
- [ ] Implement `grep` and `glob` in-process so the agent loop does not depend on external CLI tools being installed.
- [ ] Return structured tool errors to the model instead of throwing uncaught exceptions.

### Phase 3: Project Instructions, Truncation, and Loop Detection (~20%)

**Files:** `src/agent-loop/project-instructions.ts`, `src/agent-loop/truncation.ts`, `src/agent-loop/loop-detection.ts`, `test/agent-loop/project-instructions.test.ts`, `test/agent-loop/truncation.test.ts`, `test/agent-loop/loop-detection.test.ts`

**Tasks:**
- [ ] Discover project instruction files from the current workspace:
  - always consider `AGENTS.md`
  - then add the provider-specific file: `CLAUDE.md`, `GEMINI.md`, or `.codex/instructions.md`
  - stop at the workspace root
- [ ] Apply a strict 32 KB total budget to discovered instruction content, truncating least-specific content first.
- [ ] Build the initial instruction stack as:
  - base Nectar agent prompt
  - provider profile prompt
  - discovered project instructions
  - node prompt
- [ ] Implement primary character-based truncation with head/tail preservation and omitted-content markers.
- [ ] Implement secondary line-based truncation for degenerate single-line output.
- [ ] Set per-tool default model-visible limits:
  - `read_file`: 50,000 chars
  - `shell`: 30,000 chars
  - `grep`: 20,000 chars
  - `glob`: 10,000 chars
- [ ] Implement loop detection by fingerprinting each tool-execution round. If the same fingerprint repeats 3 consecutive times with no successful file mutation, fail the session with a clear loop-detected reason.

### Phase 4: Codergen Integration, Artifacts, and CLI Visibility (~15%)

**Files:** `src/agent-loop/transcript.ts`, `src/handlers/codergen.ts`, `src/engine/types.ts`, `src/engine/events.ts`, `src/engine/engine.ts`, `src/cli/ui/renderer.ts`, `test/handlers/codergen.test.ts`

**Tasks:**
- [ ] Replace the current codergen stub tool loop with `AgentSession`.
- [ ] Pass a compact execution-context snapshot into the initial task payload so the agent can see pipeline state without waiting for the future fidelity sprint.
- [ ] Preserve current codergen artifacts and add new ones:
  - `prompt.md`
  - `response.md`
  - `status.json`
  - `transcript.jsonl`
  - `tool-calls/<n>-<tool>/...`
- [ ] Update `status.json` so it includes:
  - terminal status
  - provider
  - model
  - turn count
  - tool call count
  - stop reason
  - timestamps
- [ ] Extend `HandlerExecutionInput` with `workspace_root` and an event bridge callback.
- [ ] Add engine-level event variants for high-value session visibility:
  - `agent_session_started`
  - `agent_turn_started`
  - `agent_tool_called`
  - `agent_tool_completed`
  - `agent_loop_detected`
  - `agent_session_completed`
- [ ] Update the CLI renderer to print concise agent progress in TTY mode without flooding piped output.

### Phase 5: Deterministic Tests & End-to-End Fixtures (~15%)

**Files:** `test/integration/agent-loop.test.ts`, `test/fixtures/agent-workspace/*`, `test/helpers/scripted-adapter.ts`, `test/agent-loop/*.test.ts`, `test/handlers/codergen.test.ts`

**Tasks:**
- [ ] Add a deterministic scripted provider adapter for tests that emits a known sequence of tool calls and a final assistant answer.
- [ ] Add unit tests for all six tools, including path escape rejection and structured error behavior.
- [ ] Add tests for instruction discovery order and budget trimming.
- [ ] Add tests for truncation markers and full-output artifact preservation.
- [ ] Add tests for loop detection on repeated `grep`/`read_file` rounds.
- [ ] Add codergen handler tests for:
  - multi-turn tool loop success
  - no-tool single-turn success
  - tool error recovery
  - provider-profile selection
- [ ] Add an integration test that runs a garden with a codergen node against a fixture workspace and verifies that the agent edits a file, runs a command, and exits successfully.
- [ ] Add an abort integration test that starts a long shell command, interrupts it, and verifies clean shutdown plus checkpoint preservation.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add JSON Schema validation dependency for tool arguments |
| `src/agent-loop/types.ts` | Create | Session config, results, and tool envelope types |
| `src/agent-loop/events.ts` | Create | `AgentEvent` discriminated union |
| `src/agent-loop/provider-profiles.ts` | Create | Provider prompt profiles for OpenAI, Anthropic, and Gemini |
| `src/agent-loop/session.ts` | Create | Core bounded model/tool loop |
| `src/agent-loop/tool-registry.ts` | Create | Tool exposure, validation, and dispatch |
| `src/agent-loop/execution-environment.ts` | Create | Workspace-rooted local execution environment |
| `src/agent-loop/project-instructions.ts` | Create | Discovery and budgeting of repo instruction files |
| `src/agent-loop/truncation.ts` | Create | Model-visible output truncation logic |
| `src/agent-loop/loop-detection.ts` | Create | Repeated tool-pattern detection |
| `src/agent-loop/transcript.ts` | Create | JSONL transcript and per-tool artifact writer |
| `src/agent-loop/tools/read-file.ts` | Create | File-reading tool implementation |
| `src/agent-loop/tools/write-file.ts` | Create | File-writing tool implementation |
| `src/agent-loop/tools/edit-file.ts` | Create | Exact-match edit tool implementation |
| `src/agent-loop/tools/shell.ts` | Create | Shell tool with timeout and env filtering |
| `src/agent-loop/tools/grep.ts` | Create | In-process text search tool |
| `src/agent-loop/tools/glob.ts` | Create | Workspace file-matching tool |
| `src/handlers/codergen.ts` | Modify | Replace one-shot generation with `AgentSession` |
| `src/engine/types.ts` | Modify | Add workspace root and event bridge to handler input |
| `src/engine/events.ts` | Modify | Add codergen-agent event variants |
| `src/engine/engine.ts` | Modify | Pass workspace root and session events into handlers |
| `src/cli/ui/renderer.ts` | Modify | Render concise agent progress lines |
| `test/helpers/scripted-adapter.ts` | Create | Deterministic fake provider for session tests |
| `test/agent-loop/session.test.ts` | Create | Core session loop tests |
| `test/agent-loop/tool-registry.test.ts` | Create | Tool validation and dispatch tests |
| `test/agent-loop/project-instructions.test.ts` | Create | Instruction discovery and budgeting tests |
| `test/agent-loop/truncation.test.ts` | Create | Truncation behavior tests |
| `test/agent-loop/loop-detection.test.ts` | Create | Loop detection tests |
| `test/handlers/codergen.test.ts` | Modify | Codergen tests for session-based execution |
| `test/integration/agent-loop.test.ts` | Create | End-to-end garden execution against a fixture workspace |
| `test/fixtures/agent-workspace/*` | Create | Small deterministic repo used by integration tests |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds on a clean checkout
- [ ] `npm test` passes with the new agent-loop unit and integration suites
- [ ] A codergen node can complete a deterministic multi-turn session that performs `read_file` → `edit_file` → `shell` → final answer
- [ ] A codergen node with no tool calls still completes successfully in a single turn
- [ ] `read_file`, `write_file`, `edit_file`, `shell`, `grep`, and `glob` all validate arguments and return structured error results on invalid input
- [ ] File tools reject paths outside the workspace root, including symlink-based escapes
- [ ] `write_file` refuses to overwrite an existing file unless `overwrite=true`
- [ ] `edit_file` fails deterministically when the target string matches zero or multiple times
- [ ] `shell` enforces timeout and kills subprocesses cleanly on timeout or abort
- [ ] `shell` filters obvious secret-bearing environment variables before process launch
- [ ] Tool outputs are truncated at per-tool limits for model context, and full outputs are still written to disk
- [ ] Project instruction discovery loads `AGENTS.md` plus the correct provider-specific instruction file within a 32 KB total budget
- [ ] Repeated identical tool rounds with no successful file mutation are detected and fail with a loop-detected reason after 3 repetitions
- [ ] Every codergen node writes `prompt.md`, `response.md`, `status.json`, `transcript.jsonl`, and per-tool artifacts under `tool-calls/`
- [ ] `status.json` includes provider, model, turn count, tool call count, stop reason, and timestamps
- [ ] Tool errors are returned to the model so the session can recover instead of aborting immediately
- [ ] `pollinator run` shows concise codergen-agent progress in TTY mode and remains plain-text when piped
- [ ] Ctrl+C during a codergen shell command aborts the session, preserves partial artifacts, and leaves the pipeline resumable from the current node
- [ ] OpenAI, Anthropic, and Gemini all use the same session core and tool registry, selected by provider profile rather than separate execution codepaths

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Models differ in tool-calling reliability across providers | Medium | High | Keep one shared tool contract and one shared session core. Put provider differences in prompt profiles only. Use deterministic scripted-adapter tests so the loop logic is not coupled to any single vendor. |
| Scope expands into “full Claude Code/Codex CLI parity” | High | High | Explicitly defer steer/follow_up, subagents, remote environments, provider-specific patch DSLs, and parallel tool execution. Ship the smallest complete local agent loop. |
| File-edit tools can damage the repo if they are too permissive | Medium | High | Enforce workspace-root sandboxing, exact-match `edit_file`, explicit overwrite guard on `write_file`, and structured errors on ambiguous edits. |
| Shell output overwhelms model context or logs | High | Medium | Return truncated head/tail output to the model, but always persist the full output in per-tool artifacts for debugging. |
| Long-running or hung subprocesses make abort/resume unreliable | Medium | High | Centralize command execution in `LocalExecutionEnvironment`, use default timeouts, propagate abort signals, and enforce SIGTERM then SIGKILL. |
| Loop detection is too aggressive or too weak | Medium | Medium | Use a narrow rule: only fail after 3 identical consecutive tool-round fingerprints with no successful file mutation. Persist fingerprints in the transcript for debugging. |
| Minimal CLI visibility is either too noisy or too sparse | Medium | Medium | Emit only high-value agent events in the renderer: turn start, tool start/end, loop detected, and session completion. Keep detailed output on disk, not in the terminal. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| `src/llm/client.ts` and provider adapters | Existing multi-provider model routing and tool-call streaming |
| `execa` | Existing subprocess execution layer for the `shell` tool |
| `ajv` | JSON Schema validation for tool arguments before dispatch |
| Node.js 22 | Abortable IO, filesystem primitives, path resolution, and process control |
| `vitest` | Deterministic unit and integration test coverage |

No new HTTP client, database, or background worker system is needed for this sprint.
