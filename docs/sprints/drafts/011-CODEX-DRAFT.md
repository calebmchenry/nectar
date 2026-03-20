# Sprint 011: Codergen Control Plane & OpenAI Patch Parity

## Overview

**Goal:** Turn the coding agent loop from a fire-and-forget prompt runner into a controllable subsystem. After this sprint, a codergen session has a real lifecycle state machine, accepts mid-task steering, queues follow-up work without throwing away conversation state, and gives OpenAI/Codex a native `apply_patch` editing tool instead of forcing exact-string `edit_file`.

**Why this sprint, why now:**

The compliance report's only **high-severity** gaps are all in the coding agent loop:

| Gap | Severity | Why it matters |
|---|---|---|
| C1 `steer()` missing | High | No way to redirect an agent that is drifting mid-task |
| C4 `apply_patch` missing | High | OpenAI/Codex profile is missing its primary editing primitive |
| C5 subagent tools missing | High | No delegation layer yet |

The correct sequencing is **not** to jump straight to C5. Subagents without session state, steering, or provider-appropriate edit semantics are just opaque background workers that are harder to debug and harder to control. Nectar already has the engine, the unified LLM client, the core six-tool agent loop, and transcript artifacts. The highest-leverage next sprint is therefore the **agent-loop control plane**:

- C1 `steer()`
- C2 `follow_up()`
- C3 `SessionState`
- C4 `apply_patch`
- C6 line-based truncation
- C7 environment context block
- C8 git context snapshot
- C10 full tool output on session events
- C11 richer session lifecycle metadata
- C13 default command timeout alignment
- C14 process-kill delay alignment
- L1 `developer` role in the unified message model as supporting plumbing for steering

**Scope - what ships:**

- `AgentSession` state machine: `IDLE`, `PROCESSING`, `AWAITING_INPUT`, `CLOSED`
- Backwards-compatible `processInput()` plus queue-backed `followUp()` and `steer()` semantics
- Persistent per-session conversation state across follow-up tasks
- OpenAI-only `apply_patch` tool using the v4a patch grammar inside a JSON `{ patch: string }` payload
- Provider-specific tool exposure:
  - OpenAI: `read_file`, `write_file`, `apply_patch`, `shell`, `grep`, `glob`
  - Anthropic/Gemini: keep `edit_file`/`write_file`
- Repo-aware system prompt block: platform, shell, workspace root, current date/time, provider/model, git branch, dirty summary, recent commits
- Proper line-based truncation after character truncation for `shell`, `grep`, and `glob`
- Full untruncated tool output preserved on agent events and disk artifacts
- Spec-aligned timeout defaults:
  - base default command timeout = 10s
  - profile override allowed
  - SIGKILL escalation after 2s instead of 5s

**Scope - what does not ship:**

- C5 subagents: `spawn_agent`, `send_input`, `wait`, `close_agent`
- A1 manager loop handler
- HTTP server mode, SSE API, or web UI controls
- Context fidelity runtime and thread reuse across nodes
- Unified LLM middleware, model catalog, structured output, or prompt caching
- Mid-node codergen resume: interrupted agent sessions still restart the node from scratch

**Opinionated constraint:** this sprint does **not** add another generic edit tool. OpenAI gets `apply_patch`; Anthropic and Gemini keep `edit_file`. Trying to force one editing primitive across all providers has already produced the wrong abstraction.

---

## Use Cases

1. **OpenAI codergen node edits multiple files safely.** A node runs with `llm_provider="openai"`. The model reads the repo, then calls:

   ```json
   {
     "patch": "*** Begin Patch\n*** Update File: src/main.ts\n@@\n-export const version = \"1.0.0\";\n+export const version = \"2.0.0\";\n*** Add File: CHANGELOG.md\n+# v2.0.0\n*** End Patch\n"
   }
   ```

   Nectar validates every hunk up front, applies the patch transactionally inside the workspace root, writes the full patch to artifacts, and returns a concise summary of files changed.

2. **Mid-task steering fixes a bad plan without killing the session.** A codergen session is looping on broad refactors. A caller invokes `session.steer("Stop refactoring. Only fix the failing parser fixture and rerun that single test.")`. The steering message is injected before the next model call, ahead of any new user work, and the agent changes course without losing transcript state.

