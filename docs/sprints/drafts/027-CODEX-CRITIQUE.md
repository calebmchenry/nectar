# Sprint 027 Draft Critique — Codex Review

**Reviewer:** Codex (Claude)
**Date:** 2026-03-21
**Drafts reviewed:** NEXT-CLAUDE-DRAFT.md, NEXT-GEMINI-DRAFT.md

---

## Claude Draft — "Green Suite, Engine Contract, and Server API Completeness"

### Strengths

1. **Test-first phasing is the only credible strategy left.** Five consecutive sprints (022–026) have failed to deliver a green suite. The Claude draft makes Phase 1 a hard gate at 40% of budget and refuses to start feature work until `npm test` reports zero failures. This is the single most important decision in either draft.

2. **Root-cause decomposition is specific and testable.** The draft identifies three concrete root causes — assertion mismatches (2 tests), SSE lifecycle bugs (3 timeout tests) — and proposes a diagnosis-first methodology (instrument → reproduce → root-cause → fix) rather than the timeout-bump-and-hope pattern that failed in prior sprints. Critically, it acknowledges `http-resume` as a new regression from Sprint 026, not a carried-over failure.

3. **Cut line is well-prioritized and honest.** Gaps 4–5 (diagnostic model) are cosmetic. Gap 3 (should_retry predicate) is aggressive-but-not-broken behavior. The draft is explicit that cutting these is acceptable while test fixes, jitter/presets (1–2), QueueInterviewer (6), tool.output (7), and HTTP endpoints (8) are non-negotiable. This is the right ordering.

4. **Architecture section is refreshingly minimal.** "No new modules or abstractions. This sprint modifies existing files to fix bugs and fill API gaps." After multiple sprints of scope creep, this restraint is valuable. Every change is described as a surgical modification to an existing file.

5. **HTTP endpoint spec is complete and correct.** Cancel/checkpoint/context are the last three missing endpoints for Hive API completeness. The 409 for already-completed cancel, the checkpoint-from-cocoon read path, and the active-vs-completed context resolution are all specified with correct edge cases.

6. **Risk table includes the meta-risk.** "Phase 1 debugging consumes the entire sprint" at Medium likelihood is the most honest entry in either draft. The mitigation — "this is an acceptable outcome" — is correct. The green suite is worth more than any compliance gap.

7. **Definition of Done is specific and verifiable.** Per-test pass criteria, exact preset values (initial_delay_ms=500, multiplier=2.0), specific context key names (`tool.output` not `{node_id}.stdout`), HTTP status codes (200 for active cancel, 409 for completed) — all checkable without ambiguity.

### Weaknesses

1. **`fan-in-llm` timeout is listed as root cause B but gets a separate task with a different hypothesis.** The draft groups it with SSE lifecycle bugs (res.end/event bus wiring) in the analysis, but the task says "Verify the simulation client returns valid structured output for the fan-in evaluation." This is a different theory — a mock/simulation problem vs. a server lifecycle problem. If the wrong hypothesis is pursued first, it wastes Phase 1 budget. The draft should either unify the hypothesis or explicitly note that `fan-in-llm` may have a distinct root cause.

2. **No mention of the `http-resume` regression root cause.** The validation report flags this as a *new* failure in Sprint 026 (it passed in Sprint 025). The draft lists it with the other timeout failures but doesn't hypothesize what Sprint 026 changed to break it. Since Sprint 026 modified `engine.ts` retry/failure routing and SSE route handlers, the regression could be in the cancel/resume flow that was touched. This deserves its own root-cause hypothesis.

3. **Phase 2 `shouldRetry` requires plumbing that crosses handler boundaries.** Adding `error_category` to `NodeOutcome` and populating it from `ToolHandler` and `CodergenHandler` means touching the handler → engine interface. The draft correctly makes `error_category` optional for backwards compatibility, but doesn't address how handlers that shell out via `execa` (ToolHandler) will classify errors — `execa` errors have exit codes, not HTTP status codes. The classification logic for non-LLM tools needs a brief design.

4. **Phase 5 effort estimate (20%) may be optimistic for three new endpoints.** `POST /pipelines/:id/cancel` requires coordinating with the engine's AbortController and waiting for graceful shutdown. `GET /pipelines/:id/context` needs to handle both active (live engine state) and completed (checkpoint) runs. If RunManager doesn't already expose these primitives, the plumbing could be significant. The risk table covers the race condition but not the implementation complexity.

