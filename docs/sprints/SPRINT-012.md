# Sprint 012: Subagent Tools — Parallel Task Delegation with Session Hardening

## Overview

**Goal:** Close the last HIGH-severity compliance gap (C1 — subagent tools) by implementing `spawn_agent`, `send_input`, `wait`, and `close_agent` on top of a hardened, observable `AgentSession`. After this sprint, a codergen node can delegate scoped work to child agents, steer them mid-flight, wait for results, and tear down the full tree cleanly on abort. As a quick-win, also close C3 (untruncated tool output events) and A10 (context `append_log()`).

**Why this sprint, why now:**

- `C1` is the only **HIGH-severity** gap remaining in `docs/compliance-report.md`. No combination of MEDIUM gaps matches closing the only HIGH.
- Sprint 011 shipped the session control plane (`submit()`, `steer()`, `followUp()`, `abort()`, `getState()`, `SessionState`). This is the infrastructure subagents need — building them before the control plane would have meant reimplementing half of Sprint 011.
- However, the Sprint 011 session wiring has live gaps: profile-specific tool exposure is not used at runtime, environment/git context is built but not injected into prompts, abort does not stop in-flight shell commands, and artifact metadata is incomplete. These must be fixed before multiplying the session into children — otherwise bugs propagate silently into every child.

**Design principles:**

1. **Finish the parent before multiplying children.** Fix session wiring first, then layer delegation on top.
2. **A child agent is a real `AgentSession`, not a special callback.** Each child gets its own conversation, loop detector, event stream, transcript, and result.
3. **Delegation is explicit and bounded.** The model opts in via tool calls. Default depth is 1. Concurrency is capped at 4.
4. **Observability beats convenience.** Every child has its own artifact directory. Every event carries lineage metadata.
5. **`working_dir` is a starting point, not a new trust boundary.** It changes default relative path base and shell `cwd`, but all paths still resolve inside the same workspace root.

**Gaps closed:**

| Gap | Severity | Description |
|-----|----------|-------------|
| C1 | **HIGH** | Subagent tools: `spawn_agent`, `send_input`, `wait`, `close_agent` |
| C3 | MEDIUM | Untruncated tool output in `TOOL_CALL_END` events |
| A10 | LOW | Context `append_log()` method for subagent activity logging |

**Total: 1 HIGH + 1 MEDIUM + 1 LOW = 3 gaps closed.**

**Out of scope:**

- A1 manager loop handler (`house` / `stack.manager_loop`) — builds on subagents, next sprint candidate
- A4/A5 context fidelity runtime and thread resolution
- L4 structured output, L7 middleware, L8 model catalog, L9 `generate()` loop
- L10 Anthropic prompt caching, L11 beta headers
- HTTP server mode, web UI, seedbed swarm analysis
- Recursive subagents beyond depth 1 (architecture supports it; default disabled)
- Subagent-to-subagent communication (parent-mediated only)
- Cross-machine subagent distribution (local-only)

**Cut-line:** If the sprint runs long, defer cosmetic parent-side summaries of child work and per-child timeout enforcement (children can rely on `max_tool_rounds` for natural termination). Do **not** ship partial subagent support without clean abort semantics, lineage metadata, and transcript/artifact persistence.

---

## Use Cases

1. **Parallel implementation and testing.** A codergen node spawns one child to implement a feature and another to write tests. The parent waits for both and handles integration. Total time is `max(impl, tests)` instead of `impl + tests`.

2. **Focused work in a subdirectory.** The parent spawns a child with `working_dir="packages/cli"` and task `"add zsh completion tests"`. The child resolves relative paths from that subtree and runs shell commands from there, but the workspace boundary still blocks escape outside the repo root.

3. **Mid-flight correction.** A child starts a broad refactor when the parent only wants a one-file fix. The parent calls `send_input(agent_id, "Stop refactoring. Only fix parser.ts and rerun its tests.")`. If the child is PROCESSING, the message lands as a steer before the next LLM call. If AWAITING_INPUT, it queues as a follow-up.

4. **Code review loop.** A parent implements a feature, then spawns a reviewer child. The reviewer's output becomes feedback the parent can address.

5. **Alternative approaches.** The parent spawns two children with the same task but different `model` overrides. It waits for both, compares outputs, and keeps the better approach.

