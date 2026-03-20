# Sprint 013: Subagent Tools — Parallel Task Delegation for Codergen Nodes

## Overview

**Goal:** Close the last high-severity coding-agent-loop gap (C1) by shipping spec-compliant subagent tools (`spawn_agent`, `send_input`, `wait`, `close_agent`) on top of a hardened, observable `AgentSession`. After this sprint, a codergen node can delegate scoped work to child agents, continue its own loop, steer children mid-flight, wait for results only when needed, and tear the whole tree down cleanly on abort or close.

**Why this sprint, why now:**

- `C1` is the only **HIGH-severity** gap in `docs/compliance-report.md`. No combination of MEDIUM gaps matches closing the only HIGH.
- `docs/INTENT.md` makes multi-step AI workflows a core product promise. Without delegation, every codergen node is a single-threaded worker that must serialize all work.
- Sprint 011 introduced the right control-plane concepts (`submit()`, `steer()`, `followUp()`, `abort()`, `SessionState` lifecycle), but the current implementation has live-session wiring gaps: profile-specific tool exposure is not actually used at runtime, environment/git prompt context is built but not injected, abort does not stop in-flight tools, and artifact metadata is incomplete. Adding subagents on top of that would create opaque background workers that are hard to supervise and harder to debug.

**This sprint is deliberately opinionated:** finish the control-plane wiring first, then add one level of bounded delegation, and stop.

**Gaps closed:**

| Gap | Severity | Description |
|-----|----------|-------------|
| C1 | **HIGH** | Subagent tools: `spawn_agent`, `send_input`, `wait`, `close_agent` |
| C3 | MEDIUM | Untruncated `TOOL_CALL_END` event for full transcript logging |
| A10 | Low | Context `append_log()` method for subagent activity logging |

**Total: 1 HIGH + 1 MEDIUM + 1 LOW = 3 gaps closed.**

**In scope:**

- Finish unfinished live-session wiring from Sprint 011 that subagents depend on
- Add a `SubagentManager` owned by each parent `AgentSession`
- Add `spawn_agent`, `send_input`, `wait`, and `close_agent` as real model-visible tools
- Dynamic per-turn tool visibility (hide subagent tools when inappropriate)
- Per-child budget controls (tool rounds, turns, timeout)
- Child-session lineage metadata on agent and engine event streams
- Per-child transcript/artifact storage under the codergen node run directory
- `working_dir` scoping through a `cwd`-aware execution environment
- Untruncated tool output on `TOOL_CALL_END` events (C3)
- Context `appendLog()` method (A10)

**Out of scope:**

- A1 manager loop handler (`house` / `stack.manager_loop`) — builds on subagents, next sprint candidate
- L9 high-level `generate()` SDK loop — orthogonal, defer to dedicated SDK sprint
- A4/A5 context fidelity runtime and `thread_id` session reuse
- A2 HTTP server mode and all Hive UI work
- L4, L7, L8, L10, L11 in the unified LLM client
- Recursive subagents beyond depth 1 (architecture supports deeper nesting, but default ships at 1)
- Cross-machine subagent distribution (local-only this sprint)
- Subagent-to-subagent communication (parent-mediated only)
- Automatic supervisor heuristics that spawn children without explicit model tool calls

**Cut-line:** If the sprint runs long, defer Phase 5 (cascading grandchild abort and per-child timeout enforcement). Do **not** ship partial subagent support without clean abort semantics, lineage metadata, and transcript/artifact persistence. The core spawn/send/wait/close lifecycle with depth and concurrency limits is the must-ship deliverable.

---

## Use Cases

1. **Parallel codebase exploration.** A codergen node needs both failing test coverage and implementation context. The parent agent spawns one child to inspect `test/` and another to inspect `src/`, keeps reasoning in the parent session, then calls `wait` on both handles and synthesizes the final plan. Total time is max(child1, child2) instead of child1 + child2.

2. **Focused work in a subdirectory.** The parent agent spawns a child with `working_dir="packages/cli"` and task `"add zsh completion tests"`. The child resolves relative paths from that subtree and runs shell commands from there, but the workspace boundary still blocks any escape outside the repo root.

3. **Mid-flight correction.** A child starts a broad refactor when the parent only wants a one-file fix. The parent calls `send_input(agent_id, "Stop refactoring. Only fix parser.ts and rerun its tests.")`. If the child is currently processing, that message lands as a steer before the next LLM call. If the child is idle/awaiting input, it becomes a queued follow-up.

