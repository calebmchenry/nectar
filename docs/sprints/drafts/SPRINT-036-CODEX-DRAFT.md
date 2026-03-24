# Sprint 036 - Pici Feedback Closure

## 1. Overview

### Sprint title

Pici Feedback Closure - Tool-Backed Boxes, Actionable Failures, and Safer Tool Commands

### Summary

Sprint 036 closes the user-facing runtime and authoring gaps documented in `/Users/caleb.mchenry/code/ai-pici/.nectar/feedback.md` and categorized in `/Users/caleb.mchenry/code/nectar/notes/pici-feedback-analysis.md`. The sprint starts with the four high-severity items from that analysis:

- `BUG-1` - `box + prompt` must be a real tool-backed agent path, not a silent no-op
- `BUG-2` - agent failures must surface useful text instead of only `exit code unknown`
- `BUG-4` - `tool_command` steps need explicit postconditions so `exit 0` is not treated as "work completed"
- `BUG-5` - `timeout` on `tool_command` must kill the entire process tree, not only the parent shell

The second half of the sprint tightens the authoring and validation experience around shape confusion, `model` alias support, `diamond + prompt`, missing executables, portability linting, and resume UX. The goal is that a first-time user building a garden the way the pici user did gets either the correct runtime behavior or an immediate, actionable validation message.

### Motivation

The pici user hit the worst possible class of failures: silent ones. `box` nodes appeared to run but did nothing, agent failures lost the agent's own explanation, `tool_command` nodes reported success while writing no files, and long-running commands ignored declared timeouts. Those failures forced the user to reverse-engineer Nectar's shape model and shell environment assumptions under pressure. Sprint 036 should remove that ambiguity.

The current tree already contains some partial closes from recent work. `CodergenHandler.executeWithAgentSession()` now provisions a rich `ToolRegistry`, `PipelineEngine.writeNodeStatus()` writes canonical `status.json`, `FanInHandler` now returns `success` even when it selects a failed branch, and `AgentSession` already uses session-lifetime `max_turns`. Sprint 036 should build on that baseline, not restate it. Where the current tree is already correct, the sprint should add regression coverage and documentation instead of reopening the implementation.

## 2. Use Cases

1. A user writes `plan [shape=box, prompt="Read the repo and write docs/plan.md"]` and the node actually uses `read_file`, `write_file`, `shell`, and related built-in tools through `CodergenHandler.executeWithAgentSession()`.
2. A `box` node fails after the model writes explanatory text. The user sees that explanation in the stage failure output, the pipeline failure message, and the node artifacts instead of only `wilted (exit code unknown)`.
3. A `parallelogram` node shells out to `claude -p ...` or `codex exec ...` and declares `assert_exists="docs/drafts/current-item.md"`. Nectar fails the node if that file is missing, even when the command itself exits `0`.
4. A hung `tool_command` that spawns child processes is terminated by timeout using `SIGTERM`, then `SIGKILL` if needed, and the run continues into normal failure handling instead of hanging forever.
5. A user accidentally writes `shape=box` with `tool_command="npm test"`. Validation tells them "did you mean `shape=parallelogram`?" instead of warning about a missing prompt.
6. A user writes `model="gpt-5.4"` on a node. Nectar parses the alias, resolves the actual provider/model combination deterministically, and records that choice in `agent-status.json` and runtime events.
7. A user writes `shape=diamond, prompt="Decide whether to continue"`. Validation rejects it immediately because conditional nodes are edge routers, not hidden LLM evaluators.
8. A user edits a graph after interruption and runs `nectar resume`. The conflict message clearly shows the exact `nectar resume <run-id> --force` recovery path.
9. A macOS user writes `grep -oP` in `tool_command`. Validation warns before runtime that the command is likely GNU-specific.
10. The Hive draft generator emits canonical `tool_command=` examples instead of reinforcing the deprecated `script=` path.

## 3. Architecture

### Design principles

- Keep shape semantics explicit. Do not auto-infer `box` or `parallelogram` from attributes.
- Prefer additive aliases over renames. `llm_model` remains canonical even if `model` is accepted.
- Put machine-specific checks behind warnings, not hard errors.
- Use one command-execution contract everywhere shell processes can hang.
- Treat pici regressions as first-class acceptance tests, not documentation-only cleanup.

### Design decisions by issue

