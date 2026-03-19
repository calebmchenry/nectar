# Sprint 001 — Claude Critique of Codex & Gemini Drafts

## Preamble

This critique evaluates the Codex and Gemini Sprint 001 drafts against the project INTENT.md, the sprint intent document, and the existing `gardens/compliance-loop.dot` file. Each draft is assessed for strengths, weaknesses, risk analysis gaps, missing edge cases, and Definition of Done completeness. The goal is to identify what should survive into the final sprint document.

---

## Codex Draft

### Strengths

1. **Pragmatic parser choice.** Using `@ts-graphviz/parser` instead of writing a custom DOT parser is the single most important architectural decision in the draft. It eliminates the highest-risk, lowest-value work in the sprint. The parser is hidden behind `src/garden/parse.ts`, so it can be swapped later — good instinct.

2. **Atomic cocoon writes.** Temp-file-plus-rename semantics for checkpoint persistence is the kind of detail that separates "works on the demo" from "works when the laptop dies." This is correctly identified as load-bearing and not deferred.

3. **Engine/CLI separation via events.** The `RunEvent` union type with the engine never printing directly is exactly the right boundary. It keeps the engine testable and reusable by the future HTTP server without ceremony.

4. **The compliance-loop fixture problem is solved.** The draft recognizes that `gardens/compliance-loop.dot` currently points at a nonexistent `python3 scripts/compliance_loop.py` and ships a deterministic `scripts/compliance_loop.mjs` replacement. This is not a nice-to-have — without it, the sprint literally cannot demonstrate its own success criteria. Every other draft that ignores this has a hole in its plan.

5. **Condition parser with allowlist grammar.** Explicit support for `outcome`, `exit_code`, and `attempt` operators without `eval` covers the conditions actually used in the sample garden and the attractor spec's basic cases.

6. **Well-scoped out-of-scope list.** The explicit exclusions (codergen, wait.human, parallel, fan-in, manager loop, goal gates, HTTP server, web UI, Windows) prevent scope creep without being so aggressive that the sprint can't prove the execution model.

7. **Environment variable injection.** Defining `POLLINATOR_*` variables (`RUN_ID`, `NODE_ID`, `ATTEMPT`, `RUN_DIR`, `GARDEN_PATH`) gives tool scripts a contract for accessing run context. This is a small detail that makes the system composable.

8. **Validation as pure functions returning `Diagnostic[]`.** Not throwing exceptions for user mistakes is the right design. Validators should report, not crash.

9. **Thorough file manifest.** 35+ files with action and purpose columns. An executor can work through this without guessing intent.

10. **Security section is substantive.** Addresses eval avoidance, privilege escalation, environment leakage, and cocoon atomicity — not boilerplate.

### Weaknesses

1. **No `status` command.** The Claude draft includes `pollinator status [run-id]` for listing and inspecting runs. The Codex draft ships `run`, `resume`, and `validate` but gives the user no way to list or inspect cocoons short of reading JSON files by hand. For a CLI that's "genuinely fun to use," this is a UX gap.

2. **Edge selection algorithm is underspecified.** The draft says "first matching conditional edge wins; if none match, use the first outgoing edge with no condition." This is a simplified two-step algorithm, not the 5-step deterministic algorithm the attractor spec requires (condition match → preferred label → suggested IDs → weight → lexical order). The sprint intent document explicitly names the 5-step algorithm as a success criterion. Even if Sprint 1 doesn't exercise all 5 steps, the implementation should be structurally complete so it doesn't need to be rewritten in Sprint 2.

3. **No graph hash in cocoon.** The Claude draft stores a SHA-256 of the DOT file content so `resume` can detect if the pipeline definition changed since the checkpoint was written. The Codex draft re-validates the garden on resume but doesn't detect structural drift. A user who edits the DOT file between interruption and resume could get silently wrong behavior.

4. **Phase 0 is busywork.** Creating `docs/upstream/ATTRACTOR-PIN.md` and a README before any code exists is a process artifact, not a product milestone. The README will be wrong by the end of the sprint. Pin the attractor commit in a one-line file or a comment in `package.json` and write the README as Phase 4 cleanup.

5. **Condition grammar is narrower than needed.** Only `outcome`, `exit_code`, and `attempt` are supported. The attractor spec's condition expressions include `context.<key>=<value>` and compound operators (`&&`, `||`). The compliance-loop.dot only uses `outcome=success` and `outcome=fail` today, but skipping compound support means any slightly more complex garden is blocked until Sprint 2.

6. **`zod` may be over-engineering for Sprint 1.** Runtime validation of cocoon state is defensive, but the cocoon schema is internal and written by the engine itself. A `JSON.parse` with a type assertion is sufficient when there's exactly one writer. Save `zod` for when external input (user-authored config, HTTP API payloads) enters the picture.

