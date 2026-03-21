# Sprint 029 Critique — Codex Review of Claude & Gemini Drafts

**Reviewed:** 2026-03-21
**Inputs:** NEXT-CLAUDE-DRAFT.md, NEXT-GEMINI-DRAFT.md
**Ground truth:** `npm test` run showing 6 failing files, 9 failing tests

---

## Claude Draft — "Zero Red, Zero Gaps — Green Suite, Spec Closure & Shell Completions"

### Strengths

1. **Excellent root-cause analysis.** The three-cluster breakdown (Cluster A: stop_reason assertions, Cluster B: error mapping, Cluster C: SSE lifecycle) is clear and well-supported. The table mapping test lines to expected vs. actual values is immediately actionable.
2. **Honest cut line.** Explicitly stating what can be dropped (shell completions, patient preset) while declaring Phases 1–3 as non-negotiable shows good scoping discipline. This is what the project needs after 4 consecutive sprints failed to deliver green.
3. **Risk table is thorough and calibrated.** Six risks with specific mitigations. The highest-value insight is that the 5 SSE tests may have 5 independent root causes rather than 1 shared pattern — this is the most likely way the sprint blows its budget.
4. **Phase gates.** Each phase has an explicit test command to run before proceeding. This prevents the "fixed A, broke B" cascading failure mode.
5. **Out-of-scope section is specific.** Names concrete things that are excluded (GenerateResult, StepResult, Hive UI, new HTTP endpoints). This prevents scope creep during execution.
6. **Effort allocation is realistic.** Phase 3 (SSE lifecycle) gets 30% — acknowledging it's the riskiest work. Phase 4 (patient preset) gets 5% — appropriate for a one-liner.

### Weaknesses

1. **Failure count is wrong.** Claims "10 tests fail across 7 files." Actual: **9 tests fail across 6 files.** The streaming test at `openai-compatible.test.ts:223` (`expect(end.stop_reason).toBe('tool_use')`) is NOT currently failing — it either passes or is skipped due to the `canListen` guard. This inflates the apparent scope and may lead to chasing a phantom bug.
2. **gardens-draft failure is misdiagnosed.** The draft attributes `gardens-draft.test.ts` to SSE lifecycle (stream not closing). The actual failure is on **line 80**: `expect(payload).toContain('digraph Drafted')` — the mock LLM response contains `digraph {`, not `digraph Drafted`. The SSE stream IS closing (the test receives `draft_complete`). This is an **assertion content mismatch**, not a timeout. Fixing `res.end()` won't fix this test.
3. **Shell completions are scope creep.** The sprint's thesis is "fix what's broken, close the last gap." Adding a new feature — even a small one — contradicts the narrative. The cut line acknowledges this can be dropped, but including it invites distraction. The previous 4 sprints failed to go green; this one should be ruthlessly narrow.
4. **No mention of `http-server` cancel test root cause.** The cancel test at `http-server.test.ts:242` fails with an assertion error, not a timeout. Lumping it with the SSE timeout cluster may lead to the wrong fix. The actual root cause needs investigation — it may be a state machine issue in run-manager, not an SSE lifecycle issue.
5. **Line numbers may drift.** The draft pins specific line numbers (80, 134, 223, 288, 316) as the fix targets. If any intermediate commit or rebase shifts these, the executor will waste time reconciling. The test names are more stable references.

### Gaps in Risk Analysis

- **No risk for the gardens-draft misdiagnosis.** If the executor follows the plan (add `res.end()` to the draft SSE endpoint), the test will still fail because the real issue is the assertion on `digraph Drafted`. This would block Phase 2's gate.
- **No risk for skipped tests.** The streaming test at line 223 uses `canListen` which depends on loopback port availability. If CI can't bind a port, the test is skipped silently. This means the "legacy assertion" may never actually fail — but it's also never tested.
- **No fallback if SSE fixes require architectural changes.** The risk table says "fix the minimum and document debt," but there's no concrete plan for what "minimum" means if the event bus wiring is fundamentally wrong.

### Missing Edge Cases

- What happens if a client reconnects to an SSE endpoint mid-stream? Does replay work correctly with the new `res.end()` logic?
- The patient preset change affects retry timing for any existing pipeline using `patient`. Should there be a migration note?

### Definition of Done Completeness

The DoD is comprehensive with 16 checkboxes covering build, test, compliance, and feature verification. However:
- Missing: verification that the `gardens-draft` fix addresses the actual assertion failure (content mismatch), not just the timeout.
- Missing: verification that no tests were skipped to achieve green (a test that's skipped isn't the same as a test that passes).

---

## Gemini Draft — "Green Suite & Compliance Fixes"

### Strengths

1. **Concise and focused.** At ~95 lines vs Claude's ~247, this is lean. For a sprint that's fundamentally about fixing 9 tests and changing one constant, brevity is a virtue.
2. **StreamAccumulator coverage is a good add.** New test coverage for an untested module is higher-value work than shell completions. If this module has bugs, they'll surface in future sprints when streaming features are built on top of it.
3. **Context endpoint fix.** Identifies a real issue (`current_node` not populated in `GET /pipelines/:id/context`) that the Claude draft omits entirely. If this is causing the `http-server` cancel test to fail, this is critical.

### Weaknesses

