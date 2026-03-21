# Merge Notes — Sprint 035

## Source Drafts

- **NEXT-CLAUDE-DRAFT.md** — "Green Suite or Bust — Fix the Four, Close the Gaps"
- **NEXT-CODEX-DRAFT.md** — "Runtime Contract Closure — Outcome Truth, Session Accounting, and Error Recovery"
- **NEXT-GEMINI-DRAFT.md** — "Spec Convergence & Gap Closure"

## Critiques

- **NEXT-CLAUDE-CRITIQUE.md** — Reviewed Codex and Gemini drafts; recommended Codex as backbone
- **NEXT-CODEX-CRITIQUE.md** — Reviewed all three; recommended Claude's test-fix-first + Codex's audit
- **NEXT-GEMINI-CRITIQUE.md** — Reviewed Claude and Codex; recommended combining both

---

## What Was Taken From Each Draft

### From Claude Draft (primary structure)

- **Phase 1 test-fix-first hard gate** — adopted verbatim as the sprint's core structural decision. All three critiques unanimously endorsed this. The 4 failing tests, their root causes, and their prescribed fixes are taken directly from Claude's analysis.
- **Drop line** — adopted and refined. Claude was the only draft with an explicit priority ordering for scope cuts. The Codex and Gemini critiques both flagged this as a critical missing element in the other drafts.
- **Comprehensive Definition of Done** — Claude's per-gap checkbox pattern adopted. Strengthened with defensive items ("no skipped tests," "no inflated timeouts") that Codex critique specifically called out as missing from other drafts.
- **Use cases 1–6** — adapted from Claude with minor rewording.
- **Files summary pattern** — Claude's format (file, action, purpose) adopted for all phases.
- **Risk table structure and entries** — Claude's 8-risk format used as the baseline, with additions from critiques.

### From Codex Draft (architectural decisions)

- **Audit-first methodology** — adopted as the start of Phase 2. This was Codex's signature contribution and was endorsed by all three critiques as the most mature planning approach. Prevents wasted work on stale compliance gaps.
- **Design decisions section** — Codex's five explicit architectural stances adopted nearly verbatim: canonical `status.json` ownership, unqualified-to-context fallback with reserved-root precedence, lifetime session limits, recovery-over-shutdown for ContextLengthError, additive-change posture.
- **ContextLengthError recovery model** — Codex's specific model ("fail work item, emit warnings, return to AWAITING_INPUT") chosen over Claude's vaguer "continue if possible" and Gemini's "gracefully continue or abort." The Codex critique confirmed this was the only testable recovery specification.
- **Principled scoping** — Codex's distinction between behavioral-impact gaps and cosmetic/shape gaps used to filter the scope to ~11 gaps instead of Claude's 16 or Gemini's 20.
- **Subagent tool completion coverage (C5)** — Codex was the only draft that extended full_content to subagent tool calls. Adopted.
- **`codergen` status.json consolidation** — Codex's stance that codergen should stop writing a conflicting `status.json` adopted for A2.
- **Turn-limit exhaustion policy** — Codex's explicit state machine (emit event → fail work item → reject subsequent work) adopted over Claude's less-specified version.

### From Gemini Draft (limited)

- **Gap inventory as reference** — Gemini's comprehensive mapping of all 20 gaps was useful for ensuring nothing was accidentally overlooked during scoping decisions, even though the "close all 20" scope was rejected.
- **Phase structure by spec layer** — Gemini's organization of gaps by spec layer (Attractor, Agent Loop, LLM Client) influenced the Phase 2/3 split in the merged sprint.

### Not Taken (with reasoning)

| Item | Source | Why excluded |
|------|--------|-------------|
| All 20 gaps in one sprint | Gemini | Over-scoped; all three critiques agreed. History shows mixing too many gap closures with test fixes causes both to fail. |
| L3 destructive event renames | Gemini | Breaking change with high blast radius. Claude and Codex correctly proposed additive aliases only. Codex critique specifically flagged this as "a serious plan defect." |
| A4 checkpoint path migration | Gemini | Requires migration strategy for existing cocoons, resume flows, and filesystem assumptions. All critiques agreed on deferral. |
| C2 native system prompt mirroring | Gemini | Requires obtaining proprietary prompts; license unclear. Claude and Codex both defer. |
| C3 Gemini web tools | Gemini | Optional per spec; needs search backend decision. Unanimously deferred. |
| C7 Anthropic beta headers | Claude | Codex critique correctly noted these are hardcoded date-versioned strings that will rot. Better as configuration in a future sprint. |
| L4 module-level stream() | Claude | API surface expansion with no behavioral impact. Deferred per Codex's prioritization logic. |
| L5 ImageData detail, L7 metadata | Claude | Interface shape only. No behavioral impact. |
| Suite-is-already-green assumption | Codex | Fatal flaw identified by both Claude and Codex critiques. The suite has 4 confirmed failures. Corrected by adopting Claude's Phase 1. |
| `src/engine/condition-parser.ts` | Codex | Codex critique flagged this as a potential phantom file. Merged sprint references `src/engine/conditions.ts` only, pending verification during audit. |

---

## Key Merge Decisions

1. **Claude's structure + Codex's architecture** — The merged sprint uses Claude's phase ordering and hard-gate discipline with Codex's design decisions and scoping rigor. This combination was recommended by all three critiques.

2. **Scope: 4 test fixes + 11 compliance gaps** — A middle ground. Claude proposed 16 gaps, Codex proposed 10, Gemini proposed 20. The merged sprint targets 11 (Codex's 10 + C4), with a strict drop line that protects the green suite above all else.

3. **C4 included despite Codex deferral** — The Codex critique noted that deferring `agent_session_completed` was inconsistent with the draft's own "session accounting" theme. Claude critique also flagged C4 as needing verification. Included with an audit-first check.

4. **SSE cleanup strengthened** — Gemini critique identified the memory leak risk from dead SSE connections. Merged sprint specifies `close` event cleanup on tracked connections, not just bulk cleanup on shutdown.

5. **Reserved-root precedence for A3** — Codex's design specified this explicitly; Claude's implementation tasks mentioned it but not as a design principle. Elevated to a design decision in the merged sprint.
