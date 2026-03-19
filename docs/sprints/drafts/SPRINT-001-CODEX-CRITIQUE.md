# Sprint 001 Draft Critique

Reviewed against:

- `docs/sprints/drafts/SPRINT-001-CLAUDE-DRAFT.md`
- `docs/sprints/drafts/SPRINT-001-GEMINI-DRAFT.md`
- `docs/INTENT.md`
- `gardens/compliance-loop.dot`

The main standard used here is not "does this cover the whole product?" Sprint 001 does not need full Nectar or full attractor compliance. The standard is: does this sprint create a credible, low-rework foundation for the intent document's end state, and does it cover the real execution and parser edge cases already present in `compliance-loop.dot`?

## Claude Draft

### Strengths

- This is the more implementation-ready draft. The module layout, phase breakdown, abstractions, and task lists are concrete enough that an engineer could start without re-interpreting the plan.
- It aligns better with the long-term intent. In particular, it accounts for source-located parsing errors, typed diagnostics, `type` overriding `shape`, structured engine events, atomic cocoon writes, TTY-aware output, and richer validation.
- The cocoon plan is materially stronger. Including `graph_hash`, retry state, timestamps, interruption reason, and completed node history is much closer to the "resumable by default" requirement in `docs/INTENT.md`.
- The draft is more honest about the actual engine complexity. It explicitly breaks out graph construction, validation, edge selection, retry policy, signal handling, and renderer behavior instead of treating them as trivial glue code.
- Its Definition of Done is mostly executable rather than aspirational. It names commands, fixtures, interrupt behavior, plain-text pipe behavior, and unit/integration tests.
- It handles more of the real sample shape in `gardens/compliance-loop.dot`, including graph-level attributes, fallback edges, retry on `implement`, and a cycle back from `validate` to `compliance_check`.

### Weaknesses

- The scope is too wide for a first sprint unless the team is intentionally overstaffing it. A custom lexer/parser, AST, graph builder, validator, engine, retry system, checkpointing, four CLI commands, a themed renderer, and stub handlers is a lot to finish well in one sprint.
- It is trying to be both "minimum viable Pollinator" and "foundational architecture sprint" at the same time. That usually leads to half-finished surface area instead of a truly dependable `run`/`validate`/`resume` loop.
- Stub handlers that silently succeed are a bad default for this project. They make unsupported pipelines look valid and runnable, which is especially risky in a repo whose stated end goal is strict compliance. Unsupported node types should fail loudly or require an explicit opt-in dev flag.
- The edge-selection discussion is close, but not fully safe. The example "`success` implies label `Pass`" does not generalize to real labels in `compliance-loop.dot` such as `Compliant`, `Gaps Found`, and `Fix Issues`. If implemented naively, this will encode the wrong routing behavior.
- Storing stdout directly in `context.<node_id>.stdout` is likely the wrong boundary. Context should stay small and semantic. Raw tool output belongs in run history or a future artifact/log store, not the execution context map.
- The resume behavior on `graph_hash` mismatch is too permissive. A warning-only flow invites non-deterministic resumes. For a checkpointed engine, mismatch should probably stop the resume unless the user passes an explicit override.

### Gaps in Risk Analysis

- The draft does not acknowledge its biggest risk: breadth. The primary delivery risk is not just parser ambiguity; it is trying to land too many subsystems in Sprint 001.
- There is no explicit risk for cocoon corruption or partial writes, even though checkpoint integrity is central to the sprint.
- Cross-platform behavior is underplayed. The intent document explicitly calls for macOS and Linux support at minimum, but the mitigation language mostly assumes macOS and defers Linux confidence.
- There is no risk callout for the stub-handler strategy producing false positives in validation and execution.
- There is no risk callout for checkpoint bloat if tool stdout/stderr are stored inline and updated after every node.
- There is no risk callout for running or resuming from the wrong working directory, which matters because tool node behavior depends on cwd and relative script paths.

### Missing Edge Cases

