# Sprint 028: High-Level LLM Contract and Execution Environment Completion

## Overview

**Goal:** Finish the two spec-facing layers that every codergen run and future Hive workflow depend on: the high-level Unified LLM API and the Coding Agent Loop execution environment contract. After this sprint, Nectar's public `generate()` and `stream()` surface is spec-compliant, responses carry normalized metadata and step traces, tools can be active or passive, and agent sessions describe their runtime through a real `ExecutionEnvironment` instead of ad hoc prompt formatting.

**Why this sprint, why now:**

1. **The remaining gaps are concentrated, not scattered.** The compliance report lists 26 gaps, but 23 of them collapse into four code clusters: response normalization, high-level tool looping, stream accumulation, and execution-environment metadata/lifecycle. This is one focused sprint, not 23 unrelated tasks.

2. **INTENT says "done" means spec closure first.** The hard requirement in `docs/INTENT.md` is zero unimplemented features across the pinned specs. Starting new Hive, seedbed, packaging, or release work while the core LLM and agent contracts are still incomplete is the wrong order.

3. **The low-level pieces already exist.** Provider adapters are in place. The agent session loop is in place. The tool registry is in place. What is missing is the spec-grade layer above them. This sprint should wrap, normalize, and harden the current implementation, not rewrite it.

4. **This is the last large contract sprint.** If this lands cleanly, the only material compliance work left should be small cleanup items: retry preset values, engine jitter range, and any small error-taxonomy backfill that does not justify another architecture sprint.

**Primary gaps closed:**

- Coding Agent Loop: OS version, knowledge cutoff, git-repository flag, `list_directory`, `initialize()`/`cleanup()`, `platform()`/`os_version()`, `ExecResult.timed_out`, `ExecResult.duration_ms`, environment allowlist coverage.
- Unified LLM: normalized `FinishReason`, response `id`, raw payload capture, warnings, response convenience accessors, Message factory helpers, `GenerateResult`, `StepResult`, `StreamResult`, `StreamAccumulator`, prompt shorthand, `stop_when`, active/passive tools, tool context injection, and streamed multi-step tool execution with `step_finish`.

**Scope:**

- Complete the Unified LLM public response contract without breaking the existing low-level provider adapters.
- Upgrade module-level `generate()` into the spec-defined multi-step orchestration surface.
- Upgrade module-level `stream()` into a real `StreamResult` wrapper backed by a reusable accumulator.
- Complete the `ExecutionEnvironment` interface and make environment prompt rendering depend on it.
- Preserve current `AgentSession` control flow by keeping its raw streaming/tool loop path low-level and explicit.

**Cut line (in order):**

1. Dedicated new error classes beyond the exact ones needed by the new tool-loop and tool-choice paths.
2. Rich warning population beyond an empty-or-minimal warnings array.
3. Full model-catalog backfill for exact `Knowledge cutoff` values on every catalog entry. The field must still render `unknown` when metadata is not yet known.

**Out of scope:**

- Attractor retry preset value verification.
- Engine retry jitter-range cleanup.
- New Hive features, seedbed work, release automation, or CLI distribution work.
- Rewriting `AgentSession` onto the high-level `generate()` loop.
- Provider catalog expansion beyond what is needed to render truthful model display names and knowledge cutoff metadata.

---

## Use Cases

1. **Run a simple prompt with active tools:** A caller invokes `generate()` with `prompt="Read package.json and summarize the scripts"` and a `read_file` tool that includes an `execute` handler. Nectar converts the prompt to a user message, executes the tool automatically, calls the model again, and returns a two-step `GenerateResult` with `total_usage` and full step history.

2. **Return passive tool calls to an external orchestrator:** A caller passes tool schemas without `execute` handlers because a human approval layer will run the tools. Nectar returns the model's tool calls in `result.tool_calls` and does not auto-loop.

3. **Stop a tool loop early on a custom condition:** A caller provides `stop_when = (steps) => steps.length >= 2`. Nectar executes the first step, optionally runs tools, records the second step, then exits with a valid `GenerateResult` instead of hard-coding "stop only when the model stops."

4. **Stream through multiple tool rounds:** A caller assigns `const result = stream(...)` and iterates `for await (const event of result)`. The stream emits text and tool-call deltas from step 1, pauses for tool execution, emits `step_finish`, resumes step 2, and finishes with an accumulated response available through `result.response()`.

