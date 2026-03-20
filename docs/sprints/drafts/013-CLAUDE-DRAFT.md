# Sprint 012: Subagent Tools — Parallel Task Delegation for Codergen Nodes

## Overview

**Goal:** Implement the four subagent tools (`spawn_agent`, `send_input`, `wait`, `close_agent`) so a codergen node can decompose work into parallel child sessions with independent workspaces, depth-limited recursion, and failure isolation. After this sprint, a codergen agent can spawn children for tasks like "implement feature X while I write the tests," observe their progress, inject steering, and collect their results — all within a single pipeline node execution.

**Why this sprint, why now:**

The compliance report identifies **one HIGH-severity gap** across all three specs: **C1 — subagent tools**. Everything else is MEDIUM or LOW. This is the single largest remaining compliance deficit, and it's the feature that transforms codergen from a single-threaded prompt executor into a delegating supervisor capable of real software engineering workflows.

Concretely, without subagents:
- A codergen node that needs to implement a feature and write tests does both sequentially, doubling wall-clock time
- A codergen node cannot ask a specialist child (e.g., "only write unit tests for this module") to focus on a subtask while the parent handles the integration
- The manager loop handler (A1, MEDIUM gap) cannot be built — it depends on subagent spawning and observation
- Multi-agent code review (parent writes, child reviews, parent addresses feedback) is impossible

Sprint 011 shipped the session control plane: `submit()`, `followUp()`, `steer()`, `abort()`, `getState()`, `SessionState` lifecycle, and persistent conversation history. This is exactly the infrastructure subagents need — a controllable, observable session that a parent can manage. Building subagents before the control plane would have meant reimplementing half of Sprint 011 inside the subagent layer.

**Gaps closed:**

| Gap | Severity | Description |
|-----|----------|-------------|
| C1 | **HIGH** | Subagent tools: `spawn_agent`, `send_input`, `wait`, `close_agent` |
| A10 | Low | Context `append_log()` method (needed for subagent activity logging) |

**Total: 1 HIGH + 1 LOW = 2 gaps closed.**

The single HIGH gap closure makes this the highest-impact sprint possible by severity-weighted gap count. No combination of MEDIUM gaps matches closing the only HIGH.

**Out of scope:**
- A1 manager loop handler (builds on subagents — next sprint candidate)
- A4/A5 context fidelity runtime and thread resolution
- L4 structured output, L7 middleware, L8 model catalog
- L10 Anthropic prompt caching, L11 beta headers
- HTTP server mode, web UI, seedbed swarm analysis
- Cross-machine subagent distribution (local-only this sprint)
- Subagent-to-subagent communication (parent-mediated only)

**Cut-line:** If the sprint runs long, cut Phase 5 (abort propagation and timeout enforcement). The core spawn/send/wait/close lifecycle, workspace isolation, and depth limiting are the must-ship deliverables.

---

## Use Cases

1. **Parallel implementation and testing.** A codergen node is tasked with adding a feature. The parent agent analyzes the requirements, then:
   ```
   child_impl = spawn_agent({ task: "Implement the rate limiter in src/middleware/", workspace: "." })
   child_test = spawn_agent({ task: "Write tests for the rate limiter in test/middleware/", workspace: "." })
   wait([child_impl, child_test])
   # Both finish in ~parallel wall-clock time
   ```
   The parent agent reviews both results and handles integration. Total time is max(impl, tests) instead of impl + tests.

2. **Specialist delegation.** A parent agent is writing a complex module. It encounters a failing test it didn't write. Instead of context-switching, it spawns a child:
   ```
   child = spawn_agent({ task: "Fix the failing test in test/parser.test.ts line 42. Do not modify src/ files." })
   send_input(child, "Focus only on the test expectations, not the implementation.")
   result = wait(child)
   ```
   The parent continues its primary task while the child handles the fix in a constrained scope.

3. **Code review loop.** A parent implements a feature, then spawns a reviewer:
   ```
   reviewer = spawn_agent({ task: "Review the changes in src/engine/ for correctness, edge cases, and test coverage gaps." })
   review = wait(reviewer)
   # Parent reads review feedback, addresses issues, re-runs tests
   ```

