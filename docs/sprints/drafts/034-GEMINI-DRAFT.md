# Sprint: Spec Compliance & Gap Closure

## Overview

**Goal:** Achieve 100% strict compliance with the upstream Attractor, Coding Agent Loop, and Unified LLM specifications by resolving all 22 remaining gaps identified in the 2026-03-21 Compliance Report.

**Scope:** 
This sprint focuses entirely on closing the "last mile" compliance gaps. This includes aligning tool parameter names, expanding provider profile metadata, filling out missing LLM interface fields, implementing the Gemini `web_search`/`web_fetch` tools, updating the model catalog to current specs, and matching the exact event naming conventions and context-locking mechanisms required by the specifications.

**Out of scope:**
- Major architectural changes to the engine.
- Implementation of new handler types or core features beyond what is explicitly documented as missing in the compliance report.
- UI or CLI feature additions not directly tied to spec gaps.

---

## Use Cases

1. **Strict Spec Event Consumption:** A downstream system monitoring the SSE event stream successfully parses `PipelineStarted` and `StageCompleted` events (PascalCase) instead of `run_started` and `node_completed`, matching the attractor spec exactly.
2. **Compliant Tool Execution:** An LLM agent correctly utilizes the `glob` tool by providing a `path` parameter for the base directory, and uses `file_path` for `read_file`, preventing parameter mismatch errors.
3. **Web-Enhanced Gemini Profiling:** A seedbed analysis job utilizing the Gemini provider profile automatically executes `web_search` and `web_fetch` to gather up-to-date documentation before synthesizing its report.
4. **Thread-Safe Context Access:** Parallel branches attempting to mutate the same context keys concurrently are safely serialized using a true `ReadWriteLock`, fulfilling the §5.1 Attractor specification and preventing race conditions.
5. **Modern Model Cataloging:** The orchestrator cleanly resolves capabilities and context window sizes for `GPT-5.2`, `Claude Opus 4.6`, and `Gemini 3.x` models natively without fallback approximations.

---

## Architecture

### Language & Frameworks
- TypeScript on Node.js 22+
- Retain existing dependencies; no new major libraries are necessary, with the possible exception of a lightweight locking primitive (like `async-mutex`) if we do not implement a native promise-based ReadWriteLock for the Context.

### Design Choices
- **Event Renaming:** The renaming of events from `snake_case` to `PascalCase` requires updating both the emitter (`src/engine/events.ts`, `src/engine/engine.ts`) and all consumers (CLI renderers, Server SSE routes).
- **Context Locking:** The JS event loop is single-threaded, but since handlers (like `ParallelHandler`) do async work, a simple `ReadWriteLock` abstraction will be introduced to `src/engine/context.ts` to strictly satisfy the spec and ensure async context updates are safe.
- **Tool Parameter Alignment:** This is a breaking change for any hardcoded tool definitions but is required for spec adherence. The `ToolRegistry` and specific tool implementations (`src/agent-loop/tools/*.ts`) will be updated.

---

## Implementation Phases

### Phase 1: Attractor Spec Strictness (A2, A4, A6) (~20%)
**Objective:** Resolve discrepancies in the Attractor core engine.
- **Tasks:**
  - Update `src/engine/events.ts` to use PascalCase for all event names (e.g., `PipelineStarted`, `StageCompleted`). Update all emitters and listeners across `src/engine/`, `src/cli/`, and `src/server/`.
  - Implement a `ReadWriteLock` in `src/engine/context.ts`. Update context `get`/`set` methods to acquire the appropriate lock before operating on the internal map.
  - Update the `auto_status` fallback string in `src/engine/engine.ts` to exactly match: `"auto-status: handler completed without writing status"`.

### Phase 2: Coding Agent Loop Spec Alignments (C3-C5, C9-C12) (~40%)
**Objective:** Fix tool parameters, provider profiles, and system prompts.
- **Tasks:**
  - Rename `path` to `file_path` in `src/agent-loop/tools/read-file.ts`.
  - Rename `include` to `glob_filter` in `src/agent-loop/tools/grep.ts`.
  - Add `path` parameter to `src/agent-loop/tools/glob.ts` to act as the base directory.
  - Expand `ProviderProfile` in `src/agent-loop/provider-profiles.ts` to include `context_window_size`, `supports_reasoning`, and `supports_streaming`.
  - Implement `web_search.ts` and `web_fetch.ts` in `src/agent-loop/tools/` and expose them as optional tools in the Gemini provider profile.
  - Review and update system prompts in `src/agent-loop/provider-profiles.ts` to act as full mirrors of the reference agents as defined in the spec.

