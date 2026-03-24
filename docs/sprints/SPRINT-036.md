# Sprint 036: First Contact — Fix Every Issue a Real User Hit

## Overview

**Goal:** Fix all 7 code bugs and address all 6 documentation/UX improvements reported by the first real user of nectar (the pici project). After this sprint, silent failures are eliminated, timeouts are enforced, validation messages guide users to correct configurations, and the authoring experience is documented.

**Motivation:** The pici project represents nectar's first external pipeline. During a single session, the user documented 11 issues — all specific, actionable, and reproducible. The worst class of failures were silent ones: `box` nodes appeared to run but did nothing, agent failures lost the agent's own explanation, `tool_command` nodes reported success while writing no files, and long-running commands ignored declared timeouts. These are trust-destroying bugs. This sprint closes every one of them.

**Reference files:**
- Original feedback: `/Users/caleb.mchenry/code/ai-pici/.nectar/feedback.md`
- Analyzed summary: `/Users/caleb.mchenry/code/nectar/notes/pici-feedback-analysis.md`

**Scope:** BUG-1 through BUG-7, DOC-1 through DOC-6, all with tests.

**Out of scope:**
- New node types or shapes
- Web UI / Hive changes (beyond `buildSimulationDot` fix)
- `tools="none"` / `tools="all"` attribute (diagnose root cause first)
- `continue_on_failure` attribute (failure-edge mechanism is sufficient)
- `assert_exists` mtime/freshness checking (simple existence is the MVP)
- Full assertion expression language

---

## Use Cases

1. **Box+prompt node runs an agent with tools.** A user writes `plan [shape=box, prompt="Read the repo and write docs/plan.md"]`. The agent uses `read_file`, `write_file`, `shell`, and related built-in tools through `CodergenHandler.executeWithAgentSession()` to actually fulfill the prompt.

2. **Agent failure surfaces the response text.** An agent finishes with 0 tool calls and the node fails. The log shows: `Agent finished: 1 turns, 0 tool calls — Response: "I don't have access to the file system..."`. The user immediately sees why it failed. Zero-tool-call sessions are treated as failure, not success.

3. **Fan-out stops when predecessor fails.** `pick_backlog_item` wilts. `fan_out_drafts` does not start. Downstream nodes in the branch are not executed unless a failure edge explicitly routes there.

4. **Tool command with assertion catches silent success.** A node has `tool_command="claude -p 'Write a draft'"` and `assert_exists="docs/drafts/current-item.md"`. The command exits 0 but creates no files. Nectar checks the assertion, finds the file missing, and marks the node as failed.

5. **Timeout kills runaway process tree.** `validate_ui [timeout="900s"]` starts a Gemini CLI process that spawns child processes. After 15 minutes, nectar sends SIGTERM to the entire process group. After a grace period, SIGKILL. The node is marked as failed.

6. **Model attribute controls the LLM.** `review [shape=box, prompt="Review the code", model="claude-opus-4-6"]` spawns an agent session using the specified model. The `model` attribute is accepted as an alias for `llm_model`.

7. **Diamond+prompt is rejected at validation.** `check_backlog [shape=diamond, prompt="Does the backlog have items?"]` emits a validation error: `"Conditional nodes do not support the prompt attribute. Use edge conditions for routing, or change to shape=box for LLM evaluation."` Diamond nodes remain deterministic edge routers per the Attractor spec.

8. **Validation warns about shape/attribute mismatches.** A user writes `my_node [shape=box, tool_command="echo hi"]`. Validation emits: `"Node 'my_node' has tool_command but box shape — did you mean shape=parallelogram?"`.

9. **Validation checks tool_command executables on PATH.** `my_node [shape=parallelogram, tool_command="codex exec 'do stuff'"]` triggers a validation info diagnostic if `codex` is not found on PATH.

10. **Resume --force is discoverable.** When a graph hash mismatch occurs, the error reads: `"Graph hash mismatch. The garden file has been modified since this run started.\n\nTo resume anyway, run:\n  nectar resume <run-id> --force"`.

---

## Architecture

### Design Decisions

**1. BUG-1: Diagnose-first for box+prompt agent tools.**

