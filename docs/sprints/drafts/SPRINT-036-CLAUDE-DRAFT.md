# Sprint 036: First Contact — Fix Every Issue a Real User Hit

## Overview

**Goal:** Fix all 7 code bugs and address all 6 documentation/UX improvements reported by the first real user of nectar (the pici project). After this sprint: `box`+`prompt` nodes either work with tools or reject clearly, silent agent failures surface response text, fan-out respects predecessor failure, tool_command nodes can assert artifacts, timeouts are enforced via process-group kills, the `model` attribute is recognized, diamond nodes with prompts evaluate via LLM, and validation messages guide users toward the correct fix.

**Why this sprint, why now:**

1. **First real user feedback.** The pici project represents nectar's first external pipeline. 11 issues were documented during a single session. Every issue is a paper cut that compounds — a user hitting 3–4 of these in sequence would abandon the tool.

2. **Trust erosion from silent failures.** BUG-1 (box+prompt no tools), BUG-2 (no response text on failure), BUG-4 (exit 0 with no artifacts), and BUG-5 (timeout not enforced) all share the same theme: nectar says "success" when nothing happened, or says nothing when something went wrong. These are trust-destroying bugs.

3. **The feedback is specific and actionable.** Every issue includes expected behavior, a workaround, and often a suggested fix. This is the highest-signal feedback nectar will get — addressing it fully demonstrates that user reports drive real change.

4. **Sprint 035 closed the test suite gap.** The suite is green. The foundation is stable. This sprint can focus entirely on correctness and user experience without fighting infrastructure.

**Scope:** Fix BUG-1 through BUG-7. Address DOC-1 through DOC-6. All with tests.

**Out of scope:**
- New node types or shapes
- Web UI changes
- CLI output redesign
- Full `assert_exists` expression language (this sprint adds a simple `assert_files` attribute; a richer expression system is future work)
- Hive/backlog features
- New LLM provider adapters

---

## Use Cases

1. **Box+prompt node runs an agent with file tools.** A user writes `node [shape=box, prompt="Read config.yaml and summarize it"]`. The agent session starts with `read_file`, `write_file`, `edit_file`, `shell`, `grep`, `glob`, and `list_dir` tools registered. The agent reads the file and returns a summary. If the user *only* wants text generation without tools, they can set `tools="none"`.

2. **Agent failure surfaces the response text.** An agent finishes with 0 tool calls and wilts. The log shows: `Agent finished: 1 turns, 0 tool calls (0.23s) — Response: "I don't have access to the file system..."`. The user can immediately see the agent misunderstood or lacked capability.

3. **Fan-out stops when predecessor fails.** `pick_backlog_item` wilts. `fan_out_drafts` does not start. The pipeline halts at the failure with a clear message. Downstream nodes are not attempted unless a failure edge explicitly routes there.

4. **Tool command with assertion catches silent success.** A node has `tool_command="claude -p 'Write a draft'"` and `assert_files="docs/drafts/current-item.md"`. The command exits 0 but creates no files. Nectar checks the assertion, finds the file missing, and marks the node as failed with: `"Assertion failed: expected file 'docs/drafts/current-item.md' does not exist"`.

5. **Timeout kills runaway process.** `validate_ui [timeout="900s"]` starts a Gemini CLI process. After 15 minutes, nectar sends SIGTERM to the process group. After a 5-second grace period, SIGKILL. The node is marked as failed with `"Command timed out after 900000ms."`.

6. **Model attribute controls the LLM.** `review [shape=box, prompt="Review the code", model="claude-opus-4-6"]` spawns an agent session using `claude-opus-4-6` instead of the default. The `model` attribute (in addition to `llm_model` and `llm.model`) is recognized by the parser.

7. **Diamond+prompt evaluates via LLM.** `check_backlog [shape=diamond, prompt="Does the backlog have actionable items?"]` sends the prompt to the configured LLM. The response determines the conditional outcome: if the LLM says yes, edges conditioned on `outcome.status=success` fire. If no, `outcome.status=failure` fires. The evaluation is logged.