| Item | Design decision | Primary implementation points |
|------|-----------------|-------------------------------|
| `BUG-1` | Keep `box` as the built-in agent path. The runtime already provisions tools through `CodergenHandler.executeWithAgentSession()`, so Sprint 036 adds end-to-end regression coverage and removes remaining ambiguity in failure reporting and docs. No shape auto-conversion. | `src/handlers/codergen.ts`, `test/integration/pici-feedback.test.ts`, `README.md`, `docs/garden-authoring.md` |
| `BUG-2` | Surface failure detail at three layers: `NodeOutcome`, pipeline failure message construction, and CLI rendering. If the agent produced text before failing, that text must be persisted and used in `stage_failed` / `run_error` output. | `src/handlers/codergen.ts`, `src/agent-loop/transcript.ts`, `src/engine/engine.ts`, `src/cli/ui/renderer.ts` |
| `BUG-4` | Add an explicit postcondition contract instead of trying to infer side effects. Start with `assert_exists`, parsed onto `GardenNode`, enforced by `ToolHandler.execute()`, and documented as the recommended way to guard agent CLI shell-outs. | `src/garden/types.ts`, `src/garden/parse.ts`, `src/garden/validate.ts`, `src/handlers/tool.ts` |
| `BUG-5` | Unify shell timeout behavior around process-group execution. The repo already has correct `SIGTERM -> SIGKILL` tree-kill semantics in `LocalExecutionEnvironment.exec()`. Extract that into a shared helper and make `runScript()` use it so `ToolHandler.execute()` gets the same semantics. | `src/process/exec-command.ts` (new), `src/process/run-script.ts`, `src/agent-loop/execution-environment.ts`, `src/handlers/tool.ts` |
| `BUG-3` | Top-level engine failure routing is already explicit in `PipelineEngine.run()`, but `executeNodeSequence()` still selects next edges after failures. Bring branch execution into parity: downstream nodes do not run after failure unless a failure route exists. | `src/engine/engine.ts` (`executeNodeSequence()`), `src/engine/branch-executor.ts`, `test/engine/branch-executor.test.ts` |
| `BUG-6` | Accept `model=` as an alias for `llm_model`, keep `llm_model` canonical, and infer provider only when the model maps unambiguously through the catalog and no explicit provider was set. Explicit `llm_provider` always wins. Also record the resolved model/provider in `agent-status.json`. | `src/garden/parse.ts`, `src/garden/validate.ts`, `src/handlers/codergen.ts`, `src/agent-loop/transcript.ts` |
| `BUG-7` | Keep `diamond` spec-aligned and non-LLM. `prompt` on a conditional node becomes a validation error and a runtime guard in `ConditionalHandler.execute()` for programmatic graphs that bypass validation. | `src/garden/validate.ts`, `src/handlers/conditional.ts`, `test/handlers/conditional.test.ts` |
| `DOC-1` | Replace misleading `PROMPT_MISSING` cases with shape-mismatch diagnostics. If a `box` node has `tool_command` or `script`, the validator should say that directly and suppress the generic prompt warning. | `src/garden/validate.ts`, `test/garden/validate.test.ts` |
| `DOC-2` | Document that `tool_command` runs in a non-interactive shell and does not expand aliases. Pair the docs with `assert_exists` so users have a concrete mitigation. | `README.md`, `docs/garden-authoring.md` |
| `DOC-3` | Keep explicit shapes. Improve docs, validation wording, and generated examples instead of silently changing graph meaning. | `src/garden/validate.ts`, `src/runtime/garden-draft-service.ts`, `README.md`, `docs/garden-authoring.md` |
| `DOC-4` | Preserve graph-hash conflict semantics but make recovery obvious in both CLI and service errors. The error text should show the exact `--force` follow-up. | `src/runtime/pipeline-service.ts`, `src/cli/commands/resume.ts`, `test/integration/resume.test.ts` |
| `DOC-5` | Add non-executing PATH validation for `tool_command` heads. Use filesystem lookup only; never shell out during validation. Emit warnings because the server/CLI host can differ from the eventual runtime host. | `src/garden/tool-command-lint.ts` (new), `src/garden/validate.ts`, `test/garden/validate.test.ts` |
| `DOC-6` | Add heuristic portability warnings for known GNU-only command patterns. Start with the concrete patterns from the feedback (`grep -P`) and a small allowlist of high-signal checks. | `src/garden/tool-command-lint.ts`, `src/garden/validate.ts`, `test/garden/validate.test.ts` |

### Specific technical choices

#### 1. Failure detail flows through existing primitives