- `compliance-loop.dot` includes graph-level attributes (`goal`, `label`). The parser and graph builder should prove what happens to graph attributes that are parsed but not yet used.
- The sample graph contains duplicate edges to the same target with different semantics (`condition` plus `Fallback`). That deserves explicit tests because it is easy to mishandle when candidate sets collapse.
- The sample graph contains a cycle (`validate -> compliance_check`). The draft should require at least one looped integration test and one resume-inside-a-loop test.
- Edge labels contain spaces (`"Gaps Found"`, `"Fix Issues"`). This should be covered in parser and edge-selection tests.
- `implement` has `max_retries=2`. The DoD should verify retry exhaustion, checkpoint persistence of retry counters, and correct behavior after resume.
- Signal handling needs a subprocess edge case: user hits `Ctrl+C` while a tool node is still running. The sprint should define signal forwarding, kill behavior, and exactly what gets checkpointed.
- The draft should test the "no valid next edge" case separately from generic node failure so routing bugs are diagnosable.
- Multiple matching edges, multiple `Fallback` edges, and unlabeled unconditional edges are not called out directly and should be.

### Definition of Done Completeness

- This is the stronger DoD of the two drafts, but it still needs a few additions.
- It should require a failing-path execution of `gardens/compliance-loop.dot`, since the referenced `scripts/compliance_loop.py` is not present today. The sprint should prove that this fails in a controlled way and follows failure routing correctly.
- It should explicitly require invalid DOT diagnostics with file/line/column output, not just successful validation of the happy path.
- It should explicitly cover timeout behavior, `graph_hash` mismatch behavior on resume, and unsupported node-type behavior.
- It should verify checkpoint integrity after interruption during a retrying node, not just interruption during any generic run.
- If `status` stays in scope, its exit codes and status model should be pinned more tightly. Right now it is included, but not specified deeply enough to prevent drift.

### Recommendation From This Draft

- Use this draft as the structural backbone for the final sprint.
- Keep the phased implementation plan, explicit file layout, source-located parser errors, typed diagnostics, `type` override handling, graph hashing, atomic cocoon writes, typed engine events, TTY-aware output, and concrete test-first DoD style.
- Trim the sprint surface area. The best candidates to defer are `status`, broad stub-handler support, and any parser or condition-language features not needed by `compliance-loop.dot` or the immediate validation rules.

## Gemini Draft

### Strengths

- This draft has the better MVP instinct. It centers the sprint on the one thing Sprint 001 must prove: parse a DOT file, run it, checkpoint it, and resume it.
- Its scope boundaries are clear and mostly honest. It explicitly defers the web UI, LLM-backed node types, and a full expression evaluator instead of implying that they will magically fit.
- The architecture is easy to hold in your head. For a first sprint, that simplicity is valuable and can help the team avoid overbuilding.
- The default timeout mitigation for tool nodes is a good practical safety measure and should carry forward.
- The assumption that concurrent runs are acceptable if isolated by run ID is reasonable for this stage and matches the file-system-first model well enough.

### Weaknesses

- The draft is under-specified in the places where implementation quality actually lives. Parser behavior, checkpoint schema, engine state model, validation, and test coverage are all too vague to guide a clean build.
- It says the engine will implement the 5-step deterministic edge-selection algorithm, but it never operationalizes steps 2 through 5 in the plan or the DoD. As written, this could easily collapse into "route on success/fail only."
- The parser scope is too narrow in ways that create future rework. `docs/INTENT.md` requires edge chaining and typed attributes, and even the current sample graph requires graph-level attributes, quoted strings with spaces, retries, and cyclic traversal.
- Omitting `validate` is a mistake. Sprint 001 needs a validation command because it separates parser/graph correctness from runtime behavior and gives the project a safe entry point for debugging DOT files.
- The cocoon plan is not detailed enough to support the claim that resume will pick up "exactly where they left off." Without `graph_hash`, retry state, interruption reason, timestamps, and completed-node history, resume semantics will be fragile or ambiguous.
- The storage location `.nectar/cocoons/` conflicts with the intent document's example workspace layout, which places `cocoons/` at the workspace root. That may be a fine change, but the draft does not justify it.
- It does not address `type` overriding `shape`, which is an explicit requirement in the intent document and an important forward-compatibility detail even if only three handlers are implemented now.

### Gaps in Risk Analysis

