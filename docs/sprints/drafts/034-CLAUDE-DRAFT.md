# Sprint 034: Compliance Zero — Fix the Last 4 Tests, Close All 22 Gaps, Hit the Hard Gate

## Overview

**Goal:** Ship a fully green test suite and close every remaining compliance gap in one focused sprint. After this sprint: `npm test` passes with zero failures, a fresh compliance audit against all three pinned specs finds zero unimplemented requirements, and the INTENT.md §5.1 hard gate is met.

**Why this sprint, why now:**

1. **The project has spent 10 sprints (025–033) trying to get the suite green and close compliance gaps.** Each sprint mixed gap closure with test fixes and always ran out of budget. Sprint 033 reduced failures from 6 to 4, but the suite is still red. The remaining 4 failures are well-diagnosed — no more root-cause discovery is needed, just execution.

2. **The 4 remaining test failures have known root causes.** `http-server` fails because `resolveCurrentNode()` returns undefined during active runs (timing issue with engine snapshot). `gardens-draft` fails because `draft_complete` is never emitted (validation or streaming path bug). `pipeline-events` fails because `pipeline_failed` is not in the event stream (emission ordering issue). `fan-in-llm` times out (mock or async lifecycle issue). These are all fixable bugs, not missing architecture.

3. **All 22 remaining compliance gaps are Low or Medium severity and mechanical.** No gap requires new architecture. 15 of 22 are one-line field additions, method stubs, or parameter renames. The remaining 7 are small features (model catalog update, glob path parameter, adapter lifecycle methods, provider profile fields). The longest single item is C12 (system prompt parity), estimated at 2–3 hours.

4. **The INTENT.md §5.1 hard gate blocks everything.** "An agent can read the pinned three attractor NLSpec documents, compare them against the Nectar implementation, and find zero unimplemented features." Every product-facing sprint built on a non-compliant engine risks rework. This is the last compliance sprint — after this, the project moves to polish and user-facing features.

5. **All major product areas already exist.** Engine, CLI (10 commands), Hive web UI, seedbed, swarm intelligence, garden drafting, self-update, single-binary distribution — all implemented. The compliance tail is the only thing standing between the current state and "done."

**Scope:** Fix 4 failing tests. Close 22 compliance gaps: A2, A4, A6, C3, C4, C5, C9, C10, C11, C12, U1, U2, U3, U4, U5, U6, U7, U8, U9, U10, U11, U12.

**Out of scope:**
- New product features, new CLI commands, new HTTP endpoints
- Web UI / Hive design changes
- Seedbed, swarm analysis, or garden authoring enhancements
- Performance optimization or architecture refactoring
- Shell completions, distribution changes

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures, zero timeouts, zero skipped tests. No test timeout values inflated.

2. **A compliance audit finds zero gaps.** A fresh read of attractor-spec.md, coding-agent-loop-spec.md, and unified-llm-spec.md compared against the implementation finds every requirement implemented or documented as a deliberate, justified deviation.

3. **Agent sessions read the right project instructions.** A `codergen` session launched from a nested directory reads `AGENTS.md` plus the provider-specific file at each directory level from repo root to cwd, with deeper files taking precedence. The glob tool accepts a `path` parameter for scoped searches. Grep accepts `glob_filter` alongside the existing `include` alias.

4. **Provider adapters have proper lifecycle and capability introspection.** Adapters expose `initialize()`, `close()`, and `supports_tool_choice(mode)`. The model catalog includes current-generation models (GPT-5.2, Claude Opus 4.6, Gemini 3.x). Provider profiles report `context_window_size`, `supports_reasoning`, and `supports_streaming`.

5. **Message and streaming types match the spec surface.** `Message` has `tool_call_id` and `text` accessor. `ToolCallData` has `type`. `ToolResultData` supports `image_data`. `Usage` has `raw`. Stream events include `text_id` and `PROVIDER_EVENT` for unrecognized provider events.

6. **Gemini profile optionally includes web tools.** The Gemini provider profile registers `web_search` and `web_fetch` as optional tools, gated by configuration.

