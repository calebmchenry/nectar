# Sprint 033: Hive Runtime Contract & Single-Exit Compliance

## Overview

**Goal:** Make the local Nectar server trustworthy enough for the Hive to depend on it, and close the two remaining high-severity compliance gaps that directly affect that surface. After this sprint: the HTTP integration suite is green in a network-capable environment, cancel/resume through `wait.human` is deterministic, seed-linked runs stay in sync with `meta.yaml` and `activity.jsonl`, gardens enforce the spec's single-exit rule, and Gemini `RECITATION` is normalized to `content_filter`.

**Why this sprint, why now:**

1. `INTENT.md` makes the localhost runtime the product contract for the Hive. If `/pipelines`, `/gardens/draft`, and `/seeds/:id/run` are not truthful, every browser feature above them is built on sand.
2. The compliance report says the remaining high-severity gaps are **A1** (terminal node must be exactly one exit) and **U19** (Gemini `RECITATION` should map to `content_filter`). A1 is not a cosmetic lint nit: it changes what gardens the server should accept, what the draft endpoint should generate, and what tests/examples must model.
3. Resume semantics are still muddy around human gates. An interrupted question is not a timeout. As long as those states are conflated, cancel/resume and seed-run linkage will keep producing ghost state.

**Scope:** HTTP run-state truth, human-gate interruption/resume semantics, seed-linked run lifecycle tracking, single-exit garden enforcement across validation and authoring routes, Gemini `RECITATION` finish-reason normalization, and regression coverage for the Hive-facing HTTP flows.

**Out of scope:**
- Model catalog refresh (`U3`)
- Optional Gemini `web_search` / `web_fetch` tool support (`C3`)
- `ProviderProfile` shape parity fields (`C4`, `C5`)
- Event naming renames, adapter lifecycle nits, or prompt-parity work
- New CLI commands, packaging, or UI design work

---

## Use Cases

1. **Run a garden from the Hive and trust the live state.** A browser posts to `POST /pipelines`, polls `GET /pipelines/:id`, `GET /pipelines/:id/context`, and `GET /pipelines/:id/graph`, and sees one coherent answer about the active node while the run is still executing.

2. **Cancel during a human gate and resume cleanly.** A run pauses on `wait.human`, the user cancels it, then resumes it later. The old question is marked interrupted, not timed out; `/questions` returns only the fresh pending question; answering the stale question ID returns `409`.

3. **Track a seed-linked run end-to-end on disk.** Starting a linked garden from `POST /seeds/:id/run` appends `run_started`, interruption appends `run_interrupted`, resume appends `run_resumed`, and successful completion appends `run_completed` exactly once each in `activity.jsonl`. `meta.yaml.linked_runs` stays correct and the seed remains `blooming` unless an explicit documented rule promotes it further.

4. **Reject non-compliant multi-exit gardens before execution.** A user previews, saves, or runs a DOT graph with two `Msquare` exits and gets a precise validation error that says the graph must have exactly one exit node. Nectar does not silently rewrite the graph.

5. **Draft compliant gardens from natural language.** `POST /gardens/draft` emits `draft_complete` only when the generated DOT passes preparation and validation, including the single-exit rule. If the model generates an invalid graph, the route emits `draft_error` with enough detail to debug it.

6. **Surface Gemini safety failures correctly.** If Gemini stops with `RECITATION`, the unified LLM client reports `content_filter`, so downstream code sees the same safety semantics it already gets for Gemini `SAFETY`.

---

## Architecture

### Opinionated Cut

This sprint is not another broad compliance sweep. It is a runtime-truth sprint.

- Do **not** spend this sprint on model catalog churn or optional provider-profile fields.
- Do **not** silently normalize user-authored DOT to satisfy A1. Validation must be honest.
- Do **not** let route handlers own business state. The run manager and lifecycle services should be the source of truth.

### Runtime Model

