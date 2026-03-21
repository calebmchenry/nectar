# Sprint 027: Green Suite, Engine Contract, and Server API Completeness

## Overview

**Goal:** Make `npm test` pass with zero failures, fix every engine runtime-correctness bug in the compliance report, and ship the 3 missing HTTP endpoints so the Hive can fully drive the engine. After this sprint: CI is trustworthy, the engine retries/routes/detects loops per spec, and the server API is feature-complete for the attractor pipeline contract.

**Why this sprint, why now:**

1. **The red suite has survived 4 sprints.** Sprints 022–026 all declared test fixes non-negotiable. 6 tests still fail. The pattern is clear: every sprint that bundles test fixes with feature work ships the features and punts the debugging. This sprint makes the green suite the *only* gate for Phase 1. No subsequent phase starts until `npm test` reports zero failures. The debugging methodology is diagnosis-first: reproduce, instrument, root-cause, fix — not bump timeouts and hope.

2. **The 6 failures decompose into 3 root causes.** (a) `pipeline-events` fails because the `PipelineFailedEvent` message says `"Node 'bad' failed."` but the test asserts `.toContain('failure')` — either the message format or the assertion needs aligning. (b) `gardens-draft` fails because the simulation DOT output changed format (`digraph {` vs `digraph Drafted {`) — the assertion is stale. (c) The 4 timeout failures (`hive-run-flow`, `http-resume`, `seed-run-linkage`, `workspace-events`, `fan-in-llm`) share a common pattern: async SSE/HTTP flows that never resolve, pointing to promise lifecycle bugs in the server layer where `res.end()` is never called or event bus wiring is missing. Fix the promise plumbing, fix 4 tests.

3. **Engine retry and failure routing are broken at runtime.** Compliance gaps 1–3 are not spec-conformance nits — they're silent correctness bugs:
   - **Gap 1:** Retry backoff has no jitter. Under load, all retries fire simultaneously.
   - **Gap 2:** Retry preset parameters (aggressive, linear, patient) deviate from spec values. Pipelines using named presets get wrong retry behavior.
   - **Gap 3:** Engine retries on any `failure` status without classifying the error. A 401 auth error retries 3 times instead of failing fast.
   - **Gap 6:** QueueInterviewer throws on exhaustion instead of returning SKIPPED. Any test using a pre-loaded queue crashes instead of gracefully skipping.
   - **Gap 7:** Tool handler writes `{node_id}.stdout` instead of `tool.output`. Every downstream consumer reading the spec-defined key gets nothing.

4. **3 HTTP endpoints are missing and the Hive needs all of them.** The attractor spec requires `POST /pipelines/:id/cancel`, `GET /pipelines/:id/checkpoint`, and `GET /pipelines/:id/context`. The Hive's cancel button, checkpoint inspector, and context viewer are dead features without these. Gap 8 is the last thing standing between "server works" and "server is API-complete."

5. **This sprint is the last cleanup sprint.** After this, engine correctness + server API + green tests are done. Future sprints can focus exclusively on LLM layer compliance and product polish without dragging a red suite and broken retry logic behind them.

**Gaps closed:**

| Phase | Gaps | Count | Description |
|-------|------|-------|-------------|
| 1 | 6 test failures | 6 | Green suite — prerequisite for trustworthy CI |
| 2 | 1, 2, 3 | 3 | Engine retry: jitter, preset parameters, should_retry predicate |
| 3 | 6 | 1 | QueueInterviewer returns SKIPPED instead of throwing |
| 4 | 7 | 1 | Tool handler context key: `tool.output` per spec |
| 5 | 4, 5 | 2 | Diagnostic model: add INFO severity, add fix/node_id/edge fields |
| 6 | 8 | 1 | Missing HTTP endpoints: cancel, checkpoint, context |
| — | **Total** | **14** | 8 compliance gaps + 6 test failures |

**Cut line (in order):**
1. Gap 4–5 (Diagnostic model) — cosmetic; no runtime behavior change
2. Gap 3 (should_retry predicate) — current behavior is overly aggressive but not silent data loss

