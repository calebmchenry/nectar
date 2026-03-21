# Sprint 035: Green Suite or Bust — Fix the Four, Close the Gaps

## Overview

**Goal:** Make `npm test` pass with zero failures and close every remaining compliance gap that doesn't require new architecture. After this sprint: the CI suite is green for the first time since sprint 024, every one-line and small-fix compliance gap is closed, and the compliance report shows only deliberate deferrals (C2: native system prompt mirroring, C3: Gemini web tools, L8: circuit breaker).

**Why this sprint, why now:**

1. **The test suite has been red for 10+ consecutive sprints.** Sprints 025 through 034 all listed "green suite" as a goal. All failed. The common failure mode: mixing test fixes with large feature work, running out of scope, and shipping the feature changes without landing the test fixes. This sprint breaks the cycle by making the green suite the *only* hard gate — everything else is subordinate.

2. **The 4 failing tests have known, distinct root causes.** They are not entangled: fan-in handler propagates branch failure status (bug), server shutdown doesn't force-close SSE connections (race), run-manager doesn't track current_node until engine attaches (timing), and engine never emits `pipeline_failed` on terminal-node failure (missing code path). Each fix is surgical.

3. **The remaining compliance gaps are almost all mechanical.** 17 of the 20 open gaps are one-field additions, one-line behavior changes, or small method stubs. None requires new architecture. None requires new dependencies. They've been deferred sprint after sprint because they were always lower priority than the feature of the week — but they accumulate. This sprint pays down the debt.

4. **INTENT.md §5.1 is explicit: "An agent can read the three NLSpec documents, compare them against the implementation, and find zero unimplemented features."** Every gap that stays open is a violation of the project's definition of done.

**Scope:** Fix 4 failing tests. Close gaps A1, A2, A3, A5, C1, C4, C5, C6, C7, L1, L2, L3, L4, L5, L6, L7. Update compliance report.

**Out of scope:**
- C2 (native system prompt mirroring) — requires obtaining and maintaining copies of three proprietary system prompts; high effort, unclear license
- C3 (Gemini web_search/web_fetch) — optional per spec ("optionally include"), needs external search backend decision
- L8 (circuit breaker) — spec lists as "common middleware use case," not a hard requirement
- A4 (checkpoint path) — data content is equivalent; path convention is a Nectar-specific design choice documented as intentional deviation
- New features, UI work, CLI commands, or packaging changes

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures, zero timeouts, no inflated timeout values.

2. **Fan-in completes when the selected branch succeeded.** A prompted fan-in pipeline where the LLM selects a successful branch completes the run. The fan-in handler's job is to *select*, not to re-judge branch outcomes — success/failure routing belongs to the graph's edge conditions.

3. **Server shuts down promptly.** `server.close()` terminates all SSE connections, aborts running engines, and resolves within 5 seconds. No afterEach hook timeouts.

4. **Live run state is truthful.** `GET /pipelines/:id` during an active run returns `current_node` reflecting the node currently executing, never `undefined` while a node is in progress.

5. **Failed pipelines emit terminal events.** A pipeline that terminates in failure emits `pipeline_failed` exactly once. The event stream, REST status, and context all agree on the terminal state.

6. **Unqualified condition keys resolve from context.** `condition="my_flag=true"` works — it looks up `context.my_flag` as a fallback when the key has no known root prefix.

7. **Session turns count across the session lifetime.** `max_turns` limits the total turns across all `submit()` calls, not per-input.

8. **ContextLengthError triggers recovery, not termination.** When the LLM returns a context-length error, the session emits a warning event and continues (if possible) rather than terminating the work item.

9. **Stream errors are retried.** `StreamError` is marked `retryable: true` per spec. The retry middleware retries stream errors that occur before content is yielded.

---

## Architecture

### Principle: Fix First, Then Extend

This sprint inverts the typical pattern. Previous sprints added features then tried to fix tests at the end. This sprint fixes tests first (Phase 1 is a hard gate), then makes mechanical compliance changes that are individually small and independently testable.

### Test Fix Strategy

Each of the 4 failures has a distinct root cause and a distinct fix:

