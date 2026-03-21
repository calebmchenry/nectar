# Sprint 023 Merge Notes

**Merged from:** NEXT-CLAUDE-DRAFT.md, NEXT-CODEX-DRAFT.md, NEXT-GEMINI-DRAFT.md
**Critiques considered:** NEXT-CODEX-CRITIQUE.md, NEXT-GEMINI-CRITIQUE.md

---

## Scope Decision

The final sprint adopts the **Codex draft's strategic focus** — condition language + HTTP lifecycle fixes — rather than the Claude draft's broader 6-gap sweep. Both critiques independently recommended this narrower scope.

**Included:** GAP-1 (conditions), HTTP lifecycle hardening (4 failing tests), GAP-5 (replace_all), GAP-6 (glob mtime)

**Deferred to a future sprint:**
- GAP-3 (generate() auto tool loop) — from Claude and Gemini drafts. Both critiques agreed this is SDK polish and can wait.
- GAP-7 (error subtypes) — from Claude draft only. Codex critique noted quota detection is fragile across providers; Gemini draft explicitly excluded it.
- GAP-8 (SessionConfig expansion) — from Claude and Gemini drafts. Codex critique flagged underspecified Partial<SessionConfig> merging. Deferring keeps the blast radius focused on engine + server.

---

## What Was Taken from Each Draft

### From NEXT-CLAUDE-DRAFT.md (Claude)
- **AST design and type definitions.** The `Expression` type union, `BinaryOp` type, and `ConditionScope` interface were the most concrete and implementable of the three drafts. Adopted nearly verbatim.
- **Operator set.** All 13 operators (=, !=, <, >, <=, >=, CONTAINS, STARTS_WITH, ENDS_WITH, EXISTS, NOT, &&, ||) plus parentheses.
- **Recursive-descent parser approach.** All three drafts agreed on this; Claude's was the most detailed on precedence and parser structure.
- **Backward compatibility guarantees.** Explicit requirement that existing conditions parse identically, with a gate before new operator tests.
- **GAP-5 and GAP-6 implementation details.** The `replace_all` contract and `Promise.allSettled()` stat approach were cleanly specified.
- **Zero new dependencies.** All three agreed; Claude stated it most explicitly.

### From NEXT-CODEX-DRAFT.md (Codex)
- **Phase 0: Fix failing tests first.** The Codex draft was the only one that acknowledged the 4 Sprint 022 test failures as blockers. Both critiques flagged this as a critical gap in the other two drafts. This became Phase 0 with a green-test gate.
- **Persisted step state model.** `StepResultState` with `output_preview`, `output_artifact_id`, and `artifact_aliases` in the checkpoint. The Claude and Gemini drafts assumed in-memory state would always be available, which breaks on resume. The Codex persistence model is necessary for correctness.
- **"Last execution wins per node ID" rule.** Clean, opinionated, removes ambiguity from the implementation.
- **Handler normalization contracts.** Deterministic artifact aliases from codergen, tool, wait.human, and fan-in handlers.
- **Run lifecycle state machine.** `ActiveLifecycle` enum with `booting`, `running`, `cancelling`, `terminal` states and the pending-cancel pattern.
- **SSE terminal event barrier.** Two-step commit for terminal events — journal flush before status transition.
- **Draft SSE deterministic completion.** Exactly one terminal event, tab-local abort cleanup.
- **Semantic validation warnings.** `steps.<nodeId>` references to nonexistent nodes produce warnings (not errors, since composition may create them).
- **Module layout guidance.** The Codex draft's file-level organization for the condition engine informed the files summary.

### From NEXT-GEMINI-DRAFT.md (Gemini)
- **StopReason-based tool loop detection.** While the generate() loop was deferred, Gemini's note about inspecting `StopReason` for `tool_use` (rather than just checking for tool calls) was noted for the future sprint.
- **Use case framing.** The "Batch Refactoring" use case (14 occurrences) and "Recent Files Discovery" use case were well-motivated and influenced the final use case descriptions.
- **Scope exclusion of GAP-7.** Gemini's rationale for omitting error subtypes ("pure SDK polish") was adopted.