4. **Code review loop.** A parent implements a feature, then spawns a reviewer:
   ```
   reviewer = spawn_agent({ task: "Review the changes in src/engine/ for correctness and test coverage gaps." })
   review = wait(reviewer)
   # Parent reads review feedback, addresses issues, re-runs tests
   ```

5. **Depth-limited recursion prevents runaway spawning.** A child agent tries to spawn its own child. The system checks depth and rejects: `"Maximum subagent depth (1) reached. Complete this task directly instead of delegating."` Additionally, `spawn_agent` is not even visible in the child's tool list (dynamic tool exposure), so well-behaved models never attempt it.

6. **Graceful shutdown.** The user aborts a run while a parent session has two active children and one in-flight shell command. Nectar cancels the active stream, kills the running command, aborts both children, flushes transcripts, emits terminal events, and leaves no orphaned child sessions behind.

---

## Architecture

### Design Principles

1. **Finish the parent before multiplying children.** Subagents are not worth shipping if the parent session still lies about its visible tools, drops transcript actions, or leaks processes on abort.

2. **A child agent is a real `AgentSession`, not a special callback.** Each child gets its own conversation, loop detector, event stream, transcript, and result object. Reuse the existing session machinery.

3. **Delegation is explicit and bounded.** The model must opt into spawning a child with a clear task. Default maximum nesting depth is 1. No recursive trees this sprint.

4. **Observability beats convenience.** Every child has its own artifact directory. Every bubbled event carries lineage metadata. The host can always reconstruct who spawned whom and what each child did.

5. **`working_dir` is a starting point, not a new trust boundary.** It changes the default relative path base and shell `cwd`, but all file resolution still stays inside the same workspace root.

### SubagentManager

Each `AgentSession` gets a lazily-created `SubagentManager` responsible for child-session lifecycle:

```text
Parent AgentSession
  ├── conversation / steer queue / follow-up queue
  ├── ToolRegistry
  │   ├── core tools (read/write/edit-or-patch/shell/grep/glob)
  │   └── subagent tools (spawn_agent, plus send_input/wait/close_agent when children exist)
  ├── TranscriptWriter
  └── SubagentManager
      ├── Map<agent_id, SubagentHandle>
      ├── config: SubagentConfig
      ├── spawn(task, opts?)
      ├── sendInput(agent_id, message)
      ├── wait(agent_ids)
      ├── close(agent_id)
      └── closeAll()
```

`SubagentHandle` carries:

- `id: string` (UUID)
- `session: AgentSession`
- `status: 'running' | 'completed' | 'failed' | 'timeout' | 'closed'`
- `working_dir: string`
- `started_at: string`
- `result_promise: Promise<SubagentResult>`
- `result?: SubagentResult` (cached when terminal)

`SubagentConfig`:

- `max_subagent_depth: number` (default 1)
- `max_concurrent_children: number` (default 4)
- `child_max_tool_rounds: number` (default 20)
- `child_max_turns: number` (default 5)
- `child_timeout_ms: number` (default 300,000 — 5 minutes)

### Dynamic Tool Exposure Per Turn

Tool exposure must become truthful at runtime. Each LLM turn rebuilds its tool definitions from:

1. The provider profile's core tool set (OpenAI gets `apply_patch`, Anthropic/Gemini get `edit_file`)
2. `spawn_agent` — only when `session_depth < max_subagent_depth`
3. `send_input`, `wait`, and `close_agent` — only when the session currently has active or completed child handles

| Session type | Visible editing tool | Visible subagent tools |
|--------------|----------------------|------------------------|
| OpenAI parent | `apply_patch` | `spawn_agent`, plus `send_input`/`wait`/`close_agent` when children exist |
| Anthropic parent | `edit_file` | same as above |
| Gemini parent | `edit_file` | same as above |
| Any child at max depth | provider-native editing tool | none |

This prevents models from hallucinating tool calls they can't make and reduces wasted tool-call attempts.

### Live Prompt Composition

`AgentSession` must rebuild the system prompt from real live tool list and real environment context before each LLM call:

1. Provider base prompt
2. Environment context block
3. Git snapshot block
4. Project instructions

This closes the unfinished Sprint 011 wiring and avoids the subtle failure mode where the model is told one set of tools but receives another.

### Tool Definitions

