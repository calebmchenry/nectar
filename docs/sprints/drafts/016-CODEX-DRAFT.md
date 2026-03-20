# Sprint 016: Manager Loop Supervision, Fresh-Run Restart & Tool Call Hooks

## Overview

**Goal:** Close the last substantive attractor runtime gaps by shipping `stack.manager_loop`, `loop_restart`, and `tool_hooks.pre` / `tool_hooks.post`. After this sprint, Nectar can supervise a child garden from a `house` node, intentionally restart into a brand-new cocoon when an edge demands it, and gate or audit every agent tool call.

**Why this sprint, why now:**

- `GAP-A1`, `GAP-A2`, and `GAP-A3` are the remaining non-optional attractor execution gaps. `GAP-A4` is optional server surface area.
- Manager loop is the missing orchestration primitive that makes Nectar a supervisor, not just a stage runner.
- `loop_restart` and tool hooks belong in the same sprint because both are execution-control features: one controls run lifecycle, the other controls agent tool lifecycle.
- The Unified LLM client gaps matter, but they are SDK hardening. This sprint should finish the engine first.

**Gaps closed:**

| Gap | Description |
|-----|-------------|
| `GAP-A1` | `house` / `stack.manager_loop` handler with child supervision, polling, stop conditions, and stage-boundary steering |
| `GAP-A2` | `loop_restart=true` edge parsing and fresh-run restart behavior |
| `GAP-A3` | `tool_hooks.pre` and `tool_hooks.post` around every agent tool call |

**In scope:**

- `house` shape parsing, validation, and runtime mapping to `stack.manager_loop`
- Graph attributes `stack.child_dotfile`, `stack.child_workdir`, `tool_hooks.pre`, `tool_hooks.post`
- Node attributes `manager.poll_interval`, `manager.max_cycles`, `manager.stop_condition`, `manager.actions`, `stack.child_autostart`
- In-process child run supervision with telemetry ingestion into `stack.child.*`
- Stage-boundary steering via filesystem control files consumed before the next child node starts
- `loop_restart` successor-run creation with manifest linkage and CLI follow-through
- Pre/post tool hooks for all model-visible tools, including subagent tools
- Unit and integration coverage for supervision, restart chaining, and hook gating

**Out of scope:**

- `GAP-A4` HTTP server mode
- Unified LLM client middleware, model catalog, cache reporting, and default-client work
- Live mid-token or mid-tool steering into an already-running child turn
- Web UI, seedbed, swarm analysis, or any new product surface area

**Opinionated decisions:**

- Child runs are supervised **in process**, not by shelling out to `nectar run`.
- Steering is **next-turn, file-backed control**, not arbitrary live mutation of an active model stream.
- A restart creates a **new run ID and new run directory**, but preserves filtered business context. It does **not** keep retry state or live sessions.
- Restarted runs will reuse the existing `interrupted` status plus successor metadata instead of inventing a brand-new `restarted` run status.

---

## Use Cases

1. **Supervisor starts and watches a child pipeline.** A parent garden contains `manager [shape=house]` and graph attributes `stack.child_dotfile="gardens/child.dot"` and `stack.child_workdir="."`. When the manager node runs, Nectar launches the child graph in a fresh cocoon, polls its checkpoint, mirrors `stack.child.status`, `stack.child.current_node`, and `stack.child.completed_count` into context, and exits `SUCCESS` when the child completes successfully.

2. **Supervisor stops on an explicit guard, not only child completion.** A manager node sets `manager.stop_condition="context.stack.child.current_node=review && context.stack.child.retry_count=0"`. Nectar keeps polling the child until that condition evaluates true, then returns `SUCCESS` immediately. If the manager auto-started the child, it also aborts the child cleanly so the parent does not leave an orphaned run behind.

3. **Supervisor intervenes between child stages.** A manager node sets `manager.actions="observe,steer,wait"` and provides a `prompt` like "Stop coding and fix the failing tests before continuing." When the child advances to a new active node or retry attempt, the manager writes a control note into the child run directory. Before the next child node executes, the child engine consumes that note and prepends it to the next codergen prompt.

