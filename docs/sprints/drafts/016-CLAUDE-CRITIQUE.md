# Critique: Sprint 016 Drafts (Codex & Gemini)

**Reviewer:** Claude
**Date:** 2026-03-20
**Inputs:** NEXT-CODEX-DRAFT.md, NEXT-GEMINI-DRAFT.md, NEXT-CLAUDE-DRAFT.md (own draft, for contrast)

---

## Draft Comparison Summary

| Dimension | Codex | Gemini | Claude |
|-----------|-------|--------|--------|
| **Focus** | Attractor engine only (A1+A2+A3) | LLM client (L1-L8) + Attractor engine (A1) | LLM client only (L1-L5, L7-L8) |
| **Gaps closed** | 3 (A1, A2, A3) | 9 (L1-L8, A1) | 7 (L1-L5, L7-L8) |
| **New files** | ~8 source + ~7 test | ~4 source + ~0 test files listed | ~3 source + ~8 test |
| **Phases** | 4 | 4 | 6 |
| **Scope risk** | Medium-High | **Very High** | Medium |

---

## Codex Draft Critique

### Strengths

1. **Laser focus on the right engine gaps.** A1, A2, and A3 are the three remaining non-optional attractor engine gaps. Bundling them makes thematic sense — they're all execution-control features that share integration surfaces (engine loop, checkpoint, events).

2. **Exceptional architectural depth.** The manager loop design is the most detailed of any draft: explicit telemetry namespace (`stack.child.*`), filesystem control plane with `manager-steer.json`, atomic consumption semantics, per-tuple steer deduplication, and owned-child cleanup on parent exit. This level of specificity dramatically reduces implementation ambiguity.

3. **Restart semantics are well-reasoned.** The decision to reuse `interrupted` status with successor metadata (rather than inventing a `restarted` status) is pragmatic. Context filtering rules (keep user/business, drop internal/outcome) are explicit. Manifest linkage fields (`restart_of`, `restarted_to`) are clean.

4. **Tool hook design is production-ready.** Stdin JSON + `NECTAR_*` env vars + exit-code gating + per-call artifact persistence is a solid contract. The distinction between pre-hooks (gating) and post-hooks (audit-only, never mutate) is clear and correct.

5. **Strong risk analysis.** All five risks are real and actionable: orphaned children, restart lineage confusion, hook flakiness, steer note duplication, and infinite polling. Each has a concrete mitigation, not a hand-wave.

6. **Opinionated decisions section.** Explicitly stating that child runs are in-process, steering is next-turn/file-backed, and restarts create new run IDs settles design debates upfront.

### Weaknesses

1. **Sprint 015 dependency is assumed but not verified.** The draft depends heavily on Sprint 015's RunStore, manifest, checkpoint, artifact store, and event plumbing. If Sprint 015 isn't fully landed, this sprint has no foundation. The dependency section lists these but doesn't acknowledge the risk of building on incomplete infrastructure.

2. **Three major features in one sprint is ambitious.** Manager loop supervision, fresh-run restart, and tool call hooks are each non-trivial. The manager loop alone involves a new handler, a new controller module, child engine orchestration, telemetry ingestion, filesystem control files, and stop-condition evaluation. Adding restart chaining (manifest linkage, CLI follow-through, context filtering) and tool hooks (pre/post execution, artifact persistence, parallel tool-call behavior) creates a sprint with very high surface area.

3. **No effort estimates or cut-line.** The Claude draft explicitly identifies what to cut if the sprint runs long. The Codex draft has no priority ordering or cut-line, making it harder to de-scope if any feature takes longer than expected.

4. **LLM client gaps completely deferred.** The compliance report lists L1 (Middleware) and L3 (Model Catalog) as the two highest-priority gaps across all specs. Deferring all 8 LLM gaps means the client stays at ~85% compliance indefinitely. The draft argues "this sprint should finish the engine first" but doesn't justify why engine gaps (severity: 1 medium + 2 low) outrank client gaps (2 high + 4 medium + 2 low).

