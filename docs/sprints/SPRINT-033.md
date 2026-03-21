# Sprint 033: Hive Runtime Truth & Green Suite

## Overview

**Goal:** Make the local Nectar server trustworthy enough for the Hive to depend on it by fixing the 6 integration tests that have been red for 8 consecutive sprints, establishing deterministic cancel/resume semantics through `wait.human`, enforcing the spec's single-exit rule at every authoring boundary, and normalizing Gemini `RECITATION` to `content_filter`. After this sprint: `npm test` is green with zero timeouts, the HTTP integration suite is reliable, cancel/resume through human gates is deterministic, seed-linked runs stay in sync on disk, and gaps A1 and U19 are closed.

**Why this sprint, why now:**

1. **The red suite is the longest-standing defect in the project.** 6 integration tests have failed continuously across sprints 025–032. The root causes are now well-understood (SSE deferred close race condition, `withLiveCurrentNode()` logic error, pipeline creation body validation) but have never been fixed together in a single focused effort. Previous sprints failed because they mixed test fixes with large feature work.

2. **`INTENT.md` makes the localhost runtime the product contract for the Hive.** If `/pipelines`, `/gardens/draft`, and `/seeds/:id/run` are not truthful, every browser feature above them is built on sand. The runtime must be correct before product work can proceed.

3. **Resume semantics are still muddy around human gates.** An interrupted question is not a timeout. As long as those states are conflated, cancel/resume and seed-run linkage will keep producing ghost state.

4. **The remaining high-severity compliance gaps (A1, U19) directly affect the runtime surface.** A1 changes what gardens the server should accept. U19 means Gemini safety failures are misclassified.

**Scope:** Fix 6 failing integration tests, establish HTTP run-state truth, clean `wait.human` interruption/resume semantics, seed-linked run lifecycle persistence, single-exit garden enforcement across validation and authoring routes, Gemini `RECITATION` finish-reason normalization.

