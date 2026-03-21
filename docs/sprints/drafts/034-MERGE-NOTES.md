# Sprint 034 Merge Notes

## Final Sprint Title
**Green Suite, Deterministic AI Defaults, and Compliance Closure**

## Synthesis Summary

The final sprint merges the CI rigor and compliance detail of the Claude draft with the product determinism and architectural clarity of the Codex draft, informed by all three critiques' consensus on scope, risk, and implementation approach.

## What Was Taken From Each Draft

### From NEXT-CLAUDE-DRAFT.md (Compliance Zero)

**Adopted:**
- Per-gap compliance breakdown with effort categories (trivial/small/medium/large) — used to structure Phases 3 and 4
- Detailed test fix strategies for all 3 failing tests (http-server, gardens-draft, pipeline-events)
- Phase gating rule: "Phase 2 does not begin until `npm test` is green"
- Drop line concept and ordering (adapted for the merged scope)
- Per-gap Definition of Done checkboxes — far more useful than Gemini's single "all 22 gaps" checkbox
- File-level task specificity for each compliance item
- Risk table structure with concrete mitigations
- Alias-based approach for A4 (PascalCase events alongside snake_case) and C9/C10/C11 (accept both parameter names)
- NoOpContextLock for A2 (vs Gemini's over-engineered ReadWriteLock)
- Compliance items: A2, A4, A6, U4-U10, U11, U12, C4, C5, C9, C10, C11, U1, U2, U3

**Not adopted:**
- "Compliance Zero" framing — the goal of literally zero gaps is too brittle as a sprint target (per Claude critique). The merged sprint aims to close all achievable gaps with a clear drop line.
- C12 (system prompt parity) — all three critiques agreed this is highest-effort, lowest-urgency, and underspecified. Deferred.
- C3 (Gemini web tools) — optional per spec, needs search backend decision. Deferred.
- Claim of 4 failing tests — Codex critique correctly identified that fan-in-llm is already passing. Updated to 3.
- Phase 5 (system prompts + web tools) and Phase 4 as originally scoped — redistributed across the merged phases.

### From NEXT-CODEX-DRAFT.md (Workspace Config & Determinism)

**Adopted:**
- Core architectural principle: "Credentials from Env, Behavior from Workspace" — this is the conceptual backbone of Phase 2
- `.nectar/config.yaml` schema and loading design
- Resolution order documentation (request > config > simulation for drafts; explicit > config > built-in > skipped for swarm)
- Deterministic simulation fallback — drafting defaults to simulation, not ambient provider probing
- `GET /workspace/config` read-only endpoint design (returns resolved non-secret behavior, never credentials)
- Shared runtime construction pattern (one WorkspaceConfigLoader per workspace, one shared UnifiedClient)
- Run-state truth fixes: seed `current_node` from engine attach, centralize `pipeline_failed` emission
- Risk entries for config secret leakage, existing user behavior change, and precedence ambiguity
- Insight that gardens-draft failure is entangled with ambient provider selection — Phase 1 addresses both the streaming bug and the determinism root cause
- Catalog refresh (U3) and capability fields (C4, C5) — adopted because they directly support config validation

**Not adopted:**
- Full `.nectar/models.css` pipeline integration (Phases 2–3 of original Codex draft) — too much cross-cutting work for this sprint. The config.yaml foundation is sufficient. Models.css is deferred to a follow-up sprint.
- Hive UI changes (DraftComposer, App state) — display-only config surfacing is lower priority than the backend contract. Deferred.
- `swarm-analysis-service.ts` config integration — the Codex draft's swarm provider resolution is directionally correct but the full wiring is more than this sprint needs.
- Phase 3 (workspace stylesheet transform, preparer hooks) — the heaviest cross-cutting phase, and all three critiques flagged scope risk. Deferred.

### From NEXT-GEMINI-DRAFT.md (Spec Compliance & Gap Closure)

**Adopted:**
- Compliance gap inventory — used as a cross-reference to verify the Claude draft's gap list was complete
- Use cases framed from a consumer perspective (e.g., "downstream system parsing events," "LLM agent utilizing tool parameters")
- Explicit attention to the event-renaming blast radius — informed the decision to use aliases, not renames

**Not adopted:**
- Destructive event rename from snake_case to PascalCase — all three critiques agreed this is a breaking change with high blast radius across tests, SSE consumers, CLI, and Hive. Aliases are the correct approach.
- Real ReadWriteLock with `async-mutex` — both the Claude and Codex critiques identified this as over-engineering for single-threaded JS with context clones. NoOpContextLock satisfies the spec.
- Destructive tool parameter renames (`path` → `file_path`, `include` → `glob_filter`) — both Claude and Codex drafts correctly proposed accepting both names. Destructive renames break existing tool call transcripts.
- No test fix phase — the Gemini draft's biggest omission. All critiques flagged this as critical.
- No drop line — the Gemini draft treats all 22 gaps as equally important with no scope management.
- Adding `async-mutex` as a new dependency — unnecessary for a no-op implementation.
- Single "all 22 gaps" DoD checkbox — replaced with per-gap checkboxes from the Claude draft.

## What All Three Critiques Agreed On

1. **Fix failing tests first** — non-negotiable gate before any compliance work
2. **Use aliases, not renames** for events (A4) and tool parameters (C9/C10/C11)
3. **NoOpContextLock** for A2 — real locking is over-engineering for the current runtime model
4. **Include a drop line** — the sprint is ambitious and needs explicit scope management
5. **Defer C12 (system prompts) and C3 (web tools)** — highest effort, lowest urgency
6. **fan-in-llm is already passing** — the Claude draft's claim of 4 failures was stale
7. **The gardens-draft failure is entangled with ambient provider selection** — needs both a streaming fix and a determinism fix

## Key Architectural Decisions

| Decision | Chosen Approach | Alternatives Considered |
|----------|----------------|------------------------|
| Event naming (A4) | PascalCase aliases alongside snake_case | Destructive rename (Gemini) — rejected due to blast radius |
| Tool params (C9/C10/C11) | Accept both old and new names | Destructive rename (Gemini) — rejected, breaks transcripts |
| Context locking (A2) | NoOpContextLock interface | Real ReadWriteLock with async-mutex (Gemini) — rejected as over-engineering |
| Draft provider default | `simulation` unless config overrides | First available env-backed provider (status quo) — rejected as non-deterministic |
| Workspace config scope | `.nectar/config.yaml` only | Full config.yaml + models.css (Codex) — models.css deferred to reduce scope |
| Sprint framing | Hybrid: green suite + determinism + compliance | Pure compliance (Claude/Gemini) or pure product (Codex) |

## Deferred to Follow-Up Sprints

- **C12 (System prompt parity):** Needs concrete per-provider behavioral checklists before implementation. All critiques flagged this as underspecified.
- **C3 (Gemini web tools):** Optional per spec. Needs search backend decision and privacy/offline analysis.
- **`.nectar/models.css` pipeline integration:** Workspace stylesheet transform, preparer hooks, and precedence layering with graph stylesheets. High cross-cutting cost.
- **Hive UI config display:** Show active provider/model and config diagnostics in the draft panel.
- **Swarm provider config wiring:** Full config-driven provider mapping with disabled/unavailable/misconfigured states.
- **Event rename migration:** If PascalCase becomes the primary convention, a future sprint should handle deprecation windows and consumer migration.