---

## Architecture

### Test Fix Strategy

The 4 remaining failures are independent bugs, not symptoms of a shared root cause. Fix them in isolation, verify each in isolation, then run the full suite.

**Test 1: `http-server` — `current_node` undefined during active run**

`resolveCurrentNode()` queries the engine snapshot, but the engine may not have populated `current_node` yet when the status poll arrives. The fix is to make `RunManager.getStatus()` wait for the first `node_started` event before claiming the run is active, or to derive `current_node` from the last emitted `node_started` event rather than polling the engine snapshot.

**Test 2: `gardens-draft` — `draft_complete` never emitted**

Sprint 033 added single-exit validation to the draft path. If the LLM-generated DOT fails validation, `draft_error` should be emitted — but neither event fires, suggesting the streaming path itself is broken. Trace the `GardenDraftService.streamDraft()` async generator to find where the stream stalls or swallows errors.

**Test 3: `pipeline-events` — `pipeline_failed` not in event stream**

The engine emits `run_error` but not `pipeline_failed`. Sprint 032 added `run_error` emission; `pipeline_failed` may have been accidentally gated behind a condition that doesn't fire in the test fixture. Trace the terminal event emission path in `engine.ts`.

**Test 4: `fan-in-llm` — timeout**

This test exercises the LLM-based fan-in handler with mocks. A timeout suggests either the mock doesn't resolve, the fan-in handler awaits something that never completes, or the test setup doesn't wire the mock correctly. Inspect the mock LLM response and the handler's await chain.

### Compliance Gap Strategy

The 22 gaps cluster into 4 categories by effort:

**Category A: Trivial additions (< 15 min each, 12 gaps)**
A4, A6, U4, U5, U6, U7, U8, U9, U10 — Add missing fields, methods, or type discriminators. Change a string literal. Add an event type.

**Category B: Small features (30–60 min each, 6 gaps)**
A2, C4, C5, C9, C10, C11 — Add a parameter to a tool, add fields to an interface, add a no-op ReadWriteLock interface, rename/alias a parameter.

**Category C: Medium features (1–2 hours each, 3 gaps)**
U1, U2, U3 — Adapter lifecycle methods, tool-choice introspection, model catalog refresh.

**Category D: Largest item (2–3 hours, 1 gap)**
C12 — System prompts should be closer to reference-agent mirrors. This doesn't mean copy-pasting the entire Claude Code system prompt — it means the provider-specific prompts should include the key behavioral instructions from each reference agent (tool use patterns, output formatting, safety rules) rather than the current short hints.

Total estimated effort: ~12–16 hours of implementation, plus testing.

---

## Implementation

### Phase 1: Fix the 4 Failing Tests (~30%)

**Hard rule:** Phase 2 does not begin until `npm test` is green.

**Files:** `src/server/run-manager.ts`, `src/runtime/garden-draft-service.ts`, `src/engine/engine.ts`, `src/handlers/fan-in.ts`, `test/integration/http-server.test.ts`, `test/server/gardens-draft.test.ts`, `test/server/pipeline-events.test.ts`, `test/integration/fan-in-llm.test.ts`

**Tasks:**
- [ ] **`http-server` fix:** Make `RunManager.getStatus()` derive `current_node` from the last `node_started` event emitted to the run's event log, not from a snapshot poll. This ensures the field is populated by the time any external client can observe the "running" state.
- [ ] **`gardens-draft` fix:** Add logging/tracing to `GardenDraftService.streamDraft()`. Identify where the async generator stalls. If the single-exit validation rejects the mock LLM's output, ensure `draft_error` is emitted instead of silently hanging. If the stream itself never starts, fix the mock wiring.
- [ ] **`pipeline-events` fix:** Trace the terminal event path in `engine.ts` to verify `pipeline_failed` is emitted after `run_error`. Check whether `pipeline_failed` emission is gated behind a condition that doesn't hold in the test fixture.
- [ ] **`fan-in-llm` fix:** Inspect the test's mock LLM setup. Verify the mock resolves with the expected response shape. Check whether the fan-in handler's `await` chain includes an unresolved promise. Fix the mock or the handler.
- [ ] **Run `npm test`.** All tests must pass. No regressions.

