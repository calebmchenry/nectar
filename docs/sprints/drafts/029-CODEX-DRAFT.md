# Sprint 029: Green Runtime, Hive Reliability & Final Compliance Closure

## Overview

**Goal:** Make Nectar's local runtime trustworthy enough that the Hive can draft, run, cancel, resume, and replay pipelines without hanging, while also closing the final known spec mismatch in `docs/compliance-report.md` (`patient` retry preset multiplier).

**Scope:** Server-side SSE lifecycle, active run snapshot truth, seed-linked run lifecycle convergence, green-suite restoration, and exact retry preset compliance. This is intentionally a reliability sprint, not a feature-landgrab sprint.

**Why this sprint, why now:**

1. **The compliance report no longer justifies another broad spec sprint.** It shows one tiny Attractor gap, not a missing subsystem.
2. **The biggest remaining INTENT gap is product trust.** The Hive cannot count as "polished" while draft streams hang, run event streams fail to terminate cleanly, active context can lie during execution, and seed-linked run flows race.
3. **The old INTENT note that "next sprint must prioritize parallel execution" is stale.** Parallel fan-out/fan-in is already implemented per `docs/compliance-report.md`; runtime stability is now the bottleneck.
4. **Green tests are a release gate, not cleanup.** `gardens-draft`, `hive-run-flow`, `http-resume`, `http-server`, and `seed-run-linkage` are failing exactly where the browser-backed product is supposed to shine.

**Out of scope:**

- New Hive visual polish, dark mode, or design refresh
- New seedbed features beyond run/state correctness
- CLI parity work such as `nectar watch`, graph rendering, or HTTP-driven question answering
- Bun single-binary packaging and GitHub release automation
- New provider features or LLM contract changes beyond test alignment and coverage

---

## Use Cases

1. **Draft a garden from the Hive without a hanging request.** The browser posts to `/gardens/draft`, receives `draft_start`, one or more `content_delta` events, then exactly one terminal event (`draft_complete` or `draft_error`). The response closes immediately afterward.

2. **Run a garden from the Hive and trust the live state.** The browser starts a run, opens `/pipelines/:id/events`, and sees deterministic replay + live events. `GET /pipelines/:id/context` always includes the current node while the run is active.

3. **Cancel and resume a run without race conditions.** A user cancels during engine bootstrap or mid-node execution. Nectar persists an interrupted checkpoint with reason `api_cancel`, closes the event stream cleanly, and allows `POST /pipelines/:id/resume` to continue the same run to completion.

4. **Answer a human gate after resume and finish normally.** A Hive-launched run reaches `wait.human`, is interrupted, resumed, and re-enters the question flow without duplicate questions or a dead event stream.

5. **Launch a linked garden from a seed and trust the filesystem.** `meta.yaml` records the linked run once, status auto-promotes to `blooming` on start/resume, `activity.jsonl` records `run_started`, `run_interrupted`, `run_resumed`, and `run_completed` in order, and the seed detail endpoint can derive a `honey` suggestion from the completed linked run.

6. **Replay run history deterministically.** Opening `/pipelines/:id/events` after completion returns the full journal. Opening it with `Last-Event-ID` or `?last_event_id=` replays only newer events and terminates cleanly when caught up.

7. **Ship with a green suite and exact retry semantics.** `npm test` passes with zero failures, no timeout inflation, `test/llm/openai-compatible.test.ts` reflects the unified response contract, `StreamAccumulator` has direct coverage, and the `patient` retry preset uses the spec-correct 3.0 multiplier.

---

## Architecture

### One source of truth for active runs

`RunManager` should become the authoritative source for active-run snapshots. Routes should not stitch together status from half-live engine state plus half-stale checkpoint files.

After this sprint, `RunManager` owns:

- Current lifecycle state (`booting`, `running`, `cancelling`, `terminal`)
- Latest `current_node`
- Latest visible context snapshot, with fallback when the engine has not emitted yet
- Terminal reason/status for clean SSE shutdown
- Journal replay ceiling for deterministic catch-up behavior

Opinionated rule: **if `/pipelines/:id` says a run is active, `/pipelines/:id/context` must never pretend the run has no current node.**

### SSE needs an explicit contract

The current code mostly works, but each route hand-rolls its own close logic. That is why the failures cluster around hangs.

Introduce a shared SSE helper with two clear modes:

- **Finite stream** for `/gardens/draft` and `/pipelines/:id/events`
  - Sends headers
  - Writes keepalives
  - Guarantees `close()` is idempotent
  - Guarantees exactly one terminal close path
- **Persistent stream** for `/events`
  - Sends headers and keepalives
  - Cleans up watchers/subscriptions on disconnect
  - Never relies on terminal business events

Opinionated rule: **no route should call `res.end()` from three different branches ever again.**

### Journal replay must stay monotonic

`/pipelines/:id/events` should use a strict replay model:

1. Capture the journal sequence ceiling before replay starts.
2. Replay persisted events up to that ceiling.
3. Buffer live events that arrive during replay.
4. Flush buffered live events in sequence order.
5. Stay subscribed only until a terminal pipeline event is emitted, then close.

