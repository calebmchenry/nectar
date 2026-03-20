# Sprint 004: Parallel Execution and Fan-In

## Overview

**Goal:** Implement parallel execution pipelines by introducing the `component` (parallel fan-out) and `tripleoctagon` (fan-in) node shapes. This directly addresses GAP-02 and GAP-03, allowing Nectar to run independent nodes concurrently (e.g., executing multiple AI draft prompts or running independent compliance checks simultaneously) and then synchronize their results. This is the highest-impact gap remaining in the engine and is a prerequisite for performant real-world workflows.

**Scope:**
- Implement the `parallel` handler (mapped to the `component` shape) to fan-out execution.
- Implement the `parallel.fan_in` handler (mapped to the `tripleoctagon` shape) to synchronize concurrent branches.
- Update `engine.ts` and `context.ts` to support concurrent path traversal and isolated execution contexts per branch.
- Implement join policies: `wait_all` and `first_success`.
- Update DOT validation rules to support the new shapes and validate parallel constraints.
- Update the Cocoon checkpointing system to safely store and resume parallel execution state.

**Out of scope:**
- Manager Loop (GAP-04)
- Model Stylesheet (GAP-06)
- Subgraphs (GAP-14)
- Coding Agent Loop (GAP-40)
- Unified LLM Client expansion (GAP-50)

---

## Use Cases

1. **Concurrent AI Drafting:** A pipeline needs to generate 3 independent drafts. A `component` node fans out to 3 `codergen` nodes. They execute concurrently, reducing total wait time by running in parallel. A `tripleoctagon` fan-in node waits for all 3 to complete (`join_policy="wait_all"`) and consolidates their output in the context under `parallel.results`.
2. **First Success Racing:** A pipeline attempts to fetch data using 3 different strategies/tools concurrently. The `component` node fans out to 3 `tool` nodes. The fan-in node is configured with `join_policy="first_success"`. As soon as one strategy returns successfully, the fan-in node proceeds and the other branches are intentionally ignored/cancelled.
3. **Context Isolation:** While branches execute concurrently, they modify their own cloned contexts. Changes made by branch A do not affect branch B. When the fan-in node synchronizes them, it merges their contexts according to the join policy without race conditions.
4. **Resilient Resumption:** If a parallel run is interrupted (e.g., SIGINT) while two branches are still computing and one has finished, `pollinator resume` will load the cocoon, acknowledge the finished branch, and resume only the two incomplete branches.

---

## Architecture

### Language & Frameworks
Continuing with TypeScript on Node.js 22+. Concurrency will be managed using native Node.js `Promise` primitives (`Promise.all`, `Promise.any`) inside the engine, keeping the single-process architecture while leveraging async I/O.

### Module Layout Updates

```text
nectar/
├── src/
│   ├── engine/
│   │   ├── parallel.ts           # Orchestration logic for branch synchronization
│   ├── handlers/
│   │   ├── parallel.ts           # Fan-out handler (component)
│   │   ├── fan-in.ts             # Fan-in handler (tripleoctagon)
```

### Key Abstractions

**`ExecutionContext Isolation`** — `ExecutionContext` will be extended with `clone()` and `merge()` capabilities. When a `parallel` handler triggers, the engine creates isolated context clones for each selected outgoing edge.

**`Branch State Management`** — The `RunState` and `Cocoon` must be upgraded. Instead of a single `current_node`, the state must track an array/set of active execution paths, each with its own state pointer and contextual slice.

**`Join Policies`** — 
- `wait_all`: The engine tracks all branches originating from a fan-out. The fan-in node evaluates only when all paths have either reached the fan-in or terminated.
- `first_success`: The fan-in node proceeds the moment the first successful branch arrives, signaling an abort via `AbortController` to the remaining active branches of that fan-out group.

---

## Implementation Phases

### Phase 1: Parsing, Validation & Context Isolation (~20%)

**Tasks:**
- Add `component` and `tripleoctagon` to `SUPPORTED_SHAPES` in `src/garden/parse.ts`.
- Extract the `join_policy` attribute (defaulting to `wait_all`) from fan-in nodes.
- Update `src/garden/validate.ts` to include structural checks: warn if a `component` does not have a downstream `tripleoctagon` (or vice versa), and validate `join_policy` enum values.
- Enhance `src/engine/context.ts` to support `clone()` (deep copy of KV store) and `merge(contexts[])` to combine branch results into `parallel.results`.

### Phase 2: Core Engine Concurrency (~30%)