4. **Intentional clean restart after a bad branch.** A graph routes `review -> implement [condition="outcome=failure", loop_restart=true]`. When that edge is selected, Nectar closes the current run as interrupted-with-successor, creates a fresh run directory, restores filtered context, resets retry and thread state, and resumes execution at `implement` in the new run.

5. **Tool-call governance blocks or audits risky actions.** A graph sets `tool_hooks.pre="./scripts/policy-check.sh"` and `tool_hooks.post="./scripts/audit-tool-call.sh"`. Before `shell`, `apply_patch`, or `spawn_agent` executes, the pre-hook receives metadata over stdin and environment variables. Exit code `0` allows the call; non-zero returns a synthetic error tool result to the model and records the skip. The post-hook runs after every executed tool call and writes audit artifacts without altering the actual tool result.

---

## Architecture

### Design Principles

1. **Supervision must reuse the existing engine, not bypass it.** The manager loop should create and observe a real `PipelineEngine` child run so checkpointing, events, retries, and manifests stay canonical.
2. **Steering should be buildable in one sprint.** The manager writes durable control notes that the child consumes before node start. No live socket control plane, no hidden mutable globals.
3. **Restarts reset runtime state, not user intent.** A restart gets a fresh cocoon and session registry, but keeps the useful execution context needed to continue work.
4. **Hooks are per-call wrappers, not middleware.** The right integration point is `AgentSession` around `registry.execute(...)`, because that is where tool metadata, results, transcript writing, and parallel execution already meet.

### Manager Loop Runtime

Add a new node kind and shape mapping:

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

Parse and normalize these fields into first-class types instead of leaving them buried in raw attribute maps:

- Graph: `stack.child_dotfile`, `stack.child_workdir`, `tool_hooks.pre`, `tool_hooks.post`
- Node: `manager.poll_interval`, `manager.max_cycles`, `manager.stop_condition`, `manager.actions`, `stack.child_autostart`, `tool_hooks.pre`, `tool_hooks.post`
- Edge: `loop_restart`

Introduce `src/handlers/manager-loop.ts` plus `src/engine/child-run-controller.ts`.

`ManagerLoopHandler.execute(...)` will:

1. Resolve child configuration from graph and node attributes.
2. Start a child run when `stack.child_autostart=true`.
3. Poll the child snapshot for up to `manager.max_cycles`.
4. Ingest telemetry into the parent context under `stack.child.*`.
5. Optionally write one steer note per `(child current node, child retry count)` tuple to avoid spam.
6. Evaluate `manager.stop_condition` with the existing condition engine against the parent context snapshot.
7. Return `SUCCESS` on satisfied stop condition or successful child completion.
8. Return `FAILURE` on child failure, missing child configuration, or max-cycle exhaustion.

The telemetry namespace should be explicit and stable:

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

That gives `manager.stop_condition` enough surface area to be useful without inventing another ad hoc state channel.

### Child Run Control Files

This sprint should add a small, filesystem-first control plane under the child run directory:

```text
.nectar/cocoons/<child-run-id>/
├── manifest.json
├── checkpoint.json
├── control/
│   └── manager-steer.json
└── <node-id>/
```

`manager-steer.json` contains one pending steering note plus metadata:

```json
{
  "source_run_id": "parent-run",
  "source_node_id": "manager",
  "child_run_id": "child-run",
  "message": "Stop coding and fix the failing tests before continuing.",
  "created_at": "2026-03-20T00:00:00Z"
}
```

The child engine checks for this file immediately before node execution. If present:

- For codergen nodes, prepend the note to the rendered prompt.
- For non-codergen nodes, stash it in context as `stack.manager.note` and continue.
- Consume the file atomically so the same note is not applied twice.

This keeps steering durable, observable, and testable.

### Restart Semantics

`loop_restart` belongs on `GardenEdge` as a boolean. When the selected edge sets `loop_restart=true`, the engine should:

1. Persist the current run as `status="interrupted"` with `interruption_reason="loop_restart"`.
2. Record successor metadata in the current manifest and cocoon.
3. Create a brand-new `PipelineEngine` instance with a new `run_id`.
4. Start that new run at `next_edge.target`.
5. Carry forward filtered context:
   - Keep user and business keys.
   - Drop `current_node`, `outcome`, `preferred_label`, `last_stage`, and `internal.*`.
6. Reset retry state, pending transition, and live session/thread registry.

Add manifest linkage fields:

```ts
interface ManifestData {
  run_id: string;
  dot_file: string;
  graph_hash: string;
  started_at: string;
  workspace_root: string;
  parent_run_id?: string;
  parent_node_id?: string;
  restart_of?: string;
  restarted_to?: string;
}
```

The CLI should follow restart chains by default:

- `nectar run` keeps streaming through successor runs until a non-restart terminal result
- `nectar resume` resumes the selected run and then follows any restart successor it emits
- `nectar status <run-id>` shows `restart_of` / `restarted_to` links

### Tool Hook Runtime

Hook resolution precedence is simple:

1. Node-level hook on the executing codergen node
2. Graph-level hook
3. No hook

Create `src/agent-loop/tool-hooks.ts` and wrap tool execution in `AgentSession` around both ordinary tools and subagent tools.

Pre-hook contract:

- Runs before the actual tool call
- Receives stdin JSON with run, node, session, tool, and arguments metadata
- Receives matching `NECTAR_*` environment variables
- Exit code `0` means proceed
- Non-zero means skip the tool call and return a synthetic `ToolResultEnvelope` with `is_error=true`

Post-hook contract:

- Runs after the tool call completes or returns a synthetic pre-hook rejection
- Receives the same metadata plus result fields (`is_error`, `content_preview`, `duration_ms`)
- Never changes the tool result returned to the model
- Failures are logged, not escalated

Persist hook artifacts beside the tool call transcript:

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

This sprint should also emit structured events for:

- child run started / observed / steered
- run restarted
- tool hook blocked call

The renderer can keep these terse; the important part is that the events exist for logs, future SSE, and debugging.

---

## Implementation phases

### Phase 1: Garden Schema, Parsing, and Validation

**Files:** `src/garden/types.ts`, `src/garden/parse.ts`, `src/garden/validate.ts`, `test/garden/parse.test.ts`, `test/garden/validate.test.ts`, `test/fixtures/manager-loop-basic.dot`, `test/fixtures/loop-restart.dot`

**Tasks:**

- [ ] Add `stack.manager_loop` to `NodeKind`, `house` to supported shapes, and `loop_restart` to `GardenEdge`
- [ ] Parse graph-level `stack.child_*` and `tool_hooks.*` attributes into typed fields on `GardenGraph`
- [ ] Parse node-level `manager.*`, `stack.child_autostart`, and `tool_hooks.*` attributes into typed fields on `GardenNode`
- [ ] Validate `manager.actions` as a comma-separated subset of `observe`, `steer`, `wait`
- [ ] Validate `manager.max_cycles` as a positive integer and `manager.poll_interval` as a valid duration
- [ ] Validate `manager.stop_condition` with the existing condition parser
- [ ] Error when `steer` is present without a non-empty `prompt`
- [ ] Warn when `tool_hooks.*` appears on non-codergen nodes, since it has no runtime effect there this sprint

### Phase 2: Manager Loop Supervision

**Files:** `src/handlers/manager-loop.ts`, `src/handlers/registry.ts`, `src/engine/child-run-controller.ts`, `src/engine/engine.ts`, `src/engine/events.ts`, `src/checkpoint/run-store.ts`, `src/checkpoint/types.ts`, `test/handlers/manager-loop.test.ts`, `test/integration/manager-loop.test.ts`

**Tasks:**

- [ ] Implement `ManagerLoopHandler` with observe / steer / wait cycle behavior
- [ ] Start child runs in process via `PipelineEngine`, not via subprocess CLI
- [ ] Support `stack.child_autostart=false` by attaching to `context["stack.child.run_id"]`; fail clearly if absent
- [ ] Mirror child snapshot fields into `stack.child.*`
- [ ] Write and consume `control/manager-steer.json` files atomically
- [ ] Abort owned child runs when the manager exits early or the parent run is interrupted
- [ ] Add structured events for child lifecycle and steering
- [ ] Cover success, child failure, stop-condition success, and missing-child-config cases in tests

