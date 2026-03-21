# Sprint: Spec Compliance Polish — Resilience & Observability

## Overview

**Goal:** Close the most impactful compliance gaps in Nectar's core engine, coding agent loop, and LLM client. This sprint focuses on ensuring robust error handling, accurate retry behavior, complete observability, and strict adherence to the Unified LLM Spec's response and error models. After this sprint, the engine's retry behavior will strictly match the attractor spec, the LLM client will correctly classify errors and expose complete response data, and the agent session will emit all required lifecycle events.

**Scope:**
- Fix engine retry jitter, presets, and predicates (Gaps 1-3).
- Fix Tool handler context key (Gap 7).
- Implement missing session lifecycle events in `AgentSession` (Gap 9).
- Normalize `FinishReason` and complete `GenerateResponse` fields in the Unified LLM client (Gaps 26-31).
- Complete error classification and `Retry-After` handling across all LLM adapters (Gaps 41-47).

**Out of scope:**
- HTTP API endpoints (Gap 8).
- ExecutionEnvironment interface completeness (Gaps 15-19).
- Truncation limit changes (Gaps 20-22).
- Subagent / SubagentManager parameters (Gaps 23-24).
- Stream result wrappers and stream accumulator utilities (Gaps 33-34).

---

## Use Cases

1. **Accurate Engine Retries:** When a node fails due to a network error, the engine uses the correct exponential backoff with random jitter, adhering strictly to the `patient`, `aggressive`, or `linear` presets.
2. **LLM Error Recovery:** When an LLM provider returns a `429 Too Many Requests` or `503 Overloaded`, the adapter correctly classifies it as a `RateLimitError` or `OverloadedError`, parses the `Retry-After` header correctly, and the middleware honors it without exceeding maximum limits.
3. **Session Observability:** When an agent session starts, processes inputs, and finishes, it emits the full suite of lifecycle events (`SESSION_START`, `USER_INPUT`, `TURN_LIMIT`, etc.), allowing external systems and the Hive UI to track the exact state of the agent in real time.
4. **Consistent LLM Responses:** Regardless of the underlying provider (Anthropic, OpenAI, Gemini), the returned `GenerateResponse` contains a normalized `FinishReason`, provider-assigned `id`, raw response JSON for debugging, and provides convenience accessors (e.g., `.text()`) to simplify downstream usage.

---

## Architecture

No major architectural shifts. This sprint focuses on correcting the implementation details within the existing architecture:

- `src/engine/retry.ts` will be updated to compute jitter mathematically and adjust preset configuration values.
- `src/agent-loop/session.ts` will have event emission added at appropriate lifecycle boundaries using the existing event emitter pattern.
- `src/llm/types.ts` and `src/llm/adapters/*` will be updated for strict `FinishReason` and `Response` completeness, ensuring all adapters map to standard types.
- `src/llm/errors.ts` and `src/llm/retry.ts` will be updated to handle `Retry-After` logic robustly and map all HTTP status codes.

---

## Implementation Phases

### Phase 1: Engine Retry & Tool Handler Compliance (~20%)

**Files:** `src/engine/retry.ts`, `src/engine/engine.ts`, `src/handlers/tool.ts`

**Tasks:**
- [ ] Update `computeBackoff` in `src/engine/retry.ts` to add random jitter (0.5 to 1.0 multiplier).
- [ ] Correct `RETRY_PRESETS` values in `retry.ts` to match the spec (`aggressive` initial_delay=500ms/factor=2.0; `linear` max_attempts=3/initial_delay=500ms; `patient` max_attempts=3).
- [ ] Implement the default `should_retry` predicate in `engine.ts` to distinguish retryable network/server errors (e.g., 429, 5xx) from non-retryable errors (401, 403, 400).
- [ ] Fix `src/handlers/tool.ts` to use `tool.output` for `context_updates` instead of `{node_id}.stdout`.

### Phase 2: Agent Loop Observability (~20%)

**Files:** `src/agent-loop/types.ts`, `src/agent-loop/events.ts`, `src/agent-loop/session.ts`

**Tasks:**
- [ ] Define missing events in `events.ts` and `types.ts`: `SESSION_START`, `SESSION_END`, `PROCESSING_END`, `USER_INPUT`, `STEERING_INJECTED`, `TURN_LIMIT`, `ASSISTANT_TEXT_START`, `ASSISTANT_TEXT_END`, `TOOL_CALL_OUTPUT_DELTA`, `WARNING`, `ERROR`.
- [ ] Inject event emission into `src/agent-loop/session.ts` at the appropriate lifecycle boundaries (e.g., in `submit`, `steer`, `close`, and during the generation loop).

