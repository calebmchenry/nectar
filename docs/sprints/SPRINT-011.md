# Sprint 011: Agent Control Plane & OpenAI Edit Parity

## Overview

**Goal:** Transform `AgentSession` from a stateless one-shot prompt runner into a controllable, observable subsystem with a real lifecycle, mid-task steering, follow-up queuing, and provider-appropriate editing tools. After this sprint, a codergen session can be redirected without losing context, can chain work items without reconstructing state, and gives OpenAI models their native `apply_patch` editing primitive instead of forcing exact-string replacement.

**Why this sprint, why now:**

The compliance report's only **high-severity** gaps are all in the coding agent loop:

| Gap | Severity | Description |
|-----|----------|-------------|
| C1 | **High** | `steer()` — no mid-task message injection |
| C4 | **High** | `apply_patch` — OpenAI's primary editing tool missing |
| C5 | **High** | Subagent tools — no delegation layer |

The correct sequencing is **not** to tackle all three at once. C5 (subagents) is a complex orchestration feature that depends on C1/C3 being stable — you cannot safely manage child sessions if the parent session lacks lifecycle state, steering, or clean follow-up semantics. Rushing subagents on top of a stateless session produces opaque background workers that are harder to debug and impossible to steer.

This sprint closes **C1, C2, C3, C4** and sweeps up 8 cheap medium/low-severity gaps that fall naturally out of the same work:

| Gap | Severity | Cost to close alongside |
|-----|----------|------------------------|
| C6 | Medium | Line-based truncation — 30 lines of code |
| C7 | Medium | Environment context block in system prompt |
| C8 | Medium | Git snapshot in system prompt |
| C10 | Medium | Full tool output on agent events |
| C11 | Low | Session lifecycle event metadata |
| C13 | Low | Default command timeout (10s, not 120s) |
| C14 | Low | Process kill delay (2s, not 5s) |
| L1 | Medium | `developer` role — needed for steer() semantics |

**Total: 2 HIGH + 5 MEDIUM + 3 LOW gaps closed in one sprint.**

C5 (subagents) becomes the obvious Sprint 012, building on a session that actually has state, steering, and provider-specific tool exposure. The Gemini draft's subagent use cases (parallel implementation + testing, `SubagentManager` concept) should inform Sprint 012's design, which must address: budget controls, deadlock prevention, artifact nesting, and failure surfacing.

**Out of scope:**
- C5 subagent tools (`spawn_agent`, `send_input`, `wait`, `close_agent`)
- A1 manager loop handler
- A5/A6 context fidelity runtime and thread resolution
- L5/L8/L9 structured output, middleware, model catalog
- HTTP server mode, web UI, seedbed analysis
- Mid-node codergen resume (interrupted agent sessions still restart the node)
- Fuzzy patch matching (strict parsing with descriptive errors only)
- Binary patch support

**Cut-line:** If the sprint runs long, Phase 4 (truncation/events/runtime hardening) can be deferred. The control plane (Phase 1), developer role + prompt context (Phase 2), and apply_patch (Phase 3) are the must-ship deliverables.

---

## Design Principles

1. **State before delegation.** Subagents are downstream of session control. This sprint makes the parent agent steerable and observable first.

2. **Provider-specific edit contracts are a feature, not a bug.** OpenAI/Codex is better with patches. Anthropic/Gemini are already wired around exact-match edits. Nectar exposes the right tool for each profile instead of flattening them into one lowest-common-denominator interface.

3. **Control actions happen at deterministic boundaries.** `steer()` does not interrupt an in-flight shell command or half-built stream. It is delivered only between model turns, immediately before the next LLM request.

4. **Strict, not fuzzy.** If patch context lines don't match, the tool call fails and returns a descriptive error. The model retries with corrected context. Fuzzy matching hides bugs and produces wrong edits.

5. **Full output is preserved once.** The model sees a bounded preview. Artifacts and agent-level events keep the full output. We do not make the model context pay for debugger needs.

---

## Use Cases

1. **Mid-task steering saves a runaway agent.** A codergen node is refactoring broadly when it should be fixing one test. The pipeline's future manager loop (or a human operator via the forthcoming HTTP API) calls `session.steer("Stop refactoring. Fix only the failing test in parser.test.ts and rerun it.")`. The message lands before the next LLM call as a `developer`-role message. The agent reads it, course-corrects, and finishes without losing its accumulated tool results and conversation history.

