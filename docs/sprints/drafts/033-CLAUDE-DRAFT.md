# Sprint 033: Green Suite & Remaining Compliance Closure

## Overview

**Goal:** Achieve a permanently green test suite by fixing the 6 integration test failures that have persisted since Sprint 025, then close every remaining compliance gap in one pass. After this sprint: `npm test` is green with zero timeouts, the compliance report lists zero open gaps, and the engine is spec-complete.

**Why this sprint, why now:**

1. **The red suite is the longest-standing defect in the project.** 6 integration tests have failed continuously across sprints 025 through 032 — eight consecutive sprints. Every one of those sprints listed "green suite" as a goal. Every one failed. The root causes are now well-understood (SSE deferred close, `withLiveCurrentNode()` logic error, pipeline creation body validation) but have never been fixed together in a single focused effort. This sprint treats the test failures as the primary deliverable, not a side goal.

2. **Previous sprints failed because they mixed SSE fixes with large feature work.** Sprints 029–032 each bundled SSE lifecycle fixes with 10+ compliance gaps, new event types, session semantics changes, and tool-call repair pipelines. The SSE fix kept getting deprioritized or implemented with deferred-close patterns that introduced new race conditions. This sprint inverts the priority: fix the tests first, verify green, then do compliance work.

3. **25 compliance gaps have been closed; 25 remain, all low-to-medium severity.** The remaining gaps are interface shape additions (missing optional fields), naming divergences, and catalog updates. None require architectural changes. Most are single-file, single-function additions. Closing them all in one pass eliminates the compliance debt permanently.

4. **A green, spec-complete engine unblocks The Hive.** The web UI, seedbed, and swarm intelligence features all depend on the HTTP server and SSE streams working correctly. Every sprint spent re-fixing SSE is a sprint not building product. Closing the book on engine compliance means the next sprint can focus entirely on user-facing features.

**Scope:** Fix 6 failing integration tests + close all 25 remaining compliance gaps (A1, A2, A4, A5, A6, C3, C4, C5, C9, C10, C11, C12, U1, U2, U3, U4, U5, U6, U7, U8, U9, U10, U11, U12, U19).

**Out of scope:**
- Web UI ("The Hive"), seedbed, swarm intelligence
- New CLI commands or HTTP endpoints
- New handlers or engine features
- Performance optimization
- Architecture refactoring beyond what's needed for fixes
- Self-update, binary packaging, shell completions

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures, zero timeouts. No test timeout values inflated. This is the hard gate — nothing else in this sprint ships if this fails.

2. **SSE streams close synchronously on terminal events.** A test client or browser opening `/pipelines/:id/events` receives all events during execution and the stream closes immediately (not deferred via `setTimeout`) after the terminal event. No race conditions between close scheduling and test assertions.

3. **Active pipeline context includes the current node.** `GET /pipelines/:id/context` returns `current_node` when the pipeline is mid-execution, not `undefined`.

4. **Pipeline creation accepts valid DOT source.** `POST /pipelines` with a `dot_source` body returns 202, not 400.

5. **A compliance audit finds zero gaps.** Every requirement in the three attractor NLSpec documents is implemented with source code evidence. The compliance report's GAPS section is empty.

6. **Model catalog covers current model families.** `getModelInfo()` resolves GPT-5.2, Claude Opus 4.6, and Gemini 3.x model IDs referenced in the spec.

7. **Adapters support lifecycle and capability queries.** Adapters expose optional `initialize()`/`close()` methods and `supports_tool_choice(mode)` for callers that need to check capabilities before sending requests.

---

## Architecture

### Test Fix Strategy: Root-Cause-First, Not Symptom-Chasing

Previous sprints failed because they treated the SSE test failures as a side effect of missing features. The actual root causes are three distinct bugs:

**Bug 1: Deferred SSE close creates race conditions (4 tests)**

`createFiniteSseStream()` in `src/server/sse.ts` uses `setTimeout(..., 0)` to schedule stream close after a terminal event. This means the close happens on the next event loop tick, not immediately after the terminal event is written. In tests, assertions run between the event write and the deferred close, causing timeouts when tests wait for the stream to end.

Fix: Replace `scheduleTerminalClose()` with a synchronous `core.close()` call. The terminal event has already been written to the response buffer — there is no reason to defer the close.

