# Sprint 033 Draft Critique — Codex Review

**Drafts reviewed:** NEXT-CLAUDE-DRAFT.md (Claude), NEXT-GEMINI-DRAFT.md (Gemini)
**Reviewer perspective:** Codex (NEXT-CODEX-DRAFT.md author)
**Date:** 2026-03-21

---

## Claude Draft: "Green Suite & Remaining Compliance Closure"

### Strengths

1. **Root-cause diagnosis is excellent.** The three-bug breakdown (deferred SSE close, inverted `withLiveCurrentNode()` guard, pipeline creation 400) is specific, actionable, and cites exact files and line numbers. This is the strongest section in either draft. No other draft reaches this level of diagnostic precision.

2. **Phase gating is the right structure.** "Phase 2 does not begin until `npm test` is green" is a hard constraint that prevents the failure mode of the last 8 sprints — mixing test fixes with feature work and shipping neither. The sprint correctly identifies this as the central lesson from sprints 025–032.

3. **Historical context is honest.** The Overview section does not sugarcoat the 8-sprint streak of failures. Naming the pattern ("previous sprints failed because they mixed SSE fixes with large feature work") builds institutional memory and justifies the inverted priority.

4. **Compliance categorization is thorough.** Grouping the 25 gaps into four categories (interface shapes, adapter methods, naming conventions, missing capabilities) with explicit gap IDs per category makes it easy to track progress and estimate effort.

5. **Definition of Done is the most comprehensive.** 25 checkboxes that individually verify every gap closure, plus build/test gates. This is auditable — you can mechanically verify each item.

### Weaknesses

1. **Scope is almost certainly too large.** 6 test fixes + 25 compliance gaps + tests for all of them in a single sprint. The risk table acknowledges this ("This sprint is too large for a single pass") but the mitigation ("compliance gaps can overflow to Sprint 034") undermines the DoD, which requires zero gaps. Either scope down or make the overflow explicit in the DoD.

2. **Phase effort estimates don't add up.** Phases sum to 100% but Phase 1 (6 test fixes) is 30% while Phase 2 (9 type additions) is 20% and Phase 4 (validation + events + handler + engine changes) is also 20%. The A1/A4/A5 work in Phase 4 involves behavioral changes with test updates across multiple integration suites — this is likely underestimated relative to adding optional fields.

3. **A2 (ReadWriteLock) treatment is a doc comment, not a fix.** The draft proposes adding a comment explaining that JS's event loop provides the equivalent guarantee. This is defensible but should be explicitly flagged as "intentional divergence documented" rather than "gap closed." If the spec literally requires a ReadWriteLock, a comment is non-compliant; if the spec requires the *guarantee* the lock provides, a comment is sufficient. The draft doesn't engage with which interpretation is correct.

4. **A4 (PascalCase events) approach is vague.** "Add a `toPascalCase()` event name mapping utility. Emit events with both snake_case and PascalCase names, or add a PascalCase alias registry that consumers can opt into." The word "or" in an implementation plan is a red flag — which one? Dual-emission doubles the event surface and creates ambiguity about which name is canonical. An alias registry is cleaner but the draft doesn't commit to it.

5. **Bug 3 diagnosis is incomplete.** "This requires investigation of the exact error response" — fair, but the draft then allocates a fixed 30% phase budget to a phase that includes an unknown-scope investigation. If the pipeline creation 400 has a deeper cause (the risk table rates this Medium likelihood, High impact), Phase 1 could consume the entire sprint.

6. **No mention of SSE lifecycle test already in the working tree.** `test/server/sse-lifecycle.test.ts` is listed as untracked in git status. The draft proposes adding a guard test to this file but doesn't acknowledge that it may already exist with relevant content.

### Gaps in Risk Analysis