3. **Follow-up work reuses context instead of starting over.** A node completes `"Implement the fix"`. The caller immediately queues `followUp("Run the focused test suite and update snapshots if needed.")`. The session retains prior messages and tool results, processes the new work item next, and produces a second result without constructing a brand-new session.

4. **The model starts with repo context instead of wasting turns on discovery.** The provider profile preamble includes the workspace root, shell, current date, git branch, dirty file count, and the last three commits. The model stops burning tool calls on `pwd`, `git branch`, and `git status` just to orient itself.

5. **Large tool output stays bounded for the model but fully available for humans.** `grep` returns 1,800 matches. The model sees a bounded preview capped by both characters and 200 lines. The transcript and agent event still preserve the full output so a future HTTP server or debugger can inspect it without rerunning the tool.

6. **Session lifecycle is explicit enough for future supervisor work.** A future manager-loop or subagent sprint can ask a session for its current state, see whether it is `PROCESSING` or `AWAITING_INPUT`, inject steering only at legal boundaries, and trust that the session will not silently discard queued work.

---

## Architecture

### Design Principles

**State before delegation.** Subagents are downstream of session control. This sprint makes the parent agent steerable and observable first.

**Provider-specific edit contracts are a feature, not a bug.** OpenAI/Codex is better with patches. Anthropic/Gemini are already wired around exact-match edits. Nectar should expose the right tool for each profile instead of flattening them into one lowest-common-denominator interface.

**Control actions happen at deterministic boundaries.** `steer()` does not interrupt an in-flight shell command or half-built stream. It is delivered only between model turns, immediately before the next LLM request.

**Full output is preserved once.** The model sees a bounded preview. Artifacts and agent-level events keep the full output. We do not make the model context pay for debugger needs.

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

- `IDLE`: session created, no work submitted yet
- `PROCESSING`: currently executing one queued work item through the model/tool loop
- `AWAITING_INPUT`: conversation remains open, current queue is empty, follow-up work may still arrive
- `CLOSED`: terminal state; rejects new work and aborts active operations

### Public Session API

`AgentSession` becomes queue-backed. The public surface is:

- `processInput(prompt): Promise<SessionResult>`
  - Compatibility wrapper over `submit(prompt)`
- `submit(prompt): Promise<SessionResult>`
  - Enqueue a new top-level work item
- `followUp(prompt): Promise<SessionResult>`
  - Enqueue a standard-priority follow-up behind the current work item
- `steer(message): void`
  - Enqueue a high-priority `developer` message to be injected before the next model request
- `getState(): SessionState`
- `close(): void`
- `abort(): void`

Internally, `AgentSession` owns:

- `conversation: Message[]`
- `pendingInputs: SessionWorkItem[]`
- `pendingSteers: string[]`
- `activeItem?: SessionWorkItem`
- `state: SessionState`
- `runLoopPromise?: Promise<void>`

`processInput()` no longer allocates a throwaway `messages` array per call. Conversation history lives on the session instance so follow-ups are real follow-ups, not brand-new prompts with copied text.

### Steering and Follow-Up Delivery

**`steer()`**

- Valid only while `state === PROCESSING`
- Serialized as a `developer` role message, not as user text
- Injected immediately before the next `client.stream()` call
- Recorded in `transcript.jsonl` as a control entry
- Not allowed to interrupt an in-flight tool call or active stream

**`followUp()`**

- Enqueues a new user work item behind the current item
- Reuses the same conversation transcript and tool history
- Returns a promise for that specific follow-up result
- If the session is `AWAITING_INPUT`, it starts immediately
- If the session is `CLOSED`, it rejects

### Prompt Composition

The provider system prompt becomes a composition of four blocks:

```text
1. Provider base instructions
2. Environment context block
3. Git snapshot block
4. Project instructions (AGENTS.md / provider-specific file)
```

**Environment context block**

- workspace root
- platform / architecture
- shell
- current local date/time
- active provider and model
- available tool names for this profile

**Git snapshot block**

- current branch or detached HEAD marker
- short dirty summary:
  - staged file count
  - unstaged file count
  - untracked file count
- last 3 commits as `sha subject`

This snapshot is best-effort. If the workspace is not a git repo or `git` is unavailable, Nectar omits the block and continues.

### `developer` Role Support