Do not add a second failure-event type just for codergen. `CodergenHandler.executeWithAgentSession()` should return richer `NodeOutcome` data, `PipelineEngine.buildFailureMessage()` should consume that data, and `EventRenderer.render()` should display it. This keeps the fix additive and makes server, CLI, and checkpoint behavior converge.

#### 2. `assert_exists` is a node attribute, but Sprint 036 only enforces it for tool nodes

The attribute should parse at the garden level so the syntax is uniform and future handlers can reuse it. Enforcement in this sprint stays in `ToolHandler.execute()` because the pici failure mode is specifically about shell-out steps that claim success without producing artifacts.

#### 3. Command execution is centralized

`ToolHandler.execute()` currently goes through `runScript()`, while the agent shell tool goes through `LocalExecutionEnvironment.exec()`. The latter already contains the stronger process-group timeout behavior the pici feedback asked for. Sprint 036 should extract one shared implementation and make both call sites use it, rather than hardening two separate paths forever.

#### 4. Validation remains the primary UX boundary

The shared validation path already flows through `PipelinePreparer` into CLI validate, server preview, Hive editing, and run start. Shape mismatch, missing executables, portability warnings, `diamond + prompt`, and `model` alias diagnostics should therefore live in `validateGarden()`, with runtime guards only for defense in depth.

#### 5. Provider inference must be deterministic and conservative

Provider inference from `model` should only happen when the catalog identifies a unique provider for that exact model or alias. If the model string is ambiguous or selector-like (`default`, `fast`, `reasoning`), Nectar should require `llm_provider` or warn clearly rather than guessing.

## 4. Implementation

### Phase 1 - High-Severity Runtime Corrections

This phase exists to close `BUG-1`, `BUG-2`, `BUG-4`, and `BUG-5` before any authoring UX work.

- `BUG-1`: Add a full pipeline regression in `test/integration/pici-feedback.test.ts` that drives a `shape=box` node through `CodergenHandler.executeWithAgentSession()` using a scripted adapter that calls `read_file`, `write_file`, and `shell`. The test should assert a file was created in the workspace and that the run reaches `Msquare`.
- In `src/handlers/codergen.ts`, update `CodergenHandler.executeWithAgentSession()` so failure results keep useful text alive. If `SessionResult.final_text` is non-empty on failure, write `response.md`, add `${node.id}.response` / `last_response` context updates, and incorporate an excerpt into `notes` or `error_message`.
- In `src/agent-loop/transcript.ts`, extend `TranscriptWriter.writeStatus()` so `agent-status.json` records the actual resolved `provider` and `model`, plus an optional failure response excerpt. This file is the first place users inspect after a wilted `box` node.
- In `src/engine/engine.ts`, update `PipelineEngine.buildFailureMessage()` to consult `outcome.notes` and any newly-populated `${node.id}.response` context before it falls back to generic text. The goal is that `run_error` and `pipeline_failed` always have human-usable detail.
- In `src/cli/ui/renderer.ts`, change `EventRenderer.render()` for `node_completed` failures to prefer `event.outcome.error_message ?? event.outcome.notes` when `exit_code` is missing, instead of always printing `exit code unknown`.
- In `src/garden/types.ts`, add `assertExists?: string[]` to `GardenNode`.
- In `src/garden/parse.ts`, parse `assert_exists` into `GardenNode.assertExists`. Accept a comma-separated list and trim empty segments.
- In `src/garden/validate.ts`, validate `assert_exists` syntax so empty values or whitespace-only entries are flagged before runtime.
- In `src/handlers/tool.ts`, update `ToolHandler.execute()` to enforce `input.node.assertExists` after a successful command. Missing expected files should convert the outcome to `status: 'failure'` with an explicit `error_message` listing the missing paths.
- Create `src/process/exec-command.ts` as the shared low-level command runner. It should own `detached` process-group spawning on macOS/Linux, `SIGTERM`, the 2-second grace window, `SIGKILL`, timeout bookkeeping, and abort handling.
- Refactor `src/process/run-script.ts#runScript` to call the shared helper rather than relying on `execaCommand(... timeout: ...)`.
- Refactor `src/agent-loop/execution-environment.ts#LocalExecutionEnvironment.exec` to call the same shared helper so agent shell tools and `tool_command` nodes use the same process-lifecycle semantics.
- Add `test/process/exec-command.test.ts` to prove timeout kills descendant processes, not only the parent shell.
- Expand `test/handlers/tool.test.ts` with `assert_exists` success/failure coverage and timeout coverage against the shared runner.
- Expand `test/handlers/codergen.test.ts` with failure-detail persistence coverage so a failed agent session with final text produces a useful outcome.

