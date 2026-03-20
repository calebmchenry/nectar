# Sprint NEXT Critique — Claude

> **Note:** The Codex draft (`NEXT-CODEX-DRAFT.md`) does not exist. This critique covers the two available drafts: **Gemini** and **Claude**.

---

## Gemini Draft: "Human-in-the-Loop & Core Engine Polish"

### Strengths

1. **Focused scope.** Only 5 gaps (GAP-08, GAP-10, GAP-15, GAP-05, GAP-01) — all tightly related to the human-in-the-loop feature plus critical engine fixes. This is realistic for a single sprint and reduces risk of scope creep.
2. **Clean phase structure.** Four phases with clear dependency ordering: bug fixes first (Phase 1), then the abstraction layer (Phase 2), then the handler that depends on it (Phase 3), then integration (Phase 4). Each phase's file list is explicit.
3. **Lightweight architecture choices.** Proposing native `readline` with optional fallback to `@inquirer/prompts` shows pragmatism. The module layout is minimal: one interface file, one handler file, one CLI implementation.
4. **Headless environment mitigation.** The risk table correctly identifies the TTY-detection issue (`process.stdout.isTTY`) — a real-world edge case that the Claude draft misses entirely. Falling back to `human.default_choice` in non-TTY mode prevents CI hangs.
5. **Clear use cases.** Four use cases covering the core happy paths: interactive approval, timeout fallback, partial success, graph-level retries. Concrete and testable.
6. **Low dependency footprint.** Explicit decision to avoid new npm packages. Aligns with the project's lean philosophy.

### Weaknesses

1. **Too few Interviewer implementations.** Only `ConsoleInterviewer` and `AutoApproveInterviewer` are specified. The attractor spec (Section 6) defines 5 implementations: Console, AutoApprove, Callback, Queue, and Recording. Missing `QueueInterviewer` is particularly problematic — it's the primary mechanism for deterministic handler tests. The draft proposes testing with `AutoApproveInterviewer`, which only exercises one code path (always first/default choice) and can't verify that specific user selections route correctly.
2. **No `--auto-approve` CLI flag.** The draft mentions `AutoApproveInterviewer` but never describes how users activate it. No CLI flag, no environment variable, no configuration option. This is an integration gap.
3. **No event system integration.** No mention of `human_question` or `human_answer` events. The engine's event-driven rendering model (`EventRenderer` consumes events, engine never prints directly) means without events, the renderer can't display human gate status. This is an architectural blind spot, not just a missing feature.
4. **Vague label normalization spec.** Phase 1 mentions normalizing `[Y] `, `Y) `, `Y - ` patterns but doesn't define a parsing algorithm or utility function. The Claude draft provides a concrete `parseAccelerator()` function signature. Without this, implementers will make inconsistent choices.
5. **No `GAP-09` (allow_partial).** This is a natural companion to GAP-08 (partial_success in goal gates) — when retries exhaust and `allow_partial=true`, the node should return `partial_success`. Including GAP-08 without GAP-09 means the partial_success status can be set in goal gate checks but never produced by the retry system.
6. **Architecture section lacks type definitions.** The "Key Abstractions" section describes `Interviewer` and `WaitHumanHandler` in prose but provides no TypeScript interfaces. Compare with the Claude draft's full `Interviewer`, `Question`, `Answer`, `Choice` interface definitions. Without these, the sprint leaves critical design decisions to implementation time.

### Gaps in Risk Analysis

- **No risk for scope being too small.** Five gaps is conservative. If the sprint completes early, there's no prioritized backlog of stretch goals. The Claude draft's 12 gaps with explicit "defer if behind schedule" items (GAP-13, GAP-17) is a better model.
- **No risk for Interviewer injection coupling.** The draft says the Interviewer is "plumbed into ExecutionContext or HandlerExecutionInput" but doesn't assess the coupling this creates. The Claude draft identifies this risk and proposes a factory pattern mitigation.
- **No risk for `AbortController` cleanup.** Timeout handling via `AbortController` can leak resources if the readline interface isn't properly cleaned up. Not mentioned.
- **No risk for GAP-26 interaction.** GAP-26 (retry policy: FAIL should NOT trigger retry) isn't in scope, but it directly affects how `wait.human` timeout failures are handled. If a hexagon node times out with no default and returns `failure`, should it be retried? Under current (buggy) behavior, yes. Under spec, no. This interaction isn't analyzed.

