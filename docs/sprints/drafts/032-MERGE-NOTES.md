# Sprint 032 Merge Notes

## Structure

The final sprint uses the **Codex draft** as its structural foundation, with the **Claude draft's SSE diagnosis** prepended as Phase 1 and selective improvements from all three drafts woven in. The Codex draft was chosen as the base because all three critiques independently recommended it for its tighter scope, better subsystem boundaries, more actionable architecture, and stronger Definition of Done.

## What Was Taken from Each Draft

### From NEXT-CODEX-DRAFT (primary structure)

- **Scope:** The 11-gap runtime-hardening scope (C1, C2, C6, C7, C8, U13, U14, U15, U16, U17, U18) was adopted nearly verbatim. This was the only draft that consistently stayed focused on gaps that change execution behavior.
- **Architecture:** The 4-step deterministic tool repair pipeline, the parent-unlimited / child-finite default split, the `src/llm/tool-repair.ts` shared module, and `LocalExecutionEnvironment.exec()` owning process-group lifecycle were all carried forward.
- **Implementation phases:** Phases 2–5 map directly to Codex's Phases 1–4, with minor adjustments.
- **Risk analysis:** The core risk table was built from Codex's entries, which were the most thorough and realistic.
- **Definition of Done:** The behavioral, falsifiable DoD items came primarily from Codex, including "no test timeout values were increased" and explicit per-behavior checkboxes.
- **Why:** Codex had the best alignment with actual file ownership in the codebase, the strongest architectural opinions (process-group ownership, repair pipeline boundaries), and the most realistic scope for a single sprint.

### From NEXT-CLAUDE-DRAFT (SSE diagnosis + Phase 1)

- **SSE lifecycle fix:** The entire SSE diagnosis — root cause analysis, terminal-event flow diagram, `res.end()` fix, `run_error` emission — was adopted as Phase 1. This was Claude's strongest contribution and addressed the most urgent problem (6 failing tests) that both other drafts missed.
- **SSE regression test:** The specific assertion "stream closes within 1 second of terminal event" was carried forward.
- **`closeOnTerminalEvent()` helper:** Claude's suggestion to extract a shared helper for SSE cleanup was adopted.
- **`res.on('close')` cleanup:** The client-disconnect cleanup path was adopted.
- **A3 (CheckpointSaved):** Included as part of Phase 6, adding one more gap closure at low marginal cost since `src/engine/events.ts` is already being touched.
- **Open questions:** The A1/A2 rationale (valid superset, JS single-thread) informed the decision to exclude those gaps from scope rather than spending time "fixing" them.
- **Why not more:** Claude's 37-gap scope was too ambitious. All three critiques flagged this. The low-severity interface-shape gaps (U1–U12, U19, A4–A6, C3–C5, C9–C12) were dropped — they don't change runtime behavior and are a clean follow-up sprint.

### From NEXT-GEMINI-DRAFT (selective improvements)

- **Compliance report update as DoD item:** Gemini's requirement that closed gaps move to the IMPLEMENTED list in `docs/compliance-report.md` was adopted. Neither other draft included this explicitly.
- **Process-tree fixture test design:** The specific test concept — "spawn a script that spawns `sleep 60`, timeout, ensure `sleep 60` is dead" — was the most concrete test specification across all drafts and was adopted for Phase 3.
- **User-centric use cases:** Gemini's scenario-based use case style ("A user runs a pipeline with an Anthropic model that returns `redacted_thinking`") influenced the use case phrasing.
- **Why not more:** Gemini's file targets were frequently wrong (e.g., `RedactedThinkingContentPart` in the wrong file, repair logic in `tool-registry.ts` instead of the execution pipeline). Its tool-repair approach (JSON heuristics at the adapter layer) was rejected in favor of Codex's schema-driven pipeline. Its omission of the 6 failing tests was a critical gap that all critiques flagged.

## What Was Excluded and Why

| Excluded Item | Source | Reason |
|---|---|---|
| U1–U12, U19 (adapter lifecycle, interface fields) | Claude | Additive interface shape — no runtime behavior change. Follow-up sprint. |
| A1, A2, A4, A5, A6 (Attractor gaps) | Claude | A1/A2 are valid supersets or N/A for JS. A4–A6 are naming/cosmetic. |
| C3–C5, C9–C12 (agent loop extras) | Claude | Parameter renames and prompt parity — lower priority than execution correctness. |
| U3 (model catalog) | Claude, Gemini | Catalog entries age quickly and expand test fallout. Low-leverage for a hardening sprint. |
| PascalCase event aliases (A4) | Claude | Long-term maintenance burden for low value. All critiques questioned this. |
| `repair_tool_call` as interface-only no-op | Claude | Codex's full pipeline approach is more valuable — actually solves the problem. |
| Gemini's adapter-layer JSON repair approach | Gemini | Wrong layer. Repair belongs in the execution pipeline, shared by both client and session. |
| `repair_tool_call` in `tool-registry.ts` | Gemini | Registry is for registration, not execution-time repair. |
| `jsonrepair` dependency | Gemini | Aggressive JSON cleanup can mutate valid payloads. Schema-driven repair is safer. |

## Critique Feedback Incorporated

All three critiques converged on these recommendations, all of which are reflected in the final sprint:

1. **Fix the 6 failing tests first** — adopted as Phase 1.
2. **Use Codex as structural foundation** — adopted for phases, scope, architecture, and DoD.
3. **Keep parent-unlimited / child-finite as an explicit design decision** — documented in architecture, DoD, and risks.
4. **No timeout inflation to achieve green** — explicit DoD checkbox.
5. **Compliance report update** — explicit Phase 6 task and DoD checkbox.
6. **SSE route audit as prerequisite, not mitigation** — first task in Phase 1.
7. **Cache `git rev-parse` result** — added to architecture and open questions.
8. **Add git-unavailable fallback test** — added to Phase 2 test list.
