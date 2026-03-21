# Sprint: Spec Compliance & Correctness (Closing the Gaps)

## Overview

**Goal:** Deliver a fully spec-compliant engine by addressing all High and Medium severity gaps identified in the latest compliance report. After this sprint, the engine will strictly adhere to the Attractor, Coding Agent Loop, and Unified LLM specifications, specifically resolving critical issues around data loss, execution environment safety, and algorithmic correctness.

**Scope:** 
- **High Severity Gaps:** U18 (Anthropic redacted_thinking data loss), U15 (TimeoutError retryability), C1 (Project document walk direction), C6/C7 (Default turn/round limits).
- **Medium Severity Gaps:** A3 (Missing CheckpointSaved event), C2 (`spawn_agent` max_turns parameter), C8 (Process group for shell commands), U3 (Model catalog updates), U14 (Tool call repair mechanism), U13 (Tool name validation).

**Out of scope:**
- Low severity interface shape/naming divergences (e.g., snake_case vs PascalCase).
- Major new feature additions outside of the spec compliance gaps.
- The web UI ("The Hive") or idea backlog ("Seedbed").

---

## Use Cases

1. **Round-tripping Anthropic Redacted Thinking (U18):** A user runs a pipeline with an Anthropic model (e.g., Claude 3.7 Sonnet) that returns `redacted_thinking`. The agent can successfully pass this exact opaque data back in subsequent turns without data loss, maintaining context and preventing API errors.
2. **Safe Subprocess Execution (C8):** A tool handler spawns a long-running shell command that spawns its own children (e.g., a dev server). When the pipeline run is cancelled or times out, the entire process group is cleanly terminated, leaving no orphaned child processes running in the background.
3. **Correct Project Instruction Discovery (C1):** When running an agent in a deeply nested subdirectory, it correctly walks up from the git root towards the current working directory, prioritizing instructions deeper in the tree, exactly as defined by the spec.
4. **Auto-repairing Tool Calls (U14):** An LLM returns a slightly malformed JSON payload for a tool call (e.g., trailing commas, unescaped quotes). The engine automatically repairs it using the `repair_tool_call` mechanism before throwing an `InvalidRequestError`.

---

## Architecture

### Module Layout & Changes

No new architectural patterns are introduced. We will surgically patch existing systems to align with the specs:

- **Redacted Thinking (U18):** Modify `RedactedThinkingContentPart` in `src/llm/adapters/types.ts` to include an opaque `data` string field. Update `src/llm/adapters/anthropic.ts` to map this field to and from the API payload.
- **Process Groups (C8):** Modify shell execution in `src/agent-loop/execution-environment.ts` and `src/handlers/tool.ts`. Set `detached: true` in `execa` options. When aborting, use `process.kill(-child.pid)` to terminate the process group leader and all descendants.
- **Document Walk Direction (C1):** Refactor `src/agent-loop/project-instructions.ts`. Identify the git root, collect paths down to the `cwd`, and load instructions in that precise order.
- **Tool Repair & Validation (U13, U14):** Introduce `repair_tool_call` in the LLM execution pipeline. Add a validation step checking `^[a-zA-Z][a-zA-Z0-9_]*$` (max 64 chars) for tool names during registry insertion and tool execution.
- **Default Limits (C6/C7):** Adjust defaults in `SessionConfig` (`src/agent-loop/types.ts`) to `0` (unlimited).
- **Error Retryability (U15):** Explicitly set `retryable: false` for `TimeoutError` (HTTP 408) in `src/llm/errors.ts`.
- **Model Catalog (U3):** Add `gpt-5.2-*`, `claude-opus-4.6`, and `gemini-3.*` variants to `src/llm/catalog.ts`.
- **Engine Events (A3):** Add `CheckpointSaved` to the `EngineEvent` union in `src/engine/events.ts` and emit it directly after `cocoon.ts` confirms an atomic write.

---

## Implementation Phases

### Phase 1: Execution Environment & Core Settings (~25%)

**Files:** `src/agent-loop/project-instructions.ts`, `src/agent-loop/types.ts`, `src/agent-loop/execution-environment.ts`, `src/handlers/tool.ts`

**Tasks:**
- [ ] Fix **C1**: Rewrite the filesystem traversal in `project-instructions.ts` to walk from Git root -> CWD, replacing the inverted logic. Update tests.
- [ ] Fix **C6/C7**: Change default `max_turns` and `max_tool_rounds_per_input` to `0` in `src/agent-loop/types.ts`.
- [ ] Fix **C8**: Update `execa` calls in `LocalExecutionEnvironment` and `ToolHandler` to include `detached: true`. Add cleanup logic to catch SIGTERM/timeout and execute `kill(-pid)` for the process group.