`CodergenHandler.executeWithAgentSession()` already creates a `ToolRegistry` and registers 11 tools (7 core + 4 subagent). The provider profiles in `src/agent-loop/provider-profiles.ts` expose 6-8 tools depending on provider. The sprint starts with a diagnostic test to pinpoint *why* agents finish with 0 tool calls despite having tools registered. Possible causes: prompt engineering issue, session configuration, model capability, or visibility filter. The fix targets the actual root cause rather than adding new attributes.

**2. BUG-2: Zero-tool-call sessions become failure + three-layer text surfacing.**

Two changes: (a) In `src/agent-loop/session.ts:677-689`, when `toolCalls.length === 0` on a node with a prompt expecting work, return `buildResult('failure', ...)` instead of `'success'`. (b) Surface failure text at three layers: `CodergenHandler` populates `NodeOutcome.notes` and context key `${node.id}.response` with the agent's final text → `PipelineEngine.buildFailureMessage()` consults these fields → `EventRenderer.render()` in `src/cli/ui/renderer.ts:37-83` displays `notes` on failed nodes (currently it only shows `error_message`, `stderr`, or exit code).

**3. BUG-3: Branch execution stops on predecessor failure.**

The main engine loop already routes failures through `resolveFailureTarget()` at `engine.ts:541-583`. The bug is in `executeNodeSequence()` at `engine.ts:1678-1722`, which unconditionally calls `selectNextEdge()` after failure. Fix: after each node completes in a branch sequence, check `outcome.status`. If `'failure'`, resolve failure edges first. If no explicit failure route exists, stop the branch and propagate the failure. Do not fall through to default edge selection.

**4. BUG-4: `assert_exists` post-condition for tool_command nodes.**

Parse `assert_exists` as a comma-separated list of file paths on `GardenNode` (in `src/garden/types.ts` and `src/garden/parse.ts`). After `ToolHandler.execute()` gets exit code 0, check each path via `fs.access()` resolved relative to `workspace_root` (not `process.cwd()`). If any file is missing, override outcome to failure with message listing missing paths. Reject paths that escape the workspace via `../` traversal.

**5. BUG-5: Shared process-group command runner.**

The repo already has correct SIGTERM → SIGKILL tree-kill semantics in `LocalExecutionEnvironment.exec()` at `src/agent-loop/execution-environment.ts:216-263`. Extract that logic into `src/process/exec-command.ts` as a shared helper. Refactor both `runScript()` in `src/process/run-script.ts` and `LocalExecutionEnvironment.exec()` to use it. This ensures `tool_command` nodes and agent shell tools share identical process-lifecycle semantics: `detached: true`, process-group spawning, SIGTERM, grace window, SIGKILL.

**6. BUG-6: `model` accepted as alias for `llm_model`.**

In `src/garden/parse.ts:155-160`, add `model` as a third alias. Resolution order: `llm_model` > `llm.model` > `model`. The parser populates `node.llmModel` which `CodergenHandler` already consumes at `codergen.ts:76-78`. Record the resolved model/provider in `agent-status.json` via `TranscriptWriter.writeStatus()`.

**7. BUG-7: Diamond+prompt is a validation error.**

Diamond nodes are deterministic edge routers per the Attractor spec. `ConditionalHandler` at `src/handlers/conditional.ts` is a deliberate no-op — routing happens via edge conditions in `selectNextEdge()`. Add `PROMPT_UNSUPPORTED_FOR_CONDITIONAL` validation error in `src/garden/validate.ts`. Add a runtime guard in `ConditionalHandler.execute()` that fails fast if `input.node.prompt` is present (defense in depth for programmatic callers that bypass validation).

**8. Validation improvements (DOC-1 through DOC-6).**

All validation changes are additive diagnostics in `src/garden/validate.ts`, using the existing `validateGarden()` flow. New diagnostics:
- `SHAPE_MISMATCH_TOOL_COMMAND` — box node with `tool_command` suggests parallelogram
- `PROMPT_UNSUPPORTED_FOR_CONDITIONAL` — diamond node with `prompt` is an error
- `TOOL_COMMAND_NOT_FOUND` — executable not on PATH (info severity, filesystem-only lookup via `src/garden/tool-command-lint.ts`)
- `TOOL_COMMAND_PORTABILITY` — GNU-specific flags like `grep -P` (info severity)
- `SCRIPT_DEPRECATED` — `script=` attribute suggests `tool_command=` instead
- Suppression of generic `PROMPT_MISSING` when `SHAPE_MISMATCH_TOOL_COMMAND` fires
- Updated `PROMPT_MISSING` fix text to mention shape alternatives

