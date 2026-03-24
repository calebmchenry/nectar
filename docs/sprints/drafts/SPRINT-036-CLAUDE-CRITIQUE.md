# Sprint 036 — Draft Critique

Reviewer: Claude Opus 4.6
Date: 2026-03-24

This document critiques the Codex and Gemini drafts for Sprint 036 against the original user feedback, the analyzed issue list, and the actual codebase state as of `main` (commit `3a6295f`).

---

## Codex Draft Critique

### Strengths

1. **Excellent codebase accuracy.** Every file path is correct. The draft distinguishes `src/garden/validate.ts` (exists) from `src/garden/validator.ts` (does not exist). It references the right functions: `executeWithAgentSession()`, `buildFailureMessage()`, `executeNodeSequence()`, `selectNextEdge()`, `TranscriptWriter.writeStatus()`. This is the most trustworthy draft to hand to an implementer.

2. **Correct diagnosis of `runScript` vs `LocalExecutionEnvironment.exec` gap (BUG-5).** The draft correctly identifies that `runScript()` (`src/process/run-script.ts`) uses bare `execaCommand` with execa's built-in `timeout` (which only kills the parent process), while `LocalExecutionEnvironment.exec()` (`src/agent-loop/execution-environment.ts:216`) already implements proper process-group killing with `detached: true`, `safeKillProcessGroup()`, and SIGTERM→SIGKILL with a 2-second grace window. The proposal to extract a shared helper in `src/process/exec-command.ts` is the right fix.

3. **Correct BUG-7 decision: reject `diamond + prompt`.** The actual `ConditionalHandler` (`src/handlers/conditional.ts`) is a 9-line no-op that returns `{ status: 'success' }`. Diamonds are routing nodes whose behavior is determined by edge conditions in `selectNextEdge()`. The draft correctly treats adding LLM evaluation to diamonds as a spec violation and proposes validation rejection + runtime guard instead.

4. **Layered failure-detail flow (BUG-2).** The three-layer approach (NodeOutcome → `buildFailureMessage()` → `EventRenderer.render()`) follows existing architecture. The draft correctly identifies that `buildFailureMessage()` at `engine.ts:985` already consults `outcome.error_message`, context keys like `${nodeId}.response`, and `${nodeId}.rationale` — so the fix is about populating those fields in `CodergenHandler`, not restructuring the engine.

5. **`assert_exists` scoped to tool nodes only.** Parsing at the garden level but enforcing only in `ToolHandler.execute()` is pragmatic — the pici failure mode is specifically about shell-out steps claiming success, not about codergen nodes.

6. **Comprehensive validation plan (Phase 2).** The draft covers shape-mismatch (`SHAPE_MISMATCH_TOOL_COMMAND`), conditional prompt rejection (`PROMPT_UNSUPPORTED_FOR_CONDITIONAL`), PATH lookup, portability lint, `PROMPT_MISSING` suppression, and model/provider mismatch — all as additive diagnostics in the existing `validateGarden()` flow.

7. **Strong security section.** Filesystem-only PATH validation (no shell-out during validation), workspace-scoped `assert_exists` paths, truncated failure text in CLI output, and a note about secrets in `tool_command` artifacts.

8. **Realistic phasing.** Phase 1 (high-severity runtime), Phase 2 (validation/UX), Phase 3 (failure routing parity + regression suite), Phase 4 (verification) is a natural dependency chain.

### Weaknesses

1. **`executeNodeSequence()` failure routing (BUG-3) is underspecified.** The draft says "mirror the main-engine failure-routing contract" and "stop the branch instead of selecting the default success/fallback edge," but the actual code at `engine.ts:1678-1722` shows that `executeNodeSequence()` emits `stage_failed` on failure but then unconditionally calls `selectNextEdge()` with the failure outcome. The edge selector (`edge-selector.ts`) doesn't have failure-aware gating — it does condition matching, preferred-label matching, weight-based selection, and alphabetical fallback. The draft doesn't specify *how* to make edge selection failure-aware. Options include: (a) adding `outcome.status` awareness to `selectNextEdge()`, (b) adding failure-edge detection before calling `selectNextEdge()`, or (c) checking for explicit failure labels before allowing edge traversal. The draft needs to pick one and describe the contract.

2. **BUG-1 framing implies more work than needed.** The draft says "the runtime already provisions tools through `CodergenHandler.executeWithAgentSession()`" and that Sprint 036 should "add end-to-end regression coverage." But the original feedback says box+prompt agents finish with 0 tool calls and no work done. If the tools are already provisioned, what's actually broken? The draft should diagnose *why* the agent doesn't use the tools despite having them — is it a prompt engineering issue, a session configuration issue, or something else? "Add regression coverage" is not a fix if the underlying behavior is still broken.