### Phase 2: LLM Adapters & Tooling (~40%)

**Files:** `src/llm/adapters/types.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/errors.ts`, `src/llm/catalog.ts`, `src/agent-loop/tools/spawn-agent.ts`, `src/llm/tools.ts`, `src/agent-loop/tool-registry.ts`

**Tasks:**
- [ ] Fix **U18**: Add `data` field to `RedactedThinkingContentPart`. Update Anthropic adapter to parse it from responses and inject it into requests.
- [ ] Fix **U15**: Change `TimeoutError` (408) to set `retryable: false`. Update HTTP status mapping.
- [ ] Fix **U3**: Append missing next-gen models to `src/llm/catalog.ts`.
- [ ] Fix **C2**: Add `max_turns` to the schema and execution logic of `src/agent-loop/tools/spawn-agent.ts`.
- [ ] Fix **U13**: Enforce tool name validation regex (`^[a-zA-Z][a-zA-Z0-9_]*$`, max 64) in `ToolRegistry.register()`.
- [ ] Fix **U14**: Implement `repair_tool_call` utility. Catch JSON parse errors in LLM adapter responses, run repair heuristics (fix trailing commas, unescaped quotes), and retry parsing.

### Phase 3: Engine Observability (~15%)

**Files:** `src/engine/events.ts`, `src/engine/engine.ts`, `src/checkpoint/cocoon.ts`

**Tasks:**
- [ ] Fix **A3**: Add `CheckpointSaved` event definition to `src/engine/events.ts`.
- [ ] Update engine loop to emit `CheckpointSaved` with the updated cocoon metadata immediately after checkpoint write.

### Phase 4: Verification & Testing (~20%)

**Files:** `test/integration/*`, `test/llm/*`, `test/agent-loop/*`

**Tasks:**
- [ ] Write integration test verifying Anthropic `redacted_thinking` data is preserved across a multi-turn conversation.
- [ ] Write test validating process group kill behavior (spawn a script that spawns `sleep 60`, timeout, ensure `sleep 60` is dead).
- [ ] Write unit test for `repair_tool_call` fixing malformed JSON.
- [ ] Validate all changed defaults and parameters via existing test suites.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/project-instructions.ts` | Modify | Reverse walk direction (Git root to CWD) |
| `src/agent-loop/types.ts` | Modify | Update default limits (max_turns, etc.) |
| `src/agent-loop/execution-environment.ts` | Modify | Add `detached: true` and process group termination |
| `src/handlers/tool.ts` | Modify | Add `detached: true` and process group termination |
| `src/llm/adapters/types.ts` | Modify | Add `data` to `RedactedThinkingContentPart` |
| `src/llm/adapters/anthropic.ts` | Modify | Support redacted thinking round-tripping |
| `src/llm/errors.ts` | Modify | Update `TimeoutError` retryability |
| `src/llm/catalog.ts` | Modify | Add missing models |
| `src/agent-loop/tools/spawn-agent.ts` | Modify | Add `max_turns` parameter |
| `src/llm/tools.ts` | Modify | Add tool name validation logic |
| `src/agent-loop/tool-registry.ts` | Modify | Implement tool name regex + `repair_tool_call` fallback |
| `src/engine/events.ts` | Modify | Add `CheckpointSaved` event type |
| `src/engine/engine.ts` | Modify | Emit `CheckpointSaved` on checkpoint success |

---

## Definition of Done

- [ ] High-severity gaps U18, U15, C1, and C6/C7 are fully resolved in code.
- [ ] Medium-severity gaps A3, C2, C8, U3, U14, and U13 are fully resolved in code.
- [ ] Unit tests added for Anthropic `redacted_thinking` data preservation.
- [ ] Unit tests added verifying process group termination ensures child processes are killed.
- [ ] Unit tests added for `repair_tool_call` handling common JSON format errors.
- [ ] `vitest` suite passes with zero regressions.
- [ ] When the compliance script runs against this branch, the 10 targeted gaps are formally moved to the "IMPLEMENTED" list.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `process.kill(-pid)` behaves differently on Windows or macOS | Medium | Medium | Abstract the process group kill logic. Test explicitly on UNIX environments, fallback gracefully on non-UNIX platforms where detached process groups operate differently. |
| Inverting `project-instructions.ts` path lookup breaks existing tests | High | Low | Review and update all `project-instructions.test.ts` fixtures to match the new root-to-leaf resolution ordering. |
| Tool repair logic incorrectly mutates valid strings | Low | Medium | Use strict AST-based or well-known regex-based JSON fixers (e.g., jsonrepair package or equivalent) rather than blind string replacements. |

---

## Dependencies

- No new external runtime dependencies required.
- Standard `vitest` updates for test coverage.