1. **Vague on the SSE fixes.** Phase 3 gets 65% of effort but only 4 bullet points of guidance. No specific terminal events are named, no specific files beyond `pipelines.ts` and `gardens.ts` are listed, and no specific test commands are given as gates. The executor will need to do significant discovery work that should have been done during planning.
2. **gardens-draft failure is also misdiagnosed.** Same issue as the Claude draft — attributes it to SSE lifecycle. The real failure is `expect(payload).toContain('digraph Drafted')` content mismatch.
3. **No root-cause analysis for the OpenAI-compatible failures.** States what to change but not why the current values are wrong. Without understanding that these tests predate the unified naming convention, an executor might question whether the adapter or the tests are correct.
4. **Missing 4 of the 9 failing tests.** The draft lists 5 integration tests but doesn't account for the 4 OpenAI-compatible failures with sufficient specificity. No line numbers, no before/after values.
5. **Risk section is thin.** Two risks, both at a high level. No risk assessment for: the SSE fixes being deeper than expected, the context endpoint change breaking other tests, or the StreamAccumulator tests revealing bugs that expand scope.
6. **No cut line.** If the sprint runs long, what gets dropped? StreamAccumulator tests? Context endpoint? Without a priority ordering, the executor has to make scoping decisions that should have been made during planning.
7. **Files summary is incomplete.** Only 5 files listed. Missing: `src/server/routes/events.ts`, `src/server/workspace-event-bus.ts`, `src/server/run-manager.ts`, `test/engine/retry.test.ts`, and any test files that need assertion updates.
8. **Definition of Done is missing key items.** No checkbox for: no timeout increases, compliance report gaps empty, patient preset test passing, or build succeeding. Only 7 items vs Claude's 16.

### Gaps in Risk Analysis

- **StreamAccumulator tests could reveal bugs.** If `StreamAccumulator` has issues, fixing them could cascade into streaming behavior changes. This should be called out as a risk with a mitigation (e.g., "if bugs are found, file them for a future sprint rather than fixing in-line").
- **Context endpoint change could break other tests.** Modifying what `GET /pipelines/:id/context` returns may affect other integration tests that assert on its response shape.
- **No risk for the 65% effort allocation.** If SSE lifecycle is 65% of the sprint and the root causes are deeper than expected, the sprint is toast. No mitigation offered.

### Missing Edge Cases

- Same as Claude: SSE reconnection, patient preset migration impact.
- Additionally: what if `StreamAccumulator` tests expose that `push()` doesn't handle all event types? Is that in scope or out?

### Definition of Done Completeness

Significantly underspecified:
- No "zero timeout increases" clause — this was the loophole in previous sprints.
- No compliance report verification.
- No build step.
- `http-server.test.ts` DoD references `current_node` but doesn't verify the cancel flow passes.
- No assertion that ALL tests pass (just the named ones).

---

## Recommendations for the Final Merged Sprint

### 1. Fix the gardens-draft diagnosis
Both drafts misidentify this as an SSE timeout. The test receives all events successfully — the stream closes fine. The failure is `expect(payload).toContain('digraph Drafted')` on line 80. The mock LLM returns a generic `digraph { ... }` without the word "Drafted." Either the mock response needs to include "Drafted" in the graph name, or the assertion needs to match what the mock actually returns. Investigate this FIRST — it may be a trivial test assertion fix, not an SSE infrastructure problem.

### 2. Adopt Claude's structure with Gemini's scope restraint
Use Claude's phased approach with explicit gates, root-cause analysis, and risk table. But drop shell completions — agree with Gemini that no new features belong in this sprint. The StreamAccumulator coverage from Gemini is a better use of that effort since it strengthens the foundation rather than adding surface area.

### 3. Investigate `http-server` cancel test separately
Neither draft has a clear root cause for this test. Gemini's `current_node` theory is plausible but unverified. Before writing the merged sprint, run `npx vitest test/integration/http-server.test.ts` with verbose output and trace the actual assertion failure. Don't assume it's SSE.

### 4. Correct the failure count and classification
Actual failures: 9 tests across 6 files. Classification:
- **4 assertion fixes** in `openai-compatible.test.ts` (stop_reason + error class)
- **1 content assertion fix** in `gardens-draft.test.ts` (mock response mismatch)
- **4 SSE lifecycle / state machine issues** across `hive-run-flow`, `http-resume`, `http-server`, `seed-run-linkage`

### 5. Merge the best of both DoDs
Start with Claude's 16-item DoD. Add from Gemini:
- `StreamAccumulator` has dedicated test coverage
- `current_node` is correctly populated in context endpoint (if investigation confirms this is needed)

Add missing items from both:
- No tests were skipped to achieve green (`--reporter=verbose` shows 0 skipped in affected files)
- The `gardens-draft` fix addresses the content assertion, not just stream lifecycle

### 6. Keep the cut line
Adopt Claude's cut-line approach. Priority order for cuts:
1. StreamAccumulator tests (new coverage, not fixing a failure)
2. Patient retry preset (one-liner, can ride any commit)
3. Context endpoint fix (only if confirmed as root cause)

**Never cut:** OpenAI-compatible assertion fixes, gardens-draft content fix, SSE lifecycle fixes. These are the 9 failures. Green suite is the only goal that matters.