4. **Depth-limited recursion prevents runaway spawning.** A subagent tries to spawn its own child. The system checks `current_depth + 1 <= max_depth` (default 3). If exceeded, the `spawn_agent` tool returns an error result: "Maximum subagent depth (3) reached. Complete this task directly instead of delegating." The agent adapts and works directly.

5. **Parent steers a slow child.** A child agent is taking too long exploring irrelevant files. The parent calls:
   ```
   send_input(child, "Stop exploring. The relevant code is in src/garden/parse.ts lines 100-200. Focus there.")
   ```
   This uses the session's `steer()` mechanism from Sprint 011 — the message is injected before the child's next LLM call.

6. **Clean shutdown on pipeline cancellation.** The pipeline receives SIGINT. The engine checkpoints. The codergen handler calls `abort()` on the parent session. The parent session propagates abort to all live child sessions. Children terminate their in-flight tool calls (2s SIGKILL escalation) and transition to CLOSED. No orphaned processes.

---

## Architecture

### Subagent Lifecycle

```text
Parent Session (PROCESSING)
    |
    | spawn_agent({ task, workspace?, max_tools?, timeout? })
    v
SubagentManager.spawn()
    |-- check depth limit (current_depth + 1 <= max_depth)
    |-- create child AgentSession with inherited provider profile
    |-- assign child_id (UUID)
    |-- register in active children map
    |-- start child.submit(task) (non-blocking)
    v
Return { child_id } to parent model

Parent continues processing...
    |
    | send_input(child_id, message)
    v
SubagentManager.sendInput(child_id, message)
    |-- child.steer(message) if PROCESSING
    |-- child.followUp(message) if AWAITING_INPUT
    v
Return { status: "delivered" }

Parent continues processing...
    |
    | wait(child_id) or wait([child_id_1, child_id_2])
    v
SubagentManager.wait(child_ids)
    |-- await all specified children's result promises
    |-- collect results: { child_id, status, output, usage }
    v
Return collected results to parent model

Parent processes results...
    |
    | close_agent(child_id)  (optional — auto-closed on parent completion)
    v
SubagentManager.close(child_id)
    |-- child.close() if AWAITING_INPUT
    |-- child.abort() if PROCESSING
    |-- remove from active children
    v
Return { status: "closed" }
```

### SubagentManager

Each `AgentSession` optionally owns a `SubagentManager` instance, created lazily on first `spawn_agent` call. The manager:

- Tracks active children: `Map<string, ChildEntry>` where `ChildEntry = { session: AgentSession, resultPromise: Promise<SessionResult>, depth: number }`
- Enforces depth limit: parent's `depth + 1` must not exceed `max_depth` (default 3, configurable on session config)
- Enforces concurrency limit: `max_concurrent_children` (default 4) prevents unbounded parallel spawning
- Inherits provider profile from parent (children use the same LLM provider/model unless overridden by the pipeline node)
- Shares the `ExecutionEnvironment` — children operate in the same workspace unless a `workspace` override is specified in `spawn_agent`
- Propagates abort: when parent session is aborted, all live children are aborted

### Tool Definitions

```typescript
// spawn_agent
{
  name: "spawn_agent",
  description: "Spawn a child agent to work on a subtask in parallel. Returns a child_id for tracking.",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", description: "The task prompt for the child agent" },
      workspace: { type: "string", description: "Working directory for the child (default: parent's workspace)" },
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
      child_id: { type: "string" },
      message: { type: "string" }
    },
    required: ["child_id", "message"]
  }
}

// wait
{
  name: "wait",
  description: "Wait for one or more child agents to complete. Returns their results.",
  input_schema: {
    type: "object",
    properties: {
      child_ids: {
        oneOf: [
          { type: "string", description: "Single child_id" },
          { type: "array", items: { type: "string" }, description: "Multiple child_ids" }
        ]
      }
    },
    required: ["child_ids"]
  }
}

// close_agent
{
  name: "close_agent",
  description: "Terminate a child agent session. Aborts if still processing.",
  input_schema: {
    type: "object",
    properties: {
      child_id: { type: "string" }
    },
    required: ["child_id"]
  }
}
```

