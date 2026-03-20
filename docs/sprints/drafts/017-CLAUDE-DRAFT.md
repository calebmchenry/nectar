# Sprint 017: Manager Loop, loop_restart, and Tool Call Hooks

## Overview

**Goal:** Close GAP-A1, GAP-A2, and GAP-A3 — the last three substantive attractor execution gaps. After this sprint, Nectar can supervise child pipelines from `house` nodes, restart runs cleanly when a `loop_restart` edge fires, and gate or audit every LLM tool call via pre/post hooks. This brings the attractor spec to zero non-optional gaps.

**Why these three together:**

All three gaps are execution-control features that share integration surfaces. GAP-A1 (manager loop) requires child run orchestration which exercises the same engine lifecycle as GAP-A2 (loop_restart) — both create new `PipelineEngine` instances mid-run and must handle context carryover, lineage tracking, and CLI follow-through. GAP-A3 (tool hooks) is scoped to `AgentSession` and is mechanically independent, but it's small enough (~15% of sprint effort) to bundle without diluting focus, and Sprint 016 explicitly recommended this grouping.

Shipping these together means the attractor spec goes from 6 gaps to 3 — and the remaining 3 are GAP-A4 (custom transform registration, extensibility nicety), GAP-A5 (HTTP server, explicitly optional in spec), and GAP-L1 (OpenAI-compatible adapter, additive). None of those block real pipeline functionality. After this sprint, every execution-time feature in the attractor spec works.

**Why NOT GAP-A4 (custom transforms)?** The Codex draft bundles it because it's "~30 lines." That's true, but it's the wrong framing. GAP-A4 is an extensibility API — it invites external consumers to depend on a registration interface. Shipping it alongside three complex execution features means it gets designed under time pressure and reviewed as an afterthought. It deserves 30 minutes of deliberate API design in a separate, low-risk follow-up. Bundling it here optimizes for gap-count optics over API quality.

**In scope:**

- `house` shape -> `stack.manager_loop` handler type in parsing, validation, and execution
- Graph attributes: `stack.child_dotfile`, `stack.child_workdir`
- Node attributes: `manager.poll_interval`, `manager.max_cycles`, `manager.stop_condition`, `manager.actions`, `stack.child_autostart`
- Node-level and graph-level `tool_hooks.pre` / `tool_hooks.post`
- `loop_restart` boolean on edges with successor-run creation
- `ManagerLoopHandler`: in-process child `PipelineEngine`, polling, stop condition evaluation, stage-boundary steering
- Tool hook execution wrapping all model-visible tool calls in `AgentSession`
- Lineage metadata in manifests and cocoons (restart chains, parent/child links)
- CLI support: `nectar run` follows restart chains, `nectar status` shows lineage
- Events: child_run_started, child_snapshot_observed, run_restarted, tool_hook_blocked

**Out of scope:**

- GAP-A4 (custom transform registration) — small but deserves deliberate API design, not time-pressured bundling
- GAP-A5 (HTTP server mode) — optional per spec, premature before all execution semantics are solid
- GAP-L1 (OpenAI-compatible adapter) — additive LLM client feature
- Full child-event tunneling to parent event stream (detailed child state stays on disk)
- Live mid-turn steering into an active LLM response
- Web UI, Seedbed, Swarm Intelligence

**Cut line:** If time compresses, ship A1 + A2 first. Cut Phase 4 (tool hooks) before compromising manager loop or restart correctness. Tool hooks are self-contained and can be a fast follow-up sprint. Do **not** cut restart lineage tracking — without it, restart chains become opaque and unresumable.

---

## Use Cases

1. **Parent supervises a child pipeline to completion.** A compliance pipeline has `supervisor [shape=house manager.max_cycles=50 manager.poll_interval="5s"]` with `stack.child_dotfile="gardens/implementation.dot"`. The supervisor launches the child, polls its checkpoint every 5 seconds, mirrors `stack.child.status` and `stack.child.current_node` into parent context, and returns SUCCESS when the child completes.

2. **Supervisor steers a child at stage boundaries.** The manager node has `manager.actions="observe,steer,wait"` and `prompt="Focus on test coverage before moving to the next feature."`. When the child advances to a new node, the manager writes a steering note to `control/manager-steer.json`. Before the next child node executes, the child engine consumes the note and prepends it to the codergen prompt. The same `(node_id, retry_count)` tuple is never steered twice.

