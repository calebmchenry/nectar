# Sprint 015 Draft Critique

**Reviewer:** Claude
**Date:** 2026-03-20
**Drafts reviewed:** NEXT-CODEX-DRAFT.md, NEXT-GEMINI-DRAFT.md, NEXT-CLAUDE-DRAFT.md (own draft, included for completeness)

---

## NEXT-CODEX-DRAFT.md — "Runtime Fidelity & Canonical Run Artifacts"

### Strengths

1. **Excellent architecture depth.** The `PendingTransition`, `ResolvedFidelityPlan`, and `PreambleBuilder` abstractions are well-specified with concrete TypeScript interfaces, character budgets, and truncation priority rules. This is the most implementation-ready draft.
2. **Strong migration story.** Dual-write canonical + legacy cocoon files for one sprint is the right call. The explicit "read canonical first, legacy second" fallback is clean.
3. **Precise preamble budgets and truncation policy.** The per-mode character limits (400/3200/2400/6000/12000) with deterministic truncation (header > recent failure > human answer > oldest success) are concrete and testable. No hand-waving.
4. **`prompt.md` captures actual rendered prompt.** Writing what was sent to the model (not the raw node `prompt` attribute) is excellent for debuggability. Neither other draft mentions this.
5. **Legacy parse.ts insight.** Noting that `parse.ts` already folds `node [...]` defaults into `node.fidelity`/`node.threadId` — so the runtime doesn't need a second metadata channel — shows deep codebase awareness.
6. **Good risk table.** Covers migration, thread contention, preamble omissions, character-to-token drift, `resume --force` staleness, inline index bloat, and session leaks. Comprehensive.
7. **Cut-line is correct.** Protecting RunStore, ArtifactStore, fidelity planning, session reuse, and degraded resume as non-cuttable is the right priority call.

### Weaknesses

1. **No A11 (`auto_status`).** Omits a trivial ~10-line engine change that closes a Low gap for free. The other two drafts include it. No justification given for exclusion.
2. **Thread resolution precedence differs from spec.** Codex lists: node → edge → first class → **previous completed node ID**. The spec (§5.4) says: node → edge → subgraph class → previous node. Using "first class in `node.classes`" is close but subtly different from "subgraph class derivation" — should cite the spec section explicitly and confirm the parse.ts mapping from subgraph label to class is what's being used here.
3. **Phase allocation is front-loaded.** Phase 4 is 30% of the sprint and carries session reuse, reasoning overrides, handler integration, *and* large-output artifact registration. That's 4 distinct subsystems in one phase. If anything slips in Phases 1-3, Phase 4 becomes a crunch.
4. **No `thread_registry_keys` in checkpoint.** Codex draft records `pending_transition` and `resume_requires_degraded_fidelity` but never mentions persisting which thread keys were active. Without this, degraded-resume detection on reload requires guessing whether the last codergen used `full` — fragile.
5. **Module layout adds `src/checkpoint/` directory.** This introduces a new top-level module when `src/checkpoint/` doesn't currently exist (cocoon logic lives elsewhere). The refactor is fine but adds migration surface not acknowledged in the risk table.
6. **Artifact ID allocation is underspecified.** "Monotonic artifact IDs" allocated by `RunStore` — but what's the format? Numeric? UUID? Prefixed with node ID? The Claude draft also leaves this vague; only Gemini doesn't address artifacts at all.

### Gaps in Risk Analysis

- **No risk for the `compact` default behavioral change.** Existing pipelines with no fidelity attributes currently get unbounded context. Switching to `compact` is a **breaking behavioral change**. The Claude draft flags this explicitly as a risk; Codex doesn't.
- **No risk for Anthropic thinking signatures in long thread sessions.** If a `full` fidelity thread spans many turns, thinking block signatures may expire or the API may reject them. Claude draft flags this; Codex doesn't.
- **No risk for `ArtifactStore` performance on many small artifacts.** The risk of "inline index growing too large" is mentioned but the mitigation is vague ("keep the spill threshold strict"). What's the actual plan if a run produces 500 small artifacts?

### Missing Edge Cases

