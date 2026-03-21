# Sprint 028: Unified LLM Response Contract, Execution Environment Completion & Green Suite

## Overview

**Goal:** Close the 16 remaining Unified LLM Spec gaps (11–26), complete the Execution Environment contract (gaps 2–9), fix the remaining test failures, and ship the engine retry jitter fix (gap 10). After this sprint: the LLM client layer fully matches the unified-llm-spec, the agent loop's execution environment is spec-complete, CI is green, and every downstream consumer — agent sessions, the Hive, and external callers — gets a complete, spec-compliant response contract.

**Why this sprint, why now:**

1. **The Unified LLM layer is the foundation everything else stands on.** Agent sessions, codergen handlers, swarm analysis, the Hive's draft streaming — every feature that touches an LLM goes through `UnifiedClient`. The 16 remaining LLM spec gaps mean every consumer works around missing fields, inconsistent stop reasons, and incomplete streaming contracts. Fixing the foundation unblocks cleaner code everywhere else.

2. **The gaps form two tight, self-contained clusters.** The LLM gaps (11–26) touch `src/llm/types.ts`, `src/llm/client.ts`, `src/llm/errors.ts`, the four adapter files, and one new module (`src/llm/stream-accumulator.ts`). The execution environment gaps (2–9) touch `src/agent-loop/execution-environment.ts`, `src/agent-loop/environment-context.ts`, `src/agent-loop/tools/list-dir.ts`, and `src/llm/catalog.ts`. No cross-cutting concerns with the engine, server, or CLI.

3. **INTENT says "done" means spec closure first.** The hard requirement in `docs/INTENT.md` is zero unimplemented features across the pinned specs. Starting new Hive, seedbed, or release work while the core LLM and agent contracts are still incomplete is the wrong order.

4. **The remaining test failures must die.** The red suite has survived multiple sprints. This sprint makes green the Phase 1 gate — no subsequent work starts until `npm test` reports zero failures. The timeout failures share a root cause in SSE lifecycle management; the others are assertion mismatches.

5. **The engine retry jitter is a one-line fix with disproportionate correctness impact.** Gap 10 (`[0.5, 1.0]` → `[0.5, 1.5]`) aligns the engine with both the spec and the already-correct LLM retry implementation. It rides for free.

6. **This is the last large contract sprint.** If this lands cleanly, the only material compliance work left is small cleanup: retry preset exact values, and any cosmetic backfill that doesn't justify another architecture sprint.

**Gaps closed:**

| Phase | Gap IDs | Count | Description |
|-------|---------|-------|-------------|
| 1 | — | 5 | Green suite: fix remaining failing tests |
| 2 | 11 | 1 | FinishReason unified naming with `reason` + `raw` |
| 2 | 12 | 1 | Response `id` field from provider |
| 2 | 13 | 1 | Response `raw` field for debugging |
| 2 | 14 | 1 | Response `warnings` field |
| 2 | 15 | 1 | Response convenience accessors (`.text`, `.tool_calls`, `.reasoning`) |
| 2 | 16 | 1 | Message factory methods |
| 2 | 26 | 1 | Missing error classes (ServerError, AbortError, etc.) |
| 3 | 17 | 1 | GenerateResult / StepResult with usage aggregation |
| 3 | 20 | 1 | `prompt` shorthand on generate() |
| 3 | 21 | 1 | `stop_when` / StopCondition for tool loops |
| 3 | 22 | 1 | Tool `execute` handler on ToolDefinition |
| 3 | 23 | 1 | Active/passive tool distinction |
| 3 | 24 | 1 | Tool context injection |
| 4 | 18 | 1 | StreamResult wrapper |
| 4 | 19 | 1 | StreamAccumulator utility |
| 4 | 25 | 1 | stream() tool loop with step_finish events |
| 5 | 2–9 | 8 | ExecutionEnvironment: lifecycle, metadata, list_directory, exec telemetry, env allowlist |
| 6 | 10 | 1 | Engine retry jitter range [0.5, 1.5] |
| — | **Total** | **26** | 16 LLM spec gaps + 8 agent loop gaps + 5 test failures + engine jitter |

**Out of scope:**

- Attractor spec gap 1 (retry preset parameter exact values) — needs spec document comparison; low urgency.
- Rewriting `AgentSession` onto the high-level `generate()` loop — the session keeps its raw low-level stream path.
- Hive UI features, CLI distribution, seedbed enhancements.
- New HTTP endpoints or server features.
- Provider catalog expansion beyond what is needed for knowledge cutoff metadata.