Do **not** cut the test fixes, retry jitter/presets (gaps 1–2), QueueInterviewer (gap 6), tool.output key (gap 7), or HTTP endpoints (gap 8). These are all runtime-correctness or API-completeness issues that block downstream work.

**Out of scope:**

- Unified LLM type system gaps (26–36) — large, self-contained; warrants own sprint
- Error taxonomy and adapter classification (41–50) — same rationale
- Session lifecycle events (gap 9) — large scope, not blocking Hive
- ExecutionEnvironment interface additions (gaps 15–19) — abstraction refactor, no one swaps environments today
- Truncation algorithm changes (gaps 20–22) — preference, not a bug
- Project doc discovery direction (gap 25) — behavioral difference, not broken
- All Hive UI features, CLI distribution, dark mode, shell completions

---

## Use Cases

1. **CI goes green and stays green.** A developer runs `npm test` after a clean checkout. All 132 test files pass. The 6 persistent failures from sprints 022–026 are resolved. CI can gate merges on test status for the first time.

2. **A pipeline retries with jitter under load.** Three parallel branches all hit a rate-limited API. With jitter, their retries spread across different intervals instead of thundering-herding at the same millisecond. The `aggressive` preset retries with initial_delay=500ms and factor=2.0, matching the spec exactly.

3. **A pipeline fails fast on auth errors.** A codergen node gets a 401 from the LLM provider. The engine's `should_retry` predicate classifies this as non-retryable and immediately follows the failure edge instead of burning through 3 retry attempts with exponential backoff.

4. **A test with QueueInterviewer handles exhaustion gracefully.** A pipeline has 3 human gates but the queue only has 2 answers. The third gate returns `SKIPPED` instead of crashing with an unhandled exception. The pipeline continues on the default/fallback edge.

5. **A downstream consumer reads tool output.** A conditional node checks `context.tool.output` to decide routing. Because the tool handler now writes to the spec-defined key, the condition matches. Previously, the output was written to `{node_id}.stdout` and the condition silently failed.

6. **The Hive cancels a running pipeline.** A user clicks "Cancel" in the browser. The Hive sends `POST /pipelines/:id/cancel`. The server checkpoints the current state, terminates execution, and returns the interrupted status. The user can later click "Resume" which hits the existing resume flow.

7. **The Hive inspects a checkpoint.** A user clicks on a completed node in the pipeline graph. The Hive fetches `GET /pipelines/:id/checkpoint` and displays the full checkpoint state: completed nodes, context snapshot, retry counts. Previously this returned 404.

8. **The Hive reads the context store.** During a running pipeline, the Hive polls `GET /pipelines/:id/context` to show live context key-value pairs in a debug panel. The user can see `outcome`, `preferred_label`, `tool.output`, and custom keys updating in real time.

---

## Architecture

No new modules or abstractions. This sprint modifies existing files to fix bugs and fill API gaps. The changes are surgical:

### Test Fixes (3 root causes → 6 green tests)

**Root cause A — Assertion mismatches (2 tests):**
- `pipeline-events.test.ts` asserts `.toContain('failure')` but the message is `"Node 'bad' failed."`. Fix: update the assertion to match the actual message format, OR update `buildFailureMessage()` in engine.ts to include the word "failure" explicitly.
- `gardens-draft.test.ts` asserts `payload.toContain('digraph Drafted')` but the simulation DOT output uses a different graph name. Fix: align the simulation's `buildSimulationDot()` output with the test expectation, or update the test to match the actual output.

**Root cause B — SSE/async lifecycle bugs (4 tests):**
- `hive-run-flow`, `http-resume`, `seed-run-linkage`, and `workspace-events` all timeout waiting for SSE events that never arrive. The common pattern: async operations complete or error but the SSE response stream is never closed (`res.end()` not called), or the event bus isn't wired to the service that emits the events. Fix: audit every SSE endpoint for missing `res.end()` on completion/error paths, and verify event bus wiring in server.ts constructor.

### Engine Retry Fixes (Gaps 1–3)

**File: `src/engine/retry.ts`**

