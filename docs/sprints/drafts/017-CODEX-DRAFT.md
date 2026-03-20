# Sprint 017: Finish the Attractor Floor - Manager Loop, Fresh-Run Restart, and Tool Hooks

## Overview

**Goal:** Close the last substantive attractor execution gaps by shipping `stack.manager_loop`, `loop_restart`, and `tool_hooks.pre` / `tool_hooks.post`. After this sprint, Nectar can supervise a child garden from a `house` node, intentionally roll into a fresh successor cocoon when an edge demands it, and gate or audit every agent tool call.

This is the right next sprint because `docs/INTENT.md` makes attractor compliance the floor, not the ceiling. The floor is still missing three real execution-control features. Building the HTTP runtime or Hive before these land would force every later surface to paper over lifecycle semantics that the engine still does not implement.

**Why this sprint, why now:**

- `GAP-A1`, `GAP-A2`, and `GAP-A3` are the remaining non-optional attractor runtime gaps called out in `docs/compliance-report.md`.
- They belong together. All three are about long-running orchestration control: supervising child work, restarting cleanly, and governing model-visible tool execution.
- The repo already has the needed substrate: canonical run directories, checkpoints, manifests, agent sessions, subagent tools, and filesystem-first state.
- The seedbed foundation and CLI capture work already exist. The highest leverage gap is orchestration correctness, not another product surface.

**In scope:**

- `house` shape parsing, validation, and runtime mapping to `stack.manager_loop`
- Graph attributes `stack.child_dotfile`, `stack.child_workdir`, `tool_hooks.pre`, `tool_hooks.post`
- Node attributes `manager.poll_interval`, `manager.max_cycles`, `manager.stop_condition`, `manager.actions`, `stack.child_autostart`, and node-scoped tool hooks
- In-process child run supervision with stable `stack.child.*` telemetry
- Stage-boundary steering via a file-backed control note consumed before the next child node starts
- `loop_restart` successor-run creation with lineage metadata and CLI follow-through
- Pre/post hooks around all agent-loop tool calls, including subagent tools
- Unit and integration coverage for supervision, restart chaining, and hook gating

**Out of scope:**

- HTTP server mode and the broader local runtime contract
- Custom transform registration (`GAP-A4`)
- OpenAI-compatible adapter (`GAP-L1`)
- Seedbed backlog expansion, swarm analysis, or any Hive UI work
- Live mid-stream steering into an active LLM response or active tool process
- Full child-event tunneling into the parent event stream; this sprint emits summary supervisor events and keeps the child run canonical on disk

**Opinionated decisions:**

- Child runs start **in process** via `PipelineEngine`, not by shelling out to `nectar run`.
- A manager node is **deterministic supervision**, not a second hidden LLM loop. It observes child state, optionally emits a static steering note, and relies on normal edge routing afterward.
- A restart creates a **new run ID and new run directory**, keeps filtered business context, and drops retry, thread, and session state.
- Tool hooks wrap **model-visible tool calls in `AgentSession` only**. They do not wrap `parallelogram` tool-handler nodes in this sprint.
- **Cut line:** if the sprint compresses, ship `GAP-A1` + `GAP-A2` first and cut Phase 4 (`GAP-A3`) before diluting manager-loop and restart correctness.

---

## Use Cases

1. **Supervisor starts and watches a child pipeline.** A parent garden contains `manager [shape=house]`, graph attribute `stack.child_dotfile="gardens/child.dot"`, and `manager.max_cycles=40`. When the manager node runs, Nectar launches the child graph in a fresh cocoon, polls its checkpoint, mirrors `stack.child.status`, `stack.child.current_node`, and `stack.child.completed_count` into context, and exits `success` when the child completes successfully.

2. **Supervisor attaches to an existing child run.** A parent garden sets `stack.child_autostart=false`. Another stage has already written `stack.child.run_id` into context. The manager node attaches to that run, observes progress, and routes based on `manager.stop_condition` without creating a duplicate child process.