5. **Child engine lifecycle edge cases underspecified.** What happens if the child graph fails validation? What if `stack.child_dotfile` doesn't exist? What if the child run itself triggers a `loop_restart`? What if the parent is interrupted mid-child-poll — is the child checkpoint preserved for manual resume? These are mentioned in passing ("fail clearly if absent") but deserve explicit test scenarios.

6. **Tool hooks on parallel tool calls need more detail.** The draft says "test parallel tool-call behavior" but doesn't specify whether hooks run per-call or per-batch, whether pre-hook rejection of one parallel call affects others, or how hook timeouts interact with parallel execution.

### Gaps in Risk Analysis

- **No risk for restart loops.** If a graph has `A -> B [loop_restart=true]` and `B -> A [loop_restart=true]`, the engine could create infinite successor runs. No max-restart-chain-depth or cycle detection is mentioned.
- **No risk for child dotfile circular references.** A parent garden launching a child that references the parent as its own child creates infinite recursion. No depth limit is specified.
- **No risk for hook timeout interaction with agent session.** If a pre-hook hangs, the agent session may time out waiting for the tool result. The hook timeout and the session's tool-round timeout could interact badly.
- **No risk for filesystem control file race conditions.** The manager writes `manager-steer.json` while the child engine reads it. "Atomic consumption" is stated but the mechanism (rename? write-then-delete? advisory lock?) is not specified.

### Missing Edge Cases

- Manager `stop_condition` referencing keys that don't exist yet (child hasn't populated them)
- Manager with `max_cycles=0` or negative values
- `loop_restart=true` on an edge to an exit node
- `loop_restart=true` combined with `condition` — does condition evaluation happen before or after restart decision?
- Tool hook scripts that produce large stdout (unbounded artifact growth)
- Child run that emits its own events — do they propagate to the parent event stream?

### Definition of Done Completeness

The DoD is reasonable but has gaps:
- No build/regression gate (`npm run build`, `npm test` passing)
- No backward compatibility assertion (old pipelines without manager/restart/hook attributes still work)
- No mention of how many test cases are expected
- "Re-running the compliance report after implementation would close GAP-A1, GAP-A2, and GAP-A3" is good but unmeasurable as a DoD item
- Missing: hook timeout behavior tested, restart cycle prevention tested, child validation failure tested

---

## Gemini Draft Critique

### Strengths

1. **Broadest gap coverage.** Closing 9 gaps (L1-L8 + A1) in one sprint is the most aggressive coverage of any draft. If achievable, it would bring the project from 12 gaps to 3.

2. **Use cases are well-chosen.** Middleware interception, model catalog, cost visibility, supervisor orchestration, and OpenAI-compatible providers are all real user needs with clear value.

3. **Includes L6 (OpenAI-compatible adapter).** Neither the Codex nor Claude drafts include L6. Gemini recognizes that vendor lock-in is a real concern and addresses it. This is a genuine differentiator.

### Weaknesses

1. **Severely underspecified.** This is the draft's critical flaw. Compared to the Codex and Claude drafts, the Gemini draft reads like an outline, not a sprint plan:
   - **No architecture section for the LLM work.** No `Middleware` interface definition, no chain composition semantics, no streaming middleware design, no catalog lookup resolution rules. The Claude draft spends ~200 lines on middleware architecture alone; Gemini spends ~5.
   - **Manager loop has no control plane design.** No telemetry namespace, no steering mechanism, no child lifecycle management, no stop-condition evaluation details. Compare to Codex's explicit `stack.child.*` keys and `manager-steer.json` contract.
   - **No task-level detail.** Phases list broad categories ("Implement middleware chain execution") without the specific sub-tasks needed for implementation. The Claude draft lists 8-12 specific tasks per phase with exact assertions; Gemini lists 3-5 broad strokes.