### Phase 2 - Validation, Model Resolution, and Authoring UX

- In `src/garden/parse.ts`, accept `model=` as an additive alias for `llm_model`. Keep `llm_model` as the stored canonical field and preserve the raw attribute for diagnostics.
- In `src/handlers/codergen.ts`, add a small resolver used by both `executeWithAgentSession()` and `executeWithLegacyClient()`:
  - explicit `llm_provider` / `llm_provider` alias wins
  - explicit `llm_model` or `model` sets the model
  - if provider is absent and model matches a unique catalog provider, infer it
  - if the legacy path is used, at minimum stop hardcoding `claude-sonnet-4-20250514`
- In `src/handlers/codergen.ts`, pass the resolved model/provider to `transcriptWriter.writeStatus()` instead of `profile.defaultModel`.
- In `src/garden/tool-command-lint.ts`, add sync helpers for:
  - extracting the command head from `tool_command`
  - resolving a command against `PATH`
  - detecting high-signal portability patterns such as `grep -P`
- In `src/garden/validate.ts`, add:
  - `SHAPE_MISMATCH_TOOL_COMMAND` for `shape=box` with `tool_command` or `script`
  - suppression of `PROMPT_MISSING` when that mismatch is present
  - `PROMPT_UNSUPPORTED_FOR_CONDITIONAL` for `shape=diamond` with `prompt`
  - `TOOL_COMMAND_NOT_FOUND` warning when the head executable is missing on the current PATH
  - `TOOL_COMMAND_PORTABILITY` warning for known GNU-only patterns
  - optional `MODEL_PROVIDER_MISMATCH` warning when `llm_provider` conflicts with a resolvable model family
- In `src/handlers/conditional.ts`, update `ConditionalHandler.execute()` to fail fast when `input.node.prompt` is present. Validation should catch this first, but the runtime guard prevents programmatic callers from getting a silent pass-through.
- In `src/runtime/pipeline-service.ts`, rewrite the graph-hash conflict text so the `--force` recovery path is the last, unmistakable sentence.
- In `src/cli/commands/resume.ts`, when catching `PipelineConflictError` from a graph-hash mismatch, print an explicit follow-up hint using the actual run ID.
- In `src/runtime/garden-draft-service.ts#buildSimulationDot`, replace legacy `script=` examples with canonical `tool_command=` examples so the Hive does not teach the deprecated path.
- In `README.md`, add a short "Choosing Node Shapes" section and a link to a focused authoring guide.
- Create `docs/garden-authoring.md` with:
  - box vs parallelogram vs diamond semantics
  - `prompt`, `tool_command`, `llm_model`, `model`, `llm_provider`, `reasoning_effort`
  - non-interactive shell behavior and alias caveats
  - `assert_exists`
  - `nectar resume --force`
- Expand `test/garden/parse.test.ts` for the `model` alias.
- Expand `test/garden/validate.test.ts` for shape mismatch warnings, conditional prompt rejection, executable-not-found warnings, portability warnings, and provider/model mismatch warnings.
- Expand `test/handlers/conditional.test.ts` for the runtime guard.
- Expand `test/runtime/garden-draft-service.test.ts` to assert simulation drafts use `tool_command=`.
- Expand `test/integration/resume.test.ts` to assert the conflict output clearly includes `--force`.

### Phase 3 - Failure Routing Parity and Pici Regression Lock-In

- In `src/engine/engine.ts#executeNodeSequence()`, mirror the main-engine failure-routing contract:
  - on `outcome.status === 'failure'`, resolve failure edges or retry targets first
  - if there is no explicit failure route, stop the branch instead of selecting the default success/fallback edge
- Keep `PipelineEngine.run()` unchanged unless the audit uncovers a remaining top-level gap. The current main loop already routes failures through `resolveFailureTarget()` before normal edge selection.
- In `src/engine/branch-executor.ts`, make the returned branch status reflect the new failure-stop behavior cleanly.
- Expand `test/engine/branch-executor.test.ts` to prove a failed branch does not keep executing downstream nodes without an explicit failure route.
- Expand `test/handlers/parallel.test.ts` to prove parallel branches inherit the same failure semantics as the top-level engine.
- Create `test/integration/pici-feedback.test.ts` as a compact regression suite covering:
  - `box + prompt` uses built-in tools and writes a file
  - failed codergen surfaces agent text in stage/pipeline failure output
  - `tool_command + assert_exists` fails when the artifact is missing
  - `diamond + prompt` is rejected during validation

