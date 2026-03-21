# Sprint 028: Unified LLM Response Contract & Green Suite

## Overview

**Goal:** Close every Unified LLM Spec gap (compliance gaps 11–26), fix the 5 remaining test failures, and ship the engine retry jitter fix (gap 10). After this sprint: the LLM client layer fully matches the unified-llm-spec, CI is green, and every downstream consumer — agent sessions, the Hive, and external callers — gets a complete, spec-compliant response contract.

**Why this sprint, why now:**

1. **The Unified LLM layer is the foundation everything else stands on.** Agent sessions, codergen handlers, swarm analysis, the Hive's draft streaming — every feature that touches an LLM goes through `UnifiedClient`. The 16 remaining LLM spec gaps (11–26) mean every consumer works around missing fields, inconsistent stop reasons, and incomplete streaming contracts. Fixing the foundation unblocks cleaner code everywhere else.

2. **The gaps form a tight, self-contained cluster.** Gaps 11–26 touch `src/llm/types.ts` (type additions), `src/llm/client.ts` (generate/stream enhancements), `src/llm/errors.ts` (missing error classes), `src/llm/tools.ts` (tool contract), the four adapter files, and one new module (`src/llm/stream-accumulator.ts`). There are no cross-cutting concerns with the engine, server, or CLI. This is the cleanest possible sprint boundary.

3. **5 tests still fail.** The red suite has survived since Sprint 022. This sprint makes green the Phase 1 gate — no subsequent work starts until `npm test` reports zero failures. The timeout failures share a root cause in SSE lifecycle management; the others are assertion mismatches.

4. **The engine retry jitter is a one-line fix with disproportionate correctness impact.** Gap 10 (`[0.5, 1.0]` → `[0.5, 1.5]`) aligns the engine with both the spec and the already-correct LLM retry implementation. It rides for free.

5. **The remaining non-LLM gaps (2–9) are low-urgency interface additions.** ExecutionEnvironment missing methods, environment context missing OS version — these are real gaps but have zero runtime behavior impact today. Nobody swaps ExecutionEnvironment implementations, and the missing context fields don't affect model behavior. Deferring these to a focused agent-loop polish sprint keeps this sprint's blast radius contained.

**Gaps closed:**

| Phase | Gap IDs | Count | Description |
|-------|---------|-------|-------------|
| 1 | — | 5 | Green suite: fix 5 failing tests |
| 2 | 11 | 1 | FinishReason unified naming with `reason` + `raw` |
| 2 | 12 | 1 | Response `id` field from provider |
| 2 | 13 | 1 | Response `raw` field for debugging |
| 2 | 14 | 1 | Response `warnings` field |
| 2 | 15 | 1 | Response convenience accessors (`.text`, `.tool_calls`, `.reasoning`) |
| 2 | 16 | 1 | Message factory methods |
| 3 | 17 | 1 | GenerateResult / StepResult with usage aggregation |
| 3 | 20 | 1 | `prompt` shorthand on generate() |
| 3 | 21 | 1 | `stop_when` / StopCondition for tool loops |
| 4 | 18 | 1 | StreamResult wrapper |
| 4 | 19 | 1 | StreamAccumulator utility |
| 4 | 25 | 1 | stream() tool loop with step_finish events |
| 5 | 22 | 1 | Tool `execute` handler on ToolDefinition |
| 5 | 23 | 1 | Active/passive tool distinction |
| 5 | 24 | 1 | Tool context injection |
| 5 | 26 | 1 | Missing error classes (ServerError, AbortError, etc.) |
| 6 | 10 | 1 | Engine retry jitter range [0.5, 1.5] |
| — | **Total** | **21** | 16 LLM spec gaps + 5 test failures + engine jitter |

**Out of scope:**

- Coding agent loop gaps (2–9) — ExecutionEnvironment interface additions, environment context fields. Real but zero runtime behavior impact; defer to a focused agent-loop sprint.
- Attractor spec gap 1 (retry preset parameter exact values) — needs spec document comparison; low urgency.
- Hive UI features, CLI distribution, seedbed enhancements, dark mode.
- New HTTP endpoints or server features.

---

## Use Cases

1. **CI goes green.** `npm test` passes with zero failures. The 5 persistent test failures are resolved by fixing SSE lifecycle bugs and assertion mismatches — not by increasing timeouts.

