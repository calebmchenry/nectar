# Sprint 003 Merge Notes

## Inputs

| File | Role |
|------|------|
| `NEXT-CLAUDE-DRAFT.md` | Full draft — 12 gaps, 5 phases, detailed types and data flow |
| `NEXT-GEMINI-DRAFT.md` | Full draft — 5 gaps, 4 phases, focused scope with operational risk awareness |
| `NEXT-CLAUDE-CRITIQUE.md` | Critique of both drafts by Claude |
| `NEXT-CODEX-CRITIQUE.md` | Critique of both drafts by Codex |
| `NEXT-GEMINI-CRITIQUE.md` | Critique of both drafts by Gemini |

## Scope Decision

**Baseline: Claude draft's gap list, trimmed by critique consensus.**

The Claude draft proposed 12 gaps. All three critiques agreed the parser-only items (GAP-13 node/edge defaults, GAP-17 block comments, GAP-20 h/d durations) are "nice to have" and the first to cut. The final sprint ships 9 gaps in two priority tiers:

- **Tier 1 (must ship):** GAP-08, GAP-26, GAP-01, GAP-05, GAP-10, GAP-15
- **Tier 2 (should ship):** GAP-11, GAP-16, GAP-09
- **Tier 3 (deferred):** GAP-13, GAP-17, GAP-20

This is more ambitious than the Gemini draft (5 gaps) but avoids the Claude draft's riskiest parser work. The Codex critique's recommended scope (must-ship + should-ship lists) was the closest match to this final selection.

## What Was Taken from Each Source

### From Claude Draft
- **Type definitions** — `Interviewer`, `Question`, `Answer`, `Choice` interfaces adopted verbatim. The `Answer.source` discriminator and `Choice.edge_target` field were called out as especially useful by both the Claude and Gemini critiques.
- **All 5 Interviewer implementations** — Console, AutoApprove, Callback, Queue, Recording. The Claude and Codex critiques both emphasized that `QueueInterviewer` is essential for deterministic testing (AutoApprove alone only exercises the default path). Gemini critique agreed.
- **Data flow diagram** — The Wait.Human handler flow from engine → handler → interviewer → answer → edge selector was adopted as the canonical integration description.
- **Built-in context keys (GAP-11)** — Taken as Tier 2. The Claude critique noted this makes GAP-16 (preferred_label in conditions) trivial.
- **GAP-26 inclusion** — All three critiques agreed this is necessary to prevent surprising retry behavior on `wait.human` failures.
- **GAP-09 inclusion** — Taken as Tier 2, with the GAP-26 interaction clarified per critique feedback.
- **Event system integration** — `human_question` and `human_answer` events. The Codex critique specifically flagged that omitting events (as the Gemini draft did) would break the event-driven rendering model.
- **Phase structure** — 4-phase structure (bugs → interviewer → handler → CLI) kept, adjusted to merge Claude's Phase 5 polish into Phase 4.
- **`parseAccelerator()` utility** — Concrete function signature and patterns. The Claude critique noted the Gemini draft's normalization spec was too vague without this.
- **`--auto-approve` CLI flag** — Explicit flag definition. The Codex critique flagged this was missing from the Gemini draft.
- **Tiered de-scoping plan** — Honest about what to cut if behind. Both critiques praised this approach.

### From Gemini Draft
- **Non-TTY guard** — `process.stdin.isTTY` check with fallback to `default_choice` or failure. All three critiques highlighted this as a critical operational safeguard that the Claude draft missed. This became an architectural decision and a DoD item.
- **Scope restraint** — The Gemini draft's focused 5-gap approach influenced the decision to defer GAP-13, GAP-17, and GAP-20. The Codex critique explicitly recommended "use the Gemini draft as the scope governor."
- **Operational risk awareness** — Event loop blocking, timeout race conditions, and `AbortController` cleanup risks were incorporated into the merged risk table from the Gemini draft's analysis.
- **`readline` as default** — Both drafts agreed on Node.js `readline`. The Gemini draft's mention of `@inquirer/prompts` as a fallback was noted but not adopted (no new dependencies).

### From Claude Critique
- **Tiered priority system** — The explicit Tier 1/2/3 breakdown was adopted from the critique's recommendation section.
- **ConsoleInterviewer should use EventRenderer, not stderr** — Architectural decision #1 came directly from this critique's recommendation #6.
- **Keep all 5 Interviewer impls, defer FREEFORM/CONFIRMATION** — Recommendation #3 was adopted: define all `QuestionType` values but only implement `MULTIPLE_CHOICE` and `YES_NO` handling.
- **GAP-09 / GAP-26 interaction resolution** — Recommendation #5 clarified: `allow_partial` only triggers on retry exhaustion from `retry` status, not `failure`. Adopted as an architectural decision.
- **Sample garden file in DoD** — Recommendation #9 became a DoD item (`gardens/interactive-approval.dot`).

### From Codex Critique
- **`resume` command parity** — The Codex critique was the only one to flag that `src/cli/commands/resume.ts` constructs its own engine and needs the same `--auto-approve` and Interviewer plumbing. This became architectural decision #4 and a Phase 4 task.
- **Handler boundary change as explicit risk** — The Codex critique flagged that `HandlerExecutionInput` currently lacks outgoing edges, making it impossible for `WaitHumanHandler` to derive choices. This became architectural decision #3 and a Phase 3 task.
- **Invalid human-gate topology** — The Codex critique emphasized that ambiguous choices, duplicate labels/accelerators, and invalid `default_choice` should fail clearly. This became architectural decision #5 and a validation step in the handler.
- **Manual smoke test in DoD** — The Codex critique noted it belonged in the DoD, not just in phase tasks.
- **Legacy `default_max_retry` alias** — The Codex critique caught that the Gemini draft missed this. Added to GAP-10 implementation.
- **RecordingInterviewer error capture** — Edge case from the critique: wrapped interviewer errors should be recorded then re-thrown.

### From Gemini Critique
- **CallbackInterviewer `Promise.race` timeout** — Risk mitigation for callbacks that never resolve. Adopted in Phase 2 CallbackInterviewer spec.
- **Interviewer dependency injection via ExecutionContext** — Recommended by both Gemini and Codex critiques. The final sprint notes this as a structural change to `HandlerExecutionInput` rather than deep threading through engine → registry → handler constructors.
- **Scope confirmation** — Gemini critique's recommended scope (GAPs 01, 05, 08, 09, 10, 11, 15, 26) closely matched the final selection, reinforcing the consensus.

## What Was NOT Taken (and Why)

| Proposal | Source | Reason for exclusion |
|----------|--------|---------------------|
| GAP-13 node/edge default blocks | Claude draft | All critiques flagged as risky in the custom parser. Codex called it "smaller on paper than it is." Deferred. |
| GAP-17 block comment stripping | Claude draft | Parser nicety, not blocking any feature. Deferred. |
| GAP-20 h/d duration units | Claude draft | Low value, no current use case requires hours/days. Deferred. |
| `@inquirer/prompts` fallback | Gemini draft | No new dependencies policy. `readline` is sufficient. |
| Interviewer interface in `src/engine/` | Gemini draft, critiques | Considered, but with 6 files the `src/interviewer/` module is justified. The interface is an engine concept but the implementations span engine, CLI, and test concerns. |
| Per-phase time estimates | Claude critique | Neither draft had them. Not adding speculative estimates. |
| Interrupt-and-resume test through human gate | Codex critique | Good idea but complex to implement. The `resume` path is supported but interrupt-during-prompt testing is deferred to avoid blocking the sprint. |
