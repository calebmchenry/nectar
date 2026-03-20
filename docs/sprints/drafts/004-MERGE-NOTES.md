# Sprint 004 Merge Notes

**Merged:** 2026-03-19
**Inputs:** NEXT-CLAUDE-DRAFT.md, NEXT-GEMINI-DRAFT.md, NEXT-CLAUDE-CRITIQUE.md, NEXT-CODEX-CRITIQUE.md, NEXT-GEMINI-CRITIQUE.md

---

## Architectural Base: Claude Draft

The Claude draft was used as the structural and architectural foundation. All three critiques (Claude, Codex, Gemini) agreed that handler-level parallelism (Claude's approach) is correct, while the Gemini draft's engine-level rewrite was too risky and misaligned with both the spec (Section 3.8) and the current single-threaded engine design.

**Taken from Claude draft:**
- Handler-level parallelism model (ParallelHandler owns concurrency, engine loop unchanged)
- BranchExecutor with subgraph traversal and convergence node detection
- Bounded concurrency via `max_parallel` with semaphore pattern
- Context clone isolation (no context merge back to parent)
- Dual join policies: `wait_all` and `first_success`
- Detailed data flow, module layout, and file plan
- Comprehensive risk table and security considerations
- Fan-in heuristic ranking logic (status → tiebreak)

**Taken from Gemini draft:**
- Emphasis on wall-clock concurrency verification in DoD (parallel should provably be faster than sequential)
- Identification of checkpoint write race risk (mutex around cocoon writes)
- Operational focus on resilient resumption as a future concern
- Clear UI/UX requirement for handling interleaved branch output

## Key Changes from Critiques

### From Claude Critique:
1. **Reordered phases** — `executeNodeSequence()` extraction is now Phase 1, not a sub-bullet. This is the highest-risk task and the foundation for everything else.
2. **LLM fan-in demoted to stretch goal** — Heuristic fan-in is sufficient for the compliance loop. LLM evaluation adds prompt engineering and token management complexity that would bloat the sprint.
3. **Checkpoint contradiction resolved** — Went with "atomic parallel, re-executes on resume." Removed contradictory DoD items. Branch-level resume explicitly deferred.
4. **Namespaced `parallel.results`** — Changed from `parallel.results` to `parallel.results.<node_id>` to prevent collisions across multiple parallel blocks.
5. **`HandlerExecutionInput` left narrow** — Graph and event listener injected into ParallelHandler constructor, not the shared interface.
6. **Stronger validation** — Added rules for orphaned fan-out and cycle detection within parallel subgraphs.
7. **Non-determinism test strategy** — Specified deterministic delays (mocked) for `first_success` tests.
8. **Added missing edge cases to DoD** — Invalid config values, all-fail under wait_all, empty branches.

### From Codex Critique:
1. **Explicit engine refactor risk entry** — Added as the #1 risk with highest likelihood and impact.
2. **Branch-local retry isolation** — Explicitly called out that branch executors have isolated retry state.
3. **`parallel.results` string-context friction acknowledged** — Serialization helpers serialize only terminal outcomes and summaries, not full context snapshots, to limit size.
4. **Multiple parallel block overwrite behavior defined** — Namespaced keys solve this.
5. **`first_success` late side-effects risk** — Mitigated via abort signals and branch-between-node checks.
6. **DoD strengthened** — Added `npm run build`, wall-clock test, malformed topology/config validation, explicit resume contract, and error-path behavior items.
7. **Topology kept intentionally constrained** — Support the common component→branches→tripleoctagon pattern; warn on ambiguous graphs rather than trying to handle arbitrary convergence.

### From Gemini Critique:
1. **LLM fan-in fallback** — If LLM evaluation is attempted (stretch), it falls back to heuristic on failure. Token budget cap included.
2. **Resilient resumption insight preserved** — Documented as the explicit future direction, but kept atomic for Sprint 004 to avoid cocoon schema redesign.
3. **Memory overhead of context cloning noted** — Addressed by serializing summaries rather than full snapshots in parallel results.

## What Was Rejected

| Idea | Source | Reason |
|------|--------|--------|
| Engine-level multi-active-node scheduler | Gemini draft | Contradicts spec Section 3.8; massively increases engine complexity; all critiques agreed this was wrong |
| `ExecutionContext.merge()` | Gemini draft | Violates spec rule that branch contexts don't merge back; causes key collision bugs |
| Cocoon schema redesign for per-branch resume | Gemini draft | Too large for one sprint; atomic parallel is simpler and sufficient for Sprint 004 |
| `join_policy` on fan-in node | Gemini draft | Spec places it on the fan-out `component` node |
| LLM fan-in as must-ship | Claude draft | All critiques recommended deferring; heuristic is sufficient for the motivating use case |
| Nested parallel as fully supported | Claude draft | Codex critique raised deadlock risk; demoted to smoke test only |
| Single-branch parallel as error | Claude draft | Changed to ≥2 validation (warning, not error) per Claude critique's note on dynamic graph generation |

## Priority Tiers (New Addition)

Added explicit priority tiers (Tier 1/2/3) inspired by Sprint 003's format, making it clear what to cut if the sprint runs long. LLM fan-in, branch-level resume, and full nested parallel support are all Tier 3 stretch goals.