2. **A caller inspects why the model stopped.** After `generate()`, the caller reads `response.finish_reason.reason` and gets a normalized string (`"stop"`, `"length"`, `"tool_calls"`) regardless of whether the underlying provider was Anthropic, OpenAI, or Gemini. `response.finish_reason.raw` preserves the provider-native value for debugging.

3. **A caller builds messages ergonomically.** Instead of constructing `{ role: 'user', content: [...] }` objects by hand, callers use `Message.user("Review this code")`, `Message.system("You are a code reviewer")`, `Message.tool_result(callId, output)`.

4. **A caller gets the response text in one line.** `response.text` returns the concatenated text content. `response.tool_calls` returns an array of tool calls. `response.reasoning` returns thinking blocks. No manual content-part iteration.

5. **A caller uses a string prompt.** `await generate({ prompt: "Summarize this", model: "claude-sonnet-4-20250514" })` works without wrapping in a messages array.

6. **A caller defines when to stop.** `await generate({ ..., stop_when: (response) => response.text.includes("DONE") })` exits the tool loop early based on custom logic.

7. **A caller collects streaming into a response.** `const acc = new StreamAccumulator(); for await (const e of stream(req)) { acc.push(e); } const response = acc.response()` — no manual event assembly.

8. **stream() handles tools automatically.** A streaming call with active tools executes tool calls between steps, emits `step_finish` events, and continues the conversation. The caller gets the full multi-step stream without managing the loop.

9. **Active tools execute automatically.** A tool defined with `execute: async (args) => { ... }` is auto-run by `generate()` and `stream()`. A tool without `execute` is passive — its calls are returned to the caller.

10. **Tool handlers receive context.** An active tool's `execute` function receives `{ messages, abort_signal, tool_call_id }` in addition to the parsed arguments, enabling context-aware tool implementations.

11. **Error handling is complete.** `ServerError` catches 500–504 responses. `AbortError` wraps cancellation. `InvalidToolCallError` and `UnsupportedToolChoiceError` give specific diagnostics instead of generic errors.

12. **Engine retries use correct jitter.** Retry delays vary by ±50% around the computed backoff (range [0.5, 1.5]), matching the spec and preventing thundering-herd effects.

---

## Architecture

### Phase 1: Green Suite (SSE + assertion fixes)

The 5 failures decompose into three root causes:

- **Assertion mismatch (1 test):** `gardens-draft.test.ts` expects a DOT graph name that doesn't match the simulation output. Fix: align the assertion or the output.
- **SSE lifecycle bugs (3 tests):** `hive-run-flow`, `http-resume`, `seed-run-linkage` all timeout because SSE response streams are never closed on completion/error. Fix: audit every SSE endpoint for missing `res.end()` calls, verify event bus wiring in `server.ts`.
- **HTTP cancel lifecycle (1 test):** `http-server` cancel test fails because the cancel endpoint doesn't properly terminate the pipeline. Fix: ensure `RunManager.cancel()` triggers checkpoint + graceful shutdown and returns the correct status.

**Anti-pattern:** Timeout values must not be increased. If a test still times out after the fix, the root cause is not resolved.

### Phase 2: Response Contract (Gaps 11–16)

Enrich `GenerateResponse` with the missing fields and add `Message` factory methods. This is purely additive — existing consumers continue to work.

**`src/llm/types.ts`:**
- Add `FinishReason` record: `{ reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'other', raw: string }`.
- Replace `stop_reason: StopReason` with `finish_reason: FinishReason` on `GenerateResponse`. Keep `stop_reason` as a deprecated alias getter for one sprint.
- Add `id: string` (provider-assigned response ID).
- Add `raw: unknown` (raw provider response JSON).
- Add `warnings: Warning[]` with `Warning = { message: string, code: string }`.
- Add `.text`, `.tool_calls`, `.reasoning` as computed getter properties on a `GenerateResponse` class (promote from plain interface to class).
- Add `Message` namespace with static factory methods: `Message.system()`, `Message.user()`, `Message.assistant()`, `Message.tool_result()`.

