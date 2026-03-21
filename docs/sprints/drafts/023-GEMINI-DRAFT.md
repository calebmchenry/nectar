# Sprint NEXT: Core Expressivity & Agent Loop Refinement

## Overview

**Goal:** Resolve the most impactful expressivity and usability gaps in the Nectar orchestration engine and agent loop. This sprint unlocks complex pipeline routing, gives AI agents more powerful and efficient file manipulation tools, and provides developers with a complete high-level API and configurable session constraints.

**Scope:**
- **GAP-1:** Condition Expression Language operators (`<`, `>`, `<=`, `>=`, `NOT`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `EXISTS`) and deep variable references (`steps.*`, `artifacts.*`).
- **GAP-3:** Automatic tool execution loop for the high-level `generate()` function in the Unified LLM client.
- **GAP-5:** `replace_all` parameter for the `edit_file` tool to allow bulk string replacements.
- **GAP-6:** Modification time (mtime) sorting for the `glob` tool to prioritize recent files.
- **GAP-8:** Full exposure of `SessionConfig` fields (`max_command_timeout_ms`, `reasoning_effort`, `tool_output_limits`, `tool_line_limits`, `enable_loop_detection`, `loop_detection_window`).

**Out of scope:**
- Unified LLM Content Types for AUDIO and DOCUMENT (GAP-2)
- Gemini Profile Extended Tools like `web_fetch` (GAP-4)
- New Error Subtypes (GAP-7)
*(These will be addressed in a future LLM Capabilities Expansion sprint).*

---

## Use Cases

1. **Complex Routing:** A user defines a conditional edge with `condition="artifacts.score > 0.8 && steps.review.output CONTAINS 'approved'"`. The pipeline routes accurately without requiring a custom script node to evaluate the logic.
2. **High-Level Agent Run:** A developer imports `generate()` from the Unified LLM SDK. It automatically executes multiple rounds of LLM tool calls (e.g., read a file, run a shell command) and returns only when the model has a final natural text response.
3. **Batch Refactoring:** An agent identifies a deprecated function used 14 times in a file. It calls `edit_file` with `replace_all=true` to update all occurrences in a single, token-efficient tool call.
4. **Recent Files Discovery:** An agent calls `glob` on `src/**/*.ts`. The results are returned with the most recently edited files first, allowing the agent to find active work without consuming context on alphabetical lists of legacy files.
5. **Configurable Session Constraints:** The HTTP server spawns a `codergen` session and safely enforces a strict `max_command_timeout_ms` of 30 seconds and a custom `loop_detection_window` to prevent runaway API costs, fully controlled via `SessionConfig`.

---

## Architecture

### Condition Expression Parser Update
- The grammar in `src/engine/conditions.ts` will be expanded to support binary comparison operators (`<`, `>`, `<=`, `>=`), string matching (`CONTAINS`, `STARTS_WITH`, `ENDS_WITH`), and the unary `NOT` and `EXISTS` operators.
- Variable resolution will be enhanced to safely query `steps.<node_id>.*` and `artifacts.<key>` by inspecting the `RunState` and context store. Type coercion (e.g., string to float for numeric comparisons) will be handled strictly but automatically.

### Unified LLM `generate()` Tool Loop
- `src/llm/client.ts` will wrap the existing `generateUnified()` call in an asynchronous `while` loop.
- It will inspect `StopReason`. If `tool_use`, it will automatically dispatch the calls to provided tools (using existing batch execution concurrency), append the `tool_result` messages to the history, and invoke the model again, up to `max_iterations`.

### Tool Enhancements
- **glob:** `src/agent-loop/tools/glob.ts` will be modified to use `fs.stat` (or `fs.promises.stat`) to collect `mtimeMs` for all matches, then sort the results descending before truncation.
- **edit_file:** `src/agent-loop/tools/edit-file.ts` will extend its JSON schema with `replace_all`. If true, it will use global regex replacement (via `String.prototype.replaceAll`) instead of rejecting multiple matches.

### SessionConfig Expansion
- `src/agent-loop/types.ts` will add the missing fields to `SessionConfig`.
- Hardcoded constants in `src/agent-loop/loop-detection.ts` and `src/agent-loop/types.ts` will be removed or refactored to act as default fallbacks when `SessionConfig` overrides are not explicitly provided.

---

## Implementation Phases

