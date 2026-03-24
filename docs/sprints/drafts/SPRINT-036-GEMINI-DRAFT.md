# Sprint 036 — Pici Feedback: Polish, Resilience, and Usability

## Overview

**Goal:** Address all 11 issues (7 code bugs and 6 documentation/UX improvements) reported by a real user attempting to build a pipeline with nectar for the "pici" project. This sprint focuses on making the nectar CLI more robust, intuitive, and "super slick," ensuring that user-authored `.dot` pipelines execute predictably and failures are easily diagnosed.

**Motivation:**
A real-world usage attempt of nectar exposed several friction points: silent agent failures, orphaned hanging processes due to unenforced timeouts, unintended fan-outs after failure, and misleading validation messages. The user noted that while the concept is powerful, these issues made debugging difficult. By addressing these 13 items (categorized into bugs and doc improvements), we ensure nectar is reliable, adheres strictly to the Attractor spec, and provides a polished developer experience.

## Use Cases

1. **Functional Built-in Agents:** A user creates a `box` node with a `prompt`. The built-in agent automatically has access to file system tools (read, write) and successfully fulfills the prompt instead of exiting instantly.
2. **Clear Agent Failure Diagnostics:** If an agent session fails or finishes with 0 tool calls, the log and node outcome explicitly include the agent's text response, explaining *why* it failed (e.g., misunderstanding the prompt, missing context).
3. **Fail-Fast Fan-Outs:** A pipeline automatically stops downstream execution when a predecessor node fails, preventing cascading failures across parallel branches.
4. **Tool Command Artifact Verification:** A `tool_command` node (e.g., executing a CLI tool) can specify an `assert_exists` attribute. If the command exits 0 but the expected files are not created, the node is marked as failed.
5. **Robust Timeout Enforcement:** A `tool_command` that hangs (e.g., an infinite loop in a browser subprocess) is properly terminated when it exceeds its `timeout` attribute. Nectar terminates the entire process group (SIGTERM followed by SIGKILL), preventing zombie processes.
6. **Honored Model Selection:** The `model` attribute on a node correctly dictates which LLM (e.g., `claude-opus-4-6`, `gpt-4o`) the built-in agent uses.
7. **Diamond Prompts Evaluated:** Diamond-shaped nodes with a `prompt` actually run an LLM session to evaluate the condition dynamically, rather than instantly succeeding without evaluation.
8. **Intuitive Validation Messages:** If a user puts a `tool_command` on a `box` node, validation explicitly suggests changing the shape to `parallelogram`, rather than complaining about a missing `prompt`.
9. **Executable Validation:** Nectar checks the user's `PATH` during validation to ensure the executables referenced in `tool_command` nodes exist, failing fast before the pipeline runs.
10. **Resume Discoverability:** When a user attempts to resume a pipeline after modifying the `.dot` file, the hash mismatch error explicitly instructs them to use the `--force` flag.

## Architecture

### Design Decisions

**1. BUG-1: Box nodes provisioned with default tools**
Instead of rejecting `box` nodes with only a `prompt`, we will equip the built-in `codergen` agent with default file system tools (e.g., read/write file, run command). If a user provides a `prompt`, the agent should have the basic capabilities to execute it.

**2. BUG-2: Surface Agent Text Responses**
When an agent session completes (especially when wilting with 0 tool calls), the `codergen` handler will extract the final text response from the LLM and attach it to the `notes` field of the `NodeOutcome` (standardized in Sprint 035). This ensures it appears in `status.json` and the CLI output.

**3. BUG-3: Strict Edge Selection on Failure**
The engine's `edge-selector` will be updated to enforce strict failure boundaries. If a node fails, the engine will *only* traverse edges explicitly marked for failure (or catch-all error handlers). Default fan-out edges will not be traversed if the predecessor node's outcome is a failure.

**4. BUG-4: `assert_exists` Post-Conditions**
We will introduce an `assert_exists` attribute for `parallelogram` nodes. After the `tool_command` exits with code 0, the `tool` handler will verify the existence of the specified file path(s). If missing, the node outcome becomes a failure, preventing false positives from non-interactive CLI agents.