- **Jitter (Gap 1):** Add `jitter: boolean` parameter to `computeBackoff()`. When true, multiply the computed delay by a random factor in `[0.5, 1.0]` (matching the LLM retry middleware pattern already in `src/llm/retry.ts`). Default `jitter=true` for all presets except `none`.
- **Preset parameters (Gap 2):** Update `RETRY_PRESETS` to match spec values exactly:
  - `aggressive`: initial_delay_ms=500, multiplier=2.0 (was 50, 1.5)
  - `linear`: max_retries=3, initial_delay_ms=500 (was 5, 1000)
  - `patient`: max_retries=3 (was 8)
- **should_retry predicate (Gap 3):** Add a `shouldRetry(status, error?)` function. Retryable: network errors, 429, 5xx. Not retryable: 401, 403, 400. When a handler returns `failure` with an error that classifies as non-retryable, skip retries and go straight to failure routing. This requires the handler outcome to optionally carry an error classification, which the tool and codergen handlers can populate from the LLM error hierarchy.

### QueueInterviewer Fix (Gap 6)

**File: `src/interviewer/queue.ts`**

Change `throw new Error('No more queued answers')` to `return { selected_label: 'SKIPPED', source: 'queue_exhausted' }`. One-line fix.

### Tool Handler Context Key Fix (Gap 7)

**File: `src/handlers/tool.ts`**

Change `context_updates` from `{ [node.id + '.stdout']: result.stdout, [node.id + '.stderr']: result.stderr }` to `{ 'tool.output': result.stdout }`. The spec requires exactly this key. Add `tool.exit_code` and `tool.stderr` as additional keys for completeness — these don't conflict with the spec and are useful for conditions.

### Diagnostic Model Additions (Gaps 4–5)

**File: `src/garden/types.ts`**

- Add `'info'` to the severity union type.
- Add optional `fix?: string`, `node_id?: string`, `edge?: [string, string]` fields to `Diagnostic`.

**File: `src/garden/validate.ts`**

- Where existing validations reference specific nodes or edges, populate the new fields. Add `fix` suggestions for common validation failures (e.g., "Add a second exit node" for missing terminal node).

### Missing HTTP Endpoints (Gap 8)

**File: `src/server/routes/pipelines.ts`**

Three new route handlers:

1. **`POST /pipelines/:id/cancel`** — Look up the active run in `RunManager`. Call `engine.abort()` (which triggers checkpoint + graceful shutdown). Return `{ status: 'interrupted', checkpoint_id: '...' }`.

2. **`GET /pipelines/:id/checkpoint`** — Read the checkpoint file from the run's cocoon directory. Return the raw checkpoint JSON. 404 if no checkpoint exists.

3. **`GET /pipelines/:id/context`** — Read the context store from the active run (if running) or from the latest checkpoint (if completed/interrupted). Return `{ keys: Record<string, string> }`.

---

## Implementation

### Phase 1: Green Suite (40% of effort)

**Priority:** This phase is the gate. Nothing else starts until all 6 tests pass.

**Files:** `test/server/pipeline-events.test.ts`, `test/server/gardens-draft.test.ts`, `src/runtime/garden-draft-service.ts`, `src/engine/engine.ts`, `src/server/routes/pipelines.ts`, `src/server/routes/seeds.ts`, `src/server/routes/gardens.ts`, `src/server/routes/events.ts`, `src/server/run-manager.ts`, `src/server/workspace-event-bus.ts`, `src/server/swarm-manager.ts`, `src/runtime/swarm-analysis-service.ts`, `test/integration/fan-in-llm.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/seed-run-linkage.test.ts`, `test/server/workspace-events.test.ts`

