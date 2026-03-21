# Sprint 023 Draft Critique — Codex Review

**Reviewing:** NEXT-CLAUDE-DRAFT.md and NEXT-GEMINI-DRAFT.md
**Perspective:** Codex (author of NEXT-CODEX-DRAFT.md)

---

## Claude Draft Critique

### Strengths

1. **Comprehensive gap coverage.** Tackles 6 of 8 remaining compliance gaps in one sprint. The bundling argument is well-reasoned — GAP-5, GAP-6, GAP-7 are individually too small for standalone sprints.
2. **Detailed AST design.** The Expression type union and BinaryOp type are concrete and implementable. The operator precedence table is explicit. This is the most architecturally specific of the three drafts on the condition language.
3. **ConditionScope expansion is well-grounded.** Correctly identifies that the engine already tracks completed nodes and artifact store — the scope assembly is plumbing, not new architecture.
4. **generate() tool loop is cleanly scoped.** The pseudocode is clear, the backward-compat story (no tools map = no loop) is sound, and the maxIterations cap is sensible.
5. **Zero new dependencies.** Correctly identifies that a hand-written recursive-descent parser is appropriate here.
6. **Risk table is thorough.** Covers numeric/string ambiguity, stat() overhead, quota pattern fragility, and backward-compat concerns with specific mitigations.

### Weaknesses

1. **Ignores the 4 failing tests.** The validation report shows 4 test failures from Sprint 022 (gardens-draft timeout, hive-run-flow timeout, http-resume 409, pipeline-events missing event). This draft does not acknowledge them. Shipping 6 new features on top of a failing test suite is risky — new failures will be harder to distinguish from pre-existing ones. The Codex draft correctly identifies these as load-bearing blockers.
2. **Scope is too wide for a single sprint.** A full condition parser rewrite (50% of the sprint) plus 5 other features across the LLM layer, agent loop, and engine creates a very broad blast radius. If Phase 1 takes longer than expected (parsers always do), the tail features get rushed or cut, but the sprint is structured as all-or-nothing.
3. **No persisted step state design.** The draft says "the engine already tracks completed nodes" but doesn't address how `steps.<nodeId>.output` survives resume. If a run checkpoints after node A and resumes, the in-memory completed-node history is gone. The Codex draft's `StepResultState` and checkpoint persistence addresses this; this draft assumes it's free.
4. **Artifact resolution is underspecified.** `artifacts.<key>` resolves to "true" for EXISTS and "the artifact value (stringified)" for comparisons — but artifacts can be large binary blobs or multi-KB text. What gets stringified? The whole thing? A bounded preview? This needs a concrete contract.
5. **Operator precedence puts string matching above comparison.** The precedence table lists string matching (CONTAINS, etc.) at precedence 5, higher than comparison operators at 4. This is counterintuitive — `a CONTAINS "x" && b > 5` would parse differently than expected if someone omits parens. Standard expression languages don't distinguish these levels.
6. **SessionConfig phase is underspecified.** The wiring description is a bullet list of "wire X to Y" without addressing how `Partial<SessionConfig>` merging works when new fields have complex types (Records). What happens when `tool_output_limits` is partially specified — does it merge with defaults or replace them entirely?
7. **GAP-7 quota detection is acknowledged as fragile but not bounded.** The risk table says "fall through to RateLimitError if pattern doesn't match" — but the implementation section doesn't specify which error codes/messages to match. Without a concrete allowlist, each adapter's detection logic will be ad hoc.

### Gaps in Risk Analysis

- **No risk identified for the generate() tool loop and error propagation.** What happens when a tool throws? The DoD says "tool errors are returned as tool_result error messages, not thrown" — but the risk table doesn't cover the case where tool execution itself hangs or OOMs.
- **No risk for condition language feature creep.** The operator set is large (13+ operators). Future pressure to add regex matching, arithmetic, or function calls is inevitable. The Codex draft explicitly caps the language; this draft doesn't.
- **No risk for `steps.*` references to nodes that haven't executed yet.** A condition referencing `steps.future_node.status` at validation time produces no warning in this design. The Codex draft adds semantic validation warnings for this.

### Missing Edge Cases

