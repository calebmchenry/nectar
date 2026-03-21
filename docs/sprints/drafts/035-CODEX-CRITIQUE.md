# Codex Critique — Sprint 035 Drafts

**Reviewed drafts:** NEXT-CLAUDE-DRAFT.md (Claude), NEXT-GEMINI-DRAFT.md (Gemini), NEXT-CODEX-DRAFT.md (Codex)
**Date:** 2026-03-21

---

## Claude Draft: "Green Suite or Bust — Fix the Four, Close the Gaps"

### Strengths

1. **Test-first hard gate is the right call.** The Phase 1 gate — "Phase 2 does not begin until `npm test` passes" — directly addresses the pattern of 10+ sprints shipping features without fixing the suite. This is the single most important structural decision in any of the three drafts.

2. **Root-cause specificity.** Each of the 4 failing tests is mapped to a distinct root cause with a concrete fix strategy. I verified the 4 failures match the live suite (`fan-in-llm`, `hive-seedbed-flow`, `http-server`, `pipeline-events`). The diagnoses are credible.

3. **Drop line is well-ordered.** The explicit priority ordering (green suite → report → behavioral fixes → type additions → cosmetic) gives a clear cut path if scope overruns. Most sprint docs lack this, and its absence is why previous sprints failed to land the green suite.

4. **Comprehensive files summary.** Every touched file is listed with action and purpose, including test files that only need verification. This makes review and execution tractable.

5. **Scope discipline on deferrals.** A4, C2, C3, L8 each have a one-line justification rooted in spec language or practical constraints. These are defensible choices.

### Weaknesses

1. **Scope is still ambitious.** 4 test fixes + 16 compliance gaps + compliance report refresh is a lot. The draft acknowledges this in the risk table ("sprint scope is still too large") but then proceeds to plan all of it. The drop line helps, but history says the full plan won't land. A more honest plan would set the "expected" scope at Phase 1 + a handful of one-liners from Phase 2, and treat the rest as stretch.

2. **Fan-in fix rationale may be wrong.** The draft says the fan-in handler should return `status: 'success'` when the selected branch failed because "the fan-in's job is selection, not judgment." This is a reasonable interpretation, but it changes the semantic contract of fan-in: downstream nodes will see a successful fan-in with a failed-branch payload in context. If any existing garden depends on the fan-in propagating failure status to trigger a failure edge, this fix breaks it. The draft's risk table mentions this but the mitigation (a single regression test) is thin.

3. **ContextLengthError recovery is underspecified.** The draft says "emit warning and continue (if possible)" and "do not implement automatic context truncation." But the Definition of Done says "ContextLengthError emits warning and continues, does not terminate." If the session can't actually continue without truncation, what does "continue" mean? This is the gap most likely to stall implementation or produce dead-letter code.

4. **C7 beta headers are hardcoded dates.** Adding `'extended-thinking-2025-04-15'` and `'max-tokens-3-5-sonnet-2025-04-14'` as literal strings bakes in version-specific API details that will rot. The Codex draft's deferral of C7 is arguably better — or at minimum the headers should come from configuration, not source code.

5. **No mention of the Codex draft's audit-first approach.** The Claude draft assumes all 20 gaps are still open and real. The Codex draft wisely starts with an audit phase to verify each gap against live code. Given that the compliance report was generated weeks ago and many sprints have landed since, some gaps may already be closed or partially addressed. Skipping the audit risks implementing changes that are already done.

### Gaps in Risk Analysis

- **No risk entry for fan-in semantic contract change on existing gardens.** The risk table discusses "edge selection behavior downstream" but doesn't address gardens that depend on fan-in propagating failure.
- **No risk for SSE force-close dropping in-flight events.** If `sse.closeAll()` fires while an event is mid-write, the client may see a truncated SSE frame. This is a real concern for the hive-seedbed integration.
- **No risk for compliance report becoming a bottleneck.** If Phase 4 discovers that supposedly-closed gaps are actually still open, the sprint scope expands unexpectedly.

### Missing Edge Cases

- What happens if `server.close()` is called while no SSE connections are active? The `closeAll()` on an empty Set should be a no-op, but worth a test.
- `pipeline_failed` dedup guard: what if `finishError()` is called from both the terminal-node path and an unrelated error path in the same tick? The draft trusts the boolean guard but doesn't test concurrent invocation.
- Unqualified condition fallback: what about keys that collide with future reserved prefixes? E.g., if someone writes `condition="steps=done"`, should that resolve to `context.steps` or the reserved `steps` namespace?

### Definition of Done Completeness

The DoD is thorough — 29 checkboxes covering build, tests, each gap, and the report. Two omissions:
- No DoD item for "no test was skipped or marked `.todo`/`.skip` to achieve green."
- No DoD item verifying that the 4 test fixes don't rely on inflated timeouts (mentioned in prose but not in the checklist — wait, it is there: "No test timeout values were increased to achieve green." Good).

---

## Gemini Draft: "Spec Convergence & Gap Closure"

### Strengths