- There is no risk callout for resuming after the DOT file changed.
- There is no risk callout for partial or corrupted cocoon writes during crash or signal handling.
- There is no risk callout for ambiguous routing cases such as duplicate edges, `Fallback` handling, or multiple matches.
- There is no risk callout for subprocess signal forwarding, shell quoting differences, or cwd-sensitive script execution.
- There is no risk callout for the parser becoming a dead end if the supported subset expands slightly beyond the current sample.
- There is no risk callout for spinner-only output making failures less debuggable if the actual command and stderr are hidden.

### Missing Edge Cases

- `compliance-loop.dot` contains graph-level `goal` and `label` attributes. The draft does not say whether these are parsed, ignored, or preserved.
- The sample graph contains duplicate edges to the same target with one explicit `Fallback`. That is a real routing edge case that should be in tests.
- The sample graph contains a cycle and a retrying node. The draft does not call out loop execution, retry exhaustion, or resuming with partially consumed retries.
- Node IDs contain underscores, labels contain spaces, and scripts contain quoted shell commands. The parser edge cases in the draft are too light for the actual sample.
- There is no mention of behavior for multiple start nodes, no exit nodes, duplicate node IDs, unreachable nodes, or missing tool `script` attributes.
- There is no mention of what happens when a tool exits due to signal rather than a normal non-zero exit code.
- There is no mention of resume behavior when the cocoon exists but the DOT file path no longer resolves.
- There is no mention of output-volume edge cases if stdout/stderr are stored in the cocoon.

### Definition of Done Completeness

- The DoD is directionally right, but too high-level to keep the sprint honest.
- It should name actual commands to run, actual fixtures to test, and the minimum state that must survive resume.
- It should include validation behavior, invalid DOT diagnostics, fallback-edge behavior, retry/timeout behavior, and pipe-friendly plain-text output.
- "Automated tests for the parser and edge selection pass" is too vague. It should say which parser features and which edge-selection steps are covered.
- The DoD should require checkpoint integrity, not just checkpoint existence. A cocoon file being written is not enough if it cannot deterministically restore state.
- If themed output is in scope, TTY detection should be in scope too because the intent document explicitly requires graceful degradation.

### Recommendation From This Draft

- Keep its scope discipline, default timeout mitigation, and its bias toward landing a real working path before adding surface area.
- Keep the decision to defer a full condition-expression language, but make the deferral explicit and preserve forward-compatible interfaces for `context` conditions and `!=`.
- Do not keep the omission of `validate`, the thin checkpoint model, or the underspecified interpretation of the 5-step edge-selection algorithm.

## Final Recommendation

The Claude draft should be the primary base for the final sprint because it is much closer to implementation-ready and much better aligned with the intent document's expectations around resumability, observability, and future compatibility.

The Gemini draft contributes the better product instinct: Sprint 001 should prove one dependable vertical slice, not attempt to simulate half of Nectar. That discipline should be used to trim the Claude draft, not replace it.

Ideas that should make it into the final sprint from the Claude draft:

- Source-located custom parsing with a clear AST/graph boundary.
- Explicit validation rules and a `validate` command.
- Typed engine events and a TTY-aware themed renderer.
- Atomic cocoon writes with `graph_hash`, retry state, timestamps, and interruption metadata.
- `type` attribute precedence over shape-based handler resolution.
- Concrete, command-driven Definition of Done with unit and integration coverage.

Ideas that should make it into the final sprint from the Gemini draft:

- A stricter MVP boundary centered on `run`, `resume`, and `validate`.
- The default timeout mindset for tool execution.
- Clear, explicit deferral of web UI work, LLM-backed node types, and the full condition-expression language.
- Acceptance that concurrent runs are fine if cocoon state is isolated by run ID.

Recommended synthesis for the final Sprint 001:

- Use the Claude draft's architecture and test rigor.
- Use the Gemini draft's scope discipline to cut anything not needed for a dependable `run`/`validate`/`resume` foundation.
- Treat unsupported node types as explicit failures, not silent success.
- Add sample-driven tests for fallback edges, loops, retry persistence, graph-hash mismatch, and signal interruption during tool execution.
- Make all deferrals explicit so Sprint 001 narrows scope without obscuring the long-term compliance target in `docs/INTENT.md`.