**1. `RunManager` becomes the live-state authority.**  
Active-run reads should prefer live engine state, then checkpoint state, then route-local cached state. `current_node` should never be absent from the HTTP surface just because an event append is racing a poll.

**2. Questions get a real interruption state.**  
`pending -> answered | timed_out | interrupted` is the right model. API cancel, server shutdown, and resume handoff are not timeouts. Resume creates new pending questions; it does not resurrect or overwrite stale ones.

**3. Seed lifecycle tracking moves out of route-local closures.**  
`routes/seeds.ts` currently owns transient subscription state. That is the wrong layer for a filesystem-backed product contract. Extract a dedicated bridge that subscribes to run events, writes seed lifecycle transitions idempotently, and emits workspace events from fresh seed state.

**4. Single-exit is enforced at the authoring boundary.**  
The validator changes from "at least one exit" to "exactly one root exit." Drafting, preview, save, and run surfaces must all respect that. Branching approval flows should converge to one physical exit node.

### Data Flow

```text
HTTP route
  -> RunManager / SeedRunBridge / GardenDraftService
  -> live engine state or QuestionStore or SeedLifecycleService
  -> filesystem state (.nectar/, seedbed/, gardens/)
  -> HTTP response / SSE / workspace event
```

The point is simple: browser-visible state must come from the same underlying services that own on-disk truth.

---

## Implementation Phases

### Phase 1: Active Run Truth and Failure Contract (~25%)

**Files:** `src/server/run-manager.ts`, `src/server/routes/pipelines.ts`, `src/runtime/pipeline-service.ts`, `src/server/types.ts`, `test/integration/http-server.test.ts`, `test/server/pipeline-events.test.ts`

**Tasks:**
- [ ] Add a live-state resolver inside `RunManager` so `getStatus()`, `getContext()`, and `getGraphExecutionState()` overlay `engine.getContextSnapshot()` when a run is active.
- [ ] Stop relying on route-time inference for `current_node`. Clear or advance it deterministically on `node_completed`, `run_interrupted`, `run_error`, and `run_completed`.
- [ ] Make the create-vs-fail boundary explicit:
  - structurally invalid pipeline -> `400 VALIDATION_ERROR`
  - structurally valid pipeline that fails during execution -> `202`, then terminal failure events
- [ ] Update failure fixtures/tests so they use a valid graph with one explicit exit node, while still exercising `stage_failed -> run_error -> pipeline_failed`.
- [ ] Add regression coverage for active `current_node` visibility and terminal failure event ordering.

### Phase 2: Human-Gate Interruption and Resume Semantics (~25%)

**Files:** `src/server/question-store.ts`, `src/server/http-interviewer.ts`, `src/server/routes/pipelines.ts`, `src/server/types.ts`, `test/integration/http-resume.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/server/question-store.test.ts`

**Tasks:**
- [ ] Extend stored-question state to distinguish `interrupted` from `timed_out`.
- [ ] Replace the current one-size-fits-all `close()` behavior with an explicit disposition API so cancel/shutdown/resume handoff persist the right terminal question state.
- [ ] Ensure `POST /pipelines/:id/cancel` marks any pending question for that run as interrupted.
- [ ] Ensure resume does not surface stale question files. On resume, interrupted questions are archived or ignored, and new `wait.human` pauses create fresh pending records.
- [ ] Make `POST /pipelines/:id/questions/:qid/answer` return `409` when the question is no longer pending.
- [ ] Add end-to-end coverage for cancel during `wait.human` -> resume -> answer -> complete.

### Phase 3: Seed-Linked Run Bridge and Filesystem Truth (~20%)

**Files:** `src/server/routes/seeds.ts`, `src/server/seed-run-bridge.ts`, `src/seedbed/lifecycle.ts`, `src/seedbed/activity.ts`, `src/server/workspace-event-bus.ts`, `test/integration/seed-run-linkage.test.ts`

