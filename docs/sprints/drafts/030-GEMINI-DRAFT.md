# Sprint 002: Spec Compliance & Engine Hardening

## Overview

**Goal:** Eliminate the 33 spec compliance deviations identified in the latest Nectar Compliance Report. Reaching 100% compliance across the Attractor, Coding Agent Loop, and Unified LLM Client specs is non-negotiable for system stability before we move on to building the web UI ("The Hive").

**Scope:** 
- Aligning context keys, checkpoint fields, and event payloads in the core Attractor engine (Gaps 1-6).
- Hardening the Coding Agent Loop state machine, fixing environment discovery (Git, project instructions), implementing missing `glob`/`grep` tools, and correcting session events (Gaps 7-18).
- Resolving Unified LLM SDK inconsistencies, specifically around stream lifecycle events, error classification (401/403/404), message merging, and parameter propagation (Gaps 19-33).

**Out of scope:**
- Net-new features not explicitly defined in the pinned attractor specs.
- Web UI ("The Hive") development.
- Further CLI visual theme enhancements.

---

## Use Cases

1. **Accurate Pipeline Routing:** Condition expressions relying on `context.last_stage=plan` or querying `parallel.results` work identically to the spec. This allows users to build reliable conditional logic after codergen or fan-in nodes.
2. **Reliable LLM Streaming & UI Readiness:** The pipeline emits standard `TEXT_START`/`END` and `TOOL_CALL_START`/`END` stream events, and the final `FINISH` event contains complete `Usage` metrics. This provides the predictability required for a polished real-time UI.
3. **Robust Agent Tooling:** Agents can natively use `glob` and `grep` without throwing errors. When a shell command times out, the agent receives an explicit spec-mandated truncation message, helping it gracefully recover instead of blindly retrying.
4. **Predictable Agent Steering:** Users (or automated supervisors) can inject steering messages while an agent is idle. These messages queue correctly instead of throwing application errors, ensuring robust human-in-the-loop interventions.
5. **Provider Interchangeability:** Error mapping (e.g., Auth vs. Access Denied) and prompt handling (e.g., Anthropic consecutive message merging) are identical across OpenAI, Anthropic, and Gemini adapters, allowing seamless model swapping in `.dot` stylesheets.

---

## Architecture

This sprint introduces no new major abstractions. Instead, it focuses on strict adherence to the existing contracts.

### State & Lifecycle Enforcement
- **AgentSession:** Must strictly enforce lifecycle transitions. Auth errors must transition the session to `CLOSED`. The `steer()` method must gracefully queue messages when in the `IDLE` state.
- **StreamEvent Synthesis:** Provider adapters (or the core streaming middleware) must synthesize `_start` and `_end` events if the underlying provider API only emits deltas. The `FINISH` event must be fully hydrated with the accumulated `Response` object and total token usage.

### Execution Environment Expansion
- **LocalExecutionEnvironment:** Implement `glob` and `grep` directly. These methods currently throw `Use the glob/grep tool instead`. The spec requires the environment interface to support them natively, enabling generic file-system abstraction for Docker or remote environments.

### Context & Telemetry Alignment
- **Context Keys:** Handlers (`codergen`, `wait.human`, `parallel`) must map their local execution states precisely to the spec-mandated context keys (`last_stage`, `last_response`, `human.gate.selected`, `parallel.results`) rather than ad-hoc node-ID based keys.
- **Event Payloads:** Ensure all specified fields (e.g., `artifact_count`, `index`) are populated in event emissions. 

---

## Implementation Phases

### Phase 1: Attractor Engine & Context Alignment (~20%)

**Focus:** Resolving Gaps 1-6.
- [ ] Update `src/handlers/codergen.ts` to set `last_stage` and `last_response` in context updates instead of `{node.id}.response`.
- [ ] Update `src/handlers/wait-human.ts` to set `human.gate.selected` and `human.gate.label` instead of `{node.id}.selection`.
- [ ] Update `src/handlers/parallel.ts` to store results in a single `parallel.results` dictionary instead of scattered keys. Update `src/handlers/fan-in.ts` to read from this new structure.
- [ ] Update `src/interviewer/types.ts` to implement the full `AnswerValue` enum and struct spec.
- [ ] Update `src/checkpoint/types.ts` and `cocoon.ts` to include the `logs` array.
- [ ] Update `src/engine/events.ts` to ensure `run_completed` includes `artifact_count` and `node_started` includes `index`.

### Phase 2: Agent Loop & Environment Hardening (~40%)

**Focus:** Resolving Gaps 7-18.
- [ ] Update `AgentSession` (`src/agent-loop/session.ts`) to queue steering messages when idle, use the `user` role for steering, handle authentication errors by transitioning to `CLOSED`, and auto-discover project instructions on `submit()`.
- [ ] Update `src/handlers/codergen.ts` and `AgentSession` so `AgentSession` is responsible for emitting `agent_session_started`.
- [ ] Implement `glob()` and `grep()` in `LocalExecutionEnvironment` (`src/agent-loop/execution-environment.ts`), removing the placeholder error throws.
- [ ] Update Provider Profiles (`src/agent-loop/provider-profiles.ts`) to include a `provider_options()` method for beta header configuration and implement strongly differentiated, native-mirroring system prompts.
- [ ] Add `unregister()` to `ToolRegistry` (`src/agent-loop/tool-registry.ts`).
- [ ] Update `src/agent-loop/tools/shell.ts` to append the explicit timeout error string on `124` exits.
- [ ] Update Git snapshot logic in `src/agent-loop/environment-context.ts` to extract the last 5-10 commit messages.
- [ ] Update `spawn_agent` (`src/agent-loop/tools/spawn-agent.ts`) to use the standard two-pass truncation pipeline rather than a hardcoded 2000-char slice.