- **No risk entry for A4 dual-emission breaking event consumers.** If both snake_case and PascalCase events are emitted, any consumer that subscribes to `*` or iterates all events will see duplicates. This is a real regression vector.
- **No risk entry for the `text` accessor on Message.** Adding a getter that concatenates text parts changes the serialization shape if `Message` is ever `JSON.stringify`-ed with computed properties. Low risk but unaddressed.
- **Parameter alias precedence is identified but the resolution ("spec-named takes precedence") could silently ignore user-provided values.** If a user passes `path` and `file_path` in the same call, silently dropping `path` is surprising. Should this be an error instead?

### Missing Edge Cases

- What happens if `createFiniteSseStream` is called but no terminal event is ever written? The synchronous close fix removes the deferred close — is there still a cleanup path for abandoned streams?
- The `terminal_node` exactly-one enforcement: what about composed/imported subgraphs? Do they each need exactly one exit, or only the root graph?
- `UnifiedClient.close()` iterates all registered adapters — what if an adapter's `close()` throws? Does it short-circuit or continue closing the rest?

### Definition of Done Completeness

Comprehensive but has one structural issue: the DoD conflates "all 25 gaps closed" with "tests pass" as if they are equally hard gates. Given the acknowledged risk that scope may overflow, the DoD should distinguish between hard gates (tests green, build passes, SSE fix landed) and soft gates (compliance report empty) so partial credit is possible without declaring the sprint failed.

---

## Gemini Draft: "Spec Compliance Polish"

### Strengths

1. **Concise and well-organized.** At roughly one-third the length of the Claude draft, it covers all 25 gaps without redundancy. Every gap ID is traceable to a phase and task.

2. **Three-phase structure is clean.** High-severity first, then engine/agent-loop alignment, then LLM interface completion. The severity-based ordering is a reasonable prioritization.

3. **Use cases are user-facing.** "Strict Validation," "Safe Parallel Context," "Provider Parity," "Complete LLM Interfaces" — each frames the work in terms of what a developer or user gains, not just what code changes.

### Weaknesses

