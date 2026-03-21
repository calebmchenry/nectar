# Sprint 035: Green Suite or Bust — Fix the Four, Close the Contracts

## Overview

**Goal:** Make `npm test` pass with zero failures and close the highest-impact remaining compliance gaps that affect engine decisions, run artifacts, and AI session reliability. After this sprint: the CI suite is green, condition expressions follow spec context-lookup behavior, per-node `status.json` files tell the whole truth, agent sessions enforce lifetime turn limits, tool completion events carry full payloads, context-window failures degrade cleanly, and provider retry/content-filter semantics are correct.

**Why this sprint, why now:**

1. **The test suite has been red for 10+ consecutive sprints.** Sprints 025 through 034 all listed "green suite" as a goal. All failed. The common failure mode: mixing test fixes with large feature work, running out of scope, and shipping the feature changes without landing the test fixes. This sprint breaks the cycle by making the green suite the *only* hard gate — everything else is subordinate.

2. **The 4 failing tests have known, distinct root causes.** They are not entangled: fan-in handler propagates branch failure status (bug), server shutdown doesn't force-close SSE connections (race), run-manager doesn't track current_node until engine attaches (timing), and engine never emits `pipeline_failed` on terminal-node failure (missing code path). Each fix is surgical.

3. **The remaining compliance gaps are not equal.** A3, C1, C5, C6, L1, L2, and L6 change actual runtime behavior or postmortem quality. A4, C2, C3, L5, L7, and L8 are cosmetic or require external dependencies. This sprint focuses on contracts that affect truth, not shape conformance.

4. **INTENT.md §5.1 is explicit: "An agent can read the three NLSpec documents, compare them against the implementation, and find zero unimplemented features."** Every gap that stays open is a violation of the project's definition of done.

5. **The compliance report has drifted from the live code.** Some listed gaps may already be partially or fully closed. An audit-first approach prevents wasted work on stale items.

**Scope:** Fix 4 failing tests (hard gate). Then audit and close gaps A1, A2, A3, A5, C1, C4, C5, C6, L1, L2, L6. Update compliance report.

**Out of scope:**
- A4 (checkpoint path migration) — requires cocoon/workspace migration strategy; data content is equivalent
- C2 (native system prompt mirroring) — requires proprietary prompts from three providers; license unclear
- C3 (Gemini web_search/web_fetch) — optional per spec ("optionally include"), needs search backend decision
- C7 (Anthropic beta headers) — hardcoded date-versioned strings that rot; better as configuration
- L3 (stream event renames) — additive aliases only as stretch goal, no destructive renames
- L4 (module-level stream()) — API surface expansion, no behavioral impact
- L5 (ImageData detail), L7 (GenerateRequest metadata) — interface shape, no behavioral impact
- L8 (circuit breaker) — spec lists as use case, not requirement
- New features, UI work, CLI commands, or packaging changes

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures, zero timeouts, no inflated timeout values.

2. **Fan-in completes when the selected branch succeeded.** A prompted fan-in pipeline where the LLM selects a successful branch completes the run. The fan-in handler's job is to *select*, not to re-judge branch outcomes — success/failure routing belongs to the graph's edge conditions.

3. **Server shuts down promptly.** `server.close()` terminates all SSE connections, aborts running engines, and resolves within 5 seconds. No afterEach hook timeouts.

4. **Live run state is truthful.** `GET /pipelines/:id` during an active run returns `current_node` reflecting the node currently executing, never `undefined` while a node is in progress.

5. **Failed pipelines emit terminal events.** A pipeline that terminates in failure emits `pipeline_failed` exactly once. The event stream, REST status, and context all agree on the terminal state.

6. **Unqualified condition keys resolve from context.** `condition="my_flag=true"` works — it looks up `context.my_flag` as a fallback when the key has no known root prefix.

7. **Node status artifacts are actually useful.** After any node completes, `status.json` contains the fields the spec promises: outcome, preferred label, suggested next IDs, context updates, and a human-readable note.

8. **Long-lived sessions honor lifetime limits.** A `codergen` session with one `submit()` call and several `followUp()` calls hits `max_turns` exactly once across the lifetime of the session. The counter does not silently reset per work item.

9. **Tool-call audits are trustworthy.** Every `agent_tool_call_completed` event includes the full tool output that the agent session actually saw, not just a preview. Event consumers, transcripts, and test fixtures all agree on the same payload.