| Test | Root Cause | Fix |
|------|-----------|-----|
| `fan-in-llm` | Fan-in handler returns `status: 'failure'` when selected branch failed, even though selection itself succeeded | Return `status: 'success'` with the selected branch info. Branch failure status is already available in context for downstream edge conditions. |
| `hive-seedbed-flow` | `server.close()` waits for HTTP connections to drain, but SSE streams keep connections alive indefinitely | Force-destroy all tracked SSE response objects before calling `server.close()`. Track SSE connections in a Set. |
| `http-server` | `current_node` is derived from engine snapshot, but engine may not be attached yet when status is polled early | Track `current_node` from `node_started` events on the RunManager entry. Fall back to event-derived state when engine is not yet attached. |
| `pipeline-events` | `pipeline_failed` only emitted from `finishError()`, but terminal-node failures route through `finishCompleted()` | Check terminal outcome before calling `finishCompleted()`. If the run reached an exit node via a failure path, call `finishError()` instead. |

### Compliance Closure Strategy

All changes are additive. No renames, no breaking changes:

- **Field additions** (A1, A2, L5, L6, L7): Add optional fields to existing interfaces. Existing code that doesn't use them is unaffected.
- **Behavior corrections** (A3, C1, L1, L2): Change internal logic to match spec. Tests verify the corrected behavior.
- **Missing emissions** (C4, C5): Add event emission at the correct code path. Existing consumers ignore unknown events.
- **Small implementations** (A5, C6, C7, L3, L4): Each is self-contained — a new method, a new branch, or a new export.

---

## Implementation

### Phase 1: Green Suite — Fix the Four Failing Tests (~40%)

**Hard rule:** Phase 2 does not begin until `npm test` passes with zero failures.

**Files:** `src/handlers/fan-in.ts`, `src/server/sse.ts`, `src/server/server.ts`, `src/server/run-manager.ts`, `src/engine/engine.ts`

**Tasks:**

- [ ] **Fix fan-in-llm:** In `src/handlers/fan-in.ts`, change the logic that returns `status: 'failure'` when the selected branch failed. The fan-in handler should return `status: 'success'` with `context_updates` containing the selected branch ID, rationale, and the branch's original status. The fan-in's job is selection, not judgment. Downstream edges can route on `context.fan_in_selected_status=failure` if needed.

- [ ] **Fix hive-seedbed-flow shutdown:** In `src/server/sse.ts`, maintain a `Set<ServerResponse>` of active SSE connections. Add a `closeAll()` method that calls `res.end()` on every tracked connection and clears the set. In `src/server/server.ts`, call `sse.closeAll()` before `server.close()` in the shutdown path. Add a 5-second hard timeout on `server.close()` — if it hasn't resolved, call `server.close()` forcefully.

- [ ] **Fix http-server current_node:** In `src/server/run-manager.ts`, subscribe to `node_started` events on each run entry and store `entry.current_node = event.node_id`. In `getStatus()` / `resolveCurrentNode()`, use `entry.current_node` as the primary source when the engine is not yet attached or when `engine.getContextSnapshot()` returns undefined.

- [ ] **Fix pipeline-events pipeline_failed:** In `src/engine/engine.ts`, before calling `finishCompleted()`, check whether the run's terminal status is a failure (e.g., the last node outcome was `'failure'` or the run reached an exit node via a failure edge). If so, call `finishError()` instead, which triggers `emitPipelineFailed()`. Ensure `pipeline_failed` is emitted exactly once (the existing `pipelineFailedEmitted` guard handles dedup).

- [ ] **Run `npm test`. All 1205+ tests must pass. Zero failures, zero timeouts.**

### Phase 2: Behavioral Correctness Gaps (~30%)

**Files:** `src/engine/conditions.ts`, `src/agent-loop/session.ts`, `src/llm/errors.ts`, `src/llm/adapters/anthropic.ts`, `src/engine/types.ts`, `src/engine/engine.ts`, `src/agent-loop/events.ts`, `src/interviewer/auto-approve.ts`, `src/handlers/wait-human.ts`

**Tasks:**

- [ ] **A1 (Outcome notes):** Add optional `notes?: string` to `NodeOutcome` in `src/engine/types.ts`. Populate from handlers where meaningful (e.g., tool handler: `"exit code 0"`, codergen: `"LLM response received"`). Engine writes notes to context as `steps.<node_id>.notes`.

