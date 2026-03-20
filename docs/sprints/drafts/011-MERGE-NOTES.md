# Sprint 011 Merge Notes

## Source Drafts

| Draft | Title | Lines | Key Contribution |
|-------|-------|------:|------------------|
| NEXT-CLAUDE-DRAFT.md | Agent Control Plane & OpenAI Edit Parity | 474 | Deepest specification of state machine, patch pipeline, and gap sweep. Explicit cut-line. |
| NEXT-CODEX-DRAFT.md | Codergen Control Plane & OpenAI Patch Parity | 568 | Most comprehensive architecture and file layout. Strong public API design and artifact model. |
| NEXT-GEMINI-DRAFT.md | Advanced Agent Capabilities | 123 | Included subagents (C5) alongside control plane and apply_patch. Bold scoping. |
| NEXT-CLAUDE-CRITIQUE.md | Critique of Codex and Gemini drafts | 213 | Identified gaps in both drafts; 10 concrete recommendations for the merge. |

## Primary Structure

The final sprint uses **NEXT-CODEX-DRAFT.md** as the primary structural template, as recommended by the critique. The Codex draft had the most thorough architecture sections, the clearest module layout, and the most complete files summary.

## What Was Taken From Each Draft

### From NEXT-CLAUDE-DRAFT.md
- **Sprint title** — "Agent Control Plane & OpenAI Edit Parity" (cleaner than Codex's "Codergen Control Plane" framing)
- **Overview framing** — the compliance gap table with severity ratings and the "why not all three at once" argument
- **Explicit cut-line** — "If behind schedule, defer Phase 4 truncation/events work" (Codex draft lacked this; critique flagged it)
- **GAP Closure Summary table** — the 12-gap summary with before/after status
- **Phase 1 task detail** — the Claude draft's task list was slightly more granular on steer delivery and event emission

### From NEXT-CODEX-DRAFT.md
- **Architecture section structure** — state machine diagram, public session API, steering/follow-up delivery, prompt composition, patch pipeline, event/artifact model, module layout
- **State machine diagram** — the text-art format with transition labels (clearer than Claude's ASCII box format)
- **Public API surface** with `processInput()` compatibility wrapper, internal queue fields, and `runLoopPromise`
- **Patch application pipeline** diagram and non-goals
- **Truncation rules table** with per-tool character and line caps
- **Artifact directory layout** (`tool-calls/NNN-apply_patch/` structure)
- **Files Summary table** — the most complete at 29 files vs Claude's 27
- **Risk table** — 8 risks with concrete mitigations (Claude had 8 similar risks; Codex's wording was tighter)
- **Dependencies table** with status column

### From NEXT-GEMINI-DRAFT.md
- **Subagent use case for Sprint 012 planning** — the parallel implementation + testing use case is compelling and was preserved in the overview's forward-looking note about Sprint 012 design requirements
- **Honest risk assessment** — Gemini rated patch flakiness as High/High, which influenced the risk table entry for parser fragility

### From NEXT-CLAUDE-CRITIQUE.md (Recommendations Applied)

| Recommendation | Applied? | How |
|----------------|----------|-----|
| 1. Use Codex as primary structure, defer subagents | Yes | Codex structure used; subagents explicitly out of scope |
| 2. Add explicit cut-line | Yes | Added to Overview section |
| 3. Specify `abort()` fully | Yes | Added `abort()` to Public API with SIGTERM/cancel/reject semantics |
| 4. Address conversation history growth | Yes | Added `max_follow_ups` (default: 10) and "Known limitation" subsection |
| 5. Reject fuzzy patch matching explicitly | Yes | Added as Design Principle #4 and in Out of Scope |
| 6. Clarify developer role folding for Anthropic | Yes | Specified "append as last entries in system array" with multi-steer test requirement |
| 7. Add follow-up count limit | Yes | `max_follow_ups` in Phase 1 tasks and DoD |
| 8. Steal Gemini subagent use cases for Sprint 012 | Yes | Added to Overview forward-looking paragraph |
| 9. Add build/regression gates to DoD | Yes | First three DoD items |
| 10. Specify line-ending handling for apply_patch | Yes | Added to Patch Pipeline section and Phase 3 tasks/tests |

## What Was Dropped

### From NEXT-GEMINI-DRAFT.md
- **Subagent orchestration (C5)** — the entire Phase 3 (SubagentManager, spawn_agent, send_input, wait_agent, close_agent). Reason: the critique correctly identified that subagents on an unstable session state machine produce fragile, hard-to-debug orchestration. The Gemini draft's subagent design was a sketch ("or extensions to ExecutionEnvironment") with key questions unanswered (inheritance, permissions, deadlock, budget). This is Sprint 012 work.
- **Fuzzy patch matching fallback** — explicitly rejected per Design Principle #4. Fuzzy matching hides bugs.
- **Steering as "user interruptions"** — replaced with `developer`-role messages per the Codex/Claude approach. Injecting steering as user text confuses models about who is speaking.
- **Follow-up triggers on `IDLE`** — the Gemini draft used `IDLE` for follow-up consumption, but `IDLE` means "never started." The merged sprint uses `AWAITING_INPUT` per the Codex/Claude design.

### From NEXT-CLAUDE-CRITIQUE.md
- **Pre-queue steering before PROCESSING** — the critique noted that `steer()` requiring PROCESSING state means you can't set constraints before the first model call. This is a valid observation but the workaround (use the initial prompt for pre-constraints) is sufficient. Adding a pre-queue mechanism adds complexity for a narrow use case.

## Design Decisions

1. **Title choice:** "Agent Control Plane & OpenAI Edit Parity" over "Codergen Control Plane" because the session state machine serves more than just codergen — it's the foundation for any agent session.

2. **Abort semantics:** The critique identified this as underspecified. The merged sprint defines abort as: SIGTERM to shell, cancel stream, reject promise with AbortError, fire-and-forget call. This is intentionally simple — the 2s SIGKILL escalation handles cleanup.

3. **Anthropic developer role folding:** The critique asked "what does in-order mean?" The merged sprint specifies: append as last entries in the system array, preserving FIFO among themselves. This acknowledges that Anthropic's system block is position-insensitive relative to conversation turns.

4. **Line-ending handling:** Added per critique recommendation #10. Normalize to `\n` for parsing, detect and preserve target file's endings on write. New files use platform default.

5. **Independent git timeouts:** The critique asked whether all git commands share one 2s budget or each gets 2s. The merged sprint specifies: each command gets an independent 2s timeout.