**Tasks:**
- [ ] Fix `pipeline-events.test.ts`: Align the assertion with the actual `buildFailureMessage()` output. If the message format is correct per the spec, update the test. If not, update the message format to include "failure" as a substring.
- [ ] Fix `gardens-draft.test.ts`: Trace the simulation DOT generation path in `garden-draft-service.ts`. Either update `buildSimulationDot()` to produce output matching the test expectation, or update the test assertion to match the actual format. The fix must be the one that aligns with the spec.
- [ ] Diagnose timeout root causes: Instrument the 4 timeout tests with explicit logging. For each SSE endpoint, verify: (a) the event bus is wired in `server.ts`, (b) `res.end()` is called on every completion and error path, (c) the async operation actually completes (no dangling promises).
- [ ] Fix `workspace-events.test.ts`: Verify `SwarmAnalysisService` receives the `event_bus` in its constructor. If not, wire it in `server.ts`.
- [ ] Fix `hive-run-flow.test.ts` and `http-resume.test.ts`: Audit the cancel/resume HTTP flow. Verify `RunManager.cancel()` triggers checkpoint and status change, and `RunManager.resume()` properly restarts execution and re-emits SSE events.
- [ ] Fix `seed-run-linkage.test.ts`: Verify the seed→run linkage writes `linked_runs` to `meta.yaml` and that the run lifecycle events propagate through the event bus.
- [ ] Fix `fan-in-llm.test.ts`: Verify the fan-in handler saves artifacts and context updates when using LLM-prompted selection. Check that the simulation client returns valid structured output for the fan-in evaluation.
- [ ] Run `npm test` — must be 0 failures before proceeding.

### Phase 2: Engine Retry Correctness (20% of effort)

**Files:** `src/engine/retry.ts`, `test/engine/retry.test.ts`

**Tasks:**
- [ ] Add `jitter` parameter to `computeBackoff()` with `[0.5, 1.0]` random multiplier. Update all callers.
- [ ] Update `RETRY_PRESETS` to match spec values:
  - `aggressive`: `{ max_retries: 5, initial_delay_ms: 500, multiplier: 2.0, jitter: true }`
  - `linear`: `{ max_retries: 3, initial_delay_ms: 500, multiplier: 1.0, jitter: true }`
  - `patient`: `{ max_retries: 3, initial_delay_ms: 2000, multiplier: 2.0, jitter: true }`
- [ ] Add `shouldRetry(outcome, error?)` predicate function. Classify errors: network/429/5xx → retryable; 401/403/400 → not retryable; no error classification → retryable (backwards compatible).
- [ ] Update engine retry loop to call `shouldRetry()` before scheduling a retry.
- [ ] Add `error_category?: 'auth' | 'rate_limit' | 'server' | 'network' | 'client' | 'unknown'` to `NodeOutcome` type.
- [ ] Update `ToolHandler` and `CodergenHandler` to populate `error_category` from caught errors.
- [ ] Tests: verify jitter produces non-deterministic delays within bounds, verify preset values match spec, verify should_retry skips non-retryable errors, verify backwards-compatible default.

### Phase 3: Interviewer and Tool Handler Fixes (10% of effort)

**Files:** `src/interviewer/queue.ts`, `src/handlers/tool.ts`, `test/interviewer/interviewer.test.ts`, `test/handlers/tool.test.ts`

**Tasks:**
- [ ] QueueInterviewer: Replace `throw new Error(...)` with `return { selected_label: 'SKIPPED', source: 'queue_exhausted' }`.
- [ ] Add test: QueueInterviewer with 1 answer and 2 questions returns answer then SKIPPED.
- [ ] Tool handler: Change context_updates keys from `{node_id}.stdout`/`{node_id}.stderr` to `tool.output`, `tool.stderr`, `tool.exit_code`.
- [ ] Update any engine code or tests that read the old key names.
- [ ] Add test: tool handler sets `tool.output` in context after execution.

### Phase 4: Diagnostic Model (10% of effort)

**Files:** `src/garden/types.ts`, `src/garden/validate.ts`, `test/garden/validate.test.ts`

**Tasks:**
- [ ] Add `'info'` to the `DiagnosticSeverity` union.
- [ ] Add optional `fix`, `node_id`, `edge` fields to `Diagnostic` type.
- [ ] Populate `node_id` on all existing node-specific diagnostics in `validate.ts`.
- [ ] Populate `edge` on edge-specific diagnostics.
- [ ] Add `fix` suggestions for the most common validation failures (at least: missing start node, missing exit node, unreachable node, missing prompt on codergen).
- [ ] Add at least one INFO-level diagnostic (e.g., "Node has no outgoing edges other than to exit" as an informational note).
- [ ] Tests: verify new fields are populated; verify INFO diagnostics don't cause `validate_or_raise` to error.

