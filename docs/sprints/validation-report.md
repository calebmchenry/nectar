# Sprint 031 Validation Report

**Date:** 2026-03-21
**Sprint:** 031 — SSE Lifecycle Fix & Full Compliance Closure
**Validated by:** Independent validation run
**Result:** FAIL — 6 tests failing across 6 test files; 2 DoD gates not met

## Build

| Check | Result |
|-------|--------|
| `npm run build` | PASS — zero TypeScript errors |

## Tests

| Check | Result |
|-------|--------|
| `npm test` | FAIL — 6 failed, 1124 passed (1130 total) |

### Failing Tests

| Test File | Test Name | Failure Mode |
|-----------|-----------|--------------|
| `test/server/pipeline-events.test.ts` | emits stage_failed and pipeline_failed while preserving run_error/node_completed | AssertionError: `run_error` event not present in event stream |
| `test/integration/http-server.test.ts` | cancels active runs and returns interrupted status with checkpoint_id | AssertionError: `current_node` is undefined (expected defined) |
| `test/integration/hive-run-flow.test.ts` | covers preview/save/run/question/cancel/resume/replay flow over HTTP | Test timed out in 5000ms (SSE stream hang) |
| `test/integration/http-resume.test.ts` | cancels an active run and resumes it to completion | Test timed out in 5000ms (SSE stream hang) |
| `test/integration/seed-run-linkage.test.ts` | tracks link -> run -> interrupt -> resume -> complete on filesystem | Test timed out in 5000ms (SSE stream hang) |
| `test/server/gardens-draft.test.ts` | streams draft_start, content_delta, and draft_complete events | Test timed out in 5000ms (SSE stream hang) |

### Failure Analysis

The 6 failures are the **same SSE lifecycle bugs** identified in the sprint overview (Phases 1a/1b). SSE streams opened by test clients never receive a close signal, causing tests to hang until timeout. The `run_error` event emission and `current_node` in context endpoint are also unresolved.

Despite `createFiniteSseStream` infrastructure being in place in `src/server/sse.ts`, the runtime behavior still fails — the SSE routes are correctly wired to close on terminal events, but the underlying test scenarios are not reaching terminal events or the close signal is not propagating correctly.

## Definition of Done — Item-by-Item

### FAILING Items

| # | DoD Item | Status | Evidence |
|---|----------|--------|----------|
| 1 | `npm test` passes with 0 failures — no timeouts, no skips | **FAIL** | 6 tests fail (3 timeouts, 2 assertion errors, 1 hook timeout) |
| 2 | No test timeout values were increased to achieve green | **N/A** | Suite is not green; cannot verify this was achieved cleanly |
| 3 | `/pipelines/:id/events` SSE stream closes automatically after terminal event | **FAIL** | Code exists (`createFiniteSseStream`), but 4 integration tests still hang/timeout |
| 4 | `/gardens/draft` SSE stream closes automatically after `draft_complete`/`draft_error` | **FAIL** | Code exists, but `gardens-draft.test.ts` times out |
| 5 | `GET /pipelines/:id/context` returns `current_node` during active runs | **FAIL** | `http-server.test.ts` asserts `current_node` is defined but gets `undefined` |
| 6 | `run_error` event emission (implicit from Phase 1b) | **FAIL** | `pipeline-events.test.ts` expects `run_error` in event stream but it's absent |

### PASSING Items