```
Current:  send terminal event → schedule close (setTimeout 0) → ❌ test asserts before close fires
Fixed:    send terminal event → close immediately → ✅ test sees stream end
```

**Bug 2: `withLiveCurrentNode()` condition is inverted (1 test)**

In `src/server/run-manager.ts` line 727, the condition `if (!currentNode || context.current_node)` returns early when `currentNode` is falsy OR when `context.current_node` already exists. The `||` should be `&&` — the function should only skip adding the node when there's nothing to add AND the context already has the value.

Fix: Split the guard into two clear conditions: return early if `currentNode` is undefined; return early if `context.current_node` is already set.

**Bug 3: Pipeline creation validation rejects valid DOT (1 test)**

`POST /pipelines` returns 400 when sending `dot_source`. The request body parsing or validation pipeline incorrectly rejects the payload. This requires investigation of the exact error response, but the likely cause is either `readJson()` failing to parse the body or the DOT validation returning error-severity diagnostics for a structurally valid graph.

Fix: Trace the exact 400 response body, identify which validation step rejects it, and fix the validation or parsing logic.

### Compliance Gap Closure Strategy

The 25 remaining gaps fall into four categories:

**Category 1: Missing optional interface fields (U4, U5, U6, U7, U8, U9, U10, U11, U12)**
Add the missing fields to existing type definitions. These are additive — they don't change existing behavior. Examples: `Message.tool_call_id`, `Message.text` accessor, `ToolCallData.type`, `ToolResultData.image_data`, `Usage.raw`, StreamEvent fields.

**Category 2: Missing adapter methods (U1, U2)**
Add `initialize()`/`close()` lifecycle methods and `supports_tool_choice(mode)` to the `ProviderAdapter` interface as optional methods. Implement them in each adapter.

**Category 3: Naming and convention corrections (A4, C9, C10, C11)**
Either add aliases that support both conventions or document the intentional divergence. For event naming (A4), add PascalCase aliases or a mapping layer. For tool parameter names (C9–C11), add the spec-named parameters as aliases alongside the current names.

**Category 4: Missing capabilities and content (A1, A2, A5, A6, C3, C4, C5, C12, U3, U19)**
- A1: Tighten `terminal_node` validation to enforce exactly one exit
- A2: Document that JS single-threaded event loop provides the same guarantee as ReadWriteLock
- A5: Codergen handler writes `response.md` and sets `last_stage`/`last_response` context updates
- A6: Match auto_status notes to spec text
- C3: Add optional `web_search`/`web_fetch` tools to Gemini profile
- C4: Add `context_window_size` to `ProviderProfile`
- C5: Add `supports_reasoning`/`supports_streaming` capability flags
- C12: Add provider-tailored system prompt sections
- U3: Update model catalog with current model families
- U19: Map Gemini RECITATION to `content_filter`

---

## Implementation

### Phase 1: Fix the 6 Failing Tests (~30%)

**Files:** `src/server/sse.ts`, `src/server/run-manager.ts`, `src/server/routes/pipelines.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/http-server.test.ts`, `test/integration/seed-run-linkage.test.ts`, `test/server/gardens-draft.test.ts`, `test/server/pipeline-events.test.ts`

**Tasks:**
- [ ] **SSE synchronous close:** In `src/server/sse.ts`, replace `scheduleTerminalClose()` with an immediate `core.close()` call after writing the terminal event. Remove the `pendingCloseTimer` state entirely — it is dead complexity that causes the race condition.
- [ ] **`withLiveCurrentNode()` fix:** In `src/server/run-manager.ts`, change the guard at line 727 from `if (!currentNode || context.current_node)` to two separate checks: `if (!currentNode) return context; if (context.current_node) return context;`
- [ ] **Pipeline creation 400 diagnosis:** Add a test that logs the exact 400 response body from `POST /pipelines`. Trace the rejection through `readJson()` → `startPipeline()` → validation. Fix the identified validation or parsing bug.
- [ ] **Run the full test suite.** All 6 previously-failing tests must pass. No other tests may regress. This is the gate for proceeding to Phase 2.
- [ ] **Add a guard test:** A new test in `test/server/sse-lifecycle.test.ts` that asserts `createFiniteSseStream` closes the response synchronously (same tick) after a terminal event, not deferred.

