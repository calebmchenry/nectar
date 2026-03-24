# Sprint 036 Draft Critique

I evaluated both drafts against:

- `/Users/caleb.mchenry/code/ai-pici/.nectar/feedback.md`
- `/Users/caleb.mchenry/code/nectar/notes/pici-feedback-analysis.md`
- The current implementation in `src/`

The 13-item scope from the analysis file is the right baseline: 7 code bugs and 6 documentation/UX items.

## Overall Take

The **Claude draft is materially stronger**. It is closer to the real implementation structure, has a much better Definition of Done, and correctly identifies at least one important root-cause area: the fan-out-after-failure bug is in branch sequencing, not just generic edge selection.

The **Gemini draft is not implementation-ready**. It points at several wrong files, understates the plumbing required for diamond+prompt evaluation, and its DoD is too generic to verify the 13 requested items.

If I had to pick a base, I would start from the Claude draft, but I would correct the BUG-1/BUG-2/BUG-7 assumptions and remove some scope creep before implementation starts.

---

## Draft 1: `SPRINT-036-CLAUDE-DRAFT.md`

### Strengths

- It is much better grounded in the actual code layout. The cited files mostly exist and are the right places to look: `src/handlers/codergen.ts`, `src/agent-loop/session.ts`, `src/process/run-script.ts`, `src/garden/parse.ts`, `src/garden/validate.ts`, and `src/runtime/pipeline-service.ts`.
- Its analysis of BUG-3 is the strongest part of either draft. The main engine already routes failures through `resolveFailureTarget()` in `src/engine/engine.ts:541-583`; the branch path in `executeNodeSequence()` still calls `selectNextEdge()` directly in `src/engine/engine.ts:1695-1715`. That is exactly where “fan-out continues after predecessor failure” can happen inside branch execution.
- It recognizes that BUG-6 belongs in the parser, not just the handler. `src/garden/parse.ts:155-160` populates `node.llmModel`, and `CodergenHandler` already consumes `input.node.llmModel` in `src/handlers/codergen.ts:76-78`.
- It has the best DoD coverage. Unlike the Gemini draft, it attempts explicit acceptance criteria for every bug and doc item instead of collapsing them into “all bugs fixed.”
- Its security notes are useful. The warnings about `which` command injection and path traversal for post-conditions are real concerns.

### Weaknesses

- **BUG-1 root-cause analysis is too confident and probably incomplete.** The draft assumes the main issue is `ProviderProfile.visibleTools` filtering in `src/agent-loop/session.ts:366-389`. That filter is real, but the current profiles do not expose “no tools”; they expose provider-specific subsets. Anthropic exposes 6 tools in `src/agent-loop/provider-profiles.ts:64-65`, OpenAI exposes 6 in `src/agent-loop/provider-profiles.ts:89-90`, and Gemini exposes 8 in `src/agent-loop/provider-profiles.ts:109-118`. That means “tools are completely missing” is not established by the current code.
- **The new `tools="none"` / `tools="all"` attribute is scope creep.** The feedback asked for “works with tools or rejects clearly.” Inventing a new node attribute is a product decision, not a necessary fix for the reported issues.
- **The BUG-2 implementation path is partly wrong.** The draft says the engine/event/status side needs work, but `PipelineEngine` already writes `outcome.notes` into both `node_completed` events and `status.json` in `src/engine/engine.ts:483-517` and `src/engine/engine.ts:1089-1105`. The real user-visible gap is the renderer: `src/cli/ui/renderer.ts:37-83` does not display `notes` for failed nodes; it displays `error_message`, `stderr`, or a generic exit-code string.
- **BUG-2 also misses the bigger semantic problem:** agent sessions with zero tool calls are currently treated as success. In `src/agent-loop/session.ts:677-689`, `toolCalls.length === 0` returns `buildResult('success', ...)`. Merely “surfacing final text on failure” does not address the fact that one major failure mode currently exits on the success path.
- **`assert_files` diverges from the user’s suggested `assert_exists`.** The feedback explicitly suggested `assert_exists="docs/drafts/current-item.md"`. Renaming it to `assert_files` without at least supporting the original spelling is unnecessary friction in a sprint that is supposed to respond directly to first-user feedback.
- **The BUG-5 plan overemphasizes options Execa already defaults.** With `execa@^9.6.0`, `forceKillAfterDelay` already defaults to 5000ms and `cleanup` already defaults to `true` in `node_modules/execa/types/arguments/options.d.ts:295-325`. The real missing piece is process-group handling around `shell: true` in `src/process/run-script.ts:19-30`.
- **BUG-7 semantics are too narrow.** The draft turns diamond prompts into YES/NO => success/failure and even uses the wrong condition syntax in the use case (`outcome.status=success`). The actual router works with `outcome=success` / `outcome=failure` conditions and `preferred_label` matching in `src/engine/edge-selector.ts:19-46` and `src/engine/edge-selector.ts:77-85`. A realistic design needs to say how labeled edges, fallback edges, and multi-way routing behave.
- **The draft quietly proposes extra scope again with `continue_on_failure`.** That attribute does not come from the feedback and would expand the control-flow surface in the same sprint that is trying to fix control-flow correctness.
- **The integration-test proposal is too ambitious for the value it adds.** `SimulationProvider` in `src/llm/simulation.ts:46-165` does not exercise real tool-calling behavior, so a single “pici feedback integration test” will not prove the hardest parts of BUG-1 or BUG-2. Targeted unit tests would be more reliable.

