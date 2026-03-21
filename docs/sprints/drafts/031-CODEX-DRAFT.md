# Sprint NEXT: Compliance Closure — Human Gates, Agent Sessions, and Unified LLM Contracts

## Overview

**Goal:** Close the 15 remaining gaps in `docs/compliance-report.md` and satisfy the hard gate in `docs/INTENT.md` §5: an agent comparing Nectar to the pinned attractor snapshot should find zero unimplemented requirements.

**Opinionated call:** the next sprint should not chase new CLI or Hive features. The remaining gaps sit on runtime contracts that every feature depends on: human-gate answers, cocoon fidelity, agent-session context, and the unified LLM API. Shipping more surface area before fixing those seams just bakes drift deeper into the system.

**Why this sprint, why now:**

1. **The last Attractor gaps are on the human/resume boundary.** INTENT is explicit that interruption is normal, cocoons must be self-describing, and human gates must be routable from CLI/UI/API. The current answer model, cocoon schema, and event payloads are still thinner than the spec.

2. **Agent sessions are still underspecified at the moment they matter most.** Direct `AgentSession` consumers do not get `agent_session_started`, sessions do not auto-discover project instructions, git context is too shallow, and `ExecutionEnvironment.glob()` / `grep()` still throw. That hurts every codergen run and any future embedded-agent usage.

3. **The unified LLM layer still has public contract drift.** `stream_end` is not guaranteed to carry a full response, `Message.name` is missing, `max_tool_rounds` is not on `GenerateRequest`, prompt validation is too permissive, and the model catalog does not expose spec-shaped metadata. Those are library correctness issues, not polish issues.

4. **This fits in one sprint because the work is additive contract completion, not new architecture.** The remaining gaps cluster by file and can be closed with targeted edits plus regression tests. Splitting them across multiple sprints would mostly create extra migration windows and duplicate verification work.

**Scope:** all 15 gaps currently listed in `docs/compliance-report.md`.

- Attractor gaps: 1–3
- Coding Agent Loop gaps: 4–9
- Unified LLM gaps: 10–15

**Out of scope:**

- New CLI commands, UI views, or HTTP endpoints
- Seedbed feature expansion
- Garden authoring improvements
- Release automation, packaging, or performance work
- Refactors that are not directly required for compliance closure

---

## Use Cases

1. **A browser human gate captures a real answer, not just a label.** The Hive posts either a structured choice answer or freeform text. Nectar persists the full answer shape, emits the right interview events, and `wait.human` still routes deterministically when an option was selected.

2. **A resumed run is inspectable without spelunking the filesystem.** The cocoon includes the log files produced so far, `node_started` events expose a stable ordinal index, and the final `run_completed` event reports artifact count for UI timelines and CLI summaries.

3. **A direct `AgentSession` consumer gets the same behavior codergen gets.** Calling `submit()` on an `AgentSession` emits `agent_session_started`, auto-loads `AGENTS.md` / provider-specific instructions, includes recent commit messages in git context, and can rely on `glob()` / `grep()` in the execution environment.

4. **Provider profiles can actually shape provider-specific requests.** Anthropic profiles can inject beta settings, Gemini profiles can set default safety configuration, and the session loop has a real seam for provider-specific request options instead of overloading unrelated fields.

5. **A unified LLM caller can write against the spec and get the spec.** `stream()` always ends with a full `GenerateResponse`, `GenerateRequest.max_tool_rounds` exists and is honored, `generate()` rejects `prompt + messages`, and `Message.name` survives through the stack.

6. **Catalog consumers can depend on stable spec names.** UI, CLI, and runtime code can read spec-shaped model capability and cost fields without reverse-engineering the current nested `capabilities` / `cost` structure.

---

## Architecture

### This is a contract-correction sprint, not a feature sprint

No new subsystem is needed. The work is concentrated at three boundaries:

1. **Attractor boundary:** interviewer model, wait-human handling, cocoon schema, engine event payloads.
2. **Agent-loop boundary:** session lifecycle events, provider profile contract, execution environment completeness, project/gitrepo context assembly.
3. **Unified LLM boundary:** request/response types, stream finalization, provider-option naming, catalog metadata shape.