3. **Model alias resolution (BUG-6) skips catalog integration details.** The draft mentions a "small resolver" and "catalog resolution" but doesn't specify how it interacts with the existing `src/llm/catalog.ts` which has `getModelInfo()`, `resolveModelSelector()`, and provider selectors. The catalog already maps model aliases to providers. The draft should specify whether the resolver calls `getModelInfo()` directly or builds a parallel lookup.

4. **Phase 3 repeats Phase 1's integration test.** Phase 1 says "Add a full pipeline regression in `test/integration/pici-feedback.test.ts`" and Phase 3 says "Create `test/integration/pici-feedback.test.ts` as a compact regression suite." These are the same file. The draft should clarify that Phase 1 creates the file with initial coverage, and Phase 3 expands it.

5. **Open question 1 should be answered, not deferred.** The question "Should `assert_exists` remain tool-only, or should `CodergenHandler` also honor it?" has a clear answer: codergen nodes produce files through tool calls (write_file), so the agent session already validates its own outputs. Deferring this creates ambiguity for the implementer.

6. **No explicit mention of `script=` deprecation in validation.** The draft covers `buildSimulationDot` emitting `tool_command=` instead of `script=`, but doesn't add a validation warning when a user writes `script=` directly. The existing `ToolHandler` at `tool.ts:10-11` silently falls back to `attributes.script`, which means users can still use it without knowing it's deprecated.

### Gaps in Risk Analysis

- **Missing risk: `execa` behavior on timeout.** The shared command runner replaces execa's built-in timeout with manual timer + process-group kill. If execa is updated and changes its internal timeout/cleanup behavior, the manual approach could conflict. The risk table should note the execa version dependency.
- **Missing risk: `model=` conflicts with DOT syntax.** In Graphviz DOT, `model` is not a reserved word, but some tools might interpret it. Low likelihood, but worth a note.
- **Missing risk: `assert_exists` with glob patterns.** Users may expect `assert_exists="docs/*.md"` to work. The draft says "comma-separated list" but doesn't address glob expansion. If this comes up, it needs a clear "not supported in Sprint 036" statement.

### Missing Edge Cases

- What happens when `assert_exists` paths contain environment variables (e.g., `$NECTAR_RUN_DIR/output.json`)? The draft should specify whether path expansion happens.
- What if a codergen node fails *during* tool provisioning (e.g., registry throws)? The failure text flow assumes the session starts.
- What if `tool_command` is an empty string after trimming? The existing code at `tool.ts:10-11` trims, but `assert_exists` might still run on an empty command.

### Definition of Done Completeness

The DoD has 17 items covering:
- BUG-1 through BUG-7: All present (items 1-5, 6-7, 8-9, 15)
- DOC-1 through DOC-6: All present (items 8, 14, 10-11, 12, 10, 11)
- Plus build/test gates (items 16-17)

**Verdict: Complete.** All 13 feedback items are covered, plus branch-failure parity and build gates. The DoD items are specific and testable.

### Implementation Feasibility

**Feasible with caveats.** The draft proposes 4 new files and modifications to 19 existing files. The modifications are well-scoped (mostly additive). The riskiest change is the shared command runner (`src/process/exec-command.ts`) because it touches two critical execution paths. The phasing helps — if Phase 1 takes longer than expected, Phases 2-3 can be deferred without losing the high-severity fixes.

---

## Gemini Draft Critique

### Strengths

1. **Clear use-case descriptions.** The 10 use cases map directly to user scenarios and are easy to validate against the original feedback.

2. **Correct BUG-4 approach.** `assert_exists` with `fs.existsSync` after exit code 0 is the right implementation. The description of comma-separated paths with trimming matches what the pici user needed.

3. **BUG-5 process-group approach is correct at the conceptual level.** `detached: true`, `process.kill(-subprocess.pid, 'SIGTERM')`, grace period, `SIGKILL` — this matches the pattern already proven in `LocalExecutionEnvironment.exec()`.

4. **Concise scope management.** The draft argues all fixes are "highly localized" and manageable in one sprint, which is accurate — most changes are in 3-4 handler files.

### Weaknesses

1. **Wrong file path: `src/garden/validator.ts` does not exist.** The correct file is `src/garden/validate.ts`. This appears 5 times in the draft (Files Summary, Phase 3 tasks for DOC-1/DOC-3, DOC-5, DOC-6). An implementer following this draft would immediately hit a dead end looking for a nonexistent file. This is a fundamental accuracy failure.

2. **BUG-7 design decision is wrong: diamond nodes should NOT run LLM evaluation.** The draft says "Diamond nodes with a `prompt` attribute will instantiate an LLM session to evaluate the prompt as a condition." This contradicts the Attractor spec's shape semantics. The actual `ConditionalHandler` (`src/handlers/conditional.ts`) is a deliberate no-op — diamonds are routing nodes whose outcomes are determined by `selectNextEdge()` evaluating edge conditions against context. Adding LLM evaluation to conditionals creates a new execution model that conflicts with the spec. The Codex draft correctly rejects this approach. The intent document also lists this as an open question, and the conservative answer (reject `diamond + prompt`) is safer.