5. **No explicit regression-prevention strategy for the SSE fixes.** The draft fixes SSE lifecycle bugs across `pipelines.ts`, `gardens.ts`, `seeds.ts`, and `events.ts`. These are the same files that Sprint 026 touched and introduced a regression in (`http-resume`). There should be a task to add an SSE lifecycle test helper or assertion pattern that prevents future SSE routes from omitting `res.end()`.

### Gaps in Risk Analysis

- **Changing `tool.output` key may break condition expressions in existing gardens.** The draft acknowledges this in the risk table ("Grep for all references to the old key pattern") but doesn't mention built-in gardens in `.nectar/gardens/` that may use conditions referencing `{node_id}.stdout`. If any shipped garden uses this pattern, the fix creates a silent regression.
- **No risk entry for `fan-in-llm` having a fundamentally different root cause.** If it's not an SSE lifecycle bug but a simulation/mock problem, the fix approach is entirely different and could consume disproportionate Phase 1 time.
- **Cancel endpoint interaction with checkpoint-in-progress.** The draft says "Engine already handles SIGINT gracefully — cancel is the same signal delivered via HTTP." But SIGINT during a checkpoint write could produce a corrupted checkpoint. The mitigation should note whether checkpoint writes are atomic (write-to-temp + rename) or whether this needs to be added.

### Missing Edge Cases

- **`GET /pipelines/:id/context` for a run that was cancelled before any node completed.** The context store would be empty or contain only initialization keys. The endpoint should still return 200 with an empty/minimal context, not 404.
- **`POST /pipelines/:id/cancel` called twice in quick succession.** First call starts graceful shutdown; second call arrives before shutdown completes. Should the second call return 200 (idempotent) or 409 (already cancelling)?
- **QueueInterviewer returning SKIPPED when the pipeline expects a specific label.** The draft changes the behavior from throw → SKIPPED, but if the pipeline has edges that only match specific labels (not SKIPPED), the engine will need to handle SKIPPED as a fallback/default edge case. Is this already covered by the edge selector?

### Definition of Done Completeness