**Tasks:**
- [ ] Extract run-to-seed subscription logic from `routes/seeds.ts` into a dedicated `SeedRunBridge` service.
- [ ] Make bridge attachment idempotent per `(seed_id, run_id)` so resume cannot double-subscribe or double-write lifecycle events.
- [ ] Record `run_started`, `run_resumed`, `run_interrupted`, `run_completed`, and `run_failed` exactly once each using idempotency keys.
- [ ] Emit `seed_updated` workspace events using freshly loaded seed metadata, not stale route-captured status/priority.
- [ ] Preserve INTENT's file-system-first contract: `meta.yaml` and `activity.jsonl` remain the canonical record of seed/run linkage.
- [ ] Add regression coverage for ordered seed activity events and stable `meta.yaml.linked_runs`.

### Phase 4: Single-Exit Garden Compliance at the Authoring Boundary (~20%)

**Files:** `src/garden/validate.ts`, `src/runtime/garden-draft-service.ts`, `src/server/routes/gardens.ts`, `src/runtime/pipeline-service.ts`, `test/garden/validate.test.ts`, `test/server/gardens-draft.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/seed-run-linkage.test.ts`

**Tasks:**
- [ ] Change the `terminal_node` rule from "at least one exit" to "exactly one root exit node."
- [ ] Emit a precise diagnostic code/message that tells users how many exits were found.
- [ ] Tighten the garden draft system prompt so it explicitly requires exactly one `Msquare` exit node.
- [ ] Validate generated draft DOT before emitting `draft_complete`; emit `draft_error` with diagnostics when validation fails.
- [ ] Update HTTP integration fixtures and sample branching graphs so they converge on one physical exit node instead of multiple exits.
- [ ] Keep composition behavior aligned: composed/imported gardens must still resolve to a graph with one root start and one root exit.

### Phase 5: Gemini Finish-Reason Normalization and Report Refresh (~10%)

**Files:** `src/llm/adapters/gemini.ts`, `test/llm/adapters/gemini.test.ts`, `docs/compliance-report.md`