```typescript
// spawn_agent
{
  name: "spawn_agent",
  description: "Spawn a child agent to work on a subtask in parallel. Returns an agent_id for tracking.",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", description: "The task prompt for the child agent" },
      working_dir: { type: "string", description: "Working directory for the child (default: parent's cwd)" },
      max_tool_rounds: { type: "integer", description: "Max tool rounds for the child (default: 20)" },
      timeout_ms: { type: "integer", description: "Timeout in ms for the child session (default: 300000 / 5 min)" }
    },
    required: ["task"]
  }
}

// send_input
{
  name: "send_input",
  description: "Send a steering message to a running child agent, or a follow-up prompt to an awaiting child.",
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
  description: "Wait for one or more child agents to complete. Returns their results.",
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
  description: "Terminate a child agent session. Aborts if still processing. Idempotent.",
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
| `spawn_agent` | Creates a child session with `depth + 1`, starts it immediately via `child.submit(task)`, returns `{ agent_id, status, working_dir, model }`. |
| `send_input` | If child is PROCESSING: `child.steer(message)` → `{ status: "steered" }`. If child is AWAITING_INPUT: `child.followUp(message)` → `{ status: "follow_up_queued" }`. If child is terminal or unknown: tool error. |
| `wait` | Awaits child result promises via `Promise.allSettled`. Returns `{ agent_id, status, output, error?, usage }` per child. Output is a bounded summary; full output goes to artifacts only. |
| `close_agent` | If PROCESSING: `child.abort()`. If AWAITING_INPUT: `child.close()`. If already terminal: returns informational message (idempotent). Removes from active map. |

### Scoped Execution Environment

`ExecutionEnvironment` gains an explicit `cwd` concept while preserving `workspaceRoot` as the trust boundary:

- Relative paths resolve from `cwd`
- Absolute paths remain allowed if they stay inside `workspaceRoot`
- `exec()` runs with `cwd`
- `scoped(subdir)` returns a new environment instance rooted at the same workspace but with a different `cwd`
- Child workspace must be within the parent's workspace root (validated on `spawn_agent`)

### Depth Limiting

Each `AgentSession` carries a `depth: number` (0 for top-level sessions). When `spawn_agent` is called:

1. Check `current_depth + 1 <= max_subagent_depth` (default: 1)
2. If exceeded, return tool error: `"Maximum subagent depth (${max_depth}) reached. Complete this task directly."`
3. If allowed, child session is created with `depth: current_depth + 1`

Default depth of 1 allows: parent → child. The architecture tracks depth as an integer so the default can be raised in future sprints once subagents are proven in real workflows.

### Concurrency Limiting

`max_concurrent_children` (default: 4) bounds the number of simultaneously active children per parent. When the limit is hit, `spawn_agent` returns a tool error: `"Maximum concurrent children (${max_concurrent_children}) reached. Wait for existing children to complete before spawning more."`

Completed children free concurrency slots when:
- The parent calls `wait` and the child result is collected
- The parent calls `close_agent`
- The child completes naturally and is evicted from active tracking

### Budget Controls

Each child session has independent limits:
- `max_tool_rounds`: default 20 (children should be focused subtasks)
- `max_turns`: default 5 (children handle subtasks, not multi-turn conversations)
- `timeout_ms`: default 300,000 (5 minutes)

All defaults overridable per `spawn_agent` call.

### Event Model

Every agent event carries lineage metadata for nested observability:

- `session_id`
- `root_session_id`
- `parent_session_id` (when emitted by a child)
- `agent_depth`
- `artifact_path` (on tool-completion events)

Explicit subagent lifecycle events:

```typescript
interface SubagentSpawnedEvent {
  type: 'subagent_spawned';
  session_id: string;
  parent_session_id: string;
  root_session_id: string;
  agent_id: string;
  task: string;
  depth: number;
  timestamp: string;
}