5. **Inspect a provider-neutral response while preserving provider detail:** A debugger reads `response.finish_reason.reason === "tool_calls"` and `response.finish_reason.raw === "tool_use"` for Anthropic. The same debugging path works for OpenAI and Gemini without losing raw provider detail.

6. **Diagnose a bad model response from artifacts instead of guesswork:** The caller can inspect `response.id`, `response.raw`, and `response.warnings` from any adapter. Today those debugging fields are missing or inconsistent.

7. **Build a truthful agent system prompt:** An agent session on macOS or Linux includes `Working directory`, `Is git repository`, `Git branch`, `Platform`, `OS version`, `Today's date`, `Model`, and `Knowledge cutoff` in the environment block. Today the prompt omits or infers several of those fields poorly.

8. **Swap the runtime environment without rewriting tools:** The `list_dir` tool calls `env.list_directory()` instead of walking the filesystem itself. A future Docker or SSH-backed environment can support the same tool contract without copying tool logic.

9. **Measure command behavior precisely:** A shell tool timeout returns `timed_out = true` and a wall-clock `duration_ms`. Session telemetry, tests, and future UI diagnostics can distinguish "command failed" from "command exceeded timeout."

10. **Preserve the current agent loop architecture:** `AgentSession` continues to consume low-level raw stream events from `UnifiedClient.stream()`. The new high-level `StreamResult` lives above that layer instead of fighting it.

---

## Architecture

### The low-level client stays low-level

`UnifiedClient.generateUnified()` and `UnifiedClient.stream()` are already useful as single-step provider facades. Keep them that way. Do not force `AgentSession` or provider tests through a new multi-step abstraction. The spec-facing surface belongs in the module-level `generate()` and `stream()` wrappers.

This is the central opinion of the sprint: **do not blur the adapter layer and the orchestration layer.** Adapters return one response or one raw event stream. High-level helpers add tool loops, stop conditions, prompt shorthand, and aggregated step results above that layer.

### Response normalization happens once

Add a single response-construction path that turns provider-native outputs into the public `Response` shape:

- `finish_reason: { reason, raw }`
- `id`
- `raw`
- `warnings`
- `text`, `tool_calls`, and `reasoning` convenience accessors

Adapters should populate provider-native facts. The normalizer should map those facts into Nectar's public contract. Do not scatter finish-reason normalization or tool-call extraction across call sites.

### Tools become first-class records

Extend `ToolDefinition` with an optional `execute` handler and explicit execution context:

- If `execute` exists, the tool is **active** and module-level `generate()`/`stream()` may auto-run it.
- If `execute` is absent, the tool is **passive** and tool calls are returned to the caller unchanged.
- Tool handlers receive parsed arguments plus injected context such as `messages`, `abort_signal`, `tool_call_id`, and `step_index`.

Legacy `opts.tools: Map<string, handler>` support should remain, but only as a compatibility adapter that wraps map entries into active tools internally. The canonical API after this sprint is tool records, not a sidecar map.

### Stream accumulation is the single source of truth

The repo currently has multiple places that partially reconstruct responses from stream events. Replace that duplication with one `StreamAccumulator` that consumes raw unified stream events and yields a complete `Response`.

`StreamResult` should be an object that:

- Implements async iteration over streamed events.
- Exposes `response()` for the final accumulated response.
- Exposes `text_stream` for text-only consumption.
- Exposes `partial_response` as the current best-known response snapshot.

Do **not** rename every existing raw stream event discriminator this sprint. The compliance report does not demand an event-name migration, and renaming everything would add churn with little value. Add the missing `step_finish` event at the high-level stream layer instead.

### The execution environment owns environment truth

The environment block in the system prompt should be built from the `ExecutionEnvironment`, not from ad hoc `os` calls plus incidental git probing.

After this sprint:

- `ExecutionEnvironment` owns lifecycle, metadata, directory listing, and command telemetry.
- `buildEnvironmentContext()` formats data that comes from the environment and model catalog.
- `list_dir` becomes a thin adapter over `env.list_directory()`.
- The environment block always includes required fields, even when the value is `unknown`.

This matters because the spec does not describe "the local machine." It describes an abstraction that should work for local, Docker, SSH, or future sandboxed environments.

### Knowledge cutoff is data, not string glue

The `Knowledge cutoff` line should come from model metadata, not from hard-coded profile strings or omission. Add `knowledge_cutoff` to `ModelInfo` where known. If the value is unknown for a model, render `Knowledge cutoff: unknown` explicitly instead of dropping the field.

That keeps the environment block truthful and avoids pretending Nectar knows more than it does.

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

