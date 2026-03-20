# Sprint NEXT Draft Critique

Reviewed against:

- `docs/sprints/drafts/NEXT-CLAUDE-DRAFT.md`
- `docs/sprints/drafts/NEXT-GEMINI-DRAFT.md`
- `docs/compliance-report.md`
- `src/engine/engine.ts`
- `src/engine/types.ts`
- `src/engine/events.ts`
- `src/handlers/registry.ts`
- `src/garden/types.ts`
- `src/cli/commands/run.ts`
- `src/cli/commands/resume.ts`
- `src/cli/ui/renderer.ts`

The standard for this sprint is not "close the most gaps." The standard is: land a dependable human-in-the-loop slice that fits the current engine, handler, parser, and CLI boundaries with low rework risk.

## Claude Draft

### Strengths

- This is the more implementation-ready draft. The phases, file list, handler flow, type definitions, and test plan are concrete enough that an engineer could start work immediately.
- It tracks the current compliance report closely. GAP-01, GAP-05, GAP-08, GAP-09, GAP-10, GAP-11, GAP-13, GAP-15, GAP-16, GAP-17, GAP-20, and GAP-26 are all real gaps in the repo today, and the draft does not hand-wave them.
- It is the only draft that fully respects the current event-driven CLI architecture. `src/engine/events.ts` and `src/cli/ui/renderer.ts` already exist, so planning `human_question` and `human_answer` events is the right integration shape.
- Including `QueueInterviewer` is a strong decision. In this repo, `AutoApproveInterviewer` alone is not enough to test explicit human choices, timeout behavior, or label normalization against non-default branches.
- Including GAP-26 is important. The current engine retries both `failure` and `retry`, so without this fix a failed `wait.human` path could retry in surprising ways.
- The draft is honest about de-scoping. Calling out GAP-13 and GAP-17 as first cuts is better than pretending all 12 gaps are equally safe to finish.

### Weaknesses

- The scope is still too large for one sprint. Human-in-the-loop alone already requires parser changes, engine plumbing, handler changes, CLI changes, renderer changes, and new integration tests. Adding parser cleanup items and full interviewer breadth on top of that is optimistic.
- The draft still under-specifies one key integration boundary: `HandlerExecutionInput` currently does not expose the graph or outgoing edges, but `WaitHumanHandler` needs that data to build choices. The draft talks about interviewer injection, but not about how the handler actually sees the edge set.
- It handles `run` but not `resume` deeply enough. `src/cli/commands/resume.ts` constructs its own `PipelineEngine` and `EventRenderer`, so human-gated pipelines resumed from a cocoon need the same interviewer and `--auto-approve` strategy as fresh runs.
- `ConsoleInterviewer` writing directly to `stderr` fights the current rendering model. The repo already centralizes user-facing output in `EventRenderer`, and direct prompt rendering would create split ownership of terminal UI.
- The interviewer surface may be broader than the sprint needs. `QueueInterviewer` and `AutoApproveInterviewer` are clearly justified. `CallbackInterviewer`, `RecordingInterviewer`, `FREEFORM`, and `CONFIRMATION` are useful, but they should not be allowed to delay the shipping path.
- GAP-13 looks smaller on paper than it is in this codebase. The current parser uses a custom statement collector in `src/garden/parse.ts`, and default blocks are order-sensitive and eventually subgraph-sensitive.

### Gaps in Risk Analysis

- No explicit non-TTY/headless risk. That is a real operational gap because the current CLI is TTY-aware, and an interactive prompt can hang CI or piped runs if not guarded.
- No explicit risk for `resume` behavior through a human gate. Interrupting while waiting for input and then resuming is exactly the kind of stateful path that tends to break.
- No explicit risk for ambiguous choice sets. Duplicate normalized labels, duplicate accelerators, unlabeled edges, or a `human.default_choice` that matches nothing should be treated as design risks, not just test cases.
- No explicit risk for the handler boundary change itself. Extending `HandlerExecutionInput`, or moving choice derivation into the engine, is a structural change and should be named as such.
- No explicit risk for prompt state versus spinner state during interruption. The draft mentions countdown and spinner interaction, but not what happens if `SIGINT` lands while the process is blocked on readline.

### Missing Edge Cases

- Resuming a run that was interrupted while the process was waiting at a human gate.
- A `hexagon` node with zero outgoing edges, one outgoing edge, or multiple unlabeled outgoing edges.
- Multiple outgoing edges that normalize to the same label after lowercase/trim/accelerator stripping.
- Multiple outgoing edges with the same accelerator key.
- `human.default_choice` matching no edge, or matching more than one edge after normalization.
- Closed stdin or EOF while the prompt is active.
- The exact interaction between GAP-09 and GAP-26: if `failure` no longer retries, when does `allow_partial=true` actually convert the outcome?

### Definition of Done Completeness

- This is the stronger DoD of the two drafts. It is mostly testable and tied to named gaps.
- It should explicitly require the `resume` path to work for human-gated runs, not just `run`.
- It should explicitly require non-TTY behavior, because that is where human prompts most often fail operationally.
- It should require a failure mode for malformed human gates: no choices, ambiguous labels, ambiguous accelerators, or invalid `human.default_choice`.
- The manual smoke test belongs in the DoD, not only in Phase 5 tasks.
- "All 5 implementations exist and are tested" is probably stronger than necessary for this sprint. The DoD should prioritize the implementations that are actually required to ship and verify the feature.

## Gemini Draft

### Strengths