Steering only works cleanly if it is modeled distinctly from user text. This sprint therefore adds `developer` to the unified `Role` type and updates adapters:

- OpenAI adapter: pass through as native `developer`
- Anthropic adapter: fold `developer` messages into the request's system block in-order
- Gemini adapter: fold `developer` messages into `systemInstruction`

This is small SDK work, but it belongs in this sprint because it gives `steer()` the right semantics instead of faking it as a user prompt.

### Provider-Specific Tool Exposure

`ToolRegistry` remains the source of truth for implementations, but `ProviderProfile` now chooses which tools the model is allowed to see.

**OpenAI profile**

- `read_file`
- `write_file`
- `apply_patch`
- `shell`
- `grep`
- `glob`

**Anthropic / Gemini profiles**

- `read_file`
- `write_file`
- `edit_file`
- `shell`
- `grep`
- `glob`

`apply_patch` is marked as `mutating` in the tool safety map, so it stays sequential relative to writes and shells when a model emits multiple tool calls in one turn.

### Patch Application Pipeline

The patch tool is split into a parser/applicator layer and a tool wrapper:

```text
tool call { patch: string }
        |
        v
parsePatchV4A()
        |
        v
validate operations
  - grammar
  - workspace boundaries
  - source file existence for update/delete/move
  - target path legality
  - hunk context matches
        |
        v
stage all file mutations in memory
        |
        v
commit writes / deletes / moves
        |
        v
return summary + persist patch artifact
```

**Supported operations:**

- `*** Add File`
- `*** Delete File`
- `*** Update File`
- `*** Move to`
- hunk application with context lines

**Non-goals for this sprint:**

- fuzzy patching
- partial success
- patching outside the workspace root
- binary patch support

If any hunk fails, the entire tool call fails and no file mutations are committed.

### Event and Artifact Model

Current agent events are too thin for real control-plane use. This sprint expands them:

- `agent_session_started`
  - add `session_id`, `workspace_root`, `state`
- `agent_tool_call_completed`
  - add `content_preview`, `full_content`, `truncated`, `artifact_path`
- `agent_session_completed`
  - add `session_id`, `final_state`

Engine-level `RunEvent` bridging stays slimmer:

- bridge preview metadata and artifact paths
- do **not** inline megabytes of full tool output into engine events

Artifacts under the node run directory gain:

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

### Truncation Rules

Keep the existing head/tail character truncation, then apply a second pass for line-heavy tools:

| Tool | Character cap | Line cap |
|---|---:|---:|
| `shell` | 30,000 | 256 |
| `grep` | 20,000 | 200 |
| `glob` | 10,000 | 500 |

`read_file`, `write_file`, `edit_file`, and `apply_patch` keep character-only limits for now.

### Module Layout

```text
src/agent-loop/
├── types.ts
├── session.ts
├── events.ts
├── provider-profiles.ts
├── environment-context.ts      # NEW
├── patch.ts                    # NEW
├── tool-registry.ts
├── truncation.ts
├── transcript.ts
└── tools/
    ├── apply-patch.ts          # NEW
    ├── edit-file.ts
    ├── glob.ts
    ├── grep.ts
    ├── read-file.ts
    ├── shell.ts
    └── write-file.ts

src/llm/
├── types.ts
└── adapters/
    ├── anthropic.ts
    ├── gemini.ts
    └── openai.ts

src/handlers/
└── codergen.ts

src/engine/
└── events.ts
```

---

## Implementation Phases

### Phase 1: Session State Machine and Control Queues (~25%)

**Files:** `src/agent-loop/types.ts`, `src/agent-loop/session.ts`, `src/agent-loop/events.ts`, `test/agent-loop/session.test.ts`, `test/helpers/scripted-adapter.ts`

**Tasks:**

- [ ] Add `SessionState = 'IDLE' | 'PROCESSING' | 'AWAITING_INPUT' | 'CLOSED'`
- [ ] Extend `SessionResult` so results are per submitted work item, not implicitly "the whole lifetime of the session"
- [ ] Add `submit()`, `followUp()`, `steer()`, `getState()`, and `close()` to `AgentSession`
- [ ] Keep `processInput()` as a compatibility wrapper around `submit()`
- [ ] Move conversation history from a local variable inside `processInput()` onto the `AgentSession` instance
- [ ] Add an internal work-item queue with one active item at a time
- [ ] Inject pending steering messages immediately before the next model call
- [ ] Reject illegal control actions cleanly:
  - `steer()` while not `PROCESSING`
  - new work after `CLOSED`