### Phase 2: Trivial Type and Interface Additions (~15%)

**Files:** `src/llm/types.ts`, `src/llm/streaming.ts`, `src/engine/events.ts`, `src/engine/engine.ts`

**Tasks:**
- [ ] **A4 (event naming):** Add PascalCase type aliases for all engine events alongside the existing snake_case names. Export a mapping so consumers can use either convention. Do not rename the existing events — add aliases only.
- [ ] **A6 (auto_status notes):** Change the auto_status note text from `"auto_status applied: defaulting to 'success' for node '${node.id}'"` to `"auto-status: handler completed without writing status"` to match the spec's wording.
- [ ] **U4 (Message.tool_call_id):** Add optional `tool_call_id?: string` field to the `Message` interface.
- [ ] **U5 (Message.text):** Add a `text` getter/method on `Message` that concatenates all text-type content parts.
- [ ] **U6 (ToolCallData.type):** Add `type: 'function' | 'custom'` field to `ToolCallData`, defaulting to `'function'`.
- [ ] **U7 (ToolResultData.image_data):** Add optional `image_data?: string` and `image_media_type?: string` fields to `ToolResultData`.
- [ ] **U8 (Usage.raw):** Add optional `raw?: unknown` field to `Usage` for raw provider usage data. Populate from each adapter's raw response.
- [ ] **U9 (StreamEvent.text_id):** Add optional `text_id?: string` field to text-related stream events.
- [ ] **U10 (PROVIDER_EVENT):** Add a `provider_event` stream event type for unrecognized provider events. Emit it from each adapter's stream parser instead of silently dropping unknown events.
- [ ] Add unit tests for `Message.text` concatenation and `PROVIDER_EVENT` emission.

### Phase 3: Tool Parameter and Profile Field Additions (~15%)

**Files:** `src/agent-loop/tools/read-file.ts`, `src/agent-loop/tools/glob.ts`, `src/agent-loop/tools/grep.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/types.ts`, `test/agent-loop/tool-registry.test.ts`

