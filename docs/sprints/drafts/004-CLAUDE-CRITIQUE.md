# Sprint 004 Draft Critique

**Reviewer:** Claude
**Date:** 2025-03-19
**Drafts reviewed:** NEXT-GEMINI-DRAFT.md, NEXT-CODEX-DRAFT.md (missing)

---

## Meta-Observation: Missing Codex Draft, Identical Claude/Gemini Drafts

`NEXT-CODEX-DRAFT.md` does not exist. The merge process will lack a third perspective.

`NEXT-CLAUDE-DRAFT.md` and `NEXT-GEMINI-DRAFT.md` are **byte-for-byte identical**. This likely indicates a copy error during the drafting workflow — one draft was used to seed the other, or both were generated from the same source. The merge step should treat them as a single draft and weight the Codex perspective (once produced) as the primary counterpoint.

Because the two extant drafts are identical, this critique applies to both. I'll refer to them collectively as "the draft."

---

## Strengths

### 1. Correct Architectural Decision: Handler-Level Parallelism
The draft correctly identifies that parallelism should be a **handler concern, not an engine concern**. The current `PipelineEngine.run()` loop (`engine.ts:119`) is a straightforward `while(current_node)` with single-node tracking. Keeping the engine's loop untouched and letting `ParallelHandler.execute()` manage concurrency internally is the lowest-risk design. This avoids the state machine complexity explosion that the (nonexistent) Codex draft's approach of modifying the engine loop would introduce.

### 2. Well-Defined Data Flow
The ASCII data flow diagram (lines 122–154) makes the execution model unambiguous: engine → parallel handler → branch executors → collect → fan-in handler. This clear separation of responsibilities will make the code reviewable and testable.

### 3. Bounded Concurrency via `max_parallel`
Including `max_parallel` (default 4) is pragmatic. Real-world LLM calls are expensive, and unbounded concurrency would cause rate limiting or cost overruns. The semaphore approach with `Promise.allSettled` is the right primitive.

### 4. Comprehensive Use Cases
Six use cases covering the happy path (concurrent drafts), racing (first_success), isolation, failure semantics, bounded concurrency, and observability. This is thorough enough to derive tests from directly.

### 5. `BranchExecutor` Code Reuse Strategy
The plan to factor `executeNodeSequence()` out of `PipelineEngine.run()` and share it with `BranchExecutor` is the right call. The current engine loop (engine.ts:119–312) mixes node execution, edge selection, retry logic, checkpoint writes, and context updates. Extracting a reusable inner loop is a prerequisite for clean branch execution.

### 6. Explicit Convergence Node Detection
The draft proposes detecting the convergence node (first `tripleoctagon` reachable from all branch starts) with a fallback `convergence_node` attribute. This handles the common case automatically while providing an escape hatch for complex graphs.

---

## Weaknesses

### 1. `executeNodeSequence()` Extraction Is Under-Scoped
The engine's inner loop (engine.ts:119–312) is ~190 lines with deeply interleaved concerns: goal gate checks (line 131), retry logic (lines 220–239), `allow_partial` conversion (line 243), context key updates (`current_node`, `outcome`, `preferred_label`), signal handling, cocoon writes, and event emission. Factoring this into a clean, reusable function is a **significant refactor** — arguably the riskiest part of the sprint — yet it's a sub-bullet in Phase 2 with no dedicated risk entry.

**Recommendation:** Dedicate a standalone phase to the extraction. Define the interface explicitly (what goes in, what comes out, what side effects are allowed). Add a risk entry for "inner loop extraction breaks existing behavior."

### 2. Checkpoint/Resume Is Hand-Waved
The "Open Questions" section says parallel execution is atomic — if interrupted mid-parallel, the entire block re-executes on resume. But the draft's own Definition of Done (line 326) says "SIGINT/SIGTERM during parallel execution checkpoints current state cleanly." These contradict each other.

If the parallel handler takes 10 minutes to run 3 LLM branches and gets SIGINT after 2 complete, re-executing all 3 on resume wastes significant time and money. The draft should either:
- Commit to atomic (no partial resume) and remove the DoD item, or
- Design branch-level checkpointing in this sprint.

