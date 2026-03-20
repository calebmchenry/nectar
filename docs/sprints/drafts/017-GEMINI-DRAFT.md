# Sprint NEXT: Supervisor Workflows & Continuous Execution

## Overview

**Goal:** Close the highest-priority gaps identified in the latest compliance report, specifically GAP-A1 (Manager Loop) and GAP-A2 (loop_restart). This sprint unlocks supervisor/child pipeline orchestration and continuous re-execution workflows, moving Nectar to 100% compliance for core Attractor flow control features.

**Scope:** 
- Parse and implement the `stack.manager_loop` handler mapping from the `house` shape.
- Implement the `ManagerLoopHandler` to supervise child pipelines (observe/guard/steer cycles) with support for node attributes like `manager.poll_interval`, `manager.max_cycles`, `manager.stop_condition`, and `manager.actions`.
- Parse and implement engine execution support for the `loop_restart=true` edge attribute.
- Add validation rules for manager loops and loop restarts.

**Out of scope:**
- GAP-A3 (Tool Call Hooks) - deferred to a security/auditing-focused sprint.
- GAP-A5 (HTTP Server Mode) - deferred to a backend/integration sprint.
- GAP-L1 (OpenAI-Compatible Adapter) - deferred to an LLM client sprint.
- Web UI and seedbed updates.

---

## Use Cases

1. **Supervisor Pattern:** A parent pipeline uses a `house` node to launch and supervise a child pipeline (e.g., a specific coding or analysis agent loop). The manager loop monitors the child's status according to `manager.poll_interval`, evaluates the `manager.stop_condition`, and decides whether to intervene, steer, or terminate based on `manager.max_cycles`.

2. **Continuous Pipeline Execution:** A data ingestion or monitoring pipeline completes its core workflow and follows an edge with `loop_restart=true`. The engine cleanly terminates the current run, archives the cocoon, creates a fresh log directory, and restarts execution from the `Mdiamond` node, enabling perpetual autonomous loops without memory leaks or script restarts.

---

## Architecture

### Module Layout Updates

- `src/garden/types.ts`: Add `stack.manager_loop` to `NodeKind`. Add `loop_restart` property to `GardenEdge`. Define manager-specific attributes (`stack.child_dotfile`, `manager.poll_interval`, etc.).
- `src/garden/parse.ts`: Map the `house` shape to `stack.manager_loop`. Parse `loop_restart` on edges and `stack.*`/`manager.*` attributes on nodes. Apply duration coercion to `poll_interval`.
- `src/handlers/manager-loop.ts` (NEW): Implement the `ManagerLoopHandler`. This handler instantiates a child `PipelineEngine`, manages its lifecycle, and runs a polling loop.
- `src/engine/engine.ts`: Update Step 7 of the core execution loop. If the selected edge has `loop_restart=true`, trigger the `restart_run` sequence (archive current cocoon, initialize new run state, reset to start node).

### Key Abstractions

**`ManagerLoopHandler`**: Implements the `NodeHandler` interface. When executed, it reads `stack.child_dotfile`, initializes a new `PipelineEngine` for the child, and potentially starts it based on `stack.child_autostart`. It then enters an asynchronous polling loop (delaying by `manager.poll_interval`), checking the child's status and evaluating `manager.stop_condition`. It enforces `manager.max_cycles` to prevent infinite supervision loops.

**`loop_restart` Engine Flow**: When the `EdgeSelector` returns an edge with `loop_restart=true`, the `PipelineEngine` completes the current node, fires a `run_completed` or new `run_restarting` event, generates a new execution ID and cocoon directory, resets the context (or explicitly carries over specific state if the spec dictates), and jumps back to the start node.

---

## Implementation Phases

### Phase 1: Parsing and Types (~20%)
**Files:** `src/garden/types.ts`, `src/garden/parse.ts`, `test/garden/parse.test.ts`
- Add `stack.manager_loop` to the `NodeKind` union.
- Add `loop_restart` boolean to `GardenEdge`.
- Add `stack.child_dotfile`, `stack.child_workdir` to graph attributes.
- Add `manager.poll_interval`, `manager.max_cycles`, `manager.stop_condition`, `manager.actions`, `stack.child_autostart` to node attributes.
- Update `parse.ts` to extract these values and apply proper type coercion (e.g., duration parsing for `poll_interval`).