### Missing Edge Cases

- What happens if a hexagon node has 0 outgoing edges? (Validation should catch this, but the handler needs a runtime guard too.)
- What if all outgoing edges have empty labels? The handler would present an empty choice list.
- What if the user provides input that matches no edge label and no accelerator? No retry/reprompt logic described.
- What if `human.default_choice` references a label that doesn't exist on any outgoing edge?
- What if `readline` throws on a broken pipe (piped input that ends before prompt)?

### Definition of Done Completeness

The DoD has 8 items. Assessment:
- **Complete:** GAP-08, GAP-10, GAP-15 items are clear and testable.
- **Missing:** No regression gate (`npm test` passes existing tests). Item 8 says "all new and existing" but should be explicit about build step.
- **Missing:** No compliance report update criterion. Sprint 002's DoD included this.
- **Missing:** No criterion for `--auto-approve` CLI integration.
- **Missing:** No criterion for event system integration.
- **Missing:** No criterion for a sample garden file demonstrating the feature.
- **Vague:** "Running a pipeline with a hexagon node pauses execution and displays a prompt via the CLI" — how is this verified in CI? Only via the `AutoApproveInterviewer`/`QueueInterviewer`, which the draft under-specifies.

---

## Claude Draft: "Human-in-the-Loop & Engine Hardening"

### Strengths

1. **Comprehensive gap coverage.** 12 gaps addressed spanning engine bugs, parser improvements, the full Interviewer system, and the wait.human handler. This maximizes the sprint's value by bundling related small fixes (GAP-17, GAP-20, GAP-26) alongside the headline feature.
2. **Full Interviewer system.** All 5 spec-required implementations: Console, AutoApprove, Callback, Queue, Recording. The `QueueInterviewer` enables deterministic testing, `RecordingInterviewer` enables assertion on Q&A history, and `CallbackInterviewer` enables future HTTP server integration. This is the architecturally complete solution.
3. **Detailed type definitions.** Full TypeScript interfaces for `Interviewer`, `Question`, `Answer`, `Choice`, `QuestionType`. The `Answer.source` field (`'user' | 'timeout' | 'auto' | 'queue'`) enables downstream logic to distinguish how a choice was made — important for audit trails and testing.
4. **Explicit data flow diagram.** The "Data Flow for Wait.Human" section traces the full path from engine → handler → interviewer → answer → edge selector. This makes integration points visible and reduces the risk of misalignment during implementation.
5. **Scope creep acknowledged as a risk.** The risk table explicitly calls out "12 gaps is ambitious" and provides a concrete de-scoping plan: defer GAP-13 and GAP-17 first. This is honest planning.
6. **GAP-26 inclusion.** Fixing the retry policy (FAIL should not trigger retry) is important for correctness. The current behavior masks bugs — a failing handler gets silently retried instead of propagating the failure. This is a spec-compliance fix that the Gemini draft ignores.
7. **Built-in context keys (GAP-11).** Setting `outcome`, `preferred_label`, `graph.goal`, `current_node`, and `internal.retry_count.<id>` automatically enables condition-based routing without manual handler code. This is foundational infrastructure that makes GAP-16 (preferred_label in conditions) trivial.
8. **Event integration.** Explicit `human_question` and `human_answer` event types plus themed renderer output. This respects the engine's event-driven architecture.
9. **`--auto-approve` flag.** Explicitly defined as a CLI option with clear implementation plan (Phase 5).
10. **Phase 2 parser work is appropriately scoped.** Default blocks (GAP-13), block comments (GAP-17), and duration units (GAP-20) are all small, self-contained parser enhancements that are cheap to implement and test.

### Weaknesses