---

## Implementation

### Phase 1: High-Severity Runtime Corrections — BUG-1, BUG-2, BUG-4, BUG-5

**Hard rule:** Fix the four trust-destroying bugs before anything else.

**Tasks:**

- [ ] **BUG-1: Diagnose box+prompt agent tool visibility.** Write a diagnostic test in `test/handlers/codergen.test.ts` that creates a codergen handler, calls execute with a box+prompt node, and inspects: (a) tool definitions sent to the LLM in the request, (b) session result including tool_call_count and final_text, (c) whether the SimulationProvider can exercise tool calls. Based on findings, fix the actual root cause. Verify with an end-to-end test in `test/integration/pici-feedback.test.ts` that a box+prompt node using a scripted adapter creates a file in the workspace.

- [ ] **BUG-2: Zero-tool-call = failure + surface response text.**
  - In `src/agent-loop/session.ts:677-689`, change the zero-tool-call path to return `buildResult('failure', ...)` with a message like `"Agent produced no tool calls"`.
  - In `src/handlers/codergen.ts`, when `result.status === 'failure'` and `result.final_text` is non-empty, include the text in `NodeOutcome.notes` and write `response.md` artifact. Add `${node.id}.response` context update.
  - In `src/cli/ui/renderer.ts:37-83`, update failure rendering to display `event.outcome.notes` when `error_message` and `stderr` are absent.
  - Test: agent with 0 tool calls → `node_completed` event has status `failure` and `notes` contains the agent's response text.

- [ ] **BUG-4: Add `assert_exists` attribute.**
  - In `src/garden/types.ts`, add `assertExists?: string[]` to `GardenNode`.
  - In `src/garden/parse.ts`, parse `assert_exists` into `GardenNode.assertExists`. Accept comma-separated list, trim empty segments.
  - In `src/garden/validate.ts`, validate `assert_exists` syntax (no empty values, no workspace escape via `../`).
  - In `src/handlers/tool.ts`, after `runScript()` returns exit 0, check each path in `input.node.assertExists` via `fs.access()` resolved relative to `workspace_root`. If any missing, override outcome to `failure` with message: `"Assertion failed: expected file '<path>' does not exist after tool_command completed."` Report all missing files, not just the first.
  - Test: tool_command exits 0 but asserted file missing → outcome is failure. Test: asserted file exists → outcome unchanged.

- [ ] **BUG-5: Shared process-group command runner.**
  - Create `src/process/exec-command.ts` extracting the process-group kill logic from `src/agent-loop/execution-environment.ts:216-263`. The helper owns: `detached: true` process-group spawning, SIGTERM on timeout, grace window (2 seconds, matching existing behavior), SIGKILL, abort handling, and stdout/stderr capture.
  - Refactor `src/process/run-script.ts` to use the shared helper instead of bare `execaCommand` with execa's built-in timeout.
  - Refactor `src/agent-loop/execution-environment.ts` to use the shared helper.
  - Create `test/process/exec-command.test.ts`: start a command that spawns a subprocess (`sh -c "sleep 30 & sleep 30"`), set 1s timeout → both parent and child are killed, `timed_out` is true.
  - Test: tool_command with timeout → process group killed, node marked failed.

- [ ] **Run `npm test`. All tests must pass.**

### Phase 2: Medium-Severity Bugs + Validation/UX — BUG-3, BUG-6, BUG-7, DOC-1 through DOC-6

**Tasks:**

- [ ] **BUG-3: Stop branch execution on predecessor failure.**
  - In `src/engine/engine.ts`, locate `executeNodeSequence()` at line 1678+. After each node execution, check `outcome.status`. If `'failure'`, call `resolveFailureTarget()` for the node. If an explicit failure route exists, follow it. If no failure route, stop the branch sequence and propagate the failure. Do not fall through to `selectNextEdge()`.
  - In `src/engine/branch-executor.ts`, ensure the returned branch status reflects the failure-stop behavior.
  - Test in `test/engine/branch-executor.test.ts`: branch where node A fails → node B never executes. Branch where node A fails with failure edge → failure target executes.

