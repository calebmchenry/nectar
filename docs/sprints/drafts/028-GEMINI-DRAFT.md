# Sprint Draft: Spec Compliance Finalization

## Overview

**Goal:** Close all 26 remaining spec compliance gaps identified in the 2026-03-21 Compliance Report across the Attractor, Coding Agent Loop, and Unified LLM specifications. This ensures 100% adherence to the pinned upstream NLSpec snapshot, solidifying the foundation before moving focus to the Web UI (The Hive) or Seedbed.

**Scope:** 
- Resolving Execution Environment gaps (OS metadata, `list_directory`, env vars).
- Agent Loop Context gaps (Git flag, knowledge cutoff, OS string).
- Unified LLM API Types (`StreamResult`, `GenerateResult`, `FinishReason`, message factories).
- Implementing the required tool execution loop inside `stream()` with active/passive tool distinction.

**Out of scope:** 
- New Nectar features not defined in the upstream specs.
- Web UI ("The Hive").
- Seedbed backlog implementation.
- Multi-AI Swarm analysis.

---

## Use Cases

1. **Multi-step streaming tool execution:** The unified LLM client's `stream()` method natively executes "active" tools inside the stream, emitting `step_finish` events between steps, handling context injection without caller intervention.
2. **Accurate environment context:** The LLM receives the correct OS version, knowledge cutoff date, and explicit "Is git repository" boolean in the environment context block, improving its system awareness.
3. **Spec-compliant API usage:** Developers consuming the internal unified LLM client use standard `Message.user()`, access `.text` directly on the response, and use `StreamAccumulator` to rebuild responses effortlessly.
4. **Execution timeout detection:** `ExecutionEnvironment` correctly reports `timed_out` and `duration_ms` on shell execution results, allowing Nectar to distinguish between actual crashes and hangs.

---

## Architecture

### Language & Tooling
- **TypeScript on Node.js 22+** (unchanged).
- **vitest** for unit/integration testing.

### Key Modifications
- **Tool execution inside `stream()`:** `src/llm/client.ts`'s `stream()` function will be upgraded to an asynchronous generator that includes an internal loop. When "active" tools (tools with an `execute` handler) are provided, `stream()` will automatically run them and append their results as `TOOL_RESULT` content parts, emitting `step_finish` events between round-trips.
- **Active vs. Passive Tools:** `ToolDefinition` in `src/llm/tools.ts` will gain an optional `execute` handler and `context` type mapping. Tools without this handler will be treated as "passive" and yielded back to the caller for manual execution.
- **ExecutionEnvironment Interface Alignment:** `src/agent-loop/execution-environment.ts` will natively support `initialize()`, `cleanup()`, `platform()`, `os_version()`, and `list_directory`, shedding the standalone tool workaround for the latter.

---

## Implementation phases

### Phase 1: Engine & Agent Loop Context (Gaps 1-4, 10)
**Files:** `src/engine/retry.ts`, `src/agent-loop/environment-context.ts`
**Tasks:**
- Update engine retry logic to fix the jitter range to `[0.5, 1.5]` (from `[0.5, 1.0]`).
- Align `aggressive`, `linear`, and `patient` preset parameters exactly with spec numbers.
- Update `environment-context.ts` to conditionally or explicitly include `OS version: {os_version_string}`, `Knowledge cutoff: {date}`, and `Is git repository: {true/false}`. Use Node's native `os.release()` for the OS string.

### Phase 2: Execution Environment Completeness (Gaps 5-9)
**Files:** `src/agent-loop/execution-environment.ts`, `src/agent-loop/tools/list-dir.ts`
**Tasks:**
- Expand the `ExecutionEnvironment` interface with `initialize()` and `cleanup()` lifecycle methods.
- Add `platform()` and `os_version()` methods.
- Migrate `list_dir` standalone logic into `list_directory(path, depth)` on the environment interface itself.
- Augment `ExecResult` with `timed_out` (boolean) and `duration_ms` (number). Ensure the `exec()` implementation populates these.
- Update environment variable filtering to explicitly allow list language-specific paths: `GOPATH`, `CARGO_HOME`, `NVM_DIR`, `RUSTUP_HOME`, `GOROOT`.