### Gaps in Risk Analysis

- It does not call out the **renderer gap** for BUG-2. Without changing `src/cli/ui/renderer.ts:37-83`, notes will still not be visible in the normal failure path.
- It does not call out the **zero-tool-call success path** in `src/agent-loop/session.ts:677-689`, which is one of the highest-risk behavioral mismatches in the whole sprint.
- It does not call out the **spec conflict** around BUG-7. The upstream spec currently defines diamonds as pass-through nodes: `docs/upstream/attractor-spec.md:788-798` and `docs/upstream/attractor-spec.md:2039-2045`.
- It misses the **cross-platform risk** on BUG-5. The suggested `process.kill(-pid, ...)` path is POSIX-specific. The Gemini draft at least acknowledges Windows; the Claude draft does not.
- It does not mention that post-condition path resolution is ambiguous because `runScript()` uses `cwd: process.cwd()` in `src/process/run-script.ts:21`, while the engine’s official workspace root is tracked separately in `src/engine/engine.ts:381`.

### Missing Edge Cases

- **Provider-specific tool sets:** any DoD that requires a universal “7 core tools visible” is incompatible with the current profile layer, where visible tool counts differ by provider.
- **Prompt node returns text but does no work:** this is the core “looks successful but wasn’t” case. The draft mentions it, but its proposed implementation does not fully specify whether the node becomes `failure`, `partial_success`, or still `success` with stronger notes.
- **Diamond nodes with labeled edges:** if edges are labeled `Yes` / `No` or `Approve` / `Reject`, returning only `status` loses information that the engine already knows how to route via `preferred_label`.
- **Duplicate normalized labels on diamond edges:** `WaitHumanHandler` explicitly protects against this in `src/handlers/wait-human.ts:65-90`. A diamond LLM evaluator should either reuse that discipline or document different behavior.
- **`assert_exists` / `assert_files` with multiple paths:** the draft says “check each path,” but it does not say whether the failure message reports only the first missing file or all missing files.
- **Validation false positives for PATH checks:** `tool_command` runs via `shell: true`, so a naive first-token parse will mis-handle shell builtins, `FOO=bar cmd`, `bash -lc ...`, `npx`, and quoted commands.
- **Branch-context parity:** `executeNodeSequence()` currently passes a smaller handler input surface than the main engine loop. Compare `src/engine/engine.ts:1577-1587` to `src/engine/engine.ts:372-388`. Any new behavior that depends on `workspace_root`, graph-level hooks, or session registry needs branch coverage.

### Definition of Done Completeness

The Claude draft is the only one that explicitly attempts all 13 items, but several acceptance criteria are mis-specified.

| Item | Coverage | Critique |
|------|----------|----------|
| BUG-1 | Explicit | Covered, but the “>=7 tools visible” criterion is not compatible with current provider profiles. |
| BUG-2 | Explicit | Covered, but notes alone will not fix CLI visibility. |
| BUG-3 | Explicit | Strong and correctly targeted. |
| BUG-4 | Explicit | Covered, but under a renamed attribute (`assert_files`). |
| BUG-5 | Explicit | Covered, but with some redundant Execa options and no Windows acceptance story. |
| BUG-6 | Explicit | Good. |
| BUG-7 | Explicit | Covered, but semantics are too narrow for labeled/multi-way routing. |
| DOC-1 | Explicit | Good. |
| DOC-2 | Explicit | Good in spirit, though it may belong in docs plus validation. |
| DOC-3 | Explicit | Good. |
| DOC-4 | Explicit | Good and correctly points at `pipeline-service.ts`. |
| DOC-5 | Explicit | Good, but token parsing details are under-specified. |
| DOC-6 | Explicit | Good as best-effort linting. |

