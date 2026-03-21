# Sprint 030: Compliance Zero — Close Every Spec Gap, Ship a Correct Engine

## Overview

**Goal:** Eliminate all 33 compliance gaps from the compliance report. After this sprint, a fresh audit of the pinned attractor-spec.md, coding-agent-loop-spec.md, and unified-llm-spec.md finds zero unimplemented requirements — the hard gate in INTENT.md §5.1.

**Why this sprint, why now:**

1. **The engine silently produces wrong results.** Gaps 1–3 are not cosmetic — they break condition-based routing at runtime. A codergen node writes its output under `{node.id}.response` instead of `last_stage`/`last_response`. A wait.human node writes `{node.id}.selection` instead of `human.gate.selected`. Any pipeline using `condition="context.last_stage=plan"` or `condition="context.human.gate.selected=approve"` silently takes the wrong edge. This is the highest-severity class of bug: the system appears to work but produces wrong behavior. Every sprint that ships features on top of this foundation compounds the cost of fixing it later.

2. **The Anthropic adapter throws 400 errors in production-realistic conversations.** Gap 28 — no same-role message merging — means any conversation where steering injects a user message adjacent to another user message gets rejected by the Anthropic Messages API. This isn't a theoretical spec gap; it's a request failure on the most commonly used provider.

