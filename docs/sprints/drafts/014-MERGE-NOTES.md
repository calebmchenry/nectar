# Sprint 014 Merge Notes

## Base Draft: Claude (LLM Client SDK Hardening)

The Claude draft was selected as the base for the final sprint. It provided the strongest gap selection rationale, the most detailed architecture, the most thorough Definition of Done (~45 items), and the best risk analysis.

## What Was Taken From Each Draft

### From Claude Draft (primary source — ~90% of final)
- **Gap selection (L2, L4, L10, L11, L20)** — adopted in full. The dependency-chain argument (L20→L11→L10/L2, L4→Swarm) was the most compelling of any draft.
- **All five implementation phases** — adopted with minor additions.
- **Architecture sections** — adopted verbatim: `ProviderOptions` typed interfaces, Anthropic beta header auto-injection, `ThinkingData.signature` round-trip, `injectCacheBreakpoints()` with 3-breakpoint strategy, synthetic `__structured_output` tool pattern for Anthropic, `generateObject<T>()` with retry, `streamObject<T>()` as deferrable Phase 5.
- **Definition of Done** — adopted in full with one addition from the critique (Gemini graceful degradation).
- **Risk table** — adopted in full.
- **Cut-line** — adopted: defer `stream_object()` if sprint runs long; never defer L2/L10.
- **Files summary** — adopted in full (15 files).
- **Out-of-scope rationale** — adopted, particularly the L9 exclusion reasoning.

### From Claude Critique (refinements)
- **L2/A5 dependency argument** — incorporated into the "Why this sprint, why now" section. The critique identified that the Codex fidelity draft's `full` thread reuse (A5) depends on L2 being done. This strengthened the case for LLM hardening first and was added as explicit text: "the fidelity sprint's `full` thread reuse (A5) depends on L2 being done to work correctly with Anthropic thinking."
- **Sprint 015 recommendation** — the critique's recommendation to use the Codex draft largely as-is for the next sprint was added to the "Recommended next sprint" section.
- **Gemini schema restrictions** — the critique flagged this as a missing risk in the Gemini draft. It was already in the Claude draft's risk table but was also added as an explicit DoD item ("graceful degradation for schemas exceeding Gemini's JSON Schema subset") and noted in the Architecture section.

### From Codex Draft (deferred to Sprint 015)
- **No content merged into Sprint 014.** The Codex draft targets a completely different layer (attractor engine fidelity: A4/A5/A3/A8/A10/C3) and was unanimously recommended for the following sprint.
- **Acknowledged as excellent architecture** — the sprint document explicitly recommends the Codex draft's architecture for Sprint 015, per the critique's assessment.

### From Gemini Draft (selective rejection)
- **L4 structured output concept** — confirmed the approach. Both Claude and Gemini drafts proposed the same Anthropic synthetic-tool pattern and the same Gemini `responseMimeType`/`responseSchema` mapping. The Claude draft's version was more detailed and was used.
- **L7 (Middleware) — excluded.** The critique correctly identified that middleware is orthogonal and not load-bearing for any product feature. Spending 20% of the sprint on middleware while L2 (correctness) exists was called a "prioritization error."
- **L9 (High-level `generate()` tool loop) — excluded.** The agent-loop already handles tool loops. The Claude draft and critique both argued this creates duplicate code paths and confusion. The Gemini draft didn't address why a second tool loop is needed when one already exists.
- **L10/L11 treatment — rejected as too sparse.** The Gemini draft mentioned caching and beta headers in scope but provided only 2 bullet points for Phase 4. The Claude draft's detailed `injectCacheBreakpoints()` specification and beta header auto-injection logic were far more implementable.
- **Definition of Done — rejected (8 items vs 45+).** The critique correctly identified this as insufficient: no regression guards, no build assertions, no provider-specific correctness items, no streaming items, no error handling items.

## Key Decisions

1. **LLM client before fidelity.** The critique's strongest argument: L2 is a prerequisite for correct A5 implementation. Doing fidelity first creates a hidden landmine.
2. **Typed `ProviderOptions` over `Record<string, unknown>`.** Claude draft's approach catches misspellings at compile time. The Gemini draft proposed generic records.
3. **No middleware this sprint.** Clean scope: 5 tightly coupled gaps, no orthogonal work.
4. **No duplicate tool loop.** L9 excluded because the agent-loop already provides this functionality.
5. **`stream_object()` is deferrable but included.** Covers the full spec, but the cut-line explicitly allows dropping it if time is tight.