### Phase 3: Fresh-Run Restart Semantics

**Files:** `src/engine/engine.ts`, `src/engine/types.ts`, `src/checkpoint/types.ts`, `src/checkpoint/run-store.ts`, `src/cli/commands/run.ts`, `src/cli/commands/resume.ts`, `src/cli/commands/status.ts`, `src/cli/ui/renderer.ts`, `test/integration/loop-restart.test.ts`, `test/checkpoint/run-store.test.ts`

**Tasks:**

- [ ] Handle `loop_restart=true` immediately after edge selection and before advancing the current run
- [ ] Persist predecessor/successor metadata into manifests and cocoons
- [ ] Filter and carry forward context into the successor run while resetting retry and session state
- [ ] Make `run` and `resume` follow restart chains by default
- [ ] Render restart transitions cleanly in the CLI without flooding the terminal
- [ ] Verify that `status` exposes restart lineage and that old cocoons remain inspectable

### Phase 4: Tool Call Hooks and Audit Artifacts

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/tool-hooks.ts`, `src/agent-loop/transcript.ts`, `src/agent-loop/events.ts`, `src/handlers/codergen.ts`, `test/agent-loop/tool-hooks.test.ts`, `test/integration/agent-loop.test.ts`

**Tasks:**

- [ ] Resolve effective pre/post hook commands from node then graph scope
- [ ] Execute hooks around every model-visible tool call, including subagent tools
- [ ] Send structured JSON payloads to hooks over stdin and mirrored `NECTAR_*` env vars
- [ ] Convert non-zero pre-hook exits into synthetic tool errors visible to the model
- [ ] Run post-hooks for both successful and failed tool calls without changing tool results
- [ ] Persist hook stdout/stderr and metadata next to transcript artifacts
- [ ] Test blocked calls, post-hook failures, and parallel tool-call behavior

---

## Files Summary

| Path | Change | Purpose |
|------|--------|---------|
| `src/garden/types.ts` | Modify | Add `stack.manager_loop`, manager attributes, graph hook fields, and `loop_restart` |
| `src/garden/parse.ts` | Modify | Parse `house`, `manager.*`, `stack.child_*`, `tool_hooks.*`, and `loop_restart` |
| `src/garden/validate.ts` | Modify | Validate manager-loop config, hook placement, and restart edge syntax |
| `src/handlers/manager-loop.ts` | Create | New supervisor handler for child-run observation and steering |
| `src/handlers/registry.ts` | Modify | Register `stack.manager_loop` / `house` |
| `src/engine/child-run-controller.ts` | Create | In-process child run orchestration, snapshot polling, and owned-run cleanup |
| `src/engine/engine.ts` | Modify | Consume control notes, support restart chaining, and surface new events |
| `src/engine/types.ts` | Modify | Add restart-related result and metadata types |
| `src/engine/events.ts` | Modify | Add manager-loop, restart, and hook-blocked events |
| `src/checkpoint/types.ts` | Modify | Persist parent/child/restart linkage and control metadata |
| `src/checkpoint/run-store.ts` | Modify | Add control-file helpers and richer manifest support |
| `src/agent-loop/tool-hooks.ts` | Create | Hook execution, payload formatting, and result mapping |
| `src/agent-loop/session.ts` | Modify | Wrap tool execution with pre/post hooks |
| `src/agent-loop/transcript.ts` | Modify | Persist hook artifacts beside tool-call artifacts |
| `src/handlers/codergen.ts` | Modify | Pass resolved hook config and consume manager notes in rendered prompts |
| `src/cli/commands/run.ts` | Modify | Follow successor runs automatically |
| `src/cli/commands/resume.ts` | Modify | Resume and continue through restart chains |
| `src/cli/commands/status.ts` | Modify | Show parent/child/restart relationships |
| `src/cli/ui/renderer.ts` | Modify | Render supervisor/restart/hook-block events tersely |
| `test/handlers/manager-loop.test.ts` | Create | Unit coverage for manager loop behavior |
| `test/integration/manager-loop.test.ts` | Create | End-to-end parent/child supervision flows |
| `test/integration/loop-restart.test.ts` | Create | End-to-end restart-chain behavior |
| `test/agent-loop/tool-hooks.test.ts` | Create | Hook gating, audit, and failure-mode coverage |
| `test/fixtures/manager-loop-basic.dot` | Create | Minimal manager-loop fixture |
| `test/fixtures/manager-loop-stop-condition.dot` | Create | Stop-condition fixture |
| `test/fixtures/loop-restart.dot` | Create | Restart semantics fixture |

---

## Definition of Done

- [ ] A DOT graph containing `shape="house"` parses, validates, and executes successfully.
- [ ] `manager.actions` defaults to `observe,wait` and rejects unknown tokens at validation time.
- [ ] `manager.stop_condition` evaluates against `stack.child.*` context keys during runtime.
- [ ] `stack.child_autostart=true` starts a child run from `stack.child_dotfile`; `false` attaches to an existing child run ID from context.
- [ ] Manager steering writes exactly one pending note per child node/retry tuple and the child consumes it before the next node starts.
- [ ] `loop_restart=true` creates a new run ID and fresh run directory, preserves filtered context, and resets retry/session state.
- [ ] `nectar run` and `nectar resume` follow restart chains automatically, and `nectar status` shows the lineage.
- [ ] `tool_hooks.pre` can block a tool call and the model receives a synthetic error tool result explaining the skip.
- [ ] `tool_hooks.post` runs after executed tool calls and never mutates the tool result observed by the model.
- [ ] Hook artifacts, child linkage, and restart linkage are visible on disk in stable JSON/text files.
- [ ] The integration suite covers: manager success, manager child failure, manager stop condition, restart chain, pre-hook block, and post-hook failure.
- [ ] Re-running the compliance report after implementation would close `GAP-A1`, `GAP-A2`, and `GAP-A3`.

---

## Risks

| Risk | Why it matters | Mitigation |
|------|----------------|------------|
| Parent/child lifecycle bugs leave orphaned child runs | A manager that exits early could strand background work and corrupt user trust | Treat auto-started children as owned resources; abort them on parent interruption or early-success exit |
| Restart chains become hard to inspect or resume | Fresh run IDs are correct, but confusing if lineage is hidden | Persist `restart_of` / `restarted_to` in manifest and cocoon; show lineage in `status` and renderer |
| Hook commands add flakiness or latency | A bad pre/post hook can slow or destabilize every tool call | Use strict hook timeouts, best-effort post-hooks, and explicit transcript artifacts for debugging |
| Steering notes pile up or apply twice | Duplicate control files would make child prompts noisy and nondeterministic | Use a single pending control file per child run and consume it atomically before node start |
| Manager loops become infinite pollers | A supervisor bug can stall the whole parent run | Enforce `manager.max_cycles`, validate positive limits, and record every observe/wait cycle in structured events |

---

## Dependencies

- Sprint 015 runtime groundwork: canonical run directories, manifests, checkpoints, artifact store, and event plumbing
- Existing `PipelineEngine`, `RunStore`, `ExecutionContext`, and condition-expression evaluator
- Existing agent-loop stack: `AgentSession`, `ToolRegistry`, `LocalExecutionEnvironment`, transcript writer, and subagent tools
- Existing filesystem-first workspace contract from `docs/INTENT.md`
- Pinned upstream spec sections:
  - `docs/upstream/attractor-spec.md` §3.2 Step 7 (`loop_restart`)
  - `docs/upstream/attractor-spec.md` §4.11 (`stack.manager_loop`)
  - `docs/upstream/attractor-spec.md` §9.7 (`tool_hooks.pre` / `tool_hooks.post`)

**No new third-party runtime dependency should be introduced in this sprint.** The current Node.js, `execa`, checkpoint, and agent-loop infrastructure are sufficient.