8. **Validation warns about shape/attribute mismatches.** A user writes `my_node [shape=box, tool_command="echo hi"]`. Validation emits: `"Node 'my_node' has tool_command but box shape — did you mean shape=parallelogram?"` instead of the confusing `PROMPT_MISSING` warning.

9. **Validation checks tool_command executables on PATH.** `my_node [shape=parallelogram, tool_command="codex exec 'do stuff'"]` triggers a validation info diagnostic: `"tool_command executable 'codex' not found on PATH"` if codex is not installed.

10. **Resume --force is discoverable.** When a graph hash mismatch occurs on resume, the error message reads: `"Graph hash mismatch for run 'abc123'. Run 'nectar resume abc123 --force' to override."` — with the exact command to run.

---

## Architecture

### Design Decisions

**1. Box+prompt nodes get full tool access by default.**

The codergen handler already registers 11 tools (7 core + 4 subagent) when it creates an `AgentSession` in `executeWithAgentSession()` (codergen.ts:111–126). The bug is NOT that tools aren't registered — the exploration agent confirmed tools ARE registered. The likely root cause is that the `ProviderProfile.visibleTools` filter in `AgentSession.getVisibleToolDefinitions()` (session.ts:366–392) restricts visibility based on the profile, and the default profile for box+prompt nodes may not include the core tools.

**Fix approach:** Ensure the default provider profile used by codergen always includes the 7 core file system tools. Add a `tools` attribute to nodes (`tools="none"` for text-only generation, `tools="all"` default). When `tools="none"`, create a session with an empty tool registry.

**2. Agent response text is always surfaced on failure.**

Currently, `processWorkItem()` in session.ts captures `lastText` (line 652) and returns it in `buildResult()` as `final_text` (line 1302). The codergen handler stores this as `${node.id}.response` in context (codergen.ts:226). But the engine event log and CLI renderer don't display it on failure.

**Fix approach:** When a node fails and the handler returns `final_text` or the agent response, include it in the `node_completed` event's `notes` field and in the `status.json` artifact. The CLI renderer already displays notes — this makes failure diagnosis automatic.

**3. Fan-out requires predecessor success by default.**

The engine's main loop (engine.ts:604) calls `selectNextEdge()` after a successful outcome. For failures (engine.ts:541), it calls `resolveFailureTarget()` and either routes to a failure edge or halts. The bug is in parallel branch execution: `executeNodeSequence()` (engine.ts:1496–1726) does not check predecessor status before executing each node in the sequence.

**Fix approach:** In `executeNodeSequence()`, after each node completes, check `outcome.status`. If `'failure'` and no failure edge exists for that node within the branch, stop the branch sequence and propagate the failure. Do not execute downstream nodes. The main engine loop already handles this correctly — the fix is making branch sequences consistent with it.

**4. Tool command artifact assertions via `assert_files` attribute.**

Rather than implementing a full assertion expression language, add a simple `assert_files` attribute that accepts a comma-separated list of file paths. After a tool_command node exits 0, check that each listed file exists. If any is missing, override the outcome to failure with a clear message.

**Why not full expressions?** The pici feedback specifically mentions `assert_exists="docs/drafts/current-item.md"`. A comma-separated file list covers the reported use case without scope creep. A richer expression language can be added later.

**5. Timeout enforcement via process-group SIGTERM/SIGKILL.**

The `runScript()` function in `src/process/run-script.ts` passes `timeout` to `execa`, which should enforce it. However, with `shell: true`, `execa` kills the shell process (`sh`) but may leave grandchild processes alive. This is the root cause — the Gemini CLI process was a grandchild of `sh`.

**Fix approach:** In `runScript()`, enable process-group killing. The `execa` library supports `killSignal` and `forceKillAfterDelay`. Additionally, ensure the process is spawned as a process group leader so that the entire tree can be killed. Use `execa`'s `cleanup: true` (already default) combined with signal forwarding. If `execa`'s built-in process group kill is insufficient, fall back to explicit `process.kill(-pid, 'SIGTERM')` on timeout.