### Workspace Isolation

Children share the parent's `ExecutionEnvironment` by default. The `workspace` parameter on `spawn_agent` allows scoping a child to a subdirectory, but it's still the same filesystem — not a sandbox. This matches the threat model from Sprint 001: DOT files are trusted local automation.

If the parent's execution environment has workspace boundary enforcement (path traversal prevention), the child inherits those boundaries. A child workspace override must be within the parent's workspace root.

### Depth Limiting

Each `AgentSession` carries a `depth: number` (0 for top-level sessions created by `CodergenHandler`). When `spawn_agent` is called:

1. Check `current_depth + 1 <= max_depth` (default: 3)
2. If exceeded, return tool error: `"Maximum subagent depth (${max_depth}) reached. Complete this task directly."`
3. If allowed, child session is created with `depth: current_depth + 1`

This prevents infinite delegation chains. The default depth of 3 allows: parent → child → grandchild. Deeper nesting is a code smell and usually indicates the task decomposition is wrong.

### Concurrency Limiting

`max_concurrent_children` (default: 4) bounds the number of simultaneously active children per parent. This prevents a model from spawning 20 children in a tight loop. When the limit is hit, `spawn_agent` returns a tool error: `"Maximum concurrent children (${max_concurrent_children}) reached. Wait for existing children to complete before spawning more."`

### Budget Controls

Each child session has independent limits:
- `max_tool_rounds`: default 20 (less than the parent default of 50 — children should be focused)
- `max_turns`: default 5 (children handle subtasks, not multi-turn conversations)
- `timeout_ms`: default 300,000 (5 minutes — prevents hung children from blocking the parent indefinitely)

These defaults are overridable per `spawn_agent` call.

### Event Model

Subagent events integrate with the existing event system from Sprint 011:

```typescript
interface SubagentSpawnedEvent {
  type: 'subagent_spawned';
  parent_session_id: string;
  child_session_id: string;
  child_id: string;  // the tool-visible ID
  task: string;
  depth: number;
  timestamp: string;
}

interface SubagentCompletedEvent {
  type: 'subagent_completed';
  parent_session_id: string;
  child_session_id: string;
  child_id: string;
  status: 'success' | 'failure' | 'timeout' | 'aborted';
  usage: Usage;
  timestamp: string;
}

interface SubagentMessageEvent {
  type: 'subagent_message';
  parent_session_id: string;
  child_id: string;
  direction: 'parent_to_child' | 'child_to_parent';
  message_type: 'steer' | 'follow_up' | 'result';
  timestamp: string;
}
```

These flow through the engine's event bridge so the CLI renderer and future HTTP SSE stream can observe subagent activity.

### Transcript Layout

Subagent activity is persisted under the parent node's run directory:

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
    ├── <child_id_1>/
    │   ├── prompt.md
    │   ├── response.md
    │   ├── transcript.jsonl
    │   └── tool-calls/
    └── <child_id_2>/
        └── ...
```

Each child's transcript is a nested directory under `subagents/`. This makes the full execution tree inspectable from the filesystem.

### Module Layout — New and Modified Files

```text
src/agent-loop/
├── subagent-manager.ts        CREATE — SubagentManager class, lifecycle, limits
├── session.ts                 MODIFY — lazy SubagentManager creation, abort propagation
├── types.ts                   MODIFY — depth, subagent config, child budget defaults
├── events.ts                  MODIFY — subagent event types
├── provider-profiles.ts       MODIFY — subagent tools in visible tool lists
├── transcript.ts              MODIFY — nested subagent transcript directories
└── tools/
    ├── spawn-agent.ts         CREATE — spawn_agent tool schema and handler
    ├── send-input.ts          CREATE — send_input tool schema and handler
    ├── wait.ts                CREATE — wait tool schema and handler
    └── close-agent.ts         CREATE — close_agent tool schema and handler