10. **Context overflow is recoverable.** When a provider raises `ContextLengthError`, the active work item fails with warning events, but the session remains in a recoverable state so the caller can retry with a shorter prompt or a new summarization strategy.

11. **Provider retry/error semantics are correct.** A dropped stream retries if no content has been yielded yet. An Anthropic safety/content block surfaces as `ContentFilterError`. Any retryable provider error can carry `retry_after_ms` directly.

---

## Architecture

### Principle: Fix First, Then Audit, Then Extend

This sprint inverts the typical pattern. Previous sprints added features then tried to fix tests at the end. This sprint fixes tests first (Phase 1 is a hard gate), audits the compliance report against live code (Phase 2 start), then makes targeted compliance changes that are individually small and independently testable.

### Design Decisions

**1. `status.json` becomes the canonical per-node outcome artifact.**

The engine owns one spec-shaped `status.json` writer. Handlers return a richer `NodeOutcome` instead of hand-rolling their own node-status payloads. Handler-specific extras live in separate artifacts, but `status.json` is consistent across node types. `codergen` stops writing a second incompatible `status.json`.

**2. Unqualified condition identifiers resolve to context keys.**

The evaluator treats unknown identifier roots as direct context lookups, not string literals. `foo.bar=true` means `context["foo.bar"] == "true"` unless the root is one of the reserved namespaces (`outcome`, `preferred_label`, `context`, `steps`, `artifacts`). Reserved roots take precedence.

**3. Session limits are lifetime limits.**

`max_turns` lives on the `AgentSession` instance, not inside a single `processWorkItem()` invocation. Once the lifetime cap is reached, the session emits `agent_turn_limit_reached`, fails the current work item with `turn_limit_exceeded`, and rejects subsequent work.

**4. Recovery beats forced shutdown on context overflow.**

A `ContextLengthError` emits warning events, fails the active work item, and returns the session to a recoverable state (`AWAITING_INPUT`) so a caller can retry with a shorter prompt, compacted context, or a new session. It does not auto-close the session like an auth failure would.

**5. Error semantics converge through additive change.**

Do not rename working events or rip out existing fields. Add the missing fields (`notes`, `retry_after_ms`, full tool output) and reuse existing event/error types where possible.

### Test Fix Strategy

Each of the 4 failures has a distinct root cause and a distinct fix:

| Test | Root Cause | Fix |
|------|-----------|-----|
| `fan-in-llm` | Fan-in handler returns `status: 'failure'` when selected branch failed, even though selection itself succeeded | Return `status: 'success'` with selected branch info. Branch failure status available in context for downstream edges. |
| `hive-seedbed-flow` | `server.close()` waits for HTTP connections to drain, but SSE streams keep connections alive indefinitely | Track SSE connections in a Set with proper `close` event cleanup. Add `closeAll()` method. Force-close before `server.close()`. |
| `http-server` | `current_node` derived from engine snapshot, but engine may not be attached yet when status is polled early | Track `current_node` from `node_started` events on the RunManager entry. Fall back to event-derived state. |
| `pipeline-events` | `pipeline_failed` only emitted from `finishError()`, but terminal-node failures route through `finishCompleted()` | Check terminal outcome before `finishCompleted()`. If failure, call `finishError()` instead. Existing dedup guard prevents double-emit. |

---

## Implementation

### Phase 1: Green Suite — Fix the Four Failing Tests (~35%)

**Hard rule:** Phase 2 does not begin until `npm test` passes with zero failures.

**Files:** `src/handlers/fan-in.ts`, `src/server/sse.ts`, `src/server/server.ts`, `src/server/run-manager.ts`, `src/engine/engine.ts`

**Tasks:**

- [ ] **Fix fan-in-llm:** In `src/handlers/fan-in.ts`, change the logic that returns `status: 'failure'` when the selected branch failed. Return `status: 'success'` with `context_updates` containing the selected branch ID, rationale, and the branch's original status. Add regression test: fan-in selects a failed branch, verify downstream edges can route on `context.fan_in_selected_status`.

- [ ] **Fix hive-seedbed-flow shutdown:** In `src/server/sse.ts`, maintain a `Set<ServerResponse>` of active SSE connections with proper `close` event cleanup to prevent holding dead response objects. Add `closeAll()` method. In `src/server/server.ts`, call `sse.closeAll()` before `server.close()`. Add 5-second hard timeout.