---

## Use Cases

1. **CI goes green.** `npm test` passes with zero failures. The persistent test failures are resolved by fixing SSE lifecycle bugs and assertion mismatches — not by increasing timeouts.

2. **A caller inspects why the model stopped.** After `generate()`, the caller reads `response.finish_reason.reason` and gets a normalized string (`"stop"`, `"length"`, `"tool_calls"`) regardless of whether the underlying provider was Anthropic, OpenAI, or Gemini. `response.finish_reason.raw` preserves the provider-native value for debugging.

3. **A caller builds messages ergonomically.** Instead of constructing `{ role: 'user', content: [...] }` objects by hand, callers use `Message.user("Review this code")`, `Message.system("You are a code reviewer")`, `Message.tool_result(callId, output)`.

4. **A caller gets the response text in one line.** `response.text` returns the concatenated text content. `response.tool_calls` returns an array of tool calls. `response.reasoning` returns thinking blocks. No manual content-part iteration.

5. **Run a simple prompt with active tools.** A caller invokes `generate()` with `prompt="Read package.json and summarize the scripts"` and a `read_file` tool that includes an `execute` handler. Nectar converts the prompt to a user message, executes the tool automatically, calls the model again, and returns a two-step `GenerateResult` with `total_usage` and full step history.

6. **Return passive tool calls to an external orchestrator.** A caller passes tool schemas without `execute` handlers because a human approval layer will run the tools. Nectar returns the model's tool calls in `result.tool_calls` and does not auto-loop.

7. **Stop a tool loop early on a custom condition.** A caller provides `stop_when = (response) => response.text.includes("DONE")`. Nectar evaluates the condition after each step and exits early with a valid `GenerateResult`.

8. **Stream through multiple tool rounds.** A caller assigns `const result = stream(...)` and iterates `for await (const event of result)`. The stream emits text and tool-call deltas from step 1, pauses for tool execution, emits `step_finish`, resumes step 2, and finishes with an accumulated response available through `result.response()`.

9. **Collect streaming into a response.** `const acc = new StreamAccumulator(); for await (const e of stream(req)) { acc.push(e); } const response = acc.response()` — no manual event assembly.

10. **Build a truthful agent system prompt.** An agent session on macOS includes `Working directory`, `Is git repository`, `Git branch`, `Platform`, `OS version`, `Today's date`, `Model`, and `Knowledge cutoff` in the environment block. Today the prompt omits or infers several of those fields poorly.

11. **Swap the runtime environment without rewriting tools.** The `list_dir` tool calls `env.list_directory()` instead of walking the filesystem itself. A future Docker or SSH-backed environment can support the same tool contract without copying tool logic.

12. **Measure command behavior precisely.** A shell tool timeout returns `timed_out = true` and a wall-clock `duration_ms`. Session telemetry, tests, and future UI diagnostics can distinguish "command failed" from "command exceeded timeout."

13. **Error handling is complete.** `ServerError` catches 500–504 responses. `AbortError` wraps cancellation. `InvalidToolCallError` and `UnsupportedToolChoiceError` give specific diagnostics instead of generic errors.

14. **Engine retries use correct jitter.** Retry delays vary by ±50% around the computed backoff (range [0.5, 1.5]), matching the spec and preventing thundering-herd effects.

---

## Architecture

### The low-level client stays low-level

`UnifiedClient.generateUnified()` and `UnifiedClient.stream()` are already useful as single-step provider facades. Keep them that way. Do not force `AgentSession` or provider tests through a new multi-step abstraction. The spec-facing surface belongs in the module-level `generate()` and `stream()` wrappers.

This is the central opinion of the sprint: **do not blur the adapter layer and the orchestration layer.** Adapters return one response or one raw event stream. High-level helpers add tool loops, stop conditions, prompt shorthand, and aggregated step results above that layer.

### Response normalization happens once

Add a single response-construction path that turns provider-native outputs into the public response shape:

- `finish_reason: { reason, raw }`
- `id`
- `raw`
- `warnings`
- `text`, `tool_calls`, and `reasoning` convenience accessors

Adapters populate provider-native facts. The normalizer maps those facts into Nectar's public contract. Do not scatter finish-reason normalization or tool-call extraction across call sites.

### Tools become first-class records

Extend `ToolDefinition` with an optional `execute` handler and explicit execution context:

