# Sprint 004: Parallel Fan-Out / Fan-In Handlers

## Overview

**Goal:** Deliver the parallel execution subsystem — the `component` (parallel fan-out) and `tripleoctagon` (fan-in) handlers — so that pipelines can run multiple branches concurrently with isolated contexts, bounded concurrency, configurable join policies, and heuristic or LLM-based result consolidation. After this sprint, the compliance-loop garden can fan out its three draft nodes and three critique nodes concurrently instead of sequentially.

**Scope:**
- GAP-02: Parallel handler (`component` shape → `parallel` kind) — HIGH
- GAP-03: Fan-in handler (`tripleoctagon` shape → `parallel.fan_in` kind) — HIGH
- GAP-12 (partial): Custom handler registration — `register()` method on `HandlerRegistry` so parallel/fan-in are added cleanly and external handlers become possible
- GAP-30 (partial): Parallel events — `parallel_started`, `parallel_branch_started`, `parallel_branch_completed`, `parallel_completed`
- Node attribute parsing for `join_policy`, `max_parallel`
- Context `clone()` method for branch isolation
- `parallel.results`, `parallel.fan_in.best_id`, `parallel.fan_in.best_outcome` context keys
- Validation rules: `parallel_has_outgoing`, `fan_in_has_parallel_ancestor`
- Update `compliance-loop.dot` to use `component`/`tripleoctagon` shapes for the draft and critique stages

**Out of scope:**
- Manager Loop handler (GAP-04) — deferred to Sprint 005
- Model Stylesheet (GAP-06) — deferred
- Context Fidelity modes (GAP-07) — deferred
- Node/Edge default blocks (GAP-13) — deferred
- Subgraph support (GAP-14) — deferred
- Coding Agent Loop (GAP-40) — deferred
- Unified LLM Client expansion (GAP-50) — deferred
- Web UI, HTTP server, Seedbed, Swarm Analysis

---

## Use Cases

1. **Concurrent sprint drafts:** `pollinator run gardens/compliance-loop.dot` reaches a `component` node. The engine identifies the 3 outgoing edges (→ `claude_draft`, → `codex_draft`, → `gemini_draft`), clones the execution context for each branch, and runs all three concurrently (up to `max_parallel` at a time). When all three complete, `parallel.results` is stored in context and the engine advances to the fan-in node.

2. **Fan-in consolidation:** The `tripleoctagon` node reads `parallel.results` from context. Without a `prompt` attribute, it uses heuristic selection (rank by outcome status, then by score, then by branch ID). With a `prompt`, it calls the LLM to evaluate and rank the candidates. Either way, it records `parallel.fan_in.best_id` and `parallel.fan_in.best_outcome` in context.

3. **First-success join policy:** A pipeline uses `join_policy="first_success"` on a parallel node. The engine cancels remaining branches as soon as one succeeds, stores results, and moves on. This is useful for speculative execution patterns — try three approaches, take the first one that works.

4. **Bounded concurrency:** A parallel node with `max_parallel=2` and 5 outgoing branches runs at most 2 branches simultaneously. This prevents resource exhaustion when branches involve expensive LLM calls or heavy computation.

5. **Branch failure handling:** Under `wait_all` policy, if any branch fails the parallel node returns `partial_success`. Under `first_success`, if all branches fail, it returns `failure`. Downstream edges can route on these outcomes as usual.

6. **Observable parallel execution:** The event stream emits `parallel_started` (with branch count), `parallel_branch_started`/`parallel_branch_completed` per branch, and `parallel_completed` with aggregated results. The CLI renderer shows concurrent branch progress with indented output.

---

## Architecture

### Parallel Execution Model

The spec (Section 3.8) is clear: graph traversal is single-threaded, but parallelism exists *within* specific handlers. The parallel handler internally manages concurrent execution of branches, each with an isolated context clone. Branch context changes do NOT merge back to the parent — only the handler's `context_updates` (containing `parallel.results`) are applied.

This means parallel execution is implemented as a handler concern, not an engine concern. The engine continues its simple execute-node → select-edge → advance loop. The `ParallelHandler.execute()` method spawns concurrent branch execution internally.

### Branch Execution

Each branch from a parallel node is a **subgraph traversal** starting at the branch's target node and continuing until it reaches either:
- A fan-in node (`tripleoctagon`) — branch terminates, result collected
- An exit node — branch terminates, result collected
- A dead end (no outgoing edges) — branch terminates, result collected