2. **Follow-up work chains without context loss.** A codergen node finishes implementing a feature. The caller immediately queues `session.followUp("Now run the test suite and fix any failures.")`. The session keeps its full conversation history — the model already knows what it just wrote — and starts the test-and-fix cycle without re-reading every file.

3. **OpenAI models edit files naturally.** A pipeline runs with `llm_provider="openai"`. The model needs to update 3 lines in a 500-line file. Instead of struggling with exact-string `edit_file` (which requires perfect whitespace matching), it emits:
   ```json
   { "patch": "*** Begin Patch\n*** Update File: src/config.ts\n@@\n-const MAX_RETRIES = 3;\n+const MAX_RETRIES = 5;\n*** End Patch" }
   ```
   Nectar validates every hunk, applies the patch transactionally, and returns a summary. If any hunk fails, zero files are modified.

4. **The model orients itself without burning tool calls.** The system prompt includes workspace root, platform, shell, current date, git branch, dirty file count, and recent commits. The model skips the `shell("pwd")`, `shell("git status")`, `shell("git log --oneline -5")` dance that wastes 3 tool rounds on every session start.

5. **Large tool output is bounded for the model but preserved for humans.** `grep` returns 2,000 matches. The model sees a preview capped at 20KB and 200 lines. The full output is written to `tool-calls/NNN-grep/full-result.txt` and attached to the agent event, so the HTTP server, transcript viewer, or debugger can inspect it without re-running the command.

6. **Session lifecycle is observable enough for future supervisors.** A caller can check `session.getState()` and see `PROCESSING`, `AWAITING_INPUT`, or `CLOSED`. Illegal operations (steering a closed session, submitting to a processing session) fail with clear errors. This is the foundation that Sprint 012's subagent manager will build on.

---

## Architecture

### Session State Machine

```text
IDLE
  |
  | submit/processInput
  v
PROCESSING
  |
  | natural completion with empty queue
  v
AWAITING_INPUT
  |                \
  | followUp/submit \ close
  v                  v
PROCESSING         CLOSED

PROCESSING -- abort/fatal error --> CLOSED
```

**State semantics:**
- `IDLE` — created, no work submitted. Only legal action: `submit()`.
- `PROCESSING` — executing a work item through the model/tool loop. Accepts `steer()`. Rejects new `submit()`.
- `AWAITING_INPUT` — conversation open, queue empty. Accepts `followUp()`, `submit()`, `close()`.
- `CLOSED` — terminal. Rejects everything.

**Key invariant:** `steer()` never interrupts an in-flight tool call or active stream. It is delivered at the turn boundary, immediately before the next `client.stream()` call. This makes the injection point deterministic and race-free.

### Public Session API

`AgentSession` becomes queue-backed. The public surface is:

- `processInput(prompt): Promise<SessionResult>` — Compatibility wrapper over `submit(prompt)`
- `submit(prompt): Promise<SessionResult>` — Enqueue a new top-level work item
- `followUp(prompt): Promise<SessionResult>` — Enqueue behind current item, reuse conversation
- `steer(message): void` — Push to steer queue; throw if not PROCESSING
- `getState(): SessionState`
- `close(): void`
- `abort(): void` — Transitions to CLOSED. Sends SIGTERM to any in-flight shell command, cancels active stream, and rejects the pending `SessionResult` promise with an `AbortError`. Does **not** wait for graceful shutdown of tool calls — the 2s SIGKILL escalation handles that. Returns void (fire-and-forget); the caller awaits the rejected promise from `submit()`/`followUp()` to know when cleanup is complete.

Internally, `AgentSession` owns:
- `conversation: Message[]`
- `pendingInputs: SessionWorkItem[]`
- `pendingSteers: string[]`
- `activeItem?: SessionWorkItem`
- `state: SessionState`

### Conversation Persistence & Limits

Today `processInput()` creates a throwaway `messages` array per call. This sprint moves conversation history onto the `AgentSession` instance so follow-ups can build on prior context.

**Known limitation:** Conversation history can grow unbounded across follow-ups. After many follow-ups with heavy tool usage, the message array may approach the model's context window limit. This sprint adds a configurable `max_follow_ups` (default: 10) to prevent unbounded work chains from programmatic callers. Full context management (sliding window, summarization) is deferred to a future sprint and noted in the risks table.