### Phase 2: Engine Support for loop_restart (~25%)
**Files:** `src/engine/engine.ts`, `src/engine/events.ts`, `test/engine/engine.test.ts`
- Update `PipelineEngine` core loop to detect `loop_restart=true` on the selected edge.
- Implement the `restart_run` sequence: save the final state of the current run, generate a new run ID, clear node completion state, and set the current node back to the start node.
- Ensure events are emitted correctly to signify the restart boundary without crashing the CLI/UI renderers.

### Phase 3: Manager Loop Handler (~35%)
**Files:** `src/handlers/manager-loop.ts`, `src/handlers/registry.ts`, `test/handlers/manager-loop.test.ts`
- Implement `ManagerLoopHandler`.
- Build the supervision loop: start child engine -> delay `poll_interval` -> check status -> evaluate `stop_condition` -> repeat or exit.
- Integrate with `PipelineEngine` so the child engine writes to the appropriate sub-directory or scoped cocoon.
- Register the handler in `registry.ts`.

### Phase 4: Integration and Validation (~20%)
**Files:** `src/garden/validate.ts`, `test/garden/validate.test.ts`, `test/integration/manager-loop.test.ts`, `test/integration/loop-restart.test.ts`
- Add validation rules: `house` nodes must have `stack.child_dotfile` defined.
- Create integration tests for a pipeline that uses `loop_restart`.
- Create integration tests for a `house` node successfully supervising a mock child pipeline.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/types.ts` | Modify | Add `stack.manager_loop`, `loop_restart`, and new manager attributes |
| `src/garden/parse.ts` | Modify | Parse `house` shape, `loop_restart`, and duration coercions |
| `src/garden/validate.ts` | Modify | Add structural validation rules for manager nodes |
| `src/engine/engine.ts` | Modify | Implement `loop_restart` execution flow |
| `src/handlers/registry.ts` | Modify | Register `house` -> `stack.manager_loop` |
| `src/handlers/manager-loop.ts` | Create | Implementation of the manager loop handler |
| `test/garden/parse.test.ts` | Modify | Test parsing of manager attributes and edge properties |
| `test/garden/validate.test.ts` | Modify | Test validation of manager node definitions |
| `test/engine/engine.test.ts` | Modify | Test `loop_restart` engine behavior |
| `test/handlers/manager-loop.test.ts`| Create | Unit tests for ManagerLoopHandler |
| `test/integration/manager-loop.test.ts` | Create | End-to-end test for child pipeline supervision |
| `test/integration/loop-restart.test.ts` | Create | End-to-end test for continuous execution pipelines |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors.
- [ ] The `house` shape correctly resolves to the `stack.manager_loop` handler.
- [ ] `ManagerLoopHandler` correctly spins up a child pipeline, respects `poll_interval`, and terminates when `stop_condition` is met or `max_cycles` is exhausted.
- [ ] `loop_restart=true` on an edge correctly terminates the current run and starts a new one with a fresh log directory (cocoon).
- [ ] `nectar validate` successfully lints graphs using these new features, catching errors like missing child dotfiles.
- [ ] Unit and integration tests cover both GAP-A1 and GAP-A2 functionalities.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Child pipeline resource leaks | Medium | High | Ensure `ManagerLoopHandler` guarantees child engine termination/cleanup on exit or parent interrupt. Ensure SIGINT propagates cleanly. |
| `loop_restart` causing infinite rapid loops | High | Medium | Implement a hard limit on automatic restarts or require an explicit minimal delay. |
| Nested execution contexts clashing | Low | Medium | Enforce strict isolation of `RunState` and context between parent and child engines by scoping cocoons accurately. |
| Terminal UI distortion on restart | Low | Medium | Update the CLI renderer to handle the new `run_restarting` event smoothly without breaking spinners. |

---

## Dependencies

- No new external dependencies. Relies on existing `PipelineEngine` and `execa` infrastructure.
- Blocks heavily on the correctness of `src/garden/parse.ts` and `src/engine/engine.ts` state management.