**Adapter changes (`src/llm/adapters/*.ts`):**
- Each adapter maps its native stop reason to the unified `FinishReason.reason` and preserves the original in `.raw`.
- Each adapter extracts the provider's response ID and passes through the raw JSON body.
- Each adapter collects warnings (e.g., Anthropic's `type: "warning"` events).

### Phase 3: Generate Enhancements (Gaps 17, 20, 21)

**`src/llm/client.ts`:**
- `generate()` accepts `prompt: string` as an alternative to `messages`. If `prompt` is provided, wrap it as `[Message.user(prompt)]`.
- `generate()` returns `GenerateResult` instead of plain `GenerateResponse`. `GenerateResult` has `output` (the final response), `steps: StepResult[]` (one per tool loop iteration), and `total_usage` (aggregated across all steps).
- `generate()` accepts `stop_when: (response: GenerateResponse) => boolean`. After each tool execution step, if `stop_when` returns true, exit the tool loop early.

**`src/llm/types.ts`:**
- Add `GenerateResult = { output: GenerateResponse, steps: StepResult[], total_usage: Usage }`.
- Add `StepResult = { response: GenerateResponse, tool_calls: ToolCallData[], tool_results: ToolResultContentPart[] }`.
- Add `StopCondition = (response: GenerateResponse) => boolean`.

### Phase 4: Streaming Enhancements (Gaps 18, 19, 25)

**New file: `src/llm/stream-accumulator.ts`:**
- `StreamAccumulator` class that collects `StreamEvent`s and builds a complete `GenerateResponse` via `.response()`.
- Tracks content parts, tool calls, usage, finish reason incrementally.

**`src/llm/client.ts`:**
- `stream()` returns `StreamResult` instead of raw `AsyncIterable<StreamEvent>`.
- `StreamResult` exposes: `[Symbol.asyncIterator]()` (backward compat for `for await`), `.response()` (promise that resolves when complete), `.text_stream` (filtered async iterable of text deltas only), `.partial_response` (current accumulated state).
- When tools with `execute` handlers are provided, `stream()` runs the tool loop: execute tools → emit `step_finish` → continue. Each step's events are yielded to the caller.

### Phase 5: Tool Contract (Gaps 22, 23, 24) & Error Classes (Gap 26)

**`src/llm/types.ts` + `src/llm/tools.ts`:**
- Add optional `execute: (args: Record<string, unknown>, context?: ToolContext) => Promise<string>` to `ToolDefinition`.
- `ToolContext = { messages: Message[], abort_signal?: AbortSignal, tool_call_id: string }`.
- Add `isActiveTool(tool)` / `isPassiveTool(tool)` type guards.
- `generate()` and `stream()` auto-execute active tools; passive tool calls are returned to the caller.

**`src/llm/errors.ts`:**
- Add `ServerError` (general 500–504, retryable). `OverloadedError` becomes a subclass.
- Add `AbortError` (dedicated class, not retryable).
- Add `InvalidToolCallError` (for malformed tool calls).
- Add `UnsupportedToolChoiceError` (provider doesn't support the requested tool_choice mode).
- Map 500/502/504 to `ServerError` in adapters (keep 503 → `OverloadedError`).

### Phase 6: Engine Retry Jitter (Gap 10)

**`src/engine/retry.ts`:** One-line fix: `0.5 + Math.random() * 0.5` → `0.5 + Math.random()`.

---

## Implementation

### Phase 1: Green Suite (25% of effort)

**Files:** `src/server/routes/pipelines.ts`, `src/server/routes/seeds.ts`, `src/server/routes/gardens.ts`, `src/server/routes/events.ts`, `src/server/run-manager.ts`, `src/server/workspace-event-bus.ts`, `src/runtime/garden-draft-service.ts`, `src/handlers/fan-in.ts`, `test/server/gardens-draft.test.ts`, `test/integration/fan-in-llm.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/http-server.test.ts`, `test/integration/seed-run-linkage.test.ts`

**Tasks:**
- [ ] Audit every SSE endpoint in `routes/pipelines.ts`, `routes/seeds.ts`, `routes/gardens.ts`, `routes/events.ts` for missing `res.end()` on completion and error paths
- [ ] Verify event bus wiring in `server.ts` — every service that emits events must receive the event bus
- [ ] Fix `gardens-draft.test.ts`: align the assertion with the actual DOT output from the simulation provider
- [ ] Fix `http-server.test.ts` cancel test: ensure RunManager.cancel() triggers abort, checkpoint, and returns interrupted status
- [ ] Fix `hive-run-flow.test.ts` and `http-resume.test.ts`: fix the SSE promise lifecycle so streams close on run completion/cancellation
- [ ] Fix `seed-run-linkage.test.ts`: verify `linked_runs` propagation through event bus to meta.yaml; fix afterEach timeout by ensuring server.close() completes promptly
- [ ] Run `npm test` — must be 0 failures before proceeding. No timeout increases.

### Phase 2: Response Contract (20% of effort)

**Files:** `src/llm/types.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `test/llm/types.test.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/gemini.test.ts`

**Tasks:**
- [ ] Define `FinishReason` type with unified `reason` and `raw` fields
- [ ] Promote `GenerateResponse` from interface to class with getter properties for `.text`, `.tool_calls`, `.reasoning`
- [ ] Add `id`, `raw`, `warnings` fields to `GenerateResponse`
- [ ] Add `Message` namespace with `system()`, `user()`, `assistant()`, `tool_result()` factory methods
- [ ] Update Anthropic adapter: map `end_turn` → `stop`, `max_tokens` → `length`, `tool_use` → `tool_calls`, `stop_sequence` → `stop`; extract response ID; pass through raw body; collect warnings
- [ ] Update OpenAI adapter: map native stop reasons to unified FinishReason; extract response ID; pass through raw body
- [ ] Update Gemini adapter: map `STOP` → `stop`, `MAX_TOKENS` → `length`, `SAFETY` → `content_filter`; extract response ID; pass through raw body; generate synthetic ID if provider doesn't return one
- [ ] Update OpenAI-Compatible adapter: same mappings as OpenAI
- [ ] Add backward-compat: `stop_reason` getter that returns `finish_reason.reason` for one sprint
- [ ] Tests: verify unified finish reasons across all providers, factory method ergonomics, accessor correctness

### Phase 3: Generate Enhancements (15% of effort)

**Files:** `src/llm/types.ts`, `src/llm/client.ts`, `test/llm/client.test.ts`

**Tasks:**
- [ ] Define `GenerateResult`, `StepResult`, `StopCondition` types
- [ ] Modify `generate()` to accept `prompt: string` alternative — wrap as `[Message.user(prompt)]`
- [ ] Modify `generate()` to track steps and aggregate usage across tool loop iterations
- [ ] Modify `generate()` to return `GenerateResult` with `output`, `steps`, `total_usage`
- [ ] Implement `stop_when` parameter: after each tool execution step, evaluate the condition and exit early if true
- [ ] Update all callers of `generate()` to use `GenerateResult.output` where they previously used the raw response
- [ ] Tests: prompt shorthand, multi-step usage aggregation, stop_when early exit

### Phase 4: Streaming Enhancements (20% of effort)

**Files:** `src/llm/stream-accumulator.ts` (new), `src/llm/client.ts`, `src/llm/types.ts`, `src/llm/streaming.ts`, `test/llm/stream-accumulator.test.ts` (new), `test/llm/stream-object.test.ts`

**Tasks:**
- [ ] Implement `StreamAccumulator`: push(event), response(), partial state tracking
- [ ] Define `StreamResult` class: `[Symbol.asyncIterator]()`, `.response()`, `.text_stream`, `.partial_response`
- [ ] Modify `stream()` to return `StreamResult` wrapping the provider's event iterable
- [ ] Add `step_finish` to `StreamEvent` discriminated union
- [ ] Implement tool loop in `stream()`: detect active tools in events, execute them, emit `step_finish`, continue conversation
- [ ] Update all callers of `stream()` to use `StreamResult` (most iterate directly, which still works via `Symbol.asyncIterator`)
- [ ] Tests: accumulator builds correct response from event sequence, StreamResult text_stream filters correctly, stream tool loop executes active tools, step_finish events emitted

### Phase 5: Tool Contract & Error Classes (15% of effort)

**Files:** `src/llm/types.ts`, `src/llm/tools.ts`, `src/llm/errors.ts`, `src/llm/client.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `test/llm/tools.test.ts` (new), `test/llm/errors.test.ts`

**Tasks:**
- [ ] Add `execute` handler and `ToolContext` type to `ToolDefinition`
- [ ] Add `isActiveTool()` / `isPassiveTool()` type guards
- [ ] Modify `generate()` tool loop: auto-execute active tools, return passive tool calls to caller
- [ ] Modify `stream()` tool loop: same active/passive distinction
- [ ] Thread `ToolContext` (messages, abort_signal, tool_call_id) to execute handlers
- [ ] Add `ServerError` class (retryable, covers 500/502/504)
- [ ] Make `OverloadedError` extend `ServerError` (503 keeps specific class)
- [ ] Add `AbortError` class (not retryable)
- [ ] Add `InvalidToolCallError` class (not retryable)
- [ ] Add `UnsupportedToolChoiceError` class (not retryable)
- [ ] Update adapter error mapping: 500/502/504 → `ServerError`, abort → `AbortError`
- [ ] Tests: active tool auto-execution, passive tool pass-through, tool context injection, new error classes with correct retryability

### Phase 6: Engine Retry Jitter (< 1% of effort)

**Files:** `src/engine/retry.ts`, `test/engine/retry.test.ts`

**Tasks:**
- [ ] Change jitter calculation from `0.5 + Math.random() * 0.5` to `0.5 + Math.random()` (range [0.5, 1.5])
- [ ] Update test to verify jitter range includes values > 1.0

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/types.ts` | Modify | FinishReason, GenerateResult, StepResult, StopCondition, Warning, ToolContext, Message factories, response class |
| `src/llm/client.ts` | Modify | prompt shorthand, generate returns GenerateResult, stop_when, stream returns StreamResult, tool loop |
| `src/llm/tools.ts` | Modify | execute handler on ToolDefinition, active/passive guards |
| `src/llm/errors.ts` | Modify | ServerError, AbortError, InvalidToolCallError, UnsupportedToolChoiceError |
| `src/llm/stream-accumulator.ts` | Create | StreamAccumulator: collect events → GenerateResponse |
| `src/llm/streaming.ts` | Modify | Add step_finish event type |
| `src/llm/adapters/anthropic.ts` | Modify | Unified FinishReason mapping, response id/raw/warnings extraction |
| `src/llm/adapters/openai.ts` | Modify | Unified FinishReason mapping, response id/raw extraction |
| `src/llm/adapters/gemini.ts` | Modify | Unified FinishReason mapping, response id/raw extraction |
| `src/llm/adapters/openai-compatible.ts` | Modify | Unified FinishReason mapping, response id/raw extraction |
| `src/engine/retry.ts` | Modify | Fix jitter range to [0.5, 1.5] |
| `src/server/routes/pipelines.ts` | Modify | Fix SSE res.end() lifecycle |
| `src/server/routes/seeds.ts` | Modify | Fix SSE res.end() lifecycle |
| `src/server/routes/gardens.ts` | Modify | Fix SSE res.end() lifecycle |
| `src/server/routes/events.ts` | Modify | Fix SSE res.end() lifecycle |
| `src/server/run-manager.ts` | Modify | Fix async lifecycle for SSE consumers, cancel flow |
| `src/server/workspace-event-bus.ts` | Modify | Verify event wiring |
| `src/runtime/garden-draft-service.ts` | Modify | Fix DOT output format if needed |
| `test/llm/types.test.ts` | Modify | FinishReason, Message factories, response accessors |
| `test/llm/client.test.ts` | Modify | prompt shorthand, GenerateResult, stop_when |
| `test/llm/stream-accumulator.test.ts` | Create | Accumulator correctness tests |
| `test/llm/stream-object.test.ts` | Modify | StreamResult integration |
| `test/llm/tools.test.ts` | Create | Active/passive tools, context injection |
| `test/llm/errors.test.ts` | Modify | New error classes, retryability |
| `test/llm/adapters/anthropic.test.ts` | Modify | Unified FinishReason assertions |
| `test/llm/adapters/openai.test.ts` | Modify | Unified FinishReason assertions |
| `test/llm/adapters/gemini.test.ts` | Modify | Unified FinishReason assertions |
| `test/llm/openai-compatible.test.ts` | Modify | Unified FinishReason assertions |
| `test/engine/retry.test.ts` | Modify | Jitter range verification |
| `test/server/gardens-draft.test.ts` | Modify | Fix assertion |
| `test/integration/hive-run-flow.test.ts` | Modify | Fix SSE lifecycle |
| `test/integration/http-resume.test.ts` | Modify | Fix SSE lifecycle |
| `test/integration/http-server.test.ts` | Modify | Fix cancel test |
| `test/integration/seed-run-linkage.test.ts` | Modify | Fix event bus wiring |

---

## Definition of Done

- [ ] `npm test` passes with 0 failures on a clean checkout
- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] No timeout values were increased to achieve passing tests
- [ ] `GenerateResponse` has `finish_reason: FinishReason` with unified `reason` and provider `raw`
- [ ] `GenerateResponse` has `id`, `raw`, `warnings` fields populated by all 4 adapters
- [ ] `response.text`, `response.tool_calls`, `response.reasoning` return correct values
- [ ] `Message.system()`, `Message.user()`, `Message.assistant()`, `Message.tool_result()` create correctly typed messages
- [ ] `generate({ prompt: "hello" })` works as shorthand for wrapping in a user message
- [ ] `generate()` returns `GenerateResult` with `output`, `steps`, `total_usage`
- [ ] `stop_when` callback exits the tool loop early when it returns true
- [ ] `stream()` returns `StreamResult` with `.response()`, `.text_stream`, `.partial_response`
- [ ] `StreamAccumulator` correctly assembles a `GenerateResponse` from a stream event sequence
- [ ] `stream()` with active tools runs the tool loop and emits `step_finish` events
- [ ] `ToolDefinition` supports optional `execute` handler
- [ ] Active tools (with `execute`) are auto-run; passive tools (without) are returned to caller
- [ ] Tool `execute` handlers receive `ToolContext` with `messages`, `abort_signal`, `tool_call_id`
- [ ] `ServerError`, `AbortError`, `InvalidToolCallError`, `UnsupportedToolChoiceError` exist with correct retryability
- [ ] `OverloadedError` extends `ServerError`
- [ ] Adapters map 500/502/504 → `ServerError`, abort → `AbortError`
- [ ] Engine retry jitter range is [0.5, 1.5] (not [0.5, 1.0])
- [ ] All new and modified code has corresponding test coverage
- [ ] Backward compatibility: existing code using `stop_reason` still compiles with deprecation

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Promoting GenerateResponse from interface to class breaks existing destructuring patterns | Medium | High | Keep all existing fields as public properties. The class constructor accepts the same shape as the old interface. Add a test that verifies `const { message, usage } = response` still works. |
| generate() return type change from GenerateResponse to GenerateResult breaks callers | High | High | GenerateResult.output is the response. Grep all callsites and update them in this sprint. Migration is mechanical: `const response = await generate(req)` → `const { output: response } = await generate(req)`. |
| SSE timeout root causes are deeper than res.end() | Medium | High | Instrument before fixing. If architectural, fix minimum to unblock tests and note the debt. |
| StreamResult wrapper adds overhead to simple streaming use cases | Low | Medium | StreamResult implements AsyncIterable directly — `for await (const event of stream(req))` still works with zero overhead. The wrapper methods are lazy. |
| Active tool auto-execution changes generate() behavior for existing tool definitions | Low | High | Only tools with an explicit `execute` handler are active. Existing ToolDefinitions without `execute` are passive by default — zero behavior change. |
| stop_reason deprecation breaks existing switch/match statements | Medium | Medium | Keep `stop_reason` as a getter returning `finish_reason.reason` for one sprint. Add a `@deprecated` JSDoc annotation. Remove in Sprint 030. |
| Phase 1 debugging eats the sprint | Medium | Medium | Acceptable tradeoff. If Phase 1 takes >30%, cut Phase 5 (tool contract). The green suite and response contract are worth more. |

---

## Dependencies

No new runtime dependencies. All changes use existing libraries:

| Existing Dependency | Used For |
|---|---|
| `vitest` | Test framework |
| `ajv` | JSON Schema validation for tool definitions |
| `src/llm/adapters/*` | Provider-specific response parsing |
| `src/llm/streaming.ts` | Stream event types |
| `src/llm/errors.ts` | Error class hierarchy |
| `src/server/router.ts` | HTTP route registration |

---

## Cut Line

If the sprint runs long, cut in this order (last cut first):

1. **Phase 5: Tool contract (gaps 22–24) + error classes (gap 26)** — Important but no one uses active tools yet, and the existing error hierarchy works. Defer to a follow-up.
2. **Phase 4: Streaming enhancements (gaps 18, 19, 25)** — High value but complex. StreamAccumulator can ship alone without the full stream() tool loop.
3. **Phase 6: Engine jitter (gap 10)** — One line but can ride any future sprint.

**Never cut:** Phase 1 (green suite), Phase 2 (response contract), Phase 3 (generate enhancements). These are the core value of the sprint.