### Steering and Follow-Up Delivery

**`steer()`**
- Valid only while `state === PROCESSING`
- Serialized as a `developer` role message, not as user text
- If multiple `steer()` calls arrive between model turns, all messages are injected in order (FIFO)
- Injected immediately before the next `client.stream()` call
- Recorded in `transcript.jsonl` as a control entry
- Not allowed to interrupt an in-flight tool call or active stream

**`followUp()`**
- Enqueues a new user work item behind the current item
- Reuses the same conversation transcript and tool history
- Returns a promise for that specific follow-up result
- If the session is `AWAITING_INPUT`, it starts immediately
- If the session is `CLOSED`, it rejects

### `developer` Role for Steering

Steering messages must be distinguishable from user prompts. This sprint adds `'developer'` to the unified `Role` type and updates each adapter:

| Provider | Handling |
|----------|----------|
| OpenAI | Native `developer` role — pass through unchanged |
| Anthropic | Accumulate all pending `developer` messages and append them as the **last entries** in the `system` array on the next request. This preserves their temporal ordering relative to each other while acknowledging that Anthropic's system block is position-insensitive relative to conversation turns. Adapter tests must assert exact payload shape for multi-steer scenarios. |
| Gemini | Fold into `systemInstruction` content, appended after base system content |

### Provider-Specific Tool Exposure

`ProviderProfile` gains a `visibleTools` allowlist. The tool registry stays the single source of implementations, but each profile chooses what the model sees:

| Profile | Editing tool | Other tools |
|---------|-------------|-------------|
| OpenAI | `apply_patch` | `read_file`, `write_file`, `shell`, `grep`, `glob` |
| Anthropic | `edit_file` | `read_file`, `write_file`, `shell`, `grep`, `glob` |
| Gemini | `edit_file` | `read_file`, `write_file`, `shell`, `grep`, `glob` |

`apply_patch` is marked as `mutating` in the tool safety map, so it stays sequential relative to writes and shells when a model emits multiple tool calls in one turn.

### Patch Application Pipeline

```text
tool call { patch: string }
    |
    v
parsePatchV4A(patch)  →  PatchOperation[]
    |                     (Add, Update, Delete, Move + hunks)
    v
validateOperations()
    ├─ grammar correctness
    ├─ all paths within workspace root
    ├─ source files exist for Update/Delete/Move
    ├─ target paths legal for Add/Move
    ├─ hunk context lines match file content
    └─ Add File rejects if target already exists (no implicit overwrite)
    |
    v
stageInMemory()       →  Map<path, content>
    |
    v
commitWrites()        →  atomic: all succeed or none do
    |
    v
return summary + persist patch artifact
```

**Line-ending handling:** The parser normalizes all input to `\n` before parsing. When writing output, the target file's existing line-ending style is detected and preserved. New files (Add) use the platform default.

### Prompt Composition

The provider system prompt becomes four blocks composed in order:

1. **Provider base instructions** — existing per-provider guidance
2. **Environment context block** — platform, shell, workspace root, date/time, provider/model, visible tool names
3. **Git snapshot block** — branch, staged/unstaged/untracked counts, last 3 commits (best-effort; omitted if not a git repo)
4. **Project instructions** — AGENTS.md / CLAUDE.md / GEMINI.md / .codex/instructions.md (existing)

Git snapshot uses bounded-timeout commands (each `git` command gets an independent 2s timeout). If `git` is unavailable or the workspace isn't a repo, the block is silently omitted.

### Truncation: Two-Pass Model

Keep existing head/tail character truncation, then apply a line cap for high-volume tools:

| Tool | Character cap | Line cap |
|------|------------:|--------:|
| `shell` | 30,000 | 256 |
| `grep` | 20,000 | 200 |
| `glob` | 10,000 | 500 |
| `read_file` | 50,000 | — |
| `write_file` | 1,000 | — |
| `edit_file` | 5,000 | — |
| `apply_patch` | 5,000 | — |

Full untruncated output is preserved in artifacts and on agent-level events. Engine-level events carry only a preview and an artifact path.

### Event and Artifact Model

