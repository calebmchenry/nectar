# Sprint NEXT — Cross-Draft Critique

**Reviewer:** Claude
**Drafts reviewed:** Codex Draft (Fidelity Runtime & Run Artifacts), Gemini Draft (LLM SDK High-Level APIs & Structured Output)
**Context:** Claude's own draft (LLM Client SDK Hardening) also reviewed for contrast

---

## Codex Draft: Fidelity Runtime & Run Artifacts

### Strengths

1. **Correct strategic framing.** The argument that A4/A5 are the highest-leverage remaining attractor gaps is defensible — fidelity affects every multi-stage codergen workflow, not one specialty handler. The "why not manager-loop" reasoning is sound.
2. **Exceptional architecture depth.** The `ResolvedFidelityPlan`, `SessionRegistry`, `RunStore`, and `ArtifactStore` abstractions are well-designed with clear responsibilities. The data flow diagram from edge selection through session dispatch to artifact storage is the most complete architectural picture of any draft.
3. **Run directory layout is production-grade.** The canonical `.nectar/cocoons/<run-id>/` structure with `manifest.json`, `checkpoint.json`, `artifacts/`, and per-node directories is exactly what the spec calls for and what the future HTTP/UI layer needs.
4. **Migration strategy is pragmatic.** Dual-writing canonical and legacy checkpoint formats for one sprint avoids a breaking cliff while still moving forward. The "read canonical first, fall back to legacy" pattern is clean.
5. **Deterministic preamble budgets are well-specified.** Token targets for each fidelity mode (truncate, compact, summary:low/medium/high) give implementers concrete constraints rather than vague "keep it short" guidance.
6. **Resume degradation rule is precise.** "First resumed codergen hop after `full` → `summary:high`, then clear the marker" is unambiguous and testable.

### Weaknesses

1. **Phase 3 is overloaded at 35%.** It conflates session registry, preamble builders, codergen handler changes, tool handler changes, agent-loop session changes, and validation updates. This is realistically 2 phases of work crammed into one. If anything slips, this phase becomes the bottleneck.
2. **No mention of L2 (ThinkingData.signature).** The draft proposes `full` fidelity thread reuse where multi-turn Anthropic sessions round-trip thinking blocks. Without L2 (signature preservation), these sessions will silently break on the second turn for any node using `reasoning_effort`. This is a correctness dependency that isn't acknowledged.
3. **Preamble generation has no fallback for edge cases.** What happens when a `compact` preamble exceeds its budget because there are 50 completed nodes? The draft says "hard budgets" but doesn't specify truncation behavior when the budget is exceeded.
4. **`SessionRegistry` lifecycle under parallel execution is unspecified.** If two parallel branches share a `thread_key`, what happens? Concurrent `followUp()` calls on the same session? The draft says "run-scoped" but doesn't address concurrent access.
5. **The `truncate` mode is underspecified.** Only "graph goal, run ID, and minimal state" — but what exactly is "minimal state"? This is the vaguest of the preamble definitions.
6. **No discussion of the `AgentSession` API surface needed.** The draft assumes `submit()` and `followUp()` exist with the right semantics but doesn't verify whether the current implementation supports the session-reuse pattern (e.g., does `followUp()` actually append to conversation history? Can `reasoning_effort` be changed mid-session?).

### Gaps in Risk Analysis

- **Missing risk: L2 dependency.** As noted above, `full` fidelity thread reuse with Anthropic + reasoning_effort will produce 400 errors without thinking signature round-tripping. This is a medium-likelihood, high-impact risk that should block or be co-scheduled.
- **Missing risk: preamble quality.** Deterministic preambles are only useful if they carry the right information. There's no plan for evaluating preamble quality or iterating on the format — just "bias toward recent failures." A bad preamble is worse than no preamble because it wastes context window.
- **Missing risk: artifact ID collisions.** The draft doesn't specify how artifact IDs are generated. If they're UUIDs, fine. If they're content-hashed, duplicates need handling. If they're sequential, parallel writes could collide.

### Missing Edge Cases

- What if a `full`-fidelity node targets a provider that doesn't support multi-turn (hypothetical future provider)?
- What if checkpoint.json write fails mid-write (disk full, permissions)? The dual-write makes this worse — two files to keep consistent.
- What if the same `thread_key` appears in two different parallel branches running concurrently?
- What if a preamble references artifacts that were stored but the artifact files are later deleted or corrupted?

### Definition of Done Completeness