- [ ] **A2 (status.json full outcome):** In `src/engine/engine.ts` `writeNodeStatus()`, include `outcome`, `preferred_label`, `suggested_next_ids`, `context_updates`, and `notes` from the handler's `NodeOutcome` alongside the existing timing fields.

- [ ] **A3 (Unqualified context keys):** In `src/engine/conditions.ts`, when a variable has no recognized root prefix (`outcome`, `preferred_label`, `context`, `steps`, `artifacts`), try `context.<key>` as a fallback before returning undefined. Add tests: `condition="my_flag=true"` resolves to `context.my_flag`.

- [ ] **A5 (CONFIRMATION type):** In `src/interviewer/auto-approve.ts`, treat `CONFIRMATION` the same as `YES_NO` — return `YES` by default. In `src/handlers/wait-human.ts`, ensure CONFIRMATION questions present the same UX as YES_NO but with affirmative/decline language instead of yes/no.

- [ ] **C1 (Session-scoped max_turns):** In `src/agent-loop/session.ts`, move `turnCount` from `processWorkItem()` local scope to session instance state. Increment it across all `submit()` and `followUp()` calls. Add a `resetTurns()` method for explicit reset if needed. Add test: two sequential `submit()` calls with `max_turns=3` — the second call should have only 1 turn remaining.

- [ ] **C4 (agent_session_completed emission):** In `src/agent-loop/session.ts`, emit `agent_session_completed` with `{ status, turn_count, tool_call_count, duration_ms }` when `close()` is called or when the session transitions to CLOSED state. Add test verifying the event fires with correct counts.

- [ ] **C5 (TOOL_CALL_END full output):** In the tool call completion path in `src/agent-loop/session.ts`, always include `full_content` in the `agent_tool_call_completed` event, not just when truncation occurred. Remove the conditional that only sets `full_content` on truncation.

- [ ] **C6 (ContextLengthError handling):** In `src/agent-loop/session.ts` `processWorkItem()`, add a specific catch for `ContextLengthError`. Emit `context_window_warning` event and continue the work item (e.g., by truncating history or retrying with reduced context) instead of terminating. Add test: mock an LLM that throws ContextLengthError, verify the session emits a warning and doesn't crash.

- [ ] **C7 (Anthropic beta headers):** In `src/agent-loop/provider-profiles.ts`, add `'extended-thinking-2025-04-15'` and `'max-tokens-3-5-sonnet-2025-04-14'` to the Anthropic profile's `betas` array.

- [ ] **L1 (StreamError retryable):** In `src/llm/errors.ts`, change `StreamError`'s constructor to set `this.retryable = true`.

- [ ] **L2 (Anthropic ContentFilterError):** In `src/llm/adapters/anthropic.ts`, detect content-filtered responses (e.g., `stop_reason: 'end_turn'` with empty content when the request had potentially unsafe content, or explicit content filter indicators) and throw `ContentFilterError` instead of letting them through as generic errors.

- [ ] **Run `npm test`. All tests must still pass.**

### Phase 3: Interface Shape and Type Compliance (~20%)

**Files:** `src/llm/types.ts`, `src/llm/streaming.ts`, `src/llm/errors.ts`, `src/llm/client.ts`, `src/engine/events.ts`

**Tasks:**

- [ ] **L3 (StreamEvent naming):** Add type aliases: `text_delta` as alias for `content_delta`, `finish` as alias for `stream_end`, `reasoning_start/delta/end` as aliases for `thinking_start/delta/end`. Export both names. Do not remove existing names.

- [ ] **L4 (Module-level stream()):** Export a `stream()` function from `src/llm/client.ts` that mirrors `generate()` — gets the default client and calls `client.streamWithToolLoop()`. Add test.

- [ ] **L5 (ImageData detail):** Add optional `detail?: 'auto' | 'low' | 'high'` to `ImageSource` in `src/llm/types.ts`. Pass through to OpenAI adapter's image content parts.

- [ ] **L6 (retry_after on ProviderError):** Add optional `retry_after_ms?: number` to the base `ProviderError` class in `src/llm/errors.ts`. Populate from `Retry-After` header in `ServerError` and other retryable errors, not just `RateLimitError`.