- [ ] **BUG-6: Recognize `model` as alias for `llm_model`.**
  - In `src/garden/parse.ts:155-160`:
    ```typescript
    const llmModel = mergedAttributes.llm_model?.trim()
      || mergedAttributes['llm.model']?.trim()
      || mergedAttributes.model?.trim()
      || undefined;
    ```
  - In `src/handlers/codergen.ts`, pass resolved model to `transcriptWriter.writeStatus()` so `agent-status.json` records the actual model used.
  - Test in `test/garden/parse.test.ts`: node with `model="claude-opus-4-6"` → `node.llmModel === 'claude-opus-4-6'`. Test: `llm_model` takes precedence over `model`.

- [ ] **BUG-7: Reject diamond+prompt.**
  - In `src/garden/validate.ts`, add `PROMPT_UNSUPPORTED_FOR_CONDITIONAL` error: `"Conditional node '${node.id}' does not support the prompt attribute. Diamond nodes are edge routers — use edge conditions for routing, or change to shape=box for LLM evaluation."`.
  - In `src/handlers/conditional.ts`, add runtime guard: if `input.node.prompt` is present, return `{ status: 'failure', error_message: 'Conditional nodes do not support prompt evaluation.' }`.
  - Test in `test/handlers/conditional.test.ts`: diamond+prompt → failure. Diamond without prompt → success (backward compat). Test in `test/garden/validate.test.ts`: diamond+prompt → validation error emitted.

- [ ] **DOC-1: Shape-mismatch validation.**
  - In `src/garden/validate.ts`, add `SHAPE_MISMATCH_TOOL_COMMAND` warning: `"Node '${node.id}' has tool_command but box shape — did you mean shape=parallelogram?"` with fix: `"Change shape to parallelogram, or remove tool_command and use prompt instead."`.
  - Suppress `PROMPT_MISSING` when `SHAPE_MISMATCH_TOOL_COMMAND` fires for the same node.
  - Update `PROMPT_MISSING` fix text to: `"Set ${node.id} [prompt=\"...\"] for LLM execution, or change shape to parallelogram for tool_command execution."`.
  - Add `SCRIPT_DEPRECATED` warning when `script=` attribute is used: `"The 'script' attribute is deprecated. Use 'tool_command' instead."`.
  - Test all cases in `test/garden/validate.test.ts`.

- [ ] **DOC-2 + DOC-3: Documentation and shell-alias info.**
  - In `src/garden/validate.ts`, add `SHELL_ALIAS_INFO` informational diagnostic for tool nodes: `"Note: tool_command runs in a non-interactive shell. Shell aliases are not available. Use full command paths and flags."`.
  - Create `docs/garden-authoring.md` with: box vs parallelogram vs diamond semantics, `prompt` / `tool_command` / `llm_model` / `model` attributes, non-interactive shell behavior and alias caveats, `assert_exists`, and `nectar resume --force`.
  - In `README.md`, add a short "Choosing Node Shapes" section linking to the authoring guide.
  - In `src/runtime/garden-draft-service.ts`, update `buildSimulationDot()` to emit `tool_command=` examples instead of `script=`.

- [ ] **DOC-4: Resume --force discoverability.**
  - In `src/runtime/pipeline-service.ts:275-283`, change the hash-mismatch error to:
    ```
    Graph hash mismatch for run '${options.run_id}'. The garden file has been modified since this run started.

    To resume anyway, run:
      nectar resume ${options.run_id} --force
    ```
  - In `src/cli/commands/resume.ts`, when catching `PipelineConflictError`, print the same recovery hint with the actual run ID.
  - Test: resume with hash mismatch → error contains `nectar resume <id> --force`.

- [ ] **DOC-5: Validate tool_command executables on PATH.**
  - Create `src/garden/tool-command-lint.ts` with sync helpers for: extracting the command head from `tool_command`, resolving against `$PATH` via filesystem lookup only (split `$PATH`, check `fs.existsSync(path.join(dir, head))` for each directory — never shell out).
  - Skip validation if the head starts with `/`, `./`, or is a known shell builtin.
  - In `src/garden/validate.ts`, emit `TOOL_COMMAND_NOT_FOUND` info diagnostic: `"tool_command executable '${head}' not found on PATH."`.
  - Test with known-missing executable → diagnostic emitted. Test with `echo` → no diagnostic.

