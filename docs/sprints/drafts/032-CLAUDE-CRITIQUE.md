# Sprint NEXT Critique — Claude

## Preamble

This critique evaluates `NEXT-CODEX-DRAFT.md` and `NEXT-GEMINI-DRAFT.md` against the current `docs/compliance-report.md` and the repo layout under `src/` and `test/`. The Codex draft is the stronger base overall. It has the tighter cut line, the better subsystem boundaries, and the more implementation-ready Definition of Done. The Gemini draft is easier to scan and does a better job presenting severity-driven scope, but it appears to have been written more directly from the compliance report than from the current branch, and that shows up in several file and ownership mismatches.

---

## Codex Draft

### Strengths

1. **Best scope discipline.** The draft stays centered on the runtime-correctness gaps that most directly affect live behavior: instruction precedence, unlimited loop semantics, process cleanup, tool-call hardening, and provider error fidelity. Deferring catalog churn, prompt-parity work, and unrelated Attractor cleanup is the right cut for a hardening sprint.

2. **Strong alignment with the current codebase.** The phase plan maps cleanly onto the actual files that own these behaviors today: `src/agent-loop/project-instructions.ts`, `src/agent-loop/session.ts`, `src/agent-loop/execution-environment.ts`, `src/handlers/codergen.ts`, `src/llm/client.ts`, `src/llm/retry.ts`, `src/llm/errors.ts`, and the provider adapters. This is the only draft that consistently respects the real subsystem boundaries.

3. **Good architectural instincts.** The draft puts process lifecycle ownership in `LocalExecutionEnvironment.exec()` instead of spreading kill logic across callers, and it insists on one shared deterministic tool-repair helper instead of duplicating repair behavior in multiple execution paths. Those are the two most important design choices in this sprint.

4. **Behavior-first use cases.** The use cases are written in terms of actual failures users see today: nested instruction resolution, sessions dying after 12 turns, orphan shell grandchildren, malformed tool calls, and lossy Anthropic reasoning state. That keeps the sprint anchored in observable outcomes rather than gap IDs.

5. **The strongest verification plan.** Each phase names the expected files, the expected tests, and the cross-cutting build/test/report gates. The Definition of Done is mostly behavioral and falsifiable, not just "gap X is fixed."

### Weaknesses

1. **No explicit pre-flight audit step.** The draft treats `docs/compliance-report.md` as perfectly current. The merged sprint should require a quick re-validation pass before implementation starts. That matters because nearby gaps such as `A3` appear to have already moved under active implementation on the current branch.

2. **Child-limit semantics are not fully closed.** The draft correctly distinguishes parent unlimited-by-default from child finite-by-default, but it never makes the omitted-child case fully first-class. It tests explicit `max_turns: 0` and explicit finite values, but not the equally important "parameter omitted, child stays bounded by `child_max_turns`" path.

3. **Instruction-discovery fallback behavior is still a little implicit.** The phase text mentions `git rev-parse --show-toplevel` with fallback to `workspace_root`, but it does not spell out how worktrees, nested repos, symlinked cwd values, or git-unavailable environments should be treated. Those are exactly the cases that make path-precedence code brittle.

4. **Repair observability is underspecified.** "Emit a warning" is the right instinct, but the draft does not say whether that warning must appear in the transcript, the event stream, the LLM response warnings, or all three. Since both `AgentSession` and `UnifiedClient` would consume the helper, that surface should be explicit.

### Gaps in Risk Analysis

- **No stale-audit risk.** There is no risk entry for the compliance report being out of date relative to the branch, which can lead to wasted scope or inaccurate report edits.
- **No git-root resolution risk.** `git rev-parse` can behave differently in worktrees, nested repos, shallow checkouts, and containerized CI environments without git installed. The draft mentions fallback behavior, but not the risk of inconsistent repo-root detection.
- **No coordinated-defaults risk.** Changing `max_turns` and `max_tool_rounds_per_input` to `0` will require touching tests, helpers, fixtures, and the codergen bridge in lockstep. The draft plans the code changes, but not the regression risk caused by many hard-coded `12` and `10` assumptions.
- **No consumer-compatibility risk for warning surfaces.** Adding repaired-call warnings and new compatibility error subclasses can shake snapshot tests or downstream event consumers if the emitted shapes change.

### Missing Edge Cases