- [ ] **Fix http-server current_node:** In `src/server/run-manager.ts`, subscribe to `node_started` events and store `entry.current_node`. Clear on `node_completed`. Use as primary source when engine is not yet attached.

- [ ] **Fix pipeline-events pipeline_failed:** In `src/engine/engine.ts`, check terminal outcome before `finishCompleted()`. If the run reached an exit node via a failure path, call `finishError()` instead. Existing `pipelineFailedEmitted` guard handles dedup. Add test: pipeline that fails on terminal node emits exactly one `pipeline_failed`.

- [ ] **Run `npm test`. All tests must pass. Zero failures, zero timeouts.**

### Phase 2: Audit and Engine Outcome Contract (~25%)

**Start with audit:** Before implementing any gap, verify each scoped gap (A1, A2, A3, A5, C1, C4, C5, C6, L1, L2, L6) against live code. If a gap is already closed, replace the implementation task with missing test coverage plus compliance report correction.

**Files:** `src/engine/types.ts`, `src/engine/engine.ts`, `src/engine/conditions.ts`, `src/handlers/codergen.ts`, `src/interviewer/auto-approve.ts`, `src/interviewer/types.ts`, `src/handlers/wait-human.ts`

**Tasks:**

- [ ] **Audit:** Reconcile each scoped gap against current code. Document which are still open, which are stale.

- [ ] **A1 (Outcome notes):** Add optional `notes?: string` to `NodeOutcome` in `src/engine/types.ts`. Allow engine to synthesize a fallback note when a handler omits one. Handlers may populate with meaningful notes (e.g., tool: `"exit code 0"`, codergen: `"LLM response received"`). Engine writes notes to context as `steps.<node_id>.notes`.

- [ ] **A2 (Canonical status.json):** In `src/engine/engine.ts`, replace the minimal `writeNodeStatus()` payload with the spec-shaped artifact: `{ outcome, preferred_label, suggested_next_ids, context_updates, notes, started_at, completed_at, duration_ms, node_id }`. Stop `codergen` from writing a conflicting `status.json`.

- [ ] **A3 (Unqualified context keys):** In `src/engine/conditions.ts`, when a variable has no recognized root prefix, try `context.<key>` as a fallback before returning undefined. Reserved roots (`outcome`, `preferred_label`, `context`, `steps`, `artifacts`) take precedence. Add tests: unqualified keys, dotted unqualified keys, reserved-root precedence, collision behavior.

- [ ] **A5 (CONFIRMATION type):** In `src/interviewer/auto-approve.ts`, treat `CONFIRMATION` same as `YES_NO` — return affirmative by default. In `src/handlers/wait-human.ts`, render confirmation prompts with affirmative/decline language.

- [ ] **Run `npm test`. All tests must still pass.**

### Phase 3: Agent Session Accounting and Provider Semantics (~25%)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/types.ts`, `src/agent-loop/events.ts`, `src/llm/errors.ts`, `src/llm/retry.ts`, `src/llm/adapters/anthropic.ts`

**Tasks:**

- [ ] **C1 (Session-scoped max_turns):** Move turn accounting from local work-item scope to session instance state. Increment across all `submit()` and `followUp()` calls. On exhaustion: emit `agent_turn_limit_reached`, fail current work item with `turn_limit_exceeded`, reject subsequent work. Add test: two sequential `submit()` calls with `max_turns=3` — second call has only 1 turn remaining.

- [ ] **C4 (agent_session_completed):** Verify if already emitted. If not, emit `agent_session_completed` with `{ status, turn_count, tool_call_count, duration_ms }` on session close. Add test.

- [ ] **C5 (Full tool output):** Always populate `full_content` in `agent_tool_call_completed` events, not only on truncation. Ensure this applies to both normal tool calls and subagent tool completions.

- [ ] **C6 (ContextLengthError recovery):** Catch `ContextLengthError` in session loop. Emit `agent_warning` and `context_window_warning`. Fail the active work item but return session to `AWAITING_INPUT`. Do not auto-close. Add test: mock LLM throws ContextLengthError, verify session emits warning and remains recoverable.

- [ ] **L1 (StreamError retryable):** In `src/llm/errors.ts`, set `StreamError.retryable = true`. Existing retry middleware's "no retry after partial output" guard prevents unsafe retries.