**Good coverage overall.** 17 items covering all major features. However:
- Missing: "Preamble token counts stay within specified budgets" — there's no DoD item that actually measures the budgets mentioned in Phase 3.
- Missing: explicit backward-compatibility assertion — "existing `nectar status` and `nectar resume` commands produce identical output for pre-migration cocoons."
- Missing: "Artifact IDs are deterministic/unique" — no DoD item on artifact identity.

---

## Gemini Draft: LLM SDK High-Level APIs & Structured Output

### Strengths

1. **Clean scope.** Four focused capabilities (middleware, provider_options, structured output, generate() tool loop) that form a coherent SDK enhancement layer.
2. **Middleware pattern is well-chosen.** `(req, next) => Promise<response>` is the standard fetch-interceptor shape. Familiar to TypeScript developers, composable, testable.
3. **Use cases are concrete and motivating.** "Swarm analysis with strict JSON" and "autonomous tool loops" directly connect to INTENT.md §2C-iii.

### Weaknesses

1. **Severely underspecified.** The draft reads more like a feature list than a sprint plan. Compare Phase 2 ("Define ResponseFormat type, Map to OpenAI/Anthropic/Gemini") to the Claude draft's Phase 2 which specifies exactly how the Anthropic synthetic tool pattern works, how response rewriting happens, and how streaming interacts. The Gemini draft would leave an implementer making dozens of unguided decisions.
2. **No L2 (ThinkingData.signature).** This is the same gap as the Codex draft but more consequential here — the Gemini draft is explicitly working on the LLM client layer and still misses the silent correctness bug in multi-turn thinking.
3. **No L10 (Anthropic prompt caching).** The draft mentions it in scope ("Integrated via the new options and middleware") but Phase 4 is labeled "Anthropic Prompt Caching (~20%)" and only has 2 bullet points. There's no specification of breakpoint injection strategy, no discussion of cache-control activation rules, and no interaction analysis with structured output.
4. **L9 (high-level `generate()`) is debatable scope.** The agent-loop already handles tool loops. Adding a second tool loop at the SDK layer creates two code paths doing the same thing. The Claude draft explicitly defers L9 for this reason. Including L9 while excluding L2 is a prioritization error — L2 is a correctness bug affecting every Anthropic call; L9 is a convenience API that duplicates existing functionality.
5. **The middleware implementation is mostly orthogonal.** L7 is a nice-to-have architectural improvement, but it doesn't unblock any product feature or fix any correctness bug. Spending 20% of the sprint on middleware while omitting L2 (correctness) and underspecifying L10 (cost savings) is a poor trade.
6. **Risk table is too sparse.** Only 3 risks for a sprint touching 3 provider adapters, adding a new middleware layer, and implementing tool loops. Where are the risks around: middleware ordering interactions, provider-specific structured output quirks (Gemini's schema subset restrictions), tool loop + streaming interaction, or generate() re-entrancy?
7. **Definition of Done has only 8 items** and they're all feature-existence checks ("supports adding middleware", "accepts response_format"). None are correctness assertions, behavioral contracts, or regression guards. Compare to Claude's 30+ DoD items with specific behavioral assertions.
8. **No Files Summary detail.** Only 8 files listed vs 15+ in the other drafts. No test fixtures, no error types, no simulation provider updates.
9. **No cut-line specified.** If the sprint runs long, what gets deferred? The other two drafts both have explicit cut-line guidance.

### Gaps in Risk Analysis

- **Missing risk: Gemini schema restrictions.** Gemini's `responseSchema` doesn't support `$ref`, complex `anyOf`, or `additionalProperties`. Schemas that work on OpenAI/Anthropic will silently produce garbage on Gemini. This needs a per-provider schema validation or graceful degradation strategy.
- **Missing risk: middleware + streaming interaction.** Can middleware intercept streaming responses? If so, how does the `next()` contract work for async iterators? If not, that's a significant limitation that should be documented.
- **Missing risk: generate() tool loop + abort signal.** What happens if the caller aborts mid-tool-loop? Does the current tool execution finish? Are partial results returned?
- **Missing risk: Anthropic synthetic tool interaction with caller tools.** If the caller provides tools AND response_format, the synthetic `__structured_output` tool must coexist. The Gemini draft doesn't address this.

### Missing Edge Cases

- What if `max_tool_rounds` is 0? Does `generate()` skip tool execution entirely or is it an error?
- What if middleware throws? Is the error surfaced to the caller or swallowed?
- What if the Anthropic API starts supporting native JSON mode? The synthetic-tool hack needs a migration path.
- What if `response_format` is `json_schema` but the model returns valid JSON that doesn't match the schema?

### Definition of Done Completeness

**Insufficient.** 8 items is not enough for a sprint touching middleware, structured output across 3 providers, tool loops, and prompt caching. Missing:
- No regression assertion ("existing generateUnified() behavior unchanged")
- No build assertion ("npm run build succeeds")
- No provider-specific correctness items (Anthropic synthetic tool rewriting, Gemini schema mapping)
- No error handling items (StructuredOutputError, middleware errors)
- No streaming items (streaming + structured output interaction)
- No caching correctness items (breakpoint injection, cache metrics reporting)

---

## Comparative Analysis

### Gap Selection

| Gap | Codex | Gemini | Claude |
|-----|-------|--------|--------|
| A3 (ArtifactStore) | Yes | — | — |
| A4 (Fidelity runtime) | Yes | — | — |
| A5 (Thread resolution) | Yes | — | — |
| A8 (CheckpointSaved) | Yes | — | — |
| A10 (manifest.json) | Yes | — | — |
| C3 (reasoning_effort mid-session) | Yes | — | — |
| L2 (ThinkingData.signature) | — | — | Yes |
| L4 (Structured output) | — | Yes | Yes |
| L7 (Middleware) | — | Yes | — |
| L9 (generate() tool loop) | — | Yes | — |
| L10 (Prompt caching) | — | Partial | Yes |
| L11 (Beta headers) | — | — | Yes |
| L20 (provider_options) | — | Yes | Yes |

**Observation:** Codex and Claude/Gemini target completely different layers (engine vs LLM client). Within the LLM client space, Claude's selection is tighter and more defensible: L2+L11+L20 form a dependency chain (L20 enables L11, L11 enables L2), L4 unblocks Swarm Intelligence, and L10 delivers immediate cost savings. Gemini's selection includes L7 and L9 (nice-to-haves) while omitting L2 (correctness bug) and L11 (required plumbing for L10).

### Sprint Priority Question

The fundamental question is: **engine fidelity (Codex) or LLM client hardening (Claude/Gemini)?**

Arguments for engine fidelity first:
- A4/A5 are the only medium-severity attractor gaps remaining
- Every multi-node codergen pipeline is affected
- The run directory layout benefits the future HTTP layer

Arguments for LLM client first:
- L2 is a silent correctness bug affecting every Anthropic reasoning call today
- L10 delivers measurable cost savings immediately
- L4 unblocks Swarm Intelligence (a product differentiator)
- The LLM client has 6 medium gaps vs the attractor's 2

The Claude draft's argument is stronger: fix the correctness bug and cost issue that affect every call today, then build fidelity on a correct foundation. Fidelity thread reuse (A5) actually needs L2 to work correctly with Anthropic thinking — doing A5 without L2 creates a hidden landmine.

---

## Recommendations for the Final Merged Sprint

1. **Use the Claude draft as the base.** It has the strongest gap selection rationale, the most detailed architecture, the most thorough DoD, and the best risk analysis. Its 5 gaps (L2, L4, L10, L11, L20) form a tight dependency cluster.

2. **Adopt the Claude draft's cut-line.** Defer `stream_object()` (Phase 5) if the sprint runs long. Ship `generate_object()` for non-streaming structured output, which covers the swarm analysis use case.

3. **Incorporate the Gemini draft's middleware section only if there's room.** L7 is clean and orthogonal but not load-bearing. If it delays L2/L10, cut it.

4. **Do not include L9 (high-level generate() tool loop).** The agent-loop already handles this. Adding a duplicate tool loop at the SDK layer creates confusion about which loop to use and doubles the bug surface.

5. **Defer Codex's fidelity work (A4/A5/A3/A8/A10) to the sprint after.** It's the right next step, but it depends on L2 being done (for correct `full` fidelity thread reuse with thinking). Use the Codex draft largely as-is for Sprint NEXT+1 — its architecture is excellent.

6. **Adopt the Claude draft's DoD structure.** Organized by feature area with specific behavioral assertions, not just "feature exists" checks. Add build/regression guards at the top.

7. **Merge the Gemini draft's Anthropic structured output specification with the Claude draft's.** Both describe the synthetic tool pattern, but the Claude draft has more detail on streaming interaction, response rewriting, and tool coexistence. Use Claude's as the base, verify against Gemini's for any missed edge cases.

8. **Add the Gemini draft's middleware middleware error-bubbling risk** to the final risk table if middleware is included. It's a real concern the Claude draft doesn't address (because it excludes L7).

9. **Ensure the final DoD includes at least 30 items.** The Gemini draft's 8 items is inadequate. The Claude draft's ~45 items is thorough. Target the Claude draft's level of specificity.

10. **Name the sprint "Sprint 014: LLM Client SDK Hardening"** per the Claude draft — it accurately describes the scope and continues the numbering convention.
