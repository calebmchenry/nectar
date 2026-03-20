# Sprint 006 Merge Notes

**Merged by:** Claude (Opus 4.6)
**Date:** 2026-03-19
**Output:** `docs/sprints/SPRINT-006.md`

## Foundation Decision

All three critiques (Claude, Gemini, Codex) unanimously recommended the Claude draft (Unified LLM Client) as the foundation. The strategic argument was decisive: GAP-50 at ~5% is the critical-path blocker for the Coding Agent Loop, Manager Loop, Swarm Intelligence, and Context Fidelity summary modes. The Gemini draft's features (stylesheets, subgraphs, fidelity transforms) are valuable but don't unlock new capabilities — they're structural polish that can wait.

## What Was Taken from Each Source

### From Claude Draft (primary foundation — ~70% of final)

- **Overall structure, architecture, and content model** — the provider adapter pattern, content model types, module layout, and phased implementation plan form the spine of the final sprint.
- **Priority tiers** — the tiered cut-line approach was praised by all reviewers. Preserved with adjustments (see below).
- **Zero-dependency approach** — Node.js 22 built-in `fetch` only. Universally praised.
- **Retry as middleware** — `withRetry()` pattern kept intact.
- **Streaming as async iterables** — kept intact.
- **Use cases 1-6** — adapted with minor edits.
- **Risk table** — expanded with items from critiques.

### From Gemini Draft (targeted cherry-picks — ~5% of final)

- **Fidelity validation fix** — The Gemini draft correctly identified that `fidelity_valid` should check string enums (`full`, `truncate`, `compact`, `summary:*`) not numeric ranges. This is a cheap, high-value correctness fix that was added as Phase 6. All three critiques endorsed pulling this forward.
- **Nothing else.** The stylesheets, subgraph scoping, and preamble transforms are deferred to Sprint 007+. The Codex critique correctly noted that the preamble transform has an architectural issue (it's execution-time, not parse-time) and that `summary:*` modes can't be meaningfully implemented without the LLM client this sprint builds.

### From Claude Critique (~10% of final)

- **Tighten Tier 1 scope** — Moved OpenAI from "must ship" to "should ship" (Tier 2). Tier 1 is now achievable with one production adapter. This was the critique's strongest recommendation.
- **Add request timeout** — `timeout_ms` on `GenerateRequest` with sensible defaults. Added to Phase 2 (retry middleware) and the DoD.
- **Sharpen tool execution boundary** — Single-turn tool execution was removed from scope entirely and deferred to the Coding Agent Loop sprint. The critique correctly identified that tool execution absorbs agent concerns (validation, error semantics, round limits, security).
- **Backward compatibility DoD item** — Added explicit criterion that existing pipelines work identically.
- **Defer image ContentPart translation** — Type defined, no adapter implementation.
- **Incorporate fidelity validation fix** — endorsed the Gemini draft cherry-pick.

### From Gemini Critique (~5% of final)

- **Reduce scope further** — Reinforced the Tier 1 tightening. Suggested Anthropic-only as Tier 1.
- **`stop_reason` normalization** — Added `StopReason` type and normalization as a DoD criterion. The critique correctly noted this was missing from the Claude draft.
- **`max_tokens` exceeded behavior** — Addressed via `StopReason` normalization.

### From Codex Critique (~10% of final)

- **"GAP-50 foundation, not complete GAP-50"** — The framing adjustment is reflected in the Overview ("explicitly a GAP-50 foundation sprint") and the risk table ("Sprint ships partial GAP-50" is listed as certain/intentional). This was the Codex critique's most valuable contribution.
- **Explicit provider error behavior** — Added Use Case 7 and DoD criterion: requesting an unconfigured provider raises `InvalidRequestError`, not silent fallback.
- **Migration churn risk** — Added to risk table. The move from string responses to structured content parts affects downstream consumers.
- **Partial spec coverage acknowledgment** — Out-of-scope section now explicitly lists `DEVELOPER` role and `provider_options` as "noted future spec alignment items."
- **Manual smoke test as acceptance criterion** — Moved from risk-table mitigation to a real DoD item.
- **Tool execution deferred** — Codex critique reinforced that single-turn tool loops absorb Coding Agent Loop concerns. Removed from scope.

## What Was Deliberately Excluded

| Excluded item | Source | Reason |
|---|---|---|
| Gemini adapter | Claude draft Tier 2 | Demoted. Two production adapters is the goal; Gemini comes in Sprint 007 alongside the Attractor cleanup. |
| Single-turn tool execution in codergen | Claude draft Phase 6 | Three critiques flagged scope creep into agent territory. Deferred to Coding Agent Loop sprint. |
| Stylesheets, subgraphs, default blocks | Gemini draft | Structural polish, not capability-unlocking. All three critiques agreed to defer. |
| Context fidelity transforms | Gemini draft | `summary:*` modes require the LLM client being built here. `truncate`/`compact` are parser-level work with no current runtime consumer. |
| `generate_object()` / structured output | Claude draft out-of-scope | Not blocking any current feature. |
| Middleware/interceptor extensibility | Claude draft out-of-scope | Premature. Retry is the only middleware needed. |
| `image` ContentPart adapter translation | Claude critique suggestion | Type defined for forward compatibility, but no use case this sprint. |
| Logging/observability for LLM calls | Claude critique "missing from both" | Valuable but not blocking. Can be added incrementally. |
| Cost estimation | Claude critique "missing from both" | Nice-to-have. Token counts in `Usage` provide the raw data; display is a CLI concern. |
| Token counting utilities | Gemini critique suggestion | Useful for future fidelity work but not needed by this sprint's scope. |

## Sprint Numbering

The drafts self-labeled as "Sprint 005" but `SPRINT-005.md` already exists. The merged sprint is numbered **006** based on the filesystem (SPRINT-001 through SPRINT-005 exist). The ledger at `docs/sprints/ledger.tsv` appears out of date — it only lists Sprint 001.
