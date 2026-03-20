# Sprint 002 Merge Notes

## Synthesis Summary

The final sprint document merges ideas from the Claude draft, Gemini draft, and both critiques (Claude and Gemini). Both critiques independently converged on the same core recommendation: **adopt Claude's breadth with a scoped-down version of Gemini's LLM client**.

---

## What Was Taken From Each Source

### From Claude Draft
- **Bug fixes first (Phase 1).** Claude's draft was the only one that addressed Sprint 001 debt (parse test node count, engine test timeout). Both critiques praised this. Adopted as-is.
- **Simulation mode for codergen.** Critical for CI and local dev without API keys. Gemini's draft had no offline story. Adopted and elevated to a first-class `SimulationProvider` implementing the same interface as the real provider.
- **Conditional handler (diamond shape).** Gemini's draft omitted this entirely. Both critiques flagged it as a cheap win that unlocks branching pipelines. Adopted as-is.
- **AST transform pipeline.** Claude proposed `parse → transform → validate` with `$goal` expansion as a proper transform rather than a handler-level hack. Both critiques agreed this is architecturally correct. Adopted over Gemini's in-handler approach.
- **Comprehensive validation rules (8 rules).** Gemini's draft had zero validation work. Claude's Phase 4 validation rules were adopted nearly verbatim, with the addition of specific error vs. warning classifications.
- **Phase effort percentages.** Useful for progress tracking. Adopted with adjustments to reflect the merged scope.
- **Run directory structure.** Both drafts described per-node artifact directories, but Claude's was more specific about `status.json` and `auto_status`. Adopted Claude's structure.

### From Gemini Draft
- **Real LLM client with Anthropic provider.** Gemini's biggest contribution: actually making API calls. Claude's draft deferred all real LLM work, which both critiques identified as the main weakness. Adopted Gemini's `AnthropicProvider` approach using direct `fetch` (no vendor SDKs).
- **Architecture section.** Gemini's module layout, key abstractions, and file summary table were praised by both critiques as invaluable during execution. Adopted the format, adapted the content to the merged scope.
- **Use cases.** Gemini's concrete user scenarios were adopted and expanded (added simulation mode and validation use cases).
- **Risk table.** Gemini was the only draft with a risk section. Both critiques called out Claude's lack of risk analysis. Adopted Gemini's format and expanded with risks identified in both critiques.
- **Files summary table.** Adopted format from Gemini, expanded to cover all merged scope.
- **`fetch` over vendor SDKs.** Both drafts agreed here; Gemini was more explicit. Adopted.

### From Claude Critique
- **Scope the LLM client to one provider.** The critique's top recommendation was to avoid Gemini's three-provider ambition and deliver one solid provider. Adopted: Anthropic only.
- **Defer wait.human and Interviewer.** Critique argued this is complex and not needed until human-in-the-loop pipelines. Adopted.
- **Defer tool calling.** Text-in/text-out is sufficient for MVP. Adopted.
- **Strengthen the Definition of Done.** Critique provided a specific, testable DoD checklist. Adopted nearly verbatim, with additions for infinite loop protection and compliance report.
- **Edge cases.** Several edge cases from the critique were incorporated into Phase 2 and Phase 3 task descriptions (missing prompt attribute, non-existent retry_target, empty LLM response).

### From Gemini Critique
- **Infinite loop protection mandate.** Gemini's critique was strongest on this point: goal gate retries must respect `max_retries` and fail hard. Adopted as an explicit DoD item and risk mitigation.
- **API error handling.** Critique flagged missing HTTP 429/500 handling, timeouts, and missing API key scenarios. Adopted into Phase 2 tasks.
- **File system error handling.** Critique noted missing parent directory creation and disk-full scenarios. Added to Phase 5.
- **Single-provider recommendation aligned** with Claude critique — mutual reinforcement increased confidence in this scope decision.

---

## What Was Excluded and Why

| Item | Source | Reason for Exclusion |
|------|--------|---------------------|
| OpenAI provider | Gemini draft | Both critiques agreed: one provider first, expand later. Reduces sprint risk significantly. |
| Gemini provider | Gemini draft | Same as above. |
| Tool calling in LLM client | Gemini draft | Text-in/text-out sufficient for MVP. Tool calling adds substantial complexity (schema validation, execution loops). |
| Wait.human handler | Claude draft | Complex handler requiring Interviewer interface design. Not needed until human-in-the-loop pipelines. Deferred to Sprint 003. |
| Interviewer interface | Claude draft | Coupled to wait.human. Deferred together. |
| Accelerator key parsing | Claude draft | Mentioned without explanation in Claude draft. Both critiques ignored it. Low priority. |
| `allow_partial` node attribute | Claude draft | Minor feature not mentioned in critiques. Can be added incrementally. |
| Model Stylesheets | Both (out of scope) | Agreed by both drafts. |
| Parallel/fan-in handlers | Both (out of scope) | Agreed by both drafts. |

---

## Key Design Decisions

1. **Anthropic as first provider** — Project already uses Claude heavily; team has most familiarity with the API. Lower risk than OpenAI or Gemini as first integration.

2. **SimulationProvider as interface peer, not mock** — Rather than a test mock, simulation is a first-class `LLMClient` implementation. This ensures the interface is correct and simulation remains useful long-term for demos and CI.

3. **Transform pipeline as separate stage** — `$goal` expansion happens before validation, not inside handlers. This follows the spec's intended architecture and keeps handlers focused on execution.

4. **Errors vs. warnings in validation** — Structural invariants (reachability, start/exit constraints) are errors that block execution. Stylistic/advisory rules (missing prompts, missing retry targets) are warnings that allow execution to proceed.

5. **Phase prioritization** — P1-P3 are must-haves (bug fixes, LLM client, codergen, goal gates). P4-P5 are high-value but can be partially deferred if the sprint runs long. This gives a natural cut line.