### Key design decisions

1. **Canonical answer shape with compatibility normalization**

   The interviewer stack should adopt the spec-rich answer model as the canonical in-memory and persisted shape. Legacy label-only inputs are still accepted at the boundary and normalized immediately. That means:

   - `selected_label` remains an input compatibility path, not the authoritative stored shape.
   - FREEFORM answers carry text explicitly instead of being squeezed through a fake choice label.
   - `wait.human` keeps routing by normalized selected option when one exists.

2. **`AgentSession` becomes the source of truth for session lifecycle**

   `agent_session_started` should be emitted by `AgentSession` itself exactly once per session. `CodergenHandler` should stop synthesizing that event and instead bridge the real session event into run-scoped engine events. This removes duplicate-lifecycle risk and fixes direct-consumer behavior.

3. **Search behavior should live below the tool layer**

   `ExecutionEnvironment.glob()` and `.grep()` should not shell out to the tool registry or throw. Extract the filesystem search logic behind a shared helper used by:

   - `LocalExecutionEnvironment.glob()`
   - `LocalExecutionEnvironment.grep()`
   - the `glob` tool
   - the `grep` tool

   This keeps one ignore-ordering/matching implementation instead of two drifting ones.

4. **`submit()` becomes the spec-complete entrypoint**

   The normal `submit()` path should auto-discover project instructions when no explicit instructions were provided. `processInput(prompt, instructions)` remains as an explicit override path, not the only way to get project docs into the prompt.

5. **`stream_end` must always be final and self-sufficient**

   The final stream event should always carry a complete `GenerateResponse`. `StreamAccumulator` should be the canonical assembly point so downstream consumers can trust `.response()` and `stream_end` to agree.

6. **Public API compliance beats internal convenience**

   `GenerateRequest.max_tool_rounds` becomes the canonical public field. Existing `GenerateOptions.maxIterations` can remain as a deprecated compatibility alias for one sprint, but the request type and default behavior should match the spec.

7. **Model catalog migration should not be a flag day**

   Expose spec-named flat fields on `ModelInfo` and convert internal callers to them in this sprint. Keep the current nested `capabilities` / `cost` shape as derived compatibility aliases for one sprint so this cleanup does not become a breaking migration exercise.

8. **Cocoon `logs` should be portable**

   Store log paths as run-relative paths, not absolute machine-specific paths. That keeps cocoons readable, stable under workspace moves, and consistent with the file-system-first contract in `INTENT.md`.

### Execution order

The sprint should execute in this order:

1. **Human gates and cocoon/event truthfulness**
2. **Agent session and execution environment completion**
3. **Unified LLM public contract fixes**
4. **Model catalog alignment and compliance sweep**
5. **Full verification and compliance report refresh**

That order closes the most user-visible/runtime-visible issues first while keeping the final compliance sweep small.

---

## Implementation Phases

### Phase 1: Human Gates, Cocoons, and Event Truthfulness (25%)

**Gaps closed:** 1, 2, 3

**Tasks:**

- [ ] Replace the flat interviewer `Answer` shape in `src/interviewer/types.ts` with the spec-rich canonical answer model, including the spec answer-value enum and explicit option/text fields.
- [ ] Update all interviewer implementations in `src/interviewer/*.ts` so they can produce canonical answers consistently for:
  - choice selection
  - default-choice timeout
  - queue exhaustion
  - freeform text input
- [ ] Teach `src/handlers/wait-human.ts` to normalize canonical answers into:
  - routing (`preferred_label`, `suggested_next`)
  - context updates (`human.gate.selected`, `human.gate.label`)
  - interview completion/timeout events
- [ ] Update the HTTP-backed human-gate flow in:
  - `src/server/question-store.ts`
  - `src/server/http-interviewer.ts`
  - `src/server/run-manager.ts`
  - `src/server/routes/pipelines.ts`
  - `src/server/types.ts`
  so the API can accept both the current label-only payloads and the new canonical answer payloads.