- `agent_session_started` — add `session_id`, `workspace_root`, `state`
- `agent_tool_call_completed` — add `content_preview`, `full_content`, `truncated`, `artifact_path`
- `agent_session_completed` — add `session_id`, `final_state`

Engine-level `RunEvent` bridging stays slimmer: preview metadata and artifact paths only, no megabyte payloads.

Artifacts under the node run directory:

```text
<run_dir>/<node_id>/
├── prompt.md
├── response.md
├── status.json
├── transcript.jsonl
└── tool-calls/
    ├── 001-apply_patch/
    │   ├── request.json
    │   ├── patch.txt
    │   ├── result.json
    │   └── full-result.txt
    └── ...
```

### Module Layout — New and Modified Files

```text
src/agent-loop/
├── types.ts                  MODIFY — SessionState, WorkItem, tool safety for apply_patch
├── session.ts                MODIFY — state machine, queues, persistent conversation
├── events.ts                 MODIFY — richer lifecycle metadata, full output fields
├── provider-profiles.ts      MODIFY — visible tool lists, prompt composition, timeout defaults
├── environment-context.ts    CREATE — environment + git snapshot block builder
├── patch.ts                  CREATE — v4a parser and transactional applicator
├── tool-registry.ts          MODIFY — provider-filtered tool definitions
├── truncation.ts             MODIFY — add line-based second pass
├── transcript.ts             MODIFY — persist steering/follow-up actions, full outputs
├── execution-environment.ts  MODIFY — patch filesystem ops, 2s kill delay
└── tools/
    └── apply-patch.ts        CREATE — tool schema and handler wrapper

src/llm/
├── types.ts                  MODIFY — add 'developer' to Role
└── adapters/
    ├── openai.ts             MODIFY — preserve developer role
    ├── anthropic.ts          MODIFY — fold developer into system
    └── gemini.ts             MODIFY — fold developer into systemInstruction

src/handlers/
└── codergen.ts               MODIFY — register apply_patch, provider-specific tool exposure

src/engine/
└── events.ts                 MODIFY — preview metadata + artifact paths on bridged events
```

---

## Implementation

### Phase 1: Session State Machine & Control Queues (~25%)

**Files:** `src/agent-loop/types.ts`, `src/agent-loop/session.ts`, `src/agent-loop/events.ts`, `test/agent-loop/session-control.test.ts`

**Tasks:**
- [ ] Define `SessionState = 'IDLE' | 'PROCESSING' | 'AWAITING_INPUT' | 'CLOSED'`
- [ ] Define `WorkItem = { prompt: string; resolve: (r: SessionResult) => void; reject: (e: Error) => void }`
- [ ] Move `messages` array from local variable in `processInput()` to `AgentSession.conversation` instance field
- [ ] Add internal queues: `pendingInputs: WorkItem[]`, `pendingSteers: string[]`
- [ ] Implement `submit(prompt): Promise<SessionResult>` — enqueue work item, start processing if IDLE/AWAITING_INPUT
- [ ] Implement `followUp(prompt): Promise<SessionResult>` — enqueue behind current item, reuse conversation
- [ ] Implement `steer(message): void` — push to steer queue; throw if not PROCESSING
- [ ] Implement `getState(): SessionState` and `close(): void`
- [ ] Implement `abort(): void` — transition to CLOSED, SIGTERM in-flight shell, cancel stream, reject pending promise with `AbortError`
- [ ] Add configurable `max_follow_ups` (default: 10); reject with descriptive error when exceeded
- [ ] Keep `processInput()` as compatibility wrapper: `return this.submit(prompt)`
- [ ] In the core loop, drain `pendingSteers` as `developer`-role messages (FIFO order) before each `client.stream()` call
- [ ] Emit `agent_session_started` with `session_id`, `workspace_root`, `state`
- [ ] Emit `agent_session_completed` with `session_id`, `final_state`
- [ ] Reject illegal transitions with clear error messages (e.g., "Cannot steer a session in AWAITING_INPUT state")
- [ ] Tests: state transitions through all legal paths, steer delivery timing, multiple steers injected in order, follow-up reuses conversation, follow-up count limit enforced, abort rejects pending promise, illegal actions rejected, single-input regression (existing behavior unchanged)

### Phase 2: `developer` Role & Prompt Context (~15%)

