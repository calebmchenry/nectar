# Sprint 024: Green Suite, Error Taxonomy, Streaming Reasoning Lifecycle & Structured Timeouts

## Overview

**Goal:** Fix the 3 persistent test failures carried from Sprint 022, then close the 4 highest-impact remaining compliance gaps: error subtypes for quota exhaustion and stream errors (GAP-3), streaming reasoning event lifecycle (GAP-6), structured timeout configuration (GAP-8), and named retry preset policies (GAP-4). After this sprint, the test suite is green, error classification is precise, streaming consumers get proper reasoning lifecycle events, timeout control is granular, and retry behavior is tunable by pipeline authors.

**Why this sprint, why now:**

1. **The test suite is still red.** Sprint 023's validation report shows 3 failures carried forward from Sprint 022: `gardens-draft` assertion mismatch, `hive-run-flow` timeout, and `pipeline-events` missing `pipeline_failed`. Two consecutive sprints have failed to close these. They must be fixed before any further feature work — a red suite makes every future validation report untrustworthy.

2. **GAP-3 (error subtypes) is load-bearing for production resilience.** Distinguishing `QuotaExceededError` from `RateLimitError` determines whether retry is appropriate (quota = no, rate limit = yes). `StreamError` as a distinct type lets consumers handle mid-stream disconnects differently from connection failures. Without these, pipelines waste retry budget on unrecoverable failures and cannot diagnose stalled streams.

3. **GAP-6 (streaming reasoning lifecycle) breaks the spec's universal content pattern.** Text and tool calls follow `start → delta → end`. Reasoning/thinking emits only `delta` events with no lifecycle boundaries. Stream consumers cannot reliably detect when reasoning begins or ends, which breaks progressive UI rendering and resource management.

4. **GAP-8 (structured TimeoutConfig) prevents zombie connections and stalled streams.** A single flat `timeout_ms` number forces a tradeoff between fast connection failure detection and accommodating slow model inference. Separate `connect_ms`, `request_ms`, and `stream_read_ms` resolve this. First-party consumers (garden drafting, swarm analysis) need bounded latency.

5. **GAP-4 (named retry presets) is the last engine-level compliance gap.** Every engine feature — parallel execution, fan-in, conditions, checkpointing, manager loops, composition — is implemented. But pipeline authors cannot select `standard`, `aggressive`, `linear`, or `patient` retry policies by name. This directly affects how real pipelines handle transient failures.

6. **After this sprint, only optional/future-looking gaps remain.** GAP-1 (AUDIO/DOCUMENT content types) is for modalities no provider fully offers today. GAP-2 (Gemini extended tools) is explicitly optional per spec. GAP-5 (edit_file fuzzy matching) is "may" in the spec. GAP-7 (incremental JSON parsing) is a UX optimization. None of these block real-world pipeline execution.

**Gaps closed:**

| Gap | Source | Effort | Impact |
|-----|--------|--------|--------|
| 3 test failures (Sprint 022 regressions) | validation-report.md | Medium | Green test suite — prerequisite for everything |
| GAP-3: QuotaExceeded, StreamError subtypes | unified-llm-spec §6.1 | Small | Correct retry/no-retry classification; honest failure reporting |
| GAP-6: Streaming reasoning event lifecycle | unified-llm-spec §3.14 | Medium | Consistent start/delta/end for all content types |
| GAP-8: Structured TimeoutConfig | unified-llm-spec §4.7 | Medium | Granular timeout control for adapters and first-party consumers |
| GAP-4: Named retry preset policies | attractor-spec §3.6 | Medium | Pipeline authors can tune retry behavior per-node |

**Deliberately deferred:**

- GAP-1: AUDIO/DOCUMENT content types — no provider fully uses these today; defer to a dedicated multimodal sprint
- GAP-2: Gemini extended tools (read_many_files, list_dir) — optional per spec
- GAP-5: Edit file fuzzy matching — "may" in spec, quality-of-life only
- GAP-7: Incremental JSON parsing in streamObject() — UX optimization, not blocking

**Cut line:** If the sprint compresses, cut GAP-4 (retry presets) first, then GAP-8 (TimeoutConfig). Do not cut the test fixes, GAP-3 (error subtypes), or GAP-6 (reasoning lifecycle). The test fixes are a prerequisite; error taxonomy and reasoning lifecycle are the load-bearing deliverables.

