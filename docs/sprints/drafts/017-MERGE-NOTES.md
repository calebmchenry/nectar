# Sprint 017 Merge Notes

**Merged from:** NEXT-CLAUDE-DRAFT.md, NEXT-CODEX-DRAFT.md, NEXT-GEMINI-DRAFT.md
**Critiques reviewed:** NEXT-CLAUDE-CRITIQUE.md, NEXT-CODEX-CRITIQUE.md, NEXT-GEMINI-CRITIQUE.md
**Output:** `docs/sprints/SPRINT-017.md`

---

## Structural Backbone: Claude Draft

The Claude draft was used as the structural backbone for the merged sprint. It had the most complete Definition of Done (~30 testable items categorized by feature area), fully typed event definitions, the most thorough risk table (5 entries in draft, expanded in merge), explicit phase weighting, and the strongest alignment with the current codebase shape. Both the Codex and Gemini critiques independently recommended using the Claude draft as the base.

## What Was Taken From Each Draft

### From Claude Draft (primary structure)
- Overall document structure, section ordering, and narrative framing
- Design principles 1, 5, 6, 7, 8
- All 7 use cases (largely unchanged)
- Implementation phases with effort percentages (~15/20/35/20/10)
- Definition of Done structure (categorized by feature area)
- Cut line strategy (A3 is cuttable, lineage is not)
- Gap closure summary and next-sprint recommendation
- Phase ordering: parsing first, then restart, then manager, then hooks

### From Codex Draft (architecture detail)
- `ChildRunController` class API with explicit method signatures (`start`, `attach`, `readSnapshot`, `writeSteerNote`, `abortOwnedChild`)
- `ChildSnapshot` interface with all typed fields
- Steering file JSON format and `control/` directory layout
- `ManifestData` lineage interface (`restart_of`, `restarted_to`, `restart_depth`, `parent_run_id`, `parent_node_id`)
- Tool hook artifact directory layout (`<sequence>-<tool-name>/pre-hook.json`, etc.)
- Hook stdin JSON payload structure and `NECTAR_*` environment variable list
- Explicit context filter list for restart (which keys to strip)
- "Deterministic supervision, not hidden LLM loops" principle
- "Opinionated decisions" framing adopted into design principles
- `manager.actions` default of `['observe', 'wait']`

### From Gemini Draft (scope discipline)
- Phase effort weighting percentages (Gemini was the only draft with these originally; Claude added them later but Gemini's were the reference)
- Risk entry for infinite restart loops flagged as high-likelihood (upgraded from Medium in other drafts)
- Concise use-case framing style for the supervisor and continuous-execution patterns
- Emphasis on `execa` reuse and zero new dependencies

### From Claude Critique (correctness fixes and edge cases)
- **Critical fix:** Confirmed restart target must be edge target node, not graph start (Gemini draft was wrong)
- Recommendation to make restart depth configurable via `max_restart_depth` graph attribute (adopted)
- Recommendation to specify atomic write mechanics for steering (temp-file-then-rename on both sides)
- Missing edge cases added to test plans: `stack.child_autostart=false` with missing/invalid run ID, stop condition referencing nonexistent keys, `manager.poll_interval` minimum enforcement
- DoD additions: backward compatibility criterion, build/regression gates, test count target (45)
- Recommendation to add `steer`-without-prompt as ERROR (not warning)

### From Codex Critique (codebase-specific issues)
- **Critical:** `house` must be added to supported shape whitelist, not just `normalizeNodeKind()` — otherwise validation still warns on the new shape
- Parent/child signal handler conflict identified as a real risk — child engines must NOT install SIGINT/SIGTERM handlers
- Child engine event isolation must be explicit — own event emitter, summary-only forwarding
- Missing edge cases: attach to already-terminal child run, stop condition true on first snapshot, multiple managers attaching to same child
- Parallel tool execution with hooks needs specification (per-call, not per-batch; sequence numbers for artifacts)
- Hook cwd/path resolution needs to be deliberate (adopted: cwd = run's working directory)
- DoD additions: `house` in validation whitelist, attach failure paths, interrupt semantics, parallel hook execution

### From Gemini Critique
- Risk of child engine hanging indefinitely or failing to respect `abortOwnedChild()` — addressed by making signal handling explicit
- Shared resource contention risk (parent/child sharing workdir) — added as risk with cocoon-directory isolation mitigation
- Recommendation to blend Codex's principles with Claude's payload schemas — exactly what the merge does

## What Was Rejected and Why

### Gemini Draft: A1+A2-only scope
The Gemini draft proposed deferring GAP-A3 (tool hooks) entirely. This was rejected because tool hooks are mechanically independent (~20% effort), self-contained in `AgentSession`, and already well-designed. The cut line already handles time compression: drop Phase 4 if needed. Pre-cutting it means the sprint can't claim the attractor floor is complete.

### Gemini Draft: Restart to graph start node
The Gemini draft said `loop_restart` "jumps back to the start node." This directly contradicts spec §3.2 Step 7. A restart edge `review -> implement [loop_restart=true]` must start at `implement`, not at `Mdiamond`. This was a correctness error identified by all three critiques and was corrected in the merge.

### Gemini Draft: No lineage tracking
The Gemini draft had no manifest lineage fields, no CLI follow-through for restart chains, and no `nectar resume`/`nectar status` chain awareness. Without lineage, restart chains are opaque and unresumable. This was a significant omission that would have left A2 only half-shipped.

### Claude Draft: Overly prescriptive TypeScript interfaces
The Gemini critique noted the Claude draft might over-constrain developers with exact interface shapes. The merge preserves the interfaces as architectural guidance (they're useful for implementation) but frames them as the target API, not rigid constraints.

### Claude Draft: GAP-A4 bundling consideration
The Claude draft's explicit exclusion of GAP-A4 was preserved. The Codex draft had initially considered including it ("~30 lines"), but the Claude draft correctly argued it deserves deliberate API design, not time-pressured bundling.

### Codex Critique: Nested manager loop depth guard
The Codex critique raised child DOTs containing `house` nodes (nested manager loops). Rather than adding a depth guard this sprint, the merge documents nested manager loops as explicitly unsupported. This is the right scope boundary — nested supervision is a genuine feature that deserves its own design, not a guard rail bolted on.

## Key Design Decisions in the Merge

1. **Three-GAP scope with explicit cut line** — A1+A2+A3 in scope, but Phase 4 (A3) is the designated cut point if time compresses.
2. **Restart depth is configurable** — Default 25, overridable via `max_restart_depth` graph attribute. Cheap insurance against boxing users in.
3. **Child signal handling is parent-owned** — Child engines do not install process-level signal handlers. This was not in any draft but was identified as critical by the Codex critique.
4. **Steering uses atomic operations on both sides** — temp-file-then-rename for writes AND consume-then-delete for reads. Identified by Claude critique.
5. **Hook cwd is the run's working directory** — Deliberate choice identified by Codex critique. Affects path resolution for hook scripts.
6. **Parallel tool hooks run per-call** — Not per-batch. Artifact directories use sequence numbers. Identified by Codex critique.
7. **Missing condition keys evaluate as false** — Stop conditions referencing `stack.child.*` keys that don't exist yet return false, not throw. Identified by multiple critiques.
8. **`steer` without `prompt` is an ERROR** — Semantically meaningless, so it's a hard error, not a warning. Identified by Claude critique.
