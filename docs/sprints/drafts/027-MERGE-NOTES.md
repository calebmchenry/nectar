# Sprint 027 Merge Notes

## Source Drafts

- **NEXT-CLAUDE-DRAFT.md** — "Green Suite, Engine Contract, and Server API Completeness"
- **NEXT-CODEX-DRAFT.md** — "Finish the Coding-Agent Loop Contract"
- **NEXT-GEMINI-DRAFT.md** — "Spec Compliance Polish — Resilience & Observability"
- **NEXT-GEMINI-CRITIQUE.md** — Critique of Claude and Codex drafts with merge recommendations

## What Was Taken and Why

### From Claude Draft (primary foundation for Phases 1–3)

- **Phase 1 (Green Suite) adopted wholesale.** Claude's root-cause analysis of the 6 failing tests was the most detailed and actionable. The 3 root causes (assertion mismatches, SSE lifecycle bugs) and the diagnosis-first methodology were taken verbatim. The Gemini critique endorsed this as the non-negotiable gate.
- **Phase 2 (Tool handler + QueueInterviewer fixes) adopted.** The `tool.output` context key fix (gap 7) and QueueInterviewer SKIPPED return (gap 6) were well-specified one-line fixes in the Claude draft. Gemini also included these.
- **Phase 3 (HTTP endpoints) adopted.** Claude's cancel/checkpoint/context endpoint design was the most complete, including status codes (404, 409) and response shapes. The Gemini critique agreed these are essential for Hive integration.
- **Anti-pattern rule added from Gemini critique.** "Timeout values must not be increased to achieve passing tests" was added to Phase 1 and the Definition of Done. This addresses the critique's observation that prior sprints may have bumped timeouts instead of root-causing.
- **Cut line structure adopted.** Claude's explicit cut line with ordered items was the clearest risk management tool.

### From Codex Draft (primary foundation for Phases 4–5)

- **Session lifecycle events (Phase 4) adopted.** Codex had the most thorough event design: the full list of 11 missing events, the design rules distinguishing `agent_session_completed` from `agent_session_ended`, the `agent_warning` umbrella pattern, and the bridge into engine RunEvents. This was the strongest unique contribution of the Codex draft.
- **Tool schema fixes adopted.** `grep` case_insensitive, `shell` description, `spawn_agent` model override, and spawn output limits were all well-specified in the Codex draft and absent from Claude's. These are low-effort, high-impact changes.
- **Truncation compliance adopted.** The 50/50 head/tail split, spec marker wording, and head/tail line truncation were clearly argued in the Codex draft (tail context matters for stack traces and test summaries).
- **"No new modules" principle adopted.** Codex's explicit stance against introducing new abstractions kept the sprint surgical.

### From Gemini Draft (selective adoption)

- **Engine retry (gaps 1–3) deferred.** Gemini included retry jitter, preset corrections, and should_retry predicates alongside LLM error classification and FinishReason normalization. The Gemini critique itself recommended deferring retry correctness in favor of observability and tool fixes. The merged sprint follows this advice — retry work is out of scope.
- **LLM response/error work (gaps 26–47) deferred.** Gemini's Phases 3–4 (FinishReason normalization, GenerateResponse completeness, error classification across all adapters) are a large, self-contained block. They warrant their own sprint rather than competing with test fixes and observability.
- **Session lifecycle events partially influenced Phase 4.** Gemini's event list was less detailed than Codex's but confirmed the same gap.

### From Gemini Critique (editorial influence)

- **Merge strategy adopted.** The critique's recommendation — "Get CI green → Ship missing server API endpoints → Add full agent lifecycle events → Fix core tool schemas and truncation" — became the phase ordering of the final sprint.
- **ExecutionEnvironment refactor deferred.** The critique correctly identified this as a large structural change that risks distracting from the core goals. Deferred to out-of-scope.
- **Fake streaming caveat adopted.** The critique's warning about `agent_tool_call_output_delta` being post-execution chunking (not live streaming) was added to Risks & Mitigations with a note to document the contract clearly.
- **Cascading failure risk added.** The critique's observation about context key changes breaking existing conditions was added to the risk table.

## What Was Cut and Why

| Item | Source | Reason for Cutting |
|------|--------|--------------------|
| Engine retry jitter/presets/should_retry (gaps 1–3) | Claude, Gemini | Lower urgency than observability; Gemini critique recommended deferring |
| Unified LLM FinishReason + GenerateResponse (gaps 26–31) | Gemini | Large, self-contained; warrants own sprint |
| LLM error classification across adapters (gaps 41–47) | Gemini | Same rationale as above |
| ExecutionEnvironment interface (gaps 15–19) | Codex | Large abstraction refactor; Gemini critique flagged risk; no one swaps environments today |
| Instruction discovery direction (gap 25) | Codex | Behavioral difference, not broken; Gemini critique flagged monorepo latency risk |
| Diagnostic model (gaps 4–5) | Claude | Cosmetic; no runtime behavior change |
| Message factory methods / convenience accessors | Gemini | Nice-to-have ergonomics, not a correctness issue |

## Conflict Resolution

- **Claude vs Codex on sprint focus:** Claude prioritized stability (green tests + engine correctness + server API). Codex prioritized product value (agent observability + tool quality). The merge takes Claude's stability-first phasing but fills the remaining capacity with Codex's observability and tool work instead of Claude's engine retry changes. This follows the Gemini critique's recommendation.
- **Retry work:** All three drafts included retry fixes. Deferred entirely — the green suite and observability are higher leverage right now.
- **Event naming:** Codex used `agent_*` prefixed names. Gemini used `SESSION_START` / `PROCESSING_END` style. Adopted Codex's naming as it was more detailed and consistent with the existing event model in `src/agent-loop/events.ts`.