**Out of scope:**

- New CLI commands or Hive UI features
- New handler types
- Audio/document content type support
- Gemini extended tools
- Changes to condition expressions or parallel/fan-in behavior
- Incremental JSON parsing for streamObject()

---

## Use Cases

1. **Quota exhaustion vs. rate limiting:** A pipeline hits Anthropic's monthly token quota. The engine receives a `QuotaExceededError` (not retryable) instead of a `RateLimitError` (retryable). The node immediately fails with a clear "quota exhausted" message instead of burning through 5 retry attempts that will all fail.

2. **Mid-stream disconnect recovery:** An SSE connection drops mid-response. The adapter raises `StreamError` with the partial content received so far. The retry middleware knows not to retry (content was already yielded) but the consumer can distinguish "stream broke" from "server never responded."

3. **Reasoning lifecycle in the Hive:** A user runs a pipeline with a Claude node that uses extended thinking. The Hive UI shows a "Thinking..." indicator when `thinking_start` fires, streams thinking tokens via `thinking_delta`, and collapses the thinking panel on `thinking_end`. Without lifecycle events, the UI cannot know when thinking begins or ends.

4. **Granular timeout control:** A long-running Gemini call needs 5 minutes for the full response but only 10 seconds to establish the connection. `TimeoutConfig` allows `connect_ms: 10_000, request_ms: 300_000` instead of a single 300s timeout that hides connection failures. A stalled stream that stops sending chunks is detected within 30s via `stream_read_ms`.

5. **Bounded latency for interactive drafting:** `POST /gardens/draft` uses a short timeout policy suited to interactive editing. The request either completes quickly or fails with a draft error the browser can surface immediately, rather than hanging indefinitely.

6. **Retry policy by name:** A pipeline author writes `max_retries=5; retry_policy="patient"` on an LLM node that calls a rate-limited API. The engine uses 2s initial delay with 3.0x factor instead of the default 200ms/2.0x. A different node uses `retry_policy="aggressive"` for fast recovery from transient network blips.

7. **Graph-level default retry policy:** A garden sets `default_retry_policy="standard"` at graph level. All nodes without explicit policies inherit 5-attempt, 200ms-base, 2.0x-factor backoff. Individual nodes can override.

8. **Green CI gate:** A contributor opens a PR. CI runs `npm test` and all tests pass. The contributor does not need to investigate whether failures are "known" or new — the suite is authoritative.

---

## Architecture

### Design Principles

1. **Fix first, build second.** The 3 test failures are Phase 0. No feature work begins until the suite is green. This is non-negotiable.

2. **Error taxonomy extends, never replaces.** `QuotaExceededError` extends `LLMError` alongside the existing hierarchy. `StreamError` does the same. Existing catch blocks that match `RateLimitError` are unaffected.