Branch execution reuses the existing `PipelineEngine` infrastructure. Each branch gets:
- A cloned `ExecutionContext` (isolated writes)
- Its own `run_dir` subdirectory (`{run_dir}/__parallel/{branch_id}/`)
- Its own abort signal (linked to parent for cancellation)

### Subgraph Boundaries

The parallel handler needs to know where each branch ends. The simplest and most spec-compliant approach: branches run until they reach a node that has an incoming edge from outside the branch subgraph (typically the fan-in node), or until they reach a terminal node. In practice, the convention is:

```
parallel_node -> branch_a_start
parallel_node -> branch_b_start
parallel_node -> branch_c_start

branch_a_end -> fan_in
branch_b_end -> fan_in
branch_c_end -> fan_in
```

The parallel handler identifies the **convergence node** (a node that all branches eventually reach, typically a `tripleoctagon`) and executes each branch until it reaches that node or terminates.

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
│       ├── parallel-first-success.dot  # first_success join policy
│       ├── parallel-nested.dot     # Branch contains sub-branches (degenerate case)
│       └── parallel-failure.dot    # Branch failure under wait_all
```

### Key Abstractions

**`BranchExecutor`** — Executes a subgraph starting at a given node, using a cloned context, until it reaches a termination boundary (fan-in node, exit node, or dead end). Returns a `BranchResult` containing the terminal node's outcome, the branch's context snapshot, and all intermediate node statuses.

**`ParallelResults`** — Serializable container for branch outcomes. Stored in context as `parallel.results`. Contains per-branch: branch ID (target node ID), outcome status, context snapshot, execution duration, and optional score.

**`ParallelHandler`** — Reads `join_policy` and `max_parallel` from node attributes. Identifies outgoing edges as branches. Creates a bounded concurrency pool. Executes branches via `BranchExecutor`. Collects results. Applies join policy logic. Returns consolidated outcome with `parallel.results` in `context_updates`.

**`FanInHandler`** — Reads `parallel.results` from context. If node has a `prompt`, calls LLM to evaluate candidates. Otherwise, uses heuristic ranking (outcome status → score → branch ID). Sets `parallel.fan_in.best_id` and `parallel.fan_in.best_outcome` in context.

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
        ├── Serialize to parallel.results
        └── Return Outcome(context_updates: {parallel.results: ...})
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
        ├── Deserialize parallel.results from context
        ├── Heuristic or LLM evaluation
        ├── Set parallel.fan_in.best_id, best_outcome
        └── Return Outcome(SUCCESS)
```

---

## Implementation

### Phase 1: Type System & Context Cloning (~15%)

**Files:** `src/garden/types.ts`, `src/engine/context.ts`, `src/engine/events.ts`, `src/engine/parallel-results.ts`