### Phase 5: Missing HTTP Endpoints (20% of effort)

**Files:** `src/server/routes/pipelines.ts`, `src/server/run-manager.ts`, `src/server/types.ts`, `test/server/pipeline-events.test.ts` (or new test file), `test/integration/http-server.test.ts`

**Tasks:**
- [ ] Implement `POST /pipelines/:id/cancel`:
  - Look up run in RunManager
  - Call `abort()` on the engine's AbortController
  - Wait for graceful shutdown (checkpoint write)
  - Return `{ status: 'interrupted', run_id, checkpoint_id }`
  - 404 if run not found, 409 if already completed/cancelled
- [ ] Implement `GET /pipelines/:id/checkpoint`:
  - Read `checkpoint.json` from run directory
  - Return raw checkpoint JSON
  - 404 if run not found or no checkpoint exists
- [ ] Implement `GET /pipelines/:id/context`:
  - If run is active: read from engine's live context store
  - If run is completed/interrupted: read from checkpoint's `context_values`
  - Return `{ context: Record<string, string> }`
  - 404 if run not found
- [ ] Tests: cancel a running pipeline → verify 200 + interrupted status; cancel completed pipeline → verify 409; GET checkpoint → verify JSON structure; GET context → verify key-value pairs match engine state.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/retry.ts` | Modify | Add jitter, fix preset values, add shouldRetry predicate |
| `src/engine/types.ts` | Modify | Add error_category to NodeOutcome |
| `src/engine/engine.ts` | Modify | Call shouldRetry before retry loop; fix buildFailureMessage if needed |
| `src/handlers/tool.ts` | Modify | Fix context key from {node_id}.stdout to tool.output |
| `src/handlers/codergen.ts` | Modify | Populate error_category from LLM errors |
| `src/interviewer/queue.ts` | Modify | Return SKIPPED instead of throwing on exhaustion |
| `src/garden/types.ts` | Modify | Add INFO severity, fix/node_id/edge fields to Diagnostic |
| `src/garden/validate.ts` | Modify | Populate new diagnostic fields, add fix suggestions |
| `src/server/routes/pipelines.ts` | Modify | Add cancel, checkpoint, context endpoints |
| `src/server/run-manager.ts` | Modify | Add cancel(), getCheckpoint(), getContext() methods |
| `src/runtime/garden-draft-service.ts` | Modify | Fix simulation DOT output format (if needed) |
| `src/server/routes/seeds.ts` | Modify | Fix SSE lifecycle (res.end on completion) |
| `src/server/routes/gardens.ts` | Modify | Fix SSE lifecycle (res.end on completion) |
| `src/server/routes/events.ts` | Modify | Fix SSE lifecycle (res.end on completion) |
| `src/server/workspace-event-bus.ts` | Modify | Verify event wiring |
| `src/server/swarm-manager.ts` | Modify | Wire event bus if missing |
| `src/runtime/swarm-analysis-service.ts` | Modify | Wire event bus if missing |
| `test/engine/retry.test.ts` | Modify | Add jitter, preset, shouldRetry tests |
| `test/handlers/tool.test.ts` | Modify | Update context key assertions |
| `test/interviewer/interviewer.test.ts` | Modify | Add QueueInterviewer exhaustion test |
| `test/garden/validate.test.ts` | Modify | Add diagnostic field tests |
| `test/server/pipeline-events.test.ts` | Modify | Fix assertion + add cancel/checkpoint/context tests |
| `test/server/gardens-draft.test.ts` | Modify | Fix assertion to match actual output |
| `test/integration/fan-in-llm.test.ts` | Modify | Fix timeout root cause |
| `test/integration/hive-run-flow.test.ts` | Modify | Fix timeout root cause |
| `test/integration/http-resume.test.ts` | Modify | Fix timeout root cause |
| `test/integration/seed-run-linkage.test.ts` | Modify | Fix timeout root cause |
| `test/server/workspace-events.test.ts` | Modify | Fix event bus wiring |

---

## Definition of Done

- [ ] `npm test` passes with 0 failures and 0 skipped tests on a clean checkout
- [ ] `pipeline-events` test passes: `pipeline_failed` event is emitted with correct fields
- [ ] `gardens-draft` test passes: SSE stream contains expected DOT output
- [ ] `hive-run-flow` test passes: full preview/save/run/question/cancel/resume flow completes within timeout
- [ ] `http-resume` test passes: cancel + resume flow completes within timeout
- [ ] `seed-run-linkage` test passes: seed lifecycle tracks linked runs on filesystem
- [ ] `workspace-events` test passes: seed analysis lifecycle events stream via SSE
- [ ] `fan-in-llm` test passes: fan-in handler persists context and artifacts
- [ ] Engine retry uses jitter: two retries of the same node produce different delay values
- [ ] `RETRY_PRESETS.aggressive` has initial_delay_ms=500, multiplier=2.0
- [ ] `RETRY_PRESETS.linear` has max_retries=3, initial_delay_ms=500
- [ ] `RETRY_PRESETS.patient` has max_retries=3
- [ ] Engine skips retry on 401/403/400 errors and proceeds to failure routing
- [ ] Engine retries on 429/5xx/network errors as before
- [ ] QueueInterviewer returns `{ selected_label: 'SKIPPED' }` when queue is exhausted (no throw)
- [ ] Tool handler writes `tool.output` context key (not `{node_id}.stdout`)
- [ ] Diagnostic type includes `'info'` severity and optional `fix`, `node_id`, `edge` fields
- [ ] At least 5 existing validation rules populate `node_id` on their diagnostics
- [ ] At least 3 validation rules include `fix` suggestions
- [ ] `POST /pipelines/:id/cancel` returns 200 with interrupted status for active runs
- [ ] `POST /pipelines/:id/cancel` returns 409 for already-completed runs
- [ ] `GET /pipelines/:id/checkpoint` returns the checkpoint JSON
- [ ] `GET /pipelines/:id/context` returns the context key-value pairs
- [ ] All new and modified code has corresponding test coverage
- [ ] `npm run build` succeeds with zero TypeScript errors

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE timeout root causes are deeper than res.end() — could be event loop starvation or deadlocked promises | Medium | High | Instrument with explicit debug logging before fixing. If root cause is architectural, fix the minimum needed to unblock tests and file a follow-up. |
| Changing retry preset parameters breaks existing pipelines that depend on current behavior | Low | Medium | No user pipelines in production yet. Spec compliance is more important than backwards compatibility at this stage. Document the change. |
| Changing tool handler context key (`tool.output` vs `{node_id}.stdout`) breaks existing condition expressions | Medium | Medium | Grep for all references to the old key pattern. Update conditions in test fixtures and built-in gardens. The old key was never spec-compliant, so any external user would need to change anyway. |
| shouldRetry predicate requires error classification that handlers don't currently provide | Medium | Medium | Make error_category optional. When absent, default to retryable (preserves current behavior). Handlers that catch typed LLM errors populate it; others don't need to change. |
| Cancel endpoint races with engine checkpoint | Low | High | Use the existing AbortController pattern. Engine already handles SIGINT gracefully — cancel is the same signal delivered via HTTP instead of the terminal. |
| Phase 1 debugging consumes the entire sprint | Medium | Medium | This is an acceptable outcome. The green suite is worth more than any compliance gap. If Phase 1 takes 80% of the sprint, cut Phases 4 (diagnostics) and 3's should_retry predicate. |

---

## Dependencies

No new dependencies. All changes use existing libraries and patterns:

| Existing Dependency | Used For |
|---|---|
| `vitest` | Test framework (existing) |
| `execa` | Tool handler subprocess execution (existing) |
| `src/llm/errors.ts` | Error classification hierarchy for shouldRetry (existing) |
| `src/server/router.ts` | HTTP route registration (existing) |
| `src/checkpoint/run-store.ts` | Checkpoint read/write (existing) |
| `src/engine/context.ts` | Context store access (existing) |