3. **BUG-5 implementation location is wrong.** The draft says to modify `spawn` in `src/handlers/tool.ts`, but `ToolHandler.execute()` doesn't call `spawn` — it calls `runScript()` from `src/process/run-script.ts`, which calls `execaCommand()`. The draft doesn't mention `run-script.ts` at all and doesn't recognize that the process-group pattern already exists in `execution-environment.ts:220-263`. An implementer would need to independently discover the correct files.

4. **BUG-3 implementation targets the wrong file.** The draft says to modify `src/engine/edge-selector.ts` to stop default fan-out on failure. But the problem is in `executeNodeSequence()` at `engine.ts:1695`, which calls `selectNextEdge()` *unconditionally* after failure. The fix could go in either place, but the draft doesn't mention `executeNodeSequence()` at all and doesn't analyze the actual control flow. The edge selector doesn't currently have any concept of "this is a failure edge" — it matches conditions, labels, and weights. The draft's description ("modify the logic to ensure that if the current node's outcome is `failure`, default unlabeled edges are NOT selected") is vague about what "default unlabeled" means in the context of the actual `selectNextEdge()` implementation.

5. **BUG-1 diagnosis is shallow.** The draft says "ensure that when initializing an agent session for a `box` + `prompt` node, the session is provisioned with default filesystem tools from the tool registry." But `CodergenHandler.executeWithAgentSession()` *already* creates a `ToolRegistry` and registers 11 tools (read_file, write_file, edit_file, shell, grep, glob, etc.). If the tools are already registered, saying "provision them" isn't a fix — the draft needs to diagnose *why* the agent finishes with 0 tool calls despite having tools.

6. **Missing DOC-2 treatment in implementation.** Phase 3 says "Update `README.md` to clarify non-interactive shells" but doesn't specify creating a dedicated authoring guide. The pici user needed to understand shell alias behavior, `assert_exists`, shape semantics, and model attributes — a README paragraph is insufficient. The Codex draft proposes `docs/garden-authoring.md` as a focused guide.

7. **DOC-5 proposes shelling out during validation.** The draft says "verify its existence on the system `PATH` using `which` or `command -v`." This is a security concern — validation should never execute commands. The correct approach (used by the Codex draft) is filesystem-only PATH resolution: split `$PATH`, check `fs.existsSync(path.join(dir, head))` for each directory.

8. **No mention of `buildSimulationDot` or Hive draft examples (DOC-3 partial).** The draft doesn't address the Hive draft generator emitting legacy `script=` examples. `GardenDraftService.buildSimulationDot()` at `garden-draft-service.ts:263` is the source of generated examples, and it should emit `tool_command=`. This is listed in the feedback analysis as part of DOC-3.

9. **Missing `model=` alias for `llm_model` (BUG-6 partial).** The draft says to "retrieve the `model` attribute from the node definition" but doesn't mention that the parser (`parse.ts`) currently only recognizes `llm_model` — it doesn't parse `model=` as an alias. The draft's BUG-6 fix would only work if the user writes `llm_model=`, not the `model=` they actually used in the feedback.

10. **3-second grace period vs 2-second.** The draft specifies "wait 3 seconds" between SIGTERM and SIGKILL. The existing implementation in `execution-environment.ts:251-253` uses 2 seconds. This inconsistency would create two different timeout behaviors for the same codebase.

### Gaps in Risk Analysis

- **Missing risk: no shared command runner.** The draft puts process-group logic directly in `tool.ts` rather than extracting a shared helper. This means agent shell tools (`execution-environment.ts`) and tool_command nodes (`tool.ts`) would have divergent timeout implementations. The Codex draft correctly identifies this as a risk and proposes unification.
- **Missing risk: `model` attribute not being parsed.** The draft assumes `model` is available on the node object, but the parser only maps `llm_model` to `GardenNode.llmModel`. Without a parser change, `input.node.attributes.model` would need raw attribute access, bypassing the typed interface.
- **Missing risk: diamond LLM evaluation latency and cost.** Listed as "High likelihood, Low impact" but this understates it — adding LLM calls to routing decisions changes the cost model of every pipeline with diamonds, and the evaluation prompt engineering is non-trivial (how do you map free-text LLM output to edge labels reliably?).
- **Missing risk: `which`/`command -v` portability.** The draft proposes these for PATH validation, but `which` itself behaves differently across platforms (absent on some minimal Linux images, different behavior on macOS vs GNU which).

### Missing Edge Cases

