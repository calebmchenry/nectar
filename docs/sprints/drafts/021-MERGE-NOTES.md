# Sprint 021 Merge Notes

## Structural Foundation: Claude Draft

The Claude draft (`NEXT-CLAUDE-DRAFT.md`) was used as the structural foundation. Both critiques independently recommended this — the Codex critique called its phasing, module layout, API contracts, risk table, and Definition of Done "the most complete and implementable," while the Gemini critique praised its "comprehensive structure" and "scope efficiency."

Taken from Claude:
- Overall sprint narrative, scope justification, and "why now" framing
- Seedbed UI architecture (five-column Kanban, detail drawer, SwarmCompare panel)
- Swarm analysis flow diagram and analysis document contract
- Analysis prompt design (single `generateObject` call, structured + bounded)
- Synthesis algorithm (consensus/majority/divergence, no fourth model call)
- Module layout (all file locations and component names)
- Use cases 1–10 (UC 11 adapted from Codex's reload-mid-analysis scenario)
- GAP-7 and GAP-8 as Phase 1 compliance quick wins (~5% effort)
- Cut line calibration (synthesis endpoint cuttable, seed creation protected)
- Risk table structure (expanded with items from Codex and critiques)
- Definition of Done structure (30 testable checkboxes)
- Watercolor-botanical palette for Kanban column colors
- Dependencies table and explicit non-dependencies list

## Critical Addition: Codex Phase 0 (Stability Gate)

The Codex draft (`NEXT-CODEX-DRAFT.md`) contributed the single most important structural change: **Phase 0 — fixing Sprint 020's SSE stream regressions before building new streaming features.** Both critiques flagged this as non-negotiable. The Codex critique called the Claude draft's omission "technically irresponsible," and the Gemini critique agreed that "building new streaming features on broken streams" was the Claude draft's biggest weakness.

Taken from Codex:
- Phase 0: Stability Gate with specific file targets and five failing test references
- Design principle #1: "Fix before extending"
- SSE stability items in the Definition of Done (3 checkboxes)
- Phase effort rebalancing (Phase 4 reduced from ~50% to ~40% to accommodate Phase 0 at ~10%)
- `include_attachments` parameter on `POST /seeds/:id/analyze` for cost control
- Concrete JSON request/response examples for API contracts (especially the 202 response body)
- `src/seedbed/markdown.ts` as a dedicated module (Claude inlined Markdown handling)
- Use Case 3 (upload files after creation) and the explicit "Upload after creation" workflow
- Risk: "Sprint 020 SSE fixes take longer than estimated" with descoping mitigation
- WorkspaceEventBus detail: distinction between semantic events (primary) and file-watch (supplementary)
- `seed_created` and `seed_updated` event types (Claude only had analysis events)
- Atomic writes preservation for `meta.yaml` and `seed.md`

## Deferred: Gemini Draft (Full Compliance)

The Gemini draft (`NEXT-GEMINI-DRAFT.md`) proposed closing all 8 compliance gaps in a single sprint. Both critiques rejected this scope as unrealistic — the Codex critique called it "easily 2–3 sprints of work" with "no cut line and no prioritization." The Gemini critique noted the draft "defers all product-facing work indefinitely in favor of spec compliance" which "is the wrong priority ordering."

However, the Gemini draft contributed valuable future-sprint material:
- The OpenAI-compatible adapter (`/v1/chat/completions`) is noted in out-of-scope as a future compliance sprint candidate, per both critiques' recommendation
- Sub-pipeline composition and graph merging are similarly deferred with explicit mention
- The Gemini draft's use case for local model execution (Ollama) validated the adapter's importance for a future sprint

Nothing from the Gemini draft was taken for this sprint's implementation. Its scope belongs in a dedicated compliance sprint after the product surface is complete.

## Critique-Driven Improvements

Both critiques surfaced gaps that neither draft fully addressed:

| Improvement | Source | What changed |
|-------------|--------|-------------|
| Malformed analysis file handling | Codex critique | Added `parse_error` status for invalid YAML on disk; UI shows degraded card instead of silently skipping |
| Concrete attachment token budget | Both critiques | Added "1MB inline attachment cap" to analysis input policy (Claude said "capped" without a number) |
| `include_attachments` on analyze endpoint | Codex critique + Codex draft | Adopted from Codex; enables text-only analysis for cost control |
| Keyboard-accessible Kanban minimum bar | Codex critique | Added basic tab-order and Enter-to-select to SeedCard; full a11y deferred but called out in out-of-scope |
| Provider rate limiting risk | Gemini critique | Added risk row for concurrent provider requests with `Promise.allSettled()` isolation mitigation |
| Concurrent analysis + edit race resolution | Codex critique | Explicitly stated serialization per seed ID for user-driven and analysis-driven patches |
| Failed card error UX | Codex critique | Added "failed cards show error message and retry button" to SeedDetail drawer tasks |
| Stale running recovery in DoD | Both drafts | Promoted from risk mitigation to a Definition of Done checkbox |

## What Was Cut

- Gemini's GAP-1 through GAP-6 (AUDIO/DOCUMENT types, error subtypes, OpenAI adapter, Gemini tools, custom transforms, sub-pipeline composition) — too much scope, wrong priority
- Claude's ~50% Phase 4 estimate — reduced to ~40% to accommodate Phase 0 stability gate
- Gemini's `src/agent-loop/tools/` directory (list-dir, read-many-files, web-search, web-fetch) — deferred to compliance sprint
- Gemini's `src/garden/transforms/` directory (registry, composition) — deferred to compliance sprint