**Bottom line:** yes, it covers all 13 items on paper, but BUG-1, BUG-2, BUG-4, and BUG-7 need acceptance criteria tightened before implementation starts.

### Implementation Feasibility

This draft is **feasible with corrections**.

- BUG-3, BUG-6, DOC-1, DOC-4, and most of DOC-5/DOC-6 are straightforward fits for the current codebase.
- BUG-4 is also feasible, but I would strongly recommend supporting `assert_exists` at least as an alias to keep the user-facing API aligned with the original feedback.
- BUG-5 is feasible, but it likely belongs primarily in `src/process/run-script.ts`, not as an Execa-option tweak only.
- BUG-7 is feasible only if the plan is revised to match existing routing semantics. The cleanest shape would be to inject an LLM client into `ConditionalHandler` the same way `FanInHandler` already does in `src/handlers/fan-in.ts:29-36`, then return `preferred_label` and/or a normalized status based on outgoing edges.

**Recommendation:** use this draft as the base, but remove `tools="none"`, remove `continue_on_failure`, support `assert_exists`, and rewrite BUG-2/BUG-7 around actual current behavior.

---

## Draft 2: `SPRINT-036-GEMINI-DRAFT.md`

### Strengths

- It correctly preserves the feedback’s suggested attribute name, `assert_exists`, instead of inventing a new one.
- It identifies the right product-level pain points: silent agent failures, unenforced timeouts, misleading validation, and model selection.
- It at least acknowledges the Windows risk for process-group killing, which the Claude draft omits.
- Its diamond-node direction is a bit more aligned with the existing router than the Claude draft because it mentions returning values that match outgoing edge labels, not just YES/NO.

### Weaknesses

- **Several proposed edit points are wrong.** This is the biggest problem.
- Validation lives in `src/garden/validate.ts`, not `src/garden/validator.ts`.
- The hash-mismatch error string comes from `src/runtime/pipeline-service.ts:275-283`, not `src/cli/commands/resume.ts`.
- Subprocess spawning happens in `src/process/run-script.ts:17-54`, not directly in `src/handlers/tool.ts`.
- BUG-2 does not require `src/agent-loop/events.ts`; the problem is in the codergen/session/renderer flow.
- `docs/validation-report.md` does not exist; the repo has `docs/sprints/validation-report.md`.
- `src/llm/catalog.ts` is not where the `model` attribute bug lives. The parser is.
- **BUG-3 is targeted at the wrong layer.** The draft says to change `src/engine/edge-selector.ts`, but the main engine already handles failure routing separately through `resolveFailureTarget()` in `src/engine/engine.ts:541-583`. The observed bug is in branch sequencing, where `executeNodeSequence()` still uses `selectNextEdge()` after failures in `src/engine/engine.ts:1678-1715`.
- **BUG-6 is targeted at the wrong layer too.** The draft suggests reading `model` in `src/handlers/codergen.ts`, but the real issue is that `parse.ts` does not populate `node.llmModel` from a plain `model` attribute. `src/garden/parse.ts:155-160` is the real fix point.
- **BUG-2 is under-specified.** Adding notes in the handler does not make CLI output visible, because `src/cli/ui/renderer.ts:37-83` does not render notes on failed nodes. It also does not address the fact that zero-tool agent runs can currently exit on the success path in `src/agent-loop/session.ts:677-689`.
- **BUG-7 is too hand-wavy.** “Spawn an LLM evaluation session” is not enough implementation guidance. The current `ConditionalHandler` is a no-op in `src/handlers/conditional.ts:1-7`, and `HandlerRegistry` constructs it without any LLM client in `src/handlers/registry.ts:27-33`. The draft never explains that plumbing.
- **The draft claims spec alignment while proposing a spec change.** It says the sprint will make nectar “adhere strictly to the Attractor spec,” but the current upstream spec explicitly defines diamonds as pass-through nodes, not LLM-evaluated prompts.
- **Its scope estimate is not credible.** The draft says the fixes are “highly localized,” mostly in `tool.ts`, `codergen.ts`, and `validator.ts`. That is not true for BUG-3, BUG-4, BUG-5, BUG-6, BUG-7, or DOC-4.

### Gaps in Risk Analysis

