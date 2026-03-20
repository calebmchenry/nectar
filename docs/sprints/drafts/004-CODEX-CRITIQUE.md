# Sprint 004 Draft Critique

**Reviewer:** Codex
**Date:** 2026-03-19

Reviewed against:

- `docs/sprints/drafts/NEXT-CLAUDE-DRAFT.md`
- `docs/sprints/drafts/NEXT-GEMINI-DRAFT.md`
- `docs/upstream/attractor-spec.md` (especially Sections 3.8, 4.2, 4.8, 4.9, 5.3)
- `docs/compliance-report.md`
- `src/engine/engine.ts`
- `src/engine/types.ts`
- `src/engine/context.ts`
- `src/handlers/registry.ts`
- `src/garden/types.ts`
- `src/garden/parse.ts`
- `src/garden/validate.ts`
- `src/checkpoint/types.ts`
- `src/checkpoint/cocoon.ts`
- `src/cli/ui/renderer.ts`
- `src/cli/commands/run.ts`
- `src/cli/commands/resume.ts`

The main merge question is architectural. The upstream spec and the current repo both favor a single-threaded top-level engine with concurrency contained inside specialized handlers. Any plan that rewrites the core engine loop or cocoon model needs a very strong justification.

## Claude Draft

### Strengths

- This is the more implementation-ready draft. The phases, file list, data flow, and test plan are detailed enough to start coding from directly.
- It matches the spec's concurrency model. Keeping parallelism inside `ParallelHandler` and `FanInHandler` fits Section 3.8 and avoids turning `PipelineEngine` into a multi-active-node scheduler.
- It is much more grounded in the current repo layout. The draft correctly targets `src/garden/types.ts`, `src/handlers/registry.ts`, `src/engine/events.ts`, `src/cli/ui/renderer.ts`, and `gardens/compliance-loop.dot`.
- It treats branch isolation, bounded concurrency, join policy behavior, validation, and observability as first-class concerns instead of only describing the happy path.
- The risk section is materially stronger than Gemini's. Convergence ambiguity, cancellation races, serialization bloat, nested parallel, and unparseable LLM output are all real risks here.
- Including `HandlerRegistry.register()` is a good opportunistic addition because the spec already calls for runtime handler registration and the current registry is hardcoded.

### Weaknesses

- The scope is still too large for one sprint. `BranchExecutor`, inner-loop extraction, new handlers, new events, validation, CLI rendering, compliance-loop rewiring, and LLM-based fan-in is a lot of change in one pass.
- The checkpoint/resume story is internally inconsistent. The risk table describes partial branch bookkeeping, the Open Questions section says the whole parallel block should re-execute on resume, and the DoD says interruption checkpoints current state cleanly. Those are three different promises.
- Convergence detection is still underspecified for anything except the simple happy path. "First node reachable from all branches" becomes ambiguous quickly once branches dead-end, branch early to exits, or have multiple candidate fan-in nodes.
- The data model is conflicted. `BranchResult` includes full context snapshots and completed-node state, but the risk section argues for storing only summaries to avoid bloat. In the current repo, `ExecutionContext` is string-only, so this tension matters immediately.
- LLM-based fan-in likely does not belong in the must-ship path. The compliance-loop use case can be unlocked with deterministic heuristic selection.
- Extending `HandlerExecutionInput` with graph and event hooks for every handler adds system-wide churn for a feature that only one or two handlers need.

### Gaps in Risk Analysis

- There is no explicit risk entry for the shared execution-loop refactor breaking existing retry behavior, goal-gate behavior, event ordering, or cocoon semantics.
- There is no explicit risk entry for branch-local retry bookkeeping. The current engine owns `retryState`; a branch executor will need equivalent logic or behavior will silently diverge inside branches.
- There is no explicit risk entry for `parallel.results` living inside a string-only context and cocoon snapshot. That affects size, serialization format, and downstream access patterns.
- There is no explicit risk entry for multiple parallel blocks in one pipeline overwriting `parallel.results` later in the run.
- There is no explicit risk entry for `first_success` late side effects, where a losing branch is already in the middle of a tool call or codergen call when cancellation arrives.

### Missing Edge Cases

- `component` with zero or one outgoing edge.
- Invalid `max_parallel` values such as `0`, negative values, or non-numeric strings.
- A branch that reaches an `exit` node or dead end before the shared fan-in node.
- Multiple candidate `tripleoctagon` convergence nodes, or no common convergence node at all.
- Sequential parallel blocks that both write `parallel.results`.
- Retries, `allow_partial`, and goal gates inside branch execution.
- `first_success` where the winner is known but another branch still writes logs or status before it notices cancellation.

### Definition of Done Completeness

- This is the stronger DoD of the two drafts. It is close to actionable and mostly testable.
- It needs one explicit resume contract. The DoD should say either "parallel blocks restart from the component node on resume" or "completed branches are preserved and incomplete branches restart." It cannot imply both.
- It should explicitly cover malformed topology and config behavior: invalid `join_policy`, invalid `max_parallel`, missing results, zero branches, and ambiguous convergence.
- The LLM-mode fan-in DoD item should either require a mock client and deterministic parsing contract or move to a stretch goal.
- A few DoD items are too implementation-specific, especially the exact `__parallel` artifact path. The important outcome is branch artifact isolation, not the precise directory name.

