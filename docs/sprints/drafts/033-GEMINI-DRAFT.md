# NEXT Sprint: Spec Compliance Polish

## Overview

**Goal:** Achieve 100% strict compliance with the pinned Attractor, Coding Agent Loop, and Unified LLM specifications by closing all 25 identified gaps in the `docs/compliance-report.md`.

**Scope:** Fix high-severity bugs (terminal_node validation, Gemini RECITATION mapping), add missing medium-severity features (model catalog updates, provider profile capabilities), and align all low-severity interface/naming divergences (PascalCase events, tool parameter names, Context ReadWriteLock).

**Out of scope:**
- Net-new features not explicitly listed as missing in the compliance report.
- Major refactoring of the CLI or Web UI.

---

## Use Cases

1. **Strict Validation:** A DOT file with multiple exit nodes now fails validation, strictly enforcing the `exactly one` terminal node constraint (A1).
2. **Safe Parallel Context:** Parallel handlers can safely mutate shared context using the newly implemented `ReadWriteLock`, fulfilling the thread-safety spec requirement (A2).
3. **Provider Parity:** The system prompts for Claude, Gemini, and Codex closely match their native counterparts, providing better out-of-the-box agent behavior. Tool parameter names (`file_path` vs `path`) match the spec exactly (C9, C10, C11, C12).
4. **Complete LLM Interfaces:** Developers using the Unified LLM SDK have access to missing fields like `Message.text`, `Message.tool_call_id`, `Usage.raw`, and lifecycle methods `initialize()`/`close()` (U1, U4, U5, U8).

---

## Architecture

- **Validation (`src/garden/validate.ts`)**: Update `terminal_node` rule to check for exactly one `Msquare` node instead of `< 1`.
- **Context (`src/engine/context.ts`)**: Implement an async `ReadWriteLock` and integrate it into `ExecutionContext` to coordinate parallel state mutations.
- **Events (`src/engine/events.ts`)**: Refactor all snake_case events (e.g., `run_started`) to PascalCase (e.g., `RunStarted`) across the engine and CLI renderers.
- **LLM SDK (`src/llm/`)**: Add missing optional methods and properties to canonical types (`Message`, `ToolCallData`, `StreamEvent`) and adapters. Add Claude Opus 4.6, Gemini 3.x, and GPT-5.2 to the catalog.
- **Agent Loop (`src/agent-loop/`)**: Update tool registry parameters (`file_path`, `path` for glob, `glob_filter` for grep), and refactor system prompts to be provider-specific.

---

## Implementation Phases

### Phase 1: High-Severity Fixes & Medium Features (~30%)
- [ ] Update `src/garden/validate.ts` for A1 (exactly one terminal node).
- [ ] Update `src/llm/adapters/gemini.ts` for U19 (map RECITATION to content_filter).
- [ ] Update `src/llm/catalog.ts` for U3 (add Claude Opus 4.6, Gemini 3.x, GPT-5.2).
- [ ] Update `src/agent-loop/provider-profiles.ts` for C3, C4, C5 (add `web_search`/`web_fetch` to Gemini, `context_window_size`, capability flags).

### Phase 2: Core Engine & Agent Loop Alignment (~30%)
- [ ] Implement `ReadWriteLock` in `src/engine/context.ts` (A2).
- [ ] Rename events to PascalCase in `src/engine/events.ts` and update all CLI/server consumers (A4).
- [ ] Fix Codergen context updates in `src/handlers/codergen.ts` (A5).
- [ ] Fix `auto_status` synthesized notes string in `src/engine/engine.ts` (A6).
- [ ] Rename tool parameters in `src/agent-loop/tools/*.ts` to match spec: `file_path`, base `path` for glob, `glob_filter` for grep (C9, C10, C11).
- [ ] Implement provider-specific system prompts in `src/agent-loop/provider-profiles.ts` (C12).

### Phase 3: Unified LLM Interface Completion (~40%)
- [ ] Add `initialize()` and `close()` to `ProviderAdapter` and implementations (U1).
- [ ] Add `supports_tool_choice(mode)` to adapters (U2).
- [ ] Add `tool_call_id` and `text` accessor to `Message` (U4, U5).
- [ ] Add `type` to `ToolCallData`, and `image_data`/`image_media_type` to `ToolResultData` (U6, U7).
- [ ] Add `raw` field to `Usage` (U8).
- [ ] Update `StreamEvent` to track `text_id`, `PROVIDER_EVENT` type, and `raw` field (U9, U10).
- [ ] Add `per_step` to `TimeoutConfig` and `max_retries` to `generate()` (U11, U12).

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/validate.ts` | Modify | Fix A1 (terminal_node rule) |
| `src/engine/context.ts` | Modify | Fix A2 (ReadWriteLock) |
| `src/engine/events.ts` | Modify | Fix A4 (PascalCase events) |
| `src/handlers/codergen.ts` | Modify | Fix A5 (Context updates) |
| `src/engine/engine.ts` | Modify | Fix A6 (auto_status notes string) |
| `src/agent-loop/provider-profiles.ts` | Modify | Fix C3, C4, C5, C12 |
| `src/agent-loop/tools/*.ts` | Modify | Fix C9, C10, C11 (parameter names) |
| `src/llm/catalog.ts` | Modify | Fix U3 (model catalog) |
| `src/llm/adapters/*.ts` | Modify | Fix U1, U2, U19 |
| `src/llm/types.ts` | Modify | Fix U4, U5, U6, U7, U8, U11, U12 |
| `src/llm/streaming.ts` | Modify | Fix U9, U10 |

---

## Definition of Done

- [ ] All 25 gaps listed in `docs/compliance-report.md` are addressed.
- [ ] `npm test` passes with zero failures.
- [ ] `docs/compliance-report.md` is updated to show 0 gaps.
- [ ] `pollinator validate` explicitly rejects graphs with 0 or >1 terminal nodes.
- [ ] Event names logged to CLI and emitted from the engine are in PascalCase.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Event Renaming Breakage | High | Medium | Search across the entire codebase for snake_case event names. Rely heavily on TypeScript compiler errors to catch missed updates. |
| Deadlocks from ReadWriteLock | Medium | High | Implement the lock simply and ensure all handlers use `finally` blocks to guarantee lock release. |
| Tool Parameter Mismatches | Low | Medium | Ensure that internal tool logic expects the new parameter names, and test `grep`/`glob`/`read_file` extensively after renaming. |

---

## Dependencies

- None. This sprint focuses purely on codebase internal alignment and compliance with existing specs.
