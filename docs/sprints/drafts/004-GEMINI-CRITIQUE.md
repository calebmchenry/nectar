# Critique: Sprint 004 Parallel Execution Drafts

*Note: `NEXT-CODEX-DRAFT.md` was not found in the repository. This critique evaluates `NEXT-CLAUDE-DRAFT.md` and `NEXT-GEMINI-DRAFT.md` as the two available drafts for this sprint.*

## 1. Claude Draft (`NEXT-CLAUDE-DRAFT.md`)

### Strengths
- **Architectural Safety**: Brilliantly identifies that parallelism should be a *handler* concern rather than an *engine* concern. Using a `BranchExecutor` to encapsulate subgraph traversal keeps the main engine loop single-threaded and simple.
- **Detailed Fan-In Logic**: Clearly specifies both heuristic and LLM-based evaluation strategies for the fan-in node, which is essential for evaluating multiple AI drafts.
- **Resource Management**: Includes bounded concurrency (`max_parallel`), preventing resource exhaustion when making multiple expensive LLM calls.
- **Context Isolation**: Strong approach to deep-copying contexts and namespacing results under `parallel.results` to avoid merge conflicts.

### Weaknesses
- **Atomic Resumption**: Treats the entire parallel execution block as atomic. If interrupted, all branches restart from scratch. This is highly inefficient for long-running AI tasks.
- **Convergence Node Detection**: The logic to find the convergence node (fan-in) might be brittle if the graph is complex or contains intermediate convergence points before the final fan-in.

### Gaps in Risk Analysis
- **LLM Context Window Exhaustion**: Does not consider the risk that the LLM fan-in prompt might exceed context limits if it attempts to include context snapshots from many branches.
- **Memory Overhead**: Deep-copying the context for many branches could lead to memory bloat if the context contains large payloads (like full source files).

### Missing Edge Cases
- What happens if the LLM fan-in evaluation fails entirely (e.g., API outage)? Should it fail the node or fall back to the heuristic method?
- Cyclic dependencies or infinite loops inside a parallel branch subgraph.

### Definition of Done Completeness
- Very comprehensive. It covers functional requirements, validation, CLI rendering, and specific termination scenarios.

---

## 2. Gemini Draft (`NEXT-GEMINI-DRAFT.md`)

### Strengths
- **Resilient Resumption**: Modifies the `Cocoon` schema to track `active_branches`, allowing the engine to resume only incomplete branches after an interruption. This is a massive UX improvement for long-running workflows.
- **Concurrency Safety**: Correctly identifies the risk of file-write data races (Cocoon overwrites) when multiple branches complete simultaneously, proposing a mutex/lock mitigation.
- **UI UX**: Highlights the need for an updated event renderer to handle interleaved outputs (multiple spinners).

### Weaknesses
- **High-Risk Core Rewrite**: Proposes overhauling the core `PipelineEngine` to be fully asynchronous and multi-active. This significantly increases system complexity and risks breaking existing single-threaded assumptions across the codebase.
- **Vague Fan-In Logic**: Lacks detail on how `wait_all` actually selects the "best" outcome. It completely misses the LLM evaluation and heuristic ranking mechanisms outlined in the specs.
- **Missing Concurrency Limits**: Does not specify a way to bound concurrency (no `max_parallel`), meaning a fan-out of 100 nodes would instantly spawn 100 concurrent tasks.

### Gaps in Risk Analysis
- **Context Merge Conflicts**: States that the fan-in node will "merge their contexts," but ignores the severe risk of key collisions if branches mutate the same context variables.
- **Abort Signal Propagation**: Fails to detail exactly how `AbortController` signals will propagate down to specific tool implementations or subprocesses.

### Missing Edge Cases
- Fan-in behavior when zero branches succeed under `first_success`.
- Handling of branches that reach a dead-end before hitting the fan-in node.

### Definition of Done Completeness
- Somewhat sparse. Missing specific validation rules, concurrency limit checks, and LLM fan-in verification.

---

## 3. Recommendations for Final Merged Sprint

The final merged sprint should combine Claude's safe encapsulation with Gemini's resilient checkpointing:

1. **Architecture (Use Claude's Approach)**: Keep the main engine loop single-threaded. Implement parallel execution internally within the `ParallelHandler` via `BranchExecutors`. Do *not* rewrite the core engine to support multi-active nodes.
2. **Resumption & Checkpointing (Adapt Gemini's Insight)**: Do not treat the parallel block as strictly atomic. The `ParallelHandler` should maintain its own localized state (e.g., inside `context_updates` or a dedicated checkpoint slice) so that upon resumption, it only spins up `BranchExecutors` for branches that did not previously complete. Use Gemini's proposed mutex around atomic state writes.
3. **Context Management**: Strictly enforce Claude's isolation model. Branches use clones, and their local mutations are *not* merged back to the parent. Instead, outcomes are strictly packaged into `parallel.results[branch_id]`.
4. **Fan-In Consolidation**: Adopt Claude's dual-mode (heuristic + LLM) fan-in evaluation. Add a fallback mechanism in case the LLM evaluation fails (fallback to heuristic). Add a token/size limit strategy for the LLM prompt to mitigate context exhaustion.
5. **Resource Bounding**: Include `max_parallel` from the Claude draft to prevent overwhelming the system or external APIs.