### Phase 1: Engine Expressivity (GAP-1)
**Files:** `src/engine/conditions.ts`, `test/engine/conditions.test.ts`
**Tasks:**
- [ ] Implement regex/tokenizer enhancements for new operators.
- [ ] Add evaluation logic for comparisons (with numeric coercion).
- [ ] Add evaluation logic for string operations.
- [ ] Implement deep object path resolution for `steps.*` and `artifacts.*`.
- [ ] Add exhaustive unit tests covering all new operators and edge cases (e.g., comparing missing variables).

### Phase 2: Agent Tools Refinement (GAP-5, GAP-6)
**Files:** `src/agent-loop/tools/edit-file.ts`, `src/agent-loop/tools/glob.ts`, `test/agent-loop/tools/edit-file.test.ts`, `test/agent-loop/tools/glob.test.ts`
**Tasks:**
- [ ] Update `edit_file` schema and execution logic. Add a test ensuring it replaces exactly `N` occurrences and reports the count in its output.
- [ ] Update `glob` to fetch stats and sort by `mtime`. Add a test with mock files created at different timestamps to verify sorting order.

### Phase 3: Config & High-Level API (GAP-3, GAP-8)
**Files:** `src/llm/client.ts`, `src/agent-loop/types.ts`, `src/agent-loop/session.ts`, `src/agent-loop/loop-detection.ts`, `src/agent-loop/execution-environment.ts`
**Tasks:**
- [ ] Expand `SessionConfig` interface.
- [ ] Plumb `SessionConfig` values into the loop detection instance, truncation limits, and execution environment timeout logic.
- [ ] Rewrite `generate()` in `client.ts` to implement the autonomous tool loop.
- [ ] Write tests ensuring the loop terminates correctly on `max_iterations` and handles tool errors gracefully.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/conditions.ts` | Modify | Add operators and variable resolution logic |
| `src/agent-loop/tools/edit-file.ts` | Modify | Implement `replace_all` logic and schema |
| `src/agent-loop/tools/glob.ts` | Modify | Add `fs.stat` mtime sorting |
| `src/agent-loop/types.ts` | Modify | Expand `SessionConfig` properties |
| `src/agent-loop/session.ts` | Modify | Pass expanded config down to subsystems |
| `src/agent-loop/loop-detection.ts` | Modify | Accept configurable window size |
| `src/llm/client.ts` | Modify | Implement auto-tool loop in `generate()` |
| `test/engine/conditions.test.ts` | Modify | Test new operators and variable scopes |
| `test/agent-loop/tools/edit-file.test.ts` | Modify | Test `replace_all` functionality |
| `test/agent-loop/tools/glob.test.ts` | Modify | Test mtime sorting logic |
| `test/llm/client.test.ts` | Modify | Test high-level tool execution loop |

---

## Definition of Done

- [ ] `condition="artifacts.score > 0.8"` correctly parses and routes based on context values.
- [ ] `condition="steps.review.output CONTAINS 'LGTM'"` correctly resolves the historical node output and routes.
- [ ] `edit_file` successfully accepts `replace_all: true` and replaces multiple instances in a file.
- [ ] `glob` returns recently modified files at the top of the array before applying limits.
- [ ] `SessionConfig` allows overriding `max_command_timeout_ms` and `loop_detection_window`.
- [ ] Calling `generate()` with tools automatically executes them and returns only when the final answer is generated.
- [ ] All new code has >90% test coverage.
- [ ] Existing pipelines and unit tests pass without regression.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Unsafe Condition Execution | Low | High | Do not use `eval()` or `new Function()`. Stick to the strict allowlist parser and explicit token evaluation. |
| Tool Loop Infinite Recursion | Medium | High | The `generate()` wrapper must strictly enforce `max_iterations` and abort with a clear error if exceeded. |
| Glob Performance on Large Dirs | Medium | Medium | Limit `fs.stat` concurrency in `glob`. The tool already respects `.gitignore` which filters out large unneeded directories (e.g., `node_modules`), keeping the stat pool small. |
| Breaking changes in `generate()` | Low | Medium | Ensure existing `generateUnified` interface remains unmutated for direct 1:1 call semantics. The wrapper behavior is standard across providers. |

---

## Dependencies

- No new external libraries or packages are required.
- Depends on the existing Node.js `fs` APIs and the `@ts-graphviz/parser` currently in use.