### Phase 3: LLM Response & Message Completeness (~30%)

**Files:** `src/llm/types.ts`, `src/llm/client.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`

**Tasks:**
- [ ] Refactor `src/llm/types.ts` to define the unified `FinishReason` type and add `raw` strings for provider-specific reasons.
- [ ] Update `GenerateResponse` to include `id`, `raw`, and `warnings`.
- [ ] Add convenience accessors (`.text`, `.tool_calls`, `.reasoning`) to the response wrapper or class.
- [ ] Create factory methods for `Message` (`Message.system()`, `Message.user()`, `Message.assistant()`, `Message.tool_result()`).
- [ ] Update OpenAI, Anthropic, and Gemini adapters to return the normalized fields and translate provider-specific stop reasons into the unified `FinishReason` mapping (including Gemini's `SAFETY`/`RECITATION` to `content_filter`).

### Phase 4: LLM Error Classification & Retry Header Handling (~30%)

**Files:** `src/llm/errors.ts`, `src/llm/retry.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`

**Tasks:**
- [ ] Update `src/llm/errors.ts` to include `ServerError`, `AbortError`, `InvalidToolCallError`, and `UnsupportedToolChoiceError`. Ensure `LLMError` includes `error_code`, `retry_after`, and `raw` fields.
- [ ] Update `src/llm/retry.ts` to strictly honor `Retry-After` against `max_delay`. If `Retry-After` exceeds `max_delay`, it should throw instead of delaying.
- [ ] Update OpenAI adapter to map 403, 404, 408, 413, and 422 to correct subclasses.
- [ ] Update Gemini adapter to map 403, 404, 408, 413, and 422 correctly (and stop mapping 403 to AuthenticationError).
- [ ] Update Anthropic adapter to handle the standard 500-504 range, 403, and 404 correctly.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/retry.ts` | Modify | Add jitter, correct presets |
| `src/engine/engine.ts` | Modify | Add `should_retry` predicate |
| `src/handlers/tool.ts` | Modify | Fix context update key |
| `src/agent-loop/types.ts` | Modify | Add missing events definitions |
| `src/agent-loop/events.ts` | Modify | Map missing events |
| `src/agent-loop/session.ts` | Modify | Emit lifecycle events |
| `src/llm/types.ts` | Modify | Unified FinishReason, full Response interface |
| `src/llm/client.ts` | Modify | Implement Message factories and Response accessors |
| `src/llm/errors.ts` | Modify | Add missing error classes and LLMError fields |
| `src/llm/retry.ts` | Modify | Fix Retry-After max_delay logic |
| `src/llm/adapters/openai.ts` | Modify | Error classification, FinishReason mapping |
| `src/llm/adapters/anthropic.ts` | Modify | Error classification, FinishReason mapping |
| `src/llm/adapters/gemini.ts` | Modify | Error classification, FinishReason mapping |

---

## Definition of Done

- [ ] `npm run test` passes with all engine retry changes.
- [ ] Engine retry tests explicitly verify jitter is applied and presets match spec values.
- [ ] `AgentSession` tests verify all new lifecycle events (`SESSION_START`, `SESSION_END`, etc.) are emitted correctly.
- [ ] All LLM adapters map 401, 403, 404, 413, 422, 429, and 500+ to the correct unified `LLMError` subclasses.
- [ ] LLM tests verify that `GenerateResponse` includes `.text()`, `raw`, `id`, and standard `FinishReason`.
- [ ] Retry middleware tests verify that a `Retry-After` header exceeding `max_delay` immediately throws instead of retrying.
- [ ] Tool node correctly places its output in `context_updates["tool.output"]`.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Error classification changes break existing fallback logic | Medium | High | Exhaustive unit tests for each adapter's `classifyError` method to ensure exact mappings. |
| Convenience accessors to `GenerateResponse` clash with plain object serialization | Low | Medium | Implement as pure getters or a light class wrapper that implements `toJSON` cleanly. |
| Adding jitter to retries makes tests non-deterministic | High | Low | Mock `Math.random` in the test suite or assert that delays fall within the expected min/max jitter range. |

---

## Dependencies

- No external packages needed. Relies purely on internal refactoring of existing modules.