### Phase 4 - Verification and Sprint Closeout

- Run `npm run build` and keep the suite TypeScript-clean.
- Run `npm test` and keep the suite green.
- Do one manual smoke run of a representative pici-style garden that includes:
  - one `box` node with `prompt`
  - one `parallelogram` node with `tool_command`
  - `assert_exists`
  - one `diamond` node using edge conditions instead of prompt
  - an interrupted/resume path that exercises the `--force` message
- Verify the node artifact layout still matches the current contract:
  - `status.json` remains engine-owned
  - `agent-status.json` remains codergen/session-specific
  - `response.md`, `prompt.md`, and tool-call artifacts stay backward-compatible

## 5. Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/handlers/codergen.ts` | Modify | Preserve agent failure text, resolve actual model/provider, improve failure outcomes |
| `src/agent-loop/transcript.ts` | Modify | Persist resolved model/provider and failure excerpts to `agent-status.json` |
| `src/engine/engine.ts` | Modify | Improve `buildFailureMessage()` and bring `executeNodeSequence()` failure routing into parity |
| `src/cli/ui/renderer.ts` | Modify | Show actionable failure detail instead of `exit code unknown` |
| `src/garden/types.ts` | Modify | Add parsed shape/postcondition metadata such as `assertExists` |
| `src/garden/parse.ts` | Modify | Parse `assert_exists` and `model` alias |
| `src/garden/validate.ts` | Modify | Add shape mismatch, conditional prompt, PATH, portability, and model/provider diagnostics |
| `src/garden/tool-command-lint.ts` | Create | Shared sync lint helpers for executable lookup and portability warnings |
| `src/handlers/tool.ts` | Modify | Enforce `assert_exists` and use hardened command execution |
| `src/process/exec-command.ts` | Create | Shared process-group command runner with timeout and abort semantics |
| `src/process/run-script.ts` | Modify | Reuse the shared command runner for `tool_command` nodes |
| `src/agent-loop/execution-environment.ts` | Modify | Reuse the shared command runner for agent shell execution |
| `src/handlers/conditional.ts` | Modify | Fail fast on `diamond + prompt` at runtime |
| `src/runtime/pipeline-service.ts` | Modify | Improve graph-hash mismatch messaging for resume |
| `src/cli/commands/resume.ts` | Modify | Make `--force` recovery explicit in CLI output |
| `src/runtime/garden-draft-service.ts` | Modify | Emit canonical `tool_command` in generated drafts |
| `README.md` | Modify | Add concise node-shape guidance and link to authoring docs |
| `docs/garden-authoring.md` | Create | Focused garden-authoring guide for shapes, model attrs, shell behavior, and postconditions |
| `test/handlers/codergen.test.ts` | Modify | Cover failure-detail persistence and resolved model/provider status |
| `test/handlers/tool.test.ts` | Modify | Cover `assert_exists` and hardened timeout behavior |
| `test/handlers/conditional.test.ts` | Modify | Cover prompt rejection on conditional nodes |
| `test/garden/parse.test.ts` | Modify | Cover `model` alias parsing |
| `test/garden/validate.test.ts` | Modify | Cover new diagnostics and lint warnings |
| `test/engine/branch-executor.test.ts` | Modify | Cover branch stop-on-failure semantics |
| `test/handlers/parallel.test.ts` | Modify | Cover parallel branch failure parity |
| `test/runtime/garden-draft-service.test.ts` | Modify | Ensure simulation draft examples use `tool_command` |
| `test/integration/resume.test.ts` | Modify | Assert the `--force` recovery path is obvious |
| `test/integration/pici-feedback.test.ts` | Create | End-to-end regression suite for the pici scenarios |
| `test/process/exec-command.test.ts` | Create | Prove process-group timeout and child cleanup behavior |

## 6. Definition of Done