### Phase 3: Unified LLM Client Spec Alignment (~40%)

**Focus:** Resolving Gaps 19-33.
- [ ] Expand the `StreamEvent` model in `src/llm/streaming.ts` to include `TEXT_START`, `TEXT_END`, `TOOL_CALL_START`, and `TOOL_CALL_END`. Synthesize these in the stream middleware or adapters.
- [ ] Update the `FINISH` event payload to include the full `Response` and `Usage` structures. Add `total_tokens` to `Usage`. Add `name` to the `Message` interface.
- [ ] Sync `GenerateRequest` with the spec: add `max_tool_rounds` directly to the request object and throw an error if both `prompt` and `messages` are provided.
- [ ] Update error classification across adapters (`src/llm/adapters/*.ts`):
  - OpenAI: Map 403 to `AccessDeniedError`, 404 to `NotFoundError`, and context length errors to `ContextWindowError`.
  - Gemini: Separate 401 (`AuthenticationError`) and 403 (`AccessDeniedError`), and map context length errors to `ContextWindowError`.
- [ ] Update `AnthropicAdapter` to merge consecutive messages of the same role prior to submitting the request. Fix the prompt caching disable key mismatch (`auto_cache` instead of `cache_control`).
- [ ] Update `LLMError` to include `error_code` and `raw` fields.
- [ ] Align retry defaults in `src/llm/retry.ts` to `max_retries=2` and `base_delay=1.0s`.
- [ ] Map `stop_sequences` correctly in the `OpenAIAdapter`.
- [ ] Align `ModelInfo` boolean capability flags in `src/llm/catalog.ts` with the spec names (`supports_tools`, `supports_vision`, `supports_reasoning`, `input_cost_per_million`).

---

## Files Summary

| File | Primary Action |
|------|----------------|
| `src/handlers/codergen.ts` | Context key alignment (`last_stage`) |
| `src/handlers/wait-human.ts` | Context key alignment (`human.gate.*`) |
| `src/handlers/parallel.ts` | Store `parallel.results` as single map |
| `src/checkpoint/types.ts` | Add `logs: List<String>` |
| `src/engine/events.ts` | Align event payload fields |
| `src/agent-loop/session.ts` | Lifecycle management, steering queue, auth close |
| `src/agent-loop/execution-environment.ts` | Implement `glob` and `grep` methods |
| `src/agent-loop/provider-profiles.ts` | `provider_options()` and native system prompts |
| `src/agent-loop/tool-registry.ts` | Add `unregister()` |
| `src/agent-loop/environment-context.ts` | Include recent Git commit messages |
| `src/llm/streaming.ts` | Add `START`/`END` lifecycle events |
| `src/llm/types.ts` | Update `Usage`, `Message`, `GenerateRequest` |
| `src/llm/adapters/openai.ts` | Error mappings, `stop_sequences` |
| `src/llm/adapters/anthropic.ts` | Consecutive message merging, cache option key |
| `src/llm/adapters/gemini.ts` | Error mappings |
| `src/llm/errors.ts` | Add `error_code`, `raw` fields |
| `src/llm/retry.ts` | Align default retry parameters |
| `src/llm/catalog.ts` | Align capability boolean names |

---

## Definition of Done

- [ ] All 33 gaps listed in the Nectar Compliance Report (dated 2026-03-21) are closed.
- [ ] `npm run build` and `npm test` pass.
- [ ] Running a full DOT pipeline with retries, conditionals, parallel branches, and tool nodes exhibits correct context mappings (verified via `--debug` or inspecting the `.nectar/cocoons/<id>.json`).
- [ ] A simulated `steer()` call while an `AgentSession` is IDLE successfully queues the steering message without throwing an error.
- [ ] Simulated 401/403 errors correctly transition the agent session into the `CLOSED` state and emit specific `AuthenticationError` / `AccessDeniedError` exceptions across all three adapters.
- [ ] Event listeners attached to `stream()` receive the full lifecycle of start/delta/end events for both text and tool calls.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Anthropic Message Merging:** API rejects combined messages with varied content parts. | Medium | High | Rely heavily on comprehensive unit tests for `AnthropicAdapter` message transformation logic. Ensure text parts are correctly concatenated with line breaks and image/tool parts remain intact. |
| **Context Key Refactoring:** Existing test pipelines break due to changed context keys. | High | Medium | Search the `test/fixtures/*.dot` files for legacy context key names and update them simultaneously. |
| **Event Stream Disruption:** Adding synthetic start/end events breaks existing stream consumers. | Low | Medium | Update the `StreamAccumulator` and CLI renderer alongside the middleware to handle the new event types gracefully. |

---

## Dependencies

No new external dependencies required for this sprint. All changes are internal refinements to strictly match the existing attractor specification.
