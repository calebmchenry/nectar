# Critique: NEXT Sprint Drafts

**Drafts reviewed:** NEXT-CLAUDE-DRAFT.md, NEXT-GEMINI-DRAFT.md
**Baseline:** NEXT-CODEX-DRAFT.md, docs/compliance-report.md
**Date:** 2026-03-21

---

## Claude Draft

### Strengths

1. **Comprehensive scope.** Covers all 37 compliance gaps (A1-A6, C1-C12, U1-U19) plus the 6 failing tests. No gap is left unaddressed.
2. **Root cause diagnosis is sharp.** The SSE lifecycle analysis (terminal events not calling `res.end()`) and the missing `run_error` emission are clearly identified with a before/after flow diagram. An implementer can start coding immediately from this description.
3. **Phased by priority.** Workstream A (fix tests) before Workstream B (compliance) is the correct ordering — green tests first, then extend. Within Workstream B, high-severity before low is sound.
4. **Detailed files summary.** Every file touched is listed with action and purpose. The batch table mapping gaps to files is useful for parallel work.
5. **Regression test explicitly called out.** The SSE close timing regression test (assert stream closes within 1 second) is a concrete, measurable verification step.
6. **Open questions section.** Explicitly surfaces ambiguities (A1 superset question, A2 ReadWriteLock applicability, PascalCase strategy) rather than hiding opinionated calls.

### Weaknesses

1. **Scope is almost certainly too large for one sprint.** 37 gaps + 6 test fixes across 25+ files, with 2 new test files and modifications to ~10 existing test files. The draft acknowledges "days 1-5" but does not account for the integration risk of touching nearly every module simultaneously. The Codex draft's narrower 11-gap scope is more realistic.
2. **Low-severity gaps dilute focus.** Phase 4 contains 25+ individual tasks, many of which are additive interface fields (U4-U12) that don't change runtime behavior. These compete for attention with genuinely important fixes. The Gemini draft correctly excludes these.
3. **No depth on tool repair (U14).** The task says "Add `repair_tool_call` function parameter to `generate()` / `stream()` options" — this is the interface, not the implementation. What does repair actually do? What's safe vs. unsafe? The Codex draft's 4-step pipeline with explicit boundaries (never invent required fields, never execute after failed repair) is far more actionable.
4. **SSE fix may be incomplete.** The draft focuses on `res.end()` after terminal events but doesn't discuss: What happens if the client disconnects before the terminal event? What about `res.on('close')` cleanup? The cleanup bullet exists but is underspecified.
5. **No discussion of child vs. parent session limit semantics.** Changing defaults to unlimited (C6/C7) is listed as a task, but the draft doesn't address the important question: should spawned child agents also default to unlimited? The Codex draft explicitly keeps children finite by default — a meaningful safety decision that's missing here.
6. **PascalCase event aliases (A4) add maintenance burden for low value.** Emitting events in two naming conventions is a long-term cost. The draft flags this in Open Questions but still includes it in the implementation plan.

### Gaps in Risk Analysis

- **No risk entry for unlimited defaults in production.** Changing `max_turns` from 12 to 0 (unlimited) without a safety boundary is a runaway-session risk. The risk table mentions "tests" but not production workloads.
- **No risk entry for tool parameter renames (C9/C10/C11) breaking external consumers.** If any external code or user-written pipeline references `path` instead of `file_path`, this is a breaking change. The risk table mentions test references but not external users.
- **SSE stream leak risk is underestimated.** The mitigation ("grep for all `text/event-stream`") is correct but should be a Phase 1 prerequisite, not a mitigation — if there are more SSE routes than the two mentioned, the fix is incomplete.

### Missing Edge Cases

- SSE client disconnects mid-stream (before terminal event) — cleanup path unclear.
- `run_error` emission when a node fails *with* a failure edge — should `run_error` still fire?
- `repair_tool_call` receiving `undefined` or a non-function value.
- `CheckpointSaved` emission during resume — does it fire for the restored checkpoint?
- Tool name validation on tools already registered with invalid names (migration path).

### Definition of Done Completeness

Thorough — 36 checkboxes covering every gap. However:
- No checkbox for "no test timeouts were increased" (important given SSE timeout history).
- No checkbox for compliance report update.
- Some checkboxes are type-field additions (U4-U9) that are trivially verifiable but crowd out the critical items.

---

## Gemini Draft

### Strengths

1. **Focused scope.** 10 gaps (5 High, 5 Medium) is a realistic sprint. Explicitly excludes low-severity interface-shape issues — a good prioritization call.
2. **Use cases are concrete and user-centric.** "A user runs a pipeline with an Anthropic model that returns `redacted_thinking`" is a real scenario, not an abstract spec reference.
3. **Clean phase structure.** Four phases with clear file lists and a dedicated verification phase. The 25/40/15/20 weighting is reasonable.
4. **Process group test design is specific.** "Spawn a script that spawns `sleep 60`, timeout, ensure `sleep 60` is dead" — this is a concrete, falsifiable test specification.

### Weaknesses