6. **Graceful shutdown.** The user aborts a run while a parent has active children. The engine cancels the active stream, kills running commands, aborts all children, flushes transcripts, emits terminal events, and leaves no orphaned sessions.

7. **Depth limiting prevents runaway spawning.** A child tries to spawn its own child. The system checks depth and returns a tool error: `"Maximum subagent depth (1) reached. Complete this task directly."` The agent adapts and works directly. (The `spawn_agent` tool is hidden entirely from children at max depth.)

---

## Architecture

### SubagentManager

Each `AgentSession` optionally owns a `SubagentManager`, created lazily on first `spawn_agent` call:

```text
Parent AgentSession
  ├── conversation / steer queue / follow-up queue
  ├── ToolRegistry
  │   ├── core tools (read/write/edit-or-patch/shell/grep/glob)
  │   └── subagent tools (spawn_agent, send_input, wait, close_agent)
  ├── TranscriptWriter
  └── SubagentManager
      ├── Map<agent_id, SubAgentHandle>
      ├── spawn(task, opts?)
      ├── sendInput(agent_id, message)
      ├── wait(agent_ids)
      ├── close(agent_id)
      └── closeAll()
```

`SubAgentHandle` carries:

- `id: string` (UUID)
- `session: AgentSession`
- `status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CLOSED'`
- `working_dir: string`
- `started_at: string`
- `result_promise: Promise<SubAgentResult>`
- `result?: SubAgentResult` (cached when terminal)

**Limits enforced by the manager:**

- `max_subagent_depth`: default **1** (parent -> child only; architecture carries depth tracking for future extension)
- `max_concurrent_children`: default **4** (prevents horizontal fork-bombing)
- `child_max_tool_rounds`: default **20** (children are focused subtasks, not open-ended sessions)
- `child_max_turns`: default **5**
- `child_timeout_ms`: default **300,000** (5 minutes)

All defaults are overridable per `spawn_agent` call.

### Dynamic Tool Visibility Per Turn

Tool exposure must be truthful at runtime. Each LLM turn rebuilds tool definitions from:

1. The provider profile's core tool set (OpenAI gets `apply_patch`; Anthropic/Gemini get `edit_file`)
2. `spawn_agent` — only when `session_depth < max_subagent_depth`
3. `send_input`, `wait`, `close_agent` — only when the session has active or completed child handles

| Session type | Visible editing tool | Visible subagent tools |
|--------------|----------------------|------------------------|
| OpenAI parent | `apply_patch` | `spawn_agent`, plus `send_input`/`wait`/`close_agent` when children exist |
| Anthropic parent | `edit_file` | same as above |
| Any child at max depth | provider-native editing tool | none |

This prevents wasted tool-call attempts and keeps the prompt honest.

### Live Prompt Composition

The system prompt must be rebuilt from the real live tool list and environment context before each LLM call:

1. Provider base prompt
2. Environment context block (workspace, OS, git state)
3. Git snapshot block
4. Project instructions

This closes unfinished Sprint 011 wiring where the model could be told one set of tools but receive another.

### Tool Definitions

```typescript
// spawn_agent
{
  name: "spawn_agent",
  description: "Spawn a child agent to work on a subtask in parallel.",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", description: "The task prompt for the child agent" },
      working_dir: { type: "string", description: "Working directory (default: parent's cwd)" },
      model: { type: "string", description: "Model override for the child (default: parent's model)" },
      max_tool_rounds: { type: "integer", description: "Max tool rounds (default: 20)" },
      max_turns: { type: "integer", description: "Max conversation turns (default: 5)" },
      timeout_ms: { type: "integer", description: "Timeout in ms (default: 300000)" }
    },
    required: ["task"]
  }
}

// send_input
{
  name: "send_input",
  description: "Send a message to a child agent. Steers if processing, queues follow-up if idle.",
  input_schema: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      message: { type: "string" }
    },
    required: ["agent_id", "message"]
  }
}

// wait
{
  name: "wait",
  description: "Wait for child agents to complete. Returns bounded result summaries.",
  input_schema: {
    type: "object",
    properties: {
      agent_ids: {
        oneOf: [
          { type: "string", description: "Single agent_id" },
          { type: "array", items: { type: "string" }, description: "Multiple agent_ids" }
        ]
      }
    },
    required: ["agent_ids"]
  }
}

// close_agent
{
  name: "close_agent",
  description: "Terminate a child agent. Aborts if running, closes if idle. Idempotent.",
  input_schema: {
    type: "object",
    properties: {
      agent_id: { type: "string" }
    },
    required: ["agent_id"]
  }
}
```

