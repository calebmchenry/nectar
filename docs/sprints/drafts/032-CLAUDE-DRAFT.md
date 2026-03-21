# Sprint 032: SSE Stream Termination Fix & Compliance Gap Closure

## Overview

**Goal:** Fix the 6 failing tests caused by SSE streams that never close, close all remaining compliance gaps, and deliver a green suite with zero spec deviations. After this sprint: `npm test` passes 1130/1130, and a compliance audit finds zero gaps.

**Why this sprint, why now:**

Sprint 031 correctly diagnosed the problem — SSE lifecycle bugs and 15 compliance gaps — but was never executed. The 6 failing tests have persisted across sprints 025–031 and block every downstream feature. This sprint inherits 031's diagnosis but narrows the execution plan to be completable in a single focused sprint by an implementer who can read the failing tests and fix the root causes directly.

**The two root causes behind the 6 failures:**

1. **SSE streams never close.** The HTTP route handlers for `/pipelines/:id/events` and `/gardens/draft` open an SSE stream and subscribe to engine events, but never call `res.end()` when a terminal event fires (`run_completed`, `pipeline_failed`, `run_interrupted`). Tests that consume SSE streams hang until the 5-second timeout, then fail. This affects: `http-server.test.ts`, `http-resume.test.ts`, `hive-run-flow.test.ts`, `seed-run-linkage.test.ts`, `gardens-draft.test.ts`.

2. **Missing `run_error` event emission.** The engine emits `stage_failed` and `pipeline_failed` but not `run_error` for node execution failures. `pipeline-events.test.ts` asserts on `run_error` and fails.

**Compliance gaps (from docs/compliance-report.md):**

- **6 Attractor gaps** (A1–A6): terminal_node rule relaxation, missing ReadWriteLock (N/A for JS), missing CheckpointSaved event, event naming convention, codergen response.md handling, auto_status notes text.
- **12 Coding Agent Loop gaps** (C1–C12): inverted walk direction, spawn_agent max_turns, Gemini web tools, ProviderProfile fields, default limits, process group, parameter naming, system prompts.
- **19 Unified LLM gaps** (U1–U19): adapter lifecycle, supports_tool_choice, catalog updates, Message fields, ToolCallData.type, image tool results, Usage.raw, StreamEvent fields, PROVIDER_EVENT, TimeoutConfig.per_step, per-call retry, tool name validation, repair_tool_call, TimeoutError retryability, HTTP status codes, on_retry callback, redacted_thinking data, Gemini RECITATION mapping.

**Prioritization:** Fix the 6 test failures first (Workstream A), then close compliance gaps by severity — high first, then medium, then low (Workstream B). Low-severity gaps that are purely additive interface fields get batched together.

**Out of scope:**
- Web UI features, seedbed, swarm analysis
- New CLI commands or HTTP endpoints
- Architecture refactoring beyond what's required for fixes
- Performance optimization
- Shell completions, self-update, single-binary packaging

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures, zero timeouts, zero skipped tests.

2. **SSE streams close when pipelines finish.** A test client (or browser) opening `/pipelines/:id/events` receives events during execution and a clean stream close after the terminal event. No hanging connections.

3. **Pipeline failures emit the full event sequence.** When a node fails fatally, the event stream contains `stage_failed`, `run_error`, and `pipeline_failed` in the correct order, matching the attractor spec's event contract.

4. **A fresh compliance audit returns zero gaps.** An agent reading the three pinned spec documents and comparing against the codebase finds no unimplemented requirements across all three specs.

5. **Project instruction files are discovered correctly.** Walking from git root toward cwd (not upward), with deeper files taking precedence, matching the coding-agent-loop spec §6.5.

6. **Streaming consumers get complete lifecycle events.** `stream_end` carries a fully assembled `GenerateResponse`. Unrecognized provider events are surfaced as `PROVIDER_EVENT` instead of being silently dropped.

---

## Architecture

### No new architecture — two focused workstreams

**Workstream A: Fix 6 Failing Tests (days 1–2)**

The SSE route handlers must detect terminal events and call `res.end()`. The engine already emits terminal events; the HTTP layer fails to act on them. The `run_error` event must be emitted by the engine when a node fails and no retry/failure edge is available.

```
Terminal event flow (current):
  Engine emits run_completed → SSE handler writes event → ❌ stream stays open

Terminal event flow (fixed):
  Engine emits run_completed → SSE handler writes event → res.end() → ✅ stream closes
```