**6. `model` attribute recognized as alias for `llm_model`.**

The garden parser (parse.ts:160) reads `llm_model` and `llm.model` but NOT the plain `model` attribute. Users naturally write `model="claude-opus-4-6"` because that's the Graphviz attribute convention (short, readable).

**Fix approach:** Add `model` as a third alias in `parse.ts:160`. Resolution order: `llm_model` > `llm.model` > `model`. This is a one-line fix that prevents confusion.

**7. Diamond+prompt nodes evaluate via LLM.**

Currently, `ConditionalHandler.execute()` (conditional.ts:4–7) always returns `{ status: 'success' }` and ignores all input. Diamond nodes only work via edge conditions evaluated in `selectNextEdge()`.

**Fix approach:** When a diamond node has a `prompt` attribute, the conditional handler sends the prompt to the LLM and parses the response as a boolean condition. Specifically:
- If `prompt` is set, create a single-turn LLM call (no agent session) that evaluates the prompt.
- Parse the response for affirmative/negative signals (yes/no, true/false, pass/fail).
- Return `status: 'success'` for affirmative, `status: 'failure'` for negative.
- Store the LLM response in context as `${node.id}.evaluation`.
- If `prompt` is not set, behavior is unchanged (always success, edge conditions decide routing).

**8. Validation messages guide users to the correct fix.**

The current `PROMPT_MISSING` warning (validate.ts:306–315) says "has no prompt attribute" and suggests adding a prompt. But when a box node has `tool_command`, the real issue is the shape. Additionally, there's no validation for tool_command executables existing on PATH.

**Fix approach:**
- Add a new `SHAPE_MISMATCH` warning: when a `codergen` (box) node has `tool_command`, suggest changing shape to `parallelogram`.
- Add a new `EXECUTABLE_NOT_FOUND` info diagnostic: extract the first token of `tool_command` and check `which` on PATH.
- Improve the `PROMPT_MISSING` fix text to mention shape alternatives.
- Add a `SHELL_ALIAS_WARNING` info diagnostic in docs/guides.

---

## Implementation

### Phase 1: High-Severity Bug Fixes — BUG-1, BUG-2, BUG-4, BUG-5 (~40%)

**Hard rule:** These are the trust-destroying bugs. Fix all four before moving to Phase 2.

**Files:** `src/handlers/codergen.ts`, `src/agent-loop/session.ts`, `src/handlers/tool.ts`, `src/process/run-script.ts`, `src/engine/engine.ts`, `src/garden/parse.ts`, `src/garden/types.ts`

**Tasks:**

- [ ] **BUG-1: Fix box+prompt agent tool visibility.** In `src/handlers/codergen.ts`, audit the `ProviderProfile` construction (lines 151–172) to ensure `visibleTools` includes all 7 core tools by default. In `src/agent-loop/session.ts`, verify `getVisibleToolDefinitions()` (lines 366–392) returns core tools when no visibility filter is applied. Add a `tools` attribute to the garden parser (`src/garden/parse.ts`) supporting `"all"` (default) and `"none"`. When `tools="none"`, codergen creates an empty `ToolRegistry()`. Add test: box+prompt node → agent session has ≥7 tool definitions.

- [ ] **BUG-2: Surface agent response text on failure.** In `src/handlers/codergen.ts`, when `result.status === 'failure'` or `result.tool_call_count === 0` (line 211+), include `result.final_text` in the returned `NodeOutcome.notes` field. In `src/engine/engine.ts`, ensure `notes` from the handler outcome is written to the `node_completed` event and `status.json`. Add test: agent finishes with 0 tool calls → `node_completed` event contains the agent's response text in `notes`.