### Phase 3: Unified LLM Interface & Catalog Completeness (U1-U12) (~40%)
**Objective:** Complete the missing fields and lifecycle methods in the LLM adapters.
- **Tasks:**
  - Update `src/llm/catalog.ts` to include GPT-5.2 family, Claude Opus 4.6, and Gemini 3.x models.
  - Add optional `close()` and `initialize()` methods to the `ProviderAdapter` interface and implement stubs/cleanup logic in the adapters.
  - Add `supports_tool_choice(mode)` to `ProviderAdapter`.
  - Add `tool_call_id` and a `text` convenience accessor to the `Message` interface (`src/llm/types.ts`).
  - Add `type` field to `ToolCallData` and `image_data`/`image_media_type` to `ToolResultData`.
  - Add `raw` passthrough field to `Usage` and `StreamEvent` types, along with `text_id` for streams and a `PROVIDER_EVENT` fallback type.
  - Support `per_step` in `TimeoutConfig` (`src/llm/timeouts.ts`) and `max_retries` configuration overriding on `generate()` (`src/llm/client.ts`).

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/events.ts` | Modify | Rename events to PascalCase |
| `src/engine/engine.ts` | Modify | Update event emission and auto_status wording |
| `src/cli/ui/renderer.ts` | Modify | Update event listeners for PascalCase |
| `src/server/routes/pipelines.ts` | Modify | Update SSE event names |
| `src/engine/context.ts` | Modify | Add ReadWriteLock implementation |
| `src/agent-loop/tools/read-file.ts` | Modify | Rename parameter to `file_path` |
| `src/agent-loop/tools/grep.ts` | Modify | Rename parameter to `glob_filter` |
| `src/agent-loop/tools/glob.ts` | Modify | Add `path` parameter |
| `src/agent-loop/tools/web-search.ts` | Create | Implement Gemini web search tool |
| `src/agent-loop/tools/web-fetch.ts` | Create | Implement Gemini web fetch tool |
| `src/agent-loop/provider-profiles.ts` | Modify | Add capabilities fields, update system prompts, register Gemini web tools |
| `src/llm/catalog.ts` | Modify | Add GPT-5.2, Opus 4.6, Gemini 3.x |
| `src/llm/adapters/types.ts` | Modify | Add `close`, `initialize`, `supports_tool_choice` |
| `src/llm/types.ts` | Modify | Update Message, Tool, Usage, and StreamEvent interfaces |
| `src/llm/timeouts.ts` | Modify | Add `per_step` to TimeoutConfig |
| `src/llm/client.ts` | Modify | Support `max_retries` per-call parameter |

---

## Definition of Done

- [ ] All 22 gaps listed in the 2026-03-21 Compliance Report are implemented and verified.
- [ ] A newly executed compliance audit against the Nectar codebase reports 0 gaps.
- [ ] `vitest` suite passes completely, with updated assertions for PascalCase event names.
- [ ] `pollinator validate` and execution tests still pass end-to-end.
- [ ] The `web_search` and `web_fetch` tools can be invoked successfully through the Gemini profile.
- [ ] LLM clients can explicitly define `max_retries` and `per_step` timeouts in their `generate()` calls.
- [ ] Parallel nodes mutating context correctly lock and release using the new Context ReadWriteLock.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Event Renaming breaks downstream consumers | High | Medium | Search and replace carefully across CLI and SSE logic. Add unit tests ensuring specific PascalCase events are properly emitted. |
| Context locking introduces deadlocks in `ParallelHandler` | Medium | High | Implement the `ReadWriteLock` with timeouts, and strictly enforce `try/finally` block usage whenever a lock is acquired. |
| Tool parameter renaming breaks existing LLM agent prompts or macros | High | Low | Existing agents using `path` instead of `file_path` will receive a schema validation error and self-correct on the next turn. |

---

## Dependencies

- Possible addition of `async-mutex` for clean `ReadWriteLock` implementation, or internal custom implementation using standard Promise queues to keep dependencies minimal.
