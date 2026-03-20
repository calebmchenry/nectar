# Sprint 005 Merge Notes

## Foundation Selection

**Selected:** NEXT-CLAUDE-DRAFT (Unified LLM Client) as the foundation for Sprint 005.

**Rationale:** All three critiques (Claude, Gemini, Codex) unanimously recommend the Claude draft as the foundation. The Gemini draft's own Context Fidelity feature acknowledges it is blocked by the LLM client. The Codex critique put it well: "The current repo still has a generate-only Anthropic client... that makes the Claude draft directionally right about a real blocker."

## What Was Taken from Each Draft

### From NEXT-CLAUDE-DRAFT (Claude — Unified LLM Client)
- **~90% of the final sprint.** The architecture, content model, adapter pattern, error taxonomy, retry middleware, all three adapter specs, UnifiedClient design, and codergen integration were adopted as the foundation.
- Module layout, file summary, and dependency analysis carried over directly.
- The tiered priority system provided the framework, though tier assignments were adjusted based on critique feedback.
- `StopReason` normalization (added based on Gemini critique) was integrated into every adapter phase.

### From NEXT-GEMINI-DRAFT (Gemini — Pipeline Styling, Scoping, Context Management)
- **Deferred entirely to Sprint 006+.** The features (GAP-06 stylesheets, GAP-07 context fidelity, GAP-13 defaults, GAP-14 subgraphs) are valuable but not on the critical path.
- The pragmatic decision to stub `summary:*` modes validated the dependency ordering — you need the LLM client before context fidelity can be fully realized.
- The transform pipeline architecture (`expandGoalVariables` → `applyModelStylesheet` → `applyPreambleTransform`) is a good design that will be adopted when these features are implemented.

### From NEXT-CLAUDE-CRITIQUE
Drove several specific improvements:

1. **`StopReason` normalization:** Identified that the Claude draft lacked stop reason normalization. Added `StopReason` type and mapping tasks in every adapter phase.
2. **Token limit risk:** Flagged model-specific token limit variance. Added risk entry clarifying client passes `max_tokens` through rather than enforcing limits.
3. **Tool refusal/hallucination:** Asked about `tool_choice: 'required'` edge cases. Added risk entry for tool name validation.
4. **Scope reduction signal:** Recommended limiting Tier 1 to Anthropic-only. While the final sprint kept the multi-tier structure, this influenced moving OpenAI to Tier 2.
5. **Strategic confirmation:** Strongest endorsement of the Claude draft as foundation. Reasoning about the Gemini draft's `summary:*` stub proving the dependency was particularly clear.

### From NEXT-GEMINI-CRITIQUE (reviewing the same drafts)
Reinforced the Claude critique's recommendations and added:

1. **Extreme scope warning:** Called three full adapters "a massive undertaking." This reinforced the decision to move OpenAI and Gemini to Tier 2.
2. **`stop_reason` normalization (also identified independently):** Specifically flagged `max_tokens` vs `stop_sequence` vs `end_turn` normalization as a missing DoD item.
3. **Disjointed scope concern on Gemini draft:** Noted stylesheets and context fidelity are conceptually unrelated, strengthening the case to defer the entire Gemini draft scope.

### From NEXT-CODEX-CRITIQUE
The Codex critique was the most architecturally thorough and drove the most significant changes to the final sprint:

1. **"GAP-50 foundation sprint" framing:** Insisted the sprint should explicitly acknowledge it is partial GAP-50, not the full spec. This was the single most impactful feedback — the Overview and DoD now state this plainly.

2. **Single-turn tool loop moved to Tier 3:** The Codex critique argued persuasively that tool execution "starts absorbing concerns from the Coding Agent Loop spec: tool validation, error-return semantics, round limits, and security." Moved from Tier 1 to Tier 3 to keep the sprint focused on the transport layer.

3. **Explicit provider-missing behavior:** Identified that the original draft didn't specify what happens when `provider="openai"` is set but `OPENAI_API_KEY` is absent. Added: explicit provider = no silent fallback, throws `InvalidRequestError` with clear message. This also addresses the "silent simulation fallback is risky" concern.

4. **Request timeout/abort semantics:** Added `timeout_ms` to `GenerateRequest` with defaults (120s generate, 300s stream). Added to Phase 2 retry middleware and DoD.

5. **Migration churn risk:** Flagged that moving from string responses to structured ContentPart affects codergen behavior, status persistence, streaming writes, and checkpoint semantics. Added as a risk entry and backward compatibility DoD section.

6. **Spec drift risk:** Added explicit risk entry acknowledging that some upstream DoD items remain open even after a successful sprint.

7. **Usage accounting inconsistencies:** All `Usage` fields now default to 0, and adapters populate what's available. Added as risk entry.

8. **Manual smoke test as acceptance criterion:** Elevated from a risk mitigation idea to a required DoD acceptance step.

9. **Edge cases for tool loop (Tier 3):** If tool loop is implemented, must handle: malformed JSON arguments (error tool_result), unknown tool names (error tool_result), multiple tool calls in one response (execute all before callback). Added to Phase 6 tasks.

10. **Lazy key validation:** Added design decision — `from_env()` does not validate keys eagerly. Invalid keys surface as `AuthenticationError` on first use.

11. **Graceful usage normalization:** Added design decision — partial/missing usage metadata from providers never crashes consumers.

## What Was Not Taken and Why

- **Codex's suggestion to add all 5 roles:** The upstream spec defines `developer` as a 5th role. Deferring — it's only meaningful for OpenAI compatibility, and `system` covers the same semantics for Anthropic and Gemini. Adding it is trivial when needed.

- **Codex's suggestion for a provider-options escape hatch:** A passthrough bag for provider-specific options. Premature — we don't have a use case that requires it yet, and it weakens the type system. Can be added when a real need emerges.

- **Claude critique's recommendation to keep OpenAI in Tier 1:** The final sprint moved OpenAI to Tier 2 based on the combined weight of the Codex critique ("scope is still too large") and Gemini critique ("Extreme scope"). One production adapter proves the architecture; two is validation, not foundation.

- **Gemini draft's CSS parser for model stylesheets:** Deferred to Sprint 006+. The Codex critique specifically warned against adding parser rewrites to a sprint already replacing the LLM subsystem.

- **Gemini draft's fidelity validation fix:** The Claude critique recommended pulling this in as a small correctness fix. Ultimately deferred — it's a validator change that's more natural alongside the full fidelity implementation.

- **Claude critique's recommendation for SimulationProvider determinism:** Worth doing but not critical for this sprint. SimulationProvider already produces consistent-enough output for testing. Can be tightened in a follow-up.

## Tier Restructuring Rationale

The original Claude draft had: Tier 1 = Anthropic + OpenAI, Tier 2 = Gemini, Tier 3 = polish.

The final sprint has: Tier 1 = Anthropic only, Tier 2 = OpenAI + Gemini, Tier 3 = tool loop + polish.

This change was driven by:
- **Codex critique:** "The scope is still too large for one sprint" + tool loop "starts absorbing concerns from the Coding Agent Loop spec"
- **Gemini critique:** "Reduce the Scope... to Tier 1 only: Core Types, Retry Middleware, and the Anthropic Adapter"
- **Pragmatic reasoning:** One adapter proves the architecture. The adapter pattern's value is validated by the interface contract and tests, not by having two implementations in the same sprint.