- If `execute` exists, the tool is **active** and module-level `generate()`/`stream()` may auto-run it.
- If `execute` is absent, the tool is **passive** and tool calls are returned to the caller unchanged.
- Tool handlers receive parsed arguments plus injected context: `messages`, `abort_signal`, `tool_call_id`.
- Multiple active tool calls in one step execute concurrently and preserve original order in the continuation request.
- Unknown-tool and invalid-arguments failures are returned to the model as tool results instead of throwing fatal errors.

### Stream accumulation is the single source of truth

Replace duplicated response-from-stream reconstruction with one `StreamAccumulator` that consumes raw unified stream events and yields a complete response.

`StreamResult` should be an object that:

- Implements async iteration over streamed events (backward compat for `for await`).
- Exposes `response()` for the final accumulated response.
- Exposes `text_stream` for text-only consumption.
- Exposes `partial_response` as the current best-known response snapshot.

Do **not** rename every existing raw stream event discriminator this sprint. Add the missing `step_finish` event at the high-level stream layer instead.

### The execution environment owns environment truth

The environment block in the system prompt should be built from the `ExecutionEnvironment`, not from ad hoc `os` calls plus incidental git probing.

After this sprint:

- `ExecutionEnvironment` owns lifecycle (`initialize`/`cleanup`), metadata (`platform`/`os_version`), directory listing, and command telemetry (`timed_out`/`duration_ms`).
- `buildEnvironmentContext()` formats data from the environment and model catalog.
- `list_dir` becomes a thin adapter over `env.list_directory()`.
- The environment block always includes required fields, even when the value is `unknown`.

### Knowledge cutoff is data, not string glue

The `Knowledge cutoff` line comes from model metadata via the catalog's `knowledge_cutoff` field. If the value is unknown for a model, render `Knowledge cutoff: unknown` explicitly instead of dropping the field.

### Data flow

```text
ProviderAdapter.complete()/stream()
        ↓
UnifiedClient.generateUnified()/stream()      -- low-level, single-step
        ↓
Response normalizer / StreamAccumulator
        ↓
module-level generate()/stream()              -- high-level orchestration
        ↓
GenerateResult / StreamResult

ExecutionEnvironment
        ↓
buildEnvironmentContext()
        ↓
AgentSession system prompt + list_dir tool + exec telemetry
```

---

## Implementation

### Phase 1: Green Suite (15% of effort)

**Files:** `src/server/routes/pipelines.ts`, `src/server/routes/seeds.ts`, `src/server/routes/gardens.ts`, `src/server/routes/events.ts`, `src/server/run-manager.ts`, `src/server/workspace-event-bus.ts`, `src/runtime/garden-draft-service.ts`, relevant test files

**Anti-pattern:** Timeout values must not be increased. If a test still times out after the fix, the root cause is not resolved.

**Tasks:**
- [ ] Audit every SSE endpoint in `routes/pipelines.ts`, `routes/seeds.ts`, `routes/gardens.ts`, `routes/events.ts` for missing `res.end()` on completion and error paths
- [ ] Verify event bus wiring in `server.ts` — every service that emits events must receive the event bus
- [ ] Fix assertion mismatches in `gardens-draft.test.ts`: align the assertion with the actual DOT output from the simulation provider
- [ ] Fix cancel test in `http-server.test.ts`: ensure RunManager.cancel() triggers abort, checkpoint, and returns interrupted status
- [ ] Fix SSE promise lifecycle so streams close on run completion/cancellation (`hive-run-flow`, `http-resume`, `seed-run-linkage`)
- [ ] Run `npm test` — must be 0 failures before proceeding

### Phase 2: Response Contract & Error Classes (20% of effort)