2. **Scope is unrealistic.** The draft attempts to close 9 gaps spanning two completely different subsystems (LLM client infrastructure + attractor engine orchestration). This is approximately 2x the scope of either the Codex or Claude drafts, with less than half the specification detail. The LLM middleware work alone (L1) is the hardest gap in the project per the compliance report. Adding a full manager loop handler on top is a recipe for a sprint that delivers nothing well.

3. **L6 inclusion contradicts scope discipline.** The Claude draft explicitly argues against including L6 in this sprint with a detailed rationale (new protocol, different streaming format, edge cases across Ollama/vLLM/Together/Groq). Gemini includes it without addressing any of these concerns. An OpenAI-compatible adapter that doesn't handle the differences between Chat Completions streaming and Responses API streaming is a liability.

4. **No DoD for most gaps.** The Definition of Done has 6 items for 9 gaps. L2 (default client), L6 (OpenAI-compatible), L7 (RateLimitInfo), and L8 (ConfigurationError) have no specific DoD assertions. "All 8 Unified LLM gaps are fully implemented and unit-tested" is a placeholder, not a checkable criterion.

5. **No test files listed.** The Files Summary lists zero test files. For a sprint closing 9 gaps, this is a red flag — either testing was an afterthought or the plan expects tests to emerge organically. Neither is acceptable for infrastructure this foundational.

6. **Risk analysis is shallow.** Three risks for 9 gaps. No risk for: L6 streaming format differences, model catalog staleness, retry-to-middleware conversion breaking existing behavior, default client global state in tests, provider profile migration breaking the agent loop, or manager loop child state isolation. The Claude draft identifies 7 risks; the Codex draft identifies 5. Gemini's 3 risks are too few for the scope attempted.

### Gaps in Risk Analysis

- **No risk for middleware breaking existing behavior.** Converting from direct adapter calls to a middleware chain could subtly change timing, error propagation, or streaming behavior. This is the highest-risk migration in the sprint.
- **No risk for L6 streaming protocol differences.** Chat Completions uses `data: [DONE]` termination; Responses API uses `response.completed`. Getting this wrong corrupts every streaming call to third-party providers.
- **No risk for manager loop + LLM client interaction.** If the manager loop's child pipeline uses the same `UnifiedClient` instance, middleware state (retry counts, rate limit tracking) could bleed between parent and child. No isolation strategy is described.
- **No risk for scope overrun.** 9 gaps across 2 subsystems with 4 phases and no cut-line. The most likely outcome is partial delivery of everything rather than complete delivery of anything.

### Missing Edge Cases

- Middleware that throws during streaming (after partial content delivery)
- Model catalog lookup for a model that exists under multiple providers
- OpenAI-compatible adapter connecting to an endpoint that doesn't support tool calling
- Manager loop child that uses a different LLM provider than the parent
- Rate limit headers with non-standard formats from third-party providers (L6 endpoints)
- `set_default_client()` called from multiple threads/async contexts

### Definition of Done Completeness

Insufficient:
- Only 6 DoD items for 9 gaps — several gaps have no specific acceptance criteria
- No build/regression gate
- No backward compatibility assertion
- No test count expectation
- "All 8 Unified LLM gaps are fully implemented and unit-tested" is not verifiable without sub-criteria
- Manager loop DoD is a single sentence — contrast with Codex's 12 specific DoD items

---

## Recommendations for the Final Merged Sprint

### 1. Scope: Choose one subsystem, not both

The three drafts represent three scope philosophies:
- **Codex:** All engine, no client
- **Gemini:** All client + some engine
- **Claude:** All client (minus L6), no engine

The evidence favors **one focused subsystem per sprint.** The compliance report ranks L1 (Middleware) and L3 (Model Catalog) as the two highest-priority gaps overall. Sprint 015's own recommendation says the LLM client is "the obvious next target for spec closure." The Claude draft's argument for why L6 should be deferred is persuasive.