1. **Ambitious scope creates delivery risk.** 12 gaps across 5 phases touching engine, parser, a new module (interviewer/), handlers, CLI, and renderer. Even with the de-scoping plan, this is roughly 2x the Gemini draft's scope. If execution hits unexpected complexity in any phase, later phases get compressed.
2. **`src/interviewer/` as a top-level module.** The draft places all 6 interviewer files in `src/interviewer/`. The Gemini draft splits this: interface in `src/engine/interviewer.ts`, CLI implementation in `src/cli/ui/console-interviewer.ts`. The Gemini approach better respects the existing module boundaries (engine code in `src/engine/`, CLI code in `src/cli/`). A top-level `src/interviewer/` directory for an interface with 5 implementations is reasonable, but it adds a new architectural concept. Given that the project already has `src/engine/`, `src/handlers/`, `src/garden/`, `src/llm/`, `src/transforms/`, `src/cli/`, adding another top-level module should be a deliberate decision, not a default.
3. **ConsoleInterviewer writes to stderr.** The draft specifies `process.stderr` for rendering "so stdout remains pipe-friendly." This conflicts with the existing renderer which writes to `process.stdout` (via chalk/ora). Having human gate prompts on stderr while all other output is on stdout creates an inconsistent UX. The renderer should control all output.
4. **`QuestionType` enum may be over-specified.** `YES_NO`, `MULTIPLE_CHOICE`, `FREEFORM`, `CONFIRMATION` — but the sprint only uses `MULTIPLE_CHOICE` (and `YES_NO` as a special case of 2-choice). `FREEFORM` and `CONFIRMATION` types are unused. Defining them is harmless but implementing handling for them in `ConsoleInterviewer` is wasted effort if no handler produces them.
5. **No per-phase time estimates.** Phase percentages (20/15/25/25/15) give relative effort but no absolute time. The Gemini draft has the same issue. For a 12-gap sprint, even rough day-count estimates per phase would help identify if the sprint is feasible.
6. **GAP-09 (allow_partial) adds retry complexity.** When retries exhaust and `allow_partial=true`, the node returns `partial_success` — but this interacts with GAP-08 (goal gates accept partial_success) and GAP-26 (only retry on RETRY status). The three-way interaction isn't analyzed. Specifically: if a node returns `failure` (not retried per GAP-26) and has `allow_partial=true`, what happens? `allow_partial` only triggers on retry exhaustion, but with GAP-26, `failure` doesn't retry at all, so retries are never "exhausted." This edge case needs clarification.

### Gaps in Risk Analysis

- **No risk for ConsoleInterviewer stdin conflicts.** If the user pipes input to pollinator (`echo "approve" | pollinator run ...`), the readline interface may consume input intended for other handlers or close prematurely. The Gemini draft partially addresses this via the TTY detection mitigation.
- **No risk for non-TTY environments.** The Gemini draft's `process.stdout.isTTY` check is absent. In Docker containers, CI runners, and piped contexts, `ConsoleInterviewer` will block indefinitely without this guard.
- **No risk for `CallbackInterviewer` async behavior.** If the callback never resolves (e.g., HTTP server goes down), the engine hangs. No timeout on the callback itself, only on the `Question.timeout_ms`.
- **No risk for default block ordering sensitivity.** GAP-13 (node/edge defaults) is order-dependent — `node [shape=box]` applies to all subsequent nodes. If a user defines defaults after some nodes, only later nodes get the defaults. This is correct per DOT semantics but may surprise users. No mention of validation warning for "defaults defined after nodes."

### Missing Edge Cases

- `RecordingInterviewer` wrapping a `QueueInterviewer` that throws on exhaustion — does the recording capture the error?
- `ConsoleInterviewer` with `timeout_ms=0` — should it immediately select default, or should 0 mean "no timeout"?
- `parseAccelerator` with multi-character accelerators like `[OK] Proceed` — the spec says "single alphanumeric character" but the regex pattern isn't defined.
- What if a hexagon node has exactly 1 outgoing edge? Should it auto-select (no prompt needed) or still ask?
- Block comment `/* ... */` containing `//` — does the line comment detector interfere?
- `node [shape=hexagon]` default block followed by `node [shape=box]` — does the second reset shape for subsequent nodes?
- `preferred_label` condition on a node that wasn't preceded by a wait.human — it resolves to empty string, which might unexpectedly match an `=` condition against empty string.

### Definition of Done Completeness