- [ ] **L7 (metadata on GenerateRequest):** Add optional `metadata?: Record<string, string>` to `GenerateRequest` in `src/llm/types.ts`. Pass through to adapters via `provider_options` when set.

- [ ] Add tests for each type addition: `detail` on image content, `retry_after_ms` on ServerError, `metadata` on request, module-level `stream()`.

- [ ] **Run `npm test`. All tests must still pass.**

### Phase 4: Compliance Report Refresh (~10%)

**Files:** `docs/compliance-report.md`

**Tasks:**

- [ ] Run `npm test` — final confirmation all tests pass.
- [ ] Run `npm run build` — zero TypeScript errors.
- [ ] For each closed gap, move from GAPS to IMPLEMENTED with source file evidence.
- [ ] Document the 4 deliberate deferrals with justification:
  - A4: Path convention is a documented Nectar design choice (data content equivalent)
  - C2: Requires proprietary system prompts from three providers (license unclear)
  - C3: Optional per spec language ("optionally include")
  - L8: Spec lists as use case, not requirement ("common middleware use case")
- [ ] Update generation date.
- [ ] Final audit: read each remaining gap entry against the source code to verify it's actually closed.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/handlers/fan-in.ts` | Modify | Return success on selection, not failure propagation |
| `src/server/sse.ts` | Modify | Track SSE connections, add `closeAll()` |
| `src/server/server.ts` | Modify | Force-close SSE before shutdown, add hard timeout |
| `src/server/run-manager.ts` | Modify | Derive `current_node` from events, not just engine |
| `src/engine/engine.ts` | Modify | Emit `pipeline_failed` on terminal failure; write full outcome to status.json |
| `src/engine/types.ts` | Modify | Add `notes` to `NodeOutcome` |
| `src/engine/conditions.ts` | Modify | Fallback unqualified keys to `context.*` |
| `src/engine/events.ts` | Modify | Add stream event aliases |
| `src/agent-loop/session.ts` | Modify | Session-scoped turn count; emit `agent_session_completed`; full tool output; ContextLengthError handling |
| `src/agent-loop/events.ts` | Modify | Ensure `agent_session_completed` type is exported |
| `src/agent-loop/provider-profiles.ts` | Modify | Add Anthropic beta headers |
| `src/interviewer/auto-approve.ts` | Modify | Handle CONFIRMATION type |
| `src/handlers/wait-human.ts` | Modify | CONFIRMATION question UX |
| `src/handlers/tool.ts` | Modify | Populate `notes` on outcome |
| `src/handlers/codergen.ts` | Modify | Populate `notes` on outcome |
| `src/llm/errors.ts` | Modify | StreamError retryable; retry_after on ProviderError |
| `src/llm/types.ts` | Modify | ImageData detail; metadata on GenerateRequest |
| `src/llm/streaming.ts` | Modify | Stream event type aliases |
| `src/llm/client.ts` | Modify | Module-level `stream()` export |
| `src/llm/adapters/anthropic.ts` | Modify | Raise ContentFilterError |
| `docs/compliance-report.md` | Modify | Move closed gaps to IMPLEMENTED, document deferrals |
| `test/integration/fan-in-llm.test.ts` | Verify | Confirm fix (no test change expected) |
| `test/integration/hive-seedbed-flow.test.ts` | Verify | Confirm fix (no test change expected) |
| `test/integration/http-server.test.ts` | Verify | Confirm fix (no test change expected) |
| `test/server/pipeline-events.test.ts` | Verify | Confirm fix (no test change expected) |
| `test/engine/conditions.test.ts` | Modify | Add unqualified key lookup tests |
| `test/agent-loop/session.test.ts` | Modify | Add session-scoped turn count and ContextLengthError tests |
| `test/llm/errors.test.ts` | Modify | Verify StreamError retryable, ProviderError retry_after |
| `test/llm/client.test.ts` | Modify | Add module-level stream() test |
| `test/llm/types.test.ts` | Modify | ImageData detail, metadata field tests |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts
- [ ] No test timeout values were increased to achieve green
- [ ] No existing tests regressed; test count is ≥ pre-sprint count
- [ ] The 4 previously-failing tests all pass: fan-in-llm, hive-seedbed-flow, http-server, pipeline-events
- [ ] `NodeOutcome` has `notes` field; handlers populate it (A1)
- [ ] `writeNodeStatus()` persists full outcome fields (A2)
- [ ] `condition="my_flag=true"` resolves via `context.my_flag` fallback (A3)
- [ ] `CONFIRMATION` question type handled in auto-approve and wait.human (A5)
- [ ] `max_turns` counts across session lifetime, not per-input (C1)
- [ ] `agent_session_completed` event emitted on session close with counts (C4)
- [ ] `agent_tool_call_completed` always includes `full_content` (C5)
- [ ] `ContextLengthError` emits warning and continues, does not terminate (C6)
- [ ] Anthropic profile includes extended thinking and 1M context beta headers (C7)
- [ ] `StreamError` has `retryable: true` (L1)
- [ ] Anthropic adapter raises `ContentFilterError` for filtered responses (L2)
- [ ] Stream event type aliases exist: `text_delta`, `finish`, `reasoning_*` (L3)
- [ ] Module-level `stream()` exported with tool loop support (L4)
- [ ] `ImageSource` has optional `detail` field (L5)
- [ ] `ProviderError` base class has optional `retry_after_ms` (L6)
- [ ] `GenerateRequest` has optional `metadata` field (L7)
- [ ] `docs/compliance-report.md` reflects actual shipped state with source evidence
- [ ] Only 4 gaps remain as documented deliberate deferrals: A4, C2, C3, L8

