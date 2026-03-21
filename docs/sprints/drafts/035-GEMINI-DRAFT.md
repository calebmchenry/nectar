# Sprint: Spec Convergence & Gap Closure

## Overview

**Goal:** Achieve 100% strict adherence to the upstream `attractor`, `coding-agent-loop`, and `unified-llm` specifications by closing all 20 identified compliance gaps.
**Scope:** Fix context resolution in conditions, align checkpoint file structures, correct agent session lifecycle tracking, add missing Gemini profile tools (`web_search`, `web_fetch`), align event nomenclature with the spec, and patch all reported omissions in data models and error handling.
**Out of scope:** Major new architectural features, UI changes, or adding capabilities not explicitly defined in the upstream specs.

## Use Cases

1. **Unqualified Condition Evaluation:** A pipeline author writes `condition="my_flag=true"` instead of `context.my_flag=true`, and the engine correctly resolves it against the context store.
2. **Spec-Compliant Checkpointing:** A user resumes a pipeline from `{logs_root}/checkpoint.json`, matching the exact directory structure expected by the upstream spec rather than the legacy `.nectar/cocoons/` format.
3. **Accurate Turn Limits:** An agent session correctly respects `max_turns` across multiple inputs and follow-ups, preventing runaway sessions over long lifecycles.
4. **Gemini Web Capabilities:** The Gemini profile successfully invokes the `web_search` and `web_fetch` tools to ground its responses during `codergen` execution.
5. **Robust Error Recovery:** An Anthropic tool output that hits a content filter emits a `ContentFilterError` instead of a generic failure, allowing the pipeline to handle it semantically. `StreamError` correctly triggers automatic retries.

## Architecture

The underlying architecture remains unchanged from the established 4-layer LLM client, Event-driven Agent Loop, and Core Execution Engine. This sprint focuses purely on patching misalignments:

- **Condition Parser Adjustment:** Update `src/engine/conditions.ts` to fall back to `context.*` lookups when an identifier lacks a known prefix.
- **RunStore Refactoring:** Modify `src/checkpoint/run-store.ts` and `src/checkpoint/cocoon.ts` to abandon the global `.nectar/cocoons/{run_id}.json` in favor of per-run `logs_root` directories.
- **Agent Session State:** Elevate `turnCount` to the class level in `src/agent-loop/session.ts` so it persists across `processWorkItem` invocations.
- **New Tools:** Implement `src/agent-loop/tools/web-search.ts` and `src/agent-loop/tools/web-fetch.ts` mapped strictly to the Gemini profile.
- **LLM Client Event Names:** Refactor `StreamEvent` constants across `src/llm/streaming.ts` and all adapter implementations.

## Implementation phases

### Phase 1: Attractor Engine Convergence (Gaps A1-A5)
- **A1/A2:** Add `notes` to `NodeOutcome` in `src/engine/types.ts`. Update `writeNodeStatus` to dump the complete payload (outcome, preferred_label, suggested_next_ids, context_updates, notes) to `status.json`.
- **A3:** Update `src/engine/conditions.ts` variable resolution to treat unqualified keys as `context.<key>`.
- **A4:** Modify `src/checkpoint/cocoon.ts` to write/read from `{logs_root}/checkpoint.json`. Provide a seamless migration for existing `.nectar/cocoons/` files if necessary.
- **A5:** Update `src/interviewer/auto-approve.ts` and `src/interviewer/types.ts` to properly distinguish and handle the `CONFIRMATION` question type.

### Phase 2: Agent Loop Polish (Gaps C1-C7)
- **C1:** Move `turnCount` initialization out of `processWorkItem` into the `AgentSession` state.
- **C2:** Update `src/agent-loop/provider-profiles.ts` to use accurate replicas of native system prompts.
- **C3:** Create `web_search` and `web_fetch` tools, registering them in the Gemini profile's `visibleTools`.
- **C4/C5:** Update `src/agent-loop/session.ts` to properly emit `agent_session_completed` on closure. Attach `full_content` to `agent_tool_call_completed` unconditionally.
- **C6:** Add specific try/catch handling for `ContextLengthError` during the generation loop to emit `context_window_warning` and gracefully continue or abort.
- **C7:** Inject missing beta headers (`prompt-caching-2024-07-31`, etc.) into `providerOptions` for the Anthropic profile.

### Phase 3: Unified LLM Client Fixes (Gaps L1-L8)
- **L1/L6:** In `src/llm/errors.ts`, set `retryable: true` for `StreamError`. Add `retry_after: number | null` to the base `ProviderError` class.
- **L2:** Parse Anthropic's specific safety block/error responses in `src/llm/adapters/anthropic.ts` and throw `ContentFilterError`.
- **L3:** Mass rename `content_delta` -> `text_delta`, `stream_end` -> `finish`, and `thinking_*` -> `reasoning_*` in types and emitters.
- **L4:** Export a top-level `stream()` function in `src/llm/client.ts` that includes tool loop resolution, matching `generate()`.
- **L5/L7:** Add `detail?: 'auto' | 'low' | 'high'` to `ImageData` and `metadata?: Record<string, string>` to `GenerateRequest` types.

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/types.ts` | Modify | Add `notes` to `NodeOutcome`. |
| `src/handlers/codergen.ts` | Modify | Update `writeNodeStatus` to include all outcome fields. |
| `src/engine/conditions.ts` | Modify | Support unqualified context key resolution. |
| `src/checkpoint/cocoon.ts` | Modify | Change checkpoint path to `{logs_root}/checkpoint.json`. |
| `src/agent-loop/session.ts` | Modify | Fix `max_turns` counter, emit session completion events, handle ContextLengthError. |
| `src/agent-loop/provider-profiles.ts` | Modify | Update system prompts and Anthropic beta headers. |
| `src/agent-loop/tools/web-search.ts` | Create | New tool for Gemini profile. |
| `src/agent-loop/tools/web-fetch.ts` | Create | New tool for Gemini profile. |
| `src/agent-loop/events.ts` | Modify | Ensure `full_content` is always present on tool completion events. |
| `src/llm/errors.ts` | Modify | Update `StreamError` to be retryable, add `retry_after` to base error. |
| `src/llm/adapters/anthropic.ts` | Modify | Raise `ContentFilterError` when appropriate. |
| `src/llm/streaming.ts` | Modify | Rename stream event constants to match spec. |
| `src/llm/types.ts` | Modify | Add `detail` to ImageData and `metadata` to GenerateRequest. |
| `src/llm/client.ts` | Modify | Implement module-level `stream()` export with tool loop. |

## Definition of Done

- [ ] All 20 gaps identified in `docs/compliance-report.md` are closed.
- [ ] `max_turns` correctly terminates a session spanning multiple `followUp` calls once the total limit is reached.
- [ ] `web_search` and `web_fetch` are fully integrated and accessible when using the Gemini profile.
- [ ] All modified LLM stream events correctly map to the upstream spec nomenclature.
- [ ] Unqualified identifiers in condition strings resolve against `context` natively.
- [ ] Existing automated tests pass, with new tests added to cover unqualified conditions, global turn counting, and new LLM error states.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Checkpoint location change breaks backwards compatibility | High | Medium | Implement a one-time migration fallback in `readCocoon()` that checks the old `.nectar/cocoons/` path if the new path does not exist. |
| Changing stream event names breaks existing consumers | High | High | Coordinate the rename across the entire codebase (`src/agent-loop`, `src/handlers/codergen.ts`, CLI renderer) in a single atomic commit. |

## Dependencies

No new external package dependencies are required for this sprint. All changes are internal state alignments and data model updates.