3. **Attach to an existing child run.** A graph sets `stack.child_autostart=false`. An earlier tool node launched a child and wrote `stack.child.run_id` into context. The manager attaches to that run ID, observes progress, and evaluates its stop condition without spawning a duplicate.

4. **Intentional clean restart after review failure.** An edge `review -> implement [condition="outcome=failure" loop_restart=true]` fires. The engine marks the current run as `interrupted` with reason `loop_restart`, creates a new run directory with a new run ID, carries forward business context (dropping internal/retry/session state), and starts execution at `implement` in the successor run. The CLI follows the chain automatically.

5. **Continuous monitoring loop.** A data-quality pipeline ends with `report -> start_over [loop_restart=true]`. Each iteration produces a fresh cocoon. The restart depth cap (default 25) prevents runaway loops. `nectar status` shows the full restart chain with lineage.

6. **Pre-hook blocks a dangerous tool call.** A graph sets `tool_hooks.pre="./scripts/policy-check.sh"`. Inside a codergen node, when the model calls `shell` to run `rm -rf /tmp/data`, the pre-hook receives tool metadata via stdin and env vars. The hook exits non-zero. The model receives a synthetic error result: "Tool call blocked by policy hook." The block is logged to disk and emitted as a `tool_hook_blocked` event.

7. **Post-hook audits every tool call.** `tool_hooks.post="./scripts/audit-log.sh"` runs after every tool call (including blocked ones). It receives the call result, duration, and metadata. Its exit code is recorded but never blocks the agent loop. Artifacts are persisted beside the tool call transcript.

---

## Architecture

### Design Principles

1. **Child runs use real engines.** `ManagerLoopHandler` spawns a real `PipelineEngine` in-process. No shelling out to `nectar run`. The child gets a real cocoon, real checkpoints, real artifacts. This means resume, status, and all observability work for child runs automatically.

2. **Restarts create new runs, not mutated state.** `loop_restart` produces a distinct run with a distinct ID and directory. The predecessor is closed cleanly. Lineage links the chain. This is the right trade-off: it's slightly more disk, but it means every run directory is a self-contained, resumable snapshot. No Frankenstein cocoons.

3. **Steering is file-based and at-most-once.** The control plane is a single JSON file consumed atomically. No in-memory queues between parent and child. This survives crashes, is inspectable, and cannot duplicate messages. The tradeoff is that steering is next-node only — no live injection into an active LLM turn. That's the right constraint for this sprint.

4. **Tool hooks wrap `AgentSession` tool dispatch, not engine-level tool nodes.** The spec says hooks gate "LLM tool calls" — meaning the tools the model invokes during agentic execution. `parallelogram` tool nodes are engine-level constructs, not model-visible tool calls. This sprint hooks the right layer.

5. **Context carryover on restart is explicit and conservative.** Business keys carry forward. Internal bookkeeping (`internal.*`, `stack.child.*`, `stack.manager.*`, `outcome`, `preferred_label`, `last_stage`, `last_response`, `current_node`) is stripped. Retry state, thread registry, and session registry are reset. This prevents stale state from poisoning the successor while preserving the user's accumulated context.

### Manager Loop Architecture

```
ManagerLoopHandler.execute()
    |
    +-- resolve child config (graph.childDotfile, node.childAutostart, etc.)
    |
    +-- start child run (autostart=true)
    |   +-- ChildRunController.start()
    |       +-- new PipelineEngine(childGraph) -> engine.run() [background]
    |
    +-- OR attach to existing run (autostart=false)
    |   +-- ChildRunController.attach(context["stack.child.run_id"])
    |
    +-- poll loop (max_cycles iterations):
          |
          +-- sleep(poll_interval)
          |
          +-- ChildRunController.readSnapshot()
          |   +-- reads child's checkpoint.json
          |
          +-- mirror snapshot -> parent context (stack.child.*)
          |
          +-- if steer enabled: write manager-steer.json (at-most-once per tuple)
          |
          +-- evaluate stop_condition against parent context
          |   +-- uses existing condition evaluator from src/engine/conditions.ts
          |
          +-- if stop_condition met -> return SUCCESS
          +-- if child completed successfully -> return SUCCESS
          +-- if child failed -> return FAILURE
          +-- if max_cycles exceeded -> return FAILURE
```

**ChildRunController** (`src/engine/child-run-controller.ts`):