**Files:** `src/llm/types.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `src/agent-loop/environment-context.ts`, `src/agent-loop/provider-profiles.ts`, `test/llm/adapters/*.test.ts`, `test/agent-loop/environment-context.test.ts`

**Tasks:**
- [ ] Add `'developer'` to the `Role` union type in `src/llm/types.ts`
- [ ] OpenAI adapter: pass `developer`-role messages through unchanged
- [ ] Anthropic adapter: accumulate `developer` messages, append as last entries in `system` array on next request, preserving FIFO order among themselves
- [ ] Gemini adapter: fold `developer` messages into `systemInstruction`
- [ ] Create `buildEnvironmentContext(opts): string` in `environment-context.ts`:
  - Platform, architecture, shell
  - Workspace root (absolute path)
  - Current local date/time (ISO 8601)
  - Provider name and model ID
  - Visible tool names for this profile
- [ ] Create `buildGitSnapshot(workspaceRoot): Promise<string | null>`:
  - Current branch (or `detached HEAD`)
  - Counts: staged, unstaged, untracked files
  - Last 3 commits as `sha7 subject`
  - Each git command bounded to an independent 2s timeout
  - Return `null` if not a git repo or git unavailable
- [ ] Compose system prompt: base instructions + environment context + git snapshot + project instructions
- [ ] Add provider-level `default_command_timeout_ms` field so Anthropic can keep 120s without forcing it on every profile
- [ ] Tests: developer role reaches each adapter correctly (including multi-steer payload shape), system prompt contains environment/git blocks inside a git repo, non-git workspace produces no error

### Phase 3: `apply_patch` Tool (~30%)

**Files:** `src/agent-loop/patch.ts`, `src/agent-loop/tools/apply-patch.ts`, `src/agent-loop/tool-registry.ts`, `src/agent-loop/types.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/provider-profiles.ts`, `src/handlers/codergen.ts`, `test/agent-loop/patch.test.ts`, `test/agent-loop/apply-patch-integration.test.ts`

**Tasks:**
- [ ] Create `parsePatchV4A(raw: string): PatchOperation[]` in `src/agent-loop/patch.ts`:
  - Parse `*** Begin Patch` / `*** End Patch` envelope
  - Support operations: `*** Add File: <path>`, `*** Delete File: <path>`, `*** Update File: <path>`, `*** Move to: <path>` (on Update)
  - Parse hunk headers (`@@`) and context/add/remove lines (`-`/`+`/` ` prefix)
  - Normalize all input to `\n` before parsing; preserve target file's line endings on write
  - Strict grammar: reject malformed input with descriptive errors
- [ ] Create `applyParsedPatch(ops: PatchOperation[], env: ExecutionEnvironment): Promise<PatchResult>`:
  - Validate all paths within workspace root (path traversal prevention)
  - For Update: read file, locate context, verify match, compute result
  - For Add: verify target doesn't exist (reject on conflict — no implicit overwrite)
  - For Delete: verify file exists
  - For Move: verify source exists, target doesn't
  - Stage all mutations in memory first
  - Commit writes/deletes/moves only if all hunks validate — atomic per tool call
- [ ] Extend `ExecutionEnvironment` interface: `deleteFile(path)`, `renameFile(src, dst)`, `fileExists(path)`
- [ ] Implement these in `LocalExecutionEnvironment` with workspace boundary checks
- [ ] Create `apply-patch.ts` tool wrapper: JSON schema `{ patch: string }`, calls parser + applicator, returns summary
- [ ] Register `apply_patch` in tool registry, mark as `mutating` in safety classification
- [ ] Update `ProviderProfile` to expose `visibleTools` allowlist; OpenAI sees `apply_patch`, not `edit_file`
- [ ] Update `CodergenHandler` to pass provider-filtered tool definitions
- [ ] Persist raw patch text as `tool-calls/NNN-apply_patch/patch.txt` artifact
- [ ] Tests:
  - Single-file update with context verification
  - Add new file
  - Add file that already exists → rejected
  - Delete existing file
  - Move/rename file
  - Multi-file patch (add + update + delete in one call)
  - Context mismatch → descriptive error, zero files modified
  - Path traversal (`../../etc/passwd`) → rejected
  - Malformed grammar → rejected with parse error details
  - Empty patch → rejected
  - Mixed line endings (`\r\n` input, `\n` target) handled correctly
  - OpenAI profile exposes `apply_patch`, not `edit_file`
  - Anthropic/Gemini profiles still expose `edit_file`

### Phase 4: Events, Truncation & Runtime Hardening (~20%)

**Files:** `src/agent-loop/truncation.ts`, `src/agent-loop/transcript.ts`, `src/agent-loop/events.ts`, `src/agent-loop/execution-environment.ts`, `src/engine/events.ts`, `test/agent-loop/truncation.test.ts`, `test/agent-loop/events.test.ts`

**Tasks:**
- [ ] Implement `truncateToolOutput(toolName: string, raw: string): { preview: string; truncated: boolean }`:
  - First pass: existing head/tail character truncation per tool
  - Second pass: if tool is `shell`/`grep`/`glob`, apply line cap (256/200/500)
  - Return both preview and truncation flag
- [ ] Extend `agent_tool_call_completed` event: add `content_preview`, `full_content`, `truncated`, `artifact_path`
- [ ] Engine-level bridged events carry preview + artifact path only (no megabyte payloads)
- [ ] Extend `TranscriptWriter`: persist steering actions, follow-up boundaries, full tool outputs, and raw patch texts in `tool-calls/` directories
- [ ] Record steering messages in `transcript.jsonl` as `{ type: 'steer', content: '...' }`
- [ ] Change `DEFAULT_SESSION_CONFIG.default_command_timeout_ms` from `120_000` to `10_000`
- [ ] Add `command_timeout_ms` to `ProviderProfile` so Anthropic can override to 120s
- [ ] Change `LocalExecutionEnvironment.exec()` SIGKILL escalation from 5000ms to 2000ms
- [ ] Expand `status.json` to include `session_state`, `provider`, `model`, `work_items_processed`
- [ ] Tests: character + line truncation for each tool, full output preserved in artifacts, timeout/kill delay values, event metadata shape

### Phase 5: Integration & Regression (~10%)

**Files:** `test/integration/agent-loop.test.ts`, `test/handlers/codergen.test.ts`, `test/agent-loop/session.test.ts`

**Tasks:**
- [ ] Integration test: steer message injected between tool rounds, visible in transcript
- [ ] Integration test: follow-up runs after initial task without new session, conversation state preserved
- [ ] Integration test: OpenAI profile end-to-end through CodergenHandler using `apply_patch`
- [ ] Regression test: Anthropic profile still uses `edit_file` through CodergenHandler
- [ ] Regression test: existing single-input `processInput()` behavior unchanged
- [ ] Regression test: git snapshot omission in non-repo workspace
- [ ] Regression test: full tool output written even when model preview is truncated
- [ ] Regression test: abort() during PROCESSING rejects pending promise, cleans up
- [ ] Run full existing test suite — zero regressions

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/types.ts` | Modify | `SessionState`, `WorkItem`, tool safety for `apply_patch`, timeout defaults |
| `src/agent-loop/session.ts` | Modify | State machine, queues, persistent conversation, `submit`/`followUp`/`steer`/`abort` |
| `src/agent-loop/events.ts` | Modify | Richer lifecycle metadata, full-output fields on tool events |
| `src/agent-loop/environment-context.ts` | Create | Environment block + git snapshot builder |
| `src/agent-loop/patch.ts` | Create | v4a patch parser and transactional applicator |
| `src/agent-loop/tools/apply-patch.ts` | Create | Tool schema and handler wrapper |
| `src/agent-loop/tool-registry.ts` | Modify | Provider-filtered tool definitions |
| `src/agent-loop/truncation.ts` | Modify | Line-based second pass on top of character caps |
| `src/agent-loop/transcript.ts` | Modify | Persist steering/follow-up actions, full outputs, patch artifacts |
| `src/agent-loop/execution-environment.ts` | Modify | `deleteFile`, `renameFile`, `fileExists`; 2s kill delay |
| `src/agent-loop/provider-profiles.ts` | Modify | Visible tool lists, prompt composition, timeout defaults |
| `src/llm/types.ts` | Modify | Add `'developer'` to `Role` |
| `src/llm/adapters/openai.ts` | Modify | Preserve `developer` messages natively |
| `src/llm/adapters/anthropic.ts` | Modify | Fold `developer` into system prompt |
| `src/llm/adapters/gemini.ts` | Modify | Fold `developer` into `systemInstruction` |
| `src/handlers/codergen.ts` | Modify | Register `apply_patch`, provider-specific tool exposure |
| `src/engine/events.ts` | Modify | Preview metadata + artifact paths on bridged events |
| `test/helpers/scripted-adapter.ts` | Modify | Capture outbound messages/system prompt for steering and prompt-context assertions |
| `test/agent-loop/session-control.test.ts` | Create | State machine, steering, follow-up, abort tests |
| `test/agent-loop/patch.test.ts` | Create | v4a parser/applicator unit tests |
| `test/agent-loop/apply-patch-integration.test.ts` | Create | End-to-end patch tool tests |
| `test/agent-loop/environment-context.test.ts` | Create | Environment + git snapshot tests |
| `test/agent-loop/truncation.test.ts` | Modify | Character + line cap tests |
| `test/agent-loop/events.test.ts` | Create | Event metadata shape tests |
| `test/llm/adapters/openai.test.ts` | Modify | Developer role mapping |
| `test/llm/adapters/anthropic.test.ts` | Modify | Developer role folding (including multi-steer) |
| `test/llm/adapters/gemini.test.ts` | Modify | Developer role folding |
| `test/handlers/codergen.test.ts` | Modify | Provider-specific tool exposure, event bridging |
| `test/integration/agent-loop.test.ts` | Modify | End-to-end steering, follow-up, truncation, patch flows |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing `processInput()` callers work unchanged (compatibility wrapper)

### Session Control Plane (C1, C2, C3)
- [ ] `AgentSession` exposes `submit()`, `followUp()`, `steer()`, `getState()`, `close()`, `abort()`
- [ ] States transition correctly: IDLE → PROCESSING → AWAITING_INPUT → CLOSED (and abort paths)
- [ ] `steer()` delivers a `developer`-role message before the next LLM call, never mid-tool-execution
- [ ] Multiple `steer()` calls between turns are all injected in FIFO order
- [ ] `followUp()` reuses the same conversation state — model sees full prior context
- [ ] `followUp()` count limited by configurable `max_follow_ups` (default: 10)
- [ ] `abort()` transitions to CLOSED, terminates in-flight work, rejects pending promise
- [ ] Illegal control actions fail with descriptive errors (not silent drops)
- [ ] Steering and follow-up actions are recorded in `transcript.jsonl`

### `developer` Role (L1)
- [ ] `Role` type includes `'developer'`
- [ ] OpenAI adapter passes `developer` messages natively
- [ ] Anthropic adapter folds `developer` into the system block as last entries, preserving FIFO order
- [ ] Gemini adapter folds `developer` into `systemInstruction`

### `apply_patch` Tool (C4)
- [ ] OpenAI profile exposes `apply_patch`; does NOT expose `edit_file`
- [ ] Anthropic and Gemini profiles still expose `edit_file`
- [ ] `apply_patch` supports Add, Update, Delete, Move operations
- [ ] Multi-file patches work in a single tool call
- [ ] Invalid patches fail atomically — zero files modified on any hunk failure
- [ ] Add File rejects when target already exists
- [ ] Path traversal outside workspace root is rejected
- [ ] Line endings normalized on input, preserved per target file on output
- [ ] Raw patch text persisted as `patch.txt` artifact

### Prompt Context (C7, C8)
- [ ] Provider system prompts include environment context block (platform, shell, workspace, date, model, tools)
- [ ] Provider system prompts include git snapshot (branch, dirty counts, recent commits) when available
- [ ] Each git command has an independent 2s timeout
- [ ] Non-git workspaces produce no error — git block silently omitted

### Truncation & Events (C6, C10, C11)
- [ ] `shell` output capped at 30KB / 256 lines; `grep` at 20KB / 200 lines; `glob` at 10KB / 500 lines
- [ ] Full untruncated output preserved in artifacts and agent-level events
- [ ] Engine-level bridged events carry preview + artifact path only
- [ ] `agent_session_started` includes `session_id`, `workspace_root`, `state`
- [ ] `agent_tool_call_completed` includes `content_preview`, `truncated`, `artifact_path`

### Runtime Alignment (C13, C14)
- [ ] Base command timeout default is 10s (profile-level override for Anthropic at 120s)
- [ ] Subprocess SIGKILL escalation after 2s (down from 5s)

### Test Coverage
- [ ] At least 40 new tests across session control, patch parser, environment context, truncation, adapters

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Persistent conversation state breaks existing one-shot codergen behavior | Medium | High | `processInput()` remains a compatibility wrapper. Full regression suite for single-input path runs before any session refactoring. |
| `apply_patch` parser is fragile against model hallucinations | Medium | High | Strict grammar only — no fuzzy matching. Descriptive errors guide the model to self-correct. Golden tests for every supported operation and every known malformed pattern. |
| Patch parser diverges from OpenAI's v4a grammar evolution | Low | High | Pin to the current documented v4a spec. If OpenAI iterates, this is a point-fix to the parser, not a redesign. Monitor model output in integration tests. |
| Steering creates race conditions with concurrent tool execution | Medium | High | Steering is injected at a single deterministic point (between turns, before `client.stream()`). Never mid-tool-call, never mid-stream. The injection is a queue drain, not an interrupt. |
| `developer` role folding is lossy on Anthropic/Gemini | Medium | Medium | Fold deterministically in one place per adapter, preserving FIFO order. Adapter-level tests assert exact request payload shape for multi-steer scenarios. |
| `developer` role changes model behavior in unexpected ways | Low | Medium | Steering messages are short, directive, and task-scoped. Adapter tests validate that model behavior with developer messages matches expectations. |
| Git snapshot gathering slows session startup | Low | Medium | Each git command has an independent 2s timeout. Gather only summary data (counts, not full diffs). Skip entirely on failure — session starts regardless. |
| 10s default timeout breaks long-running shell commands | Medium | Medium | Base default only. Anthropic profile keeps 120s override. Node-level `timeout` attribute is highest priority. Existing tool nodes with explicit timeouts are unaffected. |
| Full tool output on events consumes memory | Medium | Medium | Full output on agent-level events only. Engine-level events carry preview + path. Disk artifacts are the durable store. |
| Conversation history grows unbounded across follow-ups | Medium | Medium | `max_follow_ups` (default: 10) prevents unbounded chains. Full context management (sliding window, summarization) deferred to a future sprint. |
| Sprint scope is ambitious (12 gaps) | Medium | Medium | The 8 medium/low gaps are individually tiny (< 50 lines each). The real work is the state machine (Phase 1) and patch tool (Phase 3). **Cut-line:** If behind schedule, defer Phase 4 truncation/events work — ship control plane + patch tool alone. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| Existing `AgentSession` and tool infrastructure | Foundation for state machine refactoring | Implemented (Sprint 007) |
| Existing `UnifiedClient` and provider adapters | Transport layer for all LLM calls | Implemented |
| Existing `CodergenHandler` | Runtime entry point for agent sessions | Implemented |
| `execa` | Shell execution, git snapshot commands | Already in repo |
| `ajv` | JSON Schema validation for `apply_patch` tool | Already in repo |
| Local `git` binary | Best-effort git snapshot | Soft dependency; graceful fallback if absent |

**Zero new npm dependencies.** All work is concentrated in existing agent-loop, LLM adapter, and codergen handler surfaces.

---

## GAP Closure Summary

| Gap | Description | Severity | Status After Sprint |
|-----|-------------|----------|-------------------|
| C1 | `steer()` mid-task injection | **High** | **Closed** |
| C2 | `follow_up()` queue | Medium | **Closed** |
| C3 | `SessionState` lifecycle | Medium | **Closed** |
| C4 | `apply_patch` for OpenAI | **High** | **Closed** |
| C6 | Line-based truncation | Medium | **Closed** |
| C7 | Environment context in prompt | Medium | **Closed** |
| C8 | Git snapshot in prompt | Medium | **Closed** |
| C10 | Full tool output on events | Medium | **Closed** |
| C11 | Session lifecycle event metadata | Low | **Closed** |
| C13 | Default command timeout (10s) | Low | **Closed** |
| C14 | Process kill delay (2s) | Low | **Closed** |
| L1 | `developer` role | Medium | **Closed** |

**2 HIGH gaps closed. 5 MEDIUM gaps closed. 3 LOW gaps closed. 12 total.**

**Remaining HIGH gap after this sprint:** C5 (subagents) — designed to be Sprint 012, building on the session control plane shipped here.