## Gemini Draft

### Strengths

- It keeps the user value clear: run independent work concurrently, shorten wall-clock time, and resume interrupted work safely.
- The use cases and DoD both emphasize operational behavior instead of only type-level plumbing.
- The risk table names several real concurrency problems: checkpoint write races, output interleaving, engine-state complexity, and orphaned `first_success` branches.
- The wall-clock verification item in the DoD is worth keeping. This feature should prove actual concurrency, not just new code paths.
- It pushes resume and checkpoint behavior into the conversation early, which is valuable because parallel work is expensive and interruption semantics matter.

### Weaknesses

- The core architecture fights both the spec and the current codebase. Reworking `PipelineEngine` into a multi-active-node scheduler is much higher risk than handler-scoped parallel execution.
- The draft proposes `ExecutionContext.merge(contexts[])`, which conflicts with the spec's rule that branch contexts do not merge back into the parent except through explicit handler output such as `parallel.results`.
- It attaches `join_policy` to the fan-in node in the use cases and tasks, while the spec places it on the fan-out `component` node. That is a semantic mismatch, not just a wording issue.
- It does not define branch boundaries. The draft never explains how the engine decides when a branch is finished, when the fan-in node becomes eligible, or how dead-end and exit-node branches behave.
- The cocoon and run-state overhaul is too large for one sprint. Moving from one `current_node` to a set of active branches, each with isolated context, is effectively an engine redesign.
- It underuses the existing handler architecture. The draft makes the parallel handler mostly a signal to the engine rather than letting the handler own the concurrency, which weakens the pluggable-handler boundary.
- The file plan misses important current ownership points, especially `src/garden/types.ts` for shape/kind mapping and `src/engine/events.ts` for the new event surface.
- It does not mention updating `gardens/compliance-loop.dot`, which is the concrete motivating workflow for this sprint.

### Gaps in Risk Analysis

- There is no explicit risk entry for architectural mismatch with Section 3.8 of the spec and the current single-threaded engine design.
- There is no explicit risk entry for convergence detection or fan-in topology correctness.
- There is no explicit risk entry for the context-merge model violating spec semantics and inflating checkpoint size.
- There is no explicit risk entry for retry logic, goal-gate enforcement, and edge selection becoming more complex under a multi-active-node engine.
- There is no explicit risk entry for `parallel.results` lifecycle, including overwrite behavior across multiple parallel blocks.
- There is no explicit risk entry for deterministic testing of `first_success`, race timing, and cancellation ordering.

### Missing Edge Cases

- `component` with zero or one outgoing edge.
- Invalid `join_policy` and invalid `max_parallel`.
- Branches that never reach a fan-in node, or terminate early via exit/dead-end.
- All branches failing under `wait_all` versus `first_success`.
- Nested parallel blocks.
- Sequential parallel blocks in the same pipeline.
- Fan-in reading empty or malformed `parallel.results`.
- Branch-local retries, human gates, or goal gates while parallel execution is active.
- Interruption after some branches finish but before fan-in consolidation begins.

### Definition of Done Completeness

- The DoD is not complete enough to serve as the sprint's authoritative checklist.
- It should require `npm run build` in addition to tests.
- It should require shape-to-kind parsing and validator acceptance for `component` and `tripleoctagon`, not only runtime behavior.
- It should require the concrete context contract: `parallel.results`, `parallel.fan_in.best_id`, and `parallel.fan_in.best_outcome`.
- It should require parallel events and renderer support, because current CLI output is event-driven.
- It should require a concrete decision on resume semantics rather than promising branch-specific restart behavior implicitly.
- It should require the motivating workflow update in `gardens/compliance-loop.dot`.
- It should require error-path behavior for malformed topology and missing results, not only happy-path synchronization.

## Recommendations For The Final Merged Sprint

- Use the Claude draft as the architectural base. Keep the top-level engine single-threaded and implement concurrency inside `ParallelHandler` plus a small branch-execution helper.
- Keep Gemini's operational focus, but simplify the resume story for Sprint 004: interrupted parallel blocks restart from the `component` node on resume. Do not redesign the cocoon schema for per-branch resume in this sprint.
- Make heuristic fan-in the must-ship behavior. Treat LLM-based ranking as a stretch goal or defer it outright.
- Keep topology intentionally constrained. Support the common `component -> branches -> tripleoctagon` shape, and reject or warn on ambiguous graphs instead of trying to support arbitrary convergence patterns immediately.
- Parse `join_policy` and `max_parallel` on the `component` node, validate the enum/range, and define overwrite behavior for `parallel.results` when multiple parallel blocks appear in one run.
- If a shared `executeNodeSequence()` extraction is required, treat it as the highest-risk task in the sprint and land it with regression coverage before layering on parallel behavior.
- Keep `HandlerRegistry.register()` in scope if it remains low-cost. It is aligned with the spec and fits naturally with adding new handlers anyway.
- Require these DoD items in the merged sprint: `npm run build && npm test`, a wall-clock concurrency test, context-isolation tests, `wait_all` and `first_success` tests, malformed-topology/config validation tests, clearly defined interrupt/resume behavior, parallel event rendering, and `gardens/compliance-loop.dot` updated to use the new nodes.
- Defer branch-level resume, broad cocoon schema redesign, and ambitious nested-parallel support beyond a narrow smoke test.