- [ ] Emit lifecycle events on state transitions and completion
- [ ] Update `ScriptedAdapter` test helper so tests can inspect the outbound request messages and system prompt
- [ ] Regression-test current single-input behavior so existing codergen flows do not change unless follow-ups are explicitly used

### Phase 2: Prompt Context and Role Plumbing (~20%)

**Files:** `src/agent-loop/provider-profiles.ts`, `src/agent-loop/environment-context.ts`, `src/llm/types.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `test/agent-loop/provider-profiles.test.ts`, `test/llm/types.test.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/gemini.test.ts`

**Tasks:**

- [ ] Add `developer` to the unified `Role` type
- [ ] Update adapter message normalization to preserve or fold `developer` messages correctly per provider
- [ ] Create `buildEnvironmentContext(workspaceRoot, provider, model, toolNames)` helper
- [ ] Include:
  - platform / architecture
  - shell
  - workspace root
  - current local date/time
  - selected provider / model
  - visible tool names
- [ ] Add best-effort git snapshot gathering with bounded command timeouts and graceful fallback
- [ ] Prepend environment and git context into provider system prompts before project instructions
- [ ] Add provider-level default command timeout field so Anthropic can keep its longer timeout without forcing it on every profile
- [ ] Tests:
  - developer role reaches OpenAI unchanged
  - developer role is folded correctly for Anthropic and Gemini
  - system prompt contains git and environment context inside a git repo
  - non-git workspaces do not error

### Phase 3: OpenAI `apply_patch` Tool (~30%)

**Files:** `src/agent-loop/patch.ts`, `src/agent-loop/tools/apply-patch.ts`, `src/agent-loop/tool-registry.ts`, `src/agent-loop/types.ts`, `src/agent-loop/execution-environment.ts`, `src/handlers/codergen.ts`, `test/agent-loop/apply-patch.test.ts`, `test/agent-loop/tool-registry.test.ts`, `test/handlers/codergen.test.ts`

**Tasks:**

- [ ] Create `parsePatchV4A()` and `applyParsedPatch()` in `src/agent-loop/patch.ts`
- [ ] Support `Add File`, `Delete File`, `Update File`, `Move to`, and hunk application
- [ ] Resolve and validate every path through `ExecutionEnvironment` before mutating anything
- [ ] Extend `ExecutionEnvironment` with the minimum filesystem operations patch application needs:
  - write
  - delete
  - rename / move
  - existence checks
- [ ] Apply patches transactionally per tool call: validate all hunks first, then commit filesystem mutations
- [ ] Add `apply_patch` tool schema:
  - required `patch: string`
  - no extra properties
- [ ] Register `apply_patch` in `CodergenHandler`
- [ ] Make `ProviderProfile` choose visible tools so OpenAI sees `apply_patch` instead of `edit_file`
- [ ] Mark `apply_patch` as `mutating` in tool safety classification
- [ ] Persist the raw patch text as `patch.txt` in tool artifacts
- [ ] Tests:
  - update one file
  - add a file
  - delete a file
  - move a file
  - multi-file patch
  - malformed grammar fails
  - context mismatch fails without partial writes
  - patch outside workspace root is rejected

### Phase 4: Events, Truncation, and Runtime Hardening (~15%)

**Files:** `src/agent-loop/truncation.ts`, `src/agent-loop/transcript.ts`, `src/agent-loop/events.ts`, `src/engine/events.ts`, `src/handlers/codergen.ts`, `src/agent-loop/execution-environment.ts`, `test/agent-loop/truncation.test.ts`, `test/integration/agent-loop.test.ts`

**Tasks:**

- [ ] Replace generic truncation with `truncateToolOutput(toolName, text)` so line caps are tool-specific
- [ ] Preserve full output on agent-level completion events while keeping engine-level events lightweight
- [ ] Extend `TranscriptWriter.writeToolCall()` to persist:
  - preview result
  - full result
  - raw patch text for `apply_patch`
- [ ] Record steering and follow-up actions in `transcript.jsonl`
- [ ] Expand `status.json` to include session state, provider, model, and queue statistics
- [ ] Change base `DEFAULT_SESSION_CONFIG.default_command_timeout_ms` to `10_000`
- [ ] Change `LocalExecutionEnvironment.exec()` force-kill delay from 5000ms to 2000ms
- [ ] Ensure `apply_patch` and shell outputs remain deterministic in artifact numbering and event ordering

### Phase 5: Integration and Regression Coverage (~10%)

**Files:** `test/agent-loop/session-control.test.ts`, `test/integration/agent-loop.test.ts`, `test/handlers/codergen.test.ts`, `test/agent-loop/provider-profiles.test.ts`, `test/llm/adapters/*.test.ts`

**Tasks:**

- [ ] Add session-control integration tests:
  - steer injected between tool rounds
  - follow-up runs after initial task without a new session
  - illegal steer in `AWAITING_INPUT` is rejected
- [ ] Add OpenAI-profile integration test that uses `apply_patch` end-to-end through `CodergenHandler`
- [ ] Add regression tests proving Anthropic and Gemini still use `edit_file`
- [ ] Add test asserting git snapshot omission does not fail outside a repository
- [ ] Add test asserting full tool output is written even when the model-visible preview is truncated
- [ ] Run the full existing agent-loop and codergen suites to catch behavior drift

---

## Files Summary

| File | Action | Purpose |
|---|---|---|
| `src/agent-loop/types.ts` | Modify | Add `SessionState`, queue-related types, tool safety for `apply_patch`, and updated timeout defaults |
| `src/agent-loop/session.ts` | Modify | Convert session to queue-backed control plane with persistent conversation state and steering/follow-up support |
| `src/agent-loop/events.ts` | Modify | Add richer lifecycle metadata and full-output fields for agent events |
| `src/agent-loop/provider-profiles.ts` | Modify | Provider-specific visible tool lists, timeout defaults, and prompt composition changes |
| `src/agent-loop/environment-context.ts` | Create | Build environment and git snapshot blocks for provider system prompts |
| `src/agent-loop/patch.ts` | Create | Parse and apply the v4a patch format transactionally |
| `src/agent-loop/tool-registry.ts` | Modify | Allow filtered tool definitions by provider profile |
| `src/agent-loop/truncation.ts` | Modify | Add tool-specific line caps on top of character truncation |
| `src/agent-loop/transcript.ts` | Modify | Persist control actions, full outputs, and raw patch artifacts |
| `src/agent-loop/execution-environment.ts` | Modify | Add patch-safe filesystem operations and spec-aligned process kill timing |
| `src/agent-loop/tools/apply-patch.ts` | Create | `apply_patch` tool schema and handler wrapper |
| `src/llm/types.ts` | Modify | Add `developer` role |
| `src/llm/adapters/openai.ts` | Modify | Preserve `developer` messages natively |
| `src/llm/adapters/anthropic.ts` | Modify | Fold `developer` messages into the system prompt deterministically |
| `src/llm/adapters/gemini.ts` | Modify | Fold `developer` messages into `systemInstruction` deterministically |
| `src/handlers/codergen.ts` | Modify | Register `apply_patch`, select provider-specific tool exposure, and bridge richer agent events |
| `src/engine/events.ts` | Modify | Carry preview-level tool event metadata for engine consumers |
| `test/helpers/scripted-adapter.ts` | Modify | Capture outbound messages/system prompt for steering and prompt-context assertions |
| `test/agent-loop/session.test.ts` | Modify | Preserve current single-task regressions while adapting to session state changes |
| `test/agent-loop/session-control.test.ts` | Create | Dedicated coverage for `steer()`, `followUp()`, and state transitions |
| `test/agent-loop/apply-patch.test.ts` | Create | Parser/applicator coverage for valid and invalid patches |
| `test/agent-loop/tool-registry.test.ts` | Modify | Provider-specific tool definition filtering |
| `test/agent-loop/provider-profiles.test.ts` | Modify | System prompt composition and visible-tool assertions |
| `test/agent-loop/truncation.test.ts` | Modify | Character + line cap behavior |
| `test/handlers/codergen.test.ts` | Modify | OpenAI `apply_patch` registration and event bridging |
| `test/integration/agent-loop.test.ts` | Modify | End-to-end follow-up, steering, truncation, and patch flows |
| `test/llm/types.test.ts` | Modify | `developer` role coverage |
| `test/llm/adapters/openai.test.ts` | Modify | OpenAI developer-role request mapping |
| `test/llm/adapters/anthropic.test.ts` | Modify | Anthropic developer-role folding |
| `test/llm/adapters/gemini.test.ts` | Modify | Gemini developer-role folding |

---

## Definition of Done

- [ ] `AgentSession` exposes `submit()`, `followUp()`, `steer()`, `getState()`, and `close()` without breaking existing `processInput()` callers
- [ ] Session states transition correctly across `IDLE`, `PROCESSING`, `AWAITING_INPUT`, and `CLOSED`
- [ ] `steer()` is delivered before the next model call and never interrupts an in-flight tool execution
- [ ] `followUp()` runs after the current work item and reuses the same conversation state
- [ ] Illegal control actions fail predictably with clear errors
- [ ] OpenAI profile exposes `apply_patch` and does not expose `edit_file`
- [ ] Anthropic and Gemini profiles still expose `edit_file`
- [ ] `apply_patch` supports add, update, delete, and move operations across multiple files
- [ ] Invalid patches fail atomically with no partial filesystem mutation
- [ ] Patch operations cannot escape the workspace root
- [ ] `apply_patch` artifacts include the raw patch text and full result
- [ ] Unified message model includes `developer` role and adapters handle it correctly
- [ ] Provider system prompts include environment context and a best-effort git snapshot
- [ ] Non-git workspaces still run cleanly with no prompt-builder failure
- [ ] `shell`, `grep`, and `glob` previews obey both character and line caps
- [ ] Full untruncated tool output is preserved in artifacts and agent-level completion events
- [ ] Engine-level bridged events contain preview metadata and artifact paths without inlining huge payloads
- [ ] Base command timeout default is 10s unless a profile or node override says otherwise
- [ ] Subprocess force-kill escalation occurs after 2s
- [ ] Existing agent-loop and codergen integration tests still pass
- [ ] `npm test` passes on a clean checkout

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `apply_patch` grammar edge cases create a fragile parser | Medium | High | Keep the grammar strict, support only the documented operations, and add golden tests for malformed hunks and multi-file patches before wiring it into `CodergenHandler` |
| Persistent session state regresses today's one-shot codergen behavior | Medium | High | Keep `processInput()` as a compatibility wrapper, preserve existing session tests, and add regression coverage for the current single-task path |
| Steering semantics become race-prone | Medium | High | Deliver steering only at deterministic turn boundaries, never during active tool execution or mid-stream parsing |
| Git snapshot gathering slows every session start | Low | Medium | Bound each git command with a short timeout, gather only summary data, and skip the block entirely on failure |
| Full tool output on events bloats memory | Medium | Medium | Keep full output on agent-level events only, bridge preview + artifact path into engine-level events, and continue writing full output to disk once |
| Provider-specific tool visibility drifts from implementations | Low | Medium | Keep one registry, make profiles return allowlists, and test visible tool names per provider explicitly |
| Developer-role folding is lossy on Anthropic/Gemini | Medium | Medium | Normalize in one place, preserve message order, and add adapter-level tests that assert exact request payload shape |
| Timeout changes break long-running shell-heavy workflows | Medium | Medium | Make 10s the base default only, keep provider-level overrides, and preserve node-level explicit timeout attributes as the highest priority |

---

## Dependencies

| Dependency | Purpose | Status |
|---|---|---|
| Existing Sprint 007 agent-loop foundation | `AgentSession`, `ToolRegistry`, `ExecutionEnvironment`, transcripts, provider profiles | Already implemented |
| Existing Unified LLM client | Streaming + tool call transport for all providers | Already implemented |
| Existing codergen handler integration | Runtime entry point for agent sessions inside pipelines | Already implemented |
| `execa` | Shell execution and bounded git snapshot commands | Already in repo |
| `ajv` | JSON Schema validation for the new `apply_patch` tool | Already in repo |
| Local `git` binary | Best-effort git snapshot for prompt context | Soft runtime dependency; sprint must degrade gracefully if absent |

**No new npm dependencies are required.** This sprint is concentrated in the existing agent-loop, LLM adapter, and codergen surfaces.