- [ ] **BUG-4: Add `assert_files` attribute for tool_command nodes.** In `src/garden/parse.ts`, parse a new `assert_files` attribute (comma-separated file paths) on tool nodes. In `src/garden/types.ts`, add `assertFiles?: string[]` to `GardenNode`. In `src/handlers/tool.ts`, after `runScript()` returns exit code 0, check each path in `node.assertFiles` using `fs.access()`. If any file is missing, override outcome to `failure` with message `"Assertion failed: expected file '<path>' does not exist after tool_command completed."`. Add test: tool_command exits 0 but missing asserted file → outcome is failure.

- [ ] **BUG-5: Enforce timeout via process-group kill.** In `src/process/run-script.ts`, update the `execa` call to ensure process-group killing:
  - Add `forceKillAfterDelay: 5000` to send SIGKILL 5s after SIGTERM.
  - Verify `cleanup: true` (default) is active for signal-based cleanup.
  - If `execa`'s built-in kill doesn't terminate grandchild processes, refactor to use `execa` with `detached: true` and manual `process.kill(-child.pid, 'SIGTERM')` on timeout.
  - Add test: start a command that spawns a subprocess, set 1s timeout → both parent and child are killed, `timed_out` is true.

- [ ] **Run `npm test`. All tests must pass. Zero failures.**

### Phase 2: Medium-Severity Bug Fixes — BUG-3, BUG-6, BUG-7 (~25%)

**Files:** `src/engine/engine.ts`, `src/handlers/conditional.ts`, `src/garden/parse.ts`, `src/garden/types.ts`

**Tasks:**

- [ ] **BUG-3: Stop fan-out when predecessor fails.** In `src/engine/engine.ts`, locate `executeNodeSequence()` (line 1496+). After each node execution within a branch, check if `outcome.status === 'failure'`. If failure and no failure edge is defined for the node within the branch subgraph, stop the branch with the failure outcome. Do NOT execute subsequent nodes in the sequence. Add test: branch sequence where node A fails → node B is never executed. Add test: branch sequence where node A fails but has failure edge → failure edge target is executed.

- [ ] **BUG-6: Recognize `model` attribute as alias.** In `src/garden/parse.ts` line 160, add `mergedAttributes.model?.trim()` as a third fallback:
  ```typescript
  const llmModel = mergedAttributes.llm_model?.trim()
    || mergedAttributes['llm.model']?.trim()
    || mergedAttributes.model?.trim()
    || undefined;
  ```
  Add test: node with `model="claude-opus-4-6"` → `node.llmModel === 'claude-opus-4-6'`. Add test: `llm_model` takes precedence over `model`.

- [ ] **BUG-7: Diamond+prompt evaluates via LLM.** Rewrite `src/handlers/conditional.ts` to:
  1. Check if `input.node.prompt` exists.
  2. If no prompt, return `{ status: 'success' }` (current behavior, unchanged).
  3. If prompt exists, call `input.llm_client.generate()` with a single-turn request: system prompt "You are evaluating a condition. Respond with exactly YES or NO." + user prompt from the node attribute.
  4. Parse response: contains "yes"/"true"/"pass" → success; contains "no"/"false"/"fail" → failure.
  5. Return outcome with `notes` containing the full LLM response and `context_updates` containing `${node.id}.evaluation` = response text.
  6. Update `HandlerExecutionInput` in `src/engine/types.ts` if `llm_client` is not already available to the conditional handler.
  7. Add test: diamond+prompt with mock LLM returning "YES" → success. Diamond+prompt with "NO" → failure. Diamond without prompt → success (backward compat).

- [ ] **Run `npm test`. All tests must pass.**

### Phase 3: Validation and UX Improvements — DOC-1 through DOC-6 (~25%)

**Files:** `src/garden/validate.ts`, `src/runtime/pipeline-service.ts`, `test/garden/validate.test.ts`

**Tasks:**