3. **Supervisor intervenes only at stage boundaries.** A manager node sets `manager.actions="observe,steer,wait"` and a `prompt` like "Stop coding and fix the failing tests before continuing." When the child moves to a new node or retry attempt, Nectar writes one pending steering note into the child run directory. Before the next child node executes, the child consumes that note and prepends it to the next codergen prompt.

4. **Intentional clean restart after a bad branch.** A graph routes `review -> implement [condition="outcome=failure", loop_restart=true]`. When that edge is selected, Nectar closes the current run as interrupted for restart, creates a fresh run directory, carries forward filtered context, resets retry and session state, and resumes execution at `implement` in the successor run.

5. **Tool-call governance blocks or audits risky actions.** A graph sets `tool_hooks.pre="./scripts/policy-check.sh"` and `tool_hooks.post="./scripts/audit-tool-call.sh"`. Before `shell`, `apply_patch`, or `spawn_agent` executes inside a codergen node, the pre-hook receives tool metadata on stdin and through `NECTAR_*` env vars. Exit code `0` allows the call. Non-zero returns a synthetic error tool result to the model and records the block. The post-hook runs after every call for logging and auditing.

---

## Architecture

### Design Principles

1. **Finish the engine before widening the surface area.** The next sprint should complete core execution semantics, not start another broad subsystem on top of missing lifecycle behavior.
2. **Reuse the real runtime.** Child supervision must use a real `PipelineEngine` child run so checkpoints, manifests, retries, and artifacts stay canonical.
3. **Keep control visible on disk.** Steering and restart lineage should be represented with stable files and metadata, not hidden in memory.
4. **Reset runtime state on restart, not user intent.** Keep useful business context; drop ephemeral routing and internal bookkeeping.
5. **Prefer summary supervisor events over nested event trees.** Full child-event forwarding is a server/SSE problem. This sprint emits concise supervisor events and preserves detailed child state in the child cocoon.

### Typed Graph Surface

Add first-class fields instead of leaving these buried in raw attribute maps:

```ts
type NodeKind =
  | 'start'
  | 'exit'
  | 'tool'
  | 'codergen'
  | 'conditional'
  | 'wait.human'
  | 'parallel'
  | 'parallel.fan_in'
  | 'stack.manager_loop'
  | 'unknown';
```

```ts
interface GardenGraph {
  childDotfile?: string;
  childWorkdir?: string;
  toolHooksPre?: string;
  toolHooksPost?: string;
}

interface GardenNode {
  managerPollIntervalMs?: number;
  managerMaxCycles?: number;
  managerStopCondition?: string;
  managerActions?: string[];
  childAutostart?: boolean;
  toolHooksPre?: string;
  toolHooksPost?: string;
}

interface GardenEdge {
  loopRestart: boolean;
}
```

Validation rules should be explicit:

- `manager.actions` must be a subset of `observe`, `steer`, `wait`
- `manager.max_cycles` must be a positive integer
- `manager.poll_interval` must parse as a duration
- `manager.stop_condition` must parse with the existing condition parser
- If `steer` is enabled, the manager node must have a non-empty `prompt`
- If `stack.child_autostart=true` or omitted, the graph must define `stack.child_dotfile`
- `tool_hooks.*` on non-codergen nodes are warnings, not errors, because they have no runtime effect this sprint

### Child Run Supervision

Add `src/engine/child-run-controller.ts` as the boundary between the manager handler and the child engine.

```ts
interface ChildSnapshot {
  run_id: string;
  status: RunStatus;
  current_node?: string;
  completed_count: number;
  last_completed_node?: string;
  last_outcome?: NodeStatus;
  retry_count: number;
  updated_at: string;
}
```

```ts
class ChildRunController {
  start(): Promise<{ run_id: string }>;
  attach(runId: string): Promise<void>;
  readSnapshot(): Promise<ChildSnapshot | null>;
  writeSteerNote(message: string, tupleKey: string): Promise<boolean>;
  abortOwnedChild(reason: string): Promise<void>;
}
```