**Recommendation:** Go atomic for Sprint 004 (simpler), but explicitly state in the DoD that interrupted parallel blocks **restart from scratch** on resume. Defer branch-level resume to a follow-up.

### 3. Fan-In LLM Mode Is Under-Specified
Phase 4 says "call LLM to rank candidates" and "parse LLM response for best candidate selection" but gives no detail on:
- What the evaluation prompt looks like
- How branch context snapshots are formatted for the LLM
- What the expected response format is (JSON? freeform?)
- How to handle token limits when N branch contexts are large

LLM-based fan-in is a feature that could easily consume half the sprint if not tightly scoped.

**Recommendation:** Either cut LLM-based fan-in from Sprint 004 (heuristic-only is sufficient for the compliance loop) or specify the prompt template, expected response schema, and token budget upfront.

### 4. `HandlerExecutionInput` Extension Is Invasive
The draft proposes extending `HandlerExecutionInput` with `graph: GardenGraph` and `onEvent: RunEventListener` (Phase 3, line 216). Currently `HandlerExecutionInput` (types.ts:48–57) is a clean, narrow interface — node, context, attempt, run_dir, abort_signal, outgoing_edges. Adding the full graph and an event emitter changes the contract for **all** handlers, not just parallel.

**Recommendation:** Don't widen the shared interface. Instead, inject `graph` and `onEvent` into `ParallelHandler`'s constructor (or a factory method). The parallel handler is special — let it accept special inputs without polluting the common interface.

### 5. No Timeout for Parallel Execution
Individual nodes already support `timeoutMs`, but there's no timeout for the parallel block as a whole. If one branch hangs indefinitely under `wait_all`, the entire pipeline stalls. The `max_parallel` attribute limits concurrency but not duration.

**Recommendation:** Add a `timeout_ms` attribute on the `component` node. On timeout, collect whatever has completed and treat timed-out branches as failures.

### 6. Validation Rule `fan_in_topology` Is Too Weak
The draft only warns if a `tripleoctagon` has no `component` ancestor. It doesn't validate:
- That a `component` node has a corresponding `tripleoctagon` downstream (orphaned fan-out)
- That the branches between component and tripleoctagon don't contain unrelated incoming edges (which would break convergence detection)
- That branch subgraphs are well-formed DAGs (no cycles within a parallel block)

**Recommendation:** Add validation for orphaned fan-out nodes and cycles within parallel subgraphs. These are easy to get wrong in DOT and hard to debug at runtime.

---

## Gaps in Risk Analysis

### 1. Missing Risk: Engine Refactor Regression
The `executeNodeSequence()` extraction touches the core execution path that every existing test depends on. A subtle change in retry behavior, context update ordering, or event emission could break existing pipelines silently. This should be the #1 risk entry.

### 2. Missing Risk: Context Values Are Strings
`ExecutionContext` stores `Map<string, string>` (context.ts:2). `parallel.results` is a complex structured object (branch IDs, statuses, context snapshots, durations). Serializing this to a string and storing it as a context value works, but:
- Downstream condition expressions that reference `parallel.results` will get a JSON blob, not a structured object
- Size could be large if branches produce verbose context
- No type safety at the boundary

The draft mentions `serializeParallelResults()` / `deserializeParallelResults()` but doesn't address the friction of storing structured data in a string-only context.

### 3. Missing Risk: Branch Execution Order Non-Determinism
`Promise.allSettled` with a semaphore doesn't guarantee branch execution order. For `first_success`, the "winner" depends on which branch finishes first, which depends on external factors (LLM latency, network). Tests that assert on a specific winner could be flaky.

### 4. Missing Risk: Nested Parallel Deadlock
The draft says nested parallel "works naturally" (risk table, last row). But if outer `max_parallel=2` and inner `max_parallel=2`, and the outer has 2 branches each containing a parallel node with 2 branches, you need 4 concurrent slots but only have 2. The inner parallel blocks could starve if the semaphore is shared. If it's per-handler, there's no global bound.

---

## Missing Edge Cases