### Phase 3: Unified LLM Data Model & API (Gaps 11-21, 26)
**Files:** `src/llm/types.ts`, `src/llm/errors.ts`, `src/llm/client.ts`, `src/llm/streaming.ts`
**Tasks:**
- Introduce a unified `FinishReason` enum/type and a `raw` string on `GenerateResponse`.
- Add `id`, `raw`, and `warnings` fields to `GenerateResponse`.
- Implement convenience accessors (`.text`, `.tool_calls`, `.reasoning`) directly on the Response model/class.
- Introduce `Message` static factory methods (`Message.system()`, `Message.user()`, `Message.assistant()`, `Message.tool_result()`).
- Implement `GenerateResult`, `StepResult`, `StreamResult` wrapper, and `StreamAccumulator` to aggregate streaming chunks.
- Overload `generate()` to accept a `prompt` string shorthand.
- Add `stop_when` (`StopCondition`) callback support to `generate()`.
- Define missing error classes (`ServerError`, `AbortError`, `InvalidToolCallError`, `UnsupportedToolChoiceError`) in `src/llm/errors.ts` and ensure adapters map to them correctly.

### Phase 4: Streaming Tool Execution (Gaps 22-25)
**Files:** `src/llm/tools.ts`, `src/llm/client.ts`
**Tasks:**
- Update `ToolDefinition` to support an optional `execute` handler taking arguments and injected context.
- Implement the "active/passive tool distinction" inside `client.ts`.
- Restructure `stream()` to handle multi-step tool execution. When the LLM yields a tool call for an active tool, execute it, emit a `step_finish` event, and loop back to the provider with the `TOOL_RESULT` to continue the stream until completion.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/retry.ts` | Modify | Fix jitter multiplier range and retry preset values. |
| `src/agent-loop/environment-context.ts` | Modify | Add OS version, knowledge cutoff, and git flags. |
| `src/agent-loop/execution-environment.ts` | Modify | Add lifecycle methods, metadata methods, list_directory, and update env vars. |
| `src/llm/types.ts` | Modify | Add FinishReason, Response accessors, id/raw/warnings, GenerateResult, StepResult. |
| `src/llm/client.ts` | Modify | Support prompt string shorthand, stop_when, StreamResult, and stream tool loop. |
| `src/llm/errors.ts` | Modify | Add ServerError, AbortError, InvalidToolCallError, UnsupportedToolChoiceError. |
| `src/llm/tools.ts` | Modify | Add execute handler to tools and context injection. |
| `src/llm/streaming.ts` | Modify | Add StreamAccumulator and step_finish stream events. |
| `test/...` | Create/Modify | Unit and integration tests for all modified components to lock in compliance. |

---

## Definition of Done

- [ ] `npm run test` passes with zero failures.
- [ ] All 26 gaps identified in the 2026-03-21 Compliance Report are implemented and verified.
- [ ] `StreamAccumulator` perfectly reconstructs a complete response from raw stream events.
- [ ] Active tools execute automatically during a `stream()` call without any manual caller intervention, looping until the LLM naturally stops.
- [ ] `ExecutionEnvironment` exposes all spec-mandated methods, and the timeout tracking is verified to be accurate.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Streaming Loop Complexity** | High | High | Adding an internal execution loop inside an async generator `stream()` requires careful error propagation, cancellation handling, and yielding. Exhaustive test coverage using simulated tool streams is required. |
| **OS Version Consistency** | Low | Low | Cross-platform differences in `os.release()` might break tests depending on where they run. Test data will need mocked OS metadata. |

---

## Dependencies

- No external runtime dependencies. Relies on existing standard libraries (`os`, `child_process`).
- Must strictly follow the pinned upstream attractor spec version.