- `discoverInstructions()` when git is unavailable, the cwd is outside a repo, or the cwd is a symlinked path into the workspace.
- Multiple large instruction files that exceed the 32 KB budget exactly at a precedence boundary. The merge order and drop order both need coverage.
- `spawn_agent` with omitted `max_turns`, explicit `0`, explicit finite values, negative numbers, and non-integer inputs.
- A shell command that exits quickly after spawning a detached grandchild. Timeout and abort coverage should prove the grandchild dies even when the immediate shell is already gone.
- Retry behavior when a `Retry-After` header is present, and the negative case where `on_retry` must not fire because no retry actually happens.
- `redacted_thinking.data` across a real multi-turn follow-up path, not just a single request/response translation.

### Definition of Done Completeness

The Codex DoD is the stronger one. It is mostly behavior-based, ties back to named gaps, and includes `npm run build`, `npm test`, and a useful anti-cheating guard ("No test timeout values were increased to achieve green").

The gaps are narrower than structural:

- It should explicitly verify the git-unavailable/outside-repo fallback path for instruction discovery.
- It should explicitly verify the omitted-child default remains finite, not just explicit `0` and explicit finite overrides.
- The repair section should require parity in both execution sites: `UnifiedClient` and `AgentSession`.
- The adapter mapping requirement would be stronger if it were written per adapter, not as one aggregate checkbox.

---

## Gemini Draft

### Strengths

1. **Severity-first framing is easy to understand.** The draft is readable at a glance and maps well to the compliance report. If the audience is trying to understand "which open items are we burning down next," Gemini presents that story clearly.

2. **Good instinct to tie success back to the compliance script.** Requiring the targeted gaps to move into the implemented list is a useful external check and should survive into the merged sprint.

3. **Concise use cases and phases.** The document is short, direct, and easier to skim than the Codex draft. It communicates intent quickly.

4. **It does surface a couple of opportunistic cleanup items.** Pulling `U3` into view and calling out `A3` shows an instinct to improve the scorecard, not just the runtime hot path. That is a reasonable instinct even if the final scope should be tighter.

### Weaknesses

1. **The scope is less coherent.** The draft mixes runtime hardening (`C1`, `C6`, `C8`, `U14`, `U18`) with a model-catalog refresh (`U3`) and an Attractor engine event (`A3`). That produces a less unified sprint than the Codex draft and weakens the "single execution path" story.

2. **Several file targets do not match the current codebase.** `RedactedThinkingContentPart` lives in `src/llm/types.ts`, not `src/llm/adapters/types.ts`. The coding-agent-loop shell gap (`C8`) belongs in `src/agent-loop/execution-environment.ts` and the shell tool path, not partly in `src/handlers/tool.ts`. On the current branch, `CheckpointSavedEvent` and `checkpoint_saved` emission also already appear to exist, so `A3` needs re-verification before it is kept in scope.

3. **The tool-repair design is at the wrong layer.** Catching JSON parse failures inside adapter response handling and applying trailing-comma/unescaped-quote heuristics is not enough. The repair path needs to be shared by both `UnifiedClient.generate()` and `AgentSession.processWorkItem()`, revalidated with schema logic, and guaranteed to fail closed. Gemini's plan does not get there.

4. **The default-limit fix is incomplete.** Changing `SessionConfig` defaults to `0` without also defining `0` semantics in `src/agent-loop/session.ts`, the subagent path, and the `src/handlers/codergen.ts` bridge is a classic half-fix. This is one of the most dangerous places to be vague.

5. **The file plan omits too many real touch points.** There is no mention of `src/agent-loop/session.ts`, `src/agent-loop/subagent-manager.ts`, `src/handlers/codergen.ts`, `src/llm/retry.ts`, or the non-Anthropic adapters for explicit status-code mapping. The work would have to be rediscovered mid-sprint.

6. **The process-group plan is brittle.** Sprinkling `detached: true` and `process.kill(-pid)` into execa call sites is weaker than making the execution environment own process-group lifecycle end to end. The Codex draft has the better design here.

7. **The document overstates its completeness.** It calls the goal a "fully spec-compliant engine" while leaving adjacent runtime gaps unaddressed and while being less specific about how the selected gaps would actually be closed.

### Gaps in Risk Analysis