- [ ] **L2 (Anthropic ContentFilterError):** In `src/llm/adapters/anthropic.ts`, detect content-filtered responses and throw `ContentFilterError` instead of generic error. Add adapter test fixtures.

- [ ] **L6 (retry_after_ms on ProviderError):** Add optional `retry_after_ms?: number` to base `ProviderError` class. Populate from `Retry-After` header on any retryable provider error, not just `RateLimitError`. Update retry middleware to consult base field.

- [ ] **Run `npm test`. All tests must still pass.**

### Phase 4: Verification and Report Refresh (~15%)

**Files:** `docs/compliance-report.md`

**Tasks:**

- [ ] Run `npm run build` — zero TypeScript errors.
- [ ] Run `npm test` — final confirmation all tests pass.
- [ ] For each closed gap, move from GAPS to IMPLEMENTED with source file evidence.
- [ ] Correct any stale report items discovered during the Phase 2 audit.
- [ ] Document deliberate deferrals with justification:
  - A4: Checkpoint path is a documented Nectar design choice (data content equivalent; migration strategy needed)
  - C2: Requires proprietary system prompts from three providers (license unclear)
  - C3: Optional per spec language ("optionally include"); needs search backend decision
  - C7: Date-versioned beta headers rot; better as configuration
  - L3–L5, L7, L8: Cosmetic or interface-shape items with no behavioral impact
- [ ] Update generation date.
- [ ] Final audit: read each remaining gap entry against the source code to verify it's actually closed.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/handlers/fan-in.ts` | Modify | Return success on selection, not failure propagation |
| `src/server/sse.ts` | Modify | Track SSE connections with close-event cleanup, add `closeAll()` |
| `src/server/server.ts` | Modify | Force-close SSE before shutdown, add hard timeout |
| `src/server/run-manager.ts` | Modify | Derive `current_node` from events, not just engine |
| `src/engine/engine.ts` | Modify | Emit `pipeline_failed` on terminal failure; write canonical `status.json` |
| `src/engine/types.ts` | Modify | Add `notes` to `NodeOutcome` |
| `src/engine/conditions.ts` | Modify | Fallback unqualified keys to `context.*` with reserved-root precedence |
| `src/handlers/codergen.ts` | Modify | Stop writing conflicting `status.json`; return richer outcome metadata |
| `src/interviewer/auto-approve.ts` | Modify | Handle CONFIRMATION type deterministically |
| `src/interviewer/types.ts` | Modify | Tighten CONFIRMATION normalization semantics |
| `src/handlers/wait-human.ts` | Modify | CONFIRMATION prompt UX |
| `src/agent-loop/session.ts` | Modify | Session-scoped turn count; emit `agent_session_completed`; full tool output; ContextLengthError recovery |
| `src/agent-loop/types.ts` | Modify | Document session-lifetime `max_turns` semantics |
| `src/agent-loop/events.ts` | Modify | Ensure `agent_session_completed` and full tool output contracts |
| `src/llm/errors.ts` | Modify | StreamError retryable; `retry_after_ms` on base ProviderError |
| `src/llm/retry.ts` | Modify | Use generic retry-after handling for any retryable error |
| `src/llm/adapters/anthropic.ts` | Modify | Raise `ContentFilterError` for safety/content blocks |
| `docs/compliance-report.md` | Modify | Move closed gaps to IMPLEMENTED, document deferrals, correct stale entries |
| `test/integration/fan-in-llm.test.ts` | Verify/Modify | Confirm fix, add regression test for failed-branch selection |
| `test/integration/hive-seedbed-flow.test.ts` | Verify | Confirm shutdown fix |
| `test/integration/http-server.test.ts` | Verify | Confirm current_node fix |
| `test/server/pipeline-events.test.ts` | Verify/Modify | Confirm fix, add dedup test |
| `test/engine/conditions.test.ts` | Modify | Unqualified key lookup, dotted keys, reserved-root precedence |
| `test/agent-loop/session.test.ts` | Modify | Lifetime turn counting, ContextLengthError recovery, full tool output |
| `test/llm/errors.test.ts` | Modify | StreamError retryable, ProviderError retry_after_ms |
| `test/llm/retry.test.ts` | Modify | Generic retry-after, pre-output stream retries |
| `test/llm/adapters/anthropic.test.ts` | Modify | ContentFilterError classification |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts
- [ ] No test timeout values were increased to achieve green
- [ ] No tests were `.skip`-ed, `.todo`-ed, or otherwise disabled to achieve green
- [ ] No existing tests regressed; test count is ≥ pre-sprint count
- [ ] The 4 previously-failing tests all pass: fan-in-llm, hive-seedbed-flow, http-server, pipeline-events
- [ ] `NodeOutcome` has `notes` field; engine synthesizes fallback when handler omits one (A1)
- [ ] `writeNodeStatus()` persists canonical spec-shaped outcome fields; `codergen` no longer writes conflicting `status.json` (A2)
- [ ] `condition="my_flag=true"` resolves via `context.my_flag` fallback; reserved roots take precedence (A3)
- [ ] `CONFIRMATION` question type handled deterministically in auto-approve and wait.human (A5)
- [ ] `max_turns` counts across session lifetime, not per-input; exhaustion emits `agent_turn_limit_reached` (C1)
- [ ] `agent_session_completed` event emitted on session close with correct counts (C4)
- [ ] `agent_tool_call_completed` always includes `full_content` for both normal and subagent tool calls (C5)
- [ ] `ContextLengthError` emits warning, fails work item, returns session to `AWAITING_INPUT` — does not auto-close (C6)
- [ ] `StreamError` has `retryable: true`; retry only occurs before content is yielded (L1)
- [ ] Anthropic adapter raises `ContentFilterError` for filtered responses (L2)
- [ ] `ProviderError` base class has optional `retry_after_ms`; retry middleware consults it generically (L6)
- [ ] `docs/compliance-report.md` reflects actual shipped state with source evidence; stale entries corrected
- [ ] Remaining gaps documented as deliberate deferrals with justification