**Files:** `src/llm/types.ts`, `src/llm/errors.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `test/llm/types.test.ts`, adapter test files

**Tasks:**
- [ ] Define `FinishReason` type with unified `reason` (`stop`, `length`, `tool_calls`, `content_filter`, `error`, `other`) and provider-native `raw`
- [ ] Promote `GenerateResponse` from interface to class with getter properties for `.text`, `.tool_calls`, `.reasoning`
- [ ] Add `id`, `raw`, `warnings` fields to `GenerateResponse`
- [ ] Add `Message` namespace with `system()`, `user()`, `assistant()`, `tool_result()` factory methods
- [ ] Add backward-compat: `stop_reason` getter returning `finish_reason.reason` with `@deprecated` annotation — remove in Sprint 030
- [ ] Update Anthropic adapter: map `end_turn` → `stop`, `max_tokens` → `length`, `tool_use` → `tool_calls`; extract response ID; pass through raw body; collect warnings
- [ ] Update OpenAI adapter: map native stop reasons to unified FinishReason; extract response ID; pass through raw body
- [ ] Update Gemini adapter: map `STOP` → `stop`, `MAX_TOKENS` → `length`, `SAFETY` → `content_filter`; extract response ID; generate synthetic ID if provider doesn't return one
- [ ] Update OpenAI-Compatible adapter: same mappings as OpenAI
- [ ] Add `ServerError` class (retryable, covers 500/502/504); make `OverloadedError` extend `ServerError`
- [ ] Add `AbortError` class (not retryable)
- [ ] Add `InvalidToolCallError` class (not retryable)
- [ ] Add `UnsupportedToolChoiceError` class (not retryable)
- [ ] Update adapter error mapping: 500/502/504 → `ServerError`, abort → `AbortError`
- [ ] Tests: verify unified finish reasons across all providers, factory method ergonomics, accessor correctness, new error classes with correct retryability

### Phase 3: Generate Enhancements & Tool Contract (25% of effort)

**Files:** `src/llm/types.ts`, `src/llm/tools.ts`, `src/llm/client.ts`, `test/llm/client.test.ts`, `test/llm/tools.test.ts`

**Tasks:**
- [ ] Define `GenerateResult`, `StepResult`, `StopCondition` types
- [ ] Add optional `execute: (args: Record<string, unknown>, context?: ToolContext) => Promise<string>` to `ToolDefinition`
- [ ] Define `ToolContext = { messages: Message[], abort_signal?: AbortSignal, tool_call_id: string }`
- [ ] Add `isActiveTool(tool)` / `isPassiveTool(tool)` type guards
- [ ] Modify `generate()` to accept `prompt: string` alternative — wrap as `[Message.user(prompt)]`
- [ ] Modify `generate()` to track steps and aggregate usage across tool loop iterations
- [ ] Modify `generate()` to return `GenerateResult` with `output`, `steps`, `total_usage`
- [ ] Implement `stop_when` parameter: evaluate after each tool execution step, exit early if true
- [ ] Active tools (with `execute`) are auto-run by `generate()`; passive tools (without `execute`) return calls to caller
- [ ] Multiple active tool calls in one step execute concurrently, preserving original order
- [ ] Return unknown-tool and invalid-arguments failures to the model as tool results instead of throwing
- [ ] Thread `ToolContext` (messages, abort_signal, tool_call_id) to execute handlers
- [ ] Update all callers of `generate()` to use `GenerateResult.output` where they previously used the raw response
- [ ] Tests: prompt shorthand, multi-step usage aggregation, stop_when early exit, active/passive tools, context injection

### Phase 4: Streaming Enhancements (20% of effort)

**Files:** `src/llm/stream-accumulator.ts` (new), `src/llm/client.ts`, `src/llm/types.ts`, `src/llm/streaming.ts`, `test/llm/stream-accumulator.test.ts` (new), `test/llm/stream-object.test.ts`

**Tasks:**
- [ ] Implement `StreamAccumulator`: push(event), response(), partial state tracking
- [ ] Define `StreamResult` class: `[Symbol.asyncIterator]()`, `.response()`, `.text_stream`, `.partial_response`
- [ ] Modify `stream()` to return `StreamResult` wrapping the provider's event iterable
- [ ] Add `step_finish` to `StreamEvent` discriminated union
- [ ] Implement tool loop in `stream()`: detect active tools, execute them, emit `step_finish`, continue conversation
- [ ] Ensure `StreamAccumulator` reconstructs a final response equivalent to the last-step non-streaming response
- [ ] Update all callers of `stream()` to use `StreamResult` (most iterate directly via `Symbol.asyncIterator` — backward compat)
- [ ] Tests: accumulator correctness, StreamResult text_stream filtering, stream tool loop with active tools, step_finish events

### Phase 5: ExecutionEnvironment Completion (15% of effort)

**Files:** `src/agent-loop/execution-environment.ts`, `src/agent-loop/environment-context.ts`, `src/agent-loop/session.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/tools/list-dir.ts`, `src/llm/catalog.ts`, relevant test files

**Tasks:**
- [ ] Extend `ExecutionEnvironment` with `list_directory()`, `initialize()`, `cleanup()`, `platform()`, and `os_version()`
- [ ] Extend `ExecResult` with `timed_out` (boolean) and `duration_ms` (number); implement in `LocalExecutionEnvironment.exec()`
- [ ] Move directory walking into `LocalExecutionEnvironment.list_directory()` so `list_dir` tool becomes a thin adapter
- [ ] Expand environment variable allowlist: `GOPATH`, `CARGO_HOME`, `RUSTUP_HOME`, `NVM_DIR`, `VOLTA_HOME`, `PYENV_ROOT`, `VIRTUAL_ENV`, `PNPM_HOME`, `ASDF_DIR`
- [ ] Rework `buildEnvironmentContext()` to render the spec-required block: `Working directory`, `Is git repository`, `Git branch`, `Platform`, `OS version`, `Today's date`, `Model`, `Knowledge cutoff`
- [ ] Add `knowledge_cutoff` to `ModelInfo` in the catalog; render `unknown` when not available
- [ ] Call `env.initialize()` and `env.cleanup()` in session startup/shutdown with `finally` safety and idempotent behavior
- [ ] Keep the current session tool loop intact — `AgentSession` continues to use the raw low-level client path
- [ ] Tests: lifecycle, list_directory, duration_ms, timed_out, env allowlist, environment context rendering

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
| `src/llm/tools.ts` | Modify | execute handler on ToolDefinition, active/passive guards, ToolContext |
| `src/llm/errors.ts` | Modify | ServerError, AbortError, InvalidToolCallError, UnsupportedToolChoiceError |
| `src/llm/stream-accumulator.ts` | Create | StreamAccumulator: collect events → GenerateResponse |
| `src/llm/streaming.ts` | Modify | Add step_finish event type |
| `src/llm/catalog.ts` | Modify | Add knowledge_cutoff metadata for environment context rendering |
| `src/llm/adapters/anthropic.ts` | Modify | Unified FinishReason mapping, response id/raw/warnings extraction |
| `src/llm/adapters/openai.ts` | Modify | Unified FinishReason mapping, response id/raw extraction |
| `src/llm/adapters/gemini.ts` | Modify | Unified FinishReason mapping, response id/raw extraction |
| `src/llm/adapters/openai-compatible.ts` | Modify | Unified FinishReason mapping, response id/raw extraction |
| `src/agent-loop/execution-environment.ts` | Modify | Complete interface: lifecycle, metadata, list_directory, exec telemetry |
| `src/agent-loop/environment-context.ts` | Modify | Build truthful spec-complete environment block |
| `src/agent-loop/session.ts` | Modify | Initialize/cleanup envs, preserve raw-stream session path |
| `src/agent-loop/provider-profiles.ts` | Modify | Pass model display metadata into prompt construction |
| `src/agent-loop/tools/list-dir.ts` | Modify | Delegate to ExecutionEnvironment.list_directory() |
| `src/engine/retry.ts` | Modify | Fix jitter range to [0.5, 1.5] |
| `src/server/routes/pipelines.ts` | Modify | Fix SSE res.end() lifecycle |
| `src/server/routes/seeds.ts` | Modify | Fix SSE res.end() lifecycle |
| `src/server/routes/gardens.ts` | Modify | Fix SSE res.end() lifecycle |
| `src/server/routes/events.ts` | Modify | Fix SSE res.end() lifecycle |
| `src/server/run-manager.ts` | Modify | Fix async lifecycle for SSE consumers, cancel flow |
| `src/runtime/garden-draft-service.ts` | Modify | Fix DOT output format if needed |
| `test/llm/types.test.ts` | Modify | FinishReason, Message factories, response accessors |
| `test/llm/client.test.ts` | Modify | prompt shorthand, GenerateResult, stop_when |
| `test/llm/stream-accumulator.test.ts` | Create | Accumulator correctness tests |
| `test/llm/stream-object.test.ts` | Modify | StreamResult integration |
| `test/llm/tools.test.ts` | Create | Active/passive tools, context injection |
| `test/llm/errors.test.ts` | Modify | New error classes, retryability |
| `test/llm/adapters/*.test.ts` | Modify | Unified FinishReason assertions |
| `test/agent-loop/environment-context.test.ts` | Modify | OS version, git flag, knowledge cutoff rendering |
| `test/agent-loop/execution-environment.test.ts` | Modify | Lifecycle, list_directory, duration_ms, timed_out |
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
- [ ] Multiple active tool calls execute concurrently with preserved ordering
- [ ] `ServerError`, `AbortError`, `InvalidToolCallError`, `UnsupportedToolChoiceError` exist with correct retryability
- [ ] `OverloadedError` extends `ServerError`
- [ ] Adapters map 500/502/504 → `ServerError`, abort → `AbortError`
- [ ] `ExecutionEnvironment` includes `list_directory()`, `initialize()`, `cleanup()`, `platform()`, and `os_version()`
- [ ] `ExecResult` includes `timed_out` and `duration_ms`
- [ ] `list_dir` delegates to `ExecutionEnvironment.list_directory()`
- [ ] Environment context block includes `Working directory`, `Is git repository`, `Platform`, `OS version`, `Today's date`, `Model`, `Knowledge cutoff`
- [ ] `Knowledge cutoff` renders a real value when known and `unknown` when not; never omitted
- [ ] Environment variable allowlist covers language-specific paths
- [ ] Engine retry jitter range is [0.5, 1.5] (not [0.5, 1.0])
- [ ] `AgentSession` tests still pass using the raw low-level stream path
- [ ] All new and modified code has corresponding test coverage
- [ ] Backward compatibility: existing code using `stop_reason` still compiles with deprecation