- What happens if a node has `fidelity="full"` but no thread resolves (no `thread_id`, no class, no previous node)? Should it get an ephemeral fresh session? The Claude draft says "fresh ephemeral session" explicitly.
- What happens if `resume --force` is used and the `pending_transition` edge's `fidelity` attribute has changed in the edited graph? The draft says "fail fast if target is gone" but doesn't address attribute changes on surviving edges.
- What if a tool node (not codergen) follows a `full`-fidelity codergen node and the run is interrupted? Does the degraded-resume flag survive across non-codergen nodes? The draft says "non-codergen nodes do not consume the flag" — good — but doesn't address whether non-codergen nodes can *trigger* the flag.

### Definition of Done Completeness

**Score: 8/10.** Very thorough. Covers build/regression, RunStore/ArtifactStore, fidelity resolution, session reuse, artifacts, and CLI. Missing:
- No explicit DoD item for backward compatibility of old cocoons without `pending_transition` fields
- No test count target (Claude draft says "at least 55")
- No gap closure checklist (Claude draft includes compliance-report update)

---

## NEXT-GEMINI-DRAFT.md — "Engine Fidelity & Supervisor Loop"

### Strengths

1. **Includes A1 (Manager loop handler).** This is the last Medium-severity attractor engine gap. Closing it alongside A4/A5 would bring the attractor engine to zero Medium+ gaps — a significant milestone.
2. **Context window awareness (C1).** The 80% threshold warning is a practical safety net for long-running sessions. Neither other draft includes C1.
3. **Clean phase structure.** Three phases, each with a clear focus: threads → fidelity → manager loop. Easy to track progress.
4. **`auto_status` included.** Closes A11 as a minor addition in Phase 3.

### Weaknesses

1. **Severely underspecified.** This is the shortest draft by far (~125 lines vs ~500+ for the others). Critical implementation details are missing:
   - No character budgets for fidelity modes
   - No truncation priority rules
   - No preamble format specification
   - No `PendingTransition` concept — edge-level fidelity/thread_id can't survive resume without it
   - No canonical run directory layout
   - No artifact store
   - No manifest.json
   - No checkpoint_saved event
2. **`summary:*` uses a secondary LLM call.** This is a significant design choice the other drafts explicitly reject. A secondary LLM call for summarization:
   - Adds latency to every non-`full` node with `summary:*` fidelity
   - Adds cost (even with a cheap model)
   - Makes preamble generation non-deterministic and harder to test
   - Creates a provider dependency for a pipeline infrastructure feature
   - The Codex and Claude drafts use deterministic templates — cheaper, faster, testable, and sufficient for v1
3. **A1 scope risk is enormous.** The manager loop handler is a fundamentally different handler type — it needs sub-graph identification, child outcome observation, steering logic, exit condition evaluation, and loop-back routing. This is not a "Phase 3 add-on"; it's a sprint unto itself. Including it alongside fidelity and thread resolution creates a sprint that's probably 2x the size of the others.
4. **No degraded resume.** No concept of what happens when a `full`-fidelity run is interrupted and the live session is lost. This is a critical correctness gap — without it, resumed `full`-fidelity runs would silently start fresh conversations, destroying the continuity that `full` fidelity exists to preserve.
5. **SessionStore vs SessionRegistry.** Storing sessions in `ExecutionContext` (suggested as an option) would pollute the context store with non-serializable objects. The Codex and Claude drafts correctly use a separate run-scoped registry.
6. **No dual-write migration for checkpoints.** No acknowledgment that checkpoint format changes need backward compatibility. Old cocoons would break on resume.
7. **`FidelityProcessor` naming is misleading.** It "applies fidelity modes" but what it really does is build preambles and manage session creation. The name suggests a data transformation pipeline, not session lifecycle management.
8. **No per-thread locking for parallel branches.** If two parallel branches share a `thread_id`, they'd interleave turns on the same LLM conversation. The other drafts address this with FIFO locks.

### Gaps in Risk Analysis

- **No risk for backward compatibility.** Checkpoint schema changes, context store changes, new event types — all unaddressed.
- **No risk for manager loop complexity.** "Supervisor loops become infinite loops" is mentioned, but the real risk is that the manager loop handler is underspecified — how does it identify its sub-graph? How does it observe child outcomes? How does it decide to loop back vs. exit? These are design questions, not just "add max_retries."
- **No risk for LLM-based summarization failure.** If the summary LLM call fails, rate-limits, or times out, what happens to the node that's waiting for its preamble?
- **No risk for default fidelity behavioral change.** Same gap as Codex.
- **No risk for session leaks on failure/interruption.**

### Missing Edge Cases