### Communication Semantics

| Tool | Behavior |
|------|----------|
| `spawn_agent` | Creates a child session with `depth + 1`, starts it immediately, returns `{ agent_id, status, working_dir, model }` |
| `send_input` | If PROCESSING: `child.steer(message)`, returns `{ status: "steered" }`. If AWAITING_INPUT: `child.followUp(message)`, returns `{ status: "follow_up_queued" }`. If terminal: tool error. |
| `wait` | Awaits running children via `Promise.allSettled`. Returns cached result for completed children. Result: `{ agent_id, status, output, turns_used, error? }`. Output is a bounded summary; full output goes to artifacts. |
| `close_agent` | If PROCESSING: abort. If AWAITING_INPUT: close. If already terminal: return status (idempotent). Removes from active map. |

### Scoped Execution Environment

`ExecutionEnvironment` gains an explicit `cwd` concept while preserving `workspaceRoot` as the trust boundary:

- `cwd`: default relative path base and shell working directory
- `workspaceRoot`: immutable trust boundary — all path resolution stays inside it
- `scoped(subdir)`: returns a new environment instance with a different `cwd` but the same `workspaceRoot`
- `working_dir` parameter on `spawn_agent` must resolve within `workspaceRoot`

### Event Model

Every agent event carries lineage metadata:

- `session_id`
- `root_session_id`
- `parent_session_id` (when emitted by a child)
- `agent_depth`
- `artifact_path` (on tool-completion events)

Explicit subagent lifecycle events:

```typescript
interface SubagentSpawnedEvent {
  type: 'subagent_spawned';
  parent_session_id: string;
  child_session_id: string;
  agent_id: string;
  task: string;
  depth: number;
  timestamp: string;
}

interface SubagentCompletedEvent {
  type: 'subagent_completed';
  parent_session_id: string;
  child_session_id: string;
  agent_id: string;
  status: 'success' | 'failure' | 'timeout' | 'aborted';
  usage: Usage;
  timestamp: string;
}

interface SubagentMessageEvent {
  type: 'subagent_message';
  parent_session_id: string;
  agent_id: string;
  direction: 'parent_to_child' | 'child_to_parent';
  message_type: 'steer' | 'follow_up' | 'result';
  timestamp: string;
}
```

Child events bubble through the parent's event emitter so the CLI renderer and future HTTP SSE stream observe subagent activity in real time.

### Transcript & Artifact Layout

```text
<run_dir>/<node_id>/
├── prompt.md
├── response.md
├── status.json
├── transcript.jsonl
├── tool-calls/
│   ├── 001-spawn_agent/
│   │   ├── request.json
│   │   └── result.json
│   ├── 002-read_file/
│   └── 003-wait/
│       ├── request.json
│       └── result.json
└── subagents/
    ├── <agent-id-1>/
    │   ├── prompt.md
    │   ├── response.md
    │   ├── status.json
    │   ├── result.json
    │   ├── transcript.jsonl
    │   └── tool-calls/
    └── <agent-id-2>/
        └── ...
```

Parent transcripts also record control actions: `steer`, `follow_up`, `subagent_spawn`, `subagent_wait`, `subagent_close`. `apply_patch` artifacts persist `patch.txt` alongside `request.json` and `result.json`.

### Abort and Cleanup

Parent shutdown follows a single deterministic path:

1. Cancel the active LLM stream
2. Propagate abort signal to the current tool invocation
3. Abort all running child sessions
4. Await bounded child cleanup (2s SIGKILL escalation)
5. Flush transcript/status artifacts
6. Emit final session events
7. Transition to CLOSED

If a child fails naturally, the parent does **not** automatically fail. Child success/failure becomes data surfaced through `wait`. The model decides how to react.

---

## Implementation

### Phase 1: Session Hardening (~25%)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/transcript.ts`, `src/agent-loop/tools/shell.ts`, `src/agent-loop/events.ts`, `src/handlers/codergen.ts`, `src/engine/events.ts`, related tests

**Tasks:**