**Workstream B: Compliance Gap Closure (days 2–5)**

37 gaps organized into batches by affected module:

| Batch | Gaps | Files |
|-------|------|-------|
| SSE/Event fixes | A3, A4, A6 | `src/engine/events.ts`, `src/server/routes/pipelines.ts`, `src/engine/engine.ts` |
| Attractor relaxation | A1, A2 | `src/garden/validate.ts`, `src/engine/context.ts` (document JS single-thread as sufficient) |
| Codergen response | A5 | `src/handlers/codergen.ts` |
| Agent loop walk | C1 | `src/agent-loop/project-instructions.ts` |
| Agent loop params | C2, C6, C7, C9, C10, C11 | `src/agent-loop/subagent-manager.ts`, `src/agent-loop/types.ts`, `src/agent-loop/tools/` |
| Agent loop extras | C3, C4, C5, C8, C12 | `src/agent-loop/provider-profiles.ts`, `src/agent-loop/execution-environment.ts` |
| LLM adapter lifecycle | U1, U2 | `src/llm/adapters/types.ts`, all adapter files |
| LLM types | U4, U5, U6, U7, U8, U9, U10 | `src/llm/adapters/types.ts`, `src/llm/streaming.ts` |
| LLM catalog | U3 | `src/llm/catalog.ts` |
| LLM client | U11, U12, U14, U17 | `src/llm/client.ts`, `src/llm/retry.ts`, `src/llm/timeouts.ts` |
| LLM errors | U15, U16 | `src/llm/errors.ts`, adapter files |
| LLM tools | U13, U14 | `src/llm/tools.ts`, `src/llm/client.ts` |
| LLM Anthropic | U18, U19 | `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts` |

---

## Implementation

### Phase 1: SSE Lifecycle Fix (~25%)

**Files:** `src/server/routes/pipelines.ts`, `src/server/routes/gardens.ts` (or wherever the draft SSE route lives), `test/server/pipeline-events.test.ts`, `test/server/gardens-draft.test.ts`

**Tasks:**
- [ ] In the pipeline events SSE route handler, after writing any terminal event (`run_completed`, `pipeline_failed`, `run_interrupted`, `run_error`), call `res.end()` to close the stream
- [ ] In the garden draft SSE route handler, after writing `draft_complete` or `draft_error`, call `res.end()`
- [ ] Add cleanup: unsubscribe from engine events on `res.close()` (client disconnect) and on terminal event
- [ ] Emit `run_error` from the engine when a node fails fatally and no failure edge or retry is available, before emitting `pipeline_failed`
- [ ] Verify all 6 previously-failing tests now pass
- [ ] Add a regression test: open SSE stream, run a pipeline to completion, assert stream closes within 1 second of terminal event

### Phase 2: High-Severity Compliance Gaps (~25%)

**Files:** `src/llm/adapters/anthropic.ts`, `src/llm/errors.ts`, `src/agent-loop/project-instructions.ts`, `src/agent-loop/types.ts`

**Tasks:**
- [ ] **U18** — Add `data` field to `RedactedThinkingContentPart` for opaque round-tripping. In the Anthropic adapter, preserve the raw `data` field from the API response on redacted_thinking content parts.
- [ ] **U15** — Change `TimeoutError` to `retryable: false` (spec §6.3 says timeout is non-retryable, status 408). Update any retry logic that checks retryability.
- [ ] **C1** — Fix project instruction walk direction: walk from git root toward cwd (deeper = higher precedence), not upward from workspace root.
- [ ] **C6** — Change default `max_turns` to 0 (unlimited) per spec §2.2.
- [ ] **C7** — Change default `max_tool_rounds_per_input` to 0 (unlimited) per spec §2.2.
- [ ] Add/update tests for each fix.

### Phase 3: Medium-Severity Compliance Gaps (~25%)

**Files:** `src/engine/events.ts`, `src/engine/engine.ts`, `src/checkpoint/types.ts`, `src/agent-loop/subagent-manager.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/provider-profiles.ts`, `src/llm/catalog.ts`, `src/llm/tools.ts`, `src/llm/client.ts`