`ManagerLoopHandler.execute(...)` should:

1. Resolve child config from graph and node fields.
2. Start a child run when `stack.child_autostart=true`; otherwise attach to `context["stack.child.run_id"]`.
3. Poll the child snapshot every `manager.poll_interval`.
4. Mirror telemetry into the parent context under a stable namespace:

```text
stack.child.run_id
stack.child.status
stack.child.current_node
stack.child.completed_count
stack.child.last_completed_node
stack.child.last_outcome
stack.child.retry_count
stack.child.updated_at
```

5. If `steer` is enabled, write at most one pending steering note per `(current_node, retry_count)` tuple so the manager does not spam the child.
6. Evaluate `manager.stop_condition` against the normal condition engine using the parent context snapshot.
7. Return `success` when the stop condition is satisfied or when the child completes successfully.
8. Return `failure` when the child fails, child config is missing, or `manager.max_cycles` is exceeded.

### Steering Control Plane

This sprint should keep steering deliberately simple and durable:

```text
.nectar/cocoons/<child-run-id>/
├── manifest.json
├── checkpoint.json
├── control/
│   └── manager-steer.json
└── <node-id>/
```

`manager-steer.json` contains one pending note plus metadata:

```json
{
  "source_run_id": "parent-run",
  "source_node_id": "manager",
  "child_run_id": "child-run",
  "tuple_key": "implement:1",
  "message": "Stop coding and fix the failing tests before continuing.",
  "created_at": "2026-03-20T00:00:00Z"
}
```

The child engine checks for this file immediately before node execution:

- For codergen nodes, prepend the note to the rendered prompt.
- For non-codergen nodes, store it in context as `stack.manager.note`.
- Consume the file atomically so the same note is never applied twice.

This is intentionally **next-node steering**, not live mutation of an already-running turn.

### Restart Semantics

`loop_restart` belongs on `GardenEdge` as a boolean. When the selected edge sets `loop_restart=true`, the engine should:

1. Persist the current run as `status="interrupted"` with `interruption_reason="loop_restart"`.
2. Record successor linkage in both manifest and cocoon.
3. Create a brand-new `PipelineEngine` with a new `run_id`.
4. Start the successor at `selected.target`, not at the graph start node.
5. Carry forward filtered context:
   - Keep user/business keys
   - Drop `current_node`, `outcome`, `preferred_label`, `last_stage`, `last_response`
   - Drop all `internal.*`, `stack.child.*`, and `stack.manager.*` keys
6. Reset retry state, pending transition, thread/session registry, and restart-local scratch state

Add lineage metadata:

```ts
interface ManifestData {
  parent_run_id?: string;
  parent_node_id?: string;
  restart_of?: string;
  restarted_to?: string;
  restart_depth?: number;
}
```

Add a hard restart-chain guard:

- Default maximum restart depth: `25`
- Exceeding the cap is a hard run failure with a clear error

This guard is not in the upstream spec, but it is the right product decision for a filesystem-first local tool.

### Tool Hook Runtime

Tool hooks should live in `src/agent-loop/tool-hooks.ts` and wrap tool execution in `AgentSession`, because that is where tool metadata, transcript writing, parallel tool execution, and subagent tools already meet.

Hook precedence is simple:

1. Node-level hook on the executing codergen node
2. Graph-level hook
3. No hook

Pre-hook contract:

- Runs before the actual tool call
- Receives stdin JSON with run, node, session, tool, and arguments metadata
- Receives mirrored `NECTAR_*` env vars: `NECTAR_RUN_ID`, `NECTAR_NODE_ID`, `NECTAR_SESSION_ID`, `NECTAR_TOOL_CALL_ID`, `NECTAR_TOOL_NAME`, `NECTAR_HOOK_PHASE`
- Fixed timeout of `15s` in this sprint
- Exit code `0` means proceed
- Non-zero means skip the tool call and return a synthetic `ToolResultEnvelope` with `is_error=true`