| # | DoD Item | Status | Evidence |
|---|----------|--------|----------|
| 7 | `npm run build` succeeds with zero TypeScript errors | **PASS** | Build completes cleanly |
| 8 | `Answer` type includes `AnswerValue` enum, `selected_option`, `text` fields | **PASS** | `src/interviewer/types.ts` — enum at lines 20-25, fields at lines 32-34 |
| 9 | All 5 interviewer implementations produce correctly-typed Answer objects | **PASS** | All use `normalizeAnswer()` which produces canonical Answer shape |
| 10 | Legacy label-only inputs accepted and normalized at boundary | **PASS** | `normalizeAnswer()` infers `answer_value` from `selected_label` via `inferAnswerValueFromLabel()` |
| 11 | `Cocoon` type includes `logs: string[]` field | **PASS** | `src/checkpoint/types.ts` line 30 |
| 12 | Old checkpoints without `logs` load successfully (default `[]`) | **PASS** | `normalizeCocoon()` in `run-store.ts` defaults to `[]`; also in `cocoon.ts` |
| 13 | `RunCompletedEvent` includes `artifact_count` | **PASS** | `src/engine/events.ts` line 60 |
| 14 | `NodeStartedEvent` includes `index` | **PASS** | `src/engine/events.ts` line 15 |
| 15 | `AgentSession` emits `agent_session_started` without codergen | **PASS** | `session.ts` line 169 calls `emitSessionStarted()` in `submit()` |
| 16 | Exactly one session-start event per session | **PASS** | `sessionStartedEmitted` flag prevents duplicate emission |
| 17 | `ProviderProfile` has `providerOptions()`, implemented by all 3 profiles | **PASS** | Interface line 15; Anthropic (66-72), OpenAI (87-89), Gemini (113-122) |
| 18 | `ToolRegistry.unregister()` exists | **PASS** | `tool-registry.ts` lines 130-132 |
| 19 | `LocalExecutionEnvironment.glob()` and `.grep()` return real results | **PASS** | Delegates to `runGlobSearch`/`runGrepSearch` from `search.ts` |
| 20 | Existing glob/grep tools use shared helpers | **PASS** | Both tools import and call shared helpers from `search.ts` |
| 21 | `submit()` auto-discovers project instructions (32KB budget) | **PASS** | `session.ts` calls `discoverInstructions()`; `project-instructions.ts` enforces `MAX_BUDGET = 32 * 1024` |
| 22 | `buildGitSnapshot()` includes last 5 commit messages | **PASS** | `environment-context.ts` runs `git log --oneline -5` |
| 23 | `stream_end` carries complete `GenerateResponse` (not optional) | **PASS** | `streaming.ts` line 18 — `response: GenerateResponse` (required) |
| 24 | Premature stream termination emits `error`, not malformed `stream_end` | **PASS** | Anthropic adapter throws `StreamError`; client yields error event |
| 25 | `Message` has optional `name` field | **PASS** | `types.ts` line 99 — `name?: string` |
| 26 | `GenerateRequest` has `max_tool_rounds` (default 1) | **PASS** | `types.ts` line 232; `client.ts` `resolveMaxToolRounds()` defaults to 1 |
| 27 | `GenerateOptions.maxIterations` remains as deprecated alias | **PASS** | `types.ts` line 237; used as fallback in `resolveMaxToolRounds()` |
| 28 | `generate({ prompt, messages })` throws `InvalidRequestError` | **PASS** | `client.ts` `normalizePromptRequest()` lines 110-116 |
| 29 | `provider_options.anthropic.auto_cache = false` disables caching | **PASS** | `anthropic.ts` `shouldEnablePromptCaching()` checks `auto_cache === false` |
| 30 | Legacy `cache_control = false` still works | **PASS** | Same function checks `cache_control === false` as alias |
| 31 | `ModelInfo` uses flat `supports_*` and cost fields | **PASS** | `catalog.ts` lines 3-35 define flat fields |
| 32 | Nested `capabilities`/`cost` remain as compatibility aliases | **PASS** | `catalog.ts` includes nested structures alongside flat fields |
| 33 | Internal callers migrated to spec-named flat fields | **PASS** | No external callers use deprecated nested paths |
| 34 | Compliance report updated to show zero gaps | **PASS** | `docs/compliance-report.md` line 1: "NO GAPS REMAINING" |

## Summary

| Category | Pass | Fail | Total |
|----------|------|------|-------|
| Build | 1 | 0 | 1 |
| Tests | 0 | 1 | 1 |
| SSE Lifecycle (Phases 1a/1b) | 0 | 4 | 4 |
| Attractor Spec Gaps (Phase 2) | 6 | 0 | 6 |
| Agent Loop Gaps (Phase 3) | 10 | 0 | 10 |
| Unified LLM Gaps (Phase 4) | 12 | 0 | 12 |
| Compliance Report (Phase 5) | 1 | 0 | 1 |
| **Total** | **30** | **5** | **35** |

## Verdict

**FAIL** — 5 of 35 DoD items are not satisfied.

All failures stem from the SSE lifecycle workstream (Phases 1a/1b):
1. SSE streams still hang in integration tests (4 tests timeout)
2. `run_error` event not emitted by engine on node failure without failure edge
3. `current_node` not populated in context endpoint during active runs
4. Test suite is not green (6 failures)

The compliance gap closure work (Phases 2–4) is **fully complete** — all 15 gaps are verified as implemented with correct code. The compliance report accurately reflects zero remaining gaps.

The remaining work is narrowly scoped to the SSE/HTTP integration layer: fixing event propagation so terminal events reach SSE clients, emitting `run_error`, and populating `current_node` in the context snapshot.