---

## Cut Line

If the sprint runs long, cut in this order (last cut first):

1. **Phase 5: ExecutionEnvironment completion (gaps 2–9)** — Real gaps but zero runtime behavior impact today. Nobody swaps ExecutionEnvironment implementations. Can stand alone as a focused follow-up sprint.
2. **Phase 4: Streaming enhancements (gaps 18, 19, 25)** — High value but complex. StreamAccumulator can ship alone without the full stream() tool loop.
3. **Phase 6: Engine jitter (gap 10)** — One line but can ride any future sprint.

**Never cut:** Phase 1 (green suite), Phase 2 (response contract + error classes), Phase 3 (generate enhancements + tool contract). These are the core value of the sprint.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Promoting GenerateResponse from interface to class breaks existing destructuring | Medium | High | Keep all existing fields as public properties. The class constructor accepts the same shape as the old interface. Add a test that verifies destructuring still works. |
| generate() return type change from GenerateResponse to GenerateResult breaks callers | High | High | Migration is mechanical: `const response = await generate(req)` → `const { output: response } = await generate(req)`. Grep all callsites and update in this sprint. |
| SSE timeout root causes are deeper than res.end() | Medium | High | Instrument before fixing. If architectural, fix minimum to unblock tests and note the debt. |
| Confusion between low-level `UnifiedClient.stream()` and high-level module-level `stream()` | Medium | High | Keep the split explicit in code. Do not rename the low-level client path mid-sprint. Add dedicated tests for both layers. |
| Multi-step streaming deadlocks if tool execution interleaved incorrectly | Medium | High | Close each raw step cleanly before executing tools. Add scripted multi-step streaming tests. |
| Active tool auto-execution changes generate() behavior for existing tool definitions | Low | High | Only tools with an explicit `execute` handler are active. Existing ToolDefinitions without `execute` are passive by default — zero behavior change. |
| stop_reason deprecation breaks existing switch/match statements | Medium | Medium | Keep `stop_reason` as a getter returning `finish_reason.reason` for one sprint. Remove in Sprint 030. |
| Knowledge cutoff data is incomplete for some models | High | Low | Render `unknown` when not available. Backfill incrementally. |
| Expanding env allowlist accidentally exposes secrets | Low | High | Keep existing denylist (`*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`) authoritative. Add targeted tests. |
| Phase 1 debugging eats the sprint | Medium | Medium | If Phase 1 takes >30%, cut Phase 5 (ExecutionEnvironment). The green suite and LLM contract are worth more. |

---

## Dependencies

No new runtime dependencies. All changes use existing libraries:

| Existing Dependency | Used For |
|---|---|
| `vitest` | Test framework |
| `ajv` | JSON Schema validation for tool definitions |
| `execa` | Command execution, timeout handling, duration measurement |
| `ignore` | .gitignore-aware directory listing |
| `src/llm/adapters/*` | Provider-specific response parsing |
| `src/llm/streaming.ts` | Stream event types |
| `src/llm/errors.ts` | Error class hierarchy |
| `docs/upstream/unified-llm-spec.md` | Source of truth for response, generate, stream, and tool contracts |
| `docs/upstream/coding-agent-loop-spec.md` | Source of truth for ExecutionEnvironment and environment context |