src/engine/
├── context.ts                 MODIFY — append_log() method (A10)
└── events.ts                  MODIFY — subagent event bridging

src/handlers/
└── codergen.ts                MODIFY — pass depth, register subagent tools
```

---

## Implementation

### Phase 1: SubagentManager & Spawn (~30%)

**Files:** `src/agent-loop/subagent-manager.ts`, `src/agent-loop/types.ts`, `src/agent-loop/tools/spawn-agent.ts`, `src/agent-loop/session.ts`, `src/agent-loop/provider-profiles.ts`, `test/agent-loop/subagent-manager.test.ts`

**Tasks:**
- [ ] Define `SubagentConfig` on session config: `max_depth` (default 3), `max_concurrent_children` (default 4), `child_max_tool_rounds` (default 20), `child_max_turns` (default 5), `child_timeout_ms` (default 300,000)
- [ ] Add `depth: number` to `AgentSession` constructor options (default 0)
- [ ] Create `SubagentManager` class:
  - `spawn(task, opts?): Promise<{ child_id: string }>` — creates child `AgentSession` with `depth + 1`, starts `child.submit(task)`, stores result promise
  - `getChild(child_id): ChildEntry | undefined`
  - `getActiveCount(): number`
  - `abortAll(): Promise<void>` — aborts all live children
  - Internal `activeChildren: Map<string, ChildEntry>`
- [ ] Enforce depth limit: if `depth + 1 > max_depth`, return tool error
- [ ] Enforce concurrency limit: if `activeChildren.size >= max_concurrent_children`, return tool error
- [ ] Create `spawn-agent.ts` tool wrapper: JSON schema, calls `manager.spawn()`, returns `{ child_id }`
- [ ] Add lazy `SubagentManager` to `AgentSession`: created on first subagent tool call
- [ ] Child sessions inherit parent's provider profile, execution environment, and event emitter
- [ ] Add subagent tools to provider profiles' `visibleTools` for all providers
- [ ] Register subagent tools in the tool registry, classified as `mutating`
- [ ] Tests:
  - Spawn creates a child session with correct depth
  - Depth limit enforced — returns error, not exception
  - Concurrency limit enforced
  - Child inherits provider profile
  - Child session starts processing after spawn
  - Multiple spawns produce unique child_ids

### Phase 2: Send Input & Wait (~25%)

**Files:** `src/agent-loop/tools/send-input.ts`, `src/agent-loop/tools/wait.ts`, `src/agent-loop/subagent-manager.ts`, `test/agent-loop/subagent-lifecycle.test.ts`

**Tasks:**
- [ ] Implement `SubagentManager.sendInput(child_id, message)`:
  - If child is PROCESSING: call `child.steer(message)`, return `{ status: "steered" }`
  - If child is AWAITING_INPUT: call `child.followUp(message)`, return `{ status: "follow_up_queued" }`
  - If child is CLOSED: return tool error `"Child ${child_id} is already closed"`
  - If child_id unknown: return tool error `"Unknown child_id: ${child_id}"`
- [ ] Create `send-input.ts` tool wrapper
- [ ] Implement `SubagentManager.wait(child_ids)`:
  - Normalize single ID to array
  - Validate all IDs exist
  - `await Promise.allSettled(children.map(c => c.resultPromise))`
  - Collect results: for each child, produce `{ child_id, status, output, error?, usage }`
  - `output` is the final assistant message text from the child session
  - `status` derived from child session result: success/failure/timeout/aborted
- [ ] Create `wait.ts` tool wrapper: accepts single string or array, calls `manager.wait()`, returns collected results
- [ ] Handle timeout: if child has `timeout_ms`, the result promise races against a timer. On timeout, abort the child and return `{ status: "timeout" }`
- [ ] Tests:
  - send_input steers a PROCESSING child
  - send_input follows up on an AWAITING_INPUT child
  - send_input to unknown child returns error
  - send_input to closed child returns error
  - wait single child returns result
  - wait multiple children returns all results
  - wait with one failed child still returns other results
  - wait with timeout aborts child and returns timeout status
  - wait on already-completed child returns immediately

### Phase 3: Close & Cleanup (~15%)

**Files:** `src/agent-loop/tools/close-agent.ts`, `src/agent-loop/subagent-manager.ts`, `src/agent-loop/session.ts`, `test/agent-loop/subagent-cleanup.test.ts`

**Tasks:**
- [ ] Implement `SubagentManager.close(child_id)`:
  - If PROCESSING: call `child.abort()`, remove from active map
  - If AWAITING_INPUT: call `child.close()`, remove from active map
  - If already CLOSED or unknown: return informational message (not an error — idempotent close)
- [ ] Create `close-agent.ts` tool wrapper
- [ ] Auto-cleanup: when parent session transitions to CLOSED or completes, call `manager.abortAll()` for any remaining live children
- [ ] Implement `SubagentManager.abortAll()`: iterates active children, aborts each, clears map
- [ ] Wire abort propagation into `AgentSession.abort()`: if manager exists, call `manager.abortAll()` before transitioning to CLOSED
- [ ] Tests:
  - close_agent aborts a processing child
  - close_agent closes an awaiting child
  - close_agent on already-closed child is idempotent
  - Parent session completion auto-closes live children
  - Parent abort propagates to all children
  - No orphaned child processes after parent shutdown

### Phase 4: Events, Transcripts & Context Logging (~20%)

**Files:** `src/agent-loop/events.ts`, `src/agent-loop/transcript.ts`, `src/engine/events.ts`, `src/engine/context.ts`, `src/handlers/codergen.ts`, `test/agent-loop/subagent-events.test.ts`, `test/engine/context.test.ts`

**Tasks:**
- [ ] Define subagent event types: `SubagentSpawnedEvent`, `SubagentCompletedEvent`, `SubagentMessageEvent`
- [ ] Emit events from `SubagentManager`: spawn, completion, and message delivery
- [ ] Child sessions' events bubble up through the parent's event emitter with `parent_session_id` context
- [ ] Bridge subagent events to engine-level `RunEvent` stream (CLI renderer needs them)
- [ ] Extend `TranscriptWriter` to create nested `subagents/<child_id>/` directories
- [ ] Child sessions write their own transcripts (prompt.md, response.md, tool-calls/) under the nested directory
- [ ] Implement `ExecutionContext.appendLog(entry: string)` (gap A10):
  - Maintains an append-only `run_log: string[]` on the context
  - Subagent spawns, completions, and errors are logged
  - Accessible via `context.get('_run_log')` or a dedicated `context.getLog()` method
- [ ] Update `CodergenHandler` to pass `depth` from parent context to child sessions
- [ ] Tests:
  - SubagentSpawned event emitted on spawn
  - SubagentCompleted event emitted on child finish
  - Child events contain correct parent_session_id
  - Nested transcript directories created correctly
  - append_log adds entries, getLog retrieves them
  - Engine events include subagent activity

### Phase 5: Abort Propagation & Timeout Enforcement (~10%)

**Files:** `src/agent-loop/subagent-manager.ts`, `src/agent-loop/session.ts`, `test/agent-loop/subagent-abort.test.ts`

**Tasks:**
- [ ] Implement cascading abort: parent abort → children abort → grandchildren abort (recursive via each session's manager)
- [ ] Implement per-child timeout via `Promise.race()` between the child's result promise and a `setTimeout`:
  - On timeout: abort child, resolve the result promise with `{ status: 'timeout', output: 'Child agent timed out after ${timeout_ms}ms' }`
  - Timeout timer is cleared when child completes normally
- [ ] Handle AbortController signal propagation: parent's abort signal is linked to child sessions
- [ ] Edge case: parent aborted while `wait()` is pending — the wait tool call should reject, parent model receives error result
- [ ] Edge case: child spawns grandchild, parent aborts — verify full tree teardown
- [ ] Tests:
  - Cascading abort through 3-level depth
  - Timeout fires and aborts child correctly
  - Timeout timer cancelled on normal completion
  - Parent abort during wait rejects cleanly
  - Full tree teardown verified (no orphans)

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/subagent-manager.ts` | Create | Core SubagentManager: spawn, send, wait, close, abort, limits |
| `src/agent-loop/tools/spawn-agent.ts` | Create | `spawn_agent` tool schema and handler |
| `src/agent-loop/tools/send-input.ts` | Create | `send_input` tool schema and handler |
| `src/agent-loop/tools/wait.ts` | Create | `wait` tool schema and handler |
| `src/agent-loop/tools/close-agent.ts` | Create | `close_agent` tool schema and handler |
| `src/agent-loop/session.ts` | Modify | Lazy SubagentManager, depth field, abort propagation |
| `src/agent-loop/types.ts` | Modify | `SubagentConfig`, `depth`, `ChildEntry`, budget defaults |
| `src/agent-loop/events.ts` | Modify | Subagent event type definitions |
| `src/agent-loop/provider-profiles.ts` | Modify | Subagent tools in visible tool lists |
| `src/agent-loop/transcript.ts` | Modify | Nested `subagents/<child_id>/` transcript directories |
| `src/engine/context.ts` | Modify | `appendLog()` / `getLog()` methods (A10) |
| `src/engine/events.ts` | Modify | Subagent event bridging to RunEvent stream |
| `src/handlers/codergen.ts` | Modify | Pass depth to child sessions, register subagent tools |
| `test/agent-loop/subagent-manager.test.ts` | Create | Manager spawn, depth/concurrency limits |
| `test/agent-loop/subagent-lifecycle.test.ts` | Create | send_input, wait, result collection |
| `test/agent-loop/subagent-cleanup.test.ts` | Create | close, auto-cleanup, orphan prevention |
| `test/agent-loop/subagent-events.test.ts` | Create | Event emission, transcript nesting |
| `test/agent-loop/subagent-abort.test.ts` | Create | Cascading abort, timeout, tree teardown |
| `test/engine/context.test.ts` | Modify | appendLog / getLog tests |
| `test/helpers/scripted-adapter.ts` | Modify | Support multi-session scenarios for subagent testing |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing single-session `processInput()` / `submit()` behavior unchanged