This keeps browser reconnects, resume flows, and `Last-Event-ID` replays deterministic.

### Seed/run lifecycle bridging belongs in one module

`routes/seeds.ts` currently owns too much run-tracking logic inline. Extract that bridge into a dedicated server-side module so the seedbed and run manager stop communicating through route-local closures.

That module should own:

- Subscribing to run events for linked seed launches
- Recording idempotent lifecycle transitions in `activity.jsonl`
- Updating `meta.yaml` linkage/state through `SeedLifecycleService`
- Emitting workspace semantic events after meaningful changes

Opinionated rule: **route files should validate requests and delegate; they should not be mini state machines.**

### This sprint does not redesign the product

No new transport. No WebSocket rewrite. No broad Hive rewrite. Fix the contracts already chosen:

- Node HTTP + SSE
- Run journal replay
- Filesystem-backed seed state
- Existing Hive `EventSource` and fetch clients

---

## Implementation Phases

### Phase 1: Active Run Snapshot Truth & Shared SSE Helper (~35%)

**Files:** `src/server/run-manager.ts`, `src/server/router.ts`, `src/server/types.ts`, `src/server/sse.ts` (new)

**Tasks:**
- [ ] Add a shared internal SSE helper for finite and persistent streams: headers, keepalive, idempotent close, disconnect cleanup
- [ ] Add an explicit run snapshot shape in server types so routes ask for one object instead of reconstructing state ad hoc
- [ ] Teach `RunManager` to expose a live snapshot for status, context, current node, interruption reason, and terminal lifecycle state
- [ ] Ensure `getContext()` overlays `current_node` from live run state when the raw engine snapshot is empty or not yet initialized
- [ ] Preserve the existing cancel-before-bootstrap fix, but harden it so a booting run always transitions to a single interrupted terminal state
- [ ] Make terminal run state observable without waiting on eventual cleanup timers

### Phase 2: Finite Stream Hardening for Gardens and Pipelines (~30%)

**Files:** `src/server/routes/gardens.ts`, `src/server/routes/pipelines.ts`, `src/runtime/garden-draft-service.ts`, `src/server/event-journal.ts`

**Tasks:**
- [ ] Refactor `/gardens/draft` to use the shared finite-stream helper
- [ ] Guarantee exactly one terminal draft event and immediate response closure after terminal emission
- [ ] Refactor `/pipelines/:id/events` to use replay ceiling + buffered live events + terminal auto-close
- [ ] Respect both `Last-Event-ID` and `?last_event_id=` consistently, with no duplicate delivery
- [ ] Close pipeline event streams immediately when the run is already terminal before subscription starts
- [ ] Add regression coverage for replay-after-terminal, cancel-then-replay, and resume-then-replay paths

### Phase 3: Seed-Run Convergence & Workspace Semantics (~20%)

**Files:** `src/server/routes/seeds.ts`, `src/server/seed-run-tracker.ts` (new), `src/seedbed/lifecycle.ts`, `src/server/workspace-event-bus.ts`

**Tasks:**
- [ ] Extract seed-linked run tracking out of `routes/seeds.ts` into `seed-run-tracker.ts`
- [ ] Keep `attachRun()` as the only path that mutates `linked_runs` on start/resume
- [ ] Record `run_started`, `run_interrupted`, `run_resumed`, `run_completed`, and `run_failed` exactly once using existing idempotency keys
- [ ] Emit workspace semantic updates after linked-run transitions so the Hive refreshes seed detail/board state without polling hacks
- [ ] Preserve the current status rule: auto-promote `seedling`/`sprouting` to `blooming` on run start or resume; do not auto-archive to `honey`
- [ ] Verify linked-run summaries and `status_suggestion` stay truthful after completion

### Phase 4: Green Suite Gate & Final Compliance Exactness (~15%)

**Files:** `src/engine/retry.ts`, `test/server/gardens-draft.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/http-server.test.ts`, `test/integration/seed-run-linkage.test.ts`, `test/llm/openai-compatible.test.ts`, `test/llm/stream-accumulator.test.ts` (new), `test/engine/retry.test.ts`