```typescript
class ChildRunController {
  /** Launch a new child run from a DOT file. Returns the run_id. */
  start(dotFile: string, workdir?: string): Promise<string>;

  /** Attach to an already-running child run. */
  attach(runId: string): Promise<void>;

  /** Read the child's current checkpoint as a structured snapshot. */
  readSnapshot(): Promise<ChildSnapshot | null>;

  /** Write a steering note, keyed by (nodeId, retryCount) to prevent duplicates. */
  writeSteerNote(message: string, tupleKey: string): Promise<boolean>;

  /** Abort an owned (auto-started) child. No-op for attached runs. */
  abortOwnedChild(reason: string): Promise<void>;
}
```

The child engine runs via `engine.run()` as a background promise. The parent polls the child's checkpoint file on disk — no shared memory, no event bus coupling. If the parent is interrupted, it aborts any owned child via `abortOwnedChild()`.

**Steering file format** (`.nectar/cocoons/<child-run-id>/control/manager-steer.json`):

```json
{
  "source_run_id": "parent-run-id",
  "source_node_id": "supervisor",
  "tuple_key": "implement:2",
  "message": "Focus on test coverage.",
  "created_at": "2026-03-20T14:00:00Z"
}
```

The child engine checks for this file before each node execution:
- Codergen nodes: prepend the message to the rendered prompt
- Non-codergen nodes: store in `context["stack.manager.note"]`
- File is deleted atomically after consumption — cannot be applied twice

### Restart Architecture

When `loop_restart=true` on the selected edge:

1. **Close predecessor:** Set `status="interrupted"`, `interruption_reason="loop_restart"`, write `restarted_to=<successor_run_id>` into manifest and cocoon.
2. **Create successor:** New `run_id`, new run directory, new manifest with `restart_of=<predecessor_run_id>` and `restart_depth=N+1`.
3. **Filter context:** Copy all keys except:
   - `current_node`, `outcome`, `preferred_label`, `last_stage`, `last_response`
   - `internal.*`, `stack.child.*`, `stack.manager.*`
4. **Reset runtime state:** Zero retry counts, clear thread registry, clear session registry, clear pending transition.
5. **Start at edge target:** The successor begins at the target node of the restart edge, NOT at the graph's start node. This is per spec section 3.2 Step 7.
6. **Depth guard:** Hard cap of 25 restarts. Exceeding this is a fatal run error. This isn't in the spec but is the right safety net for a filesystem-first tool.

**Manifest lineage fields:**

```typescript
interface ManifestData {
  // ...existing fields...
  restart_of?: string;      // predecessor run ID
  restarted_to?: string;    // successor run ID (written to predecessor)
  restart_depth?: number;   // 0 for first run, increments each restart
  parent_run_id?: string;   // for child runs launched by manager
  parent_node_id?: string;  // which manager node launched this child
}
```

**CLI behavior:** `nectar run` follows the restart chain automatically — when a run creates a successor, the CLI seamlessly transitions to showing the successor's events. `nectar status <run-id>` shows lineage with predecessor/successor links. `nectar resume` resumes the latest run in a restart chain.

### Tool Hook Architecture

Tool hooks live in `src/agent-loop/tool-hooks.ts` and wrap tool execution inside `AgentSession`. This is the correct layer because tool hooks gate *model-visible tool calls*, not engine-level handler dispatch.

**Hook resolution precedence:**
1. Node-level `tool_hooks.pre` / `tool_hooks.post` (on the codergen node)
2. Graph-level `tool_hooks.pre` / `tool_hooks.post`
3. No hook

**Pre-hook contract:**
- Spawned with `execa` before the tool call
- Receives JSON on stdin: `{ run_id, node_id, session_id, tool_call_id, tool_name, arguments }`
- Environment: `NECTAR_RUN_ID`, `NECTAR_NODE_ID`, `NECTAR_SESSION_ID`, `NECTAR_TOOL_CALL_ID`, `NECTAR_TOOL_NAME`, `NECTAR_HOOK_PHASE=pre`
- Hard timeout: 15 seconds
- Exit 0 -> proceed with tool call
- Non-zero -> skip tool call, return synthetic `{ is_error: true, content: "Tool call blocked by pre-hook (exit code N)" }` to the model

**Post-hook contract:**
- Spawned after tool call completes (or after pre-hook rejection)
- Receives JSON on stdin: same as pre-hook plus `{ is_error, content_preview, duration_ms, blocked_by_pre_hook }`
- Environment: same as pre-hook with `NECTAR_HOOK_PHASE=post`
- Hard timeout: 15 seconds
- Exit code is recorded but never blocks execution or mutates the tool result
- Failures logged, not escalated