**Tasks:**
- [ ] Add `'parallel' | 'parallel.fan_in'` to `NodeKind` union type
- [ ] Add `'component'` and `'tripleoctagon'` to `SUPPORTED_SHAPES`
- [ ] Add shape-to-kind mappings in `normalizeNodeKind()`: `component` → `parallel`, `tripleoctagon` → `parallel.fan_in`
- [ ] Parse `join_policy` and `max_parallel` node attributes in `parse.ts`
- [ ] Add `joinPolicy?: string` and `maxParallel?: number` to `GardenNode`
- [ ] Implement `ExecutionContext.clone()`: deep-copy all key-value pairs into a new context instance
- [ ] Define `BranchResult` type: `{ branchId: string, status: NodeStatus, contextSnapshot: Record<string, string>, durationMs: number, completedNodes: CompletedNodeState[] }`
- [ ] Define `ParallelResults` type: `{ branches: BranchResult[], joinPolicy: string, convergenceNode?: string }`
- [ ] Implement `serializeParallelResults()` and `deserializeParallelResults()` for context storage
- [ ] Add parallel event types to `RunEvent` union: `parallel_started`, `parallel_branch_started`, `parallel_branch_completed`, `parallel_completed`
- [ ] Tests: context clone isolation (write to clone doesn't affect parent), parallel results round-trip serialization

### Phase 2: Branch Executor (~25%)

**Files:** `src/engine/branch-executor.ts`, `test/engine/branch-executor.test.ts`

**Tasks:**
- [ ] Implement `BranchExecutor` class:
  - Constructor: `graph`, `clonedContext`, `handlers`, `branchStartNodeId`, `terminationNodeIds` (set of node IDs where this branch stops), `runDir`, `abortSignal`, `eventListener`
  - `async execute(): Promise<BranchResult>` — iterative loop identical to engine's main loop but:
    - Starts at `branchStartNodeId` instead of the graph's start node
    - Stops when reaching a node in `terminationNodeIds` (fan-in) or an exit/dead-end
    - Uses the cloned context
    - Writes checkpoints to `{runDir}/__parallel/{branchId}/`
    - Emits branch-scoped events
    - Respects abort signal for cancellation
  - Reuse `selectNextEdge()` and handler resolution from existing engine code
- [ ] Factor out the inner execution loop from `PipelineEngine.run()` into a shared `executeNodeSequence()` utility that both the main engine and branch executor can use. This avoids duplicating the execute → select-edge → advance → checkpoint logic.
- [ ] Tests: single-node branch execution, multi-node branch, branch stops at termination boundary, branch abort/cancellation, branch context isolation

### Phase 3: Parallel Handler (~25%)

**Files:** `src/handlers/parallel.ts`, `test/handlers/parallel.test.ts`

**Tasks:**
- [ ] Implement `ParallelHandler`:
  - Read `join_policy` (default `"wait_all"`) and `max_parallel` (default `4`) from node attributes
  - Identify branches from outgoing edges of the parallel node (via `graph.outgoing`)
  - Identify convergence node: find the first node reachable from all branch start nodes that is either a `parallel.fan_in` kind or has incoming edges from multiple branches. This is computed once at handler start.
  - For each branch:
    - Clone parent context
    - Create `BranchExecutor` with branch start node and termination set = `{convergenceNode}`
    - Create linked abort signal
  - Execute with bounded concurrency using a simple semaphore pattern (`Promise.allSettled` with a concurrency limiter)
  - For `first_success` policy: when any branch succeeds, abort remaining branches
  - Collect `BranchResult[]` and build `ParallelResults`
  - Apply join policy:
    - `wait_all`: all must complete; `FAIL` count > 0 → `partial_success`; all success → `success`
    - `first_success`: any success → `success`; all fail → `failure`
  - Return outcome with `context_updates: { 'parallel.results': serialized results }`
  - Emit parallel events: `parallel_started`, per-branch start/complete, `parallel_completed`
- [ ] Handler must accept `graph` and `eventListener` — extend `HandlerExecutionInput` to include `graph: GardenGraph` and `onEvent: RunEventListener` (or pass through a narrower interface)
- [ ] Tests: 3 branches all succeed (wait_all → success), 1 of 3 fails (wait_all → partial_success), first_success with early completion, max_parallel=1 runs sequentially, cancellation propagation

### Phase 4: Fan-In Handler (~15%)

**Files:** `src/handlers/fan-in.ts`, `test/handlers/fan-in.test.ts`

**Tasks:**
- [ ] Implement `FanInHandler`:
  - Read `parallel.results` from context; fail if missing
  - If `node.prompt` is set and LLM client available:
    - Build evaluation prompt: include branch IDs, outcomes, and relevant context snapshots
    - Call LLM to rank candidates
    - Parse LLM response for best candidate selection
  - Else (heuristic mode):
    - Rank by outcome status (success=0, partial_success=1, retry=2, failure=3)
    - Tiebreak by branch ID (lexical order)
  - Set `context_updates`:
    - `parallel.fan_in.best_id` = winning branch's ID
    - `parallel.fan_in.best_outcome` = winning branch's outcome status
  - Return `{ status: 'success', context_updates, notes }` (or `failure` if all candidates failed)
- [ ] Tests: heuristic selection with mixed outcomes, all-success tiebreak, all-failure → failure, LLM evaluation (with simulated client), empty results → failure

### Phase 5: Handler Registry & Validation (~10%)

**Files:** `src/handlers/registry.ts`, `src/garden/validate.ts`, `src/garden/parse.ts`

**Tasks:**
- [ ] Add `register(kind: string, handler: NodeHandler)` method to `HandlerRegistry` for runtime registration (GAP-12 partial)
- [ ] Register `ParallelHandler` and `FanInHandler` in registry constructor (kinds: `parallel`, `parallel.fan_in`)
- [ ] Add validation rules:
  - `parallel_has_outgoing`: `component` nodes must have ≥ 2 outgoing edges (otherwise not meaningfully parallel)
  - `fan_in_topology`: warn if a `tripleoctagon` node has no `component` ancestor (likely misconfigured)
- [ ] Parse `join_policy` and `max_parallel` attributes in `parse.ts` statement handler
- [ ] Tests: registry resolves parallel/fan-in kinds, register() works for custom kinds, validation catches single-edge parallel nodes

### Phase 6: CLI Rendering & Garden Update (~10%)

**Files:** `src/cli/ui/renderer.ts`, `gardens/compliance-loop.dot`, `test/integration/parallel.test.ts`

**Tasks:**
- [ ] Add parallel event rendering to `EventRenderer`:
  - `parallel_started` → `🌿 Branching into N parallel paths...`
  - `parallel_branch_started` → `  🌱 Branch [node_id] sprouting...` (indented)
  - `parallel_branch_completed` (success) → `  ✅ Branch [node_id] bloomed (Xs)`
  - `parallel_branch_completed` (failure) → `  ❌ Branch [node_id] wilted`
  - `parallel_completed` → `🌿 All branches complete (N/M succeeded)`
- [ ] Update `gardens/compliance-loop.dot`:
  - Add `fan_out_drafts` node (`shape=component, join_policy="wait_all"`)
  - Add `fan_in_drafts` node (`shape=tripleoctagon`)
  - Route: `compliance_check -> fan_out_drafts -> {claude_draft, codex_draft, gemini_draft} -> fan_in_drafts -> fan_out_critiques`
  - Same pattern for critiques: `fan_out_critiques -> {claude_critique, codex_critique, gemini_critique} -> fan_in_critiques -> merge_sprint`
- [ ] Integration test: run `parallel-basic.dot` fixture end-to-end, verify all branches execute, verify `parallel.results` populated, verify fan-in selects best
- [ ] Integration test: `parallel-first-success.dot` with one fast branch, verify early termination
- [ ] Integration test: `parallel-failure.dot` with one failing branch under `wait_all`, verify `partial_success` outcome

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/types.ts` | Modify | Add `parallel`, `parallel.fan_in` to `NodeKind`; add `component`, `tripleoctagon` to `SUPPORTED_SHAPES`; add `joinPolicy`, `maxParallel` to `GardenNode`; update `normalizeNodeKind()` |
| `src/garden/parse.ts` | Modify | Parse `join_policy` and `max_parallel` node attributes |
| `src/garden/validate.ts` | Modify | Add `parallel_has_outgoing` and `fan_in_topology` validation rules |
| `src/engine/context.ts` | Modify | Add `clone()` method for deep-copying context |
| `src/engine/events.ts` | Modify | Add `parallel_started`, `parallel_branch_started`, `parallel_branch_completed`, `parallel_completed` event types |
| `src/engine/types.ts` | Modify | Add `BranchResult` type; extend `HandlerExecutionInput` with `graph` and `onEvent` |
| `src/engine/parallel-results.ts` | Create | `ParallelResults` type, `serializeParallelResults()`, `deserializeParallelResults()` |
| `src/engine/branch-executor.ts` | Create | `BranchExecutor` class for subgraph traversal within parallel branches |
| `src/handlers/parallel.ts` | Create | `ParallelHandler` — fan-out, bounded concurrency, join policies |
| `src/handlers/fan-in.ts` | Create | `FanInHandler` — heuristic or LLM-based candidate consolidation |
| `src/handlers/registry.ts` | Modify | Add `register()` method; register parallel and fan-in handlers |
| `src/cli/ui/renderer.ts` | Modify | Add parallel event rendering with branch-level indentation |
| `gardens/compliance-loop.dot` | Modify | Restructure drafts and critiques into parallel fan-out/fan-in patterns |
| `test/engine/branch-executor.test.ts` | Create | Branch executor unit tests |
| `test/handlers/parallel.test.ts` | Create | Parallel handler unit tests (join policies, concurrency, cancellation) |
| `test/handlers/fan-in.test.ts` | Create | Fan-in handler unit tests (heuristic, LLM, edge cases) |
| `test/integration/parallel.test.ts` | Create | End-to-end parallel pipeline tests |
| `test/fixtures/parallel-basic.dot` | Create | 3-branch fan-out → fan-in fixture |
| `test/fixtures/parallel-first-success.dot` | Create | first_success join policy fixture |
| `test/fixtures/parallel-failure.dot` | Create | Branch failure handling fixture |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests plus new parallel/fan-in tests
- [ ] `component` shape maps to `parallel` kind; `tripleoctagon` maps to `parallel.fan_in` kind
- [ ] `pollinator validate` accepts graphs with `component` and `tripleoctagon` nodes
- [ ] `pollinator validate` warns when a `component` node has fewer than 2 outgoing edges
- [ ] `pollinator validate` warns when a `tripleoctagon` node has no upstream `component` ancestor
- [ ] Parallel handler executes all outgoing branches concurrently
- [ ] Each branch runs in an isolated context clone — writes do not leak to sibling branches or parent
- [ ] Branch execution stops at the convergence node (fan-in) without executing it
- [ ] `join_policy="wait_all"` waits for all branches; returns `success` if all succeed, `partial_success` if any fail
- [ ] `join_policy="first_success"` returns `success` as soon as one branch succeeds and cancels remaining branches
- [ ] `max_parallel` attribute limits concurrent branch execution (default 4)
- [ ] `parallel.results` is stored in context after parallel handler completes
- [ ] Fan-in handler reads `parallel.results` and returns `failure` if results are empty
- [ ] Fan-in handler (heuristic mode) selects the best candidate by outcome status ranking, with lexical tiebreak
- [ ] Fan-in handler (LLM mode) calls LLM when `prompt` attribute is present and selects based on LLM response
- [ ] `parallel.fan_in.best_id` and `parallel.fan_in.best_outcome` are set in context after fan-in
- [ ] `HandlerRegistry.register()` method exists and works for custom handler types
- [ ] Parallel events (`parallel_started`, `parallel_branch_started`, `parallel_branch_completed`, `parallel_completed`) are emitted
- [ ] CLI renderer displays parallel execution with indented branch output
- [ ] `gardens/compliance-loop.dot` uses `component`/`tripleoctagon` for draft and critique stages
- [ ] Branch artifacts are written to `{run_dir}/__parallel/{branchId}/` subdirectories
- [ ] Cancellation propagates: aborting the parent run cancels all active branches
- [ ] SIGINT/SIGTERM during parallel execution checkpoints current state cleanly

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Convergence node detection is ambiguous for complex graphs | Medium | High | Start with the simple convention: fan-in node = first `tripleoctagon` reachable from all branch starts. Document the convention. Add a `convergence_node` attribute as an explicit override if needed. |
| Branch execution duplicates engine logic | High | Medium | Factor the inner loop into a shared `executeNodeSequence()` utility. Both engine and branch executor call it. Keep one copy of the truth. |
| `first_success` cancellation races | Medium | Medium | Use `AbortController` with linked signals. Branches check abort between nodes. A cancelled branch returns its partial result (not an error). |
| Context serialization bloat in `parallel.results` | Low | Medium | Serialize only the terminal outcome and a summary of context changes, not the full branch context. Cap serialized size. |
| Checkpoint/resume with in-progress parallel execution | Medium | High | If the engine is interrupted mid-parallel, the cocoon records which branches completed and which were in-progress. On resume, completed branches are skipped; in-progress branches restart from scratch. Document this as expected behavior. |
| Nested parallel nodes (parallel inside a branch) | Low | Medium | Support it naturally — `BranchExecutor` delegates to `ParallelHandler` when it encounters a `component` node within a branch. No special casing needed. Test with `parallel-nested.dot` fixture. |
| Fan-in LLM evaluation produces unparseable output | Medium | Low | Fall back to heuristic selection if LLM response can't be parsed. Log a warning. |

---

## Security Considerations

- **Branch isolation is critical.** Context clones must be true deep copies. A branch writing `context.set("secret", value)` must not be visible to sibling branches or the parent context. Only the handler's explicit `context_updates` are merged.
- **Abort signal propagation.** Cancellation must cleanly terminate branch subprocesses (tool nodes) via the existing signal handling. No zombie processes.
- **No eval or injection in convergence detection.** Node ID matching uses strict string equality, not pattern matching or evaluation.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| (existing) `@ts-graphviz/parser` | DOT file parsing — no new dependency needed |
| (existing) `execa` | Tool node subprocess execution within branches |
| (existing) `vitest` | Testing framework |

No new dependencies required. Parallel execution uses `Promise.allSettled` with a hand-rolled semaphore for bounded concurrency. No external concurrency library needed.

---

## Open Questions

| Question | Proposed Resolution |
|----------|-------------------|
| How does checkpoint/resume work with parallel state? | Parallel execution is atomic from the engine's perspective — the parallel handler either completes or doesn't. If interrupted, the entire parallel block re-executes on resume. Branch-level resume is a future optimization. |
| Should `BranchExecutor` share code with `PipelineEngine` or be independent? | Factor out `executeNodeSequence()` as shared code. This prevents logic drift while keeping both callers simple. |
| What happens if a branch has no path to the convergence node? | The branch runs until it reaches a dead end (no outgoing edges) or an exit node. Its result is collected. This is valid — not every branch needs to terminate at the fan-in. |
| Can `parallel.results` be read by non-fan-in nodes? | Yes. `parallel.results` is just a context key. Any downstream node or condition expression can reference it. But the structured format is primarily designed for the fan-in handler. |