Post-hook contract:

- Runs after the tool call or after a synthetic pre-hook rejection
- Receives the same metadata plus `is_error`, `content_preview`, and `duration_ms`
- Never mutates the tool result returned to the model
- Failures are recorded, not escalated

Persist hook artifacts beside existing tool-call transcript artifacts:

```text
<node-dir>/tool-calls/001-shell/
├── request.json
├── result.json
├── pre-hook.json
├── pre-hook.stdout.log
├── pre-hook.stderr.log
├── post-hook.json
├── post-hook.stdout.log
└── post-hook.stderr.log
```

This sprint should also add concise events for:

- child run started
- child snapshot observed
- child steer note written
- run restarted
- tool hook blocked call

---

## Implementation phases

### Phase 1: Graph Schema, Parsing, and Validation

**Files:** `src/garden/types.ts`, `src/garden/parse.ts`, `src/garden/validate.ts`, `test/garden/parse.test.ts`, `test/garden/validate.test.ts`, `test/fixtures/manager-loop-basic.dot`, `test/fixtures/manager-loop-stop-condition.dot`, `test/fixtures/loop-restart.dot`

**Tasks:**

- [ ] Add `stack.manager_loop` to `NodeKind`, `house` to supported shapes, and `loop_restart` to `GardenEdge`
- [ ] Parse graph-level `stack.child_*` and `tool_hooks.*` attributes into typed graph fields
- [ ] Parse node-level `manager.*`, `stack.child_autostart`, and `tool_hooks.*` attributes into typed node fields
- [ ] Coerce `manager.poll_interval` using the existing duration parser
- [ ] Validate `manager.actions`, `manager.max_cycles`, `manager.stop_condition`, and `steer`-without-prompt
- [ ] Warn on `tool_hooks.*` attached to non-codergen nodes
- [ ] Add fixtures and parser/validator tests for manager loops and restart edges

### Phase 2: Manager Loop Supervision and Control Files

**Files:** `src/handlers/manager-loop.ts`, `src/handlers/registry.ts`, `src/engine/child-run-controller.ts`, `src/engine/engine.ts`, `src/engine/events.ts`, `src/checkpoint/run-store.ts`, `src/checkpoint/types.ts`, `test/handlers/manager-loop.test.ts`, `test/integration/manager-loop.test.ts`

**Tasks:**

- [ ] Make the registry graph-aware enough for `ManagerLoopHandler` and graph-scoped hook/child config resolution
- [ ] Implement `ChildRunController` for start, attach, snapshot reads, steer-note writes, and owned-child abort
- [ ] Implement `ManagerLoopHandler` with `observe`, `steer`, and `wait` actions
- [ ] Support `stack.child_autostart=false` by attaching to `context["stack.child.run_id"]`; fail clearly if missing
- [ ] Mirror child snapshot fields into `stack.child.*`
- [ ] Write and consume `control/manager-steer.json` atomically
- [ ] Emit concise supervisor events without forwarding the full child event tree
- [ ] Cover success, attach mode, child failure, and stop-condition success in unit and integration tests

### Phase 3: Fresh-Run Restart Semantics and Lineage

**Files:** `src/engine/engine.ts`, `src/engine/types.ts`, `src/checkpoint/types.ts`, `src/checkpoint/run-store.ts`, `src/cli/commands/run.ts`, `src/cli/commands/resume.ts`, `src/cli/commands/status.ts`, `src/cli/ui/renderer.ts`, `test/integration/loop-restart.test.ts`, `test/checkpoint/run-store.test.ts`

**Tasks:**