**Artifact layout per tool call:**

```
<node-dir>/tool-calls/<sequence>-<tool-name>/
+-- request.json
+-- result.json
+-- pre-hook.json          (metadata + exit code)
+-- pre-hook.stdout.log
+-- pre-hook.stderr.log
+-- post-hook.json
+-- post-hook.stdout.log
+-- post-hook.stderr.log
```

### New Event Types

```typescript
// Manager loop events
interface ChildRunStartedEvent {
  type: 'child_run_started';
  parent_node_id: string;
  child_run_id: string;
  child_dotfile: string;
}
interface ChildSnapshotEvent {
  type: 'child_snapshot_observed';
  child_run_id: string;
  child_status: string;
  child_current_node?: string;
  completed_count: number;
  cycle: number;
}
interface ChildSteerEvent {
  type: 'child_steer_note_written';
  child_run_id: string;
  tuple_key: string;
}

// Restart events
interface RunRestartedEvent {
  type: 'run_restarted';
  predecessor_run_id: string;
  successor_run_id: string;
  restart_depth: number;
  target_node: string;
}

// Tool hook events
interface ToolHookBlockedEvent {
  type: 'tool_hook_blocked';
  tool_name: string;
  tool_call_id: string;
  hook_exit_code: number;
}
```

---

## Implementation Phases

### Phase 1: Graph Schema — Parsing, Types, and Validation (~15%)

**Files:** `src/garden/types.ts` (modify), `src/garden/parse.ts` (modify), `src/garden/validate.ts` (modify), `test/garden/parse.test.ts` (modify), `test/garden/validate.test.ts` (modify), `test/fixtures/manager-basic.dot` (create), `test/fixtures/loop-restart.dot` (create)

**Tasks:**

- [ ] Add `'stack.manager_loop'` to the `NodeKind` union type
- [ ] Add `house` -> `stack.manager_loop` mapping in `normalizeNodeKind()`
- [ ] Add `loopRestart: boolean` to `GardenEdge` type, default `false`
- [ ] Parse `loop_restart` attribute on edges as boolean
- [ ] Add graph-level fields to `GardenGraph`: `childDotfile?: string`, `childWorkdir?: string`, `toolHooksPre?: string`, `toolHooksPost?: string`
- [ ] Add node-level fields to `GardenNode`: `managerPollIntervalMs?: number`, `managerMaxCycles?: number`, `managerStopCondition?: string`, `managerActions?: string[]`, `childAutostart?: boolean`, `toolHooksPre?: string`, `toolHooksPost?: string`
- [ ] Parse `manager.poll_interval` using existing `parseTimeoutMs()` duration parser
- [ ] Parse `manager.actions` as comma-separated list, default `['observe', 'wait']`
- [ ] Validation rules:
  - `manager.actions` values must be subset of `{observe, steer, wait}` — ERROR
  - `manager.max_cycles` must be positive integer when present — ERROR
  - `manager.stop_condition` must parse with condition evaluator — ERROR
  - If `steer` in actions, node must have non-empty `prompt` — WARNING
  - If `stack.child_autostart` is true or absent, graph must define `stack.child_dotfile` — ERROR
  - `tool_hooks.*` on non-codergen nodes — WARNING (no runtime effect)
  - `loop_restart=true` on edge from exit node — WARNING (restart from exit is nonsensical)
- [ ] Create `test/fixtures/manager-basic.dot` with house-shaped manager node
- [ ] Create `test/fixtures/loop-restart.dot` with restart edge
- [ ] Tests: parse manager attributes, parse loop_restart, validation accepts valid configs, validation rejects invalid configs

### Phase 2: loop_restart Engine Support and Lineage (~20%)

**Files:** `src/engine/engine.ts` (modify), `src/engine/types.ts` (modify), `src/engine/events.ts` (modify), `src/checkpoint/types.ts` (modify), `src/checkpoint/run-store.ts` (modify), `src/cli/commands/run.ts` (modify), `src/cli/commands/resume.ts` (modify), `src/cli/commands/status.ts` (modify), `src/cli/ui/renderer.ts` (modify), `test/integration/loop-restart.test.ts` (create)

**Tasks:**

