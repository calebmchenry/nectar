# Sprint 004: Parallel Fan-Out / Fan-In Handlers

## Overview

**Goal:** Deliver the parallel execution subsystem — the `component` (parallel fan-out) and `tripleoctagon` (fan-in) handlers — so that pipelines can run multiple branches concurrently with isolated contexts, bounded concurrency, and configurable join policies. After this sprint, the compliance-loop garden can fan out its three draft nodes and three critique nodes concurrently instead of sequentially.

**Scope:**
- GAP-02: Parallel handler (`component` shape → `parallel` kind) — HIGH
- GAP-03: Fan-in handler (`tripleoctagon` shape → `parallel.fan_in` kind) — HIGH
- GAP-12 (partial): `HandlerRegistry.register()` method for runtime handler registration
- GAP-30 (partial): Parallel events — `parallel_started`, `parallel_branch_started`, `parallel_branch_completed`, `parallel_completed`
- Node attribute parsing for `join_policy`, `max_parallel`
- Context `clone()` method for branch isolation
- `parallel.results.<node_id>`, `parallel.fan_in.best_id`, `parallel.fan_in.best_outcome` context keys
- Validation rules for parallel/fan-in topology
- Update `gardens/compliance-loop.dot` to use `component`/`tripleoctagon` shapes

**Priority tiers** (cut from bottom if behind schedule):
- **Tier 1 — must ship:** Parallel handler, fan-in handler (heuristic mode), context cloning, join policies, validation, events, compliance-loop update
- **Tier 2 — should ship:** CLI parallel rendering, `HandlerRegistry.register()`, parallel block timeout
- **Tier 3 — stretch / defer to Sprint 005:** LLM-based fan-in evaluation, branch-level checkpoint/resume, nested parallel support beyond smoke test

**Out of scope:**
- Manager Loop handler (GAP-04)
- Model Stylesheet (GAP-06)
- Context Fidelity modes (GAP-07)
- Node/Edge default blocks (GAP-13)
- Subgraph support (GAP-14)
- Coding Agent Loop (GAP-40)
- Unified LLM Client expansion (GAP-50)
- Cocoon schema redesign for per-branch resume
- Web UI, HTTP server

---

## Use Cases

1. **Concurrent sprint drafts:** `pollinator run gardens/compliance-loop.dot` reaches a `component` node. The engine identifies the 3 outgoing edges (→ `claude_draft`, → `codex_draft`, → `gemini_draft`), clones the execution context for each branch, and runs all three concurrently (up to `max_parallel` at a time). When all three complete, `parallel.results.<node_id>` is stored in context and the engine advances to the fan-in node.

2. **Fan-in consolidation:** The `tripleoctagon` node reads `parallel.results.*` from context. It uses heuristic selection (rank by outcome status, then by branch ID as tiebreak). It records `parallel.fan_in.best_id` and `parallel.fan_in.best_outcome` in context.

3. **First-success join policy:** A pipeline uses `join_policy="first_success"` on a parallel node. The engine cancels remaining branches as soon as one succeeds, stores results, and moves on.

4. **Bounded concurrency:** A parallel node with `max_parallel=2` and 5 outgoing branches runs at most 2 branches simultaneously, preventing resource exhaustion with expensive LLM calls.

5. **Branch failure handling:** Under `wait_all` policy, if any branch fails the parallel node returns `partial_success`. Under `first_success`, if all branches fail, it returns `failure`. Downstream edges can route on these outcomes as usual.

6. **Observable parallel execution:** The event stream emits `parallel_started` (with branch count), `parallel_branch_started`/`parallel_branch_completed` per branch, and `parallel_completed` with aggregated results. The CLI renderer shows concurrent branch progress with indented output.

---

## Architecture

### Parallel Execution Model

The spec (Section 3.8) is clear: graph traversal is single-threaded, but parallelism exists *within* specific handlers. The parallel handler internally manages concurrent execution of branches, each with an isolated context clone. Branch context changes do NOT merge back to the parent — only the handler's `context_updates` (containing `parallel.results.*`) are applied.

This means parallel execution is implemented as a **handler concern, not an engine concern**. The engine continues its simple execute-node → select-edge → advance loop. The `ParallelHandler.execute()` method spawns concurrent branch execution internally.

### Branch Execution