**Out of scope:**
- Model catalog refresh (U3), optional provider-profile fields (C3, C4, C5)
- Event naming renames (A4), tool parameter renames (C9, C10, C11)
- ReadWriteLock implementation (A2 — JS event loop + context clones already provides the spec's safety guarantee)
- Provider-specific system prompts (C12)
- Unified LLM interface shape additions (U1–U12)
- New CLI commands, packaging, UI design, or architecture refactoring

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures, zero timeouts. No test timeout values inflated.

2. **SSE streams close synchronously on terminal events.** A test client or browser opening `/pipelines/:id/events` receives all events during execution and the stream closes immediately (not deferred via `setTimeout`) after the terminal event.

3. **Run a garden from the Hive and trust the live state.** A browser posts to `POST /pipelines`, polls `GET /pipelines/:id`, `GET /pipelines/:id/context`, and `GET /pipelines/:id/graph`, and sees one coherent answer about the active node while the run is still executing.

4. **Pipeline creation accepts valid DOT source.** `POST /pipelines` with a `dot_source` body returns 202, not 400.

5. **Cancel during a human gate and resume cleanly.** A run pauses on `wait.human`, the user cancels it, then resumes it later. The old question is marked interrupted, not timed out; `/questions` returns only the fresh pending question; answering the stale question ID returns `409`.

6. **Track a seed-linked run end-to-end on disk.** Starting a linked garden from `POST /seeds/:id/run` appends `run_started`, interruption appends `run_interrupted`, resume appends `run_resumed`, and successful completion appends `run_completed` exactly once each in `activity.jsonl`. `meta.yaml.linked_runs` stays correct.

7. **Reject non-compliant multi-exit gardens before execution.** A user previews, saves, or runs a DOT graph with two `Msquare` exits and gets a precise validation error. Nectar does not silently rewrite the graph.

8. **Draft compliant gardens from natural language.** `POST /gardens/draft` emits `draft_complete` only when the generated DOT passes preparation and validation, including the single-exit rule. Invalid graphs emit `draft_error` with actionable diagnostics.

9. **Surface Gemini safety failures correctly.** If Gemini stops with `RECITATION`, the unified LLM client reports `content_filter`.

---

## Architecture

### Test Fix Strategy: Root-Cause-First

Previous sprints failed because they treated test failures as a side effect of missing features. The actual root causes are three distinct bugs:

**Bug 1: Deferred SSE close creates race conditions (4 tests)**

`createFiniteSseStream()` in `src/server/sse.ts` uses `setTimeout(..., 0)` to schedule stream close after a terminal event. The close happens on the next event loop tick, not immediately after the terminal event is written. In tests, assertions run between the event write and the deferred close, causing timeouts.

Fix: Replace `scheduleTerminalClose()` with a synchronous `core.close()` call. The terminal event has already been written to the response buffer — there is no reason to defer the close.

```
Current:  send terminal event → schedule close (setTimeout 0) → ❌ test asserts before close fires
Fixed:    send terminal event → close immediately → ✅ test sees stream end
```

**Bug 2: `withLiveCurrentNode()` condition is inverted (1 test)**

The condition `if (!currentNode || context.current_node)` returns early when `currentNode` is falsy OR when `context.current_node` already exists. The `||` should split into two separate guard checks.

Fix: `if (!currentNode) return context; if (context.current_node) return context;`

**Bug 3: Pipeline creation validation rejects valid DOT (1 test)**

`POST /pipelines` returns 400 when sending `dot_source`. Requires tracing the exact error response body to identify which validation step rejects it.

Fix: Diagnose the exact 400 response, trace through `readJson()` → `startPipeline()` → validation, and fix the identified parsing or validation bug.

### Runtime Model

**1. `RunManager` becomes the live-state authority.** Active-run reads prefer live engine state, then checkpoint state, then route-local cached state. `current_node` is never absent from the HTTP surface just because an event append is racing a poll.

**2. Questions get a real interruption state.** `pending → answered | timed_out | interrupted` is the right model. API cancel, server shutdown, and resume handoff are not timeouts. Resume creates new pending questions; it does not resurrect stale ones.

**3. Seed lifecycle tracking moves out of route-local closures.** `routes/seeds.ts` currently owns transient subscription state. Extract a dedicated bridge that subscribes to run events, writes seed lifecycle transitions idempotently, and emits workspace events from fresh seed state.

**4. Single-exit is enforced at the authoring boundary.** The validator changes from "at least one exit" to "exactly one root exit." Drafting, preview, save, and run surfaces must all respect that.

---

## Implementation

### Phase 1: Fix the 6 Failing Tests (~25%)

**Hard rule:** Phase 2 does not begin until `npm test` is green.

**Files:** `src/server/sse.ts`, `src/server/run-manager.ts`, `src/server/routes/pipelines.ts`, `test/server/sse-lifecycle.test.ts`

**Tasks:**
- [ ] **SSE synchronous close:** In `src/server/sse.ts`, replace `scheduleTerminalClose()` with an immediate `core.close()` call after writing the terminal event. Remove the `pendingCloseTimer` state.
- [ ] **`withLiveCurrentNode()` fix:** In `src/server/run-manager.ts`, change the guard from `if (!currentNode || context.current_node)` to two separate checks.
- [ ] **Pipeline creation 400 diagnosis:** Log the exact 400 response body from `POST /pipelines`. Trace the rejection through `readJson()` → `startPipeline()` → validation. Fix the identified bug.
- [ ] **Run the full test suite.** All 6 previously-failing tests must pass. No other tests may regress.
- [ ] **Add SSE guard test:** Assert `createFiniteSseStream` closes the response synchronously (same tick) after a terminal event.
- [ ] **Add abandoned-stream safety net:** Ensure there is a cleanup path for SSE streams where no terminal event is ever written (idle timeout or connection-close handler).

### Phase 2: Active Run Truth and Failure Contract (~15%)

**Files:** `src/server/run-manager.ts`, `src/server/routes/pipelines.ts`, `src/runtime/pipeline-service.ts`, `src/server/types.ts`, `test/integration/http-server.test.ts`, `test/server/pipeline-events.test.ts`

**Tasks:**
- [ ] Add a live-state resolver inside `RunManager` so `getStatus()`, `getContext()`, and `getGraphExecutionState()` overlay `engine.getContextSnapshot()` when a run is active.
- [ ] Stop relying on route-time inference for `current_node`. Clear or advance it deterministically on `node_completed`, `run_interrupted`, `run_error`, and `run_completed`.
- [ ] Make the create-vs-fail boundary explicit: structurally invalid pipeline → `400 VALIDATION_ERROR`; structurally valid pipeline that fails during execution → `202`, then terminal failure events.
- [ ] Update failure fixtures/tests so they use a valid graph with one explicit exit node.
- [ ] Add regression coverage for active `current_node` visibility and terminal failure event ordering.

### Phase 3: Human-Gate Interruption and Resume Semantics (~20%)

**Files:** `src/server/question-store.ts`, `src/server/http-interviewer.ts`, `src/server/routes/pipelines.ts`, `src/server/types.ts`, `test/integration/http-resume.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/server/question-store.test.ts`

**Tasks:**
- [ ] Extend stored-question state to distinguish `interrupted` from `timed_out`.
- [ ] Replace the current one-size-fits-all `close()` behavior with an explicit disposition API so cancel/shutdown/resume handoff persist the right terminal question state.
- [ ] Ensure `POST /pipelines/:id/cancel` marks any pending question as interrupted.
- [ ] Ensure resume does not surface stale question files. On resume, interrupted questions are archived or ignored; new `wait.human` pauses create fresh pending records.
- [ ] Make `POST /pipelines/:id/questions/:qid/answer` return `409` when the question is no longer pending.
- [ ] Default unknown historic question records to existing behavior (backward-compatible deserialization).
- [ ] Add end-to-end coverage for cancel during `wait.human` → resume → answer → complete.

### Phase 4: Seed-Linked Run Bridge and Filesystem Truth (~15%)

**Files:** `src/server/routes/seeds.ts`, `src/server/seed-run-bridge.ts` (create), `src/seedbed/lifecycle.ts`, `src/seedbed/activity.ts`, `src/server/workspace-event-bus.ts`, `test/integration/seed-run-linkage.test.ts`

**Tasks:**
- [ ] Extract run-to-seed subscription logic from `routes/seeds.ts` into a dedicated `SeedRunBridge` service.
- [ ] Make bridge attachment idempotent per `(seed_id, run_id)` so resume cannot double-subscribe or double-write lifecycle events.
- [ ] Record `run_started`, `run_resumed`, `run_interrupted`, `run_completed`, and `run_failed` exactly once each using idempotency keys.
- [ ] Emit `seed_updated` workspace events using freshly loaded seed metadata, not stale route-captured status/priority.
- [ ] Preserve INTENT's file-system-first contract: `meta.yaml` and `activity.jsonl` remain the canonical record of seed/run linkage.
- [ ] Add regression coverage for ordered seed activity events, stable `meta.yaml.linked_runs`, and the `run_failed` path.

### Phase 5: Single-Exit Garden Compliance at the Authoring Boundary (~15%)

**Files:** `src/garden/validate.ts`, `src/runtime/garden-draft-service.ts`, `src/server/routes/gardens.ts`, `src/runtime/pipeline-service.ts`, `test/garden/validate.test.ts`, `test/server/gardens-draft.test.ts`, `test/integration/hive-run-flow.test.ts`

**Tasks:**
- [ ] Change the `terminal_node` rule from "at least one exit" to "exactly one root exit node."
- [ ] Emit a precise diagnostic code/message that tells users how many exits were found.
- [ ] Audit all `.dot` files in the repo for multiple exit nodes. Update fixtures and examples to converge on one physical exit node.
- [ ] Tighten the garden draft system prompt to explicitly require exactly one `Msquare` exit node.
- [ ] Validate generated draft DOT before emitting `draft_complete`; emit `draft_error` with diagnostics when validation fails.
- [ ] Keep composition behavior aligned: composed/imported gardens must resolve to a graph with one root start and one root exit.
- [ ] Add coverage for: 0 exits, 2+ exits, imported-subgraph exit counting, and draft recovery on invalid generation.

### Phase 6: Gemini Finish-Reason Normalization and Report Refresh (~10%)

**Files:** `src/llm/adapters/gemini.ts`, `test/llm/adapters/gemini.test.ts`, `docs/compliance-report.md`

**Tasks:**
- [ ] Map Gemini `RECITATION` to unified finish reason `content_filter`.
- [ ] Cover both non-streaming and streaming end states in adapter tests.
- [ ] Update `docs/compliance-report.md` to move A1 and U19 from GAPS to IMPLEMENTED.
- [ ] Verify the remaining gaps are accurately described for Sprint 034 planning.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/sse.ts` | Modify | Replace deferred close with synchronous close on terminal events |
| `src/server/run-manager.ts` | Modify | Fix `withLiveCurrentNode()` guard; make live engine state authoritative |
| `src/server/routes/pipelines.ts` | Modify | Fix pipeline creation validation; tighten HTTP contract |
| `src/runtime/pipeline-service.ts` | Modify | Keep structural validation boundary explicit |
| `src/server/types.ts` | Modify | Extend stored-question and HTTP contract types |
| `src/server/question-store.ts` | Modify | Add interrupted-question semantics and stricter answer acceptance |
| `src/server/http-interviewer.ts` | Modify | Align with new question lifecycle rules |
| `src/server/seed-run-bridge.ts` | Create | Centralize run-event → seed lifecycle synchronization |
| `src/server/routes/seeds.ts` | Modify | Use bridge instead of route-local tracking closures |
| `src/seedbed/lifecycle.ts` | Modify | Record run transitions idempotently |
| `src/seedbed/activity.ts` | Modify | Support deterministic activity appends |
| `src/server/workspace-event-bus.ts` | Modify | Emit workspace updates from fresh seed state |
| `src/garden/validate.ts` | Modify | Enforce exactly one root exit node |
| `src/runtime/garden-draft-service.ts` | Modify | Generate and validate single-exit draft DOT |
| `src/server/routes/gardens.ts` | Modify | Surface draft/preview validation failures cleanly |
| `src/llm/adapters/gemini.ts` | Modify | Map `RECITATION` to `content_filter` |
| `docs/compliance-report.md` | Modify | Record closure of A1 and U19 |
| `test/server/sse-lifecycle.test.ts` | Modify | SSE synchronous-close guard test |
| `test/server/question-store.test.ts` | Create | Unit coverage for interrupted vs timed-out question states |
| `test/integration/http-server.test.ts` | Modify | Assert live state truth during active runs |
| `test/server/pipeline-events.test.ts` | Modify | Assert failure boundary and terminal event order |
| `test/integration/http-resume.test.ts` | Modify | Assert cancel/resume semantics through HTTP |
| `test/integration/hive-run-flow.test.ts` | Modify | Assert one-exit human-gate flow |
| `test/integration/seed-run-linkage.test.ts` | Modify | Assert seed lifecycle ordering and linked run truth on disk |
| `test/server/gardens-draft.test.ts` | Modify | Assert draft endpoint validates single-exit DOT |
| `test/garden/validate.test.ts` | Modify | Assert exact-one-exit validation behavior |
| `test/llm/adapters/gemini.test.ts` | Modify | Assert `RECITATION → content_filter` |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts
- [ ] No test timeout values were increased to achieve green
- [ ] No existing tests regressed
- [ ] The 6 previously-failing integration tests all pass: hive-run-flow, http-resume, http-server, seed-run-linkage, gardens-draft, pipeline-events
- [ ] `createFiniteSseStream` closes the response on the same event loop tick as the terminal event (no `setTimeout`)
- [ ] Abandoned SSE streams have a cleanup path (idle timeout or connection-close handler)
- [ ] `GET /pipelines/:id`, `GET /pipelines/:id/context`, and `GET /pipelines/:id/graph` agree on the active node during a running pipeline
- [ ] `POST /pipelines` with valid `dot_source` body returns 202
- [ ] Cancelling a run paused on `wait.human` marks its pending question as `interrupted`, not `timed_out`
- [ ] Resuming that run surfaces a fresh pending question and rejects answers to the stale question ID with `409`
- [ ] Older question records deserialize safely with backward-compatible defaults
- [ ] `POST /seeds/:id/run` followed by interrupt/resume/complete writes exactly one `run_started`, `run_interrupted`, `run_resumed`, and `run_completed` event in `activity.jsonl`
- [ ] `run_failed` is also written exactly once on the failure path
- [ ] `meta.yaml.linked_runs` remains correct after start, interrupt, resume, and failure
- [ ] Graph validation rejects any root graph with zero exits or more than one root exit
- [ ] `POST /gardens/draft` never emits `draft_complete` with a graph that violates the single-exit rule
- [ ] All updated example and integration fixtures use one physical exit node
- [ ] Gemini `RECITATION` is normalized to `content_filter` in both streaming and non-streaming paths
- [ ] `docs/compliance-report.md` no longer lists A1 or U19 as open gaps

---

## Drop Line

If this sprint runs long, cut in this order (last item cut first):

1. **Keep:** Phase 1 (green suite) — this is the hard gate, non-negotiable
2. **Keep:** Phase 2 (active run truth) — directly fixes test reliability
3. **Keep:** Phase 5 (single-exit / A1) — high-severity compliance gap
4. **Keep:** Phase 6 (Gemini RECITATION / U19) — high-severity compliance gap
5. **Defer first:** Phase 4 (seed-linked run bridge) — valuable but can land in Sprint 034
6. **Defer second:** Phase 3 (human-gate semantics) — valuable but the existing behavior is functional if imprecise

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE synchronous close causes events to be dropped before flush | Low | High | The terminal event is already written to the response buffer before close is called. `res.end()` flushes the buffer. Verify with a test that reads the terminal event from the response body. |
| Pipeline creation 400 has a deeper cause than expected | Medium | High | Phase 1 requires logging the exact error response body before attempting a fix. If root cause is complex, isolate as a focused debugging task. |
| Enforcing single-exit graphs breaks existing fixtures, examples, or user-authored gardens | High | High | Audit all `.dot` files before tightening validation. Update all built-in fixtures in the sprint. Emit a precise diagnostic with an obvious fix path. |
| Question-state changes create compatibility issues with existing question JSON files | Medium | Medium | Default unknown historic records to existing behavior. Add backward-compatible deserialization. Only write the new `interrupted` state for newly closed questions. |
| Seed lifecycle bridge double-writes activity events when replay and live subscription overlap | Medium | High | Key every transition by `(seed_id, run_id, transition)` and keep event handling idempotent. |
| Live-state overlay makes status reads inconsistent with persisted checkpoints | Medium | Medium | Define strict precedence order: active engine snapshot > in-memory entry > checkpoint. Test all three code paths. |
| Abandoned SSE streams with no terminal event leak resources | Medium | Medium | Add a server-side idle timeout or connection-close handler as a safety net. |
| Cancel and answer race during `wait.human` (user answers while another client cancels) | Medium | Medium | Define that the first transition wins; the loser sees `409`. Test the race explicitly. |
| Server restart between interrupt and resume loses question state | Low | High | Interrupted questions are persisted to disk immediately on cancel. Resume reads from disk, not in-memory state. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing `RunManager`, `RunStore`, and `PipelineEngine` infrastructure | Source of truth for live and persisted pipeline state |
| Existing `QuestionStore` / `HttpInterviewer` stack | Human-gate persistence and resume behavior |
| Existing `SeedStore`, `SeedLifecycleService`, and `SeedActivityStore` | File-system-first seed metadata and activity tracking |
| Existing `PipelinePreparer` and garden validation pipeline | Enforce the single-exit rule across preview/save/run/draft |
| Existing `UnifiedClient` / Gemini adapter test harness | Verify `RECITATION → content_filter` without broad LLM refactors |
| `vitest` | Regression coverage for the Hive-facing runtime contract |
| No new runtime packages | All changes are to existing modules |