- `steps.<nodeId>.output` for nodes that completed with no response (e.g., start, exit, conditional) — what does it resolve to?
- Numeric comparison with `NaN` or `Infinity` strings
- `EXISTS` on `outcome` or `preferred_label` (non-context, non-step, non-artifact variables)
- `replace_all: true` with `old_string` that is empty string — infinite replacements?
- `glob` mtime sorting when result set exceeds the existing max-results cap — sort before or after truncation?

### Definition of Done Completeness

Thorough for the condition language (11 items) but thin for the other features. GAP-8 has 6 items but none verify that invalid config values are rejected. GAP-7 has 4 items but no DoD for specific provider error code matching. Missing: a cross-cutting DoD item for "the 4 pre-existing test failures are either fixed or explicitly documented as known failures."

---

## Gemini Draft Critique

### Strengths

1. **Tight, focused scope.** 5 gaps instead of 6, omitting GAP-7 (error subtypes). The rationale is sound — error subtypes are pure SDK polish and can wait.
2. **Clean use case descriptions.** Each use case is concrete and maps directly to a gap. The "Batch Refactoring" use case (14 occurrences) and "Recent Files Discovery" use case are particularly well-motivated.
3. **Correct identification of the `generate()` stopping condition.** Mentions inspecting `StopReason` for `tool_use`, which is more precise than just "has tool calls."
4. **SessionConfig coverage is concise.** Doesn't over-specify wiring details, which leaves room for implementation judgment.

### Weaknesses

1. **Also ignores the 4 failing tests.** Same blind spot as the Claude draft. Neither acknowledges the Sprint 022 validation report's FAIL verdict.
2. **Condition parser approach is vague.** Says "regex/tokenizer enhancements" — this is ambiguous. Is it extending the existing string-splitting parser with more regex patterns, or replacing it with a proper tokenizer? "Regex/tokenizer enhancements" could mean patching the current fragile parser rather than replacing it, which would be a mistake. The Claude and Codex drafts are both explicit about recursive-descent replacement.
3. **No AST design.** The architecture section describes what the parser will do but not what data structures it produces. Without a concrete AST type, there's no shared vocabulary for the implementation phase. This is a significant gap for the headline feature.
4. **No persisted step state.** Same gap as the Claude draft — `steps.*` and `artifacts.*` resolution is mentioned but checkpoint persistence is not addressed. "Inspecting the RunState and context store" assumes in-memory state is always available, which breaks on resume.
5. **Missing backward compatibility discussion.** No mention of ensuring existing `=`/`!=`/`&&`/`||` expressions continue to work. No backward-compat test requirement. This is a critical omission for a parser rewrite.
6. **Numeric comparison semantics are unclear.** "Type coercion (e.g., string to float for numeric comparisons) will be handled strictly but automatically" — these two words are in tension. What does "strictly but automatically" mean? What happens when one side is numeric and the other is not? The Claude draft has a clear rule (both sides must parse as finite numbers); this draft does not.
7. **Files summary references non-existent test files.** Lists `test/agent-loop/tools/edit-file.test.ts` and `test/agent-loop/tools/glob.test.ts` — these need to be verified as existing files or marked as Create.
8. **No validation/diagnostic updates.** The implementation phases don't mention updating `validateConditionExpression()` in `validate.ts`. Parsing without validation means malformed conditions are only caught at runtime.
9. **No integration test.** Only unit tests are mentioned. A condition parser that passes unit tests but fails to route correctly in a real pipeline execution is a real risk.
10. **Phase ordering puts SessionConfig (GAP-8) in the same phase as generate() (GAP-3).** These touch different subsystems (agent loop vs LLM client). Bundling them in one phase obscures progress and makes partial delivery harder.

### Gaps in Risk Analysis

- **No risk for backward-compat breakage.** This is the single most likely failure mode for a parser change, and it's not in the risk table.
- **No risk for resume/checkpoint interaction with step references.** A condition that routes on `steps.X.output` after resume will silently evaluate against empty/missing state.
- **No risk for `generate()` tool loop error handling.** What happens when a tool throws? When the tools map is missing a handler for a tool the model calls?
- **"Glob Performance on Large Dirs"** risk mentions limiting `fs.stat` concurrency but doesn't specify how. `Promise.allSettled` is concurrent by default — is there a semaphore? The Claude draft uses `Promise.allSettled` directly and argues the glob cap bounds the set; this draft suggests limiting concurrency without a mechanism.