**Hard rule:** Phase 2 does not begin until `npm test` is green.

### Phase 2: Interface Shape Gaps — Types and Optional Fields (~20%)

**Files:** `src/llm/types.ts`, `src/llm/streaming.ts`, `src/llm/tools.ts`, `src/llm/adapters/types.ts`, `src/agent-loop/provider-profiles.ts`

**Tasks:**
- [ ] **U4:** Add `tool_call_id?: string` to the `Message` interface
- [ ] **U5:** Add `get text(): string` convenience accessor to `Message` that concatenates all TEXT content parts
- [ ] **U6:** Add `type?: 'function' | 'custom'` to `ToolCallData`
- [ ] **U7:** Add `image_data?: string` and `image_media_type?: string` to `ToolResultData`
- [ ] **U8:** Add `raw?: unknown` to `Usage`
- [ ] **U9:** Add `text_id` tracking to text stream events; add `PROVIDER_EVENT` stream event type with `raw` passthrough field
- [ ] **U10:** Forward unrecognized provider events as `PROVIDER_EVENT` instead of silently dropping them (in each adapter's stream parser)
- [ ] **U11:** Add `per_step?: number` to `TimeoutConfig` for per-LLM-call timeout in multi-step operations
- [ ] **U12:** Add optional `max_retries?: number` to `GenerateRequest` for per-call retry config override
- [ ] **C4:** Add `context_window_size?: number` to `ProviderProfile` interface; populate from `getModelInfo()` in each built-in profile
- [ ] **C5:** Add `supports_reasoning?: boolean` and `supports_streaming?: boolean` to `ProviderProfile`
- [ ] Tests for each new field: verify it's present in type definitions, populated where appropriate, and round-trips through serialization

### Phase 3: Adapter Lifecycle, Capabilities, and Error Mapping (~15%)

**Files:** `src/llm/adapters/types.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `src/llm/client.ts`, `src/llm/catalog.ts`

**Tasks:**
- [ ] **U1:** Add optional `initialize?(): Promise<void>` and `close?(): Promise<void>` to `ProviderAdapter`. Call `close()` in a new `UnifiedClient.close()` method that iterates all registered adapters.
- [ ] **U2:** Add `supports_tool_choice?(mode: ToolChoice): boolean` to `ProviderAdapter`. Implement for each adapter: OpenAI and Anthropic support all modes; Gemini does not support `named` mode.
- [ ] **U3:** Update `src/llm/catalog.ts` with GPT-5.2 family (gpt-5.2, gpt-5.2-mini), Claude 4.5/4.6 family (claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5), and Gemini 3.x models (gemini-3.0-pro, gemini-3.0-flash) with correct context windows, pricing, and capabilities.
- [ ] **U19:** In `src/llm/adapters/gemini.ts`, map the `RECITATION` finish reason to `content_filter` instead of `other`.
- [ ] Tests: lifecycle method invocation order, `supports_tool_choice` returns correct values per adapter, catalog resolves new model IDs, RECITATION maps to content_filter

### Phase 4: Attractor Spec Compliance — Validation, Events, Handlers (~20%)

**Files:** `src/garden/validate.ts`, `src/engine/events.ts`, `src/handlers/codergen.ts`, `src/engine/engine.ts`, `src/engine/context.ts`

**Tasks:**
- [ ] **A1:** Tighten the `terminal_node` validation rule to require exactly one exit node (currently allows multiple). Add a new diagnostic code `multiple_exit_nodes` with severity `error`.
- [ ] **A2:** Add a doc comment to `ExecutionContext` explaining that JS's single-threaded event loop provides the equivalent of a ReadWriteLock for synchronous operations, and that parallel branches operate on cloned contexts. Mark this as an intentional design decision, not a gap.
- [ ] **A4:** Add a `toPascalCase()` event name mapping utility. Emit events with both snake_case (current) and PascalCase names, or add a PascalCase alias registry that consumers can opt into. The snake_case names remain the primary format.
- [ ] **A5:** In the codergen handler, write `response.md` to the stage directory and set `context_updates` with `last_stage` and `last_response` keys matching the spec language.
- [ ] **A6:** Change auto_status synthesized notes to exactly match spec text: `"auto-status: handler completed without writing status"`
- [ ] Tests: validation rejects graphs with 2+ exit nodes, PascalCase mapping produces correct names, codergen handler writes response.md and sets correct context keys, auto_status notes match spec text

### Phase 5: Agent Loop Profile Gaps (~10%)

**Files:** `src/agent-loop/provider-profiles.ts`, `src/agent-loop/tools/grep.ts`, `src/agent-loop/tools/glob.ts`, `src/agent-loop/tools/read-file.ts`

**Tasks:**
- [ ] **C3:** Add optional `web_search` and `web_fetch` tool definitions to the Gemini profile. These can be stub implementations that return "not available in local mode" — the spec marks them as optional, but the profile should list them.
- [ ] **C9:** Add `file_path` as an alias for `path` in the `read_file` tool schema (accept both, prefer `file_path` in documentation)
- [ ] **C10:** Add `path` parameter to the `glob` tool schema for specifying a base directory
- [ ] **C11:** Add `glob_filter` as an alias for `include` in the `grep` tool schema
- [ ] **C12:** Add provider-tailored system prompt sections to each profile. The Anthropic profile should reference Claude's strengths, the OpenAI profile should reference GPT's, and the Gemini profile should reference Gemini's. These supplement the shared generic prompt, not replace it.
- [ ] Tests: Gemini profile includes web tools, tool schemas accept both old and new parameter names, each profile's system prompt contains provider-specific content

### Phase 6: Compliance Report Update & Final Verification (~5%)

**Files:** `docs/compliance-report.md`

**Tasks:**
- [ ] Run `npm run build` — zero TypeScript errors
- [ ] Run `npm test` — zero failures, zero timeouts
- [ ] Re-audit every gap (A1–A6, C3–C12, U1–U19) against the current codebase
- [ ] Move all closed gaps from GAPS to IMPLEMENTED in `docs/compliance-report.md`
- [ ] Verify the GAPS section is empty
- [ ] Update the Summary section to reflect zero remaining gaps

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/sse.ts` | Modify | Replace deferred close with synchronous close on terminal events |
| `src/server/run-manager.ts` | Modify | Fix `withLiveCurrentNode()` guard condition |
| `src/server/routes/pipelines.ts` | Modify | Fix pipeline creation validation (if needed) |
| `src/llm/types.ts` | Modify | Add missing fields: Message.tool_call_id, Message.text, ToolCallData.type, ToolResultData.image_data/image_media_type, Usage.raw |
| `src/llm/streaming.ts` | Modify | Add text_id tracking, PROVIDER_EVENT type, raw passthrough |
| `src/llm/tools.ts` | Modify | Add ToolCallData.type field |
| `src/llm/adapters/types.ts` | Modify | Add optional initialize/close/supports_tool_choice to ProviderAdapter |
| `src/llm/adapters/anthropic.ts` | Modify | Implement lifecycle methods, forward unrecognized events |
| `src/llm/adapters/openai.ts` | Modify | Implement lifecycle methods, forward unrecognized events |
| `src/llm/adapters/gemini.ts` | Modify | Implement lifecycle methods, map RECITATION→content_filter, forward unrecognized events |
| `src/llm/adapters/openai-compatible.ts` | Modify | Implement lifecycle methods, forward unrecognized events |
| `src/llm/client.ts` | Modify | Add UnifiedClient.close(), per-call max_retries, per_step timeout |
| `src/llm/catalog.ts` | Modify | Add GPT-5.2, Claude 4.5/4.6, Gemini 3.x model entries |
| `src/llm/timeouts.ts` | Modify | Add per_step to TimeoutConfig |
| `src/garden/validate.ts` | Modify | Tighten terminal_node to exactly one exit |
| `src/engine/events.ts` | Modify | Add PascalCase event name aliases |
| `src/engine/engine.ts` | Modify | Emit PascalCase event names, fix auto_status notes |
| `src/engine/context.ts` | Modify | Add ReadWriteLock design decision doc comment |
| `src/handlers/codergen.ts` | Modify | Write response.md, set last_stage/last_response context |
| `src/agent-loop/provider-profiles.ts` | Modify | Add context_window_size, capability flags, provider-specific prompt sections |
| `src/agent-loop/tools/read-file.ts` | Modify | Accept file_path alias |
| `src/agent-loop/tools/glob.ts` | Modify | Add path parameter for base directory |
| `src/agent-loop/tools/grep.ts` | Modify | Accept glob_filter alias |
| `test/server/sse-lifecycle.test.ts` | Modify | Add synchronous-close guard test |
| `docs/compliance-report.md` | Modify | Move all gaps to IMPLEMENTED, empty GAPS section |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts
- [ ] No test timeout values were increased to achieve green
- [ ] The 6 previously-failing integration tests all pass: hive-run-flow, http-resume, http-server, seed-run-linkage, gardens-draft, pipeline-events
- [ ] `createFiniteSseStream` closes the response on the same event loop tick as the terminal event (no `setTimeout`)
- [ ] `GET /pipelines/:id/context` returns `current_node` when pipeline is mid-execution
- [ ] `POST /pipelines` with valid `dot_source` body returns 202
- [ ] `terminal_node` validation enforces exactly one exit node
- [ ] Codergen handler writes `response.md` to stage directory and sets `last_stage`/`last_response` context keys
- [ ] auto_status notes text is `"auto-status: handler completed without writing status"`
- [ ] PascalCase event name aliases are available for all engine events
- [ ] `ProviderAdapter` has optional `initialize()`/`close()` lifecycle methods
- [ ] `ProviderAdapter` has `supports_tool_choice(mode)` method
- [ ] Model catalog includes GPT-5.2, Claude 4.5/4.6, and Gemini 3.x families
- [ ] Gemini RECITATION finish reason maps to `content_filter`
- [ ] `Message` interface has `tool_call_id` and `text` accessor
- [ ] `ToolCallData` has `type` field; `ToolResultData` has `image_data`/`image_media_type`
- [ ] `Usage` has `raw` field
- [ ] StreamEvent supports `text_id`, `PROVIDER_EVENT` type, and `raw` passthrough
- [ ] `TimeoutConfig` has `per_step` field; `GenerateRequest` has `max_retries` field
- [ ] Gemini profile includes optional `web_search`/`web_fetch` tools
- [ ] `ProviderProfile` has `context_window_size`, `supports_reasoning`, `supports_streaming`
- [ ] Tool parameters accept spec-named aliases (`file_path`, `path`, `glob_filter`)
- [ ] Each provider profile includes provider-specific system prompt content
- [ ] `docs/compliance-report.md` GAPS section is empty
- [ ] `docs/compliance-report.md` Summary shows zero remaining gaps

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE synchronous close causes events to be dropped before flush | Low | High | The terminal event is already written to the response buffer before close is called. `res.end()` flushes the buffer. Verify with a test that reads the terminal event from the response body. |
| Pipeline creation 400 has a deeper cause than expected | Medium | High | Phase 1 requires logging the exact error response body before attempting a fix. If the root cause is complex, isolate it as a focused debugging task. |
| `terminal_node` exactly-one enforcement breaks existing gardens | Medium | Medium | Audit all `.dot` files in the repo for multiple exit nodes before tightening validation. If any exist, either fix them or add a deprecation warning period. |
| Model catalog entries have incorrect pricing/context windows | Medium | Low | Cross-reference with provider documentation at time of implementation. Catalog entries are informational, not behavioral. |
| Provider-specific system prompts drift from upstream agents | Medium | Low | Keep provider-specific sections short and focused on factual capabilities, not behavioral directives that change across model versions. |
| Adding 15+ optional fields bloats type definitions | Low | Low | All new fields are optional with `?`. They add no runtime cost and no breaking changes. |
| Parameter aliases create ambiguity when both old and new names are provided | Medium | Medium | Document that when both names are present, the spec-named parameter takes precedence. Add a test for the conflict case. |
| This sprint is too large for a single pass | Medium | High | Phase 1 is the hard gate. If Phase 1 takes longer than expected, the compliance gaps can overflow to Sprint 034 — but the tests MUST be fixed in this sprint. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Pinned spec snapshot via `docs/compliance-report.md` | Source of truth for gap definitions |
| Current model provider documentation | Required for catalog updates (U3) |
| `vitest` | Test runner |
| `ajv` | Schema validation for tool parameter aliases |
| No new runtime packages | All changes are to existing modules |