1. **Ignores the 6 failing tests entirely.** The draft makes no mention of the SSE stream termination failures that have persisted across sprints 025-031. This is the most urgent problem in the codebase — tests that hang and timeout. Fixing compliance gaps while the suite is red is building on unstable ground.
2. **Ignores all Attractor gaps (A1-A6).** While some are low-severity, A3 (CheckpointSaved) is Medium and is correctly included in the implementation but contradicts the "out of scope" statement that says A1-A6 are excluded. The draft's own Phase 3 implements A3, creating an internal inconsistency.
3. **U14 implementation is vague and potentially dangerous.** "Implement `repair_tool_call` utility. Catch JSON parse errors, run repair heuristics (fix trailing commas, unescaped quotes), and retry parsing." This describes the happy path but not the boundaries. What about: security implications of mutating tool arguments? What if repair changes semantics? The Codex draft's "never invent missing fields, never execute after failed repair" constraints are essential and missing here.
4. **No mention of U16 or U17.** HTTP 408/413/422 mapping and `on_retry` callback are both behavioral gaps that affect error handling correctness. These are in the same error-handling module being touched for U15 and could be addressed with minimal marginal effort.
5. **`repair_tool_call` placed in `tool-registry.ts`.** This is architecturally wrong — the tool registry is about registration, not execution-time repair. Repair belongs in the execution pipeline (client or session), as the Codex draft correctly identifies.
6. **Verification phase is too thin.** Phase 4 has only 4 test tasks for 10 gaps. Several gaps (C6/C7 defaults, C2 spawn_agent) have no explicit test tasks — they rely on "validate all changed defaults via existing test suites" which is wishful if existing tests don't cover the unlimited semantics.

### Gaps in Risk Analysis

- **Only 3 risks identified** for a 10-gap sprint. Missing:
  - Risk of unlimited defaults causing runaway sessions (the most dangerous behavioral change in the sprint).
  - Risk of `repair_tool_call` silently mutating valid payloads into invalid ones.
  - Risk of model catalog entries referencing unavailable models (minor but still a gap).
- **No security considerations section.** Tool name validation (U13) has security implications. Process group cleanup (C8) has security implications. These deserve explicit treatment.
- **Windows compatibility not addressed for C8.** The risk table says "Test explicitly on UNIX environments, fallback gracefully on non-UNIX platforms" but doesn't specify what the fallback is.

### Missing Edge Cases

- `repair_tool_call` receiving arguments that parse as valid JSON but violate the schema (not a JSON syntax issue).
- `spawn_agent` with `max_turns: -1` or non-integer values.
- Process group kill when `child.pid` is undefined (process failed to start).
- `CheckpointSaved` event payload shape — what metadata does it carry?
- `redacted_thinking.data` field when the value is `null` vs. absent vs. empty string.
- Tool name validation on empty string input.

### Definition of Done Completeness

Adequate for the scoped gaps, but:
- No checkbox for "SSE tests pass" or "full test suite passes" — only "vitest suite passes with zero regressions" which could be satisfied if those tests were already skipped.
- No checkbox for specific behavioral assertions (e.g., "a session can exceed 12 turns with default config").
- The compliance report update checkbox ("moved to IMPLEMENTED list") is good — Claude draft lacks this.

---

## Recommendations for the Final Merged Sprint

### Scope

1. **Start with the Codex draft's 11-gap scope as the baseline.** It correctly identifies the gaps that change runtime behavior (C1, C2, C6, C7, C8, U13, U14, U15, U16, U17, U18) and excludes cosmetic/additive changes.
2. **Add the 6 failing tests (SSE lifecycle) as Phase 0.** The Claude draft's diagnosis is correct and well-specified. A red test suite blocks everything. This should be the very first deliverable.
3. **Add A3 (CheckpointSaved) from the Gemini draft.** It's Medium severity, touches files already in scope (`src/engine/events.ts`, `src/engine/engine.ts`), and is low-effort.
4. **Defer all low-severity interface-shape gaps (U1-U12, U19, A1-A2, A4-A6, C3-C5, C9-C12).** These are real gaps but don't change runtime behavior. They're a clean follow-up sprint.

### Architecture Decisions to Carry Forward

- **From Codex draft:** The 4-step tool repair pipeline with explicit safety boundaries. The parent-unlimited / child-finite default split. The `src/llm/tool-repair.ts` as a shared module.
- **From Claude draft:** The SSE terminal-event flow diagram. The `closeOnTerminalEvent()` shared helper for SSE routes. The regression test specification (stream closes within 1 second).
- **From Gemini draft:** The process-tree fixture test design (`sleep 60` grandchild). The compliance report update as a DoD item.

### Risk Items to Include

Merge risk tables from all three drafts, but ensure these are explicitly present:
1. Unlimited defaults causing runaway sessions in production (not just tests).
2. Tool repair overreach mutating valid calls — require single-pass, schema-driven, fail-closed.
3. Process-group behavior on macOS vs. Linux with a real fixture, not mocked.
4. SSE route audit as a prerequisite (grep for `text/event-stream`), not a mitigation.
5. Child session default limits as an explicit design decision, not an implicit one.

### Definition of Done Gaps to Close

The final sprint should include these checkboxes that no single draft fully covers:
- [ ] No test timeout values were increased to achieve green (from Codex draft).
- [ ] `docs/compliance-report.md` updated — closed gaps moved to IMPLEMENTED (from Gemini draft).
- [ ] SSE streams close within 1 second of terminal event (from Claude draft).
- [ ] An integration test proves a session can exceed 12 turns and 10 tool rounds (from Codex draft).
- [ ] Failed repair never executes the underlying tool handler (from Codex draft).
- [ ] Spawned child agents default to finite limits unless explicitly overridden (from Codex draft).
- [ ] `run_error` event emitted for fatal node failures (from Claude draft — absent from both other drafts).

### What to Watch Out For

- The Claude draft's ambition (37 gaps) is admirable but will likely result in a half-finished sprint. Narrow scope, complete execution.
- The Gemini draft's omission of the 6 failing tests is a critical oversight. Never plan compliance work on a red suite.
- All three drafts underestimate the integration risk of changing default limits to unlimited. This needs explicit guardrails (loop detection, per-node overrides, child-finite defaults) documented in the sprint, not discovered during implementation.