- [ ] **DOC-1: Improve PROMPT_MISSING and add SHAPE_MISMATCH.** In `src/garden/validate.ts`:
  - Add a new check before `PROMPT_MISSING` (around line 306): if `node.kind === 'codergen'` and node has `tool_command`, emit `SHAPE_MISMATCH` warning: `"Node '${node.id}' has tool_command but box shape — did you mean shape=parallelogram?"` with fix: `"Change shape to parallelogram, or remove tool_command and use prompt instead."`.
  - Update `PROMPT_MISSING` fix text (line 315) from `"Set ${node.id} [prompt=...]"` to `"Set ${node.id} [prompt=\"...\"] for LLM execution, or change shape to parallelogram for tool_command execution."`.
  - Add tests for both cases.

- [ ] **DOC-2 + DOC-3: Add documentation comments in validation.** In `src/garden/validate.ts`, add an informational diagnostic when a box node has `tool_command`:
  - `SHELL_ALIAS_INFO`: `"Note: tool_command runs in a non-interactive shell. Shell aliases are not available. Use full command paths and flags."` (severity: info).
  - This complements the `SHAPE_MISMATCH` warning and addresses both DOC-2 and DOC-3.

- [ ] **DOC-4: Improve resume --force error message.** In `src/runtime/pipeline-service.ts` line 280–282, change the error message from:
  ```
  `Graph hash mismatch for run '${options.run_id}'. Original ${cocoon.graph_hash}, current ${nextHash}. Re-run with --force to override.`
  ```
  to:
  ```
  `Graph hash mismatch for run '${options.run_id}'. The garden file has been modified since this run started.\n\nTo resume anyway, run:\n  nectar resume ${options.run_id} --force`
  ```
  Add test: resume with hash mismatch → error message contains `nectar resume <id> --force`.

