# Sprint 029 Merge Notes (Revised — Post-Critique)

## Source Materials
- **029-CLAUDE-DRAFT.md** (Claude) — primary structure and root-cause analysis
- **029-CODEX-DRAFT.md** (Codex) — architectural SSE contract and RunManager centralization
- **029-GEMINI-DRAFT.md** (Gemini) — pragmatic scope and context endpoint fix
- **NEXT-CODEX-CRITIQUE.md** (Codex reviewing Claude + Gemini) — corrected failure count, gardens-draft misdiagnosis, http-server investigation
- **NEXT-GEMINI-CRITIQUE.md** (Gemini reviewing Claude + Codex) — scope creep identification, SSE depth concerns, refactor risk

## What Changed in This Revision

The original 029-MERGE-NOTES.md synthesized the three drafts. This revision incorporates corrections from the two critiques that arrived after the initial merge. Key changes:

### 1. Failure Count Corrected (Codex critique)
- **Before:** "10 tests fail across 7 files"
- **After:** "9 tests fail across 6 files"
- The streaming test at `openai-compatible.test.ts:223` may not actually be failing — it's behind a `canListen` guard that skips when a loopback port is unavailable. The sprint now treats it as "verify and fix if needed" rather than assuming it fails.

### 2. gardens-draft Reclassified as Content Assertion (Codex critique)
- **Before:** Lumped with SSE lifecycle cluster (Cluster C) — all three drafts made this error
- **After:** Separated into its own Cluster C as a content assertion mismatch
- The test at `gardens-draft.test.ts:80` asserts `expect(payload).toContain('digraph Drafted')` but the mock returns `digraph { ... }` without "Drafted". The SSE stream closes correctly — the test receives `draft_complete`. This is now Phase 2 with 5% effort, a trivial fix once diagnosed correctly.
- This was the single most valuable correction from the critiques. Without it, the executor would have spent Phase 2 debugging SSE infrastructure for a test that has no SSE problem.

### 3. http-server Cancel Test Flagged for Investigation (Codex critique)
- **Before:** Assumed to be an SSE timeout like the other 4 integration tests
- **After:** Noted as potentially a state machine / assertion error, not a timeout. Phase 3 now includes an explicit task to investigate this test separately with verbose output before applying SSE fixes.

### 4. "No Skipped Tests" Added to DoD (Codex critique)
- The critique noted that a test behind `canListen` that's skipped isn't the same as a test that passes. Added verification with `--reporter=verbose` to the DoD and Phase 5.

### 5. StreamAccumulator Scope Risk Added (Both critiques)
- Codex warned that StreamAccumulator tests could reveal bugs that expand scope. Gemini's critique reinforced this. Added explicit mitigation: file bugs for future sprint rather than fixing in-line.

### 6. Line Numbers Changed to Approximate (Codex critique)
- Codex noted that pinning exact line numbers risks drift from intermediate commits. All line references now use `~` prefix and the root cause table references test names as the stable identifier.

## What Was Taken From Each Source

### From Claude's Draft (Primary Structure — retained from initial merge)
- Overall framing and "why now" narrative
- Root cause analysis table with expected-vs-actual values
- Cut line strategy with explicit ordering
- Phase gate approach (run specific test suites between phases)

### From Codex's Draft (Architecture — selectively retained)
- SSE lifecycle contract concept (finite vs persistent streams) — kept as the guiding principle
- Active run context truth — `GET /pipelines/:id/context` must include `current_node`
- **Deferred:** `src/server/sse.ts` shared helper and `src/server/seed-run-tracker.ts` extraction — good ideas but architecture improvements, not bug fixes. The sprint can succeed by applying a consistent pattern to existing files.

### From Gemini's Draft (Pragmatic Scope — retained)
- Tight scope reinforcement — no new features, no new modules required
- Context endpoint fix (`current_node` from active engine state)
- StreamAccumulator test coverage as a gap fill

### From Codex's Critique (Critical Corrections — NEW)
- **gardens-draft reclassification** — most impactful correction, prevents wasted effort on wrong root cause
- **Failure count correction** — 9 tests / 6 files, not 10 / 7
- **http-server cancel investigation** — separate from SSE, may be state machine issue
- **Skipped test verification** — added to DoD
- **Line number stability** — switched to approximate + test names

### From Gemini's Critique (Risk Calibration — NEW)
- **Shell completions as scope creep** — reinforced the decision to drop them
- **SSE fix depth risk** — warned that `res.end()` may mask deeper bugs. Added risk for SSE reconnection and state machine divergence.
- **Refactor risk from Codex's broader proposals** — validated the decision to defer RunManager centralization and seed-run-tracker extraction

## Key Synthesis Decisions

1. **4 clusters, not 3.** The gardens-draft content assertion is now its own cluster (C), distinct from the SSE lifecycle cluster (D). This changes the implementation phasing: Phase 2 is now a quick content fix, Phase 3 is focused purely on SSE.

2. **SSE lifecycle gets 45% of effort, not 50%.** The 5% freed by separating gardens-draft goes to the new Phase 2. This is a more honest allocation since the gardens-draft fix is trivial.

3. **http-server gets explicit investigation.** Rather than assuming it's SSE, Phase 3 includes a diagnostic task. This may reveal a context endpoint or RunManager issue that needs a different fix.

4. **No new source files required.** Codex proposed `src/server/sse.ts` and `src/server/seed-run-tracker.ts`. These remain good ideas for future sprints but are not prerequisites for green. If a shared helper emerges naturally, great — but it's not mandated.

5. **Critique feedback is the most valuable input in this round.** The three drafts largely agreed on scope. The critiques caught real diagnostic errors that would have wasted implementation effort. The gardens-draft misdiagnosis alone could have cost 15% of the sprint budget debugging the wrong layer.
