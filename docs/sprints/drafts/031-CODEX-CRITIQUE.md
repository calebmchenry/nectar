# Sprint 031 Draft Critique

**Reviewer:** Codex
**Date:** 2026-03-21
**Drafts reviewed:** NEXT-CLAUDE-DRAFT.md ("Claude"), NEXT-GEMINI-DRAFT.md ("Gemini")

---

## Claude Draft — Strengths

1. **SSE lifecycle fix is correctly identified as the top priority and given its own phase.** The 6 failing tests are real (verified: 6 failed | 128 passed), and the root-cause analysis — SSE streams never calling `res.end()` after terminal events — is precise and actionable. Gating compliance work on a green suite is the right sequencing decision.

2. **Exceptional root-cause specificity.** The draft names exact files (`src/server/routes/pipelines.ts`, `src/server/routes/gardens.ts`), exact terminal event types, and the exact mechanism (`res.end()` on next tick). This leaves almost no ambiguity for the implementer.

3. **All 15 gaps are individually scoped with file paths, interface changes, and test expectations.** The gap-to-file mapping table is immediately executable. No gap is left as "figure it out at implementation time."

4. **Risk table is concrete and paired with mitigations.** The `max_tool_rounds` default divergence risk (spec says 1, codebase says 10) is a subtle catch that the Gemini draft misses entirely.

5. **Backward compatibility is explicitly considered.** The Answer model enrichment (additive, not replacing), `max_tool_rounds` aliasing, and ModelInfo rename rationale all show awareness of downstream impact.

6. **Use cases are user-observable and testable.** "CI is green on a clean checkout" is a concrete, pass/fail gate — not a vague aspiration.

7. **Effort allocation is explicit** (35/15/25/25) and phases have clear dependency ordering.

---

## Claude Draft — Weaknesses

1. **No mention of the `run_error` event emission bug.** One of the 6 failing tests (`pipeline-events.test.ts`) fails because `run_error` is missing from the event stream — not because of a hanging SSE connection. The draft mentions "Fix `run_error` event emission" as a task, but buries it in Phase 1 without acknowledging it's a separate root cause from the SSE lifecycle issue. The "single root cause" framing is slightly misleading — there are at least two distinct bugs.

2. **Phase 1 scope creep risk.** Phase 1 bundles the SSE lifecycle fix, `current_node` context endpoint fix, and `run_error` emission fix. These are three separate bugs. If the SSE fix is clean but `run_error` requires engine-level changes, Phase 1 could block all compliance work unnecessarily.

3. **No time estimates per gap.** The overview mentions "~2 hours" for the longest task and "15–60 minutes" for the rest, but individual tasks have no estimates. This makes it hard to detect schedule risk until you're already behind.

4. **`stream-accumulator.ts` referenced but doesn't exist.** The draft references `src/llm/stream-accumulator.ts` for Gap 10, but this file may need to be created — it's not listed in the git status or file summary as "Create." If it already exists, fine; if not, this is an undocumented new file.

5. **ModelInfo flatten (Gap 15) is the riskiest change but has no rollback plan.** The draft acknowledges the risk and says "grep for `capabilities.` and `cost.`" — but if the rename is done in a single commit and something subtle breaks, reverting a mass rename is painful. A two-commit approach (add new names as aliases → remove old names) would be safer.

6. **Open questions are listed but not resolved.** Three open questions are posed with "proposed resolutions" — but a sprint document should resolve these before execution begins, not during.

---

## Gemini Draft — Strengths

1. **Clean, scannable structure.** The three-phase breakdown is easy to follow. Implementation phases map clearly to spec boundaries.

2. **Shell injection risk for glob/grep is called out.** This is a real concern the Claude draft doesn't flag — `execa` with unsanitized patterns could be exploitable if the execution environment processes untrusted input.

3. **Context window inflation risk for auto-discovered instructions is identified.** The 32KB budget reference from the spec is a concrete constraint that the Claude draft doesn't mention.