1. **Concise and clear structure.** The draft is well-organized and easy to scan. Each phase maps directly to a spec layer (Attractor, Agent Loop, LLM Client).

2. **Addresses all 20 gaps.** Unlike the other two drafts which selectively scope, Gemini attempts to close every identified gap in one sprint.

### Weaknesses

1. **Assumes the test suite is green.** This is the critical flaw. The draft makes zero mention of the 4 failing tests. I just confirmed: 4 tests are failing right now (`fan-in-llm`, `hive-seedbed-flow`, `http-server`, `pipeline-events`). A sprint that doesn't fix or even acknowledge these failures will end with a red suite regardless of how many compliance gaps it closes. The Claude and Codex drafts both center their plans around this reality.

2. **L3 proposes destructive renames, not aliases.** "Mass rename `content_delta` -> `text_delta`, `stream_end` -> `finish`" is a breaking change. The Claude draft correctly proposes additive aliases. The Codex draft explicitly defers L3 beyond aliases. The Gemini approach would break every existing consumer of stream events and is called out in its own risk table as "High likelihood / High impact." Proposing a known-high-risk breaking change without a migration path is a serious plan defect.

3. **C2 and C3 are in scope without justification.** The draft includes C2 (native system prompt mirroring) and C3 (Gemini web tools) — both of which the Claude draft explicitly defers with good reasons (proprietary prompts, optional per spec). The Gemini draft doesn't address the practical obstacles: where do the proprietary system prompts come from? What search backend do the web tools use? These are not one-sprint items.

4. **A4 checkpoint migration is high-risk with minimal mitigation.** Changing the checkpoint location from `.nectar/cocoons/` to `{logs_root}/checkpoint.json` breaks every existing run's resume capability. The migration fallback ("check the old path if new path doesn't exist") is a start, but the draft doesn't address: what about runs in progress? What about external tooling that reads cocoon files? The Codex draft wisely defers A4 entirely.

5. **No drop line.** If the sprint runs long, what gets cut? Without a priority ordering, the executor will either rush everything (quality suffers) or arbitrarily drop items (important gaps may be skipped). Both Claude and Codex drafts have explicit prioritization.

6. **Risk table has only 2 entries.** For a sprint touching 20 compliance gaps across the engine, agent loop, and LLM client, two risks is not credible. Compare to Claude's 8 risks and Codex's 5 risks.

7. **No test strategy.** The Definition of Done says "existing automated tests pass, with new tests added" but the files summary lists zero test files. Where do the new tests go? How are they structured? The implementation phases mention no test tasks at all.

8. **Missing files.** Several files that would need modification are absent from the files summary: `src/engine/engine.ts` (for status.json changes), `src/handlers/wait-human.ts` (for CONFIRMATION), `src/server/*` (for the unaddressed failing tests).

### Gaps in Risk Analysis

- No mention of the 4 failing tests.
- No risk for C2 (obtaining proprietary system prompts — where do they come from?).
- No risk for C3 (web tools need a search/fetch backend — what service?).
- No risk for the interaction between checkpoint migration (A4) and the existing cocoon-based resume tests.
- No risk for scope overrun with all 20 gaps in one sprint.

### Missing Edge Cases

- C6 ContextLengthError: what is the recovery strategy? The draft says "gracefully continue or abort" — which one?
- A4 migration: what happens if `logs_root` doesn't exist yet at checkpoint write time?
- C3 web tools: how are they tested without a real search backend? No mock strategy mentioned.

### Definition of Done Completeness

Only 6 items for 20 gaps. Missing:
- No build/compile success criterion.
- No mention of test count preservation (no regressions).
- No per-gap verification (Claude has 17 individual gap checkboxes).
- `web_search` and `web_fetch` "fully integrated" — what does "fully" mean? Tested with mocks? With a real backend?
- "All modified LLM stream events correctly map to upstream spec nomenclature" — this is vague; which events, which names?

---

## Codex Draft: "Runtime Contract Closure"

### Strengths

1. **Audit-first methodology.** Starting with a code audit before implementing is the most mature approach of the three. It prevents wasted work on already-closed gaps and catches report drift early. This is especially valuable given the compliance report's age.

2. **Principled scoping.** The explicit distinction between "gaps that affect runtime behavior" (A3, C1, C5, C6, L1, L2, L6) and "gaps that are cosmetic" (A4, C2, C3, L5, L7, L8) is well-reasoned. The sprint focuses on truth and correctness, not shape conformance.

3. **Design decisions are explicit.** Section on "status.json becomes canonical" and "recovery beats forced shutdown" articulate architectural intent, not just task lists. This gives the executor judgment calls to make when edge cases arise.

4. **ContextLengthError recovery is the most thought-through.** The Codex draft specifies: fail the work item, emit warnings, return to `AWAITING_INPUT`. This is a concrete, testable recovery model — better than Claude's "emit warning and continue (if possible)" hand-wave.

5. **Subagent tool completions explicitly covered.** C5 full_content is extended to subagent tool calls, not just normal tool calls. Neither Claude nor Gemini mention this.

### Weaknesses