- It does not mention the risk that the plan is pointing at the wrong files.
- It does not mention the renderer/path-to-user issue for BUG-2.
- It does not mention the zero-tool-call success path in `AgentSession`.
- It does not mention command-injection risk around PATH validation.
- It does not mention path traversal / workspace-boundary handling for `assert_exists`.
- It does not mention the ambiguity of diamond routing when there are more than two outgoing edges or when labels and conditions coexist.
- It does not mention the difference between main-engine execution and branch execution, which matters directly for BUG-3.

### Missing Edge Cases

- **PATH validation under `shell: true`:** builtins, quoted commands, environment prefixes, `npx`, and `bash -lc` wrappers.
- **`assert_exists` on relative paths:** the draft says to verify existence but never says whether paths are relative to the workspace root, the run directory, or `process.cwd()`.
- **Diamond routing with labeled edges, fallback edges, and duplicate labels:** the current engine already has label normalization in `src/engine/edge-selector.ts:77-85`; the draft does not tie into that.
- **Backward compatibility for existing condition-based diamonds:** current conditional routing works via edge conditions and a no-op handler. The draft does not say how prompted diamonds coexist with that.
- **CLI visibility of failure text:** even if notes are attached, failed node rendering still ignores them.
- **Parallel branch behavior:** the draft fixes failure routing in the wrong place and never says how to test the actual branch sequence bug.

### Definition of Done Completeness

This is the weakest part of the Gemini draft. The DoD is too generic to tell whether all 13 requested items are actually done.

| Item | Coverage | Critique |
|------|----------|----------|
| BUG-1 | Partial | Mentioned in narrative/tasks, but no measurable DoD beyond “all 7 bugs fixed.” |
| BUG-2 | Partial | No explicit DoD for CLI visibility, `status.json`, or zero-tool-call behavior. |
| BUG-3 | Explicit | Covered, but the implementation target is wrong. |
| BUG-4 | Explicit | Covered and aligned to feedback naming. |
| BUG-5 | Explicit | Covered, but proposed file target is wrong. |
| BUG-6 | Partial | No explicit parser-level acceptance or precedence rule. |
| BUG-7 | Partial | No explicit acceptance semantics for labels vs status vs notes/context. |
| DOC-1 | Explicit | Covered. |
| DOC-2 | Explicit | Covered via README, though validation-side UX is still underplayed. |
| DOC-3 | Partial | Covered in spirit, but not with a concrete acceptance test. |
| DOC-4 | Explicit | Covered, but again in the wrong file. |
| DOC-5 | Explicit | Covered. |
| DOC-6 | Partial | Mentioned in implementation, but not called out explicitly in the DoD. |

**Bottom line:** no, this DoD does not adequately cover all 13 items in a verifiable way. It gestures at the full scope, but it does not define success precisely enough.

### Implementation Feasibility

As written, this draft is **not implementation-feasible without re-planning**.

- An implementer would immediately lose time because several file references are wrong or nonexistent.
- The BUG-3 fix would likely change the wrong subsystem.
- The BUG-6 fix would likely be incomplete if it only touched the handler.
- The BUG-7 fix omits the LLM-client plumbing entirely.
- The DOC-4 fix would likely change CLI presentation without fixing the actual source message in `PipelineService`.

There is still reusable value here:

- Keep the simpler prioritization.
- Keep the `assert_exists` naming.
- Keep the Windows/process-group risk note.

But the actual implementation plan needs to be rebuilt around the real code paths: `src/garden/validate.ts`, `src/runtime/pipeline-service.ts`, `src/process/run-script.ts`, `src/garden/parse.ts`, `src/handlers/conditional.ts`, `src/handlers/registry.ts`, and the branch path inside `src/engine/engine.ts`.

---

## Recommendation

Use the **Claude draft as the base**, but correct these points before anyone starts coding:

1. Reframe BUG-1 as a diagnostic-first investigation, not a visibility-filter assumption.
2. Remove `tools="none"` and `continue_on_failure` from sprint scope.
3. Keep `assert_exists` as the public attribute name, or support it as an alias if `assert_files` is introduced internally.
4. Rewrite BUG-2 around the real failure-to-user path: `AgentSession` zero-tool success behavior plus `EventRenderer` ignoring `notes`.
5. Decide whether BUG-7 is a deliberate spec change. If yes, define routing in terms of `preferred_label` and existing edge-selection behavior, not only YES/NO -> status.
6. Add branch-path and cwd/workspace-root edge cases to the test plan.

The Gemini draft is useful as a product-summary, but not as an implementation plan.