**Recommendation:** Sprint 016 should focus on the LLM client (L1-L5, L7-L8), deferring L6 and all engine gaps. Sprint 017 should focus on the engine (A1, A2, A3), using Codex's architecture as the blueprint.

### 2. Architecture: Use Claude's LLM design + Codex's engine design

- **For LLM work (Sprint 016):** The Claude draft's middleware architecture (interface definition, chain composition, streaming generator pattern, retry-as-middleware conversion) is the most complete and implementable. The model catalog design with logical selectors and the "advisory not a gate" principle is sound. Use it.
- **For engine work (Sprint 017):** The Codex draft's manager loop architecture (telemetry namespace, filesystem control plane, restart semantics, tool hook contract) is far more detailed than Gemini's. Use it as the Sprint 017 blueprint, but add a cut-line and address the missing edge cases.

### 3. From Gemini: Adopt L6 as its own sprint or pair with A1

Gemini is the only draft that addresses L6 (OpenAI-compatible adapter). It's a real gap. But it deserves focused attention — the streaming protocol differences, tool call format translation, and provider-specific quirks across Ollama/vLLM/Together/Groq are non-trivial. Options:
- **Sprint 018: L6 + any remaining low-severity gaps**
- **Bundle L6 with A1 in Sprint 017** (as the Claude draft recommends — both are "new capabilities")

### 4. Strengthen the DoD

The final sprint should adopt the Claude draft's DoD structure:
- Explicit build/regression gates
- Per-gap acceptance criteria (not one line per 9 gaps)
- Test count expectation (50+ new test cases for 7 LLM gaps)
- Backward compatibility assertions
- Cut-line with explicit priority ordering

### 5. Address missing risks from all drafts

The final sprint should include these risks regardless of scope:
- **Streaming middleware complexity** (Claude and Codex both flag this; Gemini ignores it)
- **Retry-to-middleware conversion behavioral regression** (Claude flags; others ignore)
- **Provider profile migration breaking agent loop** (Claude flags; others ignore)
- **Default client global state in tests** (Claude flags; others ignore)
- If engine work is included: **restart loops**, **child dotfile circular references**, **control file race conditions** (all missing from Codex)

### 6. Codex-specific improvements for Sprint 017

When the engine sprint happens, the Codex draft should be amended with:
- A cut-line (cut tool hooks first — A3 is low severity; A1 is the priority)
- Restart chain depth limit (prevent infinite `loop_restart` cycles)
- Child graph recursion depth limit (prevent circular `stack.child_dotfile`)
- Explicit atomic file operation mechanism for control files (rename-into-place)
- Hook timeout configuration with clear defaults
- Build/regression gates in the DoD
- Backward compatibility assertions (old pipelines without new attributes still work)
- Test count expectation

### 7. Gemini-specific feedback

The Gemini draft would benefit from:
- 3-4x more architectural detail — interface definitions, data flow diagrams, resolution rules
- Test files in the Files Summary
- Per-gap DoD items (not one blanket assertion)
- A cut-line with explicit priority ordering
- At least 5-7 risks for a 9-gap sprint
- Acknowledgment that 9 gaps across 2 subsystems is a scope risk

---

## Final Verdict

| Draft | Scope Discipline | Architecture Quality | Risk Analysis | DoD Quality | Overall |
|-------|-----------------|---------------------|---------------|-------------|---------|
| Codex | Good (focused) | **Excellent** | Good | Fair | **Strong** |
| Gemini | Poor (too broad) | Insufficient | Poor | Poor | **Needs rework** |
| Claude | Good (focused) | **Excellent** | **Excellent** | **Excellent** | **Strong** |

**Recommended merge strategy:** Use the Claude draft as the Sprint 016 base (LLM client focus). Reserve the Codex draft as the Sprint 017 blueprint (engine focus), adding the missing edge cases and cut-line. Incorporate Gemini's L6 recommendation into Sprint 017 or Sprint 018.