**5. BUG-5: Process Group Timeout Enforcement**
The `tool` handler will spawn subprocesses in their own process group (`detached: true` in Node.js). When the `timeout` is reached, nectar will send `SIGTERM` to `-PGID`, wait a grace period, and send `SIGKILL` to `-PGID`, ensuring all child processes (like `agent-browser`) are cleaned up.

**6. BUG-6: Model Attribute Propagation**
The `codergen` handler will parse the `model` attribute from the node definition and pass it into the `AgentSession` initialization, overriding the default `claude-sonnet` model.

**7. BUG-7: Diamond LLM Evaluation**
Diamond nodes with a `prompt` attribute will instantiate an LLM session to evaluate the prompt as a condition. The prompt will be injected with context, and the LLM will be instructed to return a boolean or categorical value that matches the outgoing edge labels.

**8. DOC-1 & DOC-3: Shape/Attribute Validation**
The garden parser and validation logic will be enhanced. If a node has `tool_command` but is shaped like a `box`, it will emit a warning: "Node has tool_command but box shape — did you mean shape=parallelogram?".

## Implementation

### Phase 1: High-Severity Code Bugs (BUG-1, BUG-2, BUG-4, BUG-5)

**Files:** `src/handlers/codergen.ts`, `src/agent-loop/session.ts`, `src/handlers/tool.ts`, `src/agent-loop/events.ts`

**Tasks:**
- [ ] **BUG-1 (Agent Tools):** In `src/handlers/codergen.ts`, ensure that when initializing an agent session for a `box` + `prompt` node, the session is provisioned with default filesystem tools from the tool registry.
- [ ] **BUG-2 (Silent Agent Failures):** In `src/handlers/codergen.ts`, capture the final textual response from the agent session. If the session yields 0 tool calls or fails, attach this text to the `notes` field of the returned `NodeOutcome`.
- [ ] **BUG-4 (Post-Conditions):** In `src/handlers/tool.ts`, read the `assert_exists` attribute (comma-separated paths). After a successful exit code (0), use `fs.existsSync` to verify the artifacts. If any are missing, return a failure outcome with an appropriate note.
- [ ] **BUG-5 (Timeout Enforcement):** In `src/handlers/tool.ts`, modify the `spawn` call to use `detached: true`. Implement a timeout mechanism that calls `process.kill(-subprocess.pid, 'SIGTERM')`, waits 3 seconds, and follows up with `SIGKILL` to reliably terminate the entire process group.

### Phase 2: Medium/Low Severity Bugs (BUG-3, BUG-6, BUG-7)

**Files:** `src/engine/edge-selector.ts`, `src/engine/engine.ts`, `src/llm/catalog.ts`, `src/handlers/conditional.ts`

**Tasks:**
- [ ] **BUG-3 (Fan-Out Failure Halt):** In `src/engine/edge-selector.ts`, modify the logic to ensure that if the current node's outcome is `failure`, default unlabeled edges are NOT selected. Only edges specifically meant for failure routing should be traversed.
- [ ] **BUG-6 (Model Selection):** In `src/handlers/codergen.ts`, retrieve the `model` attribute from the node definition. Pass this into the adapter initialization to ensure the correct LLM is used.
- [ ] **BUG-7 (Diamond Prompts):** In `src/handlers/conditional.ts`, if a `prompt` attribute exists, spawn an LLM evaluation session instead of instantly succeeding. The LLM's output should determine the selected edge.

### Phase 3: Documentation and UX (DOC-1 to DOC-6)

**Files:** `src/garden/validator.ts`, `src/cli/commands/resume.ts`, `README.md`, `docs/validation-report.md`

