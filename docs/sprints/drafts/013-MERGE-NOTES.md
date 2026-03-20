# Sprint 013 Merge Notes

## Source Drafts

- **Claude Draft:** "Sprint 012: Subagent Tools — Parallel Task Delegation for Codergen Nodes"
- **Codex Draft:** "Sprint 012: Subagent Delegation & Session Hardening"
- **Gemini Draft:** "Sprint NEXT: Subagents & Manager Loop"

## Critiques Considered

- **Claude Critique:** Cross-draft comparison and 10 specific merge recommendations
- **Codex Critique:** Deep code-aware analysis of both Claude and Gemini drafts
- **Gemini Critique:** Comparative strength/weakness analysis of Claude and Codex drafts

---

## Merge Strategy

All three critiques independently converged on the same recommendation: use the Codex draft's "harden first" strategy as the structural backbone, adopt the Claude draft's subagent specification for its completeness, and cherry-pick the Gemini draft's C3 quick-win. The merged sprint follows this consensus.

Sprint numbered as **013** because SPRINT-001 through SPRINT-012 already exist in `docs/sprints/`.

---

## What Was Taken From Each Draft and Why

### From Codex Draft (Structural Foundation)

1. **Session hardening as Phase 1.** The Codex draft's unique and strongest insight — the only draft that identified live bugs in Sprint 011's session wiring (profile-filtered tool exposure not used at runtime, environment context not injected, abort not stopping shell commands, artifact metadata incomplete). Building subagents on a broken parent session would amplify those bugs. Adopted as the sprint's first phase.

2. **Dynamic tool visibility per turn.** The per-turn tool rebuild (only showing `spawn_agent` when depth allows, only showing management tools when children exist) was concrete and unique to the Codex draft. Prevents models from hallucinating tool calls they can't make. Adopted wholesale.

3. **`max_subagent_depth = 1` default.** Both critiques agreed depth=3 (Claude's default) was too aggressive for a first implementation. Architecture still tracks depth as an integer for future expansion.

4. **Deterministic 7-step abort sequence.** Stream cancel → tool abort → child abort → bounded cleanup → flush → emit → CLOSED. The most detailed cleanup spec across all drafts.

5. **Live prompt composition.** Rebuilding the system prompt from real tool list and environment context before each LLM call. Closes unfinished Sprint 011 wiring.

6. **`cwd` + `scoped(subdir)` on ExecutionEnvironment.** More technically sound than Claude's simple string replacement for `working_dir`.

7. **Event lineage metadata.** `session_id`, `root_session_id`, `parent_session_id`, and `agent_depth` on every event. Better granularity than other drafts.

### From Claude Draft (Subagent Specification)

1. **SubagentManager architecture.** Most complete subagent design: lifecycle management, result caching, handle tracking. Used as the baseline.

2. **Concurrency limiting (`max_concurrent_children: 4`).** Neither Codex nor Gemini included this. Without it, models could spawn unlimited children.

3. **Per-child budget controls.** `child_max_tool_rounds: 20`, `child_max_turns: 5`, `child_timeout_ms: 300000`. Neither other draft specified these. Both critiques flagged this as critical.

4. **Tool JSON schemas.** Concrete, implementable schemas for all four tools. Codex described behavior but lacked exact schemas.

5. **Communication semantics.** Clear state-aware routing for `send_input` (PROCESSING → steer, AWAITING_INPUT → followUp). Resolved ambiguity in Codex's spec.

6. **Transcript layout.** `subagents/<agent_id>/` with full artifact nesting. Both drafts agreed; Claude's was more detailed.

7. **Explicit subagent event types.** Combined with Codex's lineage metadata in the merged version.

8. **Risk analysis.** Most comprehensive table. Extended with critique-identified items (cost, filesystem conflicts, context pressure).

9. **Definition of Done structure.** 34+ items, behavior-based. Extended per critique recommendations.

10. **A10 (context `appendLog()`).** Small compliance closure that rides along with subagent event work.

### From Gemini Draft (Targeted Addition)

1. **C3: Untruncated tool output event.** Small, well-scoped MEDIUM-severity gap closure. Both Claude and Codex critiques endorsed including it. Folded into Phase 4.

2. **Nothing else.** L9 (`generate()` loop), A1 (manager loop handler), and the broad 4-feature scope were explicitly excluded per unanimous critique recommendation.

### From Critiques (Refinements)

1. **Completed-child eviction semantics** (Codex critique): Explicitly defined when children free concurrency slots.
2. **`wait` edge cases** (all critiques): Empty array, duplicate IDs, mixed known/unknown IDs added to tasks and DoD.
3. **Workspace override validation** (Codex, Gemini critiques): Out-of-root rejection, boundary tests.
4. **Bounded `wait` output** (Claude critique): Summaries to model, full output to artifacts only.
5. **`npm run build` in DoD** (Codex, Gemini critiques): Both noted the Claude draft omitted this.
6. **Integration test requirements** (Codex critique): End-to-end tests through real codergen session path.
7. **Context `appendLog` serialization** (Codex critique): JSON-encoded array in reserved key for string-only context model.
8. **Phase budget realism** (Claude critique): Phase 5 is the explicit deferral target if Phase 1 overruns.

---

## What Was Excluded and Why

| Feature | Source | Reason for Exclusion |
|---------|--------|---------------------|
| L9 `generate()` loop | Gemini | Orthogonal to subagents, duplicates existing agent-loop functionality |
| A1 manager loop handler | Gemini | Depends on stable subagents, adds `house` shape to parser/validator/runtime, too much coupling |
| `max_depth = 3` default | Claude | Too aggressive for first implementation; architecture supports it, but default ships at 1 |
| Recursive subagents beyond depth 1 | Claude | Risk/reward too high for initial launch |
| Provider/model override on `spawn_agent` | Codex | Clean feature but adds complexity; children inherit parent profile for now |
| `send_input` via `session.submit()` | Gemini | Conflates steering with input submission; state-aware routing adopted instead |
| Automatic supervisor heuristics | — | Out of scope for explicit-delegation-first philosophy |