- [ ] **DOC-5: Validate tool_command executables on PATH.** In `src/garden/validate.ts`, add a new validation rule after the `TOOL_SCRIPT_REQUIRED` check (around line 132):
  - Extract the first whitespace-delimited token from `tool_command`.
  - Skip validation if the token starts with `/`, `./`, or contains path separators (it's an explicit path).
  - Use `child_process.execSync('which <token>')` (wrapped in try/catch) to check PATH availability.
  - If not found, emit `EXECUTABLE_NOT_FOUND` info diagnostic: `"tool_command executable '${executable}' not found on PATH. Ensure it is installed and accessible."`.
  - Severity is `info` (not error) because the PATH at validation time may differ from runtime.
  - Add test with a known-missing executable → diagnostic emitted. Add test with a known-present executable (e.g., `echo`) → no diagnostic.

- [ ] **DOC-6: Cross-platform tool_command linting.** In `src/garden/validate.ts`, add a check for common GNU-specific flags in tool_command:
  - Detect patterns like `grep -P`, `grep -oP`, `sed -i ''` vs `sed -i`, `readlink -f` on macOS.
  - Emit `PLATFORM_SPECIFIC_FLAG` info diagnostic: `"tool_command in node '${node.id}' may use GNU-specific flags (e.g., 'grep -P'). These may not work on macOS/BSD."`.
  - This is best-effort pattern matching — a small regex list of known incompatibilities.
  - Add test with `grep -oP` in tool_command → diagnostic emitted.

- [ ] **Run `npm test`. All tests must pass.**

### Phase 4: Integration Test and Verification (~10%)

**Files:** `test/integration/pici-feedback.test.ts` (create), existing test files

**Tasks:**

- [ ] **Create integration test exercising the pici feedback scenarios.** Create `test/integration/pici-feedback.test.ts` that builds a garden exercising:
  - Box+prompt node → verify agent gets tools and produces output.
  - Tool_command node with assert_files → verify assertion failure when file not created.
  - Diamond+prompt node → verify LLM evaluation with mock provider.
  - Predecessor failure → verify downstream node is NOT executed.
  - Timeout on tool_command → verify process is killed.
  Use `SimulationProvider` for deterministic behavior.

- [ ] **Run `npm run build` — zero TypeScript errors.**
- [ ] **Run `npm test` — all tests pass, zero failures, zero timeouts.**
- [ ] **Verify test count is ≥ pre-sprint count + number of new tests.**

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/handlers/codergen.ts` | Modify | Fix tool visibility for box+prompt; surface response text on failure (BUG-1, BUG-2) |
| `src/agent-loop/session.ts` | Modify | Verify tool definitions returned correctly for default profile (BUG-1) |
| `src/handlers/tool.ts` | Modify | Add `assert_files` post-condition check after exit 0 (BUG-4) |
| `src/process/run-script.ts` | Modify | Enforce process-group kills on timeout via `forceKillAfterDelay` and detached groups (BUG-5) |
| `src/engine/engine.ts` | Modify | Stop branch execution on predecessor failure in `executeNodeSequence()` (BUG-3); surface handler `notes` in events |
| `src/handlers/conditional.ts` | Modify | Evaluate `prompt` via LLM when present on diamond nodes (BUG-7) |
| `src/garden/parse.ts` | Modify | Add `model` as alias for `llm_model` (BUG-6); parse `assert_files` and `tools` attributes (BUG-4, BUG-1) |
| `src/garden/types.ts` | Modify | Add `assertFiles?: string[]` and `tools?: string` to `GardenNode` (BUG-4, BUG-1) |
| `src/engine/types.ts` | Modify | Ensure `llm_client` available in `HandlerExecutionInput` for conditional handler (BUG-7) |
| `src/garden/validate.ts` | Modify | Add `SHAPE_MISMATCH`, `EXECUTABLE_NOT_FOUND`, `PLATFORM_SPECIFIC_FLAG`, `SHELL_ALIAS_INFO` diagnostics (DOC-1–6) |
| `src/runtime/pipeline-service.ts` | Modify | Improve resume hash-mismatch error message with exact command (DOC-4) |
| `test/handlers/codergen.test.ts` | Modify | Test box+prompt tool visibility; test failure response surfacing |
| `test/handlers/tool.test.ts` | Modify | Test assert_files success and failure; test timeout enforcement |
| `test/handlers/conditional.test.ts` | Modify | Test diamond+prompt LLM evaluation; test backward compat without prompt |
| `test/engine/engine.test.ts` | Modify | Test branch stops on predecessor failure |
| `test/process/run-script.test.ts` | Modify | Test process-group timeout kill |
| `test/garden/parse.test.ts` | Modify | Test `model` alias; test `assert_files` parsing; test `tools` attribute |
| `test/garden/validate.test.ts` | Modify | Test SHAPE_MISMATCH, EXECUTABLE_NOT_FOUND, PLATFORM_SPECIFIC_FLAG diagnostics |
| `test/runtime/pipeline-service.test.ts` | Modify | Test improved resume error message |
| `test/integration/pici-feedback.test.ts` | Create | Integration test covering all 11 feedback items |

---

## Definition of Done

### Code Bugs
- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts
- [ ] No test timeout values were increased to achieve green
- [ ] No tests were `.skip`-ed, `.todo`-ed, or otherwise disabled
- [ ] No existing tests regressed; test count is ≥ pre-sprint count
- [ ] **BUG-1:** Box+prompt node spawns agent session with ≥7 core tools registered and visible
- [ ] **BUG-1:** `tools="none"` attribute creates a text-only agent with no tool definitions
- [ ] **BUG-2:** When agent finishes with 0 tool calls and wilts, the agent's text response is included in `node_completed` event `notes` and `status.json`
- [ ] **BUG-2:** Log output shows agent response text on failure: `"Agent finished: N turns, 0 tool calls — Response: ..."`
- [ ] **BUG-3:** Predecessor failure in a branch sequence stops the branch; downstream nodes are not executed
- [ ] **BUG-3:** Predecessor failure with explicit failure edge routes to the failure target
- [ ] **BUG-4:** `assert_files` attribute is parsed from DOT and available on `GardenNode`
- [ ] **BUG-4:** Tool_command node that exits 0 but is missing an asserted file reports failure with specific message
- [ ] **BUG-5:** Tool_command timeout sends SIGTERM to the process group, then SIGKILL after 5s grace
- [ ] **BUG-5:** A spawned subprocess that outlives its parent shell is also killed on timeout
- [ ] **BUG-6:** `model="X"` attribute on a node sets `node.llmModel` (alongside existing `llm_model` and `llm.model`)
- [ ] **BUG-6:** `llm_model` takes precedence over `model` when both are specified
- [ ] **BUG-7:** Diamond node with `prompt` attribute evaluates the prompt via LLM and returns success/failure based on response
- [ ] **BUG-7:** Diamond node without `prompt` attribute returns success immediately (backward compatible)
- [ ] **BUG-7:** Diamond+prompt evaluation result stored in context as `${node.id}.evaluation`

### Documentation / UX
- [ ] **DOC-1:** Box node with `tool_command` emits `SHAPE_MISMATCH` warning suggesting `shape=parallelogram`
- [ ] **DOC-1:** `PROMPT_MISSING` fix text mentions both prompt and shape alternatives
- [ ] **DOC-2:** `SHELL_ALIAS_INFO` diagnostic emitted for tool nodes mentioning non-interactive shell
- [ ] **DOC-3:** Shape/attribute mismatch warnings guide first-time users to the correct configuration
- [ ] **DOC-4:** Resume hash-mismatch error includes the exact `nectar resume <id> --force` command
- [ ] **DOC-5:** `EXECUTABLE_NOT_FOUND` info diagnostic emitted when tool_command executable is not on PATH
- [ ] **DOC-6:** `PLATFORM_SPECIFIC_FLAG` info diagnostic emitted for known GNU-specific flags in tool_command

---

## Drop Line

If this sprint runs long, cut in this order (last item cut first):

1. **Keep (non-negotiable):** Phase 1 — BUG-1, BUG-2, BUG-4, BUG-5. These are the trust-destroying silent failures.
2. **Keep:** BUG-3 (fan-out after failure) and BUG-7 (diamond+prompt). Core control-flow correctness.
3. **Keep:** DOC-1, DOC-4 (validation and resume messages). High-impact, low-effort.
4. **Defer first:** DOC-6 (cross-platform linting). Nice-to-have pattern matching with many edge cases.
5. **Defer second:** DOC-5 (PATH validation). Helpful but `info` severity — runtime PATH may differ from validation time.
6. **Defer third:** BUG-6 (`model` alias). One-line fix, but users have working alternatives (`llm_model`, `llm.model`).

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| BUG-1 root cause is deeper than visibility filter | Medium | High | Audit starts with adding a test that creates a codergen handler, calls execute, and inspects the tool definitions sent to the LLM. If tools are registered but not sent, the bug is in session; if not registered, the bug is in the handler. |
| BUG-5 process-group kill doesn't work with `execa` + `shell: true` | Medium | High | Test with a real subprocess (e.g., `sh -c "sleep 30 & sleep 30"`) and verify both sleep processes are killed. If `execa`'s built-in mechanism fails, fall back to manual `process.kill(-pid)` with `detached: true`. |
| BUG-7 LLM evaluation adds latency to conditional nodes | Low | Medium | Evaluation only occurs when `prompt` is set. Nodes without prompt are unaffected. The single-turn LLM call is lightweight. |
| BUG-7 LLM response parsing is ambiguous | Medium | Medium | Use strict keyword matching (yes/no/true/false/pass/fail). If the response doesn't contain any recognized keyword, default to `failure` and log a warning. Include the full response in `notes` for debugging. |
| BUG-3 fix changes behavior for existing gardens with failure-tolerant fan-outs | Medium | High | The fix only affects `executeNodeSequence()` within parallel branches. The main engine loop already stops on failure. Add a `continue_on_failure` attribute (default false) as an escape hatch. |
| DOC-5 `which` command behavior varies across platforms | Low | Low | Use `child_process.execSync` with try/catch. On Windows, use `where` instead of `which`. On failure, skip the check silently — this is an `info` diagnostic, not a gate. |
| `assert_files` attribute scope creep | Medium | Medium | Intentionally limited to file existence checks. Do not add content assertions, glob patterns, or expression evaluation. Document as "simple post-condition — for complex assertions, use a separate validation node." |
| Sprint scope (7 bugs + 6 docs = 13 items) | Medium | High | Drop line is strict. Phase 1 (4 high-severity bugs) is the minimum viable sprint. Phase 3 items are all small validation changes. The integration test (Phase 4) validates everything together. |

---

## Security

- **DOC-5 PATH validation:** `which` is called with the first token of `tool_command` during validation. Ensure the token is sanitized (no shell metacharacters) before passing to `execSync`. Use `execFileSync('which', [token])` instead of `execSync('which ' + token)` to prevent command injection.
- **`assert_files` paths:** Paths in `assert_files` should be resolved relative to the workspace root, not cwd. Validate that resolved paths don't escape the workspace (no `../` traversal above root). Use the existing `PipelineService.resolveWorkspacePath()` pattern.
- **BUG-7 LLM evaluation:** The prompt sent to the LLM comes from the DOT file, which is user-authored. No additional sanitization needed — the LLM call is a normal generation request, not a tool execution.
- **Process-group kill (BUG-5):** Ensure the `kill(-pid)` call targets only the spawned process group, not the nectar process itself. Always verify `pid > 0` before calling `kill(-pid)`.

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Sprint 035 (green suite) | This sprint assumes the test suite is green. All fixes build on a stable foundation. |
| `execa` package | Process-group kill for BUG-5. Already in `package.json`. May need version check for `forceKillAfterDelay` support. |
| `SimulationProvider` | Integration tests use the simulation provider for deterministic LLM responses (BUG-7 diamond+prompt evaluation). |
| Existing `HandlerRegistry` and `ToolRegistry` | BUG-1 fix extends existing tool registration patterns. |
| Existing `validateGarden()` infrastructure | All DOC items add new diagnostic codes to the existing validation framework. |
| No new runtime packages | All changes modify existing files or add new diagnostics/attributes within existing patterns. |

---

## Open Questions

1. **BUG-1 — What is the actual root cause?** The handler registers 11 tools and the session has visibility logic. Is the issue that (a) the profile filters them out, (b) the LLM provider doesn't support tool definitions, (c) the session state prevents tool delivery, or (d) something else? Phase 1 starts with a diagnostic test to pinpoint the cause before implementing the fix.

2. **BUG-3 — Should we add `continue_on_failure` attribute?** The fix stops branch execution on predecessor failure by default. But some users may want branches to continue even after upstream failure (e.g., cleanup steps). Should we add `continue_on_failure="true"` to opt into the old behavior, or is the failure-edge mechanism sufficient?

3. **BUG-7 — What model should diamond+prompt evaluation use?** Options: (a) use the node's `model`/`llm_model` attribute, (b) use the workspace config default, (c) use a cheap/fast model always (e.g., haiku). Recommendation: (a) with fallback to (b). This is consistent with how codergen handles model selection.

4. **BUG-7 — Should diamond+prompt support multi-turn evaluation?** The proposed fix uses a single-turn LLM call. Some conditions might benefit from tool-augmented evaluation (e.g., "check if file X has more than 100 lines"). Should we support this, or keep diamond evaluation strictly single-turn? Recommendation: single-turn for now. Users needing tool-augmented conditions should use a box+prompt node followed by a diamond with an edge condition on the box's output.

5. **DOC-5 — When should PATH validation run?** Options: (a) at parse time (fast, but PATH may differ at runtime), (b) at run time before node execution (accurate, but adds latency), (c) both. Recommendation: parse-time only, with `info` severity. The diagnostic is a hint, not a guarantee.