**Tasks:**
- [ ] **DOC-1 & DOC-3 (Shape Warning):** Update `src/garden/validator.ts` to check for the `box` + `tool_command` anti-pattern and yield a specific warning about changing the shape to `parallelogram`.
- [ ] **DOC-5 (Executable PATH Check):** In `src/garden/validator.ts`, parse the first token of `tool_command` attributes and verify its existence on the system `PATH` using `which` or `command -v`. Emit a warning if missing.
- [ ] **DOC-6 (Linting cross-platform flags):** Add a simple regex check in the validator to flag known GNU-specific flags (e.g., `grep -oP`) on macOS platforms, emitting a mild warning.
- [ ] **DOC-4 (Resume Discoverability):** In `src/cli/commands/resume.ts`, update the hash mismatch error message to prominently suggest using the `--force` flag.
- [ ] **DOC-2 (Documentation):** Update `README.md` to clearly state that `tool_command` runs in a non-interactive shell where shell aliases are not expanded, and document the difference between `box` and `parallelogram` shapes.

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/handlers/codergen.ts` | Modify | Attach tools to built-in agent (BUG-1); Extract LLM response to `notes` (BUG-2); Pass `model` attr to LLM (BUG-6) |
| `src/handlers/tool.ts` | Modify | Process group timeout enforcement (BUG-5); `assert_exists` artifact verification (BUG-4) |
| `src/engine/edge-selector.ts` | Modify | Stop default fan-out on predecessor failure (BUG-3) |
| `src/handlers/conditional.ts` | Modify | Evaluate diamond prompts dynamically via LLM (BUG-7) |
| `src/garden/validator.ts` | Modify | Better warnings for box/parallelogram mixups (DOC-1, DOC-3); PATH executable validation (DOC-5); Flag linting (DOC-6) |
| `src/cli/commands/resume.ts` | Modify | Improve hash mismatch error message to mention `--force` (DOC-4) |
| `README.md` | Modify | Document non-interactive shell limitations (DOC-2) and shape differences (DOC-3) |
| `test/handlers/tool.test.ts` | Add | Tests for PGID termination and `assert_exists` |
| `test/handlers/codergen.test.ts` | Add | Tests for tool provisioning, model selection, and failure text surfacing |
| `test/engine/edge-selector.test.ts` | Add | Test confirming fan-out halts on failure |

## Definition of Done

- [ ] All 7 code bugs (BUG-1 to BUG-7) are fixed and have corresponding unit/integration tests.
- [ ] Process group termination (`-PGID`) is verified for `tool_command` timeouts.
- [ ] `assert_exists` correctly validates artifact creation.
- [ ] Unlabeled edges are not traversed if the predecessor node fails.
- [ ] Validation warnings accurately guide the user regarding shape vs. attribute mismatches.
- [ ] Executable `PATH` checks run during `.dot` validation.
- [ ] Resume command error messages explicitly point out `--force`.
- [ ] The `README.md` is updated to clarify non-interactive shells and node shapes.
- [ ] `npm test` passes with zero failures.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Process group termination (`-PGID`) fails on Windows | High | Medium | Check `os.platform()`. Process groups work differently on Windows. Fall back to `taskkill /tree` or standard `kill()` if on Windows. |
| `assert_exists` causes false negatives | Medium | Medium | Document that paths are relative to the pipeline's working directory. Allow a comma-separated list and ensure trimming. |
| LLM diamond evaluation introduces latency | High | Low | Evaluating conditions with an LLM will be slower than static checks. This is expected and opt-in by using the `prompt` attribute on a diamond. |
| Strict failure routing breaks existing pipelines | Medium | High | Existing pipelines might rely on downstream nodes running regardless of predecessor status. This aligns behavior with the spec; users must add explicit error edges if they want continuation. |

## Security

- **Process Isolation:** Utilizing process group termination ensures that we do not leave orphaned processes (like `agent-browser`) consuming system resources indefinitely.
- **Command Execution:** `tool_command` execution remains user-authored within `.dot` files. No new shell injection vectors are introduced.

## Dependencies

- **Sprint 035 Completion:** This sprint assumes that Sprint 035 has successfully landed, meaning the core engine's `status.json` and node outcome contracts are stable, and the test suite is green.

## Open Questions

1. **BUG-1 resolution approach:** *Decision made:* Equip the `box` node with default file system tools. It aligns with the user's expectation that a default agent should be able to fulfill basic prompts without falling back to shell commands.
2. **BUG-7 diamond semantics:** *Decision made:* Dynamic LLM evaluation. If a user provides a `prompt`, it implies they want the LLM to make the routing decision based on the text.
3. **BUG-4 post-conditions:** *Decision made:* Implement an explicit `assert_exists` attribute rather than guessing.
4. **DOC-3 shape auto-detection:** *Decision made:* Strict manual shape specification with clear validation warnings. Auto-inferring shapes breaks the visual contract of the `.dot` file.
5. **Scope management:** The scope is large but addressable in a single sprint since the fixes are highly localized (mostly in `tool.ts`, `codergen.ts`, and `validator.ts`).