- [ ] **DOC-6: Cross-platform tool_command linting.**
  - In `src/garden/tool-command-lint.ts`, add heuristic detection for known GNU-specific flags: `grep -P`, `grep -oP`, `sed -r`, `find -printf`, `readlink -f`.
  - In `src/garden/validate.ts`, emit `TOOL_COMMAND_PORTABILITY` info diagnostic: `"tool_command in node '${node.id}' may use GNU-specific flags. These may not work on macOS/BSD."`.
  - Keep the rule set small and high-signal. Start with patterns from the actual feedback.
  - Test with `grep -oP` → diagnostic emitted.

- [ ] **Run `npm test`. All tests must pass.**

### Phase 3: Integration Test and Verification

**Tasks:**

- [ ] **Create integration regression suite.** Create `test/integration/pici-feedback.test.ts` covering:
  - Box+prompt node → agent gets tools, produces output, writes a file
  - Failed codergen with 0 tool calls → outcome is failure, notes contain agent text
  - Tool_command + `assert_exists` → fails when artifact missing, succeeds when present
  - Diamond+prompt → rejected by validation
  - Predecessor failure in branch → downstream node not executed
  - Tool_command with timeout → process group killed
  Use `SimulationProvider` for deterministic behavior.

- [ ] **Manual smoke test** with a representative pici-style garden: one box+prompt, one parallelogram+tool_command with assert_exists, one diamond with edge conditions, and a resume --force path.

