# Sprint 033 Merge Notes

**Merged from:** NEXT-CLAUDE-DRAFT.md (Claude), NEXT-CODEX-DRAFT.md (Codex), NEXT-GEMINI-DRAFT.md (Gemini)
**Critiques used:** NEXT-CLAUDE-CRITIQUE.md, NEXT-CODEX-CRITIQUE.md, NEXT-GEMINI-CRITIQUE.md
**Date:** 2026-03-21

---

## Structural Base: Codex Draft

The Codex draft was chosen as the structural base because all three critiques agreed it had:
- The strongest product thesis (runtime truth for the Hive)
- The best subsystem boundaries and file ownership model
- Appropriate scope focused on high-severity gaps rather than trying to close all 25

The merged sprint preserves Codex's five-phase structure (run truth → human gates → seed bridge → single-exit → Gemini normalization) and its "Out of scope" discipline.

## From Claude Draft

**Adopted:**
- **Root-cause test fix analysis (Phase 1).** Claude's three-bug breakdown (SSE deferred close, `withLiveCurrentNode()` inversion, pipeline creation 400) is specific, actionable, and cites exact files and line numbers. All three critiques called this the strongest diagnostic work across any draft. This became the mandatory Phase 1 with a hard gate: no further work until `npm test` is green.
- **Historical context.** The Overview section's honest accounting of the 8-sprint failure streak and the lesson ("previous sprints failed because they mixed SSE fixes with large feature work") was incorporated to build institutional memory.
- **DoD structure.** Claude's per-item, mechanically-verifiable Definition of Done was adopted and trimmed to match the actual scope. The "no timeout inflation" anti-cheating constraint was kept.
- **SSE guard test.** The proposal to add a test asserting synchronous close behavior was included in Phase 1.
- **A1 `.dot` file audit mitigation.** The risk mitigation of auditing existing gardens before tightening validation was added.

**Deferred:**
- The 23 low-severity compliance gaps (U1–U12, C3–C5, C9–C12, A2, A4–A6). All three critiques agreed this scope was too large for one sprint. These are explicitly out of scope and will be planned in Sprint 034.
- The compliance-report-zero-gaps goal. The merged sprint only closes A1 and U19, and updates the report for those two.

## From Codex Draft

**Adopted (structural base):**
- **Overall architecture and data flow.** The runtime model (RunManager as live-state authority, question interruption state, seed-run bridge extraction, single-exit enforcement at authoring boundary) was kept intact.
- **Phase structure.** Phases 2–5 map directly to Codex's Phases 1–4 with minor adjustments.
- **Use cases.** The behavior-first, HTTP-flow use cases were preserved and expanded with Claude's SSE and pipeline creation cases.
- **Risk table.** Most entries come from Codex (single-exit fixture breakage, question compatibility, seed double-writes, live-state overlay inconsistency, draft validation errors).
- **Dependencies.** Adopted verbatim.

**Additions from critiques:**
- Added an explicit drop line (recommended by Claude critique: "Write down the drop line up front").
- Added risks for abandoned SSE streams (Codex critique), cancel/answer race during `wait.human` (Claude critique), and server restart between interrupt and resume (Claude critique).
- Added backward-compatible deserialization requirement for older question records (Claude critique, Codex critique).
- Added `run_failed` exact-once requirement for the seed bridge (Claude critique).
- Added streaming + non-streaming coverage requirement for Gemini RECITATION (Claude critique, Codex critique).

## From Gemini Draft

**Adopted:**
- **Severity-first prioritization instinct.** The Gemini draft's framing of A1 and U19 as high-severity confirmed the scope decision to keep those two gaps and defer the rest.

**Rejected:**
- **ReadWriteLock for A2.** All three critiques rejected this. The Codex critique called it "the most dangerous item in either draft." JS's single-threaded event loop + context clones already provides the spec's safety guarantee. Introducing a concurrency primitive is unnecessary complexity with real deadlock risk.
- **Full PascalCase event rename for A4.** Both the Claude and Codex critiques flagged this as a breaking change with high blast radius. String-based event matching in SSE, tests, CLI formatters, and external consumers would silently break. The Claude draft's alias approach was acknowledged as safer but also deferred — neither a full rename nor aliases belong in a runtime-stability sprint.
- **All 25 gaps in one sprint.** The Codex critique noted the Gemini draft had "unacknowledged overscope." The Claude critique called it "not one sprint." The merged sprint targets only the 2 high-severity gaps plus the test fixes and runtime work.
- **Dependencies: "None."** The Codex critique correctly noted that a sprint changing engine events, execution context, tool schemas, and adapters absolutely has dependencies. The merged sprint lists real dependencies.

## Key Merge Decisions

1. **Phase 1 is test fixes, not compliance.** This is the central lesson from 8 failed sprints. The merged sprint makes it structurally impossible to skip the test fixes by gating all subsequent phases on a green suite.

2. **Scope is runtime truth + 2 high-severity gaps.** Not 25 gaps. Not zero-gap compliance. The merged sprint ships a correct, testable runtime that the Hive can depend on.

3. **Drop line is explicit.** If the sprint runs long, seed bridge and human-gate semantics can defer to Sprint 034. The test fixes, single-exit enforcement, and Gemini normalization cannot.

4. **A2 is documented divergence, not a code change.** The spec's ReadWriteLock requirement is met by JS's event loop guarantees. This is noted in "Out of scope" and will be documented with a code comment in a future sprint.

5. **A4 is deferred entirely.** Event naming is not a runtime-truth concern. It belongs in a dedicated compatibility sprint with a proper migration strategy.