### Missing Edge Cases

- `generate()` with tools map that doesn't contain the tool the model calls — throw or return error result?
- `EXISTS` on a context key that is defined but set to empty string — is it false?
- String comparison operators on non-string values (numbers, booleans)
- `edit_file` `replace_all` when `old_string` equals `new_string` — no-op or error?
- `glob` mtime sorting interaction with the existing max-results truncation — sorted before or after limit?

### Definition of Done Completeness

Only 8 items. Missing:
- Backward compatibility for existing condition expressions
- Malformed expression error quality (position info, helpful messages)
- `NOT` and parentheses verification
- `EXISTS` on missing keys
- `generate()` maxIterations cap behavior
- `generate()` no-tools passthrough behavior
- `SessionConfig` default values match current hardcoded constants
- Build/test pass cross-cutting item

---

## Recommendations for the Final Merged Sprint

### 1. Fix the 4 failing tests first — or make them Phase 0

The Sprint 022 validation report says FAIL. Both the Claude and Gemini drafts ignore this. The Codex draft correctly identifies HTTP lifecycle hardening as load-bearing. The final sprint must either:
- Include the HTTP fixes (as the Codex draft does), or
- Require them as a pre-sprint prerequisite with a separate fix commit

Shipping new features on a red test suite is unacceptable.

### 2. Scope to GAP-1 + the 4 test fixes + small tail (GAP-5, GAP-6)

The condition parser is the headline feature and the highest-impact remaining gap. Pair it with the trivial GAP-5 and GAP-6 fixes. Defer GAP-3 (generate loop), GAP-7 (error subtypes), and GAP-8 (SessionConfig) to the following sprint. This keeps the blast radius focused on the engine layer rather than spraying changes across engine, LLM client, agent loop, and server.

If the team insists on including GAP-3 and GAP-8, accept the Claude draft's broader scope but add the HTTP fixes as Phase 0.

### 3. Adopt the Claude draft's AST design with the Codex draft's persistence model

The Claude draft has the most concrete AST types and operator precedence rules. But it lacks persisted step state. The Codex draft's `StepResultState` and `artifact_aliases` in the checkpoint are necessary for `steps.*` and `artifacts.*` to survive resume. The final sprint must include checkpoint persistence for step results — this is not optional.

### 4. Flatten the operator precedence

The Claude draft's 6-level precedence is over-specified. Collapse comparison and string matching to the same level (they're all binary infix operators). Keep: `||` < `&&` < `NOT` < comparison/string-match < `EXISTS` < primary. This matches user intuition.

### 5. Specify numeric comparison semantics explicitly

Adopt the Claude draft's rule: both sides must parse as finite numbers via `Number()` for numeric comparison; otherwise lexicographic. Add: `NaN` and `Infinity` are not valid numeric values for this purpose.

### 6. Require backward-compat tests as a Phase 1 gate

Before any new operator tests, the first test file committed must verify every existing condition pattern in the test suite and garden fixtures parses and evaluates identically under the new parser. This is a gate, not a nice-to-have.

### 7. Add semantic validation warnings

Adopt the Codex draft's approach: `steps.<nodeId>` references where `nodeId` is not in the graph produce a validation WARNING (not error — the node might be created by composition). This catches typos at validate time rather than silent routing failures at runtime.

### 8. Bound artifact stringification

Artifacts resolved in conditions must use a bounded preview (e.g., first 1KB). Do not stringify entire artifact payloads into the condition evaluator. The Codex draft's `output_preview` pattern is the right approach.

### 9. Cap the condition language explicitly

State in the sprint document: "No regex operators, no arithmetic expressions, no function calls, no implicit type coercion beyond the numeric comparison rule. The operator set is frozen after this sprint." This prevents scope creep in future sprints.

### 10. Add a DoD item for the pre-existing test failures

Whether the final sprint includes HTTP fixes or not, the DoD must state: "`npm test` passes with zero failures, including the 4 tests that failed in the Sprint 022 validation report."
