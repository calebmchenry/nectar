# Sprint 030 Merge Notes

## Source Materials
- **NEXT-CLAUDE-DRAFT.md** (Claude) — "Compliance Zero": all 33 gaps, tiered by runtime severity, detailed per-gap tasks
- **NEXT-CODEX-DRAFT.md** (Codex) — "Runtime Truthfulness": Attractor gaps 1–6 + SSE/runtime hardening, deeper architectural treatment of answer model and SSE lifecycle
- **NEXT-GEMINI-DRAFT.md** (Gemini) — "Spec Compliance & Engine Hardening": all 33 gaps in 3 phases grouped by spec boundary, concise and pragmatic

## What Was Taken From Each Source

### From Claude's Draft (Primary Structure)
- **Title, framing, and "why now" narrative** — Claude's "Compliance Zero" framing is the strongest because it names the exact deliverable (zero gaps) and ties urgency to concrete runtime bugs (silent wrong routing, Anthropic 400s, broken steering).
- **Tier-based phasing (A/B/C/D)** — Claude's severity-based ordering is better than Gemini's spec-boundary grouping because it ensures the runtime-breaking bugs (Gaps 1–3, 8, 9, 17, 18, 28) ship first regardless of which spec they belong to.
- **Per-gap task descriptions** — Claude provided the most detailed, actionable task list with specific file paths, code changes, and test assertions for all 33 gaps. These were adopted nearly verbatim.
- **Files summary table** — Claude's gap-to-file mapping was the most complete and accurate.
- **Execution strategy** — The two-agent parallelization suggestion (A takes Phases 1+2, B takes 3+4) came from Claude.
- **Risk table** — Claude's risk assessment was the most thorough with 8 specific risks.

### From Codex's Draft (Architectural Depth)
- **Answer model normalization architecture** — Codex provided the strongest treatment of Gap 4, introducing the "normalize at the boundary" principle with the full `Answer` interface shape including `selected_option`, `text`, and `source`. This was merged into Gap 4's task description and the key design decisions section. Claude and Gemini treated Gap 4 as a simple field addition; Codex recognized it as a schema migration that ripples through HTTP, CLI, stored files, and events.
- **Backward compatibility strategy** — Codex's explicit stance on legacy `selected_label` acceptance, old cocoon loading, and `parallel.results.<node_id>` fallback was more thorough than the other drafts. These compatibility requirements were folded into the relevant task descriptions and DoD items.
- **SSE lifecycle concerns** — While Sprint 029 already addressed SSE hardening, Codex's emphasis on deterministic stream closure informed the risk table entry for answer schema changes rippling into HTTP surfaces.
- **"Do not claim zero-gap compliance if non-runtime gaps remain"** — This honesty principle was added to Phase 5 verification.
- **Risk for answer schema ripple** — Added as the second risk in the table (High likelihood, High impact), directly from Codex's analysis.

### From Gemini's Draft (Pragmatic Scope)
- **Three-phase spec-boundary grouping as a cross-check** — While the final sprint uses Claude's severity tiers, Gemini's Attractor/Agent/LLM grouping was useful for verifying that no gaps were missed and that the phase boundaries make sense.
- **Provider interchangeability use case** — Gemini's Use Case 5 ("Provider Interchangeability") was a cleaner framing than what the other drafts offered. Its spirit is reflected in Use Cases 3 and 5 of the merged sprint.
- **Conciseness model** — Gemini's draft was the most concise. Where Claude's descriptions were verbose, Gemini's phrasing was used to tighten task descriptions.
- **"No new external dependencies" framing** — Gemini's explicit statement that all changes are internal refinements set the right tone for the Dependencies section.

## Key Synthesis Decisions

1. **All 33 gaps, not just Attractor 1–6.** Codex argued for deferring coding-agent-loop and unified-LLM gaps to focus on runtime truthfulness. Claude and Gemini both argued for closing all 33. The merge sides with the all-33 approach because: (a) most gaps are mechanical and cluster by file, (b) batching is genuinely cheaper than spreading across sprints, (c) previous sprints (025–029) already deferred these gaps and the debt is compounding, and (d) the tier-based phasing ensures runtime-breaking bugs ship first even if the sprint runs long.

2. **Severity tiers over spec-boundary phases.** Claude's A/B/C/D tiers organize by runtime impact. Gemini's phases organize by spec document (Attractor → Agent → LLM). The severity approach is better because a Gap like 28 (Anthropic message merging, from unified-llm-spec) is more urgent than Gap 5 (checkpoint logs, from attractor-spec). Spec-boundary grouping would put Gap 28 in the last phase.

3. **Answer model gets architectural treatment.** All three drafts acknowledged Gap 4, but only Codex designed the migration. The merged sprint adopts Codex's normalize-at-boundary approach and calls out backward compatibility for `selected_label`, `QuestionStore` persistence, and HTTP input.

4. **Sprint number is 030, not 002.** Gemini's draft used "002" which doesn't match the ledger. Corrected to 030.

5. **Phase gates from Claude, honesty principle from Codex.** Each phase ends with a targeted vitest gate (Claude's approach). Phase 5 includes Codex's principle: don't update the compliance report until code and tests prove each gap closed.

6. **No SSE rearchitecture.** Codex proposed significant SSE lifecycle work (`createFiniteSseStream` hardening, `RunManager.getContext` changes, failure event replay ordering). Sprint 029 already targeted SSE hardening. The merged sprint does not duplicate that work — SSE is out of scope unless a gap specifically requires it.