- [ ] **Run `npm run build` — zero TypeScript errors.**
- [ ] **Run `npm test` — all tests pass, zero failures, zero timeouts.**
- [ ] **Verify test count ≥ pre-sprint count.**

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/handlers/codergen.ts` | Modify | Populate NodeOutcome.notes and response context on failure (BUG-1, BUG-2); pass resolved model to transcript (BUG-6) |
| `src/agent-loop/session.ts` | Modify | Zero-tool-call returns failure instead of success (BUG-2) |
| `src/agent-loop/transcript.ts` | Modify | Record resolved model/provider in agent-status.json (BUG-6) |
| `src/cli/ui/renderer.ts` | Modify | Display `notes` on failed nodes (BUG-2) |
| `src/handlers/tool.ts` | Modify | Enforce `assert_exists` post-condition (BUG-4); use shared command runner |
| `src/process/exec-command.ts` | Create | Shared process-group command runner with timeout, SIGTERM/SIGKILL (BUG-5) |
| `src/process/run-script.ts` | Modify | Use shared command runner (BUG-5) |
| `src/agent-loop/execution-environment.ts` | Modify | Use shared command runner (BUG-5) |
| `src/engine/engine.ts` | Modify | Stop branch on predecessor failure in `executeNodeSequence()` (BUG-3) |
| `src/engine/branch-executor.ts` | Modify | Reflect failure-stop in branch status (BUG-3) |
| `src/handlers/conditional.ts` | Modify | Runtime guard: fail fast on diamond+prompt (BUG-7) |
| `src/garden/parse.ts` | Modify | Parse `assert_exists` (BUG-4); add `model` alias (BUG-6) |
| `src/garden/types.ts` | Modify | Add `assertExists?: string[]` to GardenNode (BUG-4) |
| `src/garden/validate.ts` | Modify | Add SHAPE_MISMATCH, PROMPT_UNSUPPORTED_FOR_CONDITIONAL, TOOL_COMMAND_NOT_FOUND, TOOL_COMMAND_PORTABILITY, SCRIPT_DEPRECATED, SHELL_ALIAS_INFO diagnostics (DOC-1 through DOC-6, BUG-7) |
| `src/garden/tool-command-lint.ts` | Create | Sync helpers for executable lookup and portability warnings (DOC-5, DOC-6) |
| `src/runtime/pipeline-service.ts` | Modify | Improve resume hash-mismatch error (DOC-4) |
| `src/cli/commands/resume.ts` | Modify | Print --force recovery hint on hash mismatch (DOC-4) |
| `src/runtime/garden-draft-service.ts` | Modify | Emit `tool_command=` not `script=` in generated drafts (DOC-3) |
| `README.md` | Modify | Add "Choosing Node Shapes" section (DOC-3) |
| `docs/garden-authoring.md` | Create | Focused authoring guide: shapes, attributes, shell behavior, assert_exists, resume (DOC-2, DOC-3) |
| `test/handlers/codergen.test.ts` | Modify | BUG-1 diagnostic, BUG-2 failure text, BUG-6 model resolution |
| `test/handlers/tool.test.ts` | Modify | assert_exists success/failure, timeout enforcement |
| `test/handlers/conditional.test.ts` | Modify | Diamond+prompt → failure, backward compat |
| `test/process/exec-command.test.ts` | Create | Process-group timeout kill, child cleanup |
| `test/engine/branch-executor.test.ts` | Modify | Branch stop-on-failure |
| `test/garden/parse.test.ts` | Modify | `model` alias, `assert_exists` parsing |
| `test/garden/validate.test.ts` | Modify | All new diagnostics |
| `test/runtime/garden-draft-service.test.ts` | Modify | Simulation drafts use `tool_command=` |
| `test/integration/pici-feedback.test.ts` | Create | End-to-end regression for all pici scenarios |

---

## Definition of Done

### Code Bugs
- [ ] `npm install && npm run build` succeeds with zero errors
- [ ] `npm test` passes — zero failures, zero timeouts
- [ ] No tests skipped, todoed, or disabled
- [ ] Test count ≥ pre-sprint count
- [ ] **BUG-1:** Box+prompt node spawns agent session with core tools registered and visible; agent can make tool calls; root cause of 0-tool-call behavior is identified and fixed
- [ ] **BUG-2:** Zero-tool-call agent sessions return `failure` status, not `success`
- [ ] **BUG-2:** Agent's text response is included in `NodeOutcome.notes`, `status.json`, and CLI failure output
- [ ] **BUG-3:** Predecessor failure in a branch sequence stops the branch; downstream nodes not executed
- [ ] **BUG-3:** Predecessor failure with explicit failure edge routes to the failure target
- [ ] **BUG-4:** `assert_exists` attribute parsed from DOT, available on `GardenNode.assertExists`
- [ ] **BUG-4:** Tool_command exit 0 with missing asserted file → failure with specific message listing all missing files
- [ ] **BUG-4:** `assert_exists` paths resolved relative to workspace root, not cwd; paths escaping workspace rejected
- [ ] **BUG-5:** `runScript()` and `LocalExecutionEnvironment.exec()` share one command runner in `src/process/exec-command.ts`
- [ ] **BUG-5:** Timeout sends SIGTERM to process group, then SIGKILL after 2s grace; grandchild processes also killed
- [ ] **BUG-6:** `model="X"` on a node sets `node.llmModel`; `llm_model` takes precedence when both specified
- [ ] **BUG-6:** Resolved model/provider recorded in `agent-status.json`
- [ ] **BUG-7:** Diamond+prompt emits `PROMPT_UNSUPPORTED_FOR_CONDITIONAL` validation error
- [ ] **BUG-7:** `ConditionalHandler` runtime guard fails fast if prompt is present

### Documentation / UX
- [ ] **DOC-1:** Box+tool_command emits `SHAPE_MISMATCH_TOOL_COMMAND` warning; `PROMPT_MISSING` suppressed when mismatch fires
- [ ] **DOC-1:** `PROMPT_MISSING` fix text mentions both prompt and shape alternatives
- [ ] **DOC-1:** `script=` attribute emits `SCRIPT_DEPRECATED` warning
- [ ] **DOC-2:** `SHELL_ALIAS_INFO` diagnostic emitted for tool nodes
- [ ] **DOC-3:** `docs/garden-authoring.md` explains shapes, attributes, shell behavior, assert_exists, resume
- [ ] **DOC-3:** `buildSimulationDot()` emits `tool_command=` not `script=`
- [ ] **DOC-4:** Resume hash-mismatch error includes exact `nectar resume <id> --force` command
- [ ] **DOC-5:** `TOOL_COMMAND_NOT_FOUND` info diagnostic via filesystem-only PATH lookup (no shell-out)
- [ ] **DOC-6:** `TOOL_COMMAND_PORTABILITY` info diagnostic for `grep -P` and other GNU-specific flags

---

## Drop Line

If time runs short, cut in this order (last item cut first):

1. **Keep (non-negotiable):** Phase 1 — BUG-1, BUG-2, BUG-4, BUG-5. Trust-destroying silent failures.
2. **Keep:** BUG-3, BUG-7, DOC-1, DOC-4. Core control-flow correctness and high-impact validation fixes.
3. **Keep:** BUG-6, DOC-2, DOC-3. Model alias and authoring docs.
4. **Defer first:** DOC-6 (cross-platform linting). Nice-to-have with many edge cases.
5. **Defer second:** DOC-5 (PATH validation). Runtime PATH may differ from validation time.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| BUG-1 root cause is deeper than expected (not just visibility) | Medium | High | Start with diagnostic test. If tools are registered but agent doesn't use them, investigate session config, model capabilities, and prompt engineering. Budget extra time for Phase 1. |
| Shared command runner (BUG-5) breaks existing execution paths | Medium | High | Extract from working code in `execution-environment.ts`. Test both `runScript()` and agent shell tool paths. Keep execa version pinned. |
| Process-group kill is POSIX-specific | Medium | Medium | Document as POSIX-only. On Windows, fall back to `taskkill /tree` or standard `kill()`. Test on macOS (primary target). |
| Zero-tool-call = failure changes agent behavior broadly | Medium | High | Only apply when node has a prompt that expects work (codergen handler). Text-generation-only use cases (if any) need a different handler, not a special case in session. |
| Branch failure-stop (BUG-3) changes behavior for existing gardens | Low | High | The main engine already stops on failure — this brings branches into parity. Gardens with failure-tolerant branches should use explicit failure edges. |
| `assert_exists` paths ambiguous (relative to what?) | Medium | Medium | Always resolve relative to workspace root. Validate no `../` traversal above workspace. Document in authoring guide. |
| DOC-5 PATH validation false positives in Hive/server context | Medium | Low | Info severity only. Skip validation for explicit paths. Document that PATH at validation time may differ from runtime. |
| Sprint scope (13 items) | Medium | High | Drop line is strict. Phase 1 (4 bugs) is minimum viable. Phase 2 items are mostly small additive changes. |

---

## Security

- **DOC-5 PATH validation:** Use `fs.existsSync(path.join(dir, head))` — never shell out during validation. Sanitize the command head before any filesystem operation.
- **`assert_exists` paths:** Resolve relative to workspace root. Reject paths with `../` that escape the workspace boundary. Use `path.resolve()` and verify the resolved path starts with workspace root.
- **Process-group kill (BUG-5):** Always verify `pid > 0` before calling `process.kill(-pid)`. Target only the spawned process group, never the nectar process itself.
- **BUG-2 failure text:** Truncate agent response text in CLI output to prevent terminal flooding. Full text goes to `response.md` artifact on disk.
- **`tool_command` secrets:** Document in authoring guide that users should not put secrets directly in `tool_command`, as commands and failures appear in run artifacts.

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Sprint 035 (green suite) | Assumes test suite is green and Sprint 035 fixes are merged. |
| `execa` package (existing) | Shared command runner wraps execa with process-group semantics. |
| `SimulationProvider` (existing) | Integration tests use simulation for deterministic behavior. |
| Existing `HandlerRegistry` / `ToolRegistry` | BUG-1 diagnosis extends existing patterns. |
| Existing `validateGarden()` | All DOC items add diagnostics to existing validation. |
| No new runtime packages | All changes modify existing files or add within existing patterns. |

---

## Open Questions

1. **BUG-1 — What is the actual root cause?** Phase 1 starts with diagnosis. If the root cause turns out to be fundamental (e.g., the default model doesn't support tool use in the built-in agent's prompt format), the fix may be larger than expected. The drop line ensures this doesn't block the rest of the sprint.

2. **`assert_exists` scope expansion** — Should `CodergenHandler` also honor `assert_exists` so native box nodes can assert file outputs? Recommendation: defer to a follow-up. Codergen nodes produce files through tool calls which already have their own success/failure semantics.

3. **`model` alias and provider inference** — When `model="gpt-5.4"` is specified without `llm_provider`, should the catalog infer the provider? Recommendation: yes, but only when catalog resolution is unambiguous. Emit a warning on conflicts. Explicit `llm_provider` always wins.

4. **Portability lint breadth** — Start with `grep -P`, `sed -r`, `find -printf` from the actual feedback. Expand in future sprints based on real usage patterns.