- What if `assert_exists` paths are absolute? Should they be rejected, or resolved relative to workspace root?
- What happens when a diamond node has a `prompt` AND edge conditions? The draft's LLM approach doesn't address condition expression precedence.
- The draft's BUG-3 fix ("unlabeled edges are NOT selected") would break pipelines where the single outgoing edge is unlabeled. In many DOT files, edges don't have labels at all — the draft needs to distinguish "no failure-specific edges" from "no labeled edges."
- No treatment of `model` values that don't exist in the catalog (e.g., typos like `claud-sonnet`).

### Definition of Done Completeness

The DoD has 9 items:
- BUG-1 through BUG-7: Covered (items 1-4, 7)
- DOC-1/DOC-3: Covered (item 5)
- DOC-4: Covered (item 7)
- DOC-5: Covered (item 6)
- DOC-2: Partially covered (item 8, README only)
- **DOC-6 (cross-platform linting): Missing from DoD.** It's in Phase 3 tasks but not in the Definition of Done checklist.
- **DOC-3 (Hive draft examples): Missing.** `buildSimulationDot` emitting `tool_command=` is not addressed.

**Verdict: Incomplete.** DOC-6 is absent from the DoD, DOC-3 is partially addressed (validation warnings but not Hive draft output), and DOC-2 lacks a dedicated authoring guide. The DoD items are also less specific than the Codex draft's — "All 7 code bugs are fixed" is not independently verifiable without decomposing what "fixed" means for each one.

### Implementation Feasibility

**Partially feasible, with significant corrections needed.**

- BUG-5 implementation targets the wrong file and function. An implementer must independently discover `run-script.ts` and `execution-environment.ts`.
- BUG-7 design decision (LLM diamond evaluation) would require substantial new code (prompt engineering, output parsing, edge-label matching) that the draft doesn't scope. This is a multi-day feature, not a bug fix.
- BUG-3 fix in `edge-selector.ts` alone won't work — the control flow issue is in `executeNodeSequence()`.
- `src/garden/validator.ts` references would block every validation-related task until the implementer finds the correct file.

---

## Comparative Summary

| Dimension | Codex Draft | Gemini Draft |
|-----------|-------------|--------------|
| File path accuracy | All correct | `validator.ts` wrong (5 occurrences) |
| BUG-1 diagnosis depth | Acknowledges tools exist, adds regression | Doesn't recognize tools already exist |
| BUG-2 failure flow | Three-layer approach through existing primitives | Correct direction, less specific |
| BUG-3 implementation target | `executeNodeSequence()` + `branch-executor.ts` (correct) | `edge-selector.ts` only (incomplete) |
| BUG-5 process-group unification | Shared helper extracted from existing pattern | Reimplements in wrong file |
| BUG-7 diamond semantics | Reject prompt (spec-aligned) | LLM evaluation (spec-violating) |
| BUG-6 model alias | Parser change + catalog integration | Assumes attribute already available |
| DOC-5 PATH validation safety | Filesystem-only lookup | Shells out via `which`/`command -v` |
| DOC-3 Hive drafts | Covered (`buildSimulationDot`) | Missing |
| Definition of Done | 17 items, all specific | 9 items, some vague, DOC-6 missing |
| Security analysis | Thorough (5 items) | Minimal (2 items) |
| Risk analysis | 6 risks with mitigations | 4 risks, some understated |
| Test plan | 10 test files, specific scenarios | 3 test files, general coverage |
| Phasing | 4 phases with clear dependencies | 3 phases, reasonable |
| Open questions | 6 honest unknowns | "Decisions made" but some are wrong |

## Recommendations

1. **Use the Codex draft as the base.** It has correct file paths, correct architectural analysis, and a more complete DoD.
2. **Incorporate the Gemini draft's use-case descriptions** — they're clearer and more user-focused.
3. **Resolve BUG-1 root cause before sprint start.** Both drafts acknowledge tools are registered but the agent doesn't use them. Someone needs to trace why `executeWithAgentSession()` produces 0 tool calls despite having 11 tools registered. Is it a prompt issue? A model capability issue? This diagnosis should happen in sprint planning, not during execution.
4. **Firm up BUG-3 design.** Neither draft fully specifies how failure-aware edge selection works. Propose: add an `outcome.status` check in `executeNodeSequence()` before calling `selectNextEdge()`. If status is `failure`, first look for edges with condition expressions that match failure (e.g., `outcome == "failure"`). If none exist, stop the sequence. Only if an explicit failure edge exists should execution continue.
5. **Drop BUG-7 LLM evaluation.** The Gemini draft's approach is architecturally unsound. Validate-and-reject is the right call.
6. **Add `script=` deprecation warning.** Neither draft adds a validation diagnostic for the legacy `script=` attribute, but the pici user's feedback and the existing fallback at `tool.ts:11` indicate this is a live confusion vector.