3. **Streaming lifecycle follows the existing pattern.** Text has `content_delta`. Tool calls have `tool_call_delta`. Reasoning gets `thinking_start`, `thinking_delta`, `thinking_end` — same naming convention, same event flow. Adapters that natively expose lifecycle boundaries (Anthropic's `content_block_start`/`content_block_stop`) map directly; adapters that only emit deltas synthesize boundaries by tracking state transitions.

4. **Timeouts are layered, not flat.** The LLM layer needs separate control for connection establishment, full request duration, and stream idle time. A single shared timeout helper centralizes all abort signal composition so adapters don't reinvent it.

5. **Retry presets are data, not code.** Named presets are a lookup table mapping name → config values. The existing retry infrastructure already accepts configurable parameters — presets are a thin convenience layer on top.

6. **TimeoutConfig is additive.** The existing `timeout_ms` field continues to work as a shorthand. `TimeoutConfig` is an alternative that provides granularity. Adapters use `TimeoutConfig` internally; the public API accepts either.

### Phase 0: Test Failure Root Causes

**gardens-draft assertion (`digraph Drafted` vs `digraph {`):** The test expects the mock LLM to produce a garden named "Drafted" but the mock returns generic `digraph {` content. Fix: align the mock LLM response with the assertion, or adjust the assertion to match the actual mock output. The mock must be deterministic.

**hive-run-flow timeout:** The full HTTP integration flow (preview → save → run → question → cancel → resume → replay) times out at 5s test + 10s hook. Root cause is likely the cancel/resume race that Sprint 023 partially fixed — the `pending_abort_reason` mechanism works but the broader flow still has a timing window. Fix: ensure the engine attachment and abort queueing happen within the test's timing budget.

**pipeline-events missing `pipeline_failed`:** The engine emits `stage_failed` when a node fails but `pipeline_failed` (emitted by `finishError()`) only fires when no next edge is found. When a node fails and there IS a failure edge, `pipeline_failed` is never emitted. Fix: emit `pipeline_failed` when the pipeline reaches a terminal failure state (exit node with failure status, or no remaining edges after a failure), not only on "no edge found."

### Error Taxonomy Extensions (GAP-3)

Add to `src/llm/errors.ts`:

```typescript
export class QuotaExceededError extends LLMError {
  retryable = false;  // Quota is a billing/usage limit, not transient
}

export class StreamError extends LLMError {
  retryable = false;  // Content may have been yielded
  partial_content?: string;
  phase?: 'transport' | 'sse_parse' | 'idle_timeout';
}
```

Adapter detection:
- **Anthropic:** HTTP 529 or error body containing "quota" → `QuotaExceededError`
- **OpenAI:** HTTP 429 with `type: "insufficient_quota"` → `QuotaExceededError`
- **Gemini:** HTTP 429 with `RESOURCE_EXHAUSTED` and quota detail → `QuotaExceededError`
- All adapters: connection drop or malformed SSE during active stream → `StreamError`

`StreamError` carries the stream phase (`transport`, `sse_parse`, `idle_timeout`) and a bounded partial text preview when available. This allows consumers to distinguish "never connected" from "connected but broke mid-stream."

Retry middleware: `QuotaExceededError.retryable = false` means the existing retry logic already skips it. `StreamError.retryable = false` because content was (or may have been) yielded.

### Streaming Reasoning Event Lifecycle (GAP-6)

Add two new stream event types to `src/llm/streaming.ts`:

```typescript
| { type: 'thinking_start' }
| { type: 'thinking_end' }
```

Adapter changes:
- **Anthropic adapter:** Emit `thinking_start` on `content_block_start` with type `thinking`. Emit `thinking_end` on `content_block_stop` for thinking blocks. Direct mapping — no synthesis needed.
- **Gemini adapter:** Track thinking state; emit `thinking_start` before the first thinking part, `thinking_end` when transitioning to non-thinking content or stream end. Synthesis required.
- **OpenAI adapter:** Emit `thinking_start`/`thinking_end` around reasoning summary tokens (if exposed by the Responses API). No-op when absent.
- **OpenAI-Compatible adapter:** Same as OpenAI if reasoning tokens are present; no-op otherwise.

The `thinking_delta` event continues to carry the incremental text. The new events are lifecycle markers only (no payload beyond the type). Existing consumers that handle only `thinking_delta` are unaffected — the new events are additive.

### Structured TimeoutConfig (GAP-8)

Add to `src/llm/types.ts`:

```typescript
export interface TimeoutConfig {
  /** Connection establishment timeout. Default: 10000 */
  connect_ms?: number;
  /** Full request timeout. Default: 120000 */
  request_ms?: number;
  /** Interval between SSE chunks before considering stream dead. Default: 30000 */
  stream_read_ms?: number;
}
```

`GenerateRequest` gains `timeout?: number | TimeoutConfig`. When a number, it maps to `request_ms` for backward compatibility.

Create a single shared timeout helper in `src/llm/timeouts.ts` that:
- Composes abort signals for connect/request/stream-read
- Resets the stream-read timer on each received chunk
- Is the only place adapters interact with timeout abort signals

Default adapter limits: `connect_ms = 10_000`, `request_ms = 120_000`, `stream_read_ms = 30_000`.

First-party consumer defaults:
- `GardenDraftService`: `{ request_ms: 20_000 }`
- `SwarmAnalysisService`: `{ request_ms: 90_000 }`

The retry middleware must respect total timeout budget. If the budget is spent, the high-level call fails immediately.

### Named Retry Preset Policies (GAP-4)

Add a preset registry to `src/engine/retry.ts`:

```typescript
interface RetryPreset {
  name: string;
  max_retries: number;
  initial_delay_ms: number;
  multiplier: number;
  max_delay_ms: number;
  strategy: 'exponential' | 'linear';
}

const PRESETS: Record<string, RetryPreset> = {
  none:       { name: 'none',       max_retries: 0, initial_delay_ms: 0,    multiplier: 1.0, max_delay_ms: 0,     strategy: 'exponential' },
  standard:   { name: 'standard',   max_retries: 5, initial_delay_ms: 200,  multiplier: 2.0, max_delay_ms: 60000, strategy: 'exponential' },
  aggressive: { name: 'aggressive', max_retries: 5, initial_delay_ms: 50,   multiplier: 1.5, max_delay_ms: 5000,  strategy: 'exponential' },
  linear:     { name: 'linear',     max_retries: 5, initial_delay_ms: 1000, multiplier: 1.0, max_delay_ms: 5000,  strategy: 'linear' },
  patient:    { name: 'patient',    max_retries: 8, initial_delay_ms: 2000, multiplier: 3.0, max_delay_ms: 120000,strategy: 'exponential' },
};
```

Resolution order: node `retry_policy` attribute → graph `default_retry_policy` attribute → hardcoded `standard` default (when `max_retries > 0`).

Node-level `max_retries` still overrides the preset's `max_retries`. The preset provides the backoff shape; `max_retries` provides the count. If both are set, the node's count wins.

Validation: `retry_policy` must be one of the known preset names. Unknown names produce a WARNING diagnostic.

---

## Implementation

### Phase 0: Fix Sprint 022/023 Test Failures (~15%)

**Files:** `src/engine/engine.ts`, `src/server/run-manager.ts`, `src/server/routes/gardens.ts`, `src/runtime/garden-draft-service.ts`, `test/server/gardens-draft.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/server/pipeline-events.test.ts`

**Tasks:**
- [ ] Fix `pipeline_failed` emission: ensure the engine emits `pipeline_failed` when a pipeline terminates due to node failure (not just when no edge is found). Trace the path from node failure → exit node → finalization and confirm the event is emitted before `run_completed` or `run_error`.
- [ ] Fix `gardens-draft` test: align mock LLM output with the assertion, or fix the assertion to match the deterministic mock. The mock must produce predictable content that the test can assert against.
- [ ] Fix `hive-run-flow` timeout: profile the test to find the bottleneck. Likely candidates: engine attachment delay, cancel queueing latency, or resume setup time. Fix the root cause rather than increasing the timeout.
- [ ] **Gate:** `npm test` must be fully green before proceeding to Phase 1

### Phase 1: Error Taxonomy (GAP-3) (~20%)

**Files:** `src/llm/errors.ts`, `src/llm/streaming.ts`, `src/llm/retry.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `test/llm/errors.test.ts` (create or extend), `test/llm/client.test.ts`

**Tasks:**

**Error subtypes:**
- [ ] Add `QuotaExceededError` class extending `LLMError` with `retryable = false`
- [ ] Add `StreamError` class extending `LLMError` with `retryable = false`, optional `partial_content`, and `phase`
- [ ] Anthropic adapter: detect quota-specific 429/529 responses → `QuotaExceededError`
- [ ] OpenAI adapter: detect `insufficient_quota` error type → `QuotaExceededError`
- [ ] Gemini adapter: detect `RESOURCE_EXHAUSTED` with quota detail → `QuotaExceededError`
- [ ] All adapters: connection drop or malformed SSE mid-stream → `StreamError` with partial content and phase
- [ ] Verify retry middleware skips `QuotaExceededError` and `StreamError`
- [ ] Unit tests: each error type created, retryable flags correct, adapter detection logic

### Phase 2: Streaming Reasoning Event Lifecycle (GAP-6) (~20%)

**Files:** `src/llm/streaming.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/openai-compatible.ts`, `test/llm/streaming.test.ts` (create or extend), `test/llm/anthropic.test.ts` (extend), `test/llm/gemini.test.ts` (extend)

**Tasks:**
- [ ] Add `thinking_start` and `thinking_end` to the `StreamEvent` type union in `src/llm/streaming.ts`
- [ ] Anthropic adapter: emit `thinking_start` on `content_block_start` with `type: "thinking"`, emit `thinking_end` on `content_block_stop` for thinking blocks
- [ ] Gemini adapter: track thinking state; emit `thinking_start` before first thinking part, `thinking_end` when transitioning to non-thinking content or stream end
- [ ] OpenAI adapter: emit lifecycle events around reasoning summary tokens if present; no-op if absent
- [ ] OpenAI-Compatible adapter: same as OpenAI
- [ ] Ensure `thinking_delta` events only appear between `thinking_start` and `thinking_end`
- [ ] Unit tests: verify the full `start → delta* → end` lifecycle for each adapter
- [ ] Verify existing tests still pass (thinking_delta events still emitted)

### Phase 3: Structured TimeoutConfig (GAP-8) (~20%)

**Files:** `src/llm/types.ts`, `src/llm/timeouts.ts` (create), `src/llm/client.ts`, `src/llm/streaming.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `src/runtime/garden-draft-service.ts`, `src/runtime/swarm-analysis-service.ts`, `test/llm/timeouts.test.ts` (create), `test/llm/client.test.ts`

**Tasks:**
- [ ] Define `TimeoutConfig` interface in `src/llm/types.ts`
- [ ] Update `GenerateRequest.timeout` to accept `number | TimeoutConfig`
- [ ] Create `src/llm/timeouts.ts` with shared timeout helper: `resolveTimeout()`, abort signal composition, stream-read timer reset
- [ ] Update SSE parser to enforce `stream_read_ms` per-chunk deadline
- [ ] Update adapters to use `connect_ms` for connection and `request_ms` for full request
- [ ] Backward compatibility: bare `number` maps to `request_ms`
- [ ] Migrate `GardenDraftService` and `SwarmAnalysisService` to explicit `TimeoutConfig`
- [ ] Unit tests: resolution logic, backward compat, per-chunk stream timeout, total budget exhaustion

### Phase 4: Named Retry Preset Policies (GAP-4) (~15%)

**Files:** `src/engine/retry.ts`, `src/engine/engine.ts`, `src/garden/types.ts`, `src/garden/parse.ts`, `src/garden/validate.ts`, `test/engine/retry.test.ts` (create), `test/garden/parse.test.ts`, `test/garden/validate.test.ts`, `test/fixtures/retry-presets.dot` (create)

**Tasks:**

**Preset registry:**
- [ ] Define the `RetryPreset` interface and the 5 named presets (`none`, `standard`, `aggressive`, `linear`, `patient`) in `src/engine/retry.ts`
- [ ] Add `getRetryPreset(name: string): RetryPreset | undefined` lookup function
- [ ] Add `linear` strategy support to the backoff calculator (constant delay = `initial_delay_ms` on every attempt)
- [ ] Modify `computeBackoff()` to accept a `RetryPreset` and dispatch to exponential or linear strategy

**Parsing and validation:**
- [ ] Add `retry_policy` as a recognized node attribute in `src/garden/types.ts`
- [ ] Add `default_retry_policy` as a recognized graph attribute in `src/garden/types.ts`
- [ ] Parse both attributes in `src/garden/parse.ts`
- [ ] Validate `retry_policy` values against known preset names in `src/garden/validate.ts` (WARNING for unknown names)

**Engine integration:**
- [ ] Resolve retry configuration in the engine: node `retry_policy` → graph `default_retry_policy` → `standard` (when `max_retries > 0`)
- [ ] Node-level `max_retries` overrides preset `max_retries` when both are set
- [ ] Pass resolved preset to `computeBackoff()` during retry

**Tests:**
- [ ] Unit tests for each preset: verify delay sequence for 3 attempts
- [ ] Unit test for linear strategy: constant delay
- [ ] Unit test for node `max_retries` overriding preset count
- [ ] Unit test for graph-level `default_retry_policy` inheritance
- [ ] Validation test: unknown `retry_policy` produces WARNING
- [ ] Integration test: fixture garden with `retry_policy="patient"` node that retries with correct delays

### Phase 5: Validation (~10%)

**Files:** `docs/sprints/validation-report.md`

**Tasks:**
- [ ] Run `npm test`, `npm run build`, and `bun build --compile` — all must pass
- [ ] Verify all 3 previously-failing tests are green
- [ ] Run a garden fixture with named retry presets end-to-end
- [ ] Update the sprint validation report

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/engine.ts` | Modify | Fix `pipeline_failed` emission; integrate retry preset resolution |
| `src/engine/retry.ts` | Modify | Add preset registry, linear strategy, `getRetryPreset()` |
| `src/garden/types.ts` | Modify | Add `retry_policy` (node) and `default_retry_policy` (graph) |
| `src/garden/parse.ts` | Modify | Parse `retry_policy` and `default_retry_policy` attributes |
| `src/garden/validate.ts` | Modify | Validate retry_policy against known preset names |
| `src/llm/errors.ts` | Modify | Add `QuotaExceededError` and `StreamError` classes |
| `src/llm/types.ts` | Modify | Add `TimeoutConfig` interface; extend `GenerateRequest.timeout` |
| `src/llm/timeouts.ts` | Create | Centralize timeout resolution, abort signal composition, stream-read timer |
| `src/llm/streaming.ts` | Modify | Add `thinking_start`/`thinking_end` events; enforce `stream_read_ms` |
| `src/llm/retry.ts` | Modify | Verify skip logic for new error types; respect total timeout budget |
| `src/llm/client.ts` | Modify | Thread structured timeouts through generate/stream calls |
| `src/llm/adapters/anthropic.ts` | Modify | Reasoning lifecycle events; quota detection; timeout wiring |
| `src/llm/adapters/gemini.ts` | Modify | Reasoning lifecycle events; quota detection; timeout wiring |
| `src/llm/adapters/openai.ts` | Modify | Reasoning lifecycle events; quota detection; timeout wiring |
| `src/llm/adapters/openai-compatible.ts` | Modify | Reasoning lifecycle events; timeout wiring |
| `src/runtime/garden-draft-service.ts` | Modify | Adopt explicit TimeoutConfig for interactive drafting |
| `src/runtime/swarm-analysis-service.ts` | Modify | Adopt explicit TimeoutConfig for analysis |
| `src/server/run-manager.ts` | Modify | Fix cancel/resume race for hive-run-flow |
| `src/server/routes/gardens.ts` | Modify | Fix draft SSE assertion alignment |
| `test/engine/retry.test.ts` | Create | Preset registry, linear strategy, resolution precedence |
| `test/fixtures/retry-presets.dot` | Create | Garden fixture exercising named presets |
| `test/llm/errors.test.ts` | Create/Extend | QuotaExceeded, StreamError tests |
| `test/llm/timeouts.test.ts` | Create | Timeout resolution, backward compat, stream idle tests |
| `test/llm/streaming.test.ts` | Create/Extend | Reasoning lifecycle event tests |
| `test/llm/client.test.ts` | Modify | TimeoutConfig resolution tests |
| `test/server/gardens-draft.test.ts` | Modify | Fix assertion to match deterministic mock |
| `test/integration/hive-run-flow.test.ts` | Modify | Fix timing/race root cause |
| `test/server/pipeline-events.test.ts` | Modify | Verify pipeline_failed emission |

---

## Definition of Done

**Phase 0: Test Failures**
- [ ] `test/server/gardens-draft.test.ts` passes — draft SSE produces deterministic content matching assertions
- [ ] `test/integration/hive-run-flow.test.ts` passes — full preview/save/run/question/cancel/resume/replay flow completes within timeout
- [ ] `test/server/pipeline-events.test.ts` passes — failure runs emit `stage_failed`, `pipeline_failed`, and `run_error` in order
- [ ] Zero test failures in the full suite before Phase 1 begins

**Phase 1: Error Taxonomy (GAP-3)**
- [ ] `QuotaExceededError` has `retryable = false`
- [ ] `StreamError` has `retryable = false`, carries optional `partial_content` and `phase`
- [ ] Each adapter correctly classifies quota responses as `QuotaExceededError`
- [ ] Mid-stream disconnects produce `StreamError`, not `NetworkError`
- [ ] Retry middleware does not retry `QuotaExceededError` or `StreamError`
- [ ] Unit tests for each error type, retryable flags, and adapter detection

**Phase 2: Streaming Reasoning Lifecycle (GAP-6)**
- [ ] `thinking_start` event emitted before first `thinking_delta` in a reasoning block
- [ ] `thinking_end` event emitted after last `thinking_delta` in a reasoning block
- [ ] Anthropic adapter: lifecycle events map to `content_block_start`/`content_block_stop`
- [ ] Gemini adapter: lifecycle events wrap thinking part sequences via state tracking
- [ ] OpenAI/OpenAI-Compatible: lifecycle events wrap reasoning tokens (no-op when absent)
- [ ] Existing `thinking_delta` behavior unchanged
- [ ] Unit tests verify `start → delta* → end` pattern for each adapter

**Phase 3: Structured Timeouts (GAP-8)**
- [ ] `TimeoutConfig` with `connect_ms`, `request_ms`, `stream_read_ms` fields accepted
- [ ] Bare `number` in `timeout` maps to `request_ms` (backward compatible)
- [ ] `stream_read_ms` enforced by SSE parser per-chunk with timer reset
- [ ] Adapters use `connect_ms` for connection timeout
- [ ] `GardenDraftService` and `SwarmAnalysisService` use explicit TimeoutConfig
- [ ] Total timeout budget respected across retries

**Phase 4: Named Retry Presets (GAP-4)**
- [ ] `none` preset: 0 retries, no backoff
- [ ] `standard` preset: 5 retries, 200ms initial, 2.0x exponential, 60s max
- [ ] `aggressive` preset: 5 retries, 50ms initial, 1.5x exponential, 5s max
- [ ] `linear` preset: 5 retries, 1s constant delay, 5s max
- [ ] `patient` preset: 8 retries, 2s initial, 3.0x exponential, 120s max
- [ ] Node-level `retry_policy="patient"` selects the patient preset
- [ ] Graph-level `default_retry_policy="standard"` applies to all nodes without explicit policy
- [ ] Node `max_retries` overrides preset `max_retries` when both are specified
- [ ] Unknown `retry_policy` values produce a WARNING diagnostic
- [ ] Integration test: garden with `retry_policy="patient"` retries with correct delays

**Cross-cutting**
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing and new tests with zero failures
- [ ] `bun build --compile` succeeds
- [ ] No breaking changes to public API signatures (all additions are backward-compatible)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Test failures have deeper root causes than expected | Medium | High | Phase 0 is timeboxed but not cut-able. If a fix requires engine changes, make them. The suite must be green. |
| `pipeline_failed` emission change affects other tests | Medium | Medium | The event should have been emitted all along. Run the full suite after the fix. Any test incorrectly passing without `pipeline_failed` needs updating. |
| Provider-specific quota detection is fragile | Medium | Medium | Each provider's quota response format is documented. Detection falls through to `RateLimitError` (safe default) if the format changes. |
| Reasoning lifecycle events break existing stream consumers | Low | Medium | New events are additive. Consumers that don't handle `thinking_start`/`thinking_end` simply ignore them. `thinking_delta` is unchanged. |
| `stream_read_ms` false positives on slow models | Medium | Medium | Default 30s is generous. Timer resets on each chunk, so thinking is fine as long as tokens arrive. |
| Timeout layers fight each other and produce confusing aborts | Medium | High | Put all timeout composition in one helper module (`src/llm/timeouts.ts`) and test total/per-step/stream-idle interactions directly. |
| Retry preset values don't match spec intent | Low | Medium | Values derived from the spec's descriptions. Document exact values. Presets are data — trivial to adjust. |
| hive-run-flow timeout is a genuine performance issue, not a race | Low | Medium | Profile first. If the flow is genuinely slow, optimize the hot path. If it's a race, fix the race. Don't increase the timeout without understanding why. |

---

## Dependencies

| Dependency | Type | Status |
|-----------|------|--------|
| No new packages | Runtime | — |
| Provider API docs for quota error formats | Documentation | Available |

This sprint adds zero new dependencies. Error subtypes extend an existing class hierarchy. Reasoning lifecycle events extend an existing type union. TimeoutConfig is a new interface consumed by existing adapter code. Retry presets are a data table. All changes are localized and additive.

The only prerequisite is that the Sprint 023 codebase compiles and the passing tests remain stable. The 3 failing tests are addressed in Phase 0.
