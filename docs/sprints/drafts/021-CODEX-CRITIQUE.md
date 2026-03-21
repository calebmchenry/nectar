# Sprint 021 Draft Critique — Codex Review

**Drafts reviewed:** NEXT-CLAUDE-DRAFT.md, NEXT-GEMINI-DRAFT.md
**Reviewer perspective:** Codex (NEXT-CODEX-DRAFT.md as baseline)
**Date:** 2026-03-21

---

## Claude Draft: Strengths

1. **Exceptional architectural depth.** The analysis prompt design section (lines 150–160) explicitly addresses what is and isn't sent to models, caps token cost, and justifies the single `generateObject` call design. No other draft does this.

2. **Synthesis algorithm is fully specified.** The three-tier consensus/majority/divergence logic (lines 166–171) is concrete enough to implement without ambiguity. Both other drafts gesture at synthesis but don't define the algorithm.

3. **Cut line is well-calibrated.** Synthesis endpoint and within-column reordering are correctly identified as cuttable, while seed creation, Kanban, drag-and-drop, and analysis file writing are protected. This matches the actual dependency graph.

4. **GAP-7 and GAP-8 inclusion is pragmatic.** These are trivial, independently testable, and closing them now avoids a future cleanup sprint. The phase allocation (~5%) is honest about their size.

5. **Comprehensive use cases.** Ten use cases covering happy paths, missing providers, provider failures, archival, and page reload. The "Handle missing providers gracefully" and "Handle provider failures gracefully" cases (UC 7–8) are particularly valuable for driving test design.

6. **Module layout is detailed and realistic.** Every new file is named, located, and purpose-described. The test layout mirrors the source layout. This is directly executable by an implementer.

7. **Risk table is the most thorough of any draft.** Eight risks with likelihood/impact/mitigation, including stale `running` recovery on restart and SSE hang leakage from Sprint 020.

## Claude Draft: Weaknesses

1. **Does not address Sprint 020 regressions.** The git status shows five currently failing tests from Sprint 020 (SSE hangs, draft stream termination, pipeline event timing). The Claude draft assumes these are fine and mentions them only as a Phase 5 regression check. Building live seed/analysis SSE updates on top of a broken stream layer is risky. The Codex draft correctly gates Phase 0 on fixing these.

2. **UI effort estimate is optimistic.** Phase 4 is labeled ~50% but covers 10 new components, native drag-and-drop, live SSE subscriptions, URL state management, attachment upload UX, and the full SwarmCompare panel. This is probably closer to 55–60% when accounting for CSS, edge cases, and cross-component wiring.

3. **No `AnalysisDocument` validation contract.** The draft says "validate required fields" but doesn't specify what happens when an analysis file on disk is malformed (e.g., hand-edited or corrupted). Should the UI show a degraded card? Should the synthesis endpoint skip it? This edge case matters because the filesystem is the source of truth and users can edit files directly.

4. **`WorkspaceEventBus` is underspecified.** It's listed in the module layout and risk table but there's no discussion of its API surface, event schema, or how it composes with the existing file-watch layer in `routes/events.ts`. The Codex draft provides more detail here.

5. **No discussion of concurrent analysis + edit races.** What happens if a user edits a seed's title while analysis is in-flight? The `SeedStore` serialization is mentioned but the interaction between user-driven `meta.yaml` patches and analysis-driven `analysis_status` patches isn't explicitly resolved.

6. **Missing `include_attachments` parameter on analyze endpoint.** The Codex draft includes this; the Claude draft's API contract omits it. This matters for cost control — users should be able to trigger text-only analysis without sending image attachments.

---

## Gemini Draft: Strengths

1. **Ambitious compliance scope.** Tackling all 8 gaps in one sprint would bring the compliance report to zero remaining gaps. This is the only draft that attempts full spec closure.

