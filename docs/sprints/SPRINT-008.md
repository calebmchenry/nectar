# Sprint 008: Seedbed Foundation & DOT Authoring Quality-of-Life

## Overview

**Goal:** Deliver the first end-to-end slice of Nectar's Seedbed — filesystem-backed idea capture, triage, and listing — while simultaneously closing a cluster of low-risk, high-value DOT parser gaps that improve pipeline authoring. After this sprint, `pollinator seed "Add rate limiting to the API gateway"` creates a stable on-disk seed that both humans and agents can understand, and DOT files support block comments, default blocks, subgraph scoping, and extended duration units.

**Why these two clusters, why now:**

The compliance report shows the core engine at ~75%, the agent loop at ~55%, and the LLM client at ~45%. Those gaps still matter, but the INTENT doc makes a more important point: Nectar is not just an attractor implementation. It is also a filesystem-backed idea backlog and a multi-AI analysis tool. That second pillar does not exist at all. Another sprint on stylesheets, subagents, or SDK plumbing would improve internals, but Nectar would still be unable to capture a single idea.

Meanwhile, the DOT parser is missing standard Graphviz features — block comments, `node [...]` / `edge [...]` default blocks, and subgraph scoping — that force pipeline authors into unnecessary boilerplate. These are tightly scoped parsing tasks with excellent test coverage characteristics.

These two clusters are **completely independent** — different directories (`src/seedbed/` vs `src/garden/`), different test suites, zero shared state. They can be developed and reviewed in parallel.

**Scope — what ships:**

*Seedbed cluster:*
- Filesystem-backed seed creation under `seedbed/NNN-slug/`
- Canonical `meta.yaml` and `seed.md` contracts aligned with `docs/INTENT.md`
- CLI commands: `pollinator seed`, `pollinator seed show`, `pollinator seed set-status`, `pollinator seed set-priority`, `pollinator seeds`
- Attachment import into `attachments/`
- Consistency checks for `meta.yaml.status` vs directory placement (`seedbed/` vs `honey/`)

*DOT authoring cluster:*
- Block comment (`/* ... */`) stripping in the parser (GAP-17)
- `node [attrs]` and `edge [attrs]` default block parsing with scope stack (GAP-13)
- `subgraph cluster_X { ... }` boundary detection, label extraction, class derivation (GAP-14)
- Duration `h` and `d` unit support (GAP-20)
- `Subgraph` type, `classes` on `GardenNode`

**Scope — what doesn't ship:**

- Swarm analysis (`pollinator swarm`) — depends on seedbed existing first; LLM output normalization needs more design. Deferred to Sprint 009.
- Model stylesheets (GAP-06, GAP-24) — valuable but a full micro-language is too heavy to bundle here. Sprint 009.
- New node/edge/graph attributes (GAP-27/28/29) — pairs naturally with stylesheets. Sprint 009.
- Parallel tool execution (GAP-45, GAP-57) — independent performance sprint. Sprint 009/010.
- Prompt caching auto-injection (GAP-53) — independent optimization. Sprint 009/010.
- Context window awareness (GAP-44) — independent optimization. Sprint 009/010.
- Web UI, HTTP server, kanban board, timeline view
- Manager loop (GAP-04), steering/subagents (GAP-40/41)

---

## Use Cases

1. **Fast capture from the terminal:** A developer has an idea and runs `pollinator seed "Add rate limiting to the API gateway" --priority high --tag api --tag infra`. Nectar creates `seedbed/001-add-rate-limiting-to-the-api-gateway/` with `seed.md`, `meta.yaml`, `attachments/`, and `analysis/`.

2. **Capture from stdin:** A user dumps rough notes into the tool:
   ```bash
   pbpaste | pollinator seed --title "Prod incident follow-up"
   ```
   The pasted text is preserved in `seed.md`; the explicit title is used for `meta.yaml.title` and the slug. Stdin is bounded to 1 MB to prevent accidental abuse.

3. **Attach supporting files at creation time:** `pollinator seed "Investigate flaky CI" --attach ~/Desktop/failure.png --attach ./logs.txt`. Nectar copies both files into `attachments/` (max 50 MB per file), sanitizes filenames, and appends relative links to `seed.md`.

