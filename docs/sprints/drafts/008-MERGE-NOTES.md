# Sprint 008 Merge Notes

## Drafts Considered

| Draft | Author | Title |
|-------|--------|-------|
| NEXT-CLAUDE-DRAFT.md | Claude | Model Stylesheet, Default Blocks & Parallel Tool Execution |
| NEXT-CODEX-DRAFT.md | Codex | Seedbed Foundation — Filesystem Capture and Swarm Analysis |
| NEXT-GEMINI-DRAFT.md | Gemini | Agentic Parallelism & Performance |
| NEXT-GEMINI-CRITIQUE.md | Gemini | Critique of all three drafts |

## Synthesis Strategy

The final sprint combines two independent clusters — **Seedbed Foundation** (product layer) and **DOT Parser QoL** (engine layer) — while deferring heavier features to Sprint 009+. The Gemini critique's recommendation to pair seedbed capture with low-risk parser fixes was the primary guide for scoping.

## What Was Taken From Each Draft

### From NEXT-CODEX-DRAFT.md (Seedbed) — Primary source

**Adopted almost entirely for Phases 1-3:**
- Filesystem-backed seed creation architecture (`seedbed/NNN-slug/`, `meta.yaml`, `seed.md`)
- `WorkspacePaths`, `SeedStore`, `SeedMeta`, `ConsistencyCheck` abstractions
- CLI command surface (`pollinator seed`, `seeds`, `set-status`, `set-priority`, `show`)
- Attachment import with filename sanitization
- Atomic temp-file + rename writes for `meta.yaml`
- `SeedStatus`, `SeedPriority`, `AnalysisStatus` enums

**Modified based on Gemini critique:**
- **ID allocation**: Dropped the `.nectar/locks/seed-id.lock` lockfile approach. Instead, scan `seedbed/` and `honey/` for highest integer prefix + atomic `fs.mkdir` to catch races. Simpler, no stale-lock risk.
- **Bounded inputs**: Added 1 MB stdin limit and 50 MB attachment limit (critique flagged unbounded input as a gap).
- **Edge cases**: Added explicit handling for empty stdin, missing seed ID, invalid status/priority values.

**Deferred to Sprint 009:**
- `pollinator swarm` and the entire `SwarmAnalyzer` / `AnalysisNormalizer` system. The critique correctly identified that LLM output normalization is fragile and that swarm analysis depends on seedbed existing first. Shipping seedbed alone is the right vertical slice; swarm analysis gets its own focused sprint.

### From NEXT-CLAUDE-DRAFT.md (Stylesheet + Parser + Parallel Tools) — Secondary source

**Adopted for Phases 4-5 (DOT parser improvements):**
- Block comment (`/* ... */`) stripping with `insideBlockComment` state (GAP-17)
- `node [attrs]` / `edge [attrs]` default block parsing with scope stack (GAP-13)
- Subgraph extraction with class derivation (GAP-14)
- Duration `h` and `d` unit support (GAP-20)
- Scope stack architecture (push copy on subgraph enter, pop on exit)
- `Subgraph` type and `classes` on `GardenNode`

These were chosen because:
1. They are tightly scoped parsing tasks — the most testable, lowest-risk category of work
2. They close 4 compliance gaps with minimal surface area
3. They dramatically improve DOT authoring ergonomics (no more boilerplate repetition)
4. They're completely independent from the seedbed cluster

**Added from Gemini critique:**
- Unclosed block comment at EOF should produce a parse diagnostic (critique flagged this missing edge case)

**Deferred to Sprint 009:**
- Model stylesheet micro-language (GAP-06, GAP-24) — full CSS-like specificity engine is too heavy to bundle. The critique correctly called this "ambitious scope."
- New node/edge/graph attributes (GAP-27/28/29) — pairs naturally with stylesheets
- Parallel tool execution (GAP-45, GAP-57) — the critique flagged combining concurrency changes with the authoring layer as risky

### From NEXT-GEMINI-DRAFT.md (Parallelism & Performance) — Scoping reference

**Deferred entirely to Sprint 009/010:**
- Parallel tool execution in agent loop (GAP-45)
- Parallel tool execution in LLM SDK (GAP-57)
- Anthropic prompt caching auto-injection (GAP-53)
- Context window awareness / token tracking (GAP-44)

The Gemini draft was the most narrowly focused — a pure performance sprint. Its content remains valuable and largely intact for a future sprint. The parallel tool execution design from both the Claude and Gemini drafts should be reconciled during Sprint 009 planning. Key differences to resolve:
- Claude draft partitions tools by safety classification (read-only vs mutating); Gemini draft uses `Promise.all()` across all tools
- Claude draft includes a semaphore/pool for bounding concurrency; Gemini draft does not
- Claude draft's safety classification approach is more conservative and likely the right baseline

### From NEXT-GEMINI-CRITIQUE.md — Cross-cutting influence

The critique shaped the final sprint in several ways:
1. **Scoping**: Validated that combining seedbed + low-risk parser fixes is the right size. Explicitly recommended deferring stylesheets, parallel tools, and swarm analysis.
2. **ID allocation**: Identified lockfile approach as fragile, suggested scan + atomic mkdir instead. Adopted.
3. **Bounded inputs**: Flagged unbounded stdin and attachment sizes as missing edge cases. Adopted with specific limits.
4. **Edge cases**: Identified unclosed comments, slug collisions, empty stdin, and tag normalization as gaps. Addressed (except tag normalization — deferred as minor).
5. **Codex draft weakness**: Correctly noted that LLM markdown normalization is brittle. This was the primary reason for deferring swarm analysis.

## What Was Not Taken and Why

| Idea | Source | Reason for exclusion |
|------|--------|---------------------|
| Model stylesheet micro-language | Claude | Too heavy for this sprint; full CSS-like specificity engine deserves focused attention |
| 7 new node attributes, 2 edge, 2 graph | Claude | Pairs with stylesheets; adopt together |
| Parallel tool execution | Claude + Gemini | Independent performance work; own sprint |
| Prompt caching auto-injection | Gemini | Independent optimization; own sprint |
| Context window awareness | Gemini | Independent optimization; own sprint |
| Swarm analysis (`pollinator swarm`) | Codex | Fragile LLM normalization needs more design; depends on seedbed existing first |
| Tag normalization rules | Gemini critique | Minor UX polish, not worth spec'ing now |
| Tool safety classification types | Claude | Moves with parallel tool execution |