- This is the better-scoped sprint. It stays focused on the human gate vertical slice plus a small number of adjacent engine fixes.
- The module placement is closer to the current repo layout. Keeping the engine-facing abstraction near `src/engine/` and the console implementation near `src/cli/` matches the existing layering better than introducing a large new top-level subsystem by default.
- The risk table is stronger on operational behavior than the Claude draft. Non-TTY handling, timeout race conditions, and event-loop safety are real risks for this feature.
- The phases are easy to reason about and mostly follow the right dependency order: core engine fixes first, then abstraction, then handler, then integration.
- The DoD is concise and user-outcome oriented. It is clear what a successful interactive gate should look like from the CLI.

### Weaknesses

- It underestimates the number of current-code touch points. `hexagon` support does not live only in `src/garden/validate.ts`; `src/garden/types.ts` currently owns `SUPPORTED_SHAPES` and `normalizeNodeKind()`, so the file plan is incomplete.
- It does not integrate with the repo's existing event model. `EventRenderer` already owns terminal output, but the draft never plans `human_question` and `human_answer` events, so the likely implementation path is direct printing from the interviewer.
- The testing story is too thin without `QueueInterviewer`. `AutoApproveInterviewer` proves the default branch, but it does not prove that an arbitrary human choice maps to the correct edge.
- It omits GAP-26 even though current retry behavior directly affects `wait.human`. A timeout or invalid-input failure could accidentally retry under the current engine behavior.
- It also glosses over the same handler-boundary issue as the Claude draft. `HandlerExecutionInput` currently has `node`, `context`, and `abort_signal`, but no graph or outgoing-edge data. `WaitHumanHandler` cannot derive choices without more plumbing.
- It treats `AutoApproveInterviewer` as an implementation detail rather than a product path. There is no concrete activation mechanism such as `--auto-approve`, and nothing is said about parity on `resume`.
- It misses the legacy alias `default_max_retry`, which the compliance report still calls out alongside `default_max_retries`.

### Gaps in Risk Analysis

- No risk callout for architectural mismatch with the current event system and renderer ownership.
- No risk callout for weak deterministic testing if only console and auto-approve paths exist.
- No risk callout for `resume` plus human-gate interaction.
- No risk callout for ambiguous labels, accelerators, or invalid default-choice configuration.
- No risk callout for current retry semantics causing behavioral surprises until GAP-26 is fixed.
- No risk callout for stdin interruption or EOF while prompting.

### Missing Edge Cases

- A resumed run that later encounters a human gate.
- Invalid user input and the re-prompt versus fail-fast behavior.
- A `hexagon` node with zero outgoing edges, one outgoing edge, or unlabeled outgoing edges.
- Duplicate normalized labels or duplicate accelerator keys.
- `human.default_choice` missing, invalid, or ambiguous.
- Non-TTY operation with no default choice configured.
- Interrupting the process while the human prompt is open.

### Definition of Done Completeness

- The DoD is fine for a thin vertical slice, but it is not complete enough to be the authoritative sprint checklist.
- It should require `npm run build` in addition to tests.
- It should require the `resume` path, not just fresh `run`.
- It should require event emission and renderer integration if the feature is going to fit the current CLI architecture cleanly.
- It should require at least one deterministic integration test that selects a non-first edge, which implies `QueueInterviewer` or an equivalent mock.
- It should require explicit behavior for malformed human-gate configuration.
- It should include the product activation path for unattended runs, not just mention `AutoApproveInterviewer` abstractly.

## Final Recommendation

Use the Gemini draft as the scope governor, but pull in a small set of Claude items that are necessary to avoid immediate rework.

Recommended must-ship scope:

- GAP-01 `wait.human`
- GAP-05 interviewer abstraction with `ConsoleInterviewer`, `AutoApproveInterviewer`, and `QueueInterviewer`
- GAP-08 goal gates accepting `partial_success`
- GAP-10 graph-level `default_max_retries` plus legacy alias `default_max_retry`
- GAP-15 preferred-label normalization
- GAP-26 retry only on `retry` status and exceptions
- `human_question` and `human_answer` events, so the existing renderer remains the single owner of terminal output
- `--auto-approve` on both `run` and `resume`
- A handler-boundary change so `WaitHumanHandler` can actually see outgoing edges

Recommended should-ship scope, only if capacity remains:

- GAP-11 built-in context keys
- GAP-16 `preferred_label` in conditions
- GAP-09 `allow_partial`, but only after the exact interaction with GAP-26 is written down

Recommended deferrals:

- GAP-13 node/edge default blocks
- GAP-17 block comment stripping
- GAP-20 hour/day timeout units
- Full `FREEFORM` and `CONFIRMATION` prompt handling
- `CallbackInterviewer` and `RecordingInterviewer` unless they are trivial wrappers that do not slow delivery

The final merged sprint should make three architectural decisions explicit:

- `EventRenderer` remains the only component that writes the human prompt UI. `ConsoleInterviewer` should read input, not own terminal presentation.
- Human-gate behavior must be defined for non-TTY, interrupt, and resume paths.
- Invalid human-gate topology should fail clearly. At minimum, the sprint should define behavior for no choices, ambiguous normalized labels, ambiguous accelerators, and invalid `human.default_choice`.

The merged DoD should include:

- `npm run build && npm test`
- One queue-driven integration test for explicit branch selection
- One timeout/default-choice test
- One non-TTY test
- One interrupt-and-resume test through a human gate
- One `pollinator run --auto-approve` test and one equivalent `resume` test