- [ ] A `shape=box` node with only `prompt` succeeds in an end-to-end pipeline test and can use built-in file and shell tools.
- [ ] A failed codergen node that produced assistant text surfaces that text in `stage_failed`, `run_error`, CLI output, and node artifacts.
- [ ] `ToolHandler.execute()` supports `assert_exists` and fails an `exit 0` command when expected artifacts are missing.
- [ ] `tool_command` timeout enforcement kills the full spawned process tree and marks the node as failed.
- [ ] `runScript()` and `LocalExecutionEnvironment.exec()` share one command-execution implementation.
- [ ] `model=` is accepted as an alias for `llm_model`.
- [ ] Resolved provider/model selection is recorded in `agent-status.json` and does not silently fall back to `profile.defaultModel`.
- [ ] `shape=box + tool_command` emits a direct shape-mismatch diagnostic instead of only `PROMPT_MISSING`.
- [ ] `shape=diamond + prompt` is rejected by validation and guarded at runtime.
- [ ] Validation warns when a `tool_command` executable is missing from the current PATH.
- [ ] Validation warns for the initial set of GNU-specific portability hazards, including `grep -P`.
- [ ] `nectar resume` graph-hash mismatch output shows the exact `--force` recovery path.
- [ ] The Hive draft generator emits `tool_command=` rather than `script=`.
- [ ] README and `docs/garden-authoring.md` explain shape semantics, non-interactive shell behavior, and `assert_exists`.
- [ ] Branch execution stops on failure unless a failure route exists, matching top-level engine behavior.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `assert_exists` is too narrow and users immediately ask for a broader assertion DSL | Medium | Medium | Start with the exact pici failure mode and document it as the first postcondition primitive. Leave broader assertions as a follow-up question. |
| Process-group killing behaves differently across macOS, Linux, and Windows | Medium | High | Put the kill-tree logic in one helper, test it directly, and keep platform fallbacks explicit. |
| PATH validation produces noisy warnings in server/Hive preview environments | Medium | Medium | Keep executable diagnostics as warnings, not errors, and only emit them for simple command heads. |
| Provider inference from `model` guesses incorrectly | Medium | High | Only infer when catalog resolution is unique. Explicit `llm_provider` wins. Emit a warning on conflicts instead of silently overriding. |
| Surfacing agent failure text leaks too much output into terminal logs | Medium | Medium | Truncate rendered excerpts and keep full text in artifacts. Prefer excerpts in CLI, full content on disk. |
| Failure-routing parity in `executeNodeSequence()` changes existing branch behavior | Low | High | Add targeted branch tests before the change and treat the main-engine behavior as the source of truth. |

## 8. Security

- Validation-time executable checks must never execute `tool_command`. `src/garden/tool-command-lint.ts` should do filesystem lookup only.
- `assert_exists` paths should resolve relative to `workspace_root` and reject paths outside the workspace. Do not turn postconditions into an arbitrary filesystem probe outside the project.
- Shared process-group killing must target only the spawned subprocess group. Avoid broad `kill()` behavior that could reach unrelated processes.
- Failure text surfaced in CLI output should be truncated and treated as diagnostic data, not copied wholesale from large tool output or secrets.
- Documentation should explicitly tell users not to put secrets directly in `tool_command`, since those commands and their failures can appear in run artifacts.

## 9. Dependencies

Sprint 036 depends on Sprint 035 as the baseline stabilization layer. In practical terms, the following work needs to be present before Sprint 036 starts:

- `PipelineEngine.writeNodeStatus()` remains the canonical `status.json` writer.
- `AgentSession` keeps the current session-lifetime `max_turns`, `agent_session_completed`, `full_content`, and context-window recovery behavior.
- The server/runtime fixes around `current_node`, `pipeline_failed`, and SSE closeout from Sprint 035 are merged or cherry-picked so Sprint 036 can add pici regressions on top of a green suite instead of fighting older failures again.
- `FanInHandler` keeps the current "selection succeeds even when the selected branch failed" behavior, because Sprint 036's routing and failure-surfacing tests assume that contract.

If Sprint 035 is not green at branch-cut time, Sprint 036 should restack on the specific merged fixes rather than reopening the whole Sprint 035 scope.

## 10. Open Questions

1. Should `assert_exists` remain tool-only for Sprint 036, or should `CodergenHandler` also honor it immediately so native `box` nodes can assert file outputs without shelling out?
2. Is `model` the only alias worth adding this sprint, or should Nectar also accept `provider=` as an alias for `llm_provider` for symmetry?
3. When a user sets `model="default"` without `llm_provider`, should Nectar warn and keep provider selection explicit, or should it interpret that as "use the selected provider's default model"?
4. Should `diamond + prompt` be a hard validation error immediately, or a warning for one sprint with a runtime failure to preserve compatibility for anyone already relying on the current silent pass-through?
5. How broad should the portability lint be in Sprint 036? Start with a very small, high-signal rule set (`grep -P`, `sed -r`, `find -printf`) or ship only the `grep -P` warning from the feedback and expand later?
6. Do we want a dedicated `test/fixtures/pici-feedback.dot`, or should the regression suite keep DOT inline so the scenarios stay easy to read next to their assertions?