- [ ] Make live sessions use profile-filtered tool definitions instead of `registry.definitions()` — tool list must match what the prompt describes
- [ ] Build the system prompt with `buildFullSystemPrompt(...)` in the real session path (environment context + git snapshot + project instructions)
- [ ] Recompute visible tool names per turn so prompt and actual tool list stay aligned
- [ ] Propagate abort signals into shell execution so `abort()` actually stops in-flight commands
- [ ] Wire the real default command timeout into `env.exec()` and keep Anthropic's profile override
- [ ] Record follow-up actions in `transcript.jsonl`
- [ ] Persist `patch.txt` alongside `request.json` and `result.json` for `apply_patch`
- [ ] Emit `artifact_path`, `session_id`, and `workspace_root` from runtime events
- [ ] Update `AgentToolCompleted` event to include `full_output: string` alongside truncated `output` (C3)
- [ ] Ensure `TranscriptWriter` uses untruncated output for artifact files while LLM context receives truncated version
- [ ] Get the branch back to a green `npm run build` / `npm test` baseline before layering delegation

### Phase 2: SubagentManager & Core Tools (~30%)

**Files:** `src/agent-loop/subagent-manager.ts`, `src/agent-loop/types.ts`, `src/agent-loop/session.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/tools/spawn-agent.ts`, `src/agent-loop/tools/send-input.ts`, `src/agent-loop/tools/wait.ts`, `src/agent-loop/tools/close-agent.ts`, `src/agent-loop/provider-profiles.ts`, `test/agent-loop/subagent-manager.test.ts`

**Tasks:**

- [ ] Define `SubagentConfig` on session config: `max_subagent_depth` (default 1), `max_concurrent_children` (default 4), `child_max_tool_rounds` (default 20), `child_max_turns` (default 5), `child_timeout_ms` (default 300,000)
- [ ] Add `depth: number` to `AgentSession` constructor options (default 0)
- [ ] Create `SubagentManager` class with `spawn`, `sendInput`, `wait`, `close`, `closeAll`
- [ ] Enforce depth limit: return tool error when `depth + 1 > max_subagent_depth`
- [ ] Enforce concurrency limit: return tool error when `activeChildren.size >= max_concurrent_children`
- [ ] Create JSON schemas and handler factories for all four subagent tools
- [ ] `spawn_agent`: creates child with `depth + 1`, starts immediately, returns stable `agent_id`
- [ ] `send_input`: state-aware routing — steer during PROCESSING, follow-up during AWAITING_INPUT, error on terminal
- [ ] `wait`: blocks on running children via `Promise.allSettled`, returns cached results for completed, returns bounded summaries (not full transcripts)
- [ ] `close_agent`: abort if PROCESSING, close if AWAITING_INPUT, idempotent on terminal
- [ ] Add lazy `SubagentManager` creation on `AgentSession` — instantiated on first subagent tool call
- [ ] Child sessions inherit parent's provider profile, client, execution environment, and event emitter
- [ ] Support `model` override and `working_dir` override per `spawn_agent` call
- [ ] Add `cwd` and `scoped()` to `ExecutionEnvironment` — `working_dir` affects file tools and shell commands, stays within `workspaceRoot`
- [ ] Implement dynamic tool visibility: hide `spawn_agent` at max depth, hide management tools when no children exist
- [ ] Cache terminal child results so repeated `wait` calls are cheap and deterministic
- [ ] Aggregate child token usage into parent `Usage` reporting
- [ ] Tests:
  - Spawn creates child with correct depth
  - Depth limit enforced — returns error, not exception
  - Concurrency limit enforced — completed children free slots
  - Child inherits provider profile
  - Multiple spawns produce unique agent_ids
  - `send_input` steers PROCESSING child
  - `send_input` follows up on AWAITING_INPUT child
  - `send_input` to unknown/closed agent returns error
  - `wait` single child returns result
  - `wait` multiple children returns all results (including failures)
  - `wait` on already-completed child returns immediately
  - `close_agent` aborts processing, closes awaiting, idempotent on terminal
  - Dynamic tool visibility matches session state

### Phase 3: Events, Transcripts & Context Logging (~25%)