- [ ] Extend `ManifestData` with lineage fields: `restart_of`, `restarted_to`, `restart_depth`, `parent_run_id`, `parent_node_id`
- [ ] Extend `Cocoon` with `restarted_to?: string` field
- [ ] In engine's edge-advance step: detect `loopRestart === true` on selected edge
- [ ] Implement restart sequence:
  1. Mark current run `interrupted` with reason `loop_restart`
  2. Write `restarted_to` into predecessor's manifest and cocoon
  3. Create new run ID and run directory via `RunStore`
  4. Write successor manifest with `restart_of`, `restart_depth`
  5. Filter context: keep business keys, strip internal/routing/session state
  6. Reset retry counts, thread registry, session registry
  7. Start successor engine at edge target node (not graph start)
- [ ] Implement restart depth guard (default 25, configurable via graph attribute `max_restart_depth`)
- [ ] Emit `run_restarted` event at the boundary
- [ ] `nectar run`: when engine returns a restart result, seamlessly create and run the successor, subscribing the renderer to the new event stream
- [ ] `nectar resume`: detect restart chains, resume the latest run in the chain
- [ ] `nectar status <run-id>`: show predecessor/successor links in output
- [ ] Render `run_restarted` event tersely: `🔄 Run restarting -> [target_node] (depth N)`
- [ ] Tests:
  - Restart creates new run with new ID
  - Predecessor marked interrupted with restart linkage
  - Context filtering: business keys preserved, internal keys stripped
  - Retry state reset in successor
  - Successor starts at target node, not graph start
  - Depth guard triggers at limit
  - Resume finds latest run in chain

### Phase 3: Manager Loop Handler (~35%)

**Files:** `src/handlers/manager-loop.ts` (create), `src/engine/child-run-controller.ts` (create), `src/handlers/registry.ts` (modify), `src/engine/engine.ts` (modify), `src/engine/events.ts` (modify), `src/checkpoint/run-store.ts` (modify), `test/handlers/manager-loop.test.ts` (create), `test/integration/manager-loop.test.ts` (create), `test/fixtures/manager-child.dot` (create)

**Tasks:**

- [ ] Create `ChildRunController` class:
  - `start(dotFile, workdir?)` — parse child DOT, create child `PipelineEngine`, call `engine.run()` as background promise, return `run_id`
  - `attach(runId)` — validate run exists, set up snapshot reading
  - `readSnapshot()` — read child's `checkpoint.json`, return `ChildSnapshot`
  - `writeSteerNote(message, tupleKey)` — write `control/manager-steer.json` if no note with same tuple key exists; return `true` if written
  - `abortOwnedChild(reason)` — signal child engine to stop, checkpoint, and exit
- [ ] Create `ManagerLoopHandler` implementing `NodeHandler`:
  - Resolve config from node attributes + graph attributes
  - Start or attach to child run
  - Emit `child_run_started` event
  - Enter poll loop:
    - Sleep `poll_interval` (default 10s)
    - Read snapshot, emit `child_snapshot_observed`
    - Mirror snapshot into parent context under `stack.child.*` namespace
    - If `steer` enabled and tuple key is new: write steering note, emit event
    - Evaluate `stop_condition` against parent context using existing condition evaluator
    - Check cycle count against `max_cycles`
  - Return outcomes:
    - SUCCESS: child completed successfully or stop_condition satisfied
    - FAILURE: child failed, config error, or max_cycles exceeded
  - On parent interrupt/abort: call `abortOwnedChild()` for auto-started children
- [ ] Register `stack.manager_loop` handler in registry
- [ ] Update engine to consume steering notes before node execution:
  - Check for `control/manager-steer.json` in run directory
  - For codergen: prepend note to rendered prompt
  - For non-codergen: store in `context["stack.manager.note"]`
  - Delete file atomically after consumption
- [ ] Add `control/` directory support to `RunStore`
- [ ] Create `test/fixtures/manager-child.dot` — simple child pipeline the manager can supervise
- [ ] Tests:
  - Manager starts child and polls to completion
  - Manager attaches to existing child run
  - Manager fails when child fails
  - Manager respects max_cycles limit
  - Stop condition evaluated correctly against `stack.child.*` context
  - Steering note written at-most-once per tuple
  - Child consumes steering note before next node
  - Parent interrupt aborts owned child
  - Context keys correctly namespaced under `stack.child.*`
  - Integration: parent launches child, child completes, parent succeeds

### Phase 4: Tool Call Hooks (~20%)

**Files:** `src/agent-loop/tool-hooks.ts` (create), `src/agent-loop/session.ts` (modify), `src/agent-loop/events.ts` (modify), `src/agent-loop/transcript.ts` (modify), `src/handlers/codergen.ts` (modify), `test/agent-loop/tool-hooks.test.ts` (create)