**Tasks:**
- [ ] Map Gemini `RECITATION` to unified finish reason `content_filter`.
- [ ] Cover both non-streaming and streaming end states in adapter tests.
- [ ] Update `docs/compliance-report.md` to move **A1** and **U19** from GAPS to IMPLEMENTED once the sprint work lands.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/run-manager.ts` | Modify | Make live engine state authoritative for status/context/graph reads |
| `src/server/routes/pipelines.ts` | Modify | Tighten create/cancel/question HTTP contract and failure sequencing |
| `src/runtime/pipeline-service.ts` | Modify | Keep structural validation boundary explicit for create/resume flows |
| `src/server/types.ts` | Modify | Extend stored-question and HTTP contract types |
| `src/server/question-store.ts` | Modify | Add explicit interrupted-question semantics and stricter answer acceptance |
| `src/server/http-interviewer.ts` | Modify | Keep HTTP interviewer aligned with new question lifecycle rules |
| `src/server/seed-run-bridge.ts` | Create | Centralize run-event -> seed lifecycle synchronization |
| `src/server/routes/seeds.ts` | Modify | Use bridge instead of route-local tracking closures |
| `src/seedbed/lifecycle.ts` | Modify | Record run transitions idempotently and preserve filesystem truth |
| `src/seedbed/activity.ts` | Modify | Support deterministic activity appends where needed |
| `src/server/workspace-event-bus.ts` | Modify | Emit workspace updates from fresh seed state |
| `src/garden/validate.ts` | Modify | Enforce exactly one root exit node |
| `src/runtime/garden-draft-service.ts` | Modify | Generate and validate single-exit draft DOT before completion |
| `src/server/routes/gardens.ts` | Modify | Surface draft/preview validation failures cleanly |
| `src/llm/adapters/gemini.ts` | Modify | Map `RECITATION` to `content_filter` |
| `docs/compliance-report.md` | Modify | Record closure of A1 and U19 |
| `test/integration/http-server.test.ts` | Modify | Assert live state truth during active runs |
| `test/server/pipeline-events.test.ts` | Modify | Assert valid-create/runtime-fail boundary and terminal event order |
| `test/integration/http-resume.test.ts` | Modify | Assert cancel/resume semantics through HTTP |
| `test/integration/hive-run-flow.test.ts` | Modify | Assert one-exit human-gate flow through preview/run/resume |
| `test/integration/seed-run-linkage.test.ts` | Modify | Assert seed lifecycle ordering and linked run truth on disk |
| `test/server/gardens-draft.test.ts` | Modify | Assert draft endpoint only completes with valid single-exit DOT |
| `test/server/question-store.test.ts` | Create | Unit coverage for interrupted vs timed-out question states |
| `test/garden/validate.test.ts` | Modify | Assert exact-one-exit validation behavior |
| `test/llm/adapters/gemini.test.ts` | Modify | Assert `RECITATION -> content_filter` |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero TypeScript errors.
- [ ] The HTTP integration suite is green in a network-capable environment: `test/integration/http-server.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/seed-run-linkage.test.ts`, `test/server/pipeline-events.test.ts`, and `test/server/gardens-draft.test.ts`.
- [ ] No test timeout values were increased to get green.
- [ ] `GET /pipelines/:id`, `GET /pipelines/:id/context`, and `GET /pipelines/:id/graph` agree on the active node during a running pipeline.
- [ ] Cancelling a run paused on `wait.human` marks its pending question as `interrupted`, not `timed_out`.
- [ ] Resuming that run surfaces a fresh pending question and rejects answers to the stale question ID with `409`.
- [ ] `POST /seeds/:id/run` followed by interrupt/resume/complete writes exactly one `run_started`, `run_interrupted`, `run_resumed`, and `run_completed` event in `activity.jsonl`.
- [ ] `meta.yaml.linked_runs` remains correct after start, interrupt, and resume.
- [ ] Graph validation rejects any root graph with zero exits or more than one root exit.
- [ ] `POST /gardens/draft` never emits `draft_complete` with a graph that violates the single-exit rule.
- [ ] All updated example and integration fixtures use one physical exit node.
- [ ] Gemini `RECITATION` is normalized to `content_filter`.
- [ ] `docs/compliance-report.md` no longer lists A1 or U19 as open gaps.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Enforcing single-exit graphs breaks existing fixtures, examples, or user-authored gardens | High | High | Update all built-in fixtures in the sprint and emit a precise diagnostic with an obvious fix path: converge branches to one exit node. |
| Question-state changes create compatibility issues with already-written question JSON files | Medium | Medium | Default unknown historic records to existing behavior, add backward-compatible deserialization, and only write the new `interrupted` state for newly closed questions. |
| Seed lifecycle bridge double-writes activity events when replay and live subscription overlap | Medium | High | Key every transition by `(seed_id, run_id, transition)` and keep event handling idempotent. |
| Live-state overlay makes status reads inconsistent with persisted checkpoints | Medium | Medium | Define a strict precedence order: active engine snapshot > in-memory entry > checkpoint. Test all three code paths. |
| Draft validation increases the number of `draft_error` responses temporarily | Medium | Low | Tighten the draft prompt first, validate before completion, and include actionable diagnostics in the terminal error event. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing `RunManager`, `RunStore`, and `PipelineEngine` infrastructure | Source of truth for live and persisted pipeline state |
| Existing `QuestionStore` / `HttpInterviewer` stack | Human-gate persistence and resume behavior |
| Existing `SeedStore`, `SeedLifecycleService`, and `SeedActivityStore` | File-system-first seed metadata and activity tracking |
| Existing `PipelinePreparer` and garden validation pipeline | Enforce the single-exit rule consistently across preview/save/run/draft |
| Existing `UnifiedClient` / Gemini adapter test harness | Verify `RECITATION -> content_filter` without broad LLM refactors |
| `vitest` | Regression coverage for the Hive-facing runtime contract |

No new runtime packages should be added for this sprint.
