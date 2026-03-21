# Sprint 025 Merge Notes

**Date:** 2026-03-21
**Drafts merged:** NEXT-CLAUDE-DRAFT.md, NEXT-CODEX-DRAFT.md, NEXT-GEMINI-DRAFT.md
**Critiques considered:** NEXT-CODEX-CRITIQUE.md, NEXT-GEMINI-CRITIQUE.md

---

## Structural Backbone: Claude Draft

The Claude draft ("Zero Gaps") was used as the structural foundation. Its diagnosis-first methodology for test failures, phased implementation with a hard gate after Phase 1, explicit cut line, and specific Definition of Done criteria were materially stronger than the alternatives. Both critiques independently recommended using it as the base.

**Taken from Claude:**
- Phase 1 test fix methodology (instrument → reproduce → root-cause → fix) with 40% budget allocation
- Hard gate: no feature work until `npm test` is green
- All four compliance gap implementations (GAP-1 through GAP-4)
- Root-cause hypotheses for each of the 4 test failures
- Cut line ordering (GAP-4 first, then GAP-1)
- Zero new dependencies constraint
- Per-test DoD with timeout budgets and event sequence assertions

## Product Value Injection: Codex Draft

The Codex draft ("Seed-to-Execution Bridge") provided the product-facing half of the sprint. Both critiques noted that a pure tech-debt sprint halts momentum. The Codex draft's core insight — that `linked_gardens` and `linked_runs` exist in the type system but nothing writes them — identified the most important remaining product gap.

**Taken from Codex:**
- Seed activity backbone: `activity.jsonl` append-only history, `SeedActivityStore`, `SeedLifecycleService`
- Seed-aware run launch (`POST /seeds/:id/run`) with provenance tracking
- Lifecycle rules: auto-promote to `blooming`, never auto-archive to `honey`, status suggestions only
- `linked_runs` cap at 25, newest-first
- `linked_gardens` uniqueness and workspace-relative normalization
- Run manifest extension with seed metadata (`seed_id`, `seed_dir`, `launch_origin`)
- CLI parity: `nectar swarm`, `nectar seed link|unlink`
- Graceful degradation for broken links and corrupted activity lines

**Deferred from Codex to a follow-up sprint:**
- Hive List and Timeline views — the backend/API ships now; complex triage UI is better as a focused sprint
- `GET /seeds/activity` workspace-wide timeline endpoint (ships with backend but no Hive view yet)
- URL state preservation for Seedbed subview selection

## Targeted Additions from Gemini Draft

The Gemini draft ("Advanced Agent Capabilities") had significant structural weaknesses (wrong sprint number, ignored test failures, no phased gating) but contributed two specific technical ideas.

**Considered but rejected:**
- `web_search` and `web_fetch` tools — not in compliance gaps, add SSRF risk, significant scope. Both critiques flagged this.
- Levenshtein distance fallback for fuzzy matching — the Codex critique recommended it with tight bounds, but both critiques also flagged ambiguity risks. The whitespace normalization approach from Claude is simpler, covers the most common LLM failure mode (indentation mismatch), and avoids the threshold definition problem. Levenshtein can be added in a future sprint if whitespace normalization proves insufficient.
- `partial-json` or `turndown` external dependencies — rejected per the zero-dependency constraint.

**Not taken:** Sprint numbering (002), lack of test failure acknowledgment, unbounded scope, vague DoD.

## Critique-Driven Improvements

**From Codex critique:**
- Added explicit Anthropic AUDIO warn-and-skip path (Claude draft only specified DOCUMENT serialization)
- Added "the 4 previously failing tests now pass" as explicit DoD checkbox (missing from all drafts' cross-cutting sections)
- Added "compliance report regenerated showing zero open gaps" as DoD checkbox
- Added Phase 1 overrun as explicit risk with cut line invocation strategy
- Noted that `read_many_files` symlinks need explicit handling → added to architecture and tasks
- Noted fuzzy matching offset-mapping needs concrete algorithm → specified parallel character-offset index

**From Gemini critique:**
- Noted risk of building on a red suite (validated decision to gate Phase 2 on green suite)
- Added concurrency/file-locking consideration for seed state → addressed via SeedStore patch queue
- Added graceful degradation requirements for broken garden links and corrupted `activity.jsonl`
- Added `activity.jsonl` unbounded growth as a risk with pagination mitigation
- Noted missing performance assertion for fuzzy matching → added 100K line short-circuit

## Key Trade-offs

1. **Scope vs. momentum:** Combining compliance gaps + seed linkage makes this a large sprint. The cut line is aggressive: 3 of 7 phases can be dropped without losing the sprint's core value (green suite + seed bridge).

2. **Hive views deferred:** The Codex draft's List/Timeline views are high-value but high-effort UI work. Shipping the backend now and the views later avoids compressing the test fix phase.

3. **Whitespace-only fuzzy matching:** Simpler than Levenshtein but narrower. Covers the dominant failure mode (LLM indentation mismatch) without the false-positive risks of edit-distance matching.

4. **Incremental JSON scoped to shallow objects:** Both critiques flagged the parser as optimistic for its budget. Scoping to flat/shallow objects with a fallback makes it deliverable at 8% budget.
