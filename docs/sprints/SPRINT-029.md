# Sprint 029: Green Suite, SSE Lifecycle Hardening & Final Compliance Closure

## Overview

**Goal:** Fix all 9 remaining failing tests without increasing timeouts, harden SSE stream lifecycle across the HTTP server so streams close deterministically, close the final spec compliance gap (`patient` retry preset multiplier), and add direct `StreamAccumulator` test coverage. After this sprint: CI is green, the compliance report has zero gaps, and the Hive runtime is reliable enough to draft, run, cancel, resume, and replay pipelines without hanging.

**Why this sprint, why now:**

1. **The test suite is red and credibility is eroding.** 9 tests fail across 6 files. Sprints 025–028 all declared "green suite" as a goal and did not deliver it. A red suite means nobody trusts the tests, which means nobody trusts the code. This sprint has one non-negotiable gate: `npm test` passes with zero failures before any other work ships.

2. **The failures are well-understood and clustered.** Root-cause analysis reveals 4 distinct issue clusters: (a) 4 OpenAI-Compatible adapter tests assert legacy Anthropic-native stop reasons (`end_turn`, `tool_use`) instead of the unified `FinishReasonValue` naming (`stop`, `tool_calls`). (b) 1 OpenAI-Compatible error test expects `OverloadedError` for HTTP 500, but 500 → `ServerError` per the unified-llm-spec; `OverloadedError` is 503. (c) 1 content assertion mismatch in `gardens-draft` (mock LLM output doesn't match test expectation — NOT an SSE timeout). (d) 4 SSE lifecycle / state machine bugs — streams never close on run completion/cancellation, causing timeouts in `hive-run-flow`, `http-resume`, `http-server`, and `seed-run-linkage`.

3. **SSE lifecycle is the root cause of product unreliability.** The Hive cannot count as "polished" while run event streams fail to terminate cleanly and seed-linked run flows race. The biggest remaining INTENT gap is product trust, not missing features.

4. **Exactly one spec compliance gap remains.** The `patient` retry preset uses `multiplier: 2.0`; the spec requires `backoff_factor: 3.0`. One line of source, one line of test. Closing it brings the compliance report to zero gaps — the hard requirement in INTENT.md §5.1.

5. **Nothing else should ship while the foundation is cracked.** New features on top of a red suite compound the problem. This sprint is deliberately narrow: fix what's broken, harden the runtime contracts, close the last gap.

**Out of scope:**
- New LLM response contract features (GenerateResult, StepResult)
- ExecutionEnvironment interface extensions
- Hive UI features, dark mode, or design refresh
- New HTTP endpoints, server routes, or CLI commands (including shell completions)
- Refactoring or architecture changes beyond SSE lifecycle hardening
- Bun single-binary packaging and GitHub release automation

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` succeeds with zero errors, zero failures, and no test timeout bumps. The suite completes cleanly.

2. **The compliance report has zero gaps.** Every requirement in the pinned attractor-spec.md, coding-agent-loop-spec.md, and unified-llm-spec.md is implemented, including the `patient` retry preset with `backoff_factor: 3.0`.

3. **Draft a garden from the Hive without a hanging request.** The browser posts to `/gardens/draft`, receives `draft_start`, content delta events, then exactly one terminal event (`draft_complete` or `draft_error`). The response closes immediately afterward.

4. **Run a garden from the Hive and trust the live state.** The browser starts a run, opens `/pipelines/:id/events`, and sees deterministic replay plus live events. `GET /pipelines/:id/context` includes `current_node` while the run is active. When the run completes, the stream closes.

5. **Cancel and resume a run without race conditions.** A user cancels during engine bootstrap or mid-node execution. Nectar persists an interrupted checkpoint with reason `api_cancel`, closes the event stream cleanly, and allows `POST /pipelines/:id/resume` to continue the same run to completion.

6. **Launch a linked garden from a seed and trust the lifecycle.** `activity.jsonl` records `run_started`, `run_interrupted`, `run_resumed`, and `run_completed` in order. The seed-run linkage integration test passes without timeout.

7. **OpenAI-Compatible providers return consistent finish reasons.** A local LLM behind an OpenAI-compatible API (Ollama, LM Studio, vLLM) returns `finish_reason: "stop"`. Nectar's response reports `stop_reason === "stop"`, consistent with how every other adapter normalizes its native stop reasons.

---

## Architecture

### No new architecture — targeted fixes plus SSE lifecycle hardening

This sprint introduces no new major abstractions. The work is:

- **Test assertion fixes** for the OpenAI-Compatible adapter to match the unified `FinishReasonValue` naming that `GenerateResponse.stop_reason` already returns.
- **Error class mapping fix** so HTTP 500 → `ServerError` and HTTP 503 → `OverloadedError` in both adapter and test.
- **Content assertion fix** for `gardens-draft` — the mock LLM response doesn't match what the test asserts (this is NOT an SSE timeout).
- **SSE lifecycle hardening** to ensure streams close deterministically on every terminal path (completion, error, cancellation, client disconnect) across all SSE endpoints.
- **One constant change** in the engine retry module.
- **StreamAccumulator test coverage** to fill the gap left by Sprint 028.

### SSE lifecycle contract

The current code mostly works, but each route hand-rolls its own close logic, which is why failures cluster around hangs. The fix applies a consistent pattern:

- After writing any terminal event (`run_completed`, `pipeline_failed`, `run_interrupted`, `draft_complete`, `draft_error`), call `res.end()` to close the SSE connection.
- Handle `req.on('close')` on all SSE endpoints to remove event listeners and prevent memory leaks.
- Ensure idempotent close — `res.end()` must be safe to call from multiple terminal paths without double-close errors.

Opinionated rule: **no route should call `res.end()` from three different branches ever again.** If the SSE close logic cannot be unified into a shared helper trivially, extract a minimal shared SSE helper with finite-stream and persistent-stream modes.

### Active run context truth

`GET /pipelines/:id/context` must query the active engine state (if running) or the latest checkpoint to accurately merge `current_node` with persisted context, rather than only reading static `context_values`. If the engine snapshot is empty or not yet initialized, fall back to checkpoint data.

### Root cause analysis for the 9 failures

**Cluster A — OpenAI-Compatible stop_reason assertions (4 tests)**

`GenerateResponse.stop_reason` is a getter returning `this.finish_reason.reason` — the unified `FinishReasonValue`. The adapter populates `finish_reason` with unified values (`{ reason: 'stop', raw: 'stop' }`). But 4 tests were written before the unified naming convention and assert Anthropic-native values:

| Test | Line (approx) | Asserts | Should Assert |
|------|---------------|---------|---------------|
| translates request/response for text generation | ~80 | `'end_turn'` | `'stop'` |
| translates tool calls in non-streaming | ~134 | `'tool_use'` | `'tool_calls'` |
| falls back when json_schema unsupported | ~288 | `'end_turn'` | `'stop'` |
| streaming tool call end event | ~223 | `'tool_use'` | `'tool_calls'` |

Fix: update the 4 test assertions. Zero source code changes needed.

**Note:** Line numbers are approximate — use test names as the stable reference. The streaming test at ~223 may use a `canListen` guard that skips it when a loopback port is unavailable; verify it actually runs and fails before treating it as a required fix.

**Cluster B — OpenAI-Compatible error mapping (1 test)**

The test sends HTTP 500 and expects `OverloadedError`. Per the unified-llm-spec error taxonomy: 500/502/504 → `ServerError`, 503 → `OverloadedError`. The adapter correctly maps 500 → `ServerError`. The test expectation is wrong.

Fix: change the 500 assertion to expect `ServerError`; add a 503 case expecting `OverloadedError`.

**Cluster C — gardens-draft content assertion (1 test)**

`gardens-draft.test.ts` line ~80 asserts `expect(payload).toContain('digraph Drafted')`. The mock LLM response returns a generic `digraph { ... }` without the word "Drafted" in the graph name. The SSE stream IS closing correctly — the test receives `draft_complete`. This is a **content assertion mismatch**, not an SSE lifecycle bug.

Fix: either update the mock LLM response to include "Drafted" in the graph name, or relax the assertion to match what the mock actually returns. Investigate which is correct by reading the draft service's prompt/output contract.

**Cluster D — SSE lifecycle timeouts (4 tests)**

`hive-run-flow`, `http-resume`, `http-server` (cancel), and `seed-run-linkage` all time out waiting for SSE streams to close. The root cause: SSE route handlers don't call `res.end()` when the underlying run reaches a terminal state.

**Important:** The `http-server` cancel test fails with an assertion error, not necessarily a timeout. The root cause may be a state machine issue in `RunManager` rather than SSE lifecycle. Investigate this separately — Gemini's theory that `current_node` is not populated in the context endpoint response is plausible but unverified.

Fix: in each SSE endpoint, listen for the terminal event and call `res.end()` after writing it. Handle `req.on('close')` to clean up listeners if the client disconnects. For `http-server` cancel, investigate the actual assertion failure before assuming SSE is the issue.

---

## Implementation

### Phase 1: Green Suite — OpenAI-Compatible Adapter (15% of effort)

**Files:** `test/llm/openai-compatible.test.ts`, `src/llm/adapters/openai-compatible.ts`

**Tasks:**
- [ ] Update stop_reason assertion for "translates request/response for text generation" from `'end_turn'` to `'stop'`
- [ ] Update stop_reason assertion for "translates tool calls in non-streaming" from `'tool_use'` to `'tool_calls'`
- [ ] Update stop_reason assertion for "streaming tool call end event" from `'tool_use'` to `'tool_calls'` (verify this test runs; it may be behind a `canListen` guard)
- [ ] Update stop_reason assertion for "falls back when json_schema unsupported" from `'end_turn'` to `'stop'`
- [ ] Fix error mapping test: change HTTP 500 assertion from `OverloadedError` to `ServerError`
- [ ] Add HTTP 503 test case asserting `OverloadedError`
- [ ] Verify adapter's error handler maps 503 → `OverloadedError`; add the mapping if missing
- [ ] Gate: `npx vitest test/llm/openai-compatible.test.ts` — 0 failures

### Phase 2: Green Suite — Gardens Draft Content Fix (5% of effort)

**Files:** `test/server/gardens-draft.test.ts`, `src/runtime/garden-draft-service.ts`

This was misdiagnosed as an SSE timeout in all three original drafts. The Codex critique correctly identified it as a content assertion mismatch.

**Tasks:**
- [ ] Read `gardens-draft.test.ts` line ~80 and understand the assertion: `expect(payload).toContain('digraph Drafted')`
- [ ] Read the mock LLM response in the test setup — confirm it returns `digraph { ... }` without "Drafted"
- [ ] Determine the correct fix: update mock to include "Drafted" in the graph name, OR relax assertion to match mock output
- [ ] Apply the fix
- [ ] Gate: `npx vitest test/server/gardens-draft.test.ts` — passes without timeout

### Phase 3: Green Suite — SSE Lifecycle Hardening (45% of effort)

**Files:** `src/server/routes/gardens.ts`, `src/server/routes/pipelines.ts`, `src/server/run-manager.ts`, `src/server/routes/events.ts`, `src/server/workspace-event-bus.ts`, `src/runtime/garden-draft-service.ts`, `src/server/event-journal.ts`

This is the highest-risk and highest-effort phase. The 4 integration tests share a root cause pattern but touch different code paths.

**Tasks:**
- [ ] Audit the draft SSE endpoint in `routes/gardens.ts`: ensure `draft_complete` / `draft_error` events trigger `res.end()`
- [ ] On client disconnect (`req.on('close')`), clean up event listeners and abort any in-flight LLM call
- [ ] Audit `GET /pipelines/:id/events` SSE handler: identify where terminal events are written
- [ ] After writing any terminal pipeline event (`run_completed`, `pipeline_failed`, `run_interrupted`), call `res.end()`
- [ ] Handle already-terminal runs: if the run is terminal before subscription starts, replay the journal and close immediately
- [ ] **Investigate `http-server` cancel test separately:** run with verbose output, trace the actual assertion failure. If it's a state machine / context endpoint issue rather than SSE, fix accordingly
- [ ] Fix context endpoint: `GET /pipelines/:id/context` must include `current_node` from the active engine state, falling back to latest checkpoint
- [ ] Audit `POST /pipelines/:id/cancel`: ensure it triggers abort signal → checkpoint save → terminal event → stream close
- [ ] Handle `req.on('close')` on all SSE endpoints to remove event listeners and prevent memory leaks
- [ ] Ensure `res.end()` is idempotent — safe to call from multiple terminal paths
- [ ] Audit workspace event SSE (`/events`): ensure it cleans up on client disconnect
- [ ] Gate: run each failing integration test individually
  - `npx vitest test/integration/hive-run-flow.test.ts`
  - `npx vitest test/integration/http-resume.test.ts`
  - `npx vitest test/integration/http-server.test.ts`
  - `npx vitest test/integration/seed-run-linkage.test.ts`
- [ ] **Full suite gate:** `npm test` — 0 failures before proceeding to Phase 4

### Phase 4: StreamAccumulator Coverage & Last Spec Gap (15% of effort)

**Files:** `test/llm/stream-accumulator.test.ts` (new), `src/engine/retry.ts`, `test/engine/retry.test.ts`

**Tasks:**
- [ ] Create `test/llm/stream-accumulator.test.ts` with direct coverage for `StreamAccumulator`: verify `push()` logic for all event types, partial response buffering, and `response()` assembly
- [ ] If `StreamAccumulator` tests reveal bugs, file them for a future sprint rather than fixing in-line (unless trivial)
- [ ] Change `RETRY_PRESETS.patient.multiplier` from `2.0` to `3.0` at `src/engine/retry.ts`
- [ ] Update corresponding test assertion for patient preset multiplier
- [ ] Grep for any other test that computes expected delays using the patient preset multiplier — update if found
- [ ] Gate: `npx vitest test/llm/stream-accumulator.test.ts` and `npx vitest test/engine/retry.test.ts` — both pass

### Phase 5: Final Verification (20% of effort)

**Tasks:**
- [ ] `npm run build` — zero TypeScript errors
- [ ] `npm test` — 0 failures across all test files
- [ ] Verify no test timeout values were increased to achieve green
- [ ] Verify no tests were skipped to achieve green (`--reporter=verbose` shows 0 skipped in affected files)
- [ ] Verify compliance report GAPS section is empty
- [ ] Verify SSE streams close on all terminal paths tested above

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `test/llm/openai-compatible.test.ts` | Modify | Fix 4 stop_reason assertions + 1 error class assertion |
| `src/llm/adapters/openai-compatible.ts` | Modify | Verify/fix 503 → OverloadedError mapping |
| `test/server/gardens-draft.test.ts` | Modify | Fix content assertion mismatch (`digraph Drafted`) |
| `src/server/routes/gardens.ts` | Modify | Close SSE stream on draft completion/error/disconnect |
| `src/runtime/garden-draft-service.ts` | Modify | Ensure completion signal propagates to route handler |
| `src/server/routes/pipelines.ts` | Modify | Close SSE streams on run terminal states; fix context endpoint |
| `src/server/run-manager.ts` | Modify | Expose terminal state and active context for SSE close and context endpoint |
| `src/server/routes/events.ts` | Modify | Handle terminal run states in workspace event SSE |
| `src/server/workspace-event-bus.ts` | Modify | Clean up listeners on stream close |
| `src/server/event-journal.ts` | Modify | Support deterministic replay ceiling for finite pipeline event streams |
| `src/engine/retry.ts` | Modify | Patient preset multiplier: 2.0 → 3.0 |
| `test/engine/retry.test.ts` | Modify | Update patient preset test expectation |
| `test/llm/stream-accumulator.test.ts` | Create | Direct coverage for StreamAccumulator |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `npm test` passes with 0 failures across all test files
- [ ] No test timeout values were increased to achieve green
- [ ] No tests were skipped to achieve green (verified with `--reporter=verbose`)
- [ ] `test/llm/openai-compatible.test.ts` — all previously-failing tests pass with unified `FinishReasonValue` assertions
- [ ] HTTP 500 maps to `ServerError`; HTTP 503 maps to `OverloadedError` in the OpenAI-Compatible adapter
- [ ] `test/server/gardens-draft.test.ts` passes — content assertion fix addresses the actual `digraph Drafted` mismatch, not just stream lifecycle
- [ ] `/gardens/draft` emits exactly one terminal event (`draft_complete` or `draft_error`) and closes the response immediately afterward
- [ ] `/pipelines/:id/events` streams live events and closes automatically after a terminal pipeline event
- [ ] Opening `/pipelines/:id/events` for an already-terminal run returns the replay and then closes without hanging
- [ ] `GET /pipelines/:id/context` during an active run includes `current_node`
- [ ] Cancelling a run during bootstrap or active execution yields checkpoint status `interrupted` with reason `api_cancel`
- [ ] SSE endpoints clean up on client disconnect (no orphaned listeners)
- [ ] Seed-linked run lifecycle events are recorded in order without duplicates
- [ ] `test/llm/stream-accumulator.test.ts` exists and covers final response reconstruction
- [ ] `RETRY_PRESETS.patient.multiplier === 3.0` matching attractor spec `backoff_factor: 3.0`
- [ ] Compliance report GAPS section is empty — zero remaining gaps

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE lifecycle fixes are deeper than `res.end()` — event bus wiring or run-manager state machine issues | Medium | High | Instrument with targeted logging before fixing. If architectural, fix the minimum to unblock each test and document deeper debt. Phase 3 gets 45% of effort budget for this reason. |
| The 4 SSE timeout tests have 4 independent root causes, not 1 shared pattern | Medium | High | Start with `hive-run-flow` or `http-resume` (most representative). If issues are independent, prioritize `http-server` cancel — it may be a state machine bug, not SSE. |
| `http-server` cancel test is a state machine issue, not SSE | Medium | Medium | Investigate the actual assertion failure with verbose output before applying SSE fixes. The Codex critique flagged this as potentially distinct. |
| gardens-draft fix requires understanding the draft service prompt contract | Low | Low | The fix is either updating the mock or the assertion — both are local changes. Read the draft service to determine which is correct. |
| Cancel/resume races survive because bootstrap and active states still diverge | Medium | High | Keep explicit lifecycle states in `RunManager` and test cancellation during both bootstrap and active execution. |
| Replay ordering bugs appear when live events arrive during journal replay | Medium | High | Implement replay-ceiling model: capture journal sequence ceiling before replay, buffer live events, flush in order. |
| Patient preset multiplier change alters retry timing for existing pipelines | Low | Low | The `patient` preset is rarely used. Spec compliance is authoritative. |
| StreamAccumulator tests reveal bugs that expand scope | Medium | Medium | If bugs are found, file them for a future sprint rather than fixing in-line. Only fix if trivial (<10 min). |
| Browser clients treat normal SSE termination as an error and leave stale UI state | Medium | Medium | Verify Hive draft/run clients against the new finite-stream behavior and adjust only where necessary. |
| SSE reconnection mid-stream may not work correctly with new `res.end()` logic | Low | Medium | Out of scope for this sprint, but document as known limitation if observed. |

---

## Cut Line

If the sprint runs long, cut in this order (last cut first):

1. **StreamAccumulator test coverage** — Real value but not blocking green suite or compliance. Can ride a follow-up.
2. **Replay ceiling determinism** — If basic `res.end()` on terminal events is sufficient to pass the tests, defer the full replay-ceiling model.
3. **Patient retry preset** — One-line fix, can ride any future commit.

**Never cut:** OpenAI-Compatible test fixes (Phase 1), gardens-draft content fix (Phase 2), SSE lifecycle fixes (Phase 3 core). The entire point of this sprint is to make CI green.

---

## Dependencies

No new runtime dependencies. All changes use existing infrastructure:

| Existing Dependency | Used For |
|---|---|
| `vitest` | Test framework |
| `src/llm/errors.ts` | Error class hierarchy (ServerError, OverloadedError) |
| `src/llm/types.ts` | GenerateResponse, FinishReason, FinishReasonValue |
| `src/llm/stream-accumulator.ts` | Stream accumulation (test target) |
| `src/server/*` | SSE endpoint lifecycle |
| `src/engine/retry.ts` | Retry preset constants |
| `docs/upstream/attractor-spec.md` | Source of truth for patient preset parameters |
| `docs/upstream/unified-llm-spec.md` | Source of truth for error taxonomy |