**Tasks:**

- [ ] Create `ToolHookRunner` in `src/agent-loop/tool-hooks.ts`:
  - `runPreHook(hookCmd, metadata): Promise<{ allowed: boolean; exitCode: number; stdout: string; stderr: string }>`
  - `runPostHook(hookCmd, metadata): Promise<{ exitCode: number; stdout: string; stderr: string }>`
  - Both use `execa` with `shell: true`, 15s timeout, stdin JSON pipe
  - Pre-hook: exit 0 = proceed, non-zero = block
  - Post-hook: exit code recorded, never blocks
- [ ] Resolve effective hooks: node-level `toolHooksPre`/`toolHooksPost` first, fall back to graph-level
- [ ] Integrate into `AgentSession` tool dispatch:
  - Before tool execution: run pre-hook if configured
  - If blocked: return synthetic error `ToolResult` to model, skip actual tool call
  - After tool execution (or block): run post-hook if configured
  - Post-hook failure: log warning, continue
- [ ] Wrap both regular tools AND subagent tools (`spawn_agent`, `send_input`, `wait`, `close_agent`)
- [ ] Pass hook config from codergen handler to `AgentSession` creation
- [ ] Emit `tool_hook_blocked` event when pre-hook blocks a call
- [ ] Persist hook artifacts:
  - `pre-hook.json`: metadata, exit code, allowed/blocked
  - `pre-hook.stdout.log`, `pre-hook.stderr.log`
  - `post-hook.json`, `post-hook.stdout.log`, `post-hook.stderr.log`
- [ ] Environment variables for hooks: `NECTAR_RUN_ID`, `NECTAR_NODE_ID`, `NECTAR_SESSION_ID`, `NECTAR_TOOL_CALL_ID`, `NECTAR_TOOL_NAME`, `NECTAR_HOOK_PHASE`
- [ ] Tests:
  - Pre-hook exit 0 allows tool call
  - Pre-hook non-zero blocks tool call, model receives error
  - Post-hook runs after execution
  - Post-hook runs after pre-hook block
  - Post-hook failure does not block execution
  - Hook timeout (15s) enforced
  - Hook stdin receives correct JSON metadata
  - Hook env vars set correctly
  - Node-level hook overrides graph-level
  - No hooks configured -> direct passthrough (zero overhead)
  - Subagent tools also hooked

### Phase 5: Integration, Regression and Smoke (~10%)

**Files:** `test/integration/manager-loop.test.ts` (extend), `test/integration/loop-restart.test.ts` (extend), existing test files (verify)

**Tasks:**