4. **Triage without opening an editor:** `pollinator seed set-status 12 sprouting` or `pollinator seed set-priority 12 queens_order`. Nectar updates `meta.yaml`, refreshes `updated_at`, and when status becomes `honey`, moves the directory to `honey/`.

5. **Agent-readable filesystem state:** Another AI agent can scan `seedbed/012-flaky-ci/`, read `meta.yaml`, `seed.md`, and understand the current priority, state, and attachments without any API call.

6. **Visible consistency problems:** If a seed sits in `honey/` but `meta.yaml.status` still says `blooming`, `pollinator seeds --check` shows it as inconsistent and exits non-zero.

7. **Block comments for inline documentation:**
   ```dot
   /* This pipeline implements the compliance loop.
      Each iteration drafts from three providers,
      critiques each draft, then merges the best. */
   ```

8. **Default blocks eliminate boilerplate:**
   ```dot
   digraph {
     node [shape=box, timeout="120s"]
     plan [prompt="Plan the approach"]
     implement [prompt="Write the code"]
     review [prompt="Review the code"]
     test [shape=parallelogram, script="npm test"]
   }
   ```
   `plan`, `implement`, and `review` inherit `shape=box` and `timeout=120s`. `test` explicitly overrides shape.

9. **Scoped defaults inside subgraphs:**
   ```dot
   subgraph cluster_fast { node [timeout="30s"]; quick_lint; quick_check; }
   subgraph cluster_deep { node [timeout="600s"]; deep_review; deep_test; }
   ```
   `quick_lint` gets 30s. `deep_review` gets 600s. Scoping prevents leak.

---

## Architecture

### Seedbed Design Principles

**The filesystem is the API.** This sprint does not introduce a database, sqlite file, hidden index, or daemon-owned state. The source of truth is the directory tree described in `docs/INTENT.md`.

**`meta.yaml` is canonical for state.** CLI commands may render themed summaries, but every state transition must converge on `meta.yaml`.

**Partial success is normal.** Commands should degrade gracefully when encountering missing or malformed data.

### Seedbed Module Layout

```text
src/seedbed/
  types.ts              CREATE — SeedMeta, enums (SeedStatus, SeedPriority, AnalysisStatus)
  paths.ts              CREATE — Workspace layout, ID allocation, slugging
  store.ts              CREATE — File-backed seed CRUD and archive moves
  attachments.ts        CREATE — Copy + sanitize attachment imports
  markdown.ts           CREATE — seed.md serialization
  consistency.ts        CREATE — Placement/state mismatch detection

src/cli/commands/
  seed.ts               CREATE — pollinator seed + subcommands
  seeds.ts              CREATE — pollinator seeds
  shared.ts             MODIFY — Workspace path helpers
```

### Key Seedbed Abstractions

**`WorkspacePaths`** — Resolves the workspace root and canonical directories for `seedbed/`, `honey/`, and `.nectar/`.

**`SeedStore`** — File-backed repository for seeds:
- Allocate the next numeric ID by scanning `seedbed/` and `honey/` for the highest integer prefix, then use atomic directory creation (`fs.mkdir` without `recursive`) to catch race conditions and retry on collision
- Generate a stable slug from the title
- Create `seed.md`, `meta.yaml`, `attachments/`, and `analysis/`
- Read, list, and update seeds from both `seedbed/` and `honey/`
- Move directories when status crosses the archive boundary

**`SeedMeta`** — Canonical metadata contract:

```yaml
id: 12
slug: flaky-ci-failures
title: Investigate flaky CI failures
status: seedling
priority: high
tags: [ci, test]
created_at: 2026-03-20T03:10:00Z
updated_at: 2026-03-20T03:10:00Z
linked_gardens: []
linked_runs: []
analysis_status:
  claude: pending
  codex: pending
  gemini: pending
```

**`ConsistencyCheck`** — Reports mismatches between directory placement and `meta.yaml.status`. Surfaces inconsistencies in CLI output and returns non-zero from `pollinator seeds --check`. Does not auto-heal.