The DoD has 19 items — significantly more detailed than the Gemini draft. Assessment:
- **Strong:** Each gap has its own DoD line item with explicit test requirement ("unit tested").
- **Strong:** Includes regression gate, build gate, compliance report update.
- **Strong:** Integration test criterion for full pipeline with hexagon node.
- **Missing:** No manual smoke test criterion mentioned in DoD (though Phase 5 tasks include it, the DoD should be the authoritative checklist).
- **Missing:** No criterion for `ConsoleInterviewer` working correctly in TTY vs non-TTY environments.
- **Potentially over-specified:** "All 5 implementations exist and are tested" — `CallbackInterviewer` is unused by any handler in this sprint. Its DoD criterion adds implementation work with no immediate consumer.

---

## Recommendations for the Final Merged Sprint

### 1. Use Claude's scope as the baseline, with Gemini's discipline

The Claude draft's 12-gap scope is the right target — it closes related gaps together and delivers a complete Interviewer system rather than a partial one. However, adopt the Gemini draft's sharper risk awareness and defensive design decisions (TTY detection, AbortController cleanup, headless fallback).

### 2. Adopt the Gemini module layout for Interviewer

Place the `Interviewer` interface in `src/engine/interviewer.ts` (it's an engine concept) and the `ConsoleInterviewer` in `src/cli/ui/console-interviewer.ts` (it's a CLI concern). Test-only implementations (`QueueInterviewer`, `RecordingInterviewer`, `AutoApproveInterviewer`) can go in `src/interviewer/` or `test/helpers/`. This respects the existing layered architecture.

### 3. Keep all 5 Interviewer implementations, but defer FREEFORM/CONFIRMATION handling

Define all `QuestionType` values in the type system. Implement all 5 Interviewer classes. But only implement `MULTIPLE_CHOICE` and `YES_NO` handling in `ConsoleInterviewer` — throw a "not yet implemented" error for `FREEFORM` and `CONFIRMATION`. This gives the complete interface without wasted effort.

### 4. Add non-TTY guard from Gemini draft

The ConsoleInterviewer **must** check `process.stdin.isTTY`. In non-TTY environments:
- If `human.default_choice` is defined: select it immediately with `source: 'auto'`
- If not: return `failure` with a descriptive error ("human input required but no TTY available")

This prevents CI hangs and Docker deadlocks.

### 5. Resolve the GAP-09 / GAP-26 interaction

Clarify the semantics: `allow_partial` only applies when `status === 'retry'` and retry count is exhausted. If a node returns `failure`, it's a hard failure regardless of `allow_partial`. Document this interaction in the sprint doc.

### 6. ConsoleInterviewer should use the renderer, not stderr

Route all human gate output through the existing `EventRenderer` via the event system. The `human_question` event triggers the renderer to display choices; the `human_answer` event logs the selection. The ConsoleInterviewer itself only handles stdin reading. This maintains the engine's "never print directly" principle.

### 7. Explicit de-scoping tiers

**Tier 1 (must ship):** GAP-08, GAP-01, GAP-05 (all 5 impls), GAP-10, GAP-15, GAP-26
**Tier 2 (should ship):** GAP-11, GAP-16, GAP-09, GAP-20
**Tier 3 (nice to have):** GAP-13, GAP-17

If the sprint falls behind, cut from Tier 3 first, then Tier 2. This gives implementers clear priority signals.

### 8. Strengthen the risk table

Add to the merged risk table:
- **Non-TTY hang** (from Gemini): High impact, mitigated by TTY guard
- **GAP-26 behavioral change** (from Claude): Medium impact, mitigated by documentation + fixture updates
- **12-gap scope** (from Claude): Medium impact, mitigated by tiered de-scoping
- **CallbackInterviewer hang** (new): Low likelihood, mitiated by wrapping callback in `Promise.race` with Question timeout

### 9. Add a sample garden file to the DoD

Both drafts mention fixtures but neither requires a user-facing sample garden demonstrating the feature. Add: "A `gardens/interactive-approval.dot` pipeline exists and runs end-to-end with both `QueueInterviewer` (test) and `--auto-approve` (CI)."

### 10. Keep the Claude draft's type definitions verbatim

The `Interviewer`, `Question`, `Answer`, `Choice` interfaces in the Claude draft are well-designed. The `Answer.source` discriminator and `Choice.edge_target` field are especially useful. Adopt these as the canonical types.