- Everything the Codex draft covers that this one doesn't: `resume --force` with stale transitions, artifact overflow, session lifecycle on interruption, provider/model mismatch on thread reuse, reasoning_effort change mechanics.
- How does the manager loop handler interact with goal gates? With retries? With parallel branches?
- What happens if a `summary:*` LLM call itself hits the context window limit?
- How does `context_window_size` interact with `full` fidelity — does the warning prevent the session from continuing, or is it just informational?

### Definition of Done Completeness

**Score: 4/10.** Minimal. Nine items, mostly "X works correctly" without measurable criteria:
- No build/regression requirements
- No backward compatibility requirements
- No checkpoint persistence requirements
- No test count or coverage targets
- No CLI compatibility requirements
- No gap closure checklist
- "Comprehensive unit tests" is not a testable criterion

---

## Comparative Assessment

| Dimension | Codex | Gemini | Claude |
|-----------|-------|--------|--------|
| Scope appropriateness | Correct | Too large (A1 bloats it) | Correct |
| Architecture detail | Excellent | Minimal | Very good |
| Implementation readiness | High | Low | High |
| Risk analysis | Good | Weak | Good |
| DoD completeness | 8/10 | 4/10 | 8/10 |
| Gap closure count | 6 (A3,A4,A5,A8,A10,C3) | 6 (A1,A4,A5,A11,C1,C3) | 7 (A3,A4,A5,A8,A10,A11,C3) |
| Novel/unique contribution | `prompt.md` rendered prompt, parse.ts insight | A1 manager loop, C1 context warnings | Default-fidelity behavioral change analysis, gap closure summary |

---

## Recommendations for Final Merged Sprint

### Scope

1. **Exclude A1 (manager loop).** It deserves its own sprint. The fidelity + thread + run-directory scope is already substantial. Gemini's inclusion of A1 is ambitious but risks the entire sprint.
2. **Include A11 (`auto_status`).** Trivial addition, closes a gap for free. Both Claude and Gemini include it; Codex omits it without justification.
3. **Exclude C1 (context window awareness).** Useful but orthogonal. It requires `context_window_size` on provider profiles (L19) — a separate LLM spec gap. Don't mix attractor-engine work with LLM-client work.
4. **Target: A3, A4, A5, A8, A10, A11, C3 = 7 gaps closed** (matching Claude draft).

### Architecture Decisions

5. **Use deterministic preambles, not LLM-based summarization.** The Codex and Claude drafts are right here. Deterministic templates are cheaper, faster, testable, and sufficient for v1. LLM-powered summaries can be a follow-up enhancement.
6. **Use a separate `SessionRegistry`, not `ExecutionContext`.** Non-serializable live sessions should not pollute the serializable context store.
7. **Persist `pending_transition` in checkpoint.** Both Codex and Claude agree; Gemini doesn't mention it. This is mandatory for edge-level fidelity/thread_id to survive resume.
8. **Persist `thread_registry_keys` in checkpoint.** The Claude draft includes this for degraded-resume detection. Codex omits it. Include it — guessing whether the last codergen used `full` from `completed_nodes` is fragile.
9. **Include per-thread FIFO locking.** Both Codex and Claude include it. Gemini doesn't. Parallel branches sharing a thread key is a real scenario.

### Implementation

10. **Adopt Codex's phase structure with Claude's Phase 5 as the cut-line.** Five phases, with ArtifactStore and auto_status in the final phase as cuttable if the sprint runs long.
11. **Adopt Codex's preamble character budgets and truncation rules.** They're the most concrete and testable across all drafts.
12. **Include Codex's `prompt.md` rendered-prompt feature.** High debuggability value, low implementation cost.
13. **Call out the `compact` default behavioral change explicitly** in the sprint document and release notes. This is a minor but real breaking change for existing pipelines.
14. **Set a test target of at least 55 new test cases** (from Claude draft). Vague "comprehensive tests" is not actionable.
15. **Include a gap closure summary table** (from Claude draft) with before/after gap counts per spec.

### Risks to Add

16. **Default fidelity behavioral change** — existing pipelines silently get `compact` instead of unbounded context. Mitigation: integration tests, release notes, migration guide.
17. **Anthropic thinking signature expiry** in long `full`-fidelity thread sessions. Mitigation: document as known limitation; retry logic handles API rejections.
18. **`src/checkpoint/` module creation** is a refactor with migration surface. Ensure cocoon.ts import paths are updated atomically.