### DOT Parser Enhancements

**Block Comment Stripping:** Enhance `stripComments()` with character-by-character scan using `insideBlockComment` state. Handle `/*` inside string literals (don't strip). Multi-line. No nesting (standard Graphviz behavior). Unclosed block comments at EOF produce a parse error.

**Default Block & Subgraph Scope Stack:** The parser maintains a stack of attribute scopes. Entering a subgraph pushes a **copy** of the current scope. Changes inside don't affect the parent. Exiting pops.

```
Graph level:                [ { nodeDefaults: {}, edgeDefaults: {} } ]
After `node [shape=box]`:   [ { nodeDefaults: {shape: "box"} } ]
Enter subgraph cluster_X:  [ ..., { nodeDefaults: {shape: "box"} } ]  <- pushed copy
After `node [timeout=30s]`: [ ..., { nodeDefaults: {shape: "box", timeout: "30s"} } ]
Exit subgraph:              [ { nodeDefaults: {shape: "box"} } ]      <- popped
```

**Subgraph Extraction:** Detect `subgraph <name> {` boundaries. Record `Subgraph` objects with `id`, `label?`, `nodeIds`. Derive class name from subgraph label (or strip `cluster_` prefix). Add derived class to every node declared inside. Handle nested subgraphs.

### Command Surface

```text
pollinator seed <text?>          # Create a new seed
  --title <title>                # Override derived title
  --priority <priority>          # low | normal | high | queens_order
  --tag <tag>                    # Repeatable
  --attach <path>                # Repeatable, max 50MB per file

pollinator seed show <id>        # Inspect a seed
pollinator seed set-status <id> <status>
pollinator seed set-priority <id> <priority>

pollinator seeds                 # List all seeds
  --status <status>              # Filter by status
  --priority <priority>          # Filter by priority
  --check                        # Show only inconsistencies, exit non-zero if any
```

### Seedbed Data Flow

```text
pollinator seed "text"
    |
    v
SeedStore.create()
    |-- scan for next ID
    |-- slugify title
    |-- mkdir seedbed/NNN-slug/ (atomic, retry on collision)
    |-- write seed.md
    |-- write meta.yaml (via temp-file + rename)
    |-- copy attachments/
    v
seedbed/NNN-slug/
  seed.md
  meta.yaml
  attachments/
  analysis/
```

### DOT Parser Data Flow

```text
DOT source
    |-- stripComments()         ENHANCED: /* block */ comments
    |-- collectStatements()     ENHANCED: scope stack, default blocks, subgraphs
    v
GardenGraph                     (defaults applied, classes assigned)
    |-- expandGoalVariables()   (existing)
    v
GardenGraph
    |-- validate()              (existing)
    v
Ready for engine
```

---

## Implementation

### Phase 1: Workspace Layout, Schema, and Seed Store (~20%)

**Files:** `package.json`, `src/seedbed/types.ts`, `src/seedbed/paths.ts`, `src/seedbed/store.ts`, `src/seedbed/markdown.ts`, `test/seedbed/store.test.ts`

**Tasks:**
- [ ] Add a YAML dependency (`yaml`) for reading and writing `meta.yaml`
- [ ] Define enums and types:
  - `SeedStatus = 'seedling' | 'sprouting' | 'blooming' | 'honey' | 'wilted'`
  - `SeedPriority = 'low' | 'normal' | 'high' | 'queens_order'`
  - `AnalysisStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'`
- [ ] Implement `WorkspacePaths.fromCwd()` returning absolute paths for `seedbed/`, `honey/`, `.nectar/`
- [ ] Implement next-ID allocation by scanning both `seedbed/` and `honey/` for highest integer prefix. Use atomic `fs.mkdir` (without `recursive`) to claim the directory — retry with next ID on `EEXIST`
- [ ] Implement deterministic slug generation: lowercase ASCII, replace non-alphanumeric runs with `-`, trim leading/trailing `-`, truncate to 48 chars
- [ ] Implement `SeedStore.create()`: derive title from `--title` or first non-empty line of body, create directory structure, write `seed.md` and `meta.yaml` (via temp-file + rename)
- [ ] Implement `SeedStore.get()`, `list()`, and `updateMeta()`
- [ ] Make `updateMeta()` move the seed directory between `seedbed/` and `honey/` when status crosses the archive boundary
- [ ] Tests: ID allocation (including collision retry), slugging, create/read/list, archive moves, atomic writes

### Phase 2: CLI Capture, Inspection, and Triage (~20%)

**Files:** `src/cli/index.ts`, `src/cli/commands/seed.ts`, `src/cli/commands/seeds.ts`, `src/cli/commands/shared.ts`, `src/seedbed/attachments.ts`, `test/seedbed/attachments.test.ts`, `test/integration/seed-cli.test.ts`

**Tasks:**
- [ ] Register `seed` and `seeds` commands in `src/cli/index.ts`
- [ ] Implement `pollinator seed <text?>`: read text argument or piped stdin (bounded to 1 MB), flags for `--title`, `--priority`, `--tag`, `--attach`
- [ ] Implement `pollinator seed show <id>`: print title, status, priority, tags, timestamps, and raw `seed.md` content
- [ ] Implement `pollinator seed set-status <id> <status>` and `set-priority <id> <priority>`
- [ ] Implement `pollinator seeds` list view with `--status`, `--priority`, and `--check` filters
- [ ] Implement attachment import: copy files into `attachments/` (max 50 MB per file), sanitize filenames (lowercase, strip unsafe chars, preserve extension), add numeric suffix on collision, append relative markdown links under `## Attachments` in `seed.md`
- [ ] Handle edge cases: empty stdin, missing seed ID, invalid status/priority values
- [ ] Keep CLI output themed but pipe-friendly
- [ ] Tests: stdin capture, empty stdin rejection, attachment copying, duplicate filename handling, list filtering, archive move on `set-status honey`, size limit enforcement

### Phase 3: Consistency Checks (~10%)

**Files:** `src/seedbed/consistency.ts`, `src/cli/commands/seeds.ts`, `test/seedbed/consistency.test.ts`

**Tasks:**
- [ ] Implement `ConsistencyCheck` rules:
  - `honey/` directory with non-`honey` status -> inconsistency
  - `seedbed/` directory with `honey` status -> inconsistency
  - Missing required metadata keys -> inconsistency
  - Unknown status/priority values -> inconsistency
- [ ] Make `pollinator seeds --check` print only inconsistencies and exit non-zero when any are found
- [ ] Surface inconsistency warnings inline in normal `pollinator seeds` output
- [ ] Ensure all commands fail with useful messages when seed IDs are missing or ambiguous
- [ ] Add fixture coverage for active and archived seeds, partial analyses, malformed `meta.yaml`, and manually moved directories

### Phase 4: Block Comments, Default Blocks, Duration Units (~20%)

**Files:** `src/garden/parse.ts`, `test/garden/parse.test.ts`

**Tasks:**
- [ ] Enhance `stripComments()` to handle `/* ... */` block comments. Character-by-character scan with `insideBlockComment` state. Handle `/*` inside string literals (don't strip). Multi-line. No nesting. Unclosed block comment at EOF produces a parse diagnostic.
- [ ] Detect `node [attrs]` statements: when `parseStatement` sees keyword `node` followed by `[`, parse attributes and push onto the current scope's `nodeDefaults`. Same for `edge [attrs]` -> `edgeDefaults`. These keywords must no longer create spurious node entries.
- [ ] When creating a node, merge current scope's `nodeDefaults` as baseline — explicit attributes override.
- [ ] When creating an edge, merge current scope's `edgeDefaults` similarly.
- [ ] Initialize scope stack with one empty scope at graph level.
- [ ] Add `h` (3,600,000 ms) and `d` (86,400,000 ms) units to `parseTimeoutMs()`.
- [ ] Tests: block comments (single-line, multi-line, inside string literals, unclosed at EOF), default blocks applied to nodes, explicit attrs override defaults, edge defaults, `2h` and `1d` duration parsing.

### Phase 5: Subgraph Extraction & Class Derivation (~15%)

**Files:** `src/garden/parse.ts`, `src/garden/types.ts`, `test/garden/parse.test.ts`

**Tasks:**
- [ ] Add to `types.ts`: `Subgraph` interface with `id`, `label?`, `nodeIds: string[]`. Add `subgraphs: Subgraph[]` to `GardenGraph`. Add `classes: string[]` to `GardenNode`.
- [ ] Detect `subgraph <name> {` in `collectStatements()`. On entry: push new scope (copy of current). Track which nodes are declared inside. On closing `}`: pop scope, record `Subgraph`.
- [ ] Derive class name from subgraph: if subgraph has `label` attribute, use that. Otherwise strip `cluster_` prefix from name. Add derived class to every node declared inside.
- [ ] Handle nested subgraphs: each level pushes its own scope. Inner nodes get classes from all enclosing subgraphs.
- [ ] Tests: subgraph with `label`, with `cluster_` prefix, nested subgraphs, scoped defaults don't leak, nodes get correct classes.

### Phase 6: Integration Testing & Finish Quality (~15%)

**Files:** `test/integration/seed-cli.test.ts`, various

**Tasks:**
- [ ] Run the full test suite and confirm zero regressions in existing parser and engine tests
- [ ] Verify existing DOT fixtures parse and validate identically
- [ ] Add end-to-end CLI tests for seed creation, inspection, and triage
- [ ] Ensure new seedbed commands are clean in both TTY and non-TTY mode
- [ ] Test interaction between default blocks and existing DOT fixtures (compliance-loop.dot, etc.)

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add `yaml` dependency |
| `src/cli/index.ts` | Modify | Register `seed` and `seeds` commands |
| `src/cli/commands/seed.ts` | Create | Seed creation, show, and metadata mutation commands |
| `src/cli/commands/seeds.ts` | Create | Seed list and consistency-check command |
| `src/cli/commands/shared.ts` | Modify | Shared workspace resolution and output formatting |
| `src/seedbed/types.ts` | Create | Seed, analysis, and enum types |
| `src/seedbed/paths.ts` | Create | Workspace paths, slugging, and ID allocation |
| `src/seedbed/store.ts` | Create | File-backed seed CRUD and archive moves |
| `src/seedbed/attachments.ts` | Create | Attachment import and filename sanitization |
| `src/seedbed/markdown.ts` | Create | `seed.md` serialization |
| `src/seedbed/consistency.ts` | Create | Placement/schema validation for seeds |
| `src/garden/parse.ts` | Modify | Block comments, default blocks, subgraph extraction, scope stack |
| `src/garden/types.ts` | Modify | `Subgraph` type, `classes` on `GardenNode` |
| `test/seedbed/store.test.ts` | Create | Unit tests for store behavior |
| `test/seedbed/attachments.test.ts` | Create | Attachment import tests |
| `test/seedbed/consistency.test.ts` | Create | Inconsistency detection tests |
| `test/garden/parse.test.ts` | Modify | Block comment, default block, subgraph, duration unit tests |
| `test/integration/seed-cli.test.ts` | Create | End-to-end CLI tests for seed creation and triage |
| `test/fixtures/default-blocks.dot` | Create | Fixture using `node [...]` and `edge [...]` default blocks |
| `test/fixtures/subgraph-classes.dot` | Create | Fixture with subgraphs and class-based scoping |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing DOT fixtures parse and validate identically

### Seedbed: Capture & Triage
- [ ] `pollinator seed "text"` creates `seedbed/NNN-slug/` with `seed.md`, `meta.yaml`, `attachments/`, and `analysis/`
- [ ] `pollinator seed` accepts piped stdin (bounded to 1 MB) when no text argument is provided
- [ ] Empty or missing input produces a clear error message
- [ ] `meta.yaml` always contains the required fields from `docs/INTENT.md`
- [ ] `pollinator seed set-status` and `set-priority` update `meta.yaml` atomically and refresh `updated_at`
- [ ] Status changes to `honey` move the directory into `honey/`; non-`honey` statuses move it back to `seedbed/`
- [ ] `pollinator seeds` lists both active and archived seeds and supports basic filtering
- [ ] Invalid seed IDs, statuses, and priorities produce clear error messages
- [ ] The entire seed state is reconstructable from files alone — no hidden DB or sidecar index

### Seedbed: Consistency
- [ ] `pollinator seeds --check` detects placement/schema inconsistencies and exits non-zero when any exist
- [ ] Missing required metadata keys are flagged as inconsistencies

### Seedbed: Attachments
- [ ] Attachments copied with sanitized filenames; collisions get numeric suffixes
- [ ] Attachments exceeding 50 MB are rejected with a clear error
- [ ] Relative markdown links appended to `seed.md`

### DOT Parser: Block Comments (GAP-17)
- [ ] `/* ... */` block comments stripped, including multi-line
- [ ] Block comment delimiters inside string literals not treated as comments
- [ ] Unclosed block comment at EOF produces a parse diagnostic

### DOT Parser: Default Blocks (GAP-13)
- [ ] `node [shape=box, timeout="120s"]` sets baseline attributes for subsequent nodes
- [ ] `edge [weight=0]` sets baseline attributes for subsequent edges
- [ ] Explicit attributes override defaults
- [ ] `node` and `edge` keywords no longer create spurious node entries

### DOT Parser: Subgraphs (GAP-14)
- [ ] `subgraph cluster_X { ... }` boundaries detected and `Subgraph` records created
- [ ] Subgraph label extracted; nodes inside receive derived class
- [ ] Default blocks inside subgraphs are scoped — they don't leak out
- [ ] Nested subgraphs work correctly

### DOT Parser: Duration Units (GAP-20)
- [ ] `parseTimeoutMs` handles `h` and `d` units

### Test Coverage
- [ ] At least 30 new tests across seedbed and parser enhancements

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Concurrent `pollinator seed` commands allocate the same numeric ID | Medium | High | Scan for highest existing ID + atomic `fs.mkdir` that fails on collision + retry with next ID. No lockfile needed. |
| `@ts-graphviz/parser` already handles default blocks/subgraphs in its AST | Medium | Positive | Check library AST output first. If it extracts these, use its output. The facade pattern makes this seamless. |
| `node`/`edge` keyword detection breaks existing fixtures using them as node IDs | Medium | Medium | They're DOT reserved words. Audit all fixtures. Rename any that use them. |
| Manual edits to `meta.yaml` or directory moves create inconsistent state | Medium | Medium | Add explicit consistency checks and make the CLI surface them instead of silently guessing. |
| Attachment filenames collide or contain unsafe characters | Medium | Low | Sanitize names, preserve extensions, add numeric suffixes on collision. Enforce 50 MB size limit. |
| Stdin capture receives unbounded data | Low | Medium | Hard limit at 1 MB. Clear error message on overflow. |
| Sprint combines two independent clusters | Low | Medium | Clusters share zero code. If behind schedule, cut Phases 4-5 (DOT parser) — seedbed ships alone. DOT improvements move to Sprint 009. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `yaml` (npm) | Reading/writing `meta.yaml` | New dev+runtime dependency |
| Existing CLI scaffolding | `commander`, themed renderer | Already in place |
| Node.js 22 fs APIs | Atomic file writes, directory moves | Already available |

No dependency on the coding agent loop, HTTP server mode, LLM client, or structured-output SDK work.

---

## GAP Closure Summary

| GAP | Description | Priority | Status After Sprint |
|-----|-------------|----------|-------------------|
| GAP-13 | Node/Edge Default Blocks | MEDIUM | **Closed** |
| GAP-14 | Subgraph Support | MEDIUM | **Closed** |
| GAP-17 | Block Comment Stripping | LOW | **Closed** |
| GAP-20 | Duration `h` and `d` Units | LOW | **Closed** |

**2 MEDIUM + 2 LOW gaps fully closed.**

Additionally, the Seedbed foundation enables future sprints to close product-layer gaps that currently have 0% implementation.