7. **No mention of tool node timeouts.** The risk table covers parser limitations, resume semantics, and shell behavior, but doesn't address a tool script that hangs indefinitely. The attractor spec defines a `timeout` attribute on nodes. Even if Sprint 1 doesn't implement the full timeout system, a sensible default (e.g., 5 minutes) with a kill should exist.

### Gaps in Risk Analysis

- **No timeout risk.** A tool node with an infinite loop or network wait will block the pipeline forever. Mitigation: default timeout, documented override.
- **No concurrent run risk.** Two `pollinator run` invocations on the same garden can race on cocoon writes. Sprint 1 probably doesn't need locking, but the risk should be acknowledged.
- **No large output risk.** A tool node that dumps 500MB to stdout will be captured into cocoon logs and potentially blow up memory or disk. Mitigation: truncate or stream to disk with a cap.
- **No cycle detection risk.** The compliance loop has a legitimate cycle (validate → compliance_check → ... → implement → validate). But a malformed garden could create a cycle with no exit node reachable. The engine would loop forever. The validator should check that at least one exit node is reachable from every cycle.

### Missing Edge Cases

- **Empty `script` attribute.** What if a tool node has `script=""` or `script` is whitespace? Should fail validation, not runtime.
- **Non-existent script path.** The `script` attribute is a shell string, not a file path, but if it references a file that doesn't exist, the shell error should be surfaced clearly.
- **`max_retries` edge values.** What about `max_retries=0` (no retries, which should be valid) vs missing `max_retries` (inherit default)? The draft says `>= 0` but doesn't specify the default.
- **Multiple exit nodes.** The compliance-loop.dot has one exit node, but the validator allows "at least one." What if a run reaches different exit nodes on different paths? Does each one count as success? The engine needs a clear rule.
- **Cocoon directory doesn't exist.** First run on a fresh checkout — does the engine create `cocoons/` or error?

### Definition of Done Completeness

The Codex DoD has 10 items, which is reasonable. Notable gaps:

- **No `npm test` passes requirement.** The draft specifies extensive tests but the DoD doesn't require them to pass. Add: "All automated tests pass on a clean checkout."
- **No piped/non-TTY output requirement.** The draft mentions `NO_COLOR` and non-TTY support in the implementation section but doesn't make it a DoD gate.
- **No `status` command.** If it's not in scope, fine, but the user's INTENT.md envisions a CLI that's "feature-complete" and inspectable. A `status` command would be low effort and high payoff.

**Overall DoD grade: B+.** Covers the critical paths well but misses the testing and output-mode gates that prevent regressions.

---

## Gemini Draft

### Strengths

1. **Honest about its limits.** The scope boundary is deliberately narrow and the open questions are genuinely useful (logging strategy, concurrent runs, cocoon cleanup). Raising these questions is more valuable than silently picking a default.

2. **Cocoon location in `.nectar/cocoons/`.** This matches the INTENT.md directory structure (`/.nectar/` for configuration and state) better than the Codex draft's top-level `cocoons/` directory. Keeping runtime artifacts out of the project root is cleaner, especially since the workspace will eventually have `seedbed/`, `honey/`, `gardens/`, etc.

3. **Mentions `zod` for runtime validation.** While I flagged this as over-engineering for Codex, in Gemini's draft the parser is custom and therefore higher risk — validating the parser's output with `zod` actually makes sense as a safety net here.

4. **Clear fallback plan for the parser.** "If it gets too complex, we will pivot to using a lightweight library like `ts-graphviz/parser`" — this is honest risk management. The problem is that the primary plan is still the risky one.

5. **Concise phasing.** Five phases, each 3-5 bullet points. Easy to track progress and estimate effort.

### Weaknesses

1. **Custom regex/state-machine DOT parser is the wrong bet.** The draft itself calls this a potential "bug farm." Graphviz DOT has enough syntactic quirks (quoted vs unquoted identifiers, semicolons as terminators or separators, comments in multiple styles, edge chaining, attribute list syntax) that a hand-rolled parser will eat a disproportionate share of the sprint. The Codex draft's decision to use `@ts-graphviz/parser` is strictly better. Writing a parser is interesting engineering work but it produces zero user value that a library doesn't.

2. **Edge chaining explicitly out of scope.** The draft says `A -> B -> C` on a single line is not supported. The current `compliance-loop.dot` happens to use one-edge-per-line, but the attractor spec supports chaining and future gardens will use it. More importantly, this is a normalization step in the parser, not an engine concern — if you're using a library, you get it for free. Excluding it signals that the parser cost is already too high.

3. **Only `outcome=success` and `outcome=fail` conditions.** This is the narrowest condition support of any draft. No `exit_code`, no `attempt`, no `context.<key>=<value>`, no compound operators. The compliance-loop.dot happens to use only `outcome=success` and `outcome=fail`, so it works for the demo — but any user who tries to write their own garden with slightly more complex routing is immediately blocked.

4. **No `validate` command.** The sprint intent document lists "Validate DOT files — `pollinator validate <file>` checks structural correctness" as a success criterion. The Gemini draft only delivers `run` and `resume`. This is a direct gap against the stated requirements.

5. **No fixture script.** The draft does not address the fact that `gardens/compliance-loop.dot` references `python3 scripts/compliance_loop.py` which does not exist. The run command will parse the file and then immediately fail at the first tool node. The Codex draft solves this; the Gemini draft doesn't mention it. This is not a minor omission — it means the sprint's primary demo doesn't actually work.

6. **Uses `child_process.spawn` directly.** No mention of `execa` or any wrapper that handles signal forwarding, shell quoting, exit code normalization, or stream capture robustly. `child_process.spawn` requires significant boilerplate to get right on macOS and Linux. The Codex draft correctly reaches for `execa`.

7. **No atomic cocoon writes.** The draft defines a cocoon schema and read/write operations but doesn't mention atomicity. A `Ctrl+C` during `fs.writeFileSync` of a 10KB JSON file is unlikely to corrupt it, but it's not guaranteed. The Codex draft's temp-file-plus-rename approach costs one extra line of code and eliminates the risk entirely.

8. **No event system.** The engine and CLI appear to be directly coupled — no typed events, no subscriber pattern. This means the engine can't be reused by the HTTP server or web UI without refactoring. The attractor spec requires an event stream (`/pipelines/{id}/events`), and building the engine without events from day one means retrofitting them later.

9. **No `NO_COLOR` or pipe detection.** The themed output section doesn't mention what happens when stdout is piped or when the `NO_COLOR` environment variable is set. The INTENT.md says "Graceful fallback for dumb terminals" and "Pipe-friendly (detect TTY, output plain text when piped)."

10. **`uuid` package for run IDs.** Node 19+ has `crypto.randomUUID()` built in. Adding a dependency for something the runtime already provides is unnecessary.

11. **File manifest is too thin.** 16 files listed, with minimal purpose annotations. Compare to Codex's 35+ files with action and purpose columns. An executor working from Gemini's manifest would need to make many structural decisions that should be made in the planning phase.

12. **No POLLINATOR_* environment variables.** Tool scripts have no contract for accessing run context (run ID, node ID, attempt number). They execute blind.

### Gaps in Risk Analysis

- **Only 3 risks listed.** For a greenfield project with a custom parser, shell execution, and checkpoint/resume semantics, this is not enough.
- **No risk for the compliance-loop.dot being non-executable.** This is the most concrete blocker in the sprint and it's not mentioned.
- **No risk for resume with non-idempotent scripts.** If a tool node partially modified the filesystem before interruption, resume will re-run it. The Codex draft explicitly calls this out and documents idempotency requirements.
- **No risk for platform differences beyond a passing mention of macOS.** No Linux mention, no shell behavior discussion.
- **No risk for edge selection ambiguity.** The 5-step algorithm has interpretation questions (what exactly does "preferred label" mean?). The Claude draft dedicates significant space to documenting each step.
- **No risk for DOT file changes between run and resume.** The cocoon stores a "DAG hash/path" but there's no discussion of what to do when they diverge.

### Missing Edge Cases

- **All edge cases listed for Codex apply here**, plus:
- **Tool node with no `script` attribute.** There's no validation mentioned that checks for this.
- **Corrupted cocoon file.** What if the JSON is malformed when `resume` tries to read it? No error handling strategy.
- **Run ID that doesn't exist.** `pollinator resume nonexistent-id` — what's the user experience?
- **Multiple edges with the same condition.** Which one wins? The draft says "deterministic" but doesn't define the tiebreaker.
- **SIGTERM handling.** Only SIGINT (Ctrl+C) is mentioned. Docker, systemd, and process managers send SIGTERM.
- **Exponential backoff specifics.** The draft says "simple backoff" but doesn't define base delay, multiplier, jitter, or maximum delay.

### Definition of Done Completeness

The Gemini DoD has 8 items. Notable gaps:

- **No build requirement.** `npm install && npm run build` is not listed. The first DoD item goes straight to "parses the file without errors."
- **No test pass requirement.** "Automated tests for the parser and edge selection pass" is listed but there's no requirement for other tests (handler, checkpoint, integration).
- **No retry behavior verification.** The DoD says "conditional edges correctly route" but doesn't verify retry logic with backoff.
- **No validate command verification.** Because the command isn't in scope, the DoD can't test it — but the sprint intent says it should exist.
- **"Terminal output is themed appropriately" is vague.** Themed how? What's the acceptance criterion? The Codex draft is more specific: the sample run must exercise retry and loop-back.
- **No piped output check.** INTENT.md requires pipe-friendly output.

**Overall DoD grade: C.** Covers the happy path but doesn't gate on build, testing, retry, validation, or output correctness.

---

## Head-to-Head Comparison

| Dimension | Codex | Gemini |
|-----------|-------|--------|
| Parser strategy | Library (`@ts-graphviz/parser`) — low risk | Custom regex/state machine — high risk |
| Condition support | `outcome`, `exit_code`, `attempt` | `outcome` only |
| Edge selection | 2-step simplified | Claims 5-step but underspecified |
| Commands | `run`, `resume`, `validate` | `run`, `resume` |
| Fixture script | Ships `compliance_loop.mjs` | Not addressed |
| Cocoon atomicity | Temp-file + rename | Not mentioned |
| Event system | Typed `RunEvent` union | No event system |
| Environment variables | `POLLINATOR_*` contract | Not mentioned |
| File manifest | 35+ files, detailed | 16 files, minimal |
| Risk analysis | 5 risks with mitigations | 3 risks with mitigations |
| DoD items | 10 | 8 |
| Estimated implementation clarity | High — an executor could work from this | Medium — many decisions left open |

---

## Recommendations for the Final Sprint

### Take from Codex

1. **Parser strategy.** Use `@ts-graphviz/parser` behind a facade. Non-negotiable. The ROI on a custom parser is negative this sprint.
2. **Fixture script.** Ship `scripts/compliance_loop.mjs` and update the DOT file. Without this, the demo doesn't work.
3. **Atomic cocoon writes.** Temp-file + rename. One line of code, eliminates a class of corruption bugs.
4. **Event-driven engine/CLI boundary.** The `RunEvent` typed union keeps the engine reusable and testable.
5. **POLLINATOR_* environment variables.** Give tool scripts a contract for run context.
6. **Condition support breadth.** At minimum `outcome`, `exit_code`, `attempt`. Add `context.<key>=<value>` if time allows.
7. **Explicit security section.** No-eval condition parsing, no privilege escalation, atomic writes.
8. **Comprehensive file manifest.** The executor needs to know what to build and why.

### Take from Gemini

1. **Cocoon location.** `.nectar/cocoons/` is more aligned with INTENT.md's directory structure than a top-level `cocoons/` directory. Keep runtime artifacts out of the project root.
2. **Open questions as first-class deliverables.** Gemini's questions about logging strategy, concurrent runs, and cocoon cleanup are practical and worth resolving before implementation starts.
3. **Stub handlers for unimplemented types.** The Claude draft proposes this too. If a user writes a garden with a `box` node (codergen), the CLI should warn and pass through, not crash. Codex's draft rejects unsupported shapes at validation time, which is correct for strict mode but hostile for experimentation.
4. **`status` command.** Gemini doesn't include it, but raises the question of cocoon inspection. The Claude draft does include it. Add `pollinator status [run-id]` — it's low effort (read and format JSON) and fills a real UX gap.

### Take from Neither — Add These

1. **Full 5-step edge selection.** Both drafts either simplify or underspecify the algorithm. The final sprint should implement all 5 steps (condition match → preferred label → suggested IDs → weight → lexical order) even if the compliance-loop.dot only exercises steps 1 and 5. The algorithm is the engine's core intellectual property and getting it right now avoids a rewrite.
2. **Graph hash in cocoon.** Store a SHA-256 of the DOT file content. On resume, warn if the hash changed. Don't block resume — the user may have intentionally fixed the pipeline — but surface the drift.
3. **Default tool timeout.** 5 minutes default, overridable via `timeout` node attribute. Kill the process on expiry. A hung tool node shouldn't require `kill -9` from another terminal.
4. **Cycle safety analysis in validation.** Verify that every cycle in the graph has at least one edge that can break out toward an exit node. This doesn't prevent infinite loops at runtime (a condition could always evaluate to the loop-back edge), but it catches structural dead ends.
5. **`max_retries` default.** Define it explicitly: `0` (no retries) if the attribute is absent. Don't leave it ambiguous.

### Explicitly Drop

1. **Custom DOT parser** (Gemini Phase 2, Claude parser/ module). Use a library. Period.
2. **Phase 0 busywork** (Codex). Attractor pin can be a one-liner in `package.json` or a commit message. README should be written after the code works, not before.
3. **`RetryPolicy` enum with named presets** (Claude draft). Sprint 1 only needs `max_retries` + exponential backoff. Named presets (standard, aggressive, linear, patient) are attractor spec features that can wait for Sprint 2.
4. **`tsup` bundler** (Claude draft). `tsc` output is sufficient for Sprint 1. Bundling is distribution work.
5. **`uuid` package** (Gemini). Use `crypto.randomUUID()`.