Strong overall. Missing:
- No explicit criterion for the `http-resume` regression being fixed (it's a new failure, distinct from the carried-over 4)
- No criterion for "zero new test failures introduced" as a regression gate
- No criterion for `fan-in-llm` specifically (it appears in Phase 1 tasks but not in the DoD list — the DoD mentions it at line 261 but it could easily be overlooked)
- `npm run build` is at the end but should arguably be a Phase 1 gate alongside `npm test`

---

## Gemini Draft — "Spec Compliance Polish — Resilience & Observability"

### Strengths

1. **Correct identification of the shared engine retry gaps.** Gaps 1–3 (jitter, presets, should_retry) and Gap 7 (tool.output context key) are correctly prioritized, matching the Claude draft. The fix descriptions for `computeBackoff` and `RETRY_PRESETS` are accurate.

2. **Ambitious scope for LLM layer compliance.** Phases 3–4 tackle Gaps 26–31 (FinishReason, Response completeness) and Gaps 41–47 (error classification, Retry-After). These are real compliance gaps that will eventually need a sprint. The draft correctly identifies that all three adapters need the same treatment.

3. **Session lifecycle events are the right next step.** Gap 9 (missing session events) is one of the largest single compliance gaps. The draft correctly lists all 10+ missing events and proposes adding them at lifecycle boundaries in `session.ts`.

4. **Retry-After max_delay enforcement is a real bug.** Gap 43 — `Math.max(retryAfterMs, computed)` honoring the longer value instead of refusing to retry — is a correctness issue the Claude draft doesn't address. This is a genuine catch.

### Weaknesses

1. **Completely ignores the test failures.** The validation report shows 5 test failures across 5 consecutive sprints. This draft does not mention them — not in scope, not in out-of-scope, not in risks. This is the draft's most critical flaw, identical to the Gemini draft weakness identified in the Sprint 025 critique. Shipping features on a red suite is the exact pattern that has failed for 5 sprints. The fact that this weakness is being repeated verbatim from the previous critique suggests the drafting process is not learning from feedback.

2. **Scope is far too wide for one sprint.** The draft proposes 4 phases spanning 3 distinct spec areas: engine retry (attractor), session events (coding-agent-loop), response model (unified-llm), and error classification (unified-llm). Each of Phases 3 and 4 is allocated 30% of budget and touches all three LLM adapters plus core type definitions. The Claude draft allocates 100% of its budget to attractor-spec gaps plus test fixes and still includes a cut line. This draft has no buffer.

3. **Phase 2 (session lifecycle events) is larger than it appears.** Defining 10+ new event types, injecting emission at ~8 lifecycle boundaries in `session.ts`, and testing event ordering across async code paths is not 20% of a sprint. The Claude draft's Codex counterpart (NEXT-CODEX-DRAFT.md) allocates 35% to the same scope and calls it "the biggest coherent slice."

4. **Phase 3 convenience accessors risk breaking serialization.** Adding `.text()`, `.tool_calls`, `.reasoning` to `GenerateResponse` transforms it from a plain interface to a class or rich object. The risk table mentions `toJSON` but doesn't address that `GenerateResponse` is currently serialized in checkpoints, event payloads, and test fixtures. Any serialization change ripples widely.

5. **Phase 4 error classification touches all 3 adapters simultaneously.** Updating `classifyError()` in OpenAI, Anthropic, and Gemini adapters for 6+ HTTP status codes each is tedious but risky — each adapter has different response formats and edge cases. One mapping error could route retryable errors to non-retryable paths (or vice versa) in production. The draft proposes "exhaustive unit tests" but doesn't specify what those tests look like.

6. **No phased gating.** All 4 phases are independent with no gates. If Phase 3 overruns (likely given its scope), Phases 1–2 are already done but Phase 4 may be incomplete, leaving error classification half-finished across adapters — a worse state than the current one.

7. **Definition of Done is underspecified.** "All LLM adapters map 401, 403, 404, 413, 422, 429, and 500+ to the correct unified LLMError subclasses" is a single checkbox covering ~21 individual mappings across 3 adapters. Compare to the Claude draft's per-preset, per-status-code, per-endpoint criteria. The Gemini DoD has 7 items; the Claude DoD has 25+.

8. **Gap 8 (HTTP endpoints) is out of scope without justification.** The draft says "HTTP API endpoints (Gap 8)" are out of scope, but Gap 8 is the Hive's cancel/checkpoint/context endpoints — the last missing piece for server API completeness. The Hive's cancel button is a dead feature without it. No rationale is given for deferring it while taking on the much larger unified-LLM work.

### Gaps in Risk Analysis

- **No risk for the 5 existing test failures.** This is the single biggest project risk and it is entirely absent.
- **No risk for Phase 3/4 scope overrun.** Two 30%-budget phases touching all three adapters plus core types is the definition of scope risk.
- **No risk for session event emission breaking existing SSE consumers.** If the Hive or CLI renderer receives unexpected event types and doesn't handle them gracefully, the new events could break existing functionality.
- **No risk for `FinishReason` normalization affecting downstream logic.** Code that currently checks `stop_reason === 'end_turn'` (Anthropic-specific) will silently break when the value changes to `'stop'`. This is a non-trivial migration.
- **Retry-After enforcement change could cause unexpected failures.** If a provider consistently returns `Retry-After` values above `max_delay`, the new behavior (throw instead of retry) would turn recoverable errors into hard failures. The risk table should assess how common this is.

### Missing Edge Cases

- **Session event ordering under concurrent tool execution.** When `parallel_tool_execution` is true, multiple tool calls execute simultaneously. The ordering of `TOOL_CALL_OUTPUT_DELTA` events across concurrent tools needs a defined contract.
- **`FinishReason` normalization for unknown provider reasons.** What happens when a provider returns a stop reason not in the mapping? The draft doesn't specify a fallback (presumably `'other'`).
- **Error classification for non-HTTP errors.** `classifyError()` focuses on HTTP status codes, but network timeouts, DNS failures, and TLS errors also need classification. These produce different error shapes than HTTP responses.
- **`Message.system()` factory method conflicting with system message extraction.** The Anthropic adapter extracts system messages from the message array. Adding factory methods that construct system messages could interact with this extraction logic.

### Definition of Done Completeness

Incomplete:
- No `npm run build` success criterion
- No regression criterion (existing tests continue to pass)
- No mention of the 5 existing test failures
- No compliance report update criterion
- Individual adapter mapping correctness is a single checkbox instead of per-adapter criteria
- No criterion for session event ordering (just "emitted correctly")
- No criterion for `tool.output` context key being used by downstream consumers (conditions, templates)

---

## Recommendations for the Final Merged Sprint

### 1. Fix the test suite first — hard gate, non-negotiable

Adopt the Claude draft's Phase 1 wholesale: diagnosis-first protocol, 40% budget, zero-failures gate before any feature work. This is the sixth consecutive sprint where test fixes are needed. The Gemini draft's complete omission of test failures is disqualifying — it repeats the exact weakness identified in the Sprint 025 critique, demonstrating that the drafting process is not incorporating prior feedback.

### 2. Use the Claude draft as the structural backbone

The Claude draft's phasing, cut line, risk analysis, and Definition of Done are materially stronger. Use it as the base document. Its scope (attractor gaps + server API + test fixes) is coherent, bounded, and focused on a single spec area plus the overdue test debt.

### 3. Adopt the Gemini draft's Retry-After max_delay fix (Gap 43)

The Claude draft fixes engine retry jitter/presets/should_retry (Gaps 1–3) but misses Gap 43 — `src/llm/retry.ts` using `Math.max(retryAfterMs, computed)` instead of refusing to retry when `Retry-After` exceeds `max_delay`. This is a one-function fix in the LLM retry middleware that closes a real correctness bug. Add it to Phase 2 alongside the engine retry work.

### 4. Defer session lifecycle events (Gap 9) and unified-LLM work (Gaps 26–50)

Both are legitimately important but too large to bundle with test fixes and engine corrections. The Codex draft (NEXT-CODEX-DRAFT.md) already proposes a focused sprint for the coding-agent-loop contract (Gaps 9–25). The unified-LLM gaps (26–50) deserve their own sprint as the Claude draft's out-of-scope section correctly identifies. Trying to do both in one sprint, as the Gemini draft proposes, is how sprints 022–026 got overloaded.

### 5. Add an explicit hypothesis for the `http-resume` regression

Sprint 026 introduced this failure. The merged sprint should include a specific task: "Bisect `http-resume` regression against Sprint 026 changes. Check whether `resolveFailureTarget()` or SSE route handler modifications broke the cancel/resume flow." This is the only *new* failure and likely has a simpler root cause than the carried-over timeout bugs.

### 6. Specify tool handler error classification for non-LLM tools

The Claude draft's `shouldRetry` predicate classifies errors by HTTP status code, which works for `CodergenHandler` (LLM calls) but not for `ToolHandler` (shell commands via `execa`). The merged sprint should define: shell exit code 1 → not retryable (command failed), exit code 137/143 → not retryable (killed), timeout → retryable, other non-zero → retryable (default). This is 5 lines of code but closes a design gap.

### 7. Preserve the Claude draft's cut line with one addition

Original cut line (in order): Gap 4–5 (diagnostics) → Gap 3 (should_retry). Add Gap 43 (Retry-After max_delay) between Gaps 1–2 and Gap 3, since it's a small fix. If budget is exhausted after Phase 1, the minimum viable sprint is: green suite + retry jitter/presets (Gaps 1–2) + QueueInterviewer (Gap 6) + tool.output (Gap 7) + HTTP endpoints (Gap 8).

### 8. Strengthen the Definition of Done

Merge the best of both drafts and add missing items:
- `npm run build` succeeds with zero TypeScript errors (Claude)
- `npm test` passes with zero failures on clean checkout (Claude)
- The 5 previously failing tests (including `http-resume` regression) now pass (missing from both)
- Zero new test failures introduced (missing from both)
- Per-test pass criteria with specific assertions (Claude — adopt all 25+ items)
- `fan-in-llm` explicitly listed as a DoD item (easy to overlook in Claude draft)
- Engine retry tests verify non-deterministic jitter delays within bounds (both)
- If Gap 43 is included: Retry-After exceeding max_delay throws instead of retrying (Gemini)