3. **Agent sessions misbehave under normal usage patterns.** `steer()` throws when the session is idle (Gap 8) instead of queuing for next submit. Steering messages use `developer` role (Gap 9) which some providers reject. Auth errors leave sessions in AWAITING_INPUT instead of CLOSED (Gap 18), letting callers submit into a permanently-broken session. spawn_agent silently drops 90% of child output (Gap 17: 2000 char limit vs spec's 20000).

4. **33 gaps is a lot but the work is mechanical and well-scoped.** Analysis of the 33 gaps: ~12 are key renames or field additions (< 30 minutes each), ~12 are small method additions or error classification fixes (1–2 hours), ~9 are medium (message merging, streaming lifecycle events, provider-specific prompts — 2–4 hours). No gap requires new architecture. Total estimated effort is 40–60 hours of focused implementation, well within a sprint if phased correctly.

5. **Batching is cheaper than spreading.** Gaps cluster by file. Gaps 1+2 both touch handler context contracts. Gaps 25+26+27 all fix error classification in adapters. Gaps 19+20 both extend streaming events. Fixing them together avoids re-reading the same spec sections and re-running the same test files across multiple sprints.

**Out of scope:**
- New features, CLI commands, or HTTP endpoints
- Web UI / Hive changes
- Seedbed, swarm analysis, or garden authoring enhancements
- Architecture refactoring beyond what's required to close gaps
- Performance optimization
- Shell completions, self-update, single-binary packaging

---

## Use Cases

1. **Condition-based routing works.** A pipeline with `condition="context.last_stage=plan"` matches after the `plan` codergen node because the handler now sets `last_stage` and `last_response` per spec §4.5. No silent mismatch.

2. **Human gate results are routable.** After a wait.human node resolves, downstream edges can use `condition="context.human.gate.selected=approve"` because the handler sets `human.gate.selected` and `human.gate.label` per spec §4.6.

3. **Anthropic calls survive multi-turn steering.** When steering injects a user-role message adjacent to another user message, the Anthropic adapter merges consecutive same-role messages before sending, preventing 400 errors.

4. **Streaming consumers detect content boundaries.** A consumer iterating `stream()` receives `text_start` → `content_delta`* → `text_end` and `tool_call_start` → `tool_call_delta`* → `tool_call_end`. The final `stream_end` event carries a complete `GenerateResponse` including usage.

5. **Error types are correct across providers.** OpenAI 403 → `AccessDeniedError`. Gemini context-window error → `ContextWindowError`. 503 from any provider → `OverloadedError`. Callers can match on error class for retry/display logic.

6. **Agent sessions handle steering and failure gracefully.** `steer()` queues in any state. Auth errors close the session. Spawn_agent output uses the standard 20000-char truncation, not a hardcoded 2000-char cutoff.

7. **Compliance audit returns zero gaps.** An agent reading the three spec documents and diffing against the codebase finds no unimplemented requirements.

---

## Architecture

### No new architecture — systematic contract corrections across three spec boundaries

Every change maps to a numbered gap. The work groups into four priority tiers based on runtime impact:

**Tier A — Runtime-breaking contract bugs (Gaps 1, 2, 3, 8, 9, 17, 18, 28)**
These cause wrong behavior or request failures under normal usage. Fix first, test immediately.

**Tier B — Missing error classification and response contract (Gaps 14, 19, 20, 21, 25, 26, 27, 29, 31)**
These cause incorrect error handling, incomplete streaming contracts, or wrong retry behavior. Fix second.

**Tier C — Interface compliance and enrichment (Gaps 4, 5, 6, 7, 10, 11, 12, 13, 15, 16, 22, 23, 24)**
These are spec deviations that don't cause failures but prevent full spec-contract consumers from working correctly. Fix third.

**Tier D — Naming and config alignment (Gaps 30, 32, 33)**
These are naming mismatches between spec and implementation. Mechanical but important for callers following the spec docs. Fix last.

### Key design decisions

1. **Gap 3 (parallel results) uses dual-read migration.** Store results under the new single `parallel.results` key. Fan-in reads both formats. This prevents breaking any existing gardens or checkpoints mid-flight.

2. **Gap 10 (provider-specific prompts) targets distinctiveness, not perfection.** Each profile gets a 500–1500 token prompt that captures the provider's native agent personality and tool usage patterns. These can iterate — the spec requires them to exist and be distinct, not to be token-perfect copies.

3. **Gap 19 (streaming lifecycle) adds events without breaking existing consumers.** New `text_start`/`text_end`/`tool_call_start`/`tool_call_end` events are additions to the union type. Existing code that only handles `content_delta` and `tool_call_delta` continues to work via exhaustive-switch fallthrough.

4. **Gap 33 (ModelInfo naming) is a breaking rename.** No known external consumers exist. Internal references are grep-and-replace. Do it now before the catalog API stabilizes.

### Files touched by tier

**Tier A:** `src/handlers/codergen.ts`, `src/handlers/wait-human.ts`, `src/handlers/parallel.ts`, `src/handlers/fan-in.ts`, `src/agent-loop/session.ts`, `src/agent-loop/subagent-manager.ts`, `src/llm/adapters/anthropic.ts`

**Tier B:** `src/agent-loop/tools/shell.ts`, `src/llm/streaming.ts`, `src/llm/stream-accumulator.ts`, `src/llm/types.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/errors.ts`, `src/llm/retry.ts`

**Tier C:** `src/interviewer/types.ts`, `src/interviewer/*.ts` (5 implementations), `src/checkpoint/types.ts`, `src/checkpoint/run-store.ts`, `src/engine/events.ts`, `src/engine/engine.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/tool-registry.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/environment-context.ts`, `src/agent-loop/project-instructions.ts`, `src/llm/client.ts`

**Tier D:** `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/catalog.ts`

---

## Implementation

### Phase 1: Runtime-Breaking Contract Bugs — Tier A (30% of effort)

**Gaps closed: 1, 2, 3, 8, 9, 17, 18, 28**

This phase fixes bugs that cause wrong behavior or request failures today. Each fix ships with a regression test before moving on.

**Tasks:**

- [ ] **Gap 1 — Codergen context keys.** In `src/handlers/codergen.ts`, add `last_stage: node.id` and `last_response: truncate(response_text, 200)` to `context_updates` per spec §4.5. Retain `{node.id}.response` as a supplementary key. Test: assert `context.get('last_stage')` returns the node ID after codergen completes.

- [ ] **Gap 2 — Wait.human context keys.** In `src/handlers/wait-human.ts`, set `human.gate.selected` and `human.gate.label` per spec §4.6. Remove the non-spec `{node.id}.selection` key. Test: assert both keys present in context after wait.human resolves.

- [ ] **Gap 3 — Parallel results single key.** In `src/handlers/parallel.ts`, serialize all branch results as JSON under `parallel.results` (single key). In `src/handlers/fan-in.ts`, read from `parallel.results` first, fall back to `parallel.results.*` keys for checkpoint compatibility. Test: fan-in correctly ranks branches from single-key format.

- [ ] **Gap 8 — steer() queues in any state.** In `src/agent-loop/session.ts`, remove the state guard that throws on steer(). Push to `pendingSteers` unconditionally. Test: steer() in IDLE state doesn't throw; message is delivered on next submit().

- [ ] **Gap 9 — Steering uses user role.** In `src/agent-loop/session.ts`, change steering message role from `developer` to `user` in the drain loop. Test: after steer + submit, conversation includes a user-role steering message.

- [ ] **Gap 17 — spawn_agent standard truncation.** In `src/agent-loop/subagent-manager.ts`, replace hardcoded 2000-char truncation with `truncateToolOutput` using the `spawn_agent` limit (20000 chars). Test: a 15000-char subagent result is preserved in full.

- [ ] **Gap 18 — Auth errors close session.** In `src/agent-loop/session.ts`, detect `AuthenticationError` or `AccessDeniedError` in the LLM error handler, transition to CLOSED, emit `agent_session_ended`. Test: session state is CLOSED after an auth error.

- [ ] **Gap 28 — Anthropic same-role message merging.** In `src/llm/adapters/anthropic.ts`, before constructing the API request, iterate messages and merge consecutive same-role entries by concatenating their content arrays. Idempotent: already-correct sequences are unchanged. Test: two consecutive user messages produce one merged message; alternating roles are unchanged.

- [ ] **Tests:** `test/handlers/codergen.test.ts`, `test/handlers/wait-human.test.ts`, `test/handlers/fan-in.test.ts`, `test/agent-loop/session.test.ts`, `test/agent-loop/subagent-manager.test.ts`, `test/llm/adapters/anthropic.test.ts`.

### Phase 2: Error Classification and Response Contract — Tier B (25% of effort)

**Gaps closed: 14, 19, 20, 21, 25, 26, 27, 29, 31**

**Tasks:**

- [ ] **Gap 14 — Shell timeout message.** In `src/agent-loop/tools/shell.ts`, when `timed_out` is true, append: `[ERROR: Command timed out after {timeout_ms}ms. Partial output is shown above. You can retry with a longer timeout using the timeout_ms parameter.]` Test: timed-out command output ends with the timeout message.

- [ ] **Gap 19 — Streaming lifecycle events.** In `src/llm/streaming.ts`, add `text_start`, `text_end`, `tool_call_start`, `tool_call_end` to StreamEventType. Update all three adapter stream parsers to emit these at content boundaries. Test: streaming a response with text + tool call produces the full start/delta/end sequence.

- [ ] **Gap 20 — Complete stream_end event.** Extend `StreamEndEvent` to carry the fully assembled `GenerateResponse`. Update `StreamAccumulator` to build and emit this. Test: `stream_end` event contains usage, stop_reason, and complete message.

- [ ] **Gap 21 — Usage.total_tokens.** Add `total_tokens: number` to `Usage` in `src/llm/types.ts`. Compute as `input_tokens + output_tokens` at all construction sites (adapters, accumulator). Test: `total_tokens` equals sum of input + output.

- [ ] **Gap 25 — OpenAI 403/404 errors.** In `src/llm/adapters/openai.ts` `classifyError()`, add 403 → `AccessDeniedError` and 404 → `NotFoundError`. Test: HTTP 403 from OpenAI throws `AccessDeniedError`.

- [ ] **Gap 26 — Gemini 401 vs 403.** In `src/llm/adapters/gemini.ts`, split: 401 → `AuthenticationError`, 403 → `AccessDeniedError`. Test: HTTP 403 from Gemini throws `AccessDeniedError`, not `AuthenticationError`.

- [ ] **Gap 27 — ContextWindowError in OpenAI/Gemini.** Detect context-length errors by message pattern (`"maximum context length"` for OpenAI, `"exceeds the maximum"` for Gemini) and throw `ContextWindowError`. Test: context-length error message produces `ContextWindowError`.

- [ ] **Gap 29 — LLMError fields.** Add `error_code?: string` and `raw?: Record<string, unknown>` to `LLMError` in `src/llm/errors.ts`. Update adapter error construction to pass provider error codes and raw bodies. Test: caught error has `error_code` and `raw` populated.

- [ ] **Gap 31 — Retry defaults.** In `src/llm/retry.ts`, change `max_retries` 3 → 2, `base_delay_ms` 200 → 1000, per spec §6.6. Test: retry middleware retries exactly twice with ~1s initial delay.

- [ ] **Tests:** `test/agent-loop/tools/shell.test.ts`, `test/llm/stream-accumulator.test.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/gemini.test.ts`, `test/llm/errors.test.ts`, `test/llm/retry.test.ts`.

### Phase 3: Interface Compliance and Enrichment — Tier C (30% of effort)

**Gaps closed: 4, 5, 6, 7, 10, 11, 12, 13, 15, 16, 22, 23, 24**

This is the largest phase by gap count but most items are additive (new fields, new methods, new event types) rather than behavioral changes.

**Tasks:**

- [ ] **Gap 4 — Answer model enrichment.** In `src/interviewer/types.ts`, add `AnswerValue` enum (YES, NO, SKIPPED, TIMEOUT), `selected_option`, and `text` fields. Update all 5 interviewer implementations. QueueInterviewer's exhausted response uses `AnswerValue.SKIPPED`.

- [ ] **Gap 5 — Checkpoint logs field.** Add `logs: string[]` to Cocoon in `src/checkpoint/types.ts`. Populate with log file paths as nodes complete in `src/checkpoint/run-store.ts`.

- [ ] **Gap 6 — Event payload fields.** Add `artifact_count: number` to `RunCompletedEvent`, `index: number` to `NodeStartedEvent` in `src/engine/events.ts`. Populate in engine.

- [ ] **Gap 7 — AgentSession emits session_started.** In `src/agent-loop/session.ts`, emit `agent_session_started` at the top of `submit()`. Keep the handler-level emission in codergen for engine listeners.

- [ ] **Gap 10 — Provider-specific system prompts.** In `src/agent-loop/provider-profiles.ts`, replace the shared generic prompt with three distinct prompts:
  - **Anthropic:** Emphasize edit_file, direct manipulation, concise output. Mirror Claude Code's instruction style.
  - **OpenAI:** Emphasize apply_patch (v4a), patch-based editing, sandbox model. Mirror Codex's instruction style.
  - **Gemini:** Emphasize read_many_files/list_dir, broad exploration, sequential execution. Mirror Gemini CLI's style.
  - Target 500–1500 tokens each. Distinct, not identical copies.

- [ ] **Gap 11 — ProviderProfile.providerOptions().** Add `providerOptions(): Record<string, unknown>` to the interface. Anthropic returns beta headers, OpenAI returns reasoning config, Gemini returns safety settings. Wire into session LLM calls.

- [ ] **Gap 12 — ToolRegistry.unregister().** Add `unregister(name: string): boolean` to `src/agent-loop/tool-registry.ts`.

- [ ] **Gap 13 — ExecutionEnvironment glob/grep.** Replace throw stubs in `src/agent-loop/execution-environment.ts` with working implementations. Use `fast-glob` (already a dependency) for glob. Use `execa` + system `grep` (or Node.js regex scan) for grep.

- [ ] **Gap 15 — Auto-discover project instructions.** In `src/agent-loop/session.ts`, call `discoverInstructions()` during `submit()` when no instructions have been provided. Cache for session lifetime.

- [ ] **Gap 16 — Git context recent commits.** Extend `buildGitSnapshot()` in `src/agent-loop/environment-context.ts` to capture last 5 commit messages (short format: `git log --oneline -5`).

- [ ] **Gap 22 — Message.name field.** Add `name?: string` to Message in `src/llm/types.ts`. Thread through OpenAI adapter (uses natively), others ignore.

- [ ] **Gap 23 — max_tool_rounds on GenerateRequest.** Add `max_tool_rounds?: number` (default 1) to `GenerateRequest` in `src/llm/types.ts`. Use in `src/llm/client.ts` tool loop instead of `GenerateOptions.maxIterations`. Keep options path as deprecated alias.

- [ ] **Gap 24 — Reject prompt + messages.** In `normalizePromptRequest()` in `src/llm/client.ts`, throw `InvalidRequestError` when both are provided.

- [ ] **Tests:** `test/interviewer/interviewer.test.ts`, `test/checkpoint/run-store.test.ts`, `test/engine/engine.test.ts`, `test/agent-loop/session.test.ts`, `test/agent-loop/tool-registry.test.ts`, `test/agent-loop/environment-context.test.ts`, `test/llm/types.test.ts`, `test/llm/client.test.ts`.

### Phase 4: Naming and Config Alignment — Tier D (5% of effort)

**Gaps closed: 30, 32, 33**

**Tasks:**

- [ ] **Gap 30 — Prompt caching disable key.** In `src/llm/adapters/anthropic.ts`, check `provider_options.anthropic.auto_cache` per spec, not `cache_control`. Accept both keys for transition.

- [ ] **Gap 32 — OpenAI stop_sequences.** Map `request.stop_sequences` to the Responses API `stop` parameter in `src/llm/adapters/openai.ts`.

- [ ] **Gap 33 — ModelInfo capability naming.** Rename in `src/llm/catalog.ts`: `capabilities.tool_calling` → `supports_tools`, `capabilities.vision` → `supports_vision`, `capabilities.thinking` → `supports_reasoning`, `cost.input_per_million` → `input_cost_per_million`, `cost.output_per_million` → `output_cost_per_million`. Grep-and-replace all internal references.

- [ ] **Tests:** `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/openai.test.ts`, catalog assertions.

### Phase 5: Verification (10% of effort)

- [ ] `npm run build` — zero type errors.
- [ ] `npm test` — zero failures.
- [ ] Audit each of the 33 gaps against updated source, confirming every fix.
- [ ] Update `docs/compliance-report.md`: move all 33 items from GAPS to IMPLEMENTED with updated references.
- [ ] Run `nectar run .nectar/gardens/compliance-loop.dot` end-to-end — no regression.

---

## Files Summary

| File | Action | Gaps Addressed |
|------|--------|----------------|
| `src/handlers/codergen.ts` | Modify | 1 |
| `src/handlers/wait-human.ts` | Modify | 2 |
| `src/handlers/parallel.ts` | Modify | 3 |
| `src/handlers/fan-in.ts` | Modify | 3 |
| `src/interviewer/types.ts` | Modify | 4 |
| `src/interviewer/auto-approve.ts` | Modify | 4 |
| `src/interviewer/callback.ts` | Modify | 4 |
| `src/interviewer/console.ts` | Modify | 4 |
| `src/interviewer/queue.ts` | Modify | 4 |
| `src/interviewer/recording.ts` | Modify | 4 |
| `src/checkpoint/types.ts` | Modify | 5 |
| `src/checkpoint/run-store.ts` | Modify | 5 |
| `src/engine/events.ts` | Modify | 6 |
| `src/engine/engine.ts` | Modify | 6 |
| `src/agent-loop/session.ts` | Modify | 7, 8, 9, 15, 18 |
| `src/agent-loop/provider-profiles.ts` | Modify | 10, 11 |
| `src/agent-loop/tool-registry.ts` | Modify | 12 |
| `src/agent-loop/execution-environment.ts` | Modify | 13 |
| `src/agent-loop/tools/shell.ts` | Modify | 14 |
| `src/agent-loop/environment-context.ts` | Modify | 16 |
| `src/agent-loop/subagent-manager.ts` | Modify | 17 |
| `src/agent-loop/project-instructions.ts` | Modify | 15 |
| `src/llm/streaming.ts` | Modify | 19, 20 |
| `src/llm/types.ts` | Modify | 21, 22, 23 |
| `src/llm/client.ts` | Modify | 23, 24 |
| `src/llm/stream-accumulator.ts` | Modify | 20 |
| `src/llm/adapters/openai.ts` | Modify | 25, 27, 32 |
| `src/llm/adapters/gemini.ts` | Modify | 26, 27 |
| `src/llm/adapters/anthropic.ts` | Modify | 28, 30 |
| `src/llm/errors.ts` | Modify | 29 |
| `src/llm/retry.ts` | Modify | 31 |
| `src/llm/catalog.ts` | Modify | 33 |
| `docs/compliance-report.md` | Modify | All |
| `test/handlers/codergen.test.ts` | Modify | 1 |
| `test/handlers/wait-human.test.ts` | Modify | 2 |
| `test/handlers/fan-in.test.ts` | Modify | 3 |
| `test/interviewer/interviewer.test.ts` | Modify | 4 |
| `test/checkpoint/run-store.test.ts` | Modify | 5 |
| `test/engine/engine.test.ts` | Modify | 6 |
| `test/agent-loop/session.test.ts` | Modify | 7, 8, 9, 15, 18 |
| `test/agent-loop/tool-registry.test.ts` | Modify | 12 |
| `test/agent-loop/tools/shell.test.ts` | Modify | 14 |
| `test/agent-loop/subagent-manager.test.ts` | Modify | 17 |
| `test/agent-loop/environment-context.test.ts` | Modify | 16 |
| `test/llm/stream-accumulator.test.ts` | Modify | 19, 20 |
| `test/llm/types.test.ts` | Modify | 21, 22 |
| `test/llm/client.test.ts` | Modify | 23, 24 |
| `test/llm/adapters/openai.test.ts` | Modify | 25, 27, 32 |
| `test/llm/adapters/gemini.test.ts` | Modify | 26, 27 |
| `test/llm/adapters/anthropic.test.ts` | Modify | 28, 30 |
| `test/llm/errors.test.ts` | Modify | 29 |
| `test/llm/retry.test.ts` | Modify | 31 |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero type errors
- [ ] `npm test` passes with zero failures
- [ ] **Gap 1:** `codergen` handler sets `last_stage` and `last_response` context keys per spec §4.5
- [ ] **Gap 2:** `wait.human` handler sets `human.gate.selected` and `human.gate.label` per spec §4.6
- [ ] **Gap 3:** Parallel results stored under single `parallel.results` key; fan-in reads both formats
- [ ] **Gap 4:** Answer model includes `AnswerValue` enum, `selected_option`, and `text` fields
- [ ] **Gap 5:** Cocoon type includes `logs: string[]` field, populated on checkpoint save
- [ ] **Gap 6:** `RunCompletedEvent` has `artifact_count`; `NodeStartedEvent` has `index`
- [ ] **Gap 7:** `AgentSession` emits `agent_session_started` in `submit()`
- [ ] **Gap 8:** `steer()` queues in any state, never throws
- [ ] **Gap 9:** Steering messages use `user` role
- [ ] **Gap 10:** Each provider profile has a distinct, provider-flavored system prompt (500–1500 tokens)
- [ ] **Gap 11:** `ProviderProfile` has `providerOptions()` method, wired into LLM calls
- [ ] **Gap 12:** `ToolRegistry.unregister(name)` implemented and tested
- [ ] **Gap 13:** `LocalExecutionEnvironment.glob()` and `.grep()` return results
- [ ] **Gap 14:** Shell tool appends `[ERROR: Command timed out...]` on timeout
- [ ] **Gap 15:** `submit()` auto-discovers project instructions when none provided
- [ ] **Gap 16:** `buildGitSnapshot()` includes last 5 commit messages
- [ ] **Gap 17:** `spawn_agent` uses standard truncation pipeline with 20000-char limit
- [ ] **Gap 18:** Auth/access errors transition session to CLOSED
- [ ] **Gap 19:** Stream events include `text_start`, `text_end`, `tool_call_start`, `tool_call_end`
- [ ] **Gap 20:** `stream_end` event carries complete `GenerateResponse` with usage
- [ ] **Gap 21:** `Usage` has `total_tokens` field
- [ ] **Gap 22:** `Message` has optional `name` field
- [ ] **Gap 23:** `GenerateRequest` has `max_tool_rounds` (default 1), used by tool loop
- [ ] **Gap 24:** `generate()` throws when both `prompt` and `messages` provided
- [ ] **Gap 25:** OpenAI 403 → `AccessDeniedError`, 404 → `NotFoundError`
- [ ] **Gap 26:** Gemini 401 → `AuthenticationError`, 403 → `AccessDeniedError`
- [ ] **Gap 27:** OpenAI and Gemini throw `ContextWindowError` for context-length errors
- [ ] **Gap 28:** Anthropic adapter merges consecutive same-role messages
- [ ] **Gap 29:** `LLMError` has `error_code` and `raw` fields
- [ ] **Gap 30:** Anthropic cache disable checks `auto_cache` per spec
- [ ] **Gap 31:** Retry defaults: `max_retries=2`, `base_delay_ms=1000`
- [ ] **Gap 32:** OpenAI adapter maps `stop_sequences` to Responses API
- [ ] **Gap 33:** ModelInfo uses spec names: `supports_tools`, `supports_vision`, `supports_reasoning`, `input_cost_per_million`, `output_cost_per_million`
- [ ] `docs/compliance-report.md` GAPS section is empty
- [ ] `nectar run .nectar/gardens/compliance-loop.dot` completes without regression

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Gap 3 (parallel results format change) breaks in-flight checkpoints | Medium | High | Fan-in reads both formats. Integration tests cover both paths. Old checkpoints resume correctly. |
| Gap 33 (ModelInfo rename) breaks internal callers | Medium | Medium | No external consumers. Grep-and-replace all internal references. TypeScript compiler catches missed sites. |
| Gap 19 (streaming lifecycle events) requires coordinated changes in 3 adapters | High | Medium | Each adapter is independent. Fix and test sequentially: Anthropic → OpenAI → Gemini. |
| Gap 10 (provider-specific prompts) is subjective | Medium | Low | Prompts need to be distinct and provider-appropriate, not perfect. Can iterate in future sprints. |
| Gap 28 (same-role merging) alters already-correct requests | Low | Low | Merging is idempotent — single messages pass through unchanged. |
| Gap 13 (glob/grep on execution environment) may have edge cases | Medium | Low | Use `fast-glob` (already a dep) and simple regex scan. Match existing tool behavior. |
| Changing retry defaults (Gap 31) alters timing for existing consumers | Low | Low | Spec is authoritative. 2 retries / 1s base is actually more conservative than 3 / 200ms. |
| Scope: 33 fixes is ambitious for one sprint | Medium | Medium | Most are mechanical. Tier-based phasing ensures highest-impact fixes ship first even if the sprint runs long. Phase 1 alone eliminates the runtime-breaking bugs. |

---

## Dependencies

No new external dependencies. All fixes use what's already installed:

| Package | Used For |
|---------|----------|
| `fast-glob` | Gap 13 — glob implementation on ExecutionEnvironment |
| `execa` | Gap 13 — grep fallback, Gap 16 — git log |
| `ajv` | Existing schema validation (unchanged) |
| `vitest` | All test updates |

---

## Execution Strategy

**Phases 1 and 2 are sequential** — Phase 1 fixes runtime-breaking bugs and must be verified green before Phase 2 begins. This ensures the most critical fixes land first.

**Phases 3 and 4 can be parallelized** — They touch disjoint files. Assign to separate agents or sessions.

**Phase 5 runs last** — Full verification pass after all code changes are merged.

For maximum throughput with two agents: Agent A takes Phases 1 + 2 (runtime fixes + error handling), Agent B takes Phases 3 + 4 (interface enrichment + naming). Both converge for Phase 5.