Each branch from a parallel node is a **subgraph traversal** starting at the branch's target node and continuing until it reaches either:
- A fan-in node (`tripleoctagon`) — branch terminates, result collected
- An exit node — branch terminates, result collected
- A dead end (no outgoing edges) — branch terminates, result collected

Branch execution reuses the existing `PipelineEngine` infrastructure. Each branch gets:
- A cloned `ExecutionContext` (isolated writes)
- Its own `run_dir` subdirectory for artifacts (isolated per branch)
- Its own abort signal (linked to parent for cancellation)

### Convergence Node Detection

The parallel handler identifies the **convergence node** — the first `tripleoctagon` node reachable from all branch start nodes. Branches run until they reach this node or terminate at a dead end/exit.

For the common case (`component → branches → tripleoctagon`), this is unambiguous. For complex graphs, an explicit `convergence_node` attribute on the `component` node provides an override. Ambiguous topologies produce a validation warning.

### Key Design Decisions

1. **Handler-level, not engine-level parallelism.** The `PipelineEngine.run()` loop stays single-threaded. `ParallelHandler` owns all concurrency internally. This matches Section 3.8 and avoids turning the engine into a multi-active-node scheduler.

2. **No context merge.** Branch context clones are write-isolated. The parent context only receives the handler's explicit `context_updates`. This prevents key collision bugs and matches spec semantics.

3. **Inject graph/events into ParallelHandler specifically**, not into the shared `HandlerExecutionInput`. The parallel handler is special — it needs the graph to identify branches and convergence. Other handlers should not carry this weight.

4. **Atomic resume for Sprint 004.** If interrupted mid-parallel, the entire parallel block re-executes on resume. Branch-level resume requires cocoon schema changes deferred to a future sprint.

5. **Namespaced results.** `parallel.results.<parallel_node_id>` avoids collisions when multiple parallel blocks exist in a pipeline.

6. **Heuristic fan-in ships first.** LLM-based fan-in evaluation is a stretch goal. The compliance-loop use case works with deterministic heuristic selection.

### Module Layout Additions

```
nectar/
├── src/
│   ├── engine/
│   │   ├── branch-executor.ts      # Subgraph traversal for parallel branches
│   │   └── parallel-results.ts     # Serialization/deserialization of branch results
│   ├── handlers/
│   │   ├── parallel.ts             # component shape → parallel handler
│   │   └── fan-in.ts               # tripleoctagon shape → fan-in handler
│   └── garden/
│       └── types.ts                # Add NodeKind variants, SUPPORTED_SHAPES update
├── test/
│   ├── engine/
│   │   └── branch-executor.test.ts
│   ├── handlers/
│   │   ├── parallel.test.ts
│   │   └── fan-in.test.ts
│   ├── integration/
│   │   └── parallel.test.ts
│   └── fixtures/
│       ├── parallel-basic.dot      # Simple 3-branch fan-out → fan-in
│       ├── parallel-first-success.dot
│       └── parallel-failure.dot    # Branch failure under wait_all
```

### Data Flow

```
Engine reaches component node
        │
        ▼
ParallelHandler.execute()
        │
        ├── Clone context × N branches
        ├── Create BranchExecutor × N
        ├── Run up to max_parallel concurrently
        │       │
        │       ├── BranchExecutor runs subgraph
        │       ├── Emits branch events
        │       └── Returns BranchResult
        │
        ├── Collect all BranchResults
        ├── Apply join policy
        ├── Serialize to parallel.results.<node_id>
        └── Return Outcome(context_updates: {parallel.results.<id>: ...})
                │
                ▼
Engine applies context_updates, selects next edge
                │
                ▼
Engine reaches tripleoctagon node
                │
                ▼
FanInHandler.execute()
        │
        ├── Deserialize parallel.results.* from context
        ├── Heuristic ranking (status → branch ID tiebreak)
        ├── Set parallel.fan_in.best_id, best_outcome
        └── Return Outcome(SUCCESS)
```

---

## Implementation

### Phase 1: Engine Loop Extraction (~20%)

**Rationale:** The `executeNodeSequence()` extraction is the highest-risk task in the sprint. It touches the core execution path that every existing test depends on. Landing it first with full regression coverage de-risks everything that follows.

**Files:** `src/engine/engine.ts`, `test/engine/engine.test.ts`