---

## Drop Line

If this sprint runs long, cut in this order (last item cut first):

1. **Keep (non-negotiable):** Phase 1 — green suite. This is the entire point.
2. **Keep:** Phase 4 — compliance report refresh. Validates everything else.
3. **Keep:** Phase 2 behavioral fixes (L1, A3, C1) — these are one-line changes with high correctness impact.
4. **Defer first:** Phase 3 type additions (L5, L6, L7) — interface shape, no behavioral impact.
5. **Defer second:** Phase 2 lower-priority items (A5, C7) — correct but not urgent.
6. **Defer third:** L3 event aliases, L4 module stream — cosmetic compliance.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Fan-in fix changes edge selection behavior downstream | Medium | High | The fix only changes the handler return status, not the context data. Add a regression test with a fan-in that selects a failed branch and verify downstream edges can still route on branch status. |
| Server shutdown fix introduces connection leak | Low | Medium | Track connections in a WeakSet or clean Set. Add test: start server, open SSE, close server, verify connection count is 0. |
| current_node event tracking introduces stale state | Medium | Medium | Clear `entry.current_node` on `node_completed`. Never serve stale node after completion. |
| pipeline_failed emitted twice on edge cases | Medium | High | The existing `pipelineFailedEmitted` boolean guard prevents duplicates. Add explicit test: pipeline that fails, retries, and fails again — verify exactly one `pipeline_failed`. |
| Session-scoped max_turns breaks existing tests | Medium | Medium | All existing tests that use max_turns only call submit() once, so behavior is identical. Add new test for the multi-submit case. |
| ContextLengthError recovery strategy unclear | High | Medium | Start with the simplest recovery: emit warning, let the session's existing error handling decide whether to continue or stop. Do not implement automatic context truncation this sprint — that's a feature, not a bug fix. |
| Compliance report audit finds new gaps | Medium | Low | Document any newly discovered gaps. If they're one-line fixes, close them. If not, add to the gap list for the next sprint. |
| Sprint scope is still too large (4 test fixes + 16 gap closures) | Medium | High | Drop line is strict. Phase 1 (green suite) is the minimum viable sprint. Everything else is bonus. If Phase 1 takes the entire sprint, that's a successful sprint. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing test infrastructure (vitest, fixtures) | All test fixes use existing patterns |
| `SimulationProvider` | Fan-in LLM test depends on simulation provider for deterministic behavior |
| Existing `NodeOutcome`, `ProviderError`, `GenerateRequest` types | All type additions are additive optional fields |
| Existing event emission infrastructure | `pipeline_failed` and `agent_session_completed` use existing emit patterns |
| No new runtime packages | Every change modifies existing files or adds fields to existing types |