**Files:** `src/agent-loop/events.ts`, `src/agent-loop/transcript.ts`, `src/engine/context.ts`, `src/engine/events.ts`, `src/handlers/codergen.ts`, `test/agent-loop/subagent-events.test.ts`, `test/engine/context.test.ts`

**Tasks:**

- [ ] Define subagent event types: `SubagentSpawnedEvent`, `SubagentCompletedEvent`, `SubagentMessageEvent`
- [ ] Emit events from `SubagentManager` on spawn, completion, and message delivery
- [ ] Add lineage metadata to all agent events: `session_id`, `root_session_id`, `parent_session_id`, `agent_depth`
- [ ] Child events bubble through parent's event emitter with lineage context
- [ ] Bridge subagent events to engine-level `RunEvent` stream
- [ ] Extend `TranscriptWriter` to create nested `subagents/<agent_id>/` directories
- [ ] Child sessions write their own transcripts under nested directories
- [ ] Parent transcripts record control actions (steer, follow_up, spawn, wait, close)
- [ ] Implement `ExecutionContext.appendLog(entry: string)` (A10): append-only `run_log: string[]`
- [ ] Implement `ExecutionContext.getLog(): string[]` — retrieve full log
- [ ] Log subagent spawns and completions to context run log
- [ ] Update `CodergenHandler` to pass `depth` and bridge nested events/artifacts into run events
- [ ] Tests:
  - `SubagentSpawnedEvent` emitted on spawn with correct metadata
  - `SubagentCompletedEvent` emitted on child finish
  - Child events contain correct `parent_session_id` and `root_session_id`
  - Nested transcript directories created correctly
  - `appendLog` adds entries, `getLog` retrieves them
  - Engine events include subagent activity with lineage

### Phase 4: Abort Propagation, Cleanup & Integration (~20%)

**Files:** `src/agent-loop/subagent-manager.ts`, `src/agent-loop/session.ts`, `test/agent-loop/subagent-abort.test.ts`, `test/agent-loop/subagent-cleanup.test.ts`, `test/integration/agent-loop.test.ts`, `test/helpers/scripted-adapter.ts`

**Tasks:**

- [ ] Wire abort propagation: parent `abort()` → `manager.closeAll()` → children abort → CLOSED
- [ ] Auto-cleanup: parent session completion aborts all live children
- [ ] Implement per-child timeout via `Promise.race()` between result promise and `setTimeout`
  - On timeout: abort child, resolve with `{ status: 'timeout' }`
  - Clear timer on normal completion