- [ ] Handle `loop_restart=true` immediately after edge selection and before advancing the current run
- [ ] Persist predecessor/successor metadata into manifests and cocoons
- [ ] Filter and carry forward context into the successor while resetting retry and session state
- [ ] Add a hard restart-depth guard and test the failure mode
- [ ] Make `nectar run` and `nectar resume` follow restart chains by default
- [ ] Update `nectar status` to show restart lineage cleanly
- [ ] Render restart transitions tersely so the CLI does not flood the terminal

### Phase 4: Tool Hooks and Audit Artifacts

**Files:** `src/agent-loop/tool-hooks.ts`, `src/agent-loop/session.ts`, `src/agent-loop/events.ts`, `src/agent-loop/transcript.ts`, `src/handlers/codergen.ts`, `test/agent-loop/tool-hooks.test.ts`, `test/integration/agent-loop.test.ts`

**Tasks:**

- [ ] Resolve effective pre/post hook commands from node scope first, then graph scope
- [ ] Wrap both ordinary tools and subagent tools with the same pre/post hook runner
- [ ] Send structured JSON payloads to hooks over stdin and mirrored `NECTAR_*` env vars
- [ ] Convert non-zero pre-hook exits into synthetic tool errors visible to the model
- [ ] Run post-hooks for both successful and failed tool calls without mutating tool results
- [ ] Persist hook stdout/stderr and metadata next to existing tool-call artifacts
- [ ] Test blocked calls, post-hook failures, and parallel tool-call behavior

---

## Files Summary

| Path | Change | Purpose |
|------|--------|---------|
| `src/garden/types.ts` | Modify | Add `stack.manager_loop`, manager fields, graph hook fields, and `loop_restart` |
| `src/garden/parse.ts` | Modify | Parse `house`, `manager.*`, `stack.child_*`, `tool_hooks.*`, and restart edges |
| `src/garden/validate.ts` | Modify | Validate manager-loop config, hook placement, and restart-edge inputs |
| `src/handlers/manager-loop.ts` | Create | New deterministic supervisor handler for child-run observation and steering |
| `src/handlers/registry.ts` | Modify | Register `stack.manager_loop` and make graph-scoped config reachable from handlers |
| `src/engine/child-run-controller.ts` | Create | In-process child-run orchestration, snapshot polling, and owned-run cleanup |
| `src/engine/engine.ts` | Modify | Consume steering notes, support restart chaining, and emit summary supervisor/restart events |
| `src/engine/types.ts` | Modify | Add restart-related result metadata where needed |
| `src/engine/events.ts` | Modify | Add manager-loop, restart, and tool-hook-blocked events |
| `src/checkpoint/types.ts` | Modify | Persist parent/child/restart linkage and control metadata |
| `src/checkpoint/run-store.ts` | Modify | Add control-file helpers and richer manifest support |
| `src/agent-loop/tool-hooks.ts` | Create | Hook execution, payload formatting, timeout handling, and result mapping |
| `src/agent-loop/session.ts` | Modify | Wrap tool execution with pre/post hooks for all model-visible tools |
| `src/agent-loop/events.ts` | Modify | Surface hook-blocked and hook-completed event details |
| `src/agent-loop/transcript.ts` | Modify | Persist hook artifacts beside tool-call artifacts |
| `src/handlers/codergen.ts` | Modify | Resolve hook config and consume manager notes in rendered prompts |
| `src/cli/commands/run.ts` | Modify | Follow successor runs automatically |
| `src/cli/commands/resume.ts` | Modify | Resume and continue through restart chains |
| `src/cli/commands/status.ts` | Modify | Show parent/child/restart relationships |
| `src/cli/ui/renderer.ts` | Modify | Render supervisor/restart/hook-block events tersely |
| `test/handlers/manager-loop.test.ts` | Create | Unit coverage for manager-loop behavior |
| `test/integration/manager-loop.test.ts` | Create | End-to-end parent/child supervision flows |
| `test/integration/loop-restart.test.ts` | Create | End-to-end restart-chain behavior |
| `test/agent-loop/tool-hooks.test.ts` | Create | Hook gating, audit, and failure-mode coverage |
| `test/fixtures/manager-loop-basic.dot` | Create | Minimal manager-loop fixture |
| `test/fixtures/manager-loop-stop-condition.dot` | Create | Stop-condition fixture |
| `test/fixtures/loop-restart.dot` | Create | Restart-semantics fixture |