**Tasks:**
- [ ] **A3** — Add `CheckpointSaved` event type to `src/engine/events.ts`. Emit it from the engine after each checkpoint write.
- [ ] **C2** — Add `max_turns` parameter to `spawn_agent` tool definition and pass it through to child `AgentSession` config.
- [ ] **C8** — Add `detached: true` to `execa` options in `src/agent-loop/execution-environment.ts` shell execution, with process group cleanup on abort/timeout.
- [ ] **U3** — Update model catalog with GPT-5.2 family, Claude Opus 4.6, Gemini 3.x models referenced in the spec.
- [ ] **U13** — Add tool name validation: `[a-zA-Z][a-zA-Z0-9_]*`, max 64 chars. Validate on tool registration and on tool calls.
- [ ] **U14** — Add `repair_tool_call` function parameter to `generate()` / `stream()` options. When tool call JSON is invalid, call repair function before failing.
- [ ] Add/update tests for each fix.

### Phase 4: Low-Severity Compliance Gaps (~25%)

**Files:** `src/llm/adapters/types.ts`, `src/llm/streaming.ts`, `src/llm/retry.ts`, `src/llm/timeouts.ts`, `src/llm/client.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `src/garden/validate.ts`, `src/engine/context.ts`, `src/handlers/codergen.ts`, `src/agent-loop/tools/read-file.ts`, `src/agent-loop/tools/grep.ts`, `src/agent-loop/tools/glob.ts`, `src/agent-loop/provider-profiles.ts`

**Tasks:**
- [ ] **A1** — Document in `validate.ts` that allowing multiple exit nodes is an intentional relaxation of the spec's "exactly one" rule (compatible superset).
- [ ] **A2** — Document in `context.ts` that JS single-threaded event loop provides equivalent safety to a ReadWriteLock. Parallel branches already use context clones.
- [ ] **A4** — Add PascalCase event type aliases alongside existing snake_case types for spec compatibility. Emit both forms or add a mapping layer.
- [ ] **A5** — In codergen handler, write `response.md` to stage dir and set `context_updates` with `last_stage` and `last_response` keys per spec §4.5.
- [ ] **A6** — Update auto_status synthesized notes to match spec text: "auto-status: handler completed without writing status".
- [ ] **C3** — Add optional `web_search` and `web_fetch` tools to Gemini provider profile (spec marks as optional, implement stub definitions).
- [ ] **C4** — Add `context_window_size` field to `ProviderProfile` interface.
- [ ] **C5** — Add `supports_reasoning` and `supports_streaming` capability flags to `ProviderProfile`.
- [ ] **C9** — Rename `read_file` tool parameter from `path` to `file_path` per spec §3.3.
- [ ] **C10** — Add `path` parameter to `glob` tool for base directory filtering per spec §3.3.
- [ ] **C11** — Rename `grep` parameter from `include` to `glob_filter` per spec §3.3.
- [ ] **C12** — Add provider-specific system prompt templates that more closely mirror native agent prompts per spec §3.5.
- [ ] **U1** — Add optional `close()` and `initialize()` lifecycle methods to `ProviderAdapter` interface. Implement no-ops in existing adapters.
- [ ] **U2** — Add `supports_tool_choice(mode)` method to `ProviderAdapter` interface with correct implementations per provider.
- [ ] **U4** — Add `tool_call_id` field to `Message` interface.
- [ ] **U5** — Add `text` convenience accessor to `Message` that concatenates text parts.
- [ ] **U6** — Add `type` field ("function" or "custom") to `ToolCallData`.
- [ ] **U7** — Add `image_data` and `image_media_type` fields to `ToolResultData`.
- [ ] **U8** — Add `raw` field to `Usage` for raw provider usage data.
- [ ] **U9** — Add `text_id` field to relevant stream events. Add `raw` passthrough field.
- [ ] **U10** — Add `PROVIDER_EVENT` stream event type for unrecognized provider events instead of silently dropping them.
- [ ] **U11** — Add `per_step` timeout to `TimeoutConfig` for per-LLM-call timeout in multi-step operations.
- [ ] **U12** — Add `max_retries` parameter to `generate()` for per-call retry config override.
- [ ] **U16** — Add HTTP status code handling for 408→RequestTimeoutError, 413→ContextLengthError, 422→InvalidRequestError.
- [ ] **U17** — Add `on_retry` callback to `RetryPolicy`/`RetryConfig`, called before each retry with `(error, attempt, delay)`.
- [ ] **U19** — Map Gemini `RECITATION` finish reason to `content_filter` instead of `other`.
- [ ] Run full test suite, fix any regressions.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/routes/pipelines.ts` | Modify | Close SSE streams on terminal events |
| `src/server/routes/gardens.ts` | Modify | Close draft SSE streams on completion |
| `src/engine/engine.ts` | Modify | Emit `run_error` before `pipeline_failed`, emit `CheckpointSaved` |
| `src/engine/events.ts` | Modify | Add `CheckpointSaved` event type, PascalCase aliases |
| `src/engine/context.ts` | Modify | Document single-thread safety rationale |
| `src/garden/validate.ts` | Modify | Document multiple-exit relaxation |
| `src/handlers/codergen.ts` | Modify | Write response.md, set last_stage/last_response context |
| `src/checkpoint/types.ts` | Modify | Add logs field if missing |
| `src/agent-loop/project-instructions.ts` | Modify | Fix walk direction (git root → cwd) |
| `src/agent-loop/types.ts` | Modify | Change default max_turns=0, max_tool_rounds=0 |
| `src/agent-loop/subagent-manager.ts` | Modify | Accept max_turns param on spawn_agent |
| `src/agent-loop/execution-environment.ts` | Modify | Add detached:true for process group cleanup |
| `src/agent-loop/provider-profiles.ts` | Modify | Add context_window_size, capability flags, Gemini web tools, provider-specific prompts |
| `src/agent-loop/tools/read-file.ts` | Modify | Rename path→file_path parameter |
| `src/agent-loop/tools/grep.ts` | Modify | Rename include→glob_filter parameter |
| `src/agent-loop/tools/glob.ts` | Modify | Add path parameter for base dir |
| `src/llm/adapters/types.ts` | Modify | Add lifecycle methods, supports_tool_choice, Message fields, ToolCallData.type, ToolResultData image fields, Usage.raw |
| `src/llm/adapters/anthropic.ts` | Modify | Implement lifecycle stubs, preserve redacted_thinking data field, supports_tool_choice |
| `src/llm/adapters/openai.ts` | Modify | Implement lifecycle stubs, supports_tool_choice |
| `src/llm/adapters/gemini.ts` | Modify | Implement lifecycle stubs, supports_tool_choice, RECITATION→content_filter |
| `src/llm/streaming.ts` | Modify | Add text_id, raw fields to stream events, PROVIDER_EVENT type |
| `src/llm/catalog.ts` | Modify | Add GPT-5.2, Opus 4.6, Gemini 3.x models |
| `src/llm/client.ts` | Modify | Add repair_tool_call, max_retries per-call, per_step timeout |
| `src/llm/tools.ts` | Modify | Add tool name validation |
| `src/llm/errors.ts` | Modify | TimeoutError retryable:false, add 408/413/422 handling |
| `src/llm/retry.ts` | Modify | Add on_retry callback |
| `src/llm/timeouts.ts` | Modify | Add per_step to TimeoutConfig |
| `test/server/pipeline-events.test.ts` | Verify | Should pass after run_error fix |
| `test/server/gardens-draft.test.ts` | Verify | Should pass after SSE close fix |
| `test/integration/http-server.test.ts` | Verify | Should pass after SSE close fix |
| `test/integration/http-resume.test.ts` | Verify | Should pass after SSE close fix |
| `test/integration/hive-run-flow.test.ts` | Verify | Should pass after SSE close fix |
| `test/integration/seed-run-linkage.test.ts` | Verify | Should pass after SSE close fix |
| `test/server/sse-lifecycle.test.ts` | Create | Regression test: SSE close timing |
| `test/llm/tool-validation.test.ts` | Create | Tool name validation tests |
| `test/agent-loop/project-instructions.test.ts` | Modify | Test correct walk direction |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts (currently: 6 failing → 0 failing)
- [ ] SSE streams for `/pipelines/:id/events` close within 1 second of the terminal pipeline event
- [ ] SSE stream for `/gardens/draft` closes after `draft_complete` or `draft_error`
- [ ] `run_error` event is emitted when a node fails fatally with no retry/failure edge available
- [ ] `CheckpointSaved` event is emitted after each checkpoint write
- [ ] `RedactedThinkingContentPart` has a `data` field that round-trips through Anthropic API calls
- [ ] `TimeoutError.retryable` is `false`
- [ ] Project instruction walk direction goes from git root toward cwd (deeper = higher precedence)
- [ ] Default `max_turns` is 0 (unlimited); default `max_tool_rounds_per_input` is 0 (unlimited)
- [ ] `spawn_agent` accepts a `max_turns` parameter
- [ ] Shell commands in execution environment use `detached: true` with process group cleanup
- [ ] Model catalog includes GPT-5.2 family, Claude Opus 4.6, and Gemini 3.x models
- [ ] Tool names are validated: `[a-zA-Z][a-zA-Z0-9_]*`, max 64 chars
- [ ] `repair_tool_call` function is accepted by `generate()` and `stream()`
- [ ] `read_file` uses `file_path` param, `grep` uses `glob_filter`, `glob` accepts `path` for base dir
- [ ] `ProviderProfile` has `context_window_size`, `supports_reasoning`, `supports_streaming` fields
- [ ] `ProviderAdapter` has optional `initialize()`, `close()`, and `supports_tool_choice(mode)` methods
- [ ] `Message` has `tool_call_id` field and `text` accessor
- [ ] `ToolCallData` has `type` field; `ToolResultData` has `image_data`/`image_media_type` fields
- [ ] `Usage` has `raw` field; stream events have `text_id` and `raw` fields
- [ ] `PROVIDER_EVENT` stream event type exists for unrecognized provider events
- [ ] Gemini `RECITATION` finish reason maps to `content_filter`
- [ ] `on_retry` callback fires before each retry attempt
- [ ] `TimeoutConfig` has `per_step` field; `generate()` accepts `max_retries` override
- [ ] HTTP 408→RequestTimeoutError, 413→ContextLengthError, 422→InvalidRequestError
- [ ] Codergen handler writes `response.md` and sets `last_stage`/`last_response` context keys
- [ ] Auto-status notes read "auto-status: handler completed without writing status"
- [ ] All existing tests continue to pass (no regressions)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE fix is insufficient — other routes also leak streams | Medium | High | Grep for all `text/event-stream` response handlers and audit each one. Add a shared `closeOnTerminalEvent()` helper. |
| Renaming tool parameters (C9/C10/C11) breaks existing tests | High | Medium | Search for all test references to old parameter names. Update atomically with the source change. |
| Changing default limits to unlimited (C6/C7) causes runaway sessions in tests | Medium | Medium | Tests that create agent sessions should set explicit limits. Only the *default* changes; existing explicit configs are unaffected. |
| Model catalog entries (U3) reference models not yet available in all environments | Low | Low | Catalog is informational — entries don't require API access. Mark availability status. |
| `detached: true` (C8) behaves differently on macOS vs Linux | Medium | Medium | Test on both. Use negative process group kill (`kill(-pid)`) with fallback. |
| Large number of changes (37 gaps) risks merge conflicts with parallel work | Medium | Medium | Batch changes by file. Commit after each phase. Run tests after each phase. |
| `repair_tool_call` (U14) is complex enough to be its own sprint | Low | Medium | Implement the interface and wiring only. The default is no-op (no repair). Users must supply the function. |
| PascalCase event aliases (A4) may confuse consumers expecting one convention | Medium | Low | Export both. Document that snake_case is the canonical form; PascalCase is provided for spec compatibility. |