**Tasks:**
- [ ] **C9 (read_file parameter name):** Accept both `file_path` and `path` as parameter names. Keep `path` working for backward compatibility; add `file_path` as the primary name in the schema.
- [ ] **C10 (glob path parameter):** Add a `path` parameter to the glob tool schema for specifying the base directory. Default to cwd when omitted. Thread through to the execution environment's glob implementation.
- [ ] **C11 (grep parameter name):** Accept both `glob_filter` and `include` as parameter names. Keep `include` working; add `glob_filter` as the primary name in the schema.
- [ ] **C4 (ProviderProfile.context_window_size):** Add `context_window_size` field to `ProviderProfile`. Populate from `getModelInfo()` during profile construction.
- [ ] **C5 (ProviderProfile capability flags):** Add `supports_reasoning` and `supports_streaming` boolean fields to `ProviderProfile`. Populate from `getModelInfo()` during profile construction.
- [ ] **A2 (Context ReadWriteLock):** Add a `ContextLock` interface with `acquireRead()`, `acquireWrite()`, and `release()` methods. Provide a `NoOpContextLock` implementation (JS single-threaded model + context clones already provides the spec's safety guarantee). Wire into `ExecutionContext` so the interface exists for future use.
- [ ] Add tests for glob with explicit path, grep with `glob_filter`, and `ProviderProfile` field population.

### Phase 4: Adapter Lifecycle and Capability Methods (~15%)

**Files:** `src/llm/adapters/types.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `src/llm/client.ts`, `src/llm/catalog.ts`, `src/llm/types.ts`, `test/llm/adapters/*.test.ts`, `test/llm/client.test.ts`

**Tasks:**
- [ ] **U1 (Adapter lifecycle):** Add optional `initialize?(): Promise<void>` and `close?(): Promise<void>` methods to the `ProviderAdapter` interface. Add no-op defaults. Call `initialize()` on first use and `close()` on `UnifiedClient.close()`.
- [ ] **U2 (supports_tool_choice):** Add `supports_tool_choice(mode: ToolChoiceMode): boolean` to `ProviderAdapter`. Implement per adapter: OpenAI supports all modes, Anthropic supports auto/none/required/named, Gemini supports auto/none/required, OpenAI-Compatible supports auto/none.
- [ ] **U3 (Model catalog):** Update `src/llm/catalog.ts` with current-generation models: GPT-5.2 family (gpt-5.2, gpt-5.2-mini), Claude Opus 4.6 (claude-opus-4-6), Claude Sonnet 4.6 (claude-sonnet-4-6), Claude Haiku 4.5 (claude-haiku-4-5-20251001), Gemini 3.x models. Include context windows, cost estimates, and capability flags.
- [ ] **U11 (TimeoutConfig.per_step):** Add optional `per_step_ms?: number` to `TimeoutConfig` for per-LLM-call timeout in multi-step `generate()` operations. Thread through the tool execution loop.
- [ ] **U12 (generate() max_retries):** Add optional `max_retries?: number` to `GenerateRequest` for per-call retry configuration. When present, override the global retry middleware config for that call.
- [ ] Add tests for `supports_tool_choice()` per adapter, `close()` lifecycle, and per-call `max_retries`.

### Phase 5: System Prompt Parity and Gemini Web Tools (~15%)

**Files:** `src/agent-loop/provider-profiles.ts`, `src/agent-loop/tools/web-search.ts` (create), `src/agent-loop/tools/web-fetch.ts` (create), `test/agent-loop/provider-profiles.test.ts`

**Tasks:**
- [ ] **C12 (System prompts):** Expand each provider profile's system prompt to include the key behavioral instructions from the reference agent it mirrors:
  - **Anthropic profile:** Add Claude Code's core behavioral rules: prefer editing existing files over creating new, read before editing, use dedicated tools over shell equivalents, minimize unnecessary changes, security-conscious defaults.
  - **OpenAI profile:** Add Codex's core rules: apply_patch is the primary edit tool, prefer JSON output for structured data, sandbox-aware execution model.
  - **Gemini profile:** Add Gemini CLI's core rules: function calling is the primary interaction mode, batch reads with read_many_files, use list_dir for directory exploration.
  - Keep prompts under 4KB each. Focus on behavioral instructions that change how the model uses tools, not cosmetic personality differences.
- [ ] **C3 (Gemini web tools):** Create `web_search` and `web_fetch` tool implementations. `web_search` takes a query and returns search results via a configurable search backend (or returns a "not configured" message). `web_fetch` takes a URL and returns the page content. Register both in the Gemini profile only, gated by a `enable_web_tools` config flag (default false, since the spec marks these as optional).
- [ ] Add tests for prompt content (assert key behavioral phrases are present) and web tool registration (present in Gemini profile when enabled, absent when disabled).

### Phase 6: Compliance Report Refresh and Validation (~10%)

**Files:** `docs/compliance-report.md`, all test files

**Tasks:**
- [ ] Run `npm test` — all tests must pass, zero failures, zero timeouts.
- [ ] Run `npm run build` — zero TypeScript errors.
- [ ] For each of the 22 gaps, verify the implementation matches the spec requirement. Move each from GAPS to IMPLEMENTED with source code evidence.
- [ ] Update the Summary section: "Gaps identified: 0" (or document any deliberate deviations with justification).
- [ ] Do a final read of the three spec documents against the compliance report to catch any gaps that were missed in previous audits.
- [ ] Update the compliance report generation date.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/run-manager.ts` | Modify | Derive `current_node` from event log, not snapshot poll |
| `src/runtime/garden-draft-service.ts` | Modify | Fix draft streaming path; ensure `draft_error` emits on failure |
| `src/engine/engine.ts` | Modify | Fix `pipeline_failed` emission; update auto_status note text |
| `src/engine/events.ts` | Modify | Add PascalCase event aliases |
| `src/handlers/fan-in.ts` | Modify | Fix async lifecycle for LLM-based selection |
| `src/llm/types.ts` | Modify | Add `tool_call_id`, `text`, `raw`, `image_data`, `type`, `text_id` fields |
| `src/llm/streaming.ts` | Modify | Add `PROVIDER_EVENT` stream event type |
| `src/llm/adapters/types.ts` | Modify | Add `initialize()`, `close()`, `supports_tool_choice()` to adapter interface |
| `src/llm/adapters/anthropic.ts` | Modify | Implement adapter lifecycle and tool-choice support |
| `src/llm/adapters/openai.ts` | Modify | Implement adapter lifecycle and tool-choice support |
| `src/llm/adapters/gemini.ts` | Modify | Implement adapter lifecycle, tool-choice support, populate `Usage.raw` |
| `src/llm/adapters/openai-compatible.ts` | Modify | Implement adapter lifecycle and tool-choice support |
| `src/llm/client.ts` | Modify | Call adapter lifecycle methods; support per-call `max_retries` |
| `src/llm/catalog.ts` | Modify | Add GPT-5.2, Claude 4.5/4.6, Gemini 3.x models |
| `src/llm/timeouts.ts` | Modify | Add `per_step_ms` to `TimeoutConfig` |
| `src/engine/context.ts` | Modify | Add `ContextLock` interface and `NoOpContextLock` |
| `src/agent-loop/tools/read-file.ts` | Modify | Accept `file_path` as primary parameter name |
| `src/agent-loop/tools/glob.ts` | Modify | Add `path` parameter for base directory |
| `src/agent-loop/tools/grep.ts` | Modify | Accept `glob_filter` as primary parameter name |
| `src/agent-loop/provider-profiles.ts` | Modify | Expand system prompts; add capability fields |
| `src/agent-loop/tools/web-search.ts` | Create | Gemini web_search tool (optional, config-gated) |
| `src/agent-loop/tools/web-fetch.ts` | Create | Gemini web_fetch tool (optional, config-gated) |
| `docs/compliance-report.md` | Modify | Move all 22 gaps to IMPLEMENTED; update summary |
| `test/llm/adapters/*.test.ts` | Modify | Add lifecycle, tool-choice, and `Usage.raw` tests |
| `test/llm/client.test.ts` | Modify | Add per-call `max_retries` test |
| `test/agent-loop/tool-registry.test.ts` | Modify | Add glob path and grep glob_filter tests |
| `test/agent-loop/provider-profiles.test.ts` | Create | Assert prompt content and capability fields |
| `test/integration/http-server.test.ts` | Modify | Verify fix for `current_node` visibility |
| `test/server/gardens-draft.test.ts` | Modify | Verify fix for `draft_complete` emission |
| `test/server/pipeline-events.test.ts` | Modify | Verify fix for `pipeline_failed` emission |
| `test/integration/fan-in-llm.test.ts` | Modify | Verify fix for timeout |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts
- [ ] No test timeout values were increased to achieve green
- [ ] No existing tests regressed
- [ ] The 4 previously-failing tests all pass: http-server, gardens-draft, pipeline-events, fan-in-llm
- [ ] PascalCase event aliases exist alongside snake_case originals (A4)
- [ ] auto_status note text matches spec wording (A6)
- [ ] `ContextLock` interface exists with `NoOpContextLock` implementation (A2)
- [ ] `read_file` accepts `file_path` as primary parameter name (C9)
- [ ] `glob` tool accepts `path` parameter for base directory (C10)
- [ ] `grep` tool accepts `glob_filter` as primary parameter name (C11)
- [ ] Gemini profile registers `web_search` and `web_fetch` when `enable_web_tools` is true (C3)
- [ ] `ProviderProfile` exposes `context_window_size`, `supports_reasoning`, `supports_streaming` (C4, C5)
- [ ] Provider system prompts include key behavioral instructions from reference agents (C12)
- [ ] Adapters expose `initialize()`, `close()`, and `supports_tool_choice()` (U1, U2)
- [ ] Model catalog includes GPT-5.2, Claude 4.5/4.6, Gemini 3.x families (U3)
- [ ] `Message` has `tool_call_id` and `text` accessor (U4, U5)
- [ ] `ToolCallData` has `type` field (U6)
- [ ] `ToolResultData` supports `image_data` and `image_media_type` (U7)
- [ ] `Usage` has `raw` field populated by adapters (U8)
- [ ] Stream events include `text_id` field (U9)
- [ ] `PROVIDER_EVENT` stream event type exists and is emitted for unrecognized events (U10)
- [ ] `TimeoutConfig.per_step_ms` exists and is threaded through multi-step operations (U11)
- [ ] `GenerateRequest.max_retries` overrides global retry config per call (U12)
- [ ] `docs/compliance-report.md` lists zero open gaps
- [ ] Compliance report reflects the actual shipped behavior with source code evidence

---

## Drop Line

If this sprint runs long, cut in this order (last item cut first):

1. **Keep:** Phase 1 (green suite) — non-negotiable hard gate
2. **Keep:** Phase 6 (compliance report refresh) — validates the work
3. **Keep:** Phase 2 (trivial type additions) — 12 gaps closed in ~2 hours
4. **Keep:** Phase 3 (tool params and profile fields) — 6 gaps with medium user impact
5. **Defer first:** Phase 5 (C12 system prompts + C3 web tools) — highest effort, lowest urgency since both are marked optional/partial in the spec
6. **Defer second:** Phase 4 (adapter lifecycle + catalog) — U1/U2 are interface-shape compliance; U3 catalog can be refreshed independently; U11/U12 are niche

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Test fixes expose deeper bugs (not just the 4 known failures) | Medium | High | Phase 1 is a strict gate — run full suite before proceeding. If new failures appear, diagnose and fix before moving on. |
| Parameter renames (C9, C10, C11) break existing tool call transcripts | Medium | Medium | Accept both old and new names. Old name stays as alias. No breaking change for existing callers. |
| System prompt expansion (C12) changes LLM behavior in codergen nodes | Medium | Medium | Focus on tool-use behavioral rules, not personality. Keep prompts under 4KB. Run existing integration tests to verify no regressions. |
| Model catalog (U3) model IDs are wrong or outdated | Medium | Low | Use the model IDs from the knowledge cutoff. Catalog is a soft reference — wrong IDs cause a warning, not a crash. |
| `PROVIDER_EVENT` floods stream consumers with noise | Low | Medium | Only emit for truly unrecognized events. Known event types that don't map to a unified type are silently dropped (existing behavior). Only novel/unknown types get `PROVIDER_EVENT`. |
| `ContextLock` no-op implementation hides real concurrency bugs | Low | Low | Document that the no-op is correct for single-threaded JS. The interface exists for future environments (e.g., worker threads) where a real lock would be needed. |
| `web_search`/`web_fetch` tools need a real search backend | Low | Low | Gated behind `enable_web_tools` config (default false). When enabled without a configured backend, return a clear "search backend not configured" message. |
| Sprint scope is too large (22 gaps + 4 test fixes) | Medium | High | Drop line defined. Phases 5 and 4 can be deferred without violating the spirit of the sprint. The 12 trivial gaps in Phase 2 take ~2 hours total — they're not the risk. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Pinned spec snapshot via `docs/compliance-report.md` | Source of truth for gap definitions |
| Existing `UnifiedClient`, adapter, and tool infrastructure | All changes are additive to existing interfaces |
| Existing `ProviderProfile` and `ToolRegistry` | Profile fields and tool registration |
| Existing test infrastructure and mocks | All test fixes use existing patterns |
| `vitest` | Test runner |
| No new runtime packages | All changes are to existing modules or new files within existing patterns |