4. **`stream_end` error-state handling is flagged.** What happens when a stream ends prematurely? Should it emit `stream_end` with a partial response or an `error` event instead? This is an important design question the Claude draft skips.

5. **Concise and focused.** No bloat. Every section earns its space.

---

## Gemini Draft — Weaknesses

1. **Completely ignores the 6 failing tests.** This is the single biggest gap. The test suite is red _right now_ (6 failed | 128 passed, verified). The Gemini draft doesn't mention SSE lifecycle bugs, hanging tests, or the fact that `npm test` fails. A sprint titled "Compliance and Gap Closure" that doesn't address a red suite is building on a broken foundation. You cannot validate compliance changes when 6 tests are timing out.

2. **Sprint numbered "002" — out of sequence.** The ledger shows sprints up to 030. This should be 031.

3. **No effort estimates at any level.** Phase percentages are given (20/40/40) but no task-level sizing. The 40% allocation to Phase 2 (agent session & context) feels high for what's described — `unregister()` is a 15-minute task grouped alongside the more complex `glob()`/`grep()` implementation.

4. **Definition of Done is incomplete.** Only 7 items covering a subset of the 15 gaps. Missing DoD items for: AnswerValue enum, Cocoon.logs, event payload fields (artifact_count, index), provider_options, ToolRegistry.unregister, recent git commits, max_tool_rounds, auto_cache, ModelInfo renames. If it's not in the DoD, it's not verifiable.

5. **No test plan.** The Files Summary says `test/**/*.test.ts — Modify` as a single line. Which test files? What assertions? The Claude draft names 20+ specific test files. The Gemini draft's test coverage is unverifiable from the document alone.

6. **`max_tool_rounds` default behavior is unspecified.** The spec says default 1. The codebase uses 10 via `maxIterations`. The draft says "add max_tool_rounds" but doesn't address the default divergence or backward compatibility.

7. **ModelInfo rename scope is underspecified.** "Rename capability fields" is mentioned but the blast radius across consumers isn't analyzed. No mention of how many files reference the old names.

8. **No risk entry for the ModelInfo breaking rename.** This is arguably the riskiest single change in the sprint (touches type definitions used across the codebase) and it's not in the risk table.

9. **Interviewer implementation updates missing.** Gap 1 requires updating 5 interviewer implementations. The Gemini draft only mentions `src/interviewer/types.ts`. The actual work is in `auto-approve.ts`, `console.ts`, `callback.ts`, `queue.ts`, and `recording.ts`.

10. **Use cases are developer-centric, not user-observable.** "Rich Agent Context" and "Proper Search Tool Delegation" describe internal behavior. Compare Claude's "CI is green on a clean checkout" — that's a verifiable acceptance criterion.

---

## Gaps in Risk Analysis (Both Drafts)

1. **Neither draft addresses test isolation for SSE tests.** The failing tests use real HTTP servers. If the SSE fix introduces port conflicts or race conditions between parallel test runs, new flaky failures could emerge. Mitigation: ensure tests use ephemeral ports and proper cleanup.

2. **Neither draft considers the checkpoint schema migration.** Adding `logs: string[]` to `Cocoon` means existing serialized checkpoints (on disk) lack the field. What happens when `resume` loads an old checkpoint? Both drafts should specify: default to `[]` on deserialization if absent.

3. **Neither draft addresses the `run_error` vs `node_failed` event distinction.** The failing test expects `run_error` in the event stream. Is `run_error` a distinct event type or an alias? The engine code needs to be verified — this could be a spec gap, a missing event emission, or a test bug.

4. **The Gemini draft has no risk analysis for the `response: GenerateResponse` required change on `stream_end`.** If any adapter currently emits `stream_end` without a response (e.g., on connection reset), making the field required will cause a TypeScript error at the call site. This is a runtime safety concern, not just a type concern.

---

## Missing Edge Cases