---

## Definition of Done

- [ ] A DOT graph containing `shape="house"` parses, validates, and executes successfully.
- [ ] `manager.actions` defaults to `observe,wait` and rejects unknown tokens at validation time.
- [ ] `manager.stop_condition` evaluates against `stack.child.*` context keys during runtime.
- [ ] `stack.child_autostart=true` starts a child run from `stack.child_dotfile`; `false` attaches to an existing child run ID from context.
- [ ] Manager steering writes at most one pending note per `(child node, retry count)` tuple and the child consumes it before the next node starts.
- [ ] `loop_restart=true` creates a new run ID and fresh run directory, preserves filtered business context, and resets retry/session state.
- [ ] Restart chains are bounded by a hard depth cap and fail clearly when exceeded.
- [ ] `nectar run` and `nectar resume` follow restart chains automatically, and `nectar status` shows restart lineage.
- [ ] `tool_hooks.pre` can block a tool call and the model receives a synthetic error tool result explaining the skip.
- [ ] `tool_hooks.post` runs after executed tool calls and never mutates the tool result observed by the model.
- [ ] Hook artifacts, child linkage, and restart linkage are visible on disk in stable JSON/text files.
- [ ] The integration suite covers manager success, attach mode, child failure, stop-condition success, restart chaining, pre-hook block, and post-hook failure.
- [ ] Re-running the compliance report after implementation would close `GAP-A1`, `GAP-A2`, and `GAP-A3`.

---

## Risks

| Risk | Why it matters | Mitigation |
|------|----------------|------------|
| Parent/child lifecycle bugs leave orphaned child runs | A manager that exits early or is interrupted could strand background work and break trust in resume semantics | Treat auto-started children as owned resources; abort them on parent interruption or early-success exit; cover this in integration tests |
| Restart storms create infinite successor runs | `loop_restart` is useful, but a bad graph can create unbounded run chains | Add a hard restart-depth cap of `25`, persist lineage in manifest/cocoon, and fail clearly when the cap is exceeded |
| Tool hooks add latency or flakiness to every tool call | A bad hook can slow or destabilize the agent loop | Use fixed `15s` hook timeouts, best-effort post-hooks, and explicit transcript artifacts for debugging |
| Parent output becomes noisy or confusing | In-process child runs and manager events can overwhelm the CLI renderer | Emit summary supervisor events only; keep detailed child state canonical on disk instead of tunneling every child event |
| Context bleed between parent, child, and successor runs | Shared scratch keys would make stop conditions and restarts non-deterministic | Use explicit `stack.child.*` and `stack.manager.*` namespaces, and strip them when creating successor runs |

---

## Dependencies

- Existing engine substrate already in the repo: `PipelineEngine`, `ExecutionContext`, `RunStore`, manifests, canonical checkpoints, and artifact storage
- Existing agent-loop substrate already in the repo: `AgentSession`, `ToolRegistry`, `LocalExecutionEnvironment`, transcript writing, and subagent tools
- Existing condition-expression evaluator and duration parsing utilities
- Existing CLI commands and renderer for `run`, `resume`, and `status`
- Relevant upstream spec sections:
  - `docs/upstream/attractor-spec.md` Section 3.2 Step 7 (`loop_restart`)
  - `docs/upstream/attractor-spec.md` Section 4.11 (`stack.manager_loop`)
  - `docs/upstream/attractor-spec.md` Section 9.7 (`tool_hooks.pre` / `tool_hooks.post`)

**No new third-party runtime dependency should be introduced in this sprint.** The current Node.js, `execa`, checkpoint, and agent-loop infrastructure are sufficient.