### Subagent Tools (C1)
- [ ] `spawn_agent` creates a child session and returns a `child_id`
- [ ] `send_input` steers a PROCESSING child or follows up on an AWAITING_INPUT child
- [ ] `wait` blocks until specified children complete and returns their results
- [ ] `wait` supports both single child_id (string) and multiple (array)
- [ ] `close_agent` aborts/closes a child session (idempotent)
- [ ] All four tools registered in the tool registry for all provider profiles

### Depth Limiting
- [ ] `depth` tracked on every `AgentSession` (0 for top-level)
- [ ] `spawn_agent` rejected with tool error when `depth + 1 > max_depth` (default 3)
- [ ] Child sessions created with `depth: parent_depth + 1`

### Concurrency Limiting
- [ ] `spawn_agent` rejected with tool error when `max_concurrent_children` (default 4) reached
- [ ] Completed children free concurrency slots

### Budget Controls
- [ ] Child `max_tool_rounds` defaults to 20
- [ ] Child `max_turns` defaults to 5
- [ ] Child `timeout_ms` defaults to 300,000 (5 minutes)
- [ ] All defaults overridable per `spawn_agent` call
- [ ] Timeout fires and aborts child, returning timeout status

### Lifecycle & Cleanup
- [ ] Parent session completion auto-aborts live children
- [ ] Parent `abort()` cascades to all children (and grandchildren, recursively)
- [ ] No orphaned child sessions after any shutdown path
- [ ] Children inherit provider profile and execution environment from parent