- [ ] Add `logs: string[]` to `Cocoon` in `src/checkpoint/types.ts` and populate it from `src/checkpoint/run-store.ts` using run-relative paths.
- [ ] Add `index` to `NodeStartedEvent` and make it the 1-based execution ordinal for node-start events, including retries.
- [ ] Add `artifact_count` to `RunCompletedEvent` and compute it from tracked artifact state, not a late filesystem walk.
- [ ] Update focused tests:
  - `test/interviewer/interviewer.test.ts`
  - `test/interviewer/ask-multiple.test.ts`
  - `test/handlers/wait-human.test.ts`
  - `test/server/http-interviewer.test.ts`
  - `test/checkpoint/run-store.test.ts`
  - `test/checkpoint/cocoon.test.ts`
  - `test/engine/interview-events.test.ts`
  - `test/engine/engine.test.ts`

**Phase gate:**

- [ ] `npx vitest test/interviewer/interviewer.test.ts test/interviewer/ask-multiple.test.ts test/handlers/wait-human.test.ts test/server/http-interviewer.test.ts test/checkpoint/run-store.test.ts test/checkpoint/cocoon.test.ts test/engine/interview-events.test.ts test/engine/engine.test.ts`

### Phase 2: Agent Session and Execution Environment Completion (35%)

**Gaps closed:** 4, 5, 6, 7, 8, 9

**Tasks:**

- [ ] Emit `agent_session_started` from `AgentSession` itself exactly once per session.
- [ ] Remove the synthetic session-start emission from `src/handlers/codergen.ts` so codergen bridges the real session event instead of duplicating it.
- [ ] Add `providerOptions()` to `ProviderProfile` in `src/agent-loop/provider-profiles.ts` and wire `src/agent-loop/session.ts` to merge profile-provided request options into `UnifiedClient` calls.
- [ ] Keep provider prompts and provider options separate:
  - `systemPrompt()` is prompt text
  - `providerOptions()` is request-shaping metadata
- [ ] Add `ToolRegistry.unregister(name)` in `src/agent-loop/tool-registry.ts` and cover both happy-path and missing-tool behavior.
- [ ] Extract shared search helpers into a new `src/agent-loop/search.ts`.
- [ ] Reuse the new search helpers from:
  - `src/agent-loop/execution-environment.ts`
  - `src/agent-loop/tools/glob.ts`
  - `src/agent-loop/tools/grep.ts`
- [ ] Make `LocalExecutionEnvironment.glob()` and `.grep()` real implementations instead of throw stubs.
- [ ] Auto-discover project instructions during `submit()` in `src/agent-loop/session.ts` when no explicit instructions were provided, and cache the discovered result for the session lifetime.
- [ ] Extend `buildGitSnapshot()` in `src/agent-loop/environment-context.ts` to include the last 5 commit messages in addition to branch and dirty-file summary.
- [ ] Keep the existing git timeout behavior and fail open if git is unavailable.
- [ ] Update focused tests:
  - `test/agent-loop/session.test.ts`
  - `test/agent-loop/events.test.ts`
  - `test/agent-loop/provider-profiles.test.ts`
  - `test/agent-loop/tool-registry.test.ts`
  - `test/agent-loop/execution-environment-scoped.test.ts`
  - `test/agent-loop/project-instructions.test.ts`
  - `test/agent-loop/environment-context.test.ts`
  - `test/agent-loop/tools/glob.test.ts`
  - `test/agent-loop/tools/grep.test.ts`
  - `test/handlers/codergen.test.ts`

**Phase gate:**

- [ ] `npx vitest test/agent-loop/session.test.ts test/agent-loop/events.test.ts test/agent-loop/provider-profiles.test.ts test/agent-loop/tool-registry.test.ts test/agent-loop/execution-environment-scoped.test.ts test/agent-loop/project-instructions.test.ts test/agent-loop/environment-context.test.ts test/agent-loop/tools/glob.test.ts test/agent-loop/tools/grep.test.ts test/handlers/codergen.test.ts`

### Phase 3: Unified LLM Public Contract Alignment (30%)

**Gaps closed:** 10, 11, 12, 13, 14

**Tasks:**

- [ ] Make `stream_end` in `src/llm/streaming.ts` require a full `GenerateResponse`.
- [ ] Update `src/llm/stream-accumulator.ts` so final response assembly is deterministic and `stream_end` and `.response()` cannot disagree.
- [ ] Add `name?: string` to `Message` in `src/llm/types.ts` and thread it through message constructors and provider adapters.
- [ ] Add `max_tool_rounds?: number` to `GenerateRequest` in `src/llm/types.ts` with spec default `1`.
- [ ] Update `src/llm/client.ts` so:
  - `GenerateRequest.max_tool_rounds` is authoritative
  - deprecated `GenerateOptions.maxIterations` remains an alias for one sprint
  - `normalizePromptRequest()` throws if both `prompt` and `messages` are provided
- [ ] Update `src/llm/adapters/anthropic.ts` to support `provider_options.anthropic.auto_cache = false`.
- [ ] Keep accepting `provider_options.anthropic.cache_control = false` for one sprint as a compatibility alias.
- [ ] Update `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, and `src/llm/adapters/openai-compatible.ts` so the full stream contract and `Message.name` behavior are consistent across adapters.
- [ ] Update focused tests:
  - `test/llm/stream-accumulator.test.ts`
  - `test/llm/client.test.ts`
  - `test/llm/types.test.ts`
  - `test/llm/provider-options.test.ts`
  - `test/llm/anthropic-caching.test.ts`
  - `test/llm/adapters/anthropic.test.ts`
  - `test/llm/adapters/openai.test.ts`
  - `test/llm/adapters/gemini.test.ts`
  - `test/llm/openai-compatible.test.ts`

**Phase gate:**

- [ ] `npx vitest test/llm/stream-accumulator.test.ts test/llm/client.test.ts test/llm/types.test.ts test/llm/provider-options.test.ts test/llm/anthropic-caching.test.ts test/llm/adapters/anthropic.test.ts test/llm/adapters/openai.test.ts test/llm/adapters/gemini.test.ts test/llm/openai-compatible.test.ts`

### Phase 4: Model Catalog Alignment and Compatibility Sweep (10%)

**Gaps closed:** 15

**Tasks:**

- [ ] Flatten `ModelInfo` in `src/llm/catalog.ts` to expose spec-named capability fields and spec-named cost fields.
- [ ] Keep the current nested `capabilities` / `cost` structure as derived compatibility aliases for this sprint only.
- [ ] Grep internal callers and convert them to the spec-named flat fields so the compatibility alias is not carrying active internal dependencies after the sprint.
- [ ] Update `test/llm/catalog.test.ts` to verify both spec shape and compatibility behavior.

**Phase gate:**

- [ ] `npx vitest test/llm/catalog.test.ts`

### Phase 5: Verification and Compliance Report Refresh (10%)

**Tasks:**

- [ ] `npm run build`
- [ ] `npm test`
- [ ] Update `docs/compliance-report.md` so all 15 gaps move from `GAPS` to `IMPLEMENTED` with accurate file references.
- [ ] Manually diff the updated codebase against the gap list and confirm nothing remains as “known drift.”
- [ ] Do not close the sprint until the compliance report shows zero open gaps.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/interviewer/types.ts` | Modify | Replace the flat answer struct with the canonical spec-rich answer model |
| `src/interviewer/auto-approve.ts`, `src/interviewer/console.ts`, `src/interviewer/callback.ts`, `src/interviewer/queue.ts`, `src/interviewer/recording.ts` | Modify | Produce canonical answers for choice, timeout, queue, and freeform flows |
| `src/handlers/wait-human.ts` | Modify | Normalize richer answers into routing, context, and events |
| `src/server/question-store.ts`, `src/server/http-interviewer.ts`, `src/server/run-manager.ts`, `src/server/routes/pipelines.ts`, `src/server/types.ts` | Modify | Accept and persist canonical human-gate answers while staying backward-compatible with label-only clients |
| `src/checkpoint/types.ts`, `src/checkpoint/run-store.ts` | Modify | Add and populate cocoon `logs` |
| `src/engine/events.ts`, `src/engine/engine.ts` | Modify | Add `node_started.index` and `run_completed.artifact_count` |
| `src/agent-loop/session.ts` | Modify | Emit `agent_session_started`, auto-discover instructions, merge provider profile options, cache richer git context |
| `src/handlers/codergen.ts` | Modify | Stop synthesizing session-start events and bridge the real session lifecycle |
| `src/agent-loop/provider-profiles.ts` | Modify | Add `providerOptions()` and keep prompt vs request-shaping responsibilities separate |
| `src/agent-loop/tool-registry.ts` | Modify | Add `unregister(name)` |
| `src/agent-loop/search.ts` | Create | Shared ignore-aware search helpers reused by tools and execution environment |
| `src/agent-loop/execution-environment.ts` | Modify | Implement `glob()` and `grep()` against the shared search helpers |
| `src/agent-loop/tools/glob.ts`, `src/agent-loop/tools/grep.ts` | Modify | Reuse the shared search helpers so behavior stays aligned |
| `src/agent-loop/environment-context.ts` | Modify | Include recent commit messages in git snapshot output |
| `src/llm/streaming.ts`, `src/llm/stream-accumulator.ts` | Modify | Make `stream_end` final and self-sufficient |
| `src/llm/types.ts` | Modify | Add `Message.name` and `GenerateRequest.max_tool_rounds` |
| `src/llm/client.ts` | Modify | Honor `max_tool_rounds`, reject `prompt + messages`, and preserve the final stream contract |
| `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts` | Modify | Preserve `Message.name`, emit complete final stream data, and support the corrected provider-option contract |
| `src/llm/catalog.ts` | Modify | Expose spec-named model metadata with one-sprint compatibility aliases |
| `docs/compliance-report.md` | Modify | Record zero remaining gaps with updated references |
| `test/interviewer/*.test.ts`, `test/handlers/wait-human.test.ts`, `test/server/http-interviewer.test.ts` | Modify | Human-gate contract coverage |
| `test/checkpoint/*.test.ts`, `test/engine/interview-events.test.ts`, `test/engine/engine.test.ts` | Modify | Cocoon and engine event contract coverage |
| `test/agent-loop/session.test.ts`, `test/agent-loop/events.test.ts`, `test/agent-loop/provider-profiles.test.ts`, `test/agent-loop/tool-registry.test.ts`, `test/agent-loop/execution-environment-scoped.test.ts`, `test/agent-loop/project-instructions.test.ts`, `test/agent-loop/environment-context.test.ts`, `test/agent-loop/tools/glob.test.ts`, `test/agent-loop/tools/grep.test.ts`, `test/handlers/codergen.test.ts` | Modify | Agent-loop compliance coverage |
| `test/llm/stream-accumulator.test.ts`, `test/llm/client.test.ts`, `test/llm/types.test.ts`, `test/llm/provider-options.test.ts`, `test/llm/anthropic-caching.test.ts`, `test/llm/catalog.test.ts`, `test/llm/adapters/*.test.ts`, `test/llm/openai-compatible.test.ts` | Modify | Unified LLM public-contract coverage |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero type errors
- [ ] `npm test` passes with zero failures
- [ ] Human-gate answers are stored and returned in the canonical spec-rich answer shape rather than the current flat `{ selected_label, source }` struct
- [ ] FREEFORM answers can be captured through the interviewer stack and HTTP-backed question flow without being coerced into fake choice labels
- [ ] Existing label-only clients and tests still work through boundary normalization
- [ ] `wait.human` still routes deterministically when a selected option is present and still writes `human.gate.selected` / `human.gate.label`
- [ ] Cocoon JSON includes `logs: string[]` using run-relative paths
- [ ] Old cocoons without `logs` still load successfully
- [ ] `node_started` events include a 1-based execution `index`
- [ ] `run_completed` events include `artifact_count`
- [ ] Direct `AgentSession` consumers receive `agent_session_started` without relying on `CodergenHandler`
- [ ] Exactly one session-start event is emitted per session, even when codergen is involved
- [ ] `ProviderProfile` exposes provider-specific request options and `AgentSession` passes them through to LLM requests
- [ ] `ToolRegistry.unregister(name)` removes the tool definition and returns a sensible success/failure result
- [ ] `LocalExecutionEnvironment.glob()` and `.grep()` no longer throw and return ignore-aware results
- [ ] `submit()` auto-discovers project instructions and respects the existing 32KB budget
- [ ] Git snapshot output includes branch, changed-file count, and the last 5 commit messages
- [ ] Every `stream_end` event carries a complete `GenerateResponse`
- [ ] `Message.name` exists on the public message type and is preserved through the provider stack where supported
- [ ] `GenerateRequest.max_tool_rounds` exists, defaults to `1`, and controls automatic tool-loop execution
- [ ] `generate()` rejects requests that provide both `prompt` and `messages`
- [ ] `provider_options.anthropic.auto_cache = false` disables automatic caching
- [ ] Legacy `provider_options.anthropic.cache_control = false` still works for this sprint as a compatibility alias
- [ ] `ModelInfo` exposes spec-named flat capability and cost fields
- [ ] Internal callers are migrated off the old nested catalog shape, or the compatibility alias remains the only remaining usage
- [ ] `docs/compliance-report.md` shows zero open gaps

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Answer-model migration breaks the current HTTP human-gate API or queue-based tests | Medium | High | Normalize legacy `selected_label` inputs at the boundary, keep POST compatibility, and add explicit compatibility tests before removing old assumptions internally |
| Moving `agent_session_started` into `AgentSession` creates duplicate lifecycle events when codergen also emits one | Medium | High | Make `AgentSession` the only emitter and convert codergen to bridge rather than synthesize; add an exact-once assertion in session and codergen tests |
| Shared search helpers change ordering or ignore semantics compared with today’s `glob` / `grep` tools | Medium | Medium | Extract the existing logic instead of rewriting it, and make both the tool layer and execution environment call the same helper |
| Changing unified LLM defaults to spec values, especially `max_tool_rounds = 1`, surprises existing callers that implicitly relied on the current behavior | Medium | Medium | Keep `GenerateOptions.maxIterations` as a deprecated alias for one sprint, let the request field win, and update tests to lock down the new contract |
| Catalog field flattening breaks internal code that expects nested `capabilities` / `cost` | Medium | Medium | Provide one-sprint compatibility aliases, grep internal callers immediately, and do not remove the alias until all internal reads are converted |
| Git snapshot enrichment slows prompts or flakes on non-git workspaces | Low | Medium | Keep the current short timeout, degrade gracefully to a smaller snapshot, and never fail the session because git context is unavailable |
| Final stream response assembly drifts between adapters and `StreamAccumulator` | Low | High | Make `StreamAccumulator` the canonical assembler and add adapter-by-adapter final-event tests |

---

## Dependencies

| Package / Module | Purpose |
|------------------|---------|
| `ignore` | Reuse the existing `.gitignore`-aware filesystem matching behavior for shared search helpers |
| `execa` | Keep command execution and git snapshot collection consistent with the current runtime |
| `ajv` | Continue validating tool schemas and structured output without introducing a second validator path |
| `vitest` | Regression and contract test coverage for all gap closures |
| Existing `src/agent-loop/tools/glob.ts` and `src/agent-loop/tools/grep.ts` logic | Source material for the new shared search helper; do not introduce a second search implementation unless tests force it |
| Existing `src/llm/stream-accumulator.ts` | Canonical place to make final stream responses trustworthy |
| Existing `docs/compliance-report.md` gap list | Acceptance checklist for the sprint; every item must move to implemented before the sprint is closed |

No new external services are required. No new runtime dependencies should be added unless shared search extraction proves impossible with the current stack.