---

## What Was Rejected and Why

### From NEXT-CLAUDE-DRAFT.md
- **6-level operator precedence.** The Claude draft separated comparison operators (level 4) from string matching operators (level 5). The Codex critique correctly noted this is counterintuitive and non-standard. Flattened to a single level for all binary infix operators.
- **`artifacts.<key>` resolves to "true" for EXISTS.** Underspecified — artifacts can be large. Replaced with the Codex draft's bounded `output_preview` pattern and explicit alias map.
- **GAP-3, GAP-7, GAP-8 inclusion.** Too broad for one sprint. The condition parser rewrite (50% of effort) paired with 5 other features across LLM client, agent loop, and server creates excessive blast radius. Both critiques recommended narrowing.
- **`EXISTS` as postfix in examples but prefix in AST.** The Gemini critique caught this inconsistency. Standardized on prefix (`EXISTS artifacts.report`).

### From NEXT-CODEX-DRAFT.md
- **Numeric comparison evaluates false for non-numeric operands.** Initially considered adopting the Claude draft's lexicographic fallback, but the Codex draft's "evaluates false" approach is safer and more predictable. However, the final sprint uses the Claude draft's `Number()` finite check as the numeric detection method.
- **Separate `condition-parser.ts` and `edge-selector.ts` files.** The Codex draft proposed new files; the final sprint keeps the parser in `conditions.ts` (rewrite) to minimize file proliferation. The edge selection logic stays in `engine.ts`.
- **Cancel/resume during `cancelling` state.** The Gemini critique asked how this resolves. The final sprint rejects resume while lifecycle is `cancelling` — the abort must complete first.

### From NEXT-GEMINI-DRAFT.md
- **"Regex/tokenizer enhancements" approach.** The Codex critique correctly flagged this as ambiguous — it could mean patching the existing fragile parser rather than replacing it. The recursive-descent replacement from Claude and Codex is the right approach.
- **No AST design.** The Gemini draft described behavior but not data structures. Without a concrete AST type there's no shared vocabulary for implementation.
- **No backward-compat discussion.** Critical omission for a parser rewrite. Both critiques flagged this.
- **No validation/diagnostic updates.** The implementation phases didn't mention updating `validateConditionExpression()`. Adopted from Claude and Codex drafts.
- **No integration tests.** Only unit tests were mentioned. Adopted the Claude/Codex approach of requiring integration tests for conditional routing.

---

## Key Design Decisions from Critiques

1. **Codex critique recommendation #1 (fix failing tests first):** Adopted as Phase 0 with a gate.
2. **Codex critique recommendation #3 (Claude AST + Codex persistence):** This became the core architecture — Claude's parser design backed by Codex's checkpoint persistence.
3. **Codex critique recommendation #4 (flatten precedence):** Comparison and string matching operators are at the same precedence level.
4. **Codex critique recommendation #5 (numeric semantics):** Adopted Claude's `Number()` finite check rule with explicit NaN/Infinity exclusion.
5. **Codex critique recommendation #7 (semantic warnings):** Validation warns on nonexistent node references.
6. **Codex critique recommendation #8 (bound artifact stringification):** 1KB output_preview limit adopted from Codex's step-state design.
7. **Codex critique recommendation #9 (cap the language):** Explicit freeze statement in the sprint document.
8. **Gemini critique recommendation #2 (Claude grammar + Codex state model):** Same conclusion as Codex critique #3 — independent convergence.
9. **Gemini critique recommendation #3 (truncation risk):** Added as a risk with mitigation guidance about structured output for critical routing signals.
10. **Gemini critique recommendation #4 (lock down EXISTS syntax):** Standardized on prefix.