---

## Drop Line

If this sprint runs long, cut in this order (last item cut first):

1. **Keep (non-negotiable):** Phase 1 — green suite. This is the entire point.
2. **Keep:** Core engine truth fixes (A1, A2, A3).
3. **Keep:** Session and error recovery (C1, C5, C6, L1, L2).
4. **Keep:** Compliance report refresh (Phase 4).
5. **Defer first:** Interviewer/misc (A5, L6).
6. **Defer second:** Session lifecycle event (C4) — lower impact if session accounting is correct.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Fan-in fix changes downstream edge behavior for existing gardens | Medium | High | Fix only changes handler return status. Add regression test with fan-in that selects a failed branch; verify downstream edges can route on branch status via context. |
| SSE connection tracking leaks dead response objects | Medium | Medium | Clean up tracked connections on `close` event, not just on `closeAll()`. Test: open SSE, client disconnects, verify Set size returns to 0. |
| SSE force-close drops in-flight events | Low | Medium | Call `closeAll()` before `server.close()`, not during. Mid-write truncation is acceptable during shutdown — clients must handle reconnection. |
| current_node event tracking shows stale state | Medium | Medium | Clear `entry.current_node` on `node_completed`. Never serve stale node after completion. |
| pipeline_failed emitted twice on edge cases | Medium | High | Existing `pipelineFailedEmitted` boolean guard prevents duplicates. Add test: pipeline that fails on terminal node — verify exactly one `pipeline_failed`. |
| Canonicalizing status.json breaks existing consumers | Medium | Medium | New artifact is an additive superset. Handler-specific metadata stays in separate files. Run existing tests as-is to catch schema assumptions. |
| Session-scoped max_turns breaks callers that rely on per-input reset | Medium | Medium | All existing tests call submit() once, so behavior is identical. New test covers multi-submit. |
| ContextLengthError recovery leads to infinite retry loops | Medium | Medium | Recovery returns to AWAITING_INPUT — the caller must decide to retry, not the session. The session does not auto-retry. |
| Compliance report audit discovers new gaps | Medium | Low | Document newly discovered gaps. Close if one-line fixes; otherwise add to gap list for next sprint. |
| Sprint scope is still large (4 test fixes + 11 gap closures) | Medium | High | Drop line is strict. Phase 1 (green suite) is the minimum viable sprint. Everything else is bonus. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing test infrastructure (vitest, fixtures) | All test fixes use existing patterns |
| `SimulationProvider` | Fan-in LLM test depends on simulation provider for deterministic behavior |
| Existing `NodeOutcome`, `ProviderError`, `GenerateRequest` types | All type additions are additive optional fields |
| Existing event emission infrastructure | `pipeline_failed` and `agent_session_completed` use existing emit patterns |
| No new runtime packages | Every change modifies existing files or adds fields to existing types |