2. **OpenAI-compatible adapter is well-motivated.** Use Case 1 (local Ollama execution) is a real user need that neither other draft addresses. The adapter unlocks vLLM, Together AI, and other third-party endpoints.

3. **Sub-pipeline composition is architecturally interesting.** The `CompositionTransform` concept (AST merging with edge rewiring) is the right abstraction for modular pipeline definitions. This is the hardest remaining gap and the draft at least names the key challenge (namespace collisions, entry/exit edge rewiring).

4. **Concise and focused.** At ~150 lines, the draft avoids bloat and stays on-topic. Every section serves a purpose.

## Gemini Draft: Weaknesses

1. **Scope is far too large for a single sprint.** Eight gaps spanning three specs, four new tool implementations, a new adapter, a transform registry, and AST merging is easily 2–3 sprints of work. The draft provides no phase effort estimates, no cut line, and no prioritization within the gap list.

2. **No UI work at all.** INTENT.md explicitly describes the Seedbed and Swarm Intelligence as two of Nectar's three product pillars. The Gemini draft defers all product-facing work indefinitely in favor of spec compliance. This is the wrong priority ordering — users interact with the product, not the compliance report.

3. **Definition of Done is vague and incomplete.**
   - "All 8 gaps identified in the compliance report are resolved" — no testable criteria per gap.
   - "Agent loops cleanly abort when an ABBC pattern loops repeatedly" — ABBC is not a valid pattern description per the spec (patterns are length 1, 2, or 3 repeating the full window).
   - "Sub-pipelines can be embedded via DOT attributes and execute correctly" — no definition of "correctly."
   - No build verification criteria (does `npm run build` still work? does the binary compile?).
   - No regression criteria for existing functionality.

4. **Risk analysis is dangerously thin.** Only two risks listed:
   - Missing: provider API key management for the new adapter, backward compatibility of error hierarchy changes, interaction between new tools and existing provider profiles, test infrastructure for `web_search`/`web_fetch` (external API dependency), performance impact of transform registry on pipeline startup, and the very real risk that AST merging breaks existing graph validation.
   - The AST merging risk is acknowledged but the mitigation is absent.

5. **No use cases for half the gaps.** GAP-1 (AUDIO/DOCUMENT), GAP-2 (error subtypes), GAP-5 (custom transforms), and GAP-7 (tool limits) have no use cases. Without use cases, there's no way to validate that the implementation actually serves a user need.

6. **Gemini tools require external dependencies not resolved.** The draft acknowledges that `web_search` and `web_fetch` "may require deciding on a default external API provider" but doesn't make the decision. This is a blocking design question, not a footnote. Shipping tools that depend on unresolved external APIs is a recipe for a half-finished feature.

7. **No tests specified for most gaps.** The implementation section mentions tests for loop detection and composition transform but says nothing about test strategy for:
   - The OpenAI-compatible adapter (mock server? real Ollama?)
   - Error hierarchy changes (do existing error-handling tests still pass?)
   - AUDIO/DOCUMENT content types (no provider currently accepts these)
   - The four new Gemini tools

8. **Module layout assumes directories that don't exist.** `src/agent-loop/tools/` and `src/garden/transforms/` are new directories. The draft doesn't acknowledge this or discuss how they integrate with the existing tool registry and transform pipeline.

---

## Gap Analysis: What Both Drafts Miss

### Sprint 020 Stability

The git status shows modified test files and the Codex draft identified five failing Sprint 020 tests related to SSE stream hangs. **Neither the Claude nor Gemini draft gates new work on fixing these.** The Claude draft treats it as a Phase 5 regression check; the Gemini draft ignores it entirely. Any sprint that adds new SSE-dependent features (seed analysis progress, workspace events) must fix the existing stream reliability issues first.

### Analysis Prompt Engineering