1. **Single-branch parallel node:** `component` with exactly 1 outgoing edge. The validation requires ≥2, but what if a graph is dynamically generated with variable branch counts? Consider allowing 1 (degenerate but valid).

2. **Empty branch:** A branch's start node immediately reaches the fan-in with no intermediate nodes. The `BranchResult` should handle zero-work branches gracefully.

3. **Branch that hits an `exit` node:** The draft says branches terminate at exit nodes, but if a branch exits, what's the overall pipeline status? Does the fan-in still wait for other branches?

4. **`parallel.results` key collision:** If two parallel blocks run sequentially, the second overwrites `parallel.results` from the first. Downstream logic that depends on the first block's results will break. Consider namespacing: `parallel.results.{node_id}`.

5. **Retry within a branch:** If a node inside a branch has `max_retries`, the branch executor needs its own retry state. The draft doesn't address whether branch-level retry state is isolated or shared.

6. **Goal gates inside parallel branches:** The current goal gate logic (engine.ts:320–366) checks all `goalGate` nodes globally. If a goal gate node is inside a branch, its completion is tracked in the branch executor's completed_nodes, not the main engine's. This could silently bypass goal gate enforcement.

---

## Definition of Done Completeness

The DoD has 27 items — thorough, but some issues:

| Issue | Detail |
|-------|--------|
| **Contradictory items** | "SIGINT/SIGTERM checkpoints current state cleanly" vs. Open Questions saying parallel is atomic and re-executes on resume. Pick one. |
| **Missing: regression** | No item for "all pre-existing tests still pass." The `npm test` item covers it indirectly but should be explicit given the engine refactor. |
| **Missing: error paths** | No DoD item for "parallel handler returns `failure` if zero branches exist" or "parallel handler returns `failure` if all branches fail under `wait_all`." |
| **Missing: nested parallel** | The risk section mentions it, a fixture exists (`parallel-nested.dot`), but no DoD item asserts nested parallel works. |
| **Overly specific** | "Branch artifacts written to `{run_dir}/__parallel/{branchId}/`" is an implementation detail, not an outcome. Reframe as "branch execution artifacts are isolated per branch." |
| **LLM fan-in testability** | "Fan-in handler (LLM mode) calls LLM when `prompt` attribute is present" — how will this be tested without a real LLM? The DoD should specify "with a mock/simulated LLM client." |

---

## Recommendations for the Final Merged Sprint

1. **Reorder phases.** Extract `executeNodeSequence()` as Phase 1 with its own tests and risk entry. This is the foundation everything else depends on. Get it right first.

2. **Cut LLM-based fan-in to a follow-up.** Heuristic fan-in is sufficient for the compliance loop. LLM evaluation adds prompt engineering, token management, and response parsing complexity that will bloat the sprint. Mark it as a Phase 2 stretch goal at most.

3. **Resolve the checkpoint contradiction.** Go with "parallel is atomic, re-executes on resume" for Sprint 004. Remove the DoD item about clean SIGINT checkpointing of parallel state. Add a note that branch-level resume is deferred.

4. **Namespace `parallel.results`.** Use `parallel.results.{parallel_node_id}` to avoid collisions when multiple parallel blocks exist in a pipeline.

5. **Don't widen `HandlerExecutionInput`.** Inject `graph` and `onEvent` into the parallel handler's constructor, not the shared interface.

6. **Add a parallel block timeout.** `timeout_ms` on `component` nodes to prevent indefinite hangs.

7. **Strengthen validation.** Add rules for: orphaned fan-out (component with no reachable tripleoctagon), cycles within parallel subgraphs, and fan-in nodes with mismatched incoming branch counts.

8. **Add explicit edge cases to DoD.** Single-branch degenerate case, empty branches, `parallel.results` key collision, retry-within-branch isolation.

9. **Produce the Codex draft.** The merge currently has only one unique perspective. A second draft with potentially different architectural choices (e.g., engine-level parallelism vs. handler-level) would strengthen the final plan.

10. **Test strategy for non-determinism.** For `first_success` tests, use deterministic delays (e.g., `setTimeout` mocks) to control which branch "wins." Don't rely on real timing.