### Events & Transcripts
- [ ] `SubagentSpawnedEvent` emitted on spawn
- [ ] `SubagentCompletedEvent` emitted on child completion
- [ ] `SubagentMessageEvent` emitted on steer/follow-up delivery
- [ ] Child transcripts written under `subagents/<child_id>/` nested directory
- [ ] Subagent events bridged to engine-level RunEvent stream

### Context Logging (A10)
- [ ] `ExecutionContext.appendLog(entry)` appends to an immutable run log
- [ ] `ExecutionContext.getLog()` returns the full log array
- [ ] Subagent spawns and completions are logged to context

### Test Coverage
- [ ] At least 40 new tests across subagent manager, tools, lifecycle, events, cleanup, abort

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Models spawn too many children or delegate trivially | High | Medium | Conservative defaults: max 4 concurrent, max depth 3, child tool rounds 20. Error messages guide the model to work directly. Provider system prompt should include guidance on when to delegate vs. work directly. |
| Child sessions consume excessive tokens, inflating cost | Medium | High | Per-child budget limits (`max_tool_rounds`, `max_turns`, `timeout_ms`). Parent session's `Usage` aggregates child usage for accurate cost reporting. Codergen handler can enforce total budget across parent + children. |
| Deadlock: parent waits on child, child waits on parent | Low | High | Children cannot send messages to parents. Communication is strictly parent-to-child (steer/follow-up) and child-to-parent (result on completion). No bidirectional channel = no deadlock. |
| Race between parent abort and child completion | Medium | Medium | Abort is idempotent. If a child completes milliseconds before abort arrives, the result is preserved. If abort wins, the result promise rejects with AbortError. The wait tool handles both cases gracefully. |
| Child modifies files that parent is also editing | Medium | High | Same-workspace children share filesystem. This is a feature (matches real multi-developer workflows) but can cause conflicts. Document that parent should coordinate via task scoping ("only modify test/ files"). No filesystem locking this sprint — matches the `make` threat model. |
| Nested transcript directories become deeply nested | Low | Low | Max depth 3 means max 3 levels of nesting. Transcript paths are predictable and filesystem-friendly. |
| `Promise.allSettled` in wait accumulates memory for many children | Low | Low | Max 4 concurrent children bounds the set. Completed children are removed from the active map. |
| Child provider profile mismatch — parent uses Anthropic, child should use OpenAI | Low | Medium | Children inherit parent profile by default. Per-child provider override is a future enhancement (would require `spawn_agent` to accept `provider` parameter). Not needed for the common case. |
| Sprint scope is focused but deep — one feature, many edges | Medium | Medium | **Cut-line:** Phase 5 (abort propagation, timeout enforcement) is deferrable. The core CRUD lifecycle (spawn/send/wait/close) with depth and concurrency limits ships in Phases 1-3. Events and transcripts (Phase 4) are important but secondary. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| Sprint 011 session control plane | `submit()`, `steer()`, `followUp()`, `abort()`, `getState()`, `SessionState` | Prerequisite |
| Existing `AgentSession` | Foundation for child sessions | Implemented |
| Existing `ExecutionEnvironment` | Workspace boundary enforcement, file operations | Implemented |
| Existing tool registry | Registration for 4 new tools | Implemented |
| Existing event system | Event emission and engine bridging | Implemented |
| `crypto.randomUUID()` | Child ID generation | Built-in (Node 22) |

**Zero new npm dependencies.** All work uses existing session infrastructure. The subagent layer is a composition of existing primitives (sessions, tools, events) into a management layer.

---

## GAP Closure Summary

| Gap | Description | Severity | Status After Sprint |
|-----|-------------|----------|-------------------|
| C1 | Subagent tools (`spawn_agent`, `send_input`, `wait`, `close_agent`) | **HIGH** | **Closed** |
| A10 | Context `append_log()` method | Low | **Closed** |

**1 HIGH gap closed. 1 LOW gap closed. 2 total.**

**After this sprint, zero HIGH-severity gaps remain across all three specs.**

**Next sprint candidates:**
- A1 (manager loop handler) — now unblocked by subagent infrastructure
- L4 (structured output) — foundation for swarm analysis
- L10 (Anthropic prompt caching) — cost reduction for all codergen sessions
- A4/A5 (context fidelity runtime) — quality improvement for long pipelines