Both drafts underspecify the actual prompt sent to providers. The Claude draft mentions "structured and bounded" but doesn't define the prompt template or token budget. The Gemini draft doesn't mention prompts at all (it doesn't include Swarm). The quality of multi-provider analysis depends entirely on prompt design — this deserves at least a sketch of the system prompt, the structured output schema fields, and the token cap strategy.

### Attachment Size Limits

Neither draft specifies maximum attachment sizes for the analyze endpoint. If a user uploads a 50MB PDF and checks "Analyze now," what happens? The Claude draft mentions "capped" content but doesn't define the cap. This needs a concrete number (e.g., 1MB total inline content, metadata-only beyond that).

### Error UX in the Browser

Both drafts describe what happens on the server when providers fail, but neither specifies the browser error UX beyond "show a failed card." What does the failed card look like? Is the error message shown? Is there a retry button on the card itself or only in the detail drawer? These details matter for the implementation.

### Accessibility

Neither draft mentions keyboard navigation for the Kanban board, ARIA roles for drag-and-drop, or screen reader support for analysis status updates. This is fine if explicitly deferred, but it should be called out.

---

## Definition of Done Completeness

| Criterion | Claude | Gemini |
|-----------|--------|--------|
| Testable per-feature acceptance criteria | Yes (19 checkboxes) | No (6 vague bullets) |
| Build verification | Yes (npm build + bun compile) | No |
| Regression coverage | Yes (garden workbench, existing tests) | No |
| Compliance gap closure criteria | Yes (GAP-7, GAP-8 specific) | Partial ("all 8 gaps resolved") |
| UI acceptance criteria | Yes (7 Seedbed UI items) | N/A (no UI) |
| Swarm acceptance criteria | Yes (8 items) | N/A (no Swarm) |
| Cut line defined | Yes | No |

**Verdict:** The Claude draft's DoD is production-ready. The Gemini draft's DoD would not pass a sprint review — it lacks testable criteria and has no build or regression gates.

---

## Recommendations for the Final Merged Sprint

1. **Use the Claude draft as the structural foundation.** Its phasing, module layout, API contracts, risk table, and Definition of Done are the most complete and implementable. The Codex draft's Phase 0 stability gate should be prepended.

2. **Adopt the Codex draft's Phase 0 (Sprint 020 stability fixes).** Gate all new SSE-dependent work on fixing the five failing tests. This adds ~15% effort but prevents building on a broken foundation. Adjust subsequent phase percentages accordingly.

3. **Keep GAP-7 and GAP-8 from the Claude draft.** These are trivial, independently testable, and belong here. Do not expand compliance scope beyond these two — the Gemini draft's attempt to close all 8 gaps in one sprint is unrealistic.

4. **Defer GAP-1 through GAP-6 to a dedicated compliance sprint.** The Gemini draft's scope is correct that these gaps matter, but wrong that they should be tackled alongside the Seedbed/Swarm product work. Plan a focused compliance sprint after the product surface is complete.

5. **Add `include_attachments` to the analyze endpoint.** The Codex draft's API contract is better here — explicit cost control for analysis requests.

6. **Specify the malformed analysis file behavior.** When `analysis/{provider}.md` exists but has invalid YAML or missing sections, the detail endpoint should return it with `status: "parse_error"` and the UI should show a degraded card. Don't silently skip it.

7. **Define a concrete attachment token budget.** Cap inline attachment content at 1MB (or equivalent token estimate) per analysis request. Metadata-only beyond that threshold.

8. **Carry the Gemini draft's OpenAI-compatible adapter as a future sprint candidate.** It's a real user need (local models, third-party endpoints) and should be the centerpiece of the next compliance sprint, not squeezed into this one.

9. **Add one sentence to the DoD about keyboard-accessible Kanban.** Even if full a11y is deferred, basic tab-order and Enter-to-select on cards should be a minimum bar.

10. **Include the Codex draft's `include_attachments` field and `seedbed/markdown.ts` module.** The Claude draft inlines Markdown handling into other modules; a dedicated module for seed Markdown parsing/rendering is cleaner and more testable.
