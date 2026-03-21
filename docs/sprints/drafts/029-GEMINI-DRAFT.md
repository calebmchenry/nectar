# Sprint 029: Green Suite & Compliance Fixes

## Overview

**Goal:** Achieve a 100% green test suite by fixing persistent HTTP server SSE lifecycle bugs, updating OpenAI-compatible adapter tests for the unified FinishReason contract, adding missing test coverage for `StreamAccumulator`, and fixing the `patient` retry preset multiplier to achieve full Attractor spec compliance.

**Scope:**
- Fix `test/llm/openai-compatible.test.ts` assertions to match the unified Response contract.
- Investigate and fix Server-Sent Events (SSE) lifecycle bugs causing 5s timeouts in multiple integration tests.
- Fix the context endpoint in the HTTP server to properly populate `current_node`.
- Add unit tests for `src/llm/stream-accumulator.ts`.
- Update `patient` retry preset multiplier to `3.0` for compliance.

**Out of scope:**
- New features or adapter enhancements.
- Web UI or CLI additions.

---

## Use Cases

1. **Developer runs tests:** `npm test` passes completely without hanging or timing out, confirming the server cleanly closes SSE connections and all assertions align with the current LLM contract.
2. **Server accurately reports state:** The `GET /pipelines/:id/context` endpoint returns the correct `current_node` during active runs, preventing UI desyncs.
3. **Engine respects Attractor Spec:** The `patient` retry preset correctly uses a 3.0x backoff multiplier.

---

## Architecture

### SSE Stream Termination
The HTTP server routes using Server-Sent Events must explicitly terminate connections (`res.end()`) when the underlying stream completes, errors out, or when the client disconnects. Currently, streams are left dangling, which causes the integration tests to hang until the 5s timeout. Explicit cleanup logic (`req.on('close')`) and termination signals must be added.

### Unified FinishReason Assertions
The OpenAI-compatible adapter was updated in Sprint 028 to map native API stop reasons to unified values (`stop`, `tool_calls`). The corresponding tests must assert these unified values instead of the provider-native ones (`end_turn`, `tool_use`). Additionally, 500 status codes map to `ServerError`, not `OverloadedError`.

### Context Endpoint State
The HTTP server's context endpoint must query the active `PipelineEngine` state (if running) or the latest `Cocoon` checkpoint to accurately merge `current_node` with the persisted context, rather than only reading static `context_values`.

---

## Implementation phases

### Phase 1: Compliance and Coverage (~20%)
**Tasks:**
- Modify `src/engine/retry.ts` to set `multiplier: 3.0` for the `patient` preset.
- Create `test/llm/stream-accumulator.test.ts` and write exhaustive unit tests for `StreamAccumulator` (verifying `push()` logic for all event types, partial response buffering, and `response()` assembly).

### Phase 2: OpenAI-Compatible Test Fixes (~15%)
**Tasks:**
- Update `test/llm/openai-compatible.test.ts` assertions.
- Change expected `stop_reason` values from `end_turn` to `stop` and `tool_use` to `tool_calls`.
- Change expected error class for the 500 HTTP status code test from `OverloadedError` to `ServerError`.

### Phase 3: Server Context & SSE Lifecycle (~65%)
**Tasks:**
- Update `src/server/routes/pipelines.ts` for `GET /pipelines/:id/context` to retrieve and include `current_node` from the active engine or latest checkpoint.
- Audit and fix SSE endpoint handlers (`GET /pipelines/:id/events`, and potentially garden drafting endpoints). Ensure that when the pipeline completes or fails, `res.end()` is explicitly called.
- Add `req.on('close', ...)` handlers to clean up engine listeners if the client drops the connection early.
- Verify that `gardens-draft.test.ts`, `hive-run-flow.test.ts`, `http-resume.test.ts`, `http-server.test.ts`, and `seed-run-linkage.test.ts` all pass without timeout.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/retry.ts` | Modify | Update `patient` preset multiplier to 3.0 for spec compliance. |
| `test/llm/stream-accumulator.test.ts` | Create | Add missing test coverage for `StreamAccumulator`. |
| `test/llm/openai-compatible.test.ts` | Modify | Update assertions for `FinishReason` and `ServerError`. |
| `src/server/routes/pipelines.ts` | Modify | Fix SSE connection termination and populate `current_node` in the context endpoint. |
| `src/server/routes/gardens.ts` | Modify | Fix SSE connection termination for any draft endpoints (if applicable). |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero TypeScript errors.
- [ ] `npm test` passes with 0 failures (all test files and individual tests pass).
- [ ] `test/llm/openai-compatible.test.ts` assertions successfully use `stop` and `tool_calls`.
- [ ] `StreamAccumulator` has dedicated, passing test coverage in `test/llm/stream-accumulator.test.ts`.
- [ ] Integration tests (`gardens-draft`, `hive-run-flow`, `http-resume`, `seed-run-linkage`) complete cleanly without 5s timeouts.
- [ ] `test/integration/http-server.test.ts` passes with `current_node` correctly defined.
- [ ] The `patient` preset in `src/engine/retry.ts` uses `multiplier: 3.0`.

---

## Risks

- **SSE Lifecycle Complexity:** Debugging Node.js stream and Express event emitter leaks can be tricky and may require deep inspection of how events are piped to the response. **Mitigation:** Add explicit trace logging for the `close` and `finish` events on the request/response objects during development.
- **Context Endpoint State Retrieval:** The engine might not expose `current_node` synchronously, or it might be null at certain lifecycle stages. **Mitigation:** Ensure the endpoint gracefully falls back to checking the active engine's `RunState` and, if not available, the latest persisted `Cocoon`.

## Dependencies

- Existing `vitest` infrastructure.
- Existing HTTP server routing layer (Express or standard Node HTTP handlers).