1. **Assumes the test suite is already green.** "npm test and npm run build are already green" — this is false. 4 tests are currently failing. The Codex draft's entire premise ("the repo does not need another stabilization sprint") is invalidated by the live suite state. This is a fatal assumption that must be corrected.

2. **Narrower scope may leave too many gaps open.** Only 10 of 20 gaps are in scope. Gaps L3, L4, L5, L7, C4, C7 are all deferred. While the prioritization logic is sound, closing only half the gaps means another sprint is needed. If the goal is eventual full compliance, the runway is getting long.

3. **C4 (agent_session_completed) is deferred.** This is a session lifecycle event that's arguably part of "session accounting" — the draft's own Phase 2 theme. Its exclusion is inconsistent with the stated focus on "agent session accounting."

4. **No compliance report item for L8 circuit breaker.** The Codex draft defers L8 but doesn't document the deferral rationale the way Claude does. For report consistency, every deferred gap needs a justification.

5. **`src/engine/condition-parser.ts` may not exist.** The files summary references this file, but the Claude draft only mentions `src/engine/conditions.ts`. If the parser is a separate file, fine — but if it doesn't exist, the implementation plan has a phantom file.

### Gaps in Risk Analysis

- **No risk for the false "green suite" assumption.** This is the biggest risk to the sprint and it's not in the table.
- **No risk for the codergen status.json change.** Stopping codergen from writing its own status.json could break tooling or tests that read that file.
- **No risk for retry middleware behavioral change.** Updating retry middleware to use generic `retry_after_ms` instead of special-casing `RateLimitError` could change retry timing for existing rate-limit scenarios.

### Missing Edge Cases

- What if the audit discovers that more than half the scoped gaps are already closed? Does the sprint pull in backup items, or does it end early? The draft says "do not pull in unrelated feature work" but Phase 4 allows L3 aliases as a backup item — this is slightly contradictory.
- Lifetime turn limit: what happens if `max_turns` is changed mid-session via configuration? Does the new limit apply retroactively to already-counted turns?
- Full tool output on subagent completions: what if the subagent itself truncated its output? Is `full_content` the subagent's truncated output or the raw output?

### Definition of Done Completeness

13 items — solid coverage but missing:
- No item for "no test was skipped to achieve green."
- No item for test count preservation.
- The "or explicitly removed from the report as stale findings" escape hatch on the first DoD item is good (reflects the audit-first approach) but could be abused to close gaps by relabeling rather than fixing.

---

## Recommendations for the Final Merged Sprint

### 1. Adopt the Claude draft's test-fix-first structure
The 4 failing tests are real and confirmed. Phase 1 must be: fix the 4 tests, get the suite green, hard-gate everything else behind it. This is non-negotiable. The Gemini and Codex drafts' failure to address the red suite is their biggest gap.

### 2. Incorporate the Codex draft's audit-first step
Before implementing any compliance gap closure, verify each gap against live code. Insert a quick audit task at the start of Phase 2. This prevents wasted work and catches report drift — a real risk given sprint velocity.

### 3. Use additive aliases for L3, not destructive renames
The Gemini draft's mass-rename approach is a breaking change with high blast radius. Follow the Claude/Codex approach: export both old and new names. Existing consumers keep working. Migration can happen later if desired.

### 4. Defer A4, C2, C3 (agree with Claude and Codex)
These three require external dependencies or architectural decisions that don't belong in a gap-closure sprint. A4 needs a migration strategy. C2 needs proprietary prompt access. C3 needs a search backend decision. Document the deferrals with justification.

### 5. Use the Codex draft's ContextLengthError recovery model
"Fail the work item, emit warnings, return session to AWAITING_INPUT" is concrete and testable. The Claude draft's "continue if possible" is too vague. The Gemini draft's "gracefully continue or abort" is worse. Pick the Codex model.

### 6. Keep the Claude draft's drop line
Explicit priority ordering is essential. If Phase 1 (green suite) takes the entire sprint, that's a successful sprint. The drop line should be:
1. Green suite (non-negotiable)
2. High-impact behavioral fixes (A3, C1, L1, L2)
3. Compliance report refresh
4. Remaining behavioral fixes (A1, A2, A5, C4, C5, C6, L6)
5. Type/interface additions (L3 aliases, L4, L5, L7)
6. Cosmetic items (C7 beta headers)

### 7. Scope to ~12 gaps, not 20
The Gemini draft's "all 20" is unrealistic given the test-fix prerequisite. The Codex draft's 10 is conservative but prudent. Target 12-14: the 4 test fixes + the 10 highest-impact gaps + stretch items from Phase 3.

### 8. Add a DoD item for no skipped/todo tests
All three drafts miss this. The Definition of Done should include: "No tests were `.skip`-ed, `.todo`-ed, or had timeouts inflated to achieve green."

### 9. Include test files in the Gemini-originated items
Every compliance gap needs at least one corresponding test. The merged sprint should list test files for each phase, following the Claude draft's pattern.

### 10. Reference `condition-parser.ts` vs `conditions.ts` correctly
Verify which file actually owns condition parsing and resolution. Use the correct file in the implementation plan — phantom file references waste executor time.
