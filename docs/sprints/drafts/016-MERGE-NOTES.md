# Sprint 016 Merge Notes

**Date:** 2026-03-20
**Inputs:** NEXT-CLAUDE-DRAFT.md, NEXT-CODEX-DRAFT.md, NEXT-GEMINI-DRAFT.md, NEXT-CLAUDE-CRITIQUE.md

---

## Merge Decision: Claude Draft as Base

The final sprint uses the **Claude draft** as its base with minimal modifications. Here's what was taken from each draft and why.

---

## From Claude Draft (primary source — ~95% of final)

**Taken:**
- Entire document structure, scope, architecture, phases, files summary, DoD, and risks
- LLM-client-only focus (L1-L5, L7-L8), deliberately excluding L6 and all engine gaps
- Middleware architecture: `Middleware` interface with optional `generate`/`stream` methods, chain composition, retry-as-middleware conversion
- Model catalog design: `ModelInfo` interface, static data, lookup functions, logical selectors, "advisory not a gate" principle
- RateLimitInfo with shared `parseRateLimitHeaders()` utility and per-provider prefixes
- Cut-line prioritization: drop L2 (default client) first, never cut L1 or L3
- 6-phase implementation plan with effort percentages
- 7 risks with likelihood/impact/mitigation columns
- Comprehensive DoD with per-gap acceptance criteria and 50+ test case expectation

**Why:** The Claude draft had the strongest combination of scope discipline, architectural depth, risk analysis, and definition of done. The critique scored it "Excellent" across architecture, risk, and DoD quality. Its focused scope (one subsystem per sprint) aligns with the project's cadence and Sprint 015's explicit recommendation.

---

## From Codex Draft (reserved for Sprint 017 blueprint)

**Taken into Sprint 016:**
- Nothing directly — the Codex draft focuses entirely on engine gaps (A1, A2, A3) which are out of scope for Sprint 016

**Taken as Sprint 017 recommendation in closing section:**
- Manager loop architecture: telemetry namespace (`stack.child.*`), filesystem control plane (`manager-steer.json`), atomic consumption semantics, per-tuple steer deduplication
- Restart semantics: reuse `interrupted` status with successor metadata, manifest linkage fields (`restart_of`, `restarted_to`), context filtering rules
- Tool hook contract: stdin JSON + `NECTAR_*` env vars + exit-code gating + per-call artifact persistence
- The final sprint's "Recommended next sprint (017)" section explicitly credits the Codex draft as the architectural blueprint

**Why deferred:** The critique correctly identified that bundling engine work with LLM client work creates too much surface area. The Codex draft's architecture is excellent — it just belongs in a separate sprint. The compliance report ranks L1 and L3 (LLM client) as the two highest-priority gaps overall, ahead of A1 (the highest engine gap).

---

## From Gemini Draft

**Taken into Sprint 016:**
- Nothing directly

**Acknowledged but deferred:**
- L6 (OpenAI-compatible adapter) — Gemini was the only draft to include this. The final sprint acknowledges its value but defers it, adopting the Claude draft's rationale: L6 is a new protocol with significant edge cases (Chat Completions streaming differs from Responses API, tool call format translation, provider-specific quirks across Ollama/vLLM/Together/Groq). It pairs better with Sprint 017 or stands alone as Sprint 018.

**Why not used as base:** The critique identified critical weaknesses:
1. **Scope too broad** — 9 gaps across 2 subsystems (LLM client + engine) with less than half the specification detail of either the Claude or Codex drafts
2. **Architecture underspecified** — No middleware interface definition, no chain composition semantics, no manager loop control plane design, no streaming middleware pattern
3. **No test files listed** in the files summary
4. **DoD insufficient** — 6 items for 9 gaps, several gaps with no specific acceptance criteria
5. **Risk analysis shallow** — 3 risks for 9 gaps vs. Claude's 7 risks for 7 gaps

---

## From Claude Critique (synthesis guidance)

**Applied:**
- Scope recommendation: "Choose one subsystem, not both" → adopted, LLM client wins on severity ranking
- Architecture recommendation: "Use Claude's LLM design + Codex's engine design" → Claude for Sprint 016, Codex reserved for Sprint 017
- L6 handling: "Adopt L6 as its own sprint or pair with A1" → deferred, noted in Sprint 017 recommendation
- DoD strengthening: per-gap criteria, build/regression gates, test count expectation, backward compatibility assertions → all present in final
- Risk additions: streaming middleware complexity, retry behavioral regression, provider profile migration, default client global state → all present in final

**Not applied:**
- The critique suggested Codex's engine draft needs a cut-line, restart chain depth limit, child graph recursion depth limit, and explicit atomic file operation mechanism. These are valid but belong in the Sprint 017 planning conversation, not in Sprint 016's merge notes.

---

## Modifications to Claude Draft

The final sprint is nearly identical to the Claude draft. The only substantive changes:

1. **Added "What about engine gaps?" paragraph** in the Overview — explains the deferral rationale and credits the Codex draft, since the original Claude draft didn't acknowledge the Codex draft's existence.
2. **Updated Sprint 017 recommendation** — changed from "A1 + L6" to "A1 + A2 + A3" to reflect the Codex draft's argument that all three engine gaps share integration surfaces and belong together. L6 noted as Sprint 017 or 018 candidate.

---

## Summary Table

| Source | What was used | Where |
|--------|--------------|-------|
| Claude Draft | ~95% of final document | Sprint 016 base |
| Codex Draft | Sprint 017 architectural blueprint | Sprint 016 closing recommendation |
| Gemini Draft | L6 gap acknowledged | Sprint 016 deferral note + Sprint 017/018 candidate |
| Claude Critique | Scope, architecture, and DoD guidance | Merge decision framework |