---

## Security Considerations

- **Tool name validation (U13)** prevents injection through tool names containing special characters.
- **Process group cleanup (C8)** prevents orphaned child processes from lingering after timeout.
- **No `eval`/`Function`** anywhere — all condition parsing remains allowlist-only.
- **Parameter renames** are internal; no external API surface changes.

---

## Dependencies

No new packages required. All changes use existing dependencies:

| Package | Purpose |
|---------|---------|
| `execa` | Process group support via existing `detached` option |
| `vitest` | Testing (existing) |
| All others | Unchanged from current `package.json` |

---

## Open Questions

| Question | Proposed Resolution |
|----------|-------------------|
| Should A4 (PascalCase events) be a full rename or just aliases? | Aliases only — snake_case is canonical, PascalCase exported for compatibility. Avoids breaking existing consumers. |
| Should C6/C7 unlimited defaults apply to codergen sessions too? | Yes — spec says unlimited. Codergen handler can set explicit limits if needed via its own config. |
| Is A1 (multiple exits) truly a gap or a valid superset? | Valid superset — document as intentional. Multiple exit nodes are useful for distinct termination paths. |
| Is A2 (ReadWriteLock) applicable to JS? | No — JS is single-threaded. Document that context clones for parallel branches provide equivalent isolation. |