## Implementation phases

### Phase 1: Response Contract and Message Factories (25%)

**Files:** `src/llm/types.ts`, `src/llm/response.ts`, `src/llm/client.ts`, `src/llm/errors.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `src/llm/simulation.ts`, `test/llm/types.test.ts`, `test/helpers/scripted-adapter.ts`, adapter test files

**Tasks:**

- [ ] Introduce the public `Response` shape expected by the upstream spec: `id`, `model`, `provider`, `message`, `finish_reason`, `usage`, `raw`, `warnings`, `rate_limit`.
- [ ] Add normalized `FinishReason` with unified values (`stop`, `length`, `tool_calls`, `content_filter`, `error`, `other`) plus provider-native `raw`.
- [ ] Add response convenience accessors for `.text`, `.tool_calls`, and `.reasoning`.
- [ ] Add Message factory helpers: `Message.system()`, `Message.user()`, `Message.assistant()`, and `Message.tool_result()`.
- [ ] Keep a compatibility alias for `stop_reason` for one sprint so existing low-level tests and call sites can migrate without a flag day.
- [ ] Update every adapter and the simulation provider to populate response IDs, normalized finish reasons, raw payloads, and warnings arrays.
- [ ] Add the missing error classes that are directly needed by the new surface area: `ServerError`, `AbortError`, `InvalidToolCallError`, and `UnsupportedToolChoiceError`.

### Phase 2: GenerateResult, Active Tools, and Stop Conditions (30%)

**Files:** `src/llm/types.ts`, `src/llm/tools.ts`, `src/llm/tool-loop.ts`, `src/llm/client.ts`, `test/llm/default-client.test.ts`, `test/llm/high-level-generate.test.ts`, `test/llm/tools.test.ts`

**Tasks:**

- [ ] Extend `ToolDefinition` with optional `execute` and a typed `ToolExecutionContext`.
- [ ] Treat tools with `execute` as active and tools without it as passive.
- [ ] Normalize prompt input so module-level `generate()` accepts exactly one of `prompt` or `messages`.
- [ ] Convert the legacy `opts.tools: Map<string, handler>` path into active tools internally instead of maintaining two independent tool-loop implementations.
- [ ] Implement `GenerateResult` with `text`, `reasoning`, `tool_calls`, `tool_results`, `finish_reason`, `usage`, `total_usage`, `steps`, `response`, and `output`.
- [ ] Implement `StepResult` with the response, extracted tool calls, executed tool results, usage, finish reason, and warnings for each step.
- [ ] Execute multiple active tool calls concurrently, preserve original order, and append all tool results in a single continuation request.
- [ ] Support `stop_when(steps)` as an early-exit condition after each recorded step.
- [ ] Return unknown-tool and invalid-arguments failures to the model as tool results instead of throwing fatal errors from the high-level loop.

### Phase 3: StreamResult and StreamAccumulator (25%)

**Files:** `src/llm/streaming.ts`, `src/llm/stream-accumulator.ts`, `src/llm/stream-result.ts`, `src/llm/tool-loop.ts`, `src/llm/client.ts`, `test/llm/high-level-stream.test.ts`, `test/llm/stream-accumulator.test.ts`, `test/llm/stream-object.test.ts`

**Tasks:**

- [ ] Implement `StreamAccumulator` that consumes low-level stream events and reconstructs the final `Response`.
- [ ] Implement `StreamResult` as an async-iterable wrapper with `response()`, `text_stream`, and `partial_response`.
- [ ] Upgrade module-level `stream()` into the high-level multi-step orchestration surface while preserving `UnifiedClient.stream()` as the raw single-step stream used by `AgentSession`.
- [ ] When active tools are present, emit tool-call deltas as they form, execute the tools after the step finishes, emit `step_finish`, then start the next model step.
- [ ] Make the final accumulated response from `StreamAccumulator` equivalent to the last-step response from non-streaming `generate()`.
- [ ] Reuse the accumulator in streaming tests so the non-streaming and streaming contracts cannot silently diverge.

### Phase 4: ExecutionEnvironment Completion and Prompt Context Rewrite (20%)

**Files:** `src/agent-loop/execution-environment.ts`, `src/agent-loop/environment-context.ts`, `src/agent-loop/session.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/tools/list-dir.ts`, `src/llm/catalog.ts`, `test/agent-loop/environment-context.test.ts`, `test/agent-loop/execution-environment-scoped.test.ts`, `test/agent-loop/session.test.ts`

**Tasks:**

- [ ] Extend `ExecutionEnvironment` with `list_directory()`, `initialize()`, `cleanup()`, `platform()`, and `os_version()`.
- [ ] Extend `ExecResult` with `timed_out` and `duration_ms`, and make `LocalExecutionEnvironment.exec()` measure and surface both.
- [ ] Move directory walking into `LocalExecutionEnvironment.list_directory()` so the `list_dir` tool becomes a thin adapter instead of a second filesystem implementation.
- [ ] Expand the environment allowlist with language and toolchain home paths: `GOPATH`, `CARGO_HOME`, `RUSTUP_HOME`, `NVM_DIR`, `VOLTA_HOME`, `PYENV_ROOT`, `VIRTUAL_ENV`, `PNPM_HOME`, `ASDF_DIR`.
- [ ] Rework `buildEnvironmentContext()` to render the spec-required block: `Working directory`, `Is git repository`, `Git branch`, `Platform`, `OS version`, `Today's date`, `Model`, `Knowledge cutoff`.
- [ ] Source `Knowledge cutoff` from the model catalog when known; otherwise render `unknown` explicitly.
- [ ] Call `env.initialize()` and `env.cleanup()` in session startup/shutdown paths with `finally` safety and idempotent expectations for shared environments.
- [ ] Keep the current session tool loop intact and prove via tests that it still uses the raw low-level client path.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/types.ts` | Modify | Public response, finish-reason, step-result, and tool types |
| `src/llm/response.ts` | Create | Response factories/accessors and finish-reason normalization helpers |
| `src/llm/tools.ts` | Modify | Active/passive tool semantics and injected tool execution context |
| `src/llm/tool-loop.ts` | Create | Shared high-level orchestration for `generate()` and `stream()` |
| `src/llm/stream-accumulator.ts` | Create | Reconstruct a complete `Response` from low-level stream events |
| `src/llm/stream-result.ts` | Create | Async-iterable `StreamResult` wrapper with `response()` and `text_stream` |
| `src/llm/client.ts` | Modify | Keep low-level client methods, wire module-level high-level entry points |
| `src/llm/errors.ts` | Modify | Missing error classes needed by tool choice, abort, and tool validation paths |
| `src/llm/catalog.ts` | Modify | Add `knowledge_cutoff` metadata for environment context rendering |
| `src/llm/adapters/openai.ts` | Modify | Populate normalized response metadata and raw payload capture |
| `src/llm/adapters/anthropic.ts` | Modify | Populate normalized response metadata and raw payload capture |
| `src/llm/adapters/gemini.ts` | Modify | Populate normalized response metadata and raw payload capture |
| `src/llm/adapters/openai-compatible.ts` | Modify | Populate normalized response metadata and raw payload capture |
| `src/llm/simulation.ts` | Modify | Keep fake provider behavior aligned with the new response contract |
| `src/agent-loop/execution-environment.ts` | Modify | Complete the interface, exec timing, lifecycle, and directory listing |
| `src/agent-loop/environment-context.ts` | Modify | Build a truthful spec-complete environment block |
| `src/agent-loop/session.ts` | Modify | Initialize/cleanup envs and preserve the raw-stream session path |
| `src/agent-loop/provider-profiles.ts` | Modify | Pass model display metadata cleanly into prompt construction |
| `src/agent-loop/tools/list-dir.ts` | Modify | Delegate to `ExecutionEnvironment.list_directory()` |
| `test/helpers/scripted-adapter.ts` | Modify | Deterministic fake provider updated for the new response shape |
| `test/llm/types.test.ts` | Modify | Response accessors, finish reason mapping, Message factory coverage |
| `test/llm/default-client.test.ts` | Modify | High-level `generate()` and `stream()` contract coverage |
| `test/llm/high-level-generate.test.ts` | Create | Prompt shorthand, active/passive tools, `stop_when`, `GenerateResult` |
| `test/llm/high-level-stream.test.ts` | Create | `StreamResult`, `step_finish`, `text_stream`, `partial_response` |
| `test/llm/stream-accumulator.test.ts` | Create | Response reconstruction from streamed text, tool calls, and reasoning |
| `test/llm/tools.test.ts` | Modify | Active-tool batching, passive-tool passthrough, validation failures |
| `test/llm/stream-object.test.ts` | Modify | Ensure structured streaming still works on top of the new stream contract |
| `test/agent-loop/environment-context.test.ts` | Modify | OS version, git flag, knowledge cutoff, and model display rendering |
| `test/agent-loop/execution-environment-scoped.test.ts` | Modify | Lifecycle, `list_directory()`, `duration_ms`, `timed_out`, env filtering |
| `test/agent-loop/session.test.ts` | Modify | Raw low-level streaming path still works after the high-level API changes |

---

## Definition of Done

- [ ] Module-level `generate()` accepts either `prompt` or `messages`, rejects both together, and returns a `GenerateResult`.
- [ ] `GenerateResult` includes `steps`, `total_usage`, `response`, and the final-step fields defined by the upstream spec.
- [ ] `StepResult` captures per-step response, tool calls, tool results, usage, finish reason, and warnings.
- [ ] Tools with `execute` handlers are auto-run; tools without `execute` are returned to the caller unchanged.
- [ ] Multiple tool calls in one step execute concurrently and preserve original order in the continuation request.
- [ ] `stop_when` can terminate a high-level tool loop early without throwing or corrupting step history.
- [ ] Every provider adapter returns response `id`, normalized `finish_reason.reason`, raw `finish_reason.raw`, `raw`, and `warnings`.
- [ ] Response convenience accessors work for text, tool calls, and reasoning across all adapters and the simulation provider.
- [ ] Module-level `stream()` returns a `StreamResult`, not a raw async iterable.
- [ ] `StreamResult.response()` returns the final accumulated response after iteration completes.
- [ ] `StreamResult.partial_response` is populated during streaming.
- [ ] High-level streaming with active tools emits `step_finish` between tool-execution rounds.
- [ ] `StreamAccumulator` reconstructs a final response equivalent to the last-step non-streaming response for scripted test fixtures.
- [ ] `ExecutionEnvironment` includes `list_directory()`, `initialize()`, `cleanup()`, `platform()`, and `os_version()`.
- [ ] `LocalExecutionEnvironment.exec()` returns `timed_out` and `duration_ms` correctly for success, timeout, and abort paths.
- [ ] The environment context block always includes `Working directory`, `Is git repository`, `Platform`, `OS version`, `Today's date`, `Model`, and `Knowledge cutoff`.
- [ ] The environment context block includes `Git branch` whenever `Is git repository` is `true`.
- [ ] `Knowledge cutoff` is rendered as a real value when known and `unknown` when not known; the field is never omitted.
- [ ] `list_dir` uses the environment implementation instead of maintaining its own filesystem walker.
- [ ] `AgentSession` tests still pass and continue to use the low-level raw stream path.
- [ ] `npm test` passes on a clean checkout.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Confusion between low-level `UnifiedClient.stream()` and high-level module-level `stream()` | Medium | High | Keep the split explicit in code and docs. Do not rename the low-level client path mid-sprint. Add dedicated tests for both layers. |
| Response-shape changes create widespread test churn | High | Medium | Make new fields additive where possible and keep a temporary `stop_reason` compatibility alias for one sprint. |
| Multi-step streaming deadlocks if tool execution is interleaved incorrectly | Medium | High | Isolate orchestration in `StreamResult`, close each raw step cleanly before executing tools, and add scripted multi-step streaming tests. |
| Raw provider payload capture increases memory pressure | Medium | Medium | Store raw payloads on responses and step responses, not on every low-level stream event. Keep provider-event passthrough optional. |
| `Knowledge cutoff` data is incomplete or wrong for some models | High | Low | Treat catalog values as data, not guesswork. Render `unknown` when not available and backfill incrementally. |
| Shared environments are cleaned up more than once | Medium | Medium | Require idempotent `initialize()`/`cleanup()` behavior and verify session tests against reused/local environments. |
| Expanding the env allowlist accidentally exposes secrets | Low | High | Keep the existing denylist (`*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_CREDENTIAL`) authoritative and add targeted tests for the new allowlist entries. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| `docs/upstream/unified-llm-spec.md` | Source of truth for `Response`, `GenerateResult`, `StepResult`, `StreamResult`, and active/passive tool semantics |
| `docs/upstream/coding-agent-loop-spec.md` | Source of truth for `ExecutionEnvironment` and the environment context block |
| `execa` | Command execution, timeout handling, duration measurement, and git probing |
| `ajv` | Tool argument validation before execution |
| `ignore` | `.gitignore`-aware directory listing in the environment implementation |
| `vitest` | Regression coverage for adapters, streaming, tool loops, and environment lifecycle |

No new runtime packages should be introduced unless an implementation detail is impossible with the current standard library and dependency set. This sprint is a contract sprint, not a dependency-accretion sprint.