1. **A2 (ReadWriteLock) proposes implementing an actual async ReadWriteLock.** This is the most dangerous item in either draft. Introducing a concurrency primitive into a single-threaded JS runtime is unnecessary complexity that creates real deadlock risk (as the draft's own risk table acknowledges). The spec's intent is thread-safe parallel context access; JS already provides this through the event loop for synchronous operations, and the existing implementation uses context clones for parallel branches. Implementing a lock is over-engineering that could introduce bugs where none exist today.

2. **A4 proposes a full rename from snake_case to PascalCase.** "Rename events to PascalCase in `src/engine/events.ts` and update all CLI/server consumers." This is a breaking change that the draft underestimates. The risk table says "High likelihood, Medium impact" but the mitigation ("rely on TypeScript compiler errors") only catches statically-referenced event names. Any string-based event matching (SSE event types, test assertions, CLI formatters, external consumers) will silently break. The Claude draft's alias approach, while vague, is less destructive.

3. **No mention of the 6 failing integration tests.** This is the most critical omission. The test suite has been red for 8 sprints. A compliance sprint that doesn't acknowledge or fix the existing test failures will ship with a red suite, making it impossible to verify that the compliance changes themselves don't break anything. You cannot do a "polish" sprint on an unstable foundation.

4. **No phase gating or ordering constraints.** All three phases could theoretically be worked in parallel, but Phase 2 (engine changes, event renames) could break tests that Phase 3 relies on. The draft doesn't specify sequencing.

5. **Definition of Done is too thin.** Only 5 items, of which 2 are generic ("npm test passes," "25 gaps addressed"). There is no way to mechanically verify that each individual gap was closed without re-auditing the entire compliance report. Compare this to the Claude draft's 25-item DoD.

6. **Phase effort allocation is inverted.** Phase 3 (LLM interface additions — mostly optional fields) is 40%, while Phase 2 (ReadWriteLock implementation, event rename across all consumers, codergen handler changes, tool parameter renames, provider-specific prompts) is 30%. Phase 2 contains the hardest and riskiest work.

### Gaps in Risk Analysis

- **No risk for ReadWriteLock deadlocks in production**, only "Implement the lock simply" as mitigation. A deadlock in the execution engine is a pipeline hang with no user-visible error — this is a high-severity production risk.
- **No risk for breaking external consumers of snake_case events.** If anything outside the repo subscribes to SSE events by name, the rename silently breaks it.
- **No risk for scope.** 25 gaps including a concurrency primitive, a full event rename, and 13 interface additions — this is at least as large as the Claude draft but presents no contingency plan.
- **No acknowledgment of the test suite's current state.** Without knowing the suite is red, the "npm test passes" DoD item could be satisfied by coincidence or by increasing timeouts.

### Missing Edge Cases

- ReadWriteLock: what happens when a handler acquires a write lock and then throws? Is the lock released? What about nested lock acquisition?
- Event rename: what about persisted event names in checkpoint files, activity.jsonl, or SSE stream archives? Are these migrated?
- Tool parameter renames: the draft says "rename" but does it mean replace (breaking) or alias (compatible)? The Claude draft explicitly says alias.

### Definition of Done Completeness

Insufficient. Key items missing:
- No individual gap verification (just "all 25 addressed")
- No "no timeout inflation" constraint
- No specific test file requirements
- No verification that existing functionality isn't broken by the event rename or ReadWriteLock
- "Event names logged to CLI and emitted from the engine are in PascalCase" — what about events in SSE streams, checkpoint files, and activity logs?

---

## Comparative Analysis

| Dimension | Claude | Gemini |
|-----------|--------|--------|
| Test suite awareness | Excellent — primary deliverable | Absent |
| Diagnostic precision | High (line numbers, exact bugs) | Low (task-level only) |
| Scope realism | Acknowledged overscope, partial mitigation | Unacknowledged overscope |
| A2 approach | Doc comment (safe, pragmatic) | Full ReadWriteLock (risky, unnecessary) |
| A4 approach | Alias/dual-emit (compatible, vague) | Full rename (breaking, high-risk) |
| DoD rigor | 25 items, mechanically verifiable | 5 items, requires manual audit |
| Risk analysis | 8 risks with mitigations | 3 risks, mitigations are thin |
| Brevity | Verbose but thorough | Concise but incomplete |

---

## Recommendations for the Final Merged Sprint

1. **Fix the test suite first — adopt Claude's Phase 1 as the hard gate.** The 6 failing integration tests must be the primary deliverable. No compliance work ships on a red suite. Use Claude's root-cause analysis verbatim — it is specific and actionable.

2. **Scope compliance work to what the sprint can actually land.** 25 gaps in one sprint has failed implicitly across 8 prior sprints. Recommend targeting the 2 high-severity gaps (A1, U19) and a curated subset of medium/low gaps (perhaps 8–12 total) that are genuinely single-file additions. Defer the rest to Sprint 034 explicitly, and make the DoD reflect the actual scope.

3. **Reject the ReadWriteLock (Gemini A2).** Adopt Claude's approach: document that JS's single-threaded event loop + context clones provides the spec's safety guarantee. Do not introduce a concurrency primitive where none is needed.

4. **Reject the full event rename (Gemini A4).** Either add PascalCase aliases alongside existing snake_case names (Claude's approach, but commit to one mechanism — recommend an alias registry, not dual emission) or document the naming convention as an intentional divergence. A full rename is a breaking change with high blast radius.

5. **Adopt Claude's DoD structure** with per-gap verification items, but trim it to match the actual scoped gaps. Add the "no timeout inflation" constraint from Claude. Add an explicit "no existing tests regressed" gate.

6. **Include the Codex draft's runtime-truth work selectively.** The `withLiveCurrentNode()` fix and pipeline creation 400 fix are already in Claude's Phase 1. The deeper question-store and seed-bridge work from the Codex draft is valuable but should be deferred — it is new feature work, not compliance closure.

7. **Address the SSE abandoned-stream edge case.** Neither draft covers what happens when a stream is opened but no terminal event arrives. Add a server-side idle timeout or connection-close handler as a safety net.

8. **Resolve parameter alias semantics before implementation.** When both old and new parameter names are provided, define the behavior (error vs. precedence) and document it. Don't leave this as a test-time surprise.