interface SubagentCompletedEvent {
  type: 'subagent_completed';
  session_id: string;
  parent_session_id: string;
  root_session_id: string;
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

Child events bubble through the parent's event emitter with lineage metadata — the parent sees child tool calls in real time. Events are bridged to the engine-level `RunEvent` stream for CLI renderer and future consumers.

### Untruncated Tool Output (C3)

The internal tool execution loop preserves the original, untruncated tool output. `AgentToolCallCompletedEvent` includes `full_output: string` alongside the truncated `output` sent to the model. `TranscriptWriter` uses the untruncated output for artifact files; the LLM context receives only the truncated version.

### Transcript Layout

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
│   │   └── ...
│   └── 003-wait/
│       ├── request.json
│       └── result.json
└── subagents/
    ├── <agent_id_1>/
    │   ├── prompt.md
    │   ├── response.md
    │   ├── status.json
    │   ├── result.json
    │   ├── transcript.jsonl
    │   └── tool-calls/
    └── <agent_id_2>/
        └── ...
```

Parent transcripts also record control actions: `steer`, `follow_up`, `subagent_spawn`, `subagent_wait`, `subagent_close`. As part of the hardening pass, `apply_patch` artifacts persist `patch.txt`, and tool-completion events expose `artifact_path`.

### Abort and Cleanup

Parent shutdown is single-path and deterministic:

1. Cancel the active LLM stream
2. Propagate the abort signal to the current tool invocation
3. Abort all running child sessions
4. Await bounded child cleanup (2s SIGKILL escalation)
5. Flush transcript/status artifacts
6. Emit final session events
7. Transition to CLOSED

If a child fails naturally, the parent does **not** automatically fail. Child success/failure becomes data surfaced through `wait`. The model decides how to react.

Auto-cleanup: when parent session transitions to CLOSED or completes, `manager.closeAll()` aborts any remaining live children. No orphaned child sessions.

---

## Implementation Phases

### Phase 1: Finish Live Session Wiring (~20%)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/transcript.ts`, `src/agent-loop/tools/shell.ts`, `src/handlers/codergen.ts`, `src/engine/events.ts`, related tests

**Tasks:**

- [ ] Make live sessions use profile-filtered tool definitions instead of `registry.definitions()`
- [ ] Build the system prompt with `buildFullSystemPrompt(...)` in the real session path, not just in helper tests
- [ ] Recompute visible tool names per turn so the prompt and actual tool list stay aligned
- [ ] Propagate abort signals into shell execution so `abort()` actually stops in-flight commands
- [ ] Wire the real default command timeout into `env.exec()` and keep Anthropic's profile override
- [ ] Record follow-up actions in `transcript.jsonl`
- [ ] Persist `patch.txt` alongside `request.json` and `result.json` for `apply_patch`
- [ ] Emit `artifact_path`, `session_id`, and `workspace_root` from real runtime events
- [ ] Get the branch back to a green `npm run build` / `npm test` baseline before layering delegation on top

### Phase 2: SubagentManager, Scoped Environments & Spawn (~25%)

**Files:** `src/agent-loop/subagent-manager.ts`, `src/agent-loop/types.ts`, `src/agent-loop/session.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/tools/spawn-agent.ts`, `src/agent-loop/provider-profiles.ts`, `test/agent-loop/subagent-manager.test.ts`

**Tasks:**

- [ ] Define `SubagentConfig` on session config: `max_subagent_depth` (default 1), `max_concurrent_children` (default 4), `child_max_tool_rounds` (default 20), `child_max_turns` (default 5), `child_timeout_ms` (default 300,000)
- [ ] Add `depth: number` to `AgentSession` constructor options (default 0)
- [ ] Create `SubagentManager` class:
  - `spawn(task, opts?): Promise<{ agent_id: string }>` — creates child `AgentSession` with `depth + 1`, starts `child.submit(task)`, stores result promise
  - `getChild(agent_id): SubagentHandle | undefined`
  - `getActiveCount(): number`
  - `closeAll(): Promise<void>` — aborts all live children
  - Internal `activeChildren: Map<string, SubagentHandle>`
- [ ] Enforce depth limit: if `depth + 1 > max_subagent_depth`, return tool error
- [ ] Enforce concurrency limit: if `activeChildren.size >= max_concurrent_children`, return tool error
- [ ] Add `cwd` and `scoped(subdir)` to `ExecutionEnvironment` — `working_dir` affects both file tools and shell commands
- [ ] Validate workspace override: child `working_dir` must be within parent's `workspaceRoot`
- [ ] Create `spawn-agent.ts` tool wrapper: JSON schema, calls `manager.spawn()`, returns `{ agent_id, status, working_dir, model }`
- [ ] Add lazy `SubagentManager` to `AgentSession`: created on first subagent tool call
- [ ] Child sessions inherit parent's provider profile, execution environment, and event emitter
- [ ] Add subagent tools to provider profiles with dynamic visibility (hide `spawn_agent` at max depth; hide management tools when no children exist)
- [ ] Register subagent tools in the tool registry, classified as `mutating`
- [ ] Tests:
  - Spawn creates a child session with correct depth
  - Depth limit enforced — returns error, not exception
  - Concurrency limit enforced
  - Child inherits provider profile
  - Dynamic tool visibility: `spawn_agent` hidden at max depth, management tools hidden with no children
  - `working_dir` changes relative-path resolution and shell `cwd`
  - Workspace override boundary: out-of-root paths rejected
  - Multiple spawns produce unique agent_ids

### Phase 3: Send Input, Wait & Close (~25%)

**Files:** `src/agent-loop/tools/send-input.ts`, `src/agent-loop/tools/wait.ts`, `src/agent-loop/tools/close-agent.ts`, `src/agent-loop/subagent-manager.ts`, `test/agent-loop/subagent-lifecycle.test.ts`, `test/agent-loop/subagent-cleanup.test.ts`

**Tasks:**

- [ ] Implement `SubagentManager.sendInput(agent_id, message)`:
  - If child is PROCESSING: call `child.steer(message)`, return `{ status: "steered" }`
  - If child is AWAITING_INPUT: call `child.followUp(message)`, return `{ status: "follow_up_queued" }`
  - If child is CLOSED: return tool error `"Child ${agent_id} is already closed"`
  - If agent_id unknown: return tool error `"Unknown agent_id: ${agent_id}"`
- [ ] Create `send-input.ts` tool wrapper
- [ ] Implement `SubagentManager.wait(agent_ids)`:
  - Normalize single ID to array
  - Validate all IDs exist (return tool error for unknown IDs)
  - Handle edge cases: empty array, duplicate IDs
  - `await Promise.allSettled(children.map(c => c.resultPromise))`
  - Collect results: for each child, produce `{ agent_id, status, output, error?, usage }`
  - `output` is a bounded summary of the child's final assistant message (full output to artifacts only)
  - `status` derived from child session result: success/failure/timeout/aborted
  - Already-completed children return cached result immediately
- [ ] Create `wait.ts` tool wrapper
- [ ] Implement `SubagentManager.close(agent_id)`:
  - If PROCESSING: call `child.abort()`, remove from active map
  - If AWAITING_INPUT: call `child.close()`, remove from active map
  - If already terminal or unknown: return informational message (idempotent)
- [ ] Create `close-agent.ts` tool wrapper
- [ ] Auto-cleanup: when parent session transitions to CLOSED or completes, call `manager.closeAll()` for any remaining live children
- [ ] Wire abort propagation into `AgentSession.abort()`: if manager exists, call `manager.closeAll()` before transitioning to CLOSED
- [ ] Tests:
  - send_input steers a PROCESSING child
  - send_input follows up on an AWAITING_INPUT child
  - send_input to unknown agent_id returns error
  - send_input to closed child returns error
  - wait single child returns result
  - wait multiple children returns all results
  - wait with one failed child still returns other results
  - wait on already-completed child returns immediately
  - wait with empty array, duplicate IDs handled gracefully
  - close_agent aborts a processing child
  - close_agent closes an awaiting child
  - close_agent on already-closed child is idempotent
  - Parent session completion auto-closes live children
  - Parent abort propagates to all children
  - No orphaned child sessions after parent shutdown

### Phase 4: Events, Transcripts, Context Logging & C3 (~20%)

**Files:** `src/agent-loop/events.ts`, `src/agent-loop/transcript.ts`, `src/engine/events.ts`, `src/engine/context.ts`, `src/handlers/codergen.ts`, `test/agent-loop/subagent-events.test.ts`, `test/engine/context.test.ts`

**Tasks:**

- [ ] Define subagent event types: `SubagentSpawnedEvent`, `SubagentCompletedEvent`, `SubagentMessageEvent` with full lineage metadata (`session_id`, `root_session_id`, `parent_session_id`, `agent_depth`)
- [ ] Emit events from `SubagentManager`: spawn, completion, and message delivery
- [ ] Child sessions' events bubble up through the parent's event emitter with lineage metadata
- [ ] Bridge subagent events to engine-level `RunEvent` stream (CLI renderer needs them)
- [ ] Extend `TranscriptWriter` to create nested `subagents/<agent_id>/` directories
- [ ] Child sessions write their own transcripts (prompt.md, response.md, tool-calls/) under the nested directory
- [ ] Implement untruncated tool output (C3): preserve original output in `AgentToolCallCompletedEvent.full_output`, transcript writes use full output, LLM context receives truncated version
- [ ] Implement `ExecutionContext.appendLog(entry: string)` (gap A10):
  - Maintains an append-only `run_log: string[]` on the context
  - Subagent spawns, completions, and errors are logged
  - Accessible via `context.getLog()` method
  - Define serialization for string-only context model (JSON-encoded array in reserved key `_run_log`)
- [ ] Update `CodergenHandler` to pass `depth` from parent context and bridge nested events/artifacts into run events
- [ ] Tests:
  - SubagentSpawned event emitted on spawn with correct lineage metadata
  - SubagentCompleted event emitted on child finish
  - SubagentMessage event emitted on steer/follow-up delivery
  - Child events contain correct parent_session_id and root_session_id
  - Nested transcript directories created correctly with expected artifacts
  - Deterministic transcript and engine-event assertions for nested child runs
  - Untruncated tool output available on events and in artifacts, truncated version in LLM context
  - appendLog adds entries, getLog retrieves them, serialization through context clone works
  - Engine events include subagent activity with lineage

### Phase 5: Timeout Enforcement & Cascading Abort (Deferrable — ~10%)

**Files:** `src/agent-loop/subagent-manager.ts`, `src/agent-loop/session.ts`, `test/agent-loop/subagent-abort.test.ts`

**Tasks:**

- [ ] Implement per-child timeout via `Promise.race()` between the child's result promise and a `setTimeout`:
  - On timeout: abort child, resolve the result promise with `{ status: 'timeout', output: 'Child agent timed out after ${timeout_ms}ms' }`
  - Timeout timer is cleared when child completes normally
- [ ] Handle AbortController signal propagation: parent's abort signal is linked to child sessions
- [ ] Edge case: parent aborted while `wait()` is pending — the wait tool call should reject, parent model receives error result
- [ ] Edge case: child spawns grandchild (when depth > 1 in future), parent aborts — verify full tree teardown
- [ ] Tests:
  - Timeout fires and aborts child correctly
  - Timeout timer cancelled on normal completion
  - Parent abort during wait rejects cleanly
  - No orphaned child processes after any shutdown path

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/subagent-manager.ts` | Create | Core SubagentManager: spawn, send, wait, close, limits, cleanup |
| `src/agent-loop/tools/spawn-agent.ts` | Create | `spawn_agent` tool schema and handler |
| `src/agent-loop/tools/send-input.ts` | Create | `send_input` tool schema and handler |
| `src/agent-loop/tools/wait.ts` | Create | `wait` tool schema and handler |
| `src/agent-loop/tools/close-agent.ts` | Create | `close_agent` tool schema and handler |
| `src/agent-loop/session.ts` | Modify | Dynamic tool visibility, live prompt rebuild, lazy SubagentManager, depth field, deterministic abort cleanup |
| `src/agent-loop/types.ts` | Modify | `SubagentConfig`, `depth`, `SubagentHandle`, `SubagentResult`, budget defaults |
| `src/agent-loop/events.ts` | Modify | Lineage metadata, subagent lifecycle events, untruncated `full_output` (C3) |
| `src/agent-loop/execution-environment.ts` | Modify | `cwd`-aware path resolution, `scoped()` method, timeout/abort wiring |
| `src/agent-loop/provider-profiles.ts` | Modify | Full prompt builder in live sessions, dynamic subagent tool visibility |
| `src/agent-loop/transcript.ts` | Modify | Record follow-ups/control actions, persist `patch.txt`, nested `subagents/<agent_id>/` dirs, full tool output |
| `src/agent-loop/tools/shell.ts` | Modify | Session-aware timeout and abort signal for shell execution |
| `src/engine/context.ts` | Modify | `appendLog()` / `getLog()` methods (A10) |
| `src/engine/events.ts` | Modify | Subagent event bridging, lineage metadata preservation |
| `src/handlers/codergen.ts` | Modify | Construct SubagentManager, pass depth, register tools, bridge nested events/artifacts |
| `test/agent-loop/subagent-manager.test.ts` | Create | Manager spawn, depth/concurrency limits, dynamic tool visibility |
| `test/agent-loop/subagent-lifecycle.test.ts` | Create | send_input, wait, result collection, edge cases |
| `test/agent-loop/subagent-cleanup.test.ts` | Create | close, auto-cleanup, orphan prevention |
| `test/agent-loop/subagent-events.test.ts` | Create | Event emission, lineage metadata, transcript nesting |
| `test/agent-loop/subagent-abort.test.ts` | Create | Timeout, cascading abort, tree teardown |
| `test/agent-loop/session-control.test.ts` | Modify | Abort cleanup, dynamic tool exposure, follow-up transcript persistence |
| `test/agent-loop/environment-context.test.ts` | Modify | Environment/git blocks in live sessions, scoped cwd |
| `test/agent-loop/apply-patch-integration.test.ts` | Modify | `patch.txt` and artifact-path wiring |
| `test/engine/context.test.ts` | Modify | appendLog / getLog tests |
| `test/handlers/codergen.test.ts` | Modify | Nested event bridging and child artifact locations |
| `test/helpers/scripted-adapter.ts` | Modify | Support deterministic parent/child scripted responses |
| `test/integration/agent-loop.test.ts` | Modify | End-to-end parent/child delegation scenarios |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing single-session `processInput()` / `submit()` behavior unchanged

### Session Hardening (Phase 1)
- [ ] Live OpenAI sessions expose `apply_patch` and do **not** expose `edit_file`
- [ ] Live Anthropic and Gemini sessions expose `edit_file` and do **not** expose `apply_patch`
- [ ] Real agent sessions include environment context and git snapshot blocks in the system prompt when available
- [ ] `followUp()` writes a transcript entry in `transcript.jsonl`
- [ ] `apply_patch` writes `patch.txt` into the tool-call artifact directory
- [ ] Abort stops in-flight shell commands

### Subagent Tools (C1)
- [ ] `spawn_agent` creates a child session and returns an `agent_id`
- [ ] `send_input` steers a PROCESSING child or follows up on an AWAITING_INPUT child
- [ ] `wait` blocks until specified children complete and returns their results (bounded summaries)
- [ ] `wait` supports both single agent_id (string) and multiple (array)
- [ ] `wait` handles edge cases: empty array, duplicate IDs, unknown IDs, already-completed children
- [ ] `close_agent` aborts/closes a child session (idempotent)
- [ ] All four tools registered and visible through the correct provider profiles

### Dynamic Tool Visibility
- [ ] `spawn_agent` hidden when `session_depth >= max_subagent_depth`
- [ ] `send_input`, `wait`, `close_agent` hidden when no children exist
- [ ] Tool list and system prompt rebuilt per turn to stay aligned

### Depth & Concurrency Limiting
- [ ] `depth` tracked on every `AgentSession` (0 for top-level)
- [ ] `spawn_agent` rejected with tool error when `depth + 1 > max_subagent_depth` (default 1)
- [ ] Child sessions created with `depth: parent_depth + 1`
- [ ] `spawn_agent` rejected with tool error when `max_concurrent_children` (default 4) reached
- [ ] Completed children free concurrency slots

### Budget Controls
- [ ] Child `max_tool_rounds` defaults to 20
- [ ] Child `max_turns` defaults to 5
- [ ] Child `timeout_ms` defaults to 300,000 (5 minutes)
- [ ] All defaults overridable per `spawn_agent` call

### Scoped Execution Environment
- [ ] `working_dir` changes relative-path resolution and shell `cwd` while enforcing workspace-root boundary
- [ ] Out-of-root workspace overrides rejected with error
- [ ] `ExecutionEnvironment.scoped(subdir)` returns a correctly rooted environment

### Lifecycle & Cleanup
- [ ] Parent session completion auto-aborts live children
- [ ] Parent `abort()` cascades to all children via `manager.closeAll()`
- [ ] No orphaned child sessions after any shutdown path (completion, failure, close, abort)
- [ ] Children inherit provider profile and execution environment from parent

### Events & Transcripts
- [ ] `SubagentSpawnedEvent` emitted on spawn with `session_id`, `parent_session_id`, `root_session_id`, `agent_depth`
- [ ] `SubagentCompletedEvent` emitted on child completion
- [ ] `SubagentMessageEvent` emitted on steer/follow-up delivery
- [ ] Child transcripts written under `subagents/<agent_id>/` nested directory
- [ ] Child tool calls visible in parent agent event stream with lineage metadata
- [ ] Subagent events bridged to engine-level RunEvent stream
- [ ] Tool-completion events expose full untruncated output (C3) to host and truncated to model
- [ ] `artifact_path` present on tool-completion events

### Context Logging (A10)
- [ ] `ExecutionContext.appendLog(entry)` appends to an immutable run log
- [ ] `ExecutionContext.getLog()` returns the full log array
- [ ] Subagent spawns and completions are logged to context
- [ ] Log survives context clone/restore through serialization

### Integration Tests
- [ ] End-to-end test: parent spawns multiple children, waits for both, finishes with correct answer
- [ ] End-to-end test: parent spawns, steers, and closes a child
- [ ] Deterministic transcript and engine-event assertions for nested child runs
- [ ] At least 35 new tests across subagent manager, tools, lifecycle, events, cleanup, abort

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Parent/child abort races leave orphaned shell processes** | Medium | High | One shutdown path: stream cancel → tool abort → child abort → bounded cleanup → flush → final event → CLOSED. Test with long-running shell commands. |
| **Models spawn children too eagerly and waste turns** | High | Medium | Conservative defaults: max depth 1, max 4 concurrent, child tool rounds 20. Error messages guide the model to work directly. Tool descriptions explicit about when delegation is worthwhile. |
| **Child sessions consume excessive tokens, inflating cost** | Medium | High | Per-child budget limits (`max_tool_rounds`, `max_turns`, `timeout_ms`). Parent session's `Usage` aggregates child usage for accurate cost reporting. |
| **Dynamic tool visibility changes confuse the model** | Medium | Medium | Rebuild prompt + tool definitions every turn. Never hide `wait`/`close_agent` while active children exist. Prompt stays aligned with actual tool list. |
| **`working_dir` semantics become inconsistent across tools** | Medium | High | Put `cwd` in `ExecutionEnvironment`, not in ad hoc tool wrappers. Add tests covering read, write, and shell operations with scoped cwd. |
| **Child modifies files that parent is also editing** | Medium | High | Same-workspace children share filesystem. Document that parents should scope children to non-overlapping directories via task instructions. No filesystem locking this sprint. |
| **Large child outputs bloat parent context** | Medium | Medium | `wait` returns bounded summaries, not full transcripts. Full output goes to artifacts only. |
| **Phase 1 (session hardening) overruns its budget** | Medium | Medium | Phase 1 is capped at ~20%. If it overruns, Phase 5 (timeout enforcement) is the explicit cut target. The core subagent lifecycle ships regardless. |
| **Child event fan-out becomes noisy or duplicated** | Medium | Medium | Lineage metadata on every event. Assert exact event counts in integration tests. |
| **Completed children retained in memory blocking new spawns** | Low | Medium | Completed children evicted from active tracking on `wait` collection, `close_agent`, or parent shutdown. Explicit slot-release logic in SubagentManager. |
| **Subagent cleanup bugs corrupt parent transcripts** | Low | High | Give every child its own transcript root. Append parent control records only after child operations reach a durable state. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| Sprint 011 session control plane | `submit()`, `steer()`, `followUp()`, `abort()`, `getState()`, `SessionState` | Prerequisite |
| Existing `AgentSession` | Foundation for child sessions | Implemented |
| Existing `ExecutionEnvironment` | Workspace boundary enforcement, file operations | Implemented |
| Existing tool registry | Registration for 4 new tools | Implemented |
| Existing event system | Event emission and engine bridging | Implemented |
| Existing `UnifiedClient` + provider adapters | Child sessions reuse the same multi-provider client | Implemented |
| Existing `execa` integration | Abortable shell execution | Implemented |
| Existing `ajv` validation in `ToolRegistry` | Validates new subagent tool inputs | Implemented |
| Existing `vitest` suite + scripted adapter | Deterministic parent/child lifecycle testing | Implemented |
| `crypto.randomUUID()` | Child ID generation | Built-in (Node 22) |

**Zero new npm dependencies.** All work uses existing session infrastructure. The subagent layer is a composition of existing primitives (sessions, tools, events) into a management layer.

---

## Gap Closure Summary

| Gap | Description | Severity | Status After Sprint |
|-----|-------------|----------|-------------------|
| C1 | Subagent tools (`spawn_agent`, `send_input`, `wait`, `close_agent`) | **HIGH** | **Closed** |
| C3 | Untruncated `TOOL_CALL_END` event for full transcript logging | MEDIUM | **Closed** |
| A10 | Context `append_log()` method | Low | **Closed** |

**1 HIGH + 1 MEDIUM + 1 LOW gap closed. 3 total.**

**After this sprint, zero HIGH-severity gaps remain across all three specs.**

**Next sprint candidates:**
- A1 (manager loop handler) — now unblocked by subagent infrastructure
- L9 (high-level `generate()` loop) — SDK convenience, orthogonal to subagents
- L4 (structured output) — foundation for swarm analysis
- L10 (Anthropic prompt caching) — cost reduction for all codergen sessions
- A4/A5 (context fidelity runtime) — quality improvement for long pipelines