- [ ] End-to-end: manager launches child, child completes, manager exits success, parent continues
- [ ] End-to-end: restart edge fires, successor run starts at target node, completes
- [ ] End-to-end: restart chain of 3 runs, verify lineage in all manifests
- [ ] End-to-end: pre-hook blocks tool call, model adapts and tries a different approach
- [ ] Verify all existing tests pass — zero regressions
- [ ] Verify `npm run build` clean
- [ ] Verify old cocoons without new fields resume cleanly
- [ ] Run compliance report check: GAP-A1, GAP-A2, GAP-A3 should be closeable

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/types.ts` | Modify | Add `stack.manager_loop` to NodeKind, manager node fields, graph hook fields, `loopRestart` on edges |
| `src/garden/parse.ts` | Modify | Parse `house` shape, `manager.*`, `stack.child_*`, `tool_hooks.*`, `loop_restart` |
| `src/garden/validate.ts` | Modify | Validate manager config, hook placement, restart edges |
| `src/engine/child-run-controller.ts` | Create | In-process child run orchestration: start, attach, snapshot, steer, abort |
| `src/handlers/manager-loop.ts` | Create | Deterministic supervisor handler: poll, observe, steer, evaluate stop condition |
| `src/handlers/registry.ts` | Modify | Register `stack.manager_loop`, expose graph config to handlers |
| `src/engine/engine.ts` | Modify | loop_restart handling, steering note consumption, successor engine creation |
| `src/engine/types.ts` | Modify | Restart result metadata, ChildSnapshot type |
| `src/engine/events.ts` | Modify | child_run_started, child_snapshot_observed, run_restarted, tool_hook_blocked events |
| `src/checkpoint/types.ts` | Modify | Lineage fields on manifest and cocoon |
| `src/checkpoint/run-store.ts` | Modify | Control directory helpers, lineage manifest writes |
| `src/agent-loop/tool-hooks.ts` | Create | ToolHookRunner: pre/post hook execution, timeout, stdin pipe, artifact persistence |
| `src/agent-loop/session.ts` | Modify | Wrap tool dispatch with hook runner |
| `src/agent-loop/events.ts` | Modify | tool_hook_blocked event |
| `src/agent-loop/transcript.ts` | Modify | Persist hook artifacts beside tool call artifacts |
| `src/handlers/codergen.ts` | Modify | Resolve hook config, pass to session, consume steering notes |
| `src/cli/commands/run.ts` | Modify | Follow restart chains automatically |
| `src/cli/commands/resume.ts` | Modify | Resume latest run in restart chain |
| `src/cli/commands/status.ts` | Modify | Show restart lineage and parent/child links |
| `src/cli/ui/renderer.ts` | Modify | Render manager, restart, and hook events |
| `test/fixtures/manager-basic.dot` | Create | Minimal manager node parsing fixture |
| `test/fixtures/manager-child.dot` | Create | Simple child pipeline for manager integration |
| `test/fixtures/loop-restart.dot` | Create | Restart edge fixture |
| `test/handlers/manager-loop.test.ts` | Create | Manager handler unit tests |
| `test/integration/manager-loop.test.ts` | Create | End-to-end parent/child supervision |
| `test/integration/loop-restart.test.ts` | Create | End-to-end restart chain behavior |
| `test/agent-loop/tool-hooks.test.ts` | Create | Hook gating, audit, timeout, artifact tests |
| `test/garden/parse.test.ts` | Modify | Manager attribute and restart edge parsing |
| `test/garden/validate.test.ts` | Modify | Manager and hook validation rules |

---

## Definition of Done

### Build and Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Old cocoons without lineage fields resume cleanly

### Manager Loop (GAP-A1)
- [ ] `house` shape maps to `stack.manager_loop` handler
- [ ] `ManagerLoopHandler` starts a child `PipelineEngine` and polls to completion
- [ ] `stack.child_autostart=false` attaches to existing run via context key
- [ ] `manager.poll_interval` controls polling frequency (duration-parsed)
- [ ] `manager.max_cycles` enforced — exceeding it returns FAILURE
- [ ] `manager.stop_condition` evaluated against parent context including `stack.child.*` keys
- [ ] `manager.actions` validated; `steer` requires non-empty `prompt`
- [ ] Steering notes written at-most-once per `(node_id, retry_count)` tuple
- [ ] Child engine consumes steering note before next node execution
- [ ] Parent interrupt aborts owned child runs
- [ ] `stack.child.*` context keys populated from child snapshot
- [ ] Events emitted: `child_run_started`, `child_snapshot_observed`, `child_steer_note_written`

### loop_restart (GAP-A2)
- [ ] `loop_restart` boolean parsed on edges
- [ ] Restart creates new run ID and run directory
- [ ] Predecessor marked `interrupted` with `loop_restart` reason and `restarted_to` link
- [ ] Successor manifest has `restart_of` and `restart_depth`
- [ ] Context filtering: business keys preserved, internal/routing keys stripped
- [ ] Retry state, thread registry, session registry reset in successor
- [ ] Successor starts at edge target node (not graph start)
- [ ] Restart depth cap (25) enforced with clear error
- [ ] `nectar run` follows restart chains automatically
- [ ] `nectar resume` resumes latest in chain
- [ ] `nectar status` shows lineage
- [ ] `run_restarted` event emitted

### Tool Call Hooks (GAP-A3)
- [ ] `tool_hooks.pre` and `tool_hooks.post` parsed at graph and node level
- [ ] Node-level hooks override graph-level
- [ ] Pre-hook exit 0 allows tool call; non-zero blocks with synthetic error
- [ ] Post-hook runs after every tool call (including blocked ones)
- [ ] Post-hook failure logged, never blocks
- [ ] Both regular and subagent tools are hooked
- [ ] Hook timeout: 15 seconds
- [ ] Hook receives JSON stdin and NECTAR_* env vars
- [ ] Hook artifacts persisted to disk
- [ ] `tool_hook_blocked` event emitted
- [ ] No hooks configured -> zero overhead passthrough

### Test Coverage
- [ ] At least 45 new test cases across all phases
- [ ] Manager loop: start, attach, poll, steer, stop condition, max_cycles, child failure, parent interrupt
- [ ] Restart: new run creation, context filtering, depth guard, lineage, CLI follow-through
- [ ] Tool hooks: allow, block, post-hook, timeout, env vars, stdin, node vs graph precedence, subagent tools
- [ ] Integration: full parent/child lifecycle, restart chain of 3, pre-hook block with model adaptation

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Orphaned child runs on parent crash** | Medium | High | Auto-started children are "owned" — parent interrupt/failure triggers `abortOwnedChild()`. Integration test verifies cleanup. Attached (non-owned) children are left running by design. |
| **Restart storms from bad graph topology** | Medium | High | Hard depth cap of 25. Lineage tracking makes chains inspectable. `nectar status` surfaces depth clearly. Graph validation could warn on unconditional restart edges (future enhancement). |
| **Polling overhead for long-running children** | Low | Low | Default 10s poll interval, configurable per node. Polling reads a single JSON file — negligible I/O. No event bus coupling between parent and child. |
| **Steering note race: parent writes while child reads** | Low | Medium | Atomic write via temp-file + rename. Atomic delete after consumption. At-most-once tuple key prevents re-delivery. |
| **Tool hook latency degrades agent loop** | Medium | Medium | 15s hard timeout. Post-hooks are fire-and-forget. No hooks = zero overhead (check is a single boolean). Hooks are opt-in. |
| **Context filtering on restart strips something the user needs** | Medium | Medium | Explicit allowlist approach: strip only known internal prefixes. Log stripped keys at debug level. If a user key collides with `internal.*` namespace, that's a documentation issue, not a silent data loss issue. |
| **Old cocoons without lineage fields break resume** | Low | Medium | All new fields are optional with defaults. Missing `restart_of` -> not a restart. Missing `parent_run_id` -> not a child. Backward compat test covers this. |
| **In-process child engine shares event listeners** | Medium | Medium | Child engine gets its own event listener (summary events only forwarded to parent). No shared mutable state between parent and child contexts. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `PipelineEngine` execution loop | Foundation for child runs and restart successors | Implemented |
| `RunStore` with canonical run directories | Child run directories, control files, lineage metadata | Implemented |
| `ExecutionContext` with get/set/snapshot/clone | Context carryover and filtering on restart | Implemented |
| Condition expression evaluator | `manager.stop_condition` evaluation | Implemented |
| Duration parser (`parseTimeoutMs`) | `manager.poll_interval` parsing | Implemented |
| `AgentSession` with tool dispatch | Hook wrapping point | Implemented |
| `execa` for subprocess execution | Hook execution | Implemented |
| CLI `run`/`resume`/`status` commands | Restart chain follow-through and lineage display | Implemented |
| Event system (`engine.onEvent()`) | New event types | Implemented |
| `ArtifactStore` | Hook artifact persistence | Implemented |

**Zero new npm dependencies.** All work extends existing engine, checkpoint, agent-loop, and CLI infrastructure.

---

## Gap Closure Summary

| Gap | Description | Severity | Status After Sprint |
|-----|-------------|----------|-------------------|
| GAP-A1 | Manager Loop Handler (`stack.manager_loop`) | **High** | **Closed** |
| GAP-A2 | `loop_restart` edge attribute | **High** | **Closed** |
| GAP-A3 | Tool Call Hooks (`tool_hooks.pre`/`post`) | **High** | **Closed** |
| GAP-A4 | Custom Transform Registration | Low | Open (deliberate API design follow-up) |
| GAP-A5 | HTTP Server Mode | Low | Open (optional per spec) |
| GAP-L1 | OpenAI-Compatible Adapter | Medium | Open (additive feature) |

**3 High-priority gaps closed.**

**After this sprint:**
- Attractor engine: all execution-time features implemented — zero substantive gaps
- Remaining gaps are extensibility (A4), optional features (A5), and additive adapters (L1)
- Coding agent loop: 0 gaps — already 100%
- **Total remaining gaps across all specs: 3** (down from 6)

**Recommended next sprint (018):** Two strong candidates:
1. **Seedbed Foundation** — the product surface for idea capture is fully unblocked. CLI `nectar seed`, `nectar seeds`, `nectar swarm`, filesystem layout, `meta.yaml`, multi-AI analysis triggers. This moves Nectar from "spec-compliant engine" to "usable product."
2. **GAP-L1 (OpenAI-Compatible Adapter) + GAP-A4 (Custom Transforms)** — close the last two non-optional gaps. L1 unblocks local/self-hosted LLMs (Ollama, vLLM). A4 is a small, deliberate API design task.

My recommendation: **Seedbed Foundation.** The compliance floor is built. Time to build something users touch.