- **No stale-scope risk.** The draft does not acknowledge the possibility that a targeted gap from the compliance report is already implemented or partially implemented on the current branch.
- **No subsystem-boundary risk.** There is no risk entry for solving the right problem in the wrong layer, even though the file plan already shows cross-wiring between agent-loop and engine subsystems.
- **No zero-means-unlimited risk.** The draft changes the numeric defaults but does not identify the danger that existing `while (count < max)` style logic will interpret `0` as immediate failure unless all loop predicates are updated together.
- **No shared-repair risk.** The repair plan could diverge between the unified LLM client and the agent session loop, or repair could accidentally execute a tool twice. Neither risk is called out.
- **No dependency/heuristic risk for repair.** The risk table recommends `jsonrepair` or regex-style fixers while the dependency section says no new runtime dependencies. It also understates how easily aggressive JSON cleanup can mutate valid string payloads.
- **No partial-error-taxonomy risk.** Fixing `TimeoutError.retryable` without explicitly covering 408/413/422 mappings and retry callback behavior can leave the unified error model internally inconsistent.
- **No catalog-staleness risk.** If `U3` is in scope, the draft should acknowledge that model catalog updates age quickly and may expand test fallout beyond a "quick win."

### Missing Edge Cases

- `spawn_agent(max_turns)` with omitted value versus explicit `0` versus explicit finite value.
- A repaired call that parses as JSON but still fails schema validation because required fields are missing or coercion would be lossy.
- `discoverInstructions()` precedence when `AGENTS.md` and provider-specific files coexist in the same directory, and when the session starts outside a git repo.
- Timeout versus abort behavior for process groups. The draft mentions kill behavior generally, but not both termination paths explicitly.
- Explicit HTTP 408, 413, and 422 handling across all adapters, plus the locally synthesized timeout path in retry middleware.
- `redacted_thinking.data` surviving a real multi-turn round-trip without inspection, truncation, or logging.
- Compliance-script output when one targeted gap was already implemented before the sprint began.

### Definition of Done Completeness

The Gemini DoD is materially weaker than the Codex DoD. It is short, but most of its items are gap labels or broad test statements rather than concrete behavioral assertions.

Specific omissions:

- No `npm run build` gate.
- No explicit requirement that `0` behaves as unlimited in the actual session loops.
- No explicit requirement that omitted child `max_turns` stays finite.
- No explicit per-adapter coverage for 408/413/422 mappings.
- No explicit `on_retry(error, attempt, delay)` behavior check.
- No guard against making tests pass by increasing timeouts.
- No exact-once repair criterion.
- No requirement that the compliance report update be accurate relative to the current branch state.

The compliance-script exit criterion is worth keeping, but the rest of the DoD needs to be rebuilt around user-visible behavior.

---

## Recommendations for the Final Merged Sprint

1. **Use the Codex draft as the structural foundation.** Its phasing, subsystem boundaries, file mapping, risk analysis, and Definition of Done are materially stronger and much closer to the current codebase.

2. **Add a short Phase 0 audit before implementation begins.** Re-run the compliance check against the current branch and confirm the target gap list before coding. In particular, verify whether `A3` is still open before carrying it into scope.

3. **Keep the sprint centered on runtime hardening.** Preserve Codex's focus on `C1`, `C2`, `C6`, `C7`, `C8`, and `U13`-`U18`. Treat `U3` as an optional stretch item only if it remains a one-file, low-risk change after the runtime work is done.

4. **Do not adopt Gemini's repair strategy.** The merged sprint should require one shared, local, deterministic repair helper with schema-guided revalidation, no second LLM pass, no broad JSON "fix everything" heuristic, and no new runtime dependency unless absolutely necessary.

5. **Keep process-group ownership in the execution environment.** Do not spread `detached`/`kill(-pid)` logic across handlers. `LocalExecutionEnvironment.exec()` should own timeout, abort, and teardown semantics, with the shell tool staying thin.

6. **Strengthen the merged Definition of Done with a few missing checks.** Add explicit assertions for:
   - git-unavailable and outside-repo instruction discovery fallback
   - omitted child `max_turns` staying finite by default
   - repaired tool calls executing exactly once in both `UnifiedClient` and `AgentSession`
   - per-adapter 408/413/422 mappings plus `on_retry(error, attempt, delay)` behavior
   - no timeout inflation to make tests pass

7. **Keep Gemini's external validation instinct.** Require the compliance script and `docs/compliance-report.md` to match the shipped behavior at the end of the sprint, but only after the target-gap set has been revalidated.