**Tasks:**
- [ ] Factor the inner execution loop from `PipelineEngine.run()` into a shared `executeNodeSequence()` utility
  - Define clear interface: graph, context, handlers, start node, termination set, run dir, abort signal, event listener
  - Preserve existing behavior exactly: retry logic, context key updates, event emission, checkpoint writes
  - Both `PipelineEngine.run()` and `BranchExecutor` will call this shared function
- [ ] All existing engine tests must pass unchanged after the extraction
- [ ] Add targeted regression tests for: retry behavior through the extracted function, goal gate checks, event emission ordering

**Risk:** Subtle changes in retry behavior, context update ordering, or event emission could break existing pipelines silently. The extraction must be verified against the full existing test suite before proceeding.

### Phase 2: Type System & Context Cloning (~15%)

**Files:** `src/garden/types.ts`, `src/engine/events.ts`, `src/engine/parallel-results.ts`, `src/engine/types.ts`

**Tasks:**
- [ ] Add `'parallel' | 'parallel.fan_in'` to `NodeKind` union type
- [ ] Add `'component'` and `'tripleoctagon'` to `SUPPORTED_SHAPES`
- [ ] Add shape-to-kind mappings in `normalizeNodeKind()`: `component` → `parallel`, `tripleoctagon` → `parallel.fan_in`
- [ ] Parse `join_policy` (enum: `"wait_all"` | `"first_success"`, default `"wait_all"`) and `max_parallel` (positive integer, default `4`) node attributes in `parse.ts`; validate enum/range
- [ ] Add `joinPolicy?: string` and `maxParallel?: number` to `GardenNode`
- [ ] Implement `ExecutionContext.clone()`: deep-copy all key-value pairs into a new context instance
- [ ] Define `BranchResult` type: `{ branchId: string, status: NodeStatus, contextSnapshot: Record<string, string>, durationMs: number }`
- [ ] Define `ParallelResults` type: `{ branches: BranchResult[], joinPolicy: string, convergenceNode?: string }`
- [ ] Implement `serializeParallelResults()` and `deserializeParallelResults()` for context storage (serialize only terminal outcome and summary, not full branch context, to limit size)
- [ ] Add parallel event types to `RunEvent` union: `parallel_started`, `parallel_branch_started`, `parallel_branch_completed`, `parallel_completed`
- [ ] Tests: context clone isolation (write to clone doesn't affect parent), parallel results round-trip serialization, invalid `join_policy` rejected, invalid `max_parallel` rejected

### Phase 3: Branch Executor (~20%)

**Files:** `src/engine/branch-executor.ts`, `test/engine/branch-executor.test.ts`

**Tasks:**
- [ ] Implement `BranchExecutor` class:
  - Constructor: `graph`, `clonedContext`, `handlers`, `branchStartNodeId`, `terminationNodeIds` (set of node IDs where this branch stops), `runDir`, `abortSignal`, `eventListener`
  - `async execute(): Promise<BranchResult>` — delegates to `executeNodeSequence()` from Phase 1
  - Starts at `branchStartNodeId`, stops at termination boundary (fan-in), exit node, or dead end
  - Uses the cloned context; writes artifacts to branch-isolated run dir
  - Emits branch-scoped events
  - Respects abort signal for cancellation
  - Branch-local retry state is isolated (not shared with parent or siblings)
- [ ] Tests: single-node branch, multi-node branch, branch stops at termination boundary, branch abort/cancellation, branch context isolation, retry within a branch

### Phase 4: Parallel Handler (~20%)

**Files:** `src/handlers/parallel.ts`, `test/handlers/parallel.test.ts`

**Tasks:**
- [ ] Implement `ParallelHandler`:
  - Injected with `graph` and `onEvent` via constructor (NOT via `HandlerExecutionInput`)
  - Read `join_policy` (default `"wait_all"`) and `max_parallel` (default `4`) from node attributes
  - Identify branches from outgoing edges of the parallel node
  - Identify convergence node: first `tripleoctagon` reachable from all branch start nodes; fallback to `convergence_node` attribute
  - For each branch: clone parent context, create `BranchExecutor` with termination set `{convergenceNode}`, create linked abort signal
  - Execute with bounded concurrency using a semaphore pattern with `Promise.allSettled`
  - For `first_success`: when any branch succeeds, abort remaining branches
  - Collect `BranchResult[]`, build `ParallelResults`
  - Apply join policy:
    - `wait_all`: all must complete; any failure → `partial_success`; all success → `success`; all fail → `failure`
    - `first_success`: any success → `success`; all fail → `failure`
  - Return outcome with `context_updates: { 'parallel.results.<node_id>': serialized results }`
  - Emit events: `parallel_started`, per-branch start/complete, `parallel_completed`
- [ ] Optional: `timeout_ms` attribute on `component` node — on timeout, collect completed results and treat timed-out branches as failures
- [ ] Tests: 3 branches all succeed (wait_all → success), 1 of 3 fails (wait_all → partial_success), all 3 fail (wait_all → failure), first_success with early completion, max_parallel=1 runs sequentially, cancellation propagation, wall-clock concurrency verification (parallel is faster than sequential)

### Phase 5: Fan-In Handler (~10%)

**Files:** `src/handlers/fan-in.ts`, `test/handlers/fan-in.test.ts`

**Tasks:**
- [ ] Implement `FanInHandler` (heuristic mode — must ship):
  - Read `parallel.results.*` from context; fail if no results found
  - Rank by outcome status (success=0, partial_success=1, retry=2, failure=3)
  - Tiebreak by branch ID (lexical order) for determinism
  - Set `context_updates`:
    - `parallel.fan_in.best_id` = winning branch's ID
    - `parallel.fan_in.best_outcome` = winning branch's outcome status
  - Return `{ status: 'success', context_updates, notes }` (or `failure` if all candidates failed)
- [ ] Stretch: LLM-based fan-in evaluation when `prompt` attribute is present (with fallback to heuristic on LLM failure, and token budget cap for the evaluation prompt)
- [ ] Tests: heuristic selection with mixed outcomes, all-success tiebreak, all-failure → failure, empty results → failure, zero branches → failure

### Phase 6: Handler Registry & Validation (~10%)

**Files:** `src/handlers/registry.ts`, `src/garden/validate.ts`, `src/garden/parse.ts`

**Tasks:**
- [ ] Add `register(kind: string, handler: NodeHandler)` method to `HandlerRegistry` (GAP-12 partial)
- [ ] Register `ParallelHandler` and `FanInHandler` in registry (kinds: `parallel`, `parallel.fan_in`)
- [ ] Add validation rules:
  - `parallel_has_outgoing`: `component` nodes must have ≥ 2 outgoing edges
  - `fan_in_topology`: warn if a `tripleoctagon` has no `component` ancestor
  - `parallel_has_fan_in`: warn if a `component` has no reachable `tripleoctagon` downstream (orphaned fan-out)
  - Warn on cycles within parallel subgraphs
- [ ] Tests: registry resolves parallel/fan-in kinds, `register()` works for custom kinds, validation catches single-edge parallel, validation warns on orphaned fan-out

### Phase 7: CLI Rendering & Garden Update (~5%)

**Files:** `src/cli/ui/renderer.ts`, `gardens/compliance-loop.dot`, `test/integration/parallel.test.ts`

**Tasks:**
- [ ] Add parallel event rendering to `EventRenderer`:
  - `parallel_started` → branching message with branch count
  - `parallel_branch_started` → indented branch start indicator
  - `parallel_branch_completed` → indented success/failure per branch
  - `parallel_completed` → summary (N/M succeeded)
- [ ] Update `gardens/compliance-loop.dot`:
  - Add `fan_out_drafts` node (`shape=component, join_policy="wait_all"`)
  - Add `fan_in_drafts` node (`shape=tripleoctagon`)
  - Route: `compliance_check → fan_out_drafts → {claude_draft, codex_draft, gemini_draft} → fan_in_drafts → fan_out_critiques`
  - Same pattern for critiques: `fan_out_critiques → {claude_critique, codex_critique, gemini_critique} → fan_in_critiques → merge_sprint`
- [ ] Integration test: run `parallel-basic.dot` end-to-end, verify all branches execute, verify `parallel.results.*` populated, verify fan-in selects best
- [ ] Integration test: `parallel-first-success.dot` with deterministic delays (mocked), verify early termination
- [ ] Integration test: `parallel-failure.dot` with one failing branch under `wait_all`, verify `partial_success` outcome

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/engine.ts` | Modify | Extract `executeNodeSequence()` for reuse by branch executor |
| `src/garden/types.ts` | Modify | Add `parallel`, `parallel.fan_in` to `NodeKind`; add `component`, `tripleoctagon` to `SUPPORTED_SHAPES`; add `joinPolicy`, `maxParallel` to `GardenNode` |
| `src/garden/parse.ts` | Modify | Parse `join_policy` and `max_parallel` node attributes |
| `src/garden/validate.ts` | Modify | Add parallel topology validation rules |
| `src/engine/events.ts` | Modify | Add parallel event types |
| `src/engine/types.ts` | Modify | Add `BranchResult` type |
| `src/engine/parallel-results.ts` | Create | `ParallelResults` type, serialization/deserialization |
| `src/engine/branch-executor.ts` | Create | `BranchExecutor` class for subgraph traversal within branches |
| `src/handlers/parallel.ts` | Create | `ParallelHandler` — fan-out, bounded concurrency, join policies |
| `src/handlers/fan-in.ts` | Create | `FanInHandler` — heuristic candidate consolidation |
| `src/handlers/registry.ts` | Modify | Add `register()` method; register parallel and fan-in handlers |
| `src/cli/ui/renderer.ts` | Modify | Add parallel event rendering with branch-level indentation |
| `gardens/compliance-loop.dot` | Modify | Restructure drafts and critiques into parallel fan-out/fan-in |
| `test/engine/engine.test.ts` | Modify | Regression tests for `executeNodeSequence()` extraction |
| `test/engine/branch-executor.test.ts` | Create | Branch executor unit tests |
| `test/handlers/parallel.test.ts` | Create | Parallel handler unit tests |
| `test/handlers/fan-in.test.ts` | Create | Fan-in handler unit tests |
| `test/integration/parallel.test.ts` | Create | End-to-end parallel pipeline tests |
| `test/fixtures/parallel-basic.dot` | Create | 3-branch fan-out → fan-in fixture |
| `test/fixtures/parallel-first-success.dot` | Create | first_success join policy fixture |
| `test/fixtures/parallel-failure.dot` | Create | Branch failure handling fixture |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests plus new parallel/fan-in tests (all pre-existing tests must remain green after engine refactor)

### Parsing & Validation
- [ ] `component` shape maps to `parallel` kind; `tripleoctagon` maps to `parallel.fan_in` kind
- [ ] `pollinator validate` accepts graphs with `component` and `tripleoctagon` nodes
- [ ] `pollinator validate` warns when a `component` node has fewer than 2 outgoing edges
- [ ] `pollinator validate` warns when a `tripleoctagon` node has no upstream `component` ancestor
- [ ] `pollinator validate` warns when a `component` node has no reachable `tripleoctagon` downstream
- [ ] Invalid `join_policy` values are rejected; invalid `max_parallel` values (0, negative, non-numeric) are rejected

### Parallel Execution
- [ ] Parallel handler executes all outgoing branches concurrently
- [ ] Each branch runs in an isolated context clone — writes do not leak to sibling branches or parent
- [ ] Branch execution stops at the convergence node (fan-in) without executing it
- [ ] `join_policy="wait_all"` waits for all branches; returns `success` if all succeed, `partial_success` if some fail, `failure` if all fail
- [ ] `join_policy="first_success"` returns `success` as soon as one branch succeeds and cancels remaining branches; returns `failure` if all fail
- [ ] `max_parallel` attribute limits concurrent branch execution (default 4)
- [ ] Wall-clock concurrency verified: parallel execution of N branches completes faster than sequential execution
- [ ] Branch-local retry state is isolated from parent and sibling branches

### Context & Results
- [ ] `parallel.results.<parallel_node_id>` is stored in context after parallel handler completes (namespaced to avoid collisions across multiple parallel blocks)
- [ ] Fan-in handler reads `parallel.results.*` and returns `failure` if results are empty or missing
- [ ] Fan-in handler (heuristic mode) selects the best candidate by outcome status ranking, with lexical tiebreak on branch ID
- [ ] `parallel.fan_in.best_id` and `parallel.fan_in.best_outcome` are set in context after fan-in

### Registry & Events
- [ ] `HandlerRegistry.register()` method exists and works for custom handler types
- [ ] Parallel events (`parallel_started`, `parallel_branch_started`, `parallel_branch_completed`, `parallel_completed`) are emitted
- [ ] CLI renderer displays parallel execution with indented branch output

### Garden Update
- [ ] `gardens/compliance-loop.dot` uses `component`/`tripleoctagon` for draft and critique stages

### Interrupt & Cleanup
- [ ] Cancellation propagates: aborting the parent run cancels all active branches
- [ ] Interrupted parallel blocks restart from the `component` node on resume (atomic parallel — branch-level resume deferred)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Engine loop extraction breaks existing behavior** | High | High | This is the #1 risk. The `executeNodeSequence()` extraction touches retry logic, goal gates, context updates, event emission, and checkpoint writes. Land it as Phase 1 with the full existing test suite as the gate. No parallel code until all existing tests pass. |
| **Convergence node detection is ambiguous for complex graphs** | Medium | High | Start with the simple convention: fan-in = first `tripleoctagon` reachable from all branch starts. Add `convergence_node` attribute as explicit override. Warn on ambiguous topologies via validation. |
| **Branch execution duplicates engine logic** | High | Medium | Mitigated by Phase 1: factor the inner loop into `executeNodeSequence()` shared by engine and branch executor. One copy of the truth. |
| **`first_success` cancellation races** | Medium | Medium | Use `AbortController` with linked signals. Branches check abort between nodes. A cancelled branch returns its partial result (not an error). Test with deterministic delays to control winner. |
| **Branch-local retry bookkeeping divergence** | Medium | Medium | `BranchExecutor` delegates to `executeNodeSequence()` which includes retry logic. Branch-local retry state is isolated by design — each branch executor has its own state. |
| **`parallel.results` stored as string in string-only context** | Medium | Low | Serialize only terminal outcome and summary (not full branch context) to limit size. Provide `serializeParallelResults()`/`deserializeParallelResults()` helpers. |
| **Multiple parallel blocks overwrite results** | Medium | Medium | Namespaced context key `parallel.results.<node_id>` prevents collisions. |
| **Checkpoint/resume with in-progress parallel execution** | Medium | High | Sprint 004 uses atomic parallel: interrupted blocks re-execute entirely on resume. Document this as expected behavior. Defer branch-level resume. |
| **Fan-in LLM evaluation complexity** | Low | Medium | LLM fan-in is a stretch goal. Heuristic mode ships first. If LLM evaluation is attempted, fall back to heuristic on parse failure. |
| **Nested parallel deadlock** | Low | Medium | Nested parallel blocks are not formally supported in Sprint 004. A smoke test verifies the degenerate case works. Full nested support is deferred. |

---

## Security Considerations

- **Branch isolation is critical.** Context clones must be true deep copies. A branch writing `context.set("secret", value)` must not be visible to sibling branches or the parent context. Only the handler's explicit `context_updates` are merged.
- **Abort signal propagation.** Cancellation must cleanly terminate branch subprocesses (tool nodes) via the existing signal handling. No zombie processes.
- **No eval or injection in convergence detection.** Node ID matching uses strict string equality, not pattern matching or evaluation.

---

## Dependencies

No new external NPM dependencies required. Parallel execution uses `Promise.allSettled` with a hand-rolled semaphore for bounded concurrency. All existing dependencies (`@ts-graphviz/parser`, `execa`, `vitest`) are sufficient.

---

## Open Questions

| Question | Resolution |
|----------|-----------|
| How does checkpoint/resume work with parallel state? | Parallel execution is atomic for Sprint 004. If interrupted, the entire parallel block re-executes on resume. Branch-level resume is a future optimization. |
| Should `BranchExecutor` share code with `PipelineEngine`? | Yes. `executeNodeSequence()` is factored out as shared code in Phase 1. |
| What if a branch has no path to the convergence node? | The branch runs until it reaches a dead end or exit node. Its result is collected. This is valid. |
| Can `parallel.results.*` be read by non-fan-in nodes? | Yes — they are ordinary context keys. But the structured format is designed for the fan-in handler. |
| What if there are multiple candidate convergence nodes? | Validation warns. The `convergence_node` attribute on the `component` node provides an explicit override. |
| What happens to empty branches (start node = fan-in)? | `BranchResult` is returned with zero work done. The branch "succeeded" trivially. |