- [ ] Handle edge case: parent aborted while `wait()` is pending — wait rejects cleanly
- [ ] Handle edge case: `wait` called on a child that was already `close_agent`'d — return last known status
- [ ] Handle edge case: child completes with error while parent is not waiting — result cached for later `wait`
- [ ] No orphaned child sessions after any shutdown path (completion, failure, close, abort)
- [ ] Update `test/helpers/scripted-adapter.ts` to support multi-session scenarios
- [ ] Integration test: parent spawns multiple children, waits for both, finishes with correct answer
- [ ] Integration test: parent abort stops active children and flushes artifacts
- [ ] Integration test: depth limit prevents child from spawning grandchild
- [ ] Regression tests for Phase 1 session-hardening fixes

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/session.ts` | Modify | Dynamic tool visibility, live prompt rebuild, lazy SubagentManager, depth tracking, abort propagation, untruncated tool output |
| `src/agent-loop/subagent-manager.ts` | Create | `SubagentManager`: spawn, sendInput, wait, close, closeAll, depth/concurrency limits |
| `src/agent-loop/types.ts` | Modify | `SubagentConfig`, `depth`, `SubAgentHandle`, `SubAgentResult`, budget defaults |
| `src/agent-loop/events.ts` | Modify | Subagent event types, lineage metadata, `full_output` on `AgentToolCompleted` (C3) |
| `src/agent-loop/execution-environment.ts` | Modify | Add `cwd`, `scoped()`, real timeout/abort wiring |
| `src/agent-loop/provider-profiles.ts` | Modify | Profile-filtered tools in live sessions, dynamic subagent tool exposure |
| `src/agent-loop/transcript.ts` | Modify | Nested `subagents/<agent_id>/` dirs, `patch.txt` persistence, follow-up recording, untruncated output in artifacts |
| `src/agent-loop/tools/shell.ts` | Modify | Session-aware timeout and abort signal |
| `src/agent-loop/tools/spawn-agent.ts` | Create | `spawn_agent` tool schema and handler |
| `src/agent-loop/tools/send-input.ts` | Create | `send_input` tool schema and handler |
| `src/agent-loop/tools/wait.ts` | Create | `wait` tool schema and handler |
| `src/agent-loop/tools/close-agent.ts` | Create | `close_agent` tool schema and handler |
| `src/engine/context.ts` | Modify | `appendLog()` / `getLog()` methods (A10) |
| `src/engine/events.ts` | Modify | Subagent event bridging, lineage metadata preservation |
| `src/handlers/codergen.ts` | Modify | Pass depth, register subagent tools, bridge nested events/artifacts |
| `test/agent-loop/subagent-manager.test.ts` | Create | Manager spawn, depth/concurrency limits, tool visibility |
| `test/agent-loop/subagent-events.test.ts` | Create | Event emission, transcript nesting, lineage metadata |
| `test/agent-loop/subagent-abort.test.ts` | Create | Abort propagation, timeout, cleanup |
| `test/agent-loop/subagent-cleanup.test.ts` | Create | Auto-cleanup, orphan prevention, idempotent close |
| `test/engine/context.test.ts` | Modify | appendLog / getLog tests |
| `test/helpers/scripted-adapter.ts` | Modify | Support multi-session parent/child scenarios |
| `test/integration/agent-loop.test.ts` | Modify | End-to-end parent/child delegation scenarios |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing single-session `processInput()` / `submit()` behavior unchanged

### Session Hardening (Phase 1)
- [ ] Live OpenAI sessions expose `apply_patch` and do **not** expose `edit_file`
- [ ] Live Anthropic and Gemini sessions expose `edit_file` and do **not** expose `apply_patch`
- [ ] Real agent sessions include environment context and git snapshot blocks in the system prompt
- [ ] `followUp()` writes a transcript entry in `transcript.jsonl`
- [ ] `apply_patch` writes `patch.txt` into the tool-call artifact directory
- [ ] `abort()` stops in-flight shell commands
- [ ] Tool-completion events expose `full_output` (untruncated) to the host and truncated output to the model (C3)

### Subagent Tools (C1)
- [ ] `spawn_agent` creates a child session with `depth + 1` and returns a stable `agent_id`
- [ ] `send_input` steers a PROCESSING child or queues follow-up for an AWAITING_INPUT child
- [ ] `wait` blocks until specified children complete and returns bounded result summaries
- [ ] `wait` supports both single `agent_id` (string) and multiple (array)
- [ ] `wait` on already-completed child returns immediately with cached result
- [ ] `close_agent` aborts/closes a child session (idempotent on terminal)
- [ ] All four tools registered for all provider profiles with dynamic visibility

### Depth & Concurrency Limiting
- [ ] `depth` tracked on every `AgentSession` (0 for top-level)
- [ ] `spawn_agent` rejected with tool error when `depth + 1 > max_subagent_depth` (default 1)
- [ ] `spawn_agent` tool hidden entirely from sessions at max depth
- [ ] `spawn_agent` rejected when `max_concurrent_children` (default 4) reached
- [ ] Completed children free concurrency slots

### Budget Controls
- [ ] Child `max_tool_rounds` defaults to 20
- [ ] Child `max_turns` defaults to 5
- [ ] Child `timeout_ms` defaults to 300,000 (5 minutes)
- [ ] All defaults overridable per `spawn_agent` call
- [ ] Child token usage aggregated into parent `Usage` reporting

### Lifecycle & Cleanup
- [ ] Parent session completion auto-aborts live children
- [ ] Parent `abort()` cascades to all children
- [ ] No orphaned child sessions after any shutdown path
- [ ] Children inherit provider profile, client, and execution environment from parent
- [ ] `working_dir` changes `cwd` for file tools and shell commands while enforcing `workspaceRoot` boundary

### Events & Transcripts
- [ ] `SubagentSpawnedEvent` emitted on spawn with lineage metadata
- [ ] `SubagentCompletedEvent` emitted on child completion
- [ ] `SubagentMessageEvent` emitted on steer/follow-up delivery
- [ ] All agent events carry `session_id`, `root_session_id`, `parent_session_id`, `agent_depth`
- [ ] Child transcripts written under `subagents/<agent_id>/` nested directory
- [ ] Parent transcripts record control actions (spawn, steer, wait, close)
- [ ] Subagent events bridged to engine-level RunEvent stream

### Context Logging (A10)
- [ ] `ExecutionContext.appendLog(entry)` appends to an immutable run log
- [ ] `ExecutionContext.getLog()` returns the full log array
- [ ] Subagent spawns and completions are logged to context

### Test Coverage
- [ ] At least 30 new tests across subagent manager, tools, lifecycle, events, cleanup, abort
- [ ] Integration test: parent spawns children, waits, finishes correctly
- [ ] Integration test: abort propagates and cleans up
- [ ] Regression tests for session-hardening fixes

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Phase 1 session hardening underestimated.** Profile-filtered tools, live prompt composition, and abort-into-shell are each non-trivial. | Medium | High | Budget Phase 1 at 25% (not 20%). If it overruns, compress Phase 4 integration tests before cutting core subagent features. |
| **Models spawn children too eagerly for trivial tasks.** | High | Medium | Conservative defaults: max 4 concurrent, depth 1, child tool rounds 20. Error messages guide the model to work directly. Tool descriptions explicit about when delegation is worthwhile. `spawn_agent` hidden at max depth. |
| **Cost explosion from unbounded child token usage.** | Medium | High | Per-child budget limits (`max_tool_rounds`, `max_turns`, `timeout_ms`). Child usage aggregated into parent `Usage` for accurate cost reporting. |
| **Filesystem conflicts when parent and child edit the same file.** | Medium | High | No filesystem locking this sprint — matches the `make` threat model. Document that parents should scope children to non-overlapping directories via task instructions. |
| **Parent/child abort races leave orphaned shell processes.** | Medium | High | Single shutdown path: stream cancel -> tool abort -> child abort -> bounded cleanup (2s SIGKILL escalation) -> final event. Test with long-running shell commands. |
| **Dynamic tool visibility changes confuse the model.** | Medium | Medium | Rebuild prompt + tool definitions every turn. Never hide `wait`/`close_agent` while active children exist. Models that cache tool expectations may hallucinate — but tool call validation catches it before execution. |
| **Context window pressure from accumulated child results.** | Medium | Medium | `wait` returns bounded summaries, not full transcripts. Full output preserved in artifacts only. |
| **Child event fan-out becomes noisy or duplicated.** | Medium | Medium | Lineage metadata on every event. Assert exact event counts in tests. |
| **Deadlock: parent waits on child, child waits on parent.** | Low | High | Communication is strictly parent-to-child (steer/follow-up) and child-to-parent (result on completion). No bidirectional channel = no deadlock. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| Sprint 011 session control plane | `submit()`, `steer()`, `followUp()`, `abort()`, `getState()`, `SessionState` | Prerequisite |
| Existing `AgentSession` | Foundation for child sessions | Implemented |
| Existing `ExecutionEnvironment` | Workspace boundary enforcement, file operations | Implemented |
| Existing tool registry | Registration for 4 new tools | Implemented |
| Existing event system | Event emission and engine bridging | Implemented |
| Existing `UnifiedClient` + provider adapters | Child sessions reuse same multi-provider client | Implemented |
| Existing `vitest` suite + scripted adapter | Deterministic coverage for parent/child scenarios | Implemented |
| `crypto.randomUUID()` | Agent ID generation | Built-in (Node 22) |

**Zero new npm dependencies.** All work composes existing session, tool, and event infrastructure.

---

## Gap Closure Summary

| Gap | Description | Severity | Status After Sprint |
|-----|-------------|----------|-------------------|
| C1 | Subagent tools (`spawn_agent`, `send_input`, `wait`, `close_agent`) | **HIGH** | **Closed** |
| C3 | Untruncated tool output in `TOOL_CALL_END` events | MEDIUM | **Closed** |
| A10 | Context `append_log()` method | LOW | **Closed** |

**After this sprint, zero HIGH-severity gaps remain across all three specs.**

**Next sprint candidates:**
- A1 (manager loop handler) — now unblocked by subagent infrastructure
- L9 (`generate()` high-level tool loop) — standalone SDK feature
- L4 (structured output) — foundation for swarm analysis
- L10 (Anthropic prompt caching) — cost reduction for all codergen sessions