**Tasks:**
- Modify `src/engine/engine.ts` execution loop to support multiple active nodes. Transition from a strict `while(current_node)` loop to an asynchronous event-driven or queue-based execution model where multiple nodes can process simultaneously.
- Update `EdgeSelector` to select *all* valid candidate edges for the `parallel` node (unlike standard nodes where it picks one winner).
- Ensure thread-safety-equivalent protections when writing status JSON files or emitting `RunEvent`s.

### Phase 3: Handlers (Fan-Out / Fan-In) (~25%)

**Tasks:**
- Implement `src/handlers/parallel.ts` (`component`). This handler performs minimal work itself; it signals to the engine to branch execution and clone contexts.
- Implement `src/handlers/fan-in.ts` (`tripleoctagon`). This handler evaluates incoming branch completions against its `join_policy`.
- Implement `wait_all`: Aggregate outcomes, write to `parallel.results`.
- Implement `first_success`: Identify the winner, cancel siblings via an injected `AbortSignal`, and write the winner to `parallel.results`.

### Phase 4: Checkpointing & CLI Integration (~25%)

**Tasks:**
- Overhaul `Cocoon` schema in `src/checkpoint/types.ts` to store `active_branches` (array of node IDs and their isolated contexts) instead of a single `current_node`.
- Update atomic write logic in `src/checkpoint/cocoon.ts` to ensure concurrent branch completions don't overwrite each other's checkpoint saves (e.g., using a mutex/lock around the write operation).
- Update `src/cli/commands/resume.ts` to reconstruct the multi-branch state and reignite all active paths.
- Adjust `src/cli/ui/renderer.ts` to clearly display concurrent node executions (e.g., multiple spinners active at once).

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/parse.ts` | Modify | Add `component`, `tripleoctagon`, and `join_policy` |
| `src/garden/validate.ts` | Modify | Validate parallel/fan-in topology constraints |
| `src/engine/context.ts` | Modify | Add `clone()` and `merge()` capabilities |
| `src/engine/engine.ts` | Modify | Transition loop to support concurrent active nodes |
| `src/handlers/registry.ts` | Modify | Register new parallel handlers |
| `src/handlers/parallel.ts` | Create | Fan-out logic implementation |
| `src/handlers/fan-in.ts` | Create | Fan-in synchronization and `join_policy` logic |
| `src/checkpoint/types.ts` | Modify | Upgrade Cocoon schema for multi-branch tracking |
| `src/checkpoint/cocoon.ts` | Modify | Make atomic writes safe under concurrent completion |
| `src/cli/ui/renderer.ts` | Modify | Support rendering multiple simultaneous spinners |
| `test/engine/parallel.test.ts` | Create | Engine-level concurrency and join policy tests |
| `test/fixtures/parallel-wait-all.dot` | Create | End-to-end fixture for `wait_all` |
| `test/fixtures/parallel-first-success.dot` | Create | End-to-end fixture for `first_success` |

---

## Definition of Done

- [ ] `component` and `tripleoctagon` node shapes parse without errors.
- [ ] Pipeline engine correctly executes multiple branches concurrently after a `component` node (verified by wall-clock time in tests).
- [ ] Context is strictly isolated between concurrent branches.
- [ ] Fan-in node successfully synchronizes branches using `wait_all` policy and populates `parallel.results` in the unified context.
- [ ] Fan-in node successfully synchronizes branches using `first_success` policy, cancels peers, and proceeds immediately on the first success.
- [ ] Cocoon checkpoint safely and correctly persists the state of multiple in-flight branches without data races.
- [ ] `pollinator resume` correctly restarts all incomplete parallel branches from their specific intermediate states.
- [ ] CLI renderer gracefully handles overlapping events and visually indicates parallel execution.
- [ ] `npm test` passes all unit and integration tests.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Checkpoint Data Races** | High | High | Multiple concurrent nodes finishing simultaneously could cause overlapping file writes to the Cocoon. Implement an async mutex (e.g., using a simple Promise queue) around the `writeCocoon` operation. |
| **Console Output Interleaving** | High | Medium | Multiple branches logging simultaneously could break the UI. The event-driven `EventRenderer` must be updated to manage an active "pool" of spinners rather than a single linear stream. |
| **Engine State Complexity** | Medium | High | Moving from a single `current_node` loop to concurrent tracking significantly increases engine complexity. Thoroughly unit test the state machine transitions before modifying the core loop. |
| **Orphaned `first_success` branches** | Medium | Medium | If `first_success` is met, other branches must be cleanly aborted, not just abandoned, to free up resources and avoid late side-effects. Pass an `AbortSignal` down to all handlers. |

---

## Dependencies

No new external NPM dependencies are required. The concurrency model relies on native Node.js `Promise.all`/`Promise.any` and the existing event infrastructure. Concurrency control for writes will be implemented using a minimal custom async lock or queue.