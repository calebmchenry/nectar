# Sprint 002: Compliance and Gap Closure

## Overview

**Goal:** Address the 15 remaining specification gaps identified in the latest Nectar Compliance Report. This sprint brings the execution engine, coding agent loop, and unified LLM client to 100% adherence with the pinned upstream attractor specs.

**Scope:** 
- Fix structural data model omissions (`Answer` model, `Cocoon.logs`, `Message.name`, event payloads).
- Complete `AgentSession` context discovery (recent git commits, auto-discovered project instructions).
- Implement missing interface methods (`LocalExecutionEnvironment.glob/grep`, `ToolRegistry.unregister`, `ProviderProfile.provider_options`).
- Fix LLM streaming, parameter validation, and provider-specific quirks (caching keys, capability schemas).

**Out of scope:**
- Web UI ("The Hive")
- Seedbed backlog and swarm analysis
- New architectural features or capabilities beyond closing the reported gaps.

---

## Use Cases

1. **Rich Agent Context:** When an agent session starts, it automatically loads `AGENTS.md` and `[PROVIDER].md` instructions, and includes the last 5-10 git commit messages in its environment context, without requiring explicit injection by the caller.
2. **Proper Search Tool Delegation:** A containerized or remote execution environment subclass can override `glob()` and `grep()` to run inside the container, because the base `LocalExecutionEnvironment` implements them directly instead of throwing an error.
3. **Reliable LLM Stream Consumption:** Consumers of the `stream()` API receive a fully assembled `GenerateResponse` object on the `stream_end` event, allowing them to access total token usage and final finish reasons without manually accumulating chunks.
4. **Provider-Specific Toggles:** Developers can properly configure `auto_cache: false` and other beta headers via the newly implemented `provider_options()` interface on `ProviderProfile`.
5. **Accurate Event Streams:** Integrators listening to engine events reliably receive `agent_session_started` from the session itself, and pipeline events include required fields like `index` and `artifact_count`.

---

## Architecture

This sprint consists of targeted fixes across existing modules rather than new abstractions. The architectural footprint remains the same, but the contracts are tightened to match the specs:

### Execution Environment & Context
- `LocalExecutionEnvironment` will implement `.glob()` and `.grep()` using Node.js `fs`/`path` modules or lightweight `execa` wrappers, removing the current `throw new Error()`.
- `buildGitSnapshot()` in `environment-context.ts` will execute `git log -n 10` to fulfill the recent commit history requirement.
- `session.ts` will invoke `discoverInstructions()` locally if project instructions are missing from the configuration.

### Data Models
- Interfaces across `types.ts` files will be updated to match the spec's exact naming and structural requirements (e.g., `Message.name`, `AnswerValue` structure, `ModelInfo` capabilities).
- Events will be updated to mandate the missing payload fields.

### Unified LLM Client
- The `stream_end` event definition will be tightened to make `response: GenerateResponse` required. The `StreamAccumulator` will ensure it is fully populated before the event fires.
- `GenerateRequest` will formally adopt `max_tool_rounds`.
- Parameter validation will strictly reject overlapping inputs (e.g., both `prompt` and `messages` defined).

---

## Implementation Phases

### Phase 1: Data Model & Event Payload Fixes (~20%)
**Tasks:**
- Update `src/interviewer/types.ts`: Expand the `Answer` model to support the full `AnswerValue` structure (`selected_option`, `text`) and ensure the FREEFORM question type has a distinct handling path.
- Update `src/checkpoint/types.ts`: Add `logs: string[]` to the `Cocoon` interface.
- Update `src/engine/events.ts`: Add `artifact_count` to the `run_completed` payload and `index` to the `node_started` payload.
- Update `src/llm/types.ts`: Add `name?: string` to the `Message` interface for tool and developer attribution.
- Update `src/llm/catalog.ts`: Rename `ModelInfo` capability fields to `supports_tools`, `supports_vision`, and `supports_reasoning`, and rename `cost.input_per_million` to `input_cost_per_million` to match the spec.

### Phase 2: Agent Session & Context Completeness (~40%)
**Tasks:**
- Update `src/agent-loop/session.ts`: Ensure `agent_session_started` is emitted by `AgentSession` itself (e.g., during `initialize()` or the constructor) instead of externally by the codergen handler.
- Update `src/agent-loop/session.ts`: Modify the initialization or `processInput` loop to automatically call `discoverInstructions()` and inject the results if they weren't provided.
- Update `src/agent-loop/tool-registry.ts`: Implement the missing `unregister(name: string)` method.
- Update `src/agent-loop/execution-environment.ts`: Implement `.glob()` and `.grep()` functionality using native Node APIs or `execa`, rather than throwing errors.
- Update `src/agent-loop/environment-context.ts`: Modify `buildGitSnapshot()` to retrieve and append the last 10 commit messages.
- Update `src/agent-loop/provider-profiles.ts`: Add `provider_options()` to the `ProviderProfile` interface and implement it across `AnthropicProfile`, `OpenAIProfile`, and `GeminiProfile`.

### Phase 3: Unified LLM API Compliance (~40%)
**Tasks:**
- Update `src/llm/streaming.ts`: Change `response?: GenerateResponse` to `response: GenerateResponse` on the `stream_end` event, and ensure `StreamAccumulator` guarantees its presence.
- Update `src/llm/types.ts` and `src/llm/client.ts`: Add `max_tool_rounds` to `GenerateRequest` as a first-class parameter, replacing or mapping the internal `maxIterations`.
- Update `src/llm/client.ts`: Update `normalizePromptRequest()` / `generate()` to explicitly throw an error if both `prompt` and `messages` are passed in the request.
- Update `src/llm/adapters/anthropic.ts`: Fix the prompt caching toggle logic to check `provider_options.anthropic.auto_cache === false` instead of `cache_control !== false`.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/interviewer/types.ts` | Modify | Expand `Answer` model to spec richness |
| `src/checkpoint/types.ts` | Modify | Add `logs` to `Cocoon` |
| `src/engine/events.ts` | Modify | Add missing fields to `run_completed` and `node_started` |
| `src/llm/types.ts` | Modify | Add `Message.name`, add `max_tool_rounds` |
| `src/llm/catalog.ts` | Modify | Rename capabilities and cost keys |
| `src/agent-loop/session.ts` | Modify | Auto-discover instructions, emit `agent_session_started` |
| `src/agent-loop/tool-registry.ts` | Modify | Implement `unregister()` |
| `src/agent-loop/execution-environment.ts` | Modify | Implement `glob()` and `grep()` |
| `src/agent-loop/environment-context.ts` | Modify | Include recent commits in git snapshot |
| `src/agent-loop/provider-profiles.ts` | Modify | Add `provider_options()` interface method |
| `src/llm/streaming.ts` | Modify | Make `response` required on `stream_end` |
| `src/llm/client.ts` | Modify | Enforce `prompt` vs `messages` exclusivity, handle `max_tool_rounds` |
| `src/llm/adapters/anthropic.ts` | Modify | Fix `auto_cache` provider option key |
| `test/**/*.test.ts` | Modify | Update and add unit tests to cover the new behaviors and types |

---

## Definition of Done

- [ ] All 15 gaps listed in the 2026-03-21 Compliance Report have been addressed.
- [ ] TypeScript compilation succeeds with zero errors (`npm run build`).
- [ ] `AgentSession` automatically injects `AGENTS.md` and commit history into its context block.
- [ ] `LocalExecutionEnvironment`'s `glob()` and `grep()` methods execute successful file searches.
- [ ] Calling `generate()` with both `prompt` and `messages` throws a predictable error.
- [ ] Listening to a stream guarantees a `GenerateResponse` object is attached to the `stream_end` event.
- [ ] All unit and integration tests pass, including new tests specifically covering the resolved gaps.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Implementing `glob`/`grep` locally introduces shell injection vulnerabilities | Low | High | Use safe API wrappers (e.g., native `fs` traversing or strictly escaped `execa` arguments) rather than bare shell strings. |
| Auto-discovering project instructions inflates context window too much | Medium | Medium | Respect the 32KB budget mentioned in the spec and safely truncate or omit if files are too large. |
| Making `response` required on `stream_end` breaks error states | Medium | Medium | Ensure that if a stream ends prematurely due to an error, it emits an `error` event instead of a `stream_end` event, or constructs a valid partial response. |

---

## Dependencies

No new external dependencies are required for this sprint. We will rely on existing libraries (`execa`, `fs`, etc.) to fill the missing gaps.