1. **SSE client reconnection.** What if a client disconnects and reconnects mid-stream (e.g., EventSource auto-reconnect with `Last-Event-ID`)? Neither draft addresses whether the SSE endpoint supports replay or just starts from current state.

2. **`glob()` / `grep()` on empty directories or missing `rg` binary.** `grep()` delegates to `rg` via exec — but `rg` may not be installed in all environments (CI, containers). What's the fallback? Neither draft specifies.

3. **`discoverInstructions()` file encoding.** What if AGENTS.md contains non-UTF-8 content or is a symlink to a binary file? Edge case, but auto-discovery should handle it gracefully.

4. **`max_tool_rounds: 0` semantics.** Does 0 mean "no tool calls allowed" or "unlimited"? The spec likely says no tool calls, but neither draft clarifies.

5. **Concurrent `unregister()` during active tool execution.** If a tool is unregistered while an agent session is mid-loop and about to invoke it, what happens? Race condition worth documenting.

---

## Definition of Done Completeness

| Criterion | Claude | Gemini |
|-----------|--------|--------|
| Build succeeds | Yes | Yes |
| All tests pass | Yes (explicit zero failures) | Yes (but no mention of current 6 failures) |
| No timeout inflation | Yes | No |
| SSE lifecycle closes | Yes (2 endpoints) | Not mentioned |
| AnswerValue enum | Yes | No |
| Cocoon.logs | Yes | No |
| Event payload fields | Yes | No |
| agent_session_started | Yes | Yes |
| provider_options | Yes | No |
| ToolRegistry.unregister | Yes | No |
| glob/grep real impl | Yes | Yes |
| Auto-discover instructions | Yes | Yes |
| Recent git commits | Yes | No |
| stream_end required response | Yes | Yes |
| Message.name | Yes | No |
| max_tool_rounds | Yes | No |
| prompt+messages rejection | Yes | Yes |
| auto_cache disable | Yes | No |
| ModelInfo renames | Yes | No |
| Compliance report updated | Yes | No |

**Claude: 20/20 gaps covered in DoD. Gemini: 7/20 (counting SSE as a gap).**

---

## Recommendations for the Final Merged Sprint

1. **Use the Claude draft as the structural foundation.** It is significantly more complete in gap enumeration, file mapping, task decomposition, and Definition of Done. The Gemini draft's structure can inform simplification where the Claude draft is verbose.

2. **Adopt the SSE-first phasing from the Claude draft.** The Gemini draft's omission of the failing tests is a critical gap. No compliance work should be validated against a red suite.

3. **Split Phase 1 into two sub-phases.** (a) SSE lifecycle fix (the `res.end()` change), (b) ancillary test fixes (`run_error` emission, `current_node` endpoint). This prevents the SSE fix from being blocked by unrelated bugs.

4. **Incorporate Gemini's risk items into the Claude risk table:**
   - Shell injection risk for `glob()`/`grep()` implementations
   - Context window budget (32KB) for auto-discovered instructions
   - `stream_end` behavior on premature stream termination

5. **Add checkpoint deserialization handling.** Specify that `Cocoon.logs` defaults to `[]` when loading checkpoints that predate the field.

6. **Resolve the `max_tool_rounds` default before execution.** The Claude draft's proposed resolution (default 1 on GenerateRequest, preserve 10 on GenerateOptions) is correct but should be stated as a decision, not an open question.

7. **Add a fallback strategy for `grep()` when `rg` is unavailable.** Fall back to Node.js `fs.readFileSync` + regex matching, or throw a clear error with install instructions.

8. **Expand the Gemini draft's Definition of Done to cover all 15 gaps** — or simply adopt the Claude draft's DoD wholesale.

9. **Number the sprint 031** per the ledger sequence.

10. **Add an event-sequence integration test** (from Claude's risk mitigation) that asserts the full lifecycle: `run_started → node_started(0) → node_completed → ... → run_completed → SSE close`. This is the strongest guard against regression.