**Tasks:**
- [ ] Update `test/llm/openai-compatible.test.ts` to assert the unified finish-reason contract and `ServerError` mapping
- [ ] Add direct `StreamAccumulator` tests instead of relying on incidental coverage
- [ ] Change `RETRY_PRESETS.patient.multiplier` from `2.0` to spec-correct `3.0`
- [ ] Update retry tests and any integration fixtures to expect patient delays of `2000ms`, `6000ms`, and `18000ms` before jitter
- [ ] Run the full suite and keep the ban on timeout inflation

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/sse.ts` | Create | Shared SSE session helper with keepalive, idempotent close, and finite/persistent stream modes |
| `src/server/router.ts` | Modify | Expose shared SSE primitives cleanly and remove route-level duplication |
| `src/server/types.ts` | Modify | Define explicit run snapshot / route contract types used by the runtime |
| `src/server/run-manager.ts` | Modify | Centralize live run snapshot truth, context fallback, terminal state tracking, and cancel bootstrap handling |
| `src/server/event-journal.ts` | Modify | Support deterministic replay ceiling behavior used by finite pipeline event streams |
| `src/server/routes/pipelines.ts` | Modify | Harden event replay/closure, terminal behavior, and active context responses |
| `src/server/routes/gardens.ts` | Modify | Harden draft SSE lifecycle and terminal response closure |
| `src/runtime/garden-draft-service.ts` | Modify | Tighten draft terminal/error semantics so the route can close deterministically |
| `src/server/seed-run-tracker.ts` | Create | Isolate run-to-seed lifecycle subscription and transition handling |
| `src/server/routes/seeds.ts` | Modify | Delegate linked-run tracking to the extracted tracker and simplify the route |
| `src/seedbed/lifecycle.ts` | Modify | Keep run transition recording idempotent and aligned with seed status rules |
| `src/server/workspace-event-bus.ts` | Modify | Emit semantic updates that let the Hive react to linked-run lifecycle changes |
| `src/engine/retry.ts` | Modify | Close the final compliance gap by making `patient` use multiplier `3.0` |
| `test/server/gardens-draft.test.ts` | Modify | Lock in finite draft SSE behavior and single terminal event semantics |
| `test/integration/hive-run-flow.test.ts` | Modify | Validate preview/save/run/question/cancel/resume/replay over the hardened runtime |
| `test/integration/http-resume.test.ts` | Modify | Validate cancel/resume over HTTP with persisted interruption metadata |
| `test/integration/http-server.test.ts` | Modify | Validate active `current_node`, graph/context endpoints, and cancel behavior |
| `test/integration/seed-run-linkage.test.ts` | Modify | Validate linked-run filesystem truth and ordered activity transitions |
| `test/llm/openai-compatible.test.ts` | Modify | Align assertions with the unified response contract shipped in Sprint 028 |
| `test/llm/stream-accumulator.test.ts` | Create | Add direct coverage for stream accumulation behavior |
| `test/engine/retry.test.ts` | Modify | Lock in spec-exact `patient` retry values and jitter expectations |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes with zero failing tests
- [ ] No test timeout values were increased to make the suite pass
- [ ] `/gardens/draft` emits exactly one terminal event (`draft_complete` or `draft_error`) and closes the response immediately afterward
- [ ] `/pipelines/:id/events` replays persisted events, streams live events, and closes automatically after a terminal pipeline event
- [ ] `/pipelines/:id/events` honors `Last-Event-ID` and `?last_event_id=` without duplicate delivery
- [ ] Opening `/pipelines/:id/events` for an already-terminal run returns the replay and then closes without hanging
- [ ] `GET /pipelines/:id/context` during an active run always includes `current_node`
- [ ] Cancelling a run during bootstrap or active execution yields checkpoint status `interrupted` with reason `api_cancel`
- [ ] `POST /pipelines/:id/resume` can resume the interrupted run to completion over HTTP
- [ ] Seed-linked runs append ordered `run_started`, `run_interrupted`, `run_resumed`, and `run_completed` activity events with no duplicates
- [ ] Starting or resuming a linked run auto-promotes `seedling` and `sprouting` seeds to `blooming`, and does not auto-archive completed runs to `honey`
- [ ] Seed detail returns truthful `linked_run_summaries` and a `honey` status suggestion after the latest linked run completes
- [ ] `test/llm/openai-compatible.test.ts` reflects unified finish reasons and `ServerError` handling
- [ ] `test/llm/stream-accumulator.test.ts` exists and covers final response reconstruction
- [ ] `RETRY_PRESETS.patient.multiplier === 3.0`
- [ ] The patient preset produces deterministic non-jittered delays of `2000ms`, `6000ms`, and `18000ms` for attempts 1-3

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE hangs persist because close logic remains duplicated across routes | Medium | High | Introduce one shared SSE helper and ban route-local close choreography |
| Replay ordering bugs appear when live events arrive during journal replay | Medium | High | Keep the replay-ceiling model and add targeted replay + reconnect tests |
| Cancel/resume races survive because bootstrap and active states still diverge | Medium | High | Keep explicit lifecycle states in `RunManager` and test cancellation during both bootstrap and active execution |
| Seed activity duplication appears after extracting tracker logic | Medium | Medium | Preserve idempotency keys in `SeedLifecycleService` and add ordered activity assertions |
| The patient preset fix breaks existing fixtures that silently codified the wrong value | High | Low | Update tests and fixtures in the same sprint; do not carry the old multiplier forward |
| Browser clients treat normal SSE termination as an error and leave stale UI state | Medium | Medium | Verify Hive draft/run clients against the new finite-stream behavior and adjust only where necessary |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing Node HTTP + SSE implementation | Keep transport unchanged while fixing lifecycle correctness |
| Existing `EventJournal` + run directory structure | Preserve replay/history architecture instead of replacing it |
| Existing `RunManager`, `SeedLifecycleService`, and `WorkspaceEventBus` | Reuse current ownership boundaries, but make them sharper |
| `vitest` integration suite | Primary gate for runtime stability and regression protection |

No new third-party runtime dependency should be added for this sprint. If the code needs a new abstraction, make it an internal module.
