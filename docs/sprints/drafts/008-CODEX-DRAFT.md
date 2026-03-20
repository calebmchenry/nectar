# Sprint 008: Seedbed Foundation - Filesystem Capture and Swarm Analysis

## Overview

**Goal:** Deliver the first end-to-end slice of Nectar's Seedbed: capture ideas from the CLI into the filesystem, track canonical state in `meta.yaml`, and generate per-provider swarm analysis files. After this sprint, `pollinator seed "Add rate limiting to the API gateway"` and `pollinator swarm 1` produce a stable on-disk seed that both humans and agents can understand without any database or hidden state.

**Why this sprint, why now:**

The compliance report shows that the core engine is no longer the biggest product bottleneck. Attractor is roughly 75% complete, the coding agent loop is roughly 55% complete, and the unified LLM client is roughly 45% complete. Those gaps still matter, but the INTENT doc makes a more important point: Nectar is not just an attractor implementation. It is also a filesystem-backed idea backlog and a multi-AI analysis tool.

Right now that second pillar does not exist at all. Another sprint on stylesheets, subagents, or SDK plumbing would improve internals, but Nectar would still be unable to capture a single idea. That is the wrong tradeoff. The next sprint should ship the thinnest vertical slice that makes Nectar feel like Nectar.

**Scope - what ships:**

- Filesystem-backed seed creation under `seedbed/NNN-slug/`
- Canonical `meta.yaml` and `seed.md` contracts aligned with `docs/INTENT.md`
- CLI commands for capture, listing, inspection, and status/priority updates
- Attachment import into `attachments/`
- Per-provider swarm analysis writing `analysis/claude.md`, `analysis/codex.md`, and `analysis/gemini.md`
- `analysis_status` tracking with `pending`, `running`, `complete`, `failed`, and `skipped`
- Consistency checks for `meta.yaml.status` vs directory placement (`seedbed/` vs `honey/`)

**Scope - what does not ship:**

- Web UI ("The Hive"), kanban board, timeline view, or synthesis view
- Local HTTP server and browser-facing seed APIs
- Automatic watched-folder ingestion
- Automatic pipeline-driven status transitions from `linked_runs`
- DOT editor work, model stylesheet work, context fidelity work, manager loop, steering, or subagents

---

## Use Cases

1. **Fast capture from the terminal:** A developer has an idea and runs `pollinator seed "Add rate limiting to the API gateway" --priority high --tag api --tag infra`. Nectar creates `seedbed/001-add-rate-limiting-to-the-api-gateway/` with `seed.md`, `meta.yaml`, `attachments/`, and `analysis/`.

2. **Capture from stdin with near-zero friction:** A user dumps rough notes into the tool:
   ```bash
   pbpaste | pollinator seed --title "Prod incident follow-up"
   ```
   The full pasted text is preserved in `seed.md`; the explicit title is used for `meta.yaml.title` and the slug.

3. **Attach supporting files at creation time:** A user runs `pollinator seed "Investigate flaky CI failures" --attach ~/Desktop/failure.png --attach ./logs.txt`. Nectar copies both files into `attachments/`, sanitizes filenames, and appends relative links to `seed.md`.

4. **Triage without opening an editor:** A user runs `pollinator seed set-status 12 sprouting` or `pollinator seed set-priority 12 queens_order`. Nectar updates `meta.yaml`, refreshes `updated_at`, and, when status becomes `honey`, moves the directory to `honey/`.

5. **Run independent AI analysis:** A user runs `pollinator swarm 12`. Nectar sends the seed to Claude, Codex, and Gemini concurrently using the existing LLM client, writes one normalized markdown file per provider, and updates `analysis_status` without aborting the whole command when one provider fails.

6. **Agent-readable filesystem state:** Another AI agent can scan `seedbed/012-flaky-ci-failures/`, read `meta.yaml`, `seed.md`, and `analysis/*.md`, and understand the current priority, state, attachments, and provider opinions without any API call.

7. **Visible consistency problems instead of hidden state:** If a seed sits in `honey/` but `meta.yaml.status` still says `blooming`, `pollinator seeds` shows it as inconsistent instead of silently guessing which one is correct.

---

## Architecture

### Design Principles

**The filesystem is the API.** This sprint does not introduce a database, sqlite file, hidden index, or daemon-owned state. The source of truth is the directory tree described in `docs/INTENT.md`.

**`meta.yaml` is canonical for state, not convenience output.** CLI commands may render themed summaries, but every state transition must converge on `meta.yaml`.

**Analysis is normalized on write.** Models are allowed to produce imperfect markdown, but Nectar should not persist ambiguous analysis documents. The sprint includes a normalizer that enforces front matter keys and required body sections before writing `analysis/*.md`.

**Partial success is normal.** Swarm analysis must tolerate missing API keys or one-provider failures. The command should return a mixed result and update `analysis_status` deterministically.

### Module Layout

```text
src/
├── cli/
│   ├── index.ts                    # Register new seed + swarm commands
│   └── commands/
│       ├── seed.ts                 # pollinator seed ... + subcommands
│       ├── seeds.ts                # pollinator seeds
│       ├── swarm.ts                # pollinator swarm <id>
│       └── shared.ts               # Workspace path helpers, shared output
├── seedbed/
│   ├── types.ts                    # SeedMeta, AnalysisMeta, enums
│   ├── paths.ts                    # Workspace layout, ID allocation, slugging
│   ├── store.ts                    # Create/read/list/update/move seeds
│   ├── attachments.ts              # Copy + sanitize attachment imports
│   ├── markdown.ts                 # seed.md + analysis markdown serialization
│   ├── analysis.ts                 # SwarmAnalyzer orchestration
│   └── consistency.ts              # Placement/state mismatch detection
└── llm/
    └── client.ts                   # Reused as-is via UnifiedClient.from_env()

test/
├── seedbed/
│   ├── store.test.ts
│   ├── attachments.test.ts
│   ├── analysis.test.ts
│   └── consistency.test.ts
└── integration/
    ├── seed-cli.test.ts
    └── swarm-cli.test.ts
```

### Key Abstractions

**`WorkspacePaths`** - Resolves the workspace root and the canonical directories for `seedbed/`, `honey/`, and `.nectar/`. This sprint assumes the current working directory is the workspace root. Later HTTP server work can reuse the same path resolver.

**`SeedStore`** - File-backed repository for seeds. Responsibilities:

- Allocate the next numeric ID using an atomic lock in `.nectar/locks/seed-id.lock`
- Generate a stable slug from the title
- Create `seed.md`, `meta.yaml`, `attachments/`, and `analysis/`
- Read and list seeds from both `seedbed/` and `honey/`
- Update metadata fields and move directories when status changes between active and archived states

**`SeedMeta`** - Canonical metadata contract:

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

Every CLI command that mutates a seed rewrites this file atomically and bumps `updated_at`.

**`SwarmAnalyzer`** - Runs independent provider analyses concurrently with `Promise.allSettled()`. Provider mapping is product-facing rather than SDK-facing:

- `anthropic` -> `claude.md`
- `openai` -> `codex.md`
- `gemini` -> `gemini.md`

The analyzer uses `UnifiedClient.generateUnified()` directly. It does not use the coding agent loop. Each provider gets a stable prompt template and a default model from the existing provider profile definitions.

**`AnalysisNormalizer`** - Validates and rewrites provider output into Nectar's required format:

- YAML front matter fields: `provider`, `generated_at`, `status`, `recommended_priority`, `estimated_complexity`, `feasibility`
- Required markdown sections: `Summary`, `Implementation Approach`, `Risks`, `Open Questions`

Nectar should not trust model-generated timestamps or status values. It should set those fields locally and treat the model output as body content to normalize.

**`ConsistencyCheck`** - Reports mismatches between directory placement and `meta.yaml.status`. This sprint does not auto-heal manual edits silently. It surfaces inconsistencies in CLI output and returns non-zero from `pollinator seeds --check`.

### Command Surface

```text
pollinator seed <text?>
pollinator seed show <id>
pollinator seed set-status <id> <status>
pollinator seed set-priority <id> <priority>
pollinator seeds [--status <status>] [--priority <priority>] [--check]
pollinator swarm <id>
```

`pollinator seed` behavior:

- If `<text>` is provided, use it as the body.
- If no `<text>` is provided and stdin is piped, read stdin.
- `--title` overrides the derived title.
- `--attach <path>` may be passed multiple times.
- `--tag <tag>` may be passed multiple times.

### Data Flow

```text
pollinator seed
    │
    ▼
SeedStore.create()
    │
    ├── allocate next ID
    ├── slugify title
    ├── create seed directory
    ├── write seed.md
    ├── write meta.yaml
    └── copy attachments/

pollinator swarm <id>
    │
    ▼
SeedStore.get()
    │
    ▼
SwarmAnalyzer.run()
    │
    ├── set analysis_status.* = running
    ├── run Claude / Codex / Gemini in parallel
    ├── normalize each result to analysis/*.md
    └── set analysis_status.* = complete|failed|skipped
```

---

## Implementation Phases

### Phase 1: Workspace Layout, Schema, and Seed Store (~25%)

**Files:** `package.json`, `src/seedbed/types.ts`, `src/seedbed/paths.ts`, `src/seedbed/store.ts`, `src/seedbed/markdown.ts`, `test/seedbed/store.test.ts`

**Tasks:**

- [ ] Add a YAML dependency for reading and writing `meta.yaml`
- [ ] Define enums and types:
  - `SeedStatus = 'seedling' | 'sprouting' | 'blooming' | 'honey' | 'wilted'`
  - `SeedPriority = 'low' | 'normal' | 'high' | 'queens_order'`
  - `AnalysisStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'`
- [ ] Implement `WorkspacePaths.fromCwd()` returning absolute paths for `seedbed/`, `honey/`, `.nectar/`, and `.nectar/locks/`
- [ ] Implement atomic next-ID allocation with a lock file so concurrent `pollinator seed` commands do not mint the same ID
- [ ] Implement deterministic slug generation:
  - Lowercase ASCII
  - Replace non-alphanumeric runs with `-`
  - Trim leading/trailing `-`
  - Truncate to 48 chars
- [ ] Implement `SeedStore.create()`:
  - Derive `title` from `--title` or the first non-empty line of the body
  - Create `seedbed/NNN-slug/`
  - Write `seed.md`
  - Write `meta.yaml`
  - Create empty `attachments/` and `analysis/`
- [ ] Implement `SeedStore.get()`, `list()`, and `updateMeta()`
- [ ] Make `updateMeta()` move the seed directory between `seedbed/` and `honey/` when status crosses the archive boundary
- [ ] Use temp-file + rename writes for `meta.yaml` and markdown files
- [ ] Tests: ID allocation, slugging, create/read/list, archive moves, atomic writes

### Phase 2: CLI Capture, Inspection, and Triage (~25%)

**Files:** `src/cli/index.ts`, `src/cli/commands/seed.ts`, `src/cli/commands/seeds.ts`, `src/cli/commands/shared.ts`, `src/seedbed/attachments.ts`, `test/seedbed/attachments.test.ts`, `test/integration/seed-cli.test.ts`

**Tasks:**

- [ ] Register `seed` and `seeds` commands in `src/cli/index.ts`
- [ ] Implement `pollinator seed <text?>`:
  - Read text argument or piped stdin
  - Flags: `--title`, `--priority`, `--tag`, `--attach`
  - Default priority: `normal`
  - Default status: `seedling`
- [ ] Implement `pollinator seed show <id>`:
  - Print title, status, priority, tags, timestamps, linked files, and analysis summary
  - Print raw `seed.md` content after metadata
- [ ] Implement `pollinator seed set-status <id> <status>`
- [ ] Implement `pollinator seed set-priority <id> <priority>`
- [ ] Implement `pollinator seeds` list view:
  - Show `id`, `title`, `status`, `priority`, and provider analysis completion summary
  - Support `--status`, `--priority`, and `--check`
- [ ] Implement attachment import:
  - Copy files into `attachments/`
  - Sanitize filenames and add numeric suffixes on collision
  - Append relative markdown links under an `## Attachments` section in `seed.md`
- [ ] Keep CLI output themed but pipe-friendly
- [ ] Tests: stdin capture, attachment copying, duplicate filename handling, list filtering, archive move on `set-status honey`

### Phase 3: Swarm Analysis Runner (~30%)

**Files:** `src/cli/commands/swarm.ts`, `src/seedbed/analysis.ts`, `src/seedbed/markdown.ts`, `test/seedbed/analysis.test.ts`, `test/integration/swarm-cli.test.ts`

**Tasks:**

- [ ] Register `pollinator swarm <id>`
- [ ] Build a provider-neutral analysis prompt requiring:
  - Feasibility assessment
  - Suggested implementation approach
  - Estimated complexity
  - Risks
  - Open questions
  - Recommended priority
- [ ] Reuse existing provider profile defaults to choose one default model per provider
- [ ] Run analyses concurrently with `Promise.allSettled()`
- [ ] Before the run, set all attempted providers to `analysis_status.* = running`
- [ ] For each provider:
  - If credentials are absent, mark `skipped`
  - If generation succeeds, normalize output and write `analysis/{provider_alias}.md`
  - If generation fails or normalization fails, write `analysis/{provider_alias}.md` with `status: failed` and the failure reason in the body
- [ ] Normalize every analysis document to this contract:
  ```md
  ---
  provider: codex
  generated_at: 2026-03-20T03:15:00Z
  status: complete
  recommended_priority: high
  estimated_complexity: medium
  feasibility: high
  ---

  # Summary

  ...

  # Implementation Approach

  ...

  # Risks

  ...

  # Open Questions

  ...
  ```
- [ ] Update `meta.yaml.analysis_status` after each provider completes so partial results survive interruption
- [ ] Tests with scripted or simulation adapters only; no network in CI

### Phase 4: Consistency Checks, Repair Signals, and Finish Quality (~20%)

**Files:** `src/seedbed/consistency.ts`, `src/cli/commands/seed.ts`, `src/cli/commands/seeds.ts`, `test/seedbed/consistency.test.ts`, `test/integration/seed-cli.test.ts`

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
- [ ] Run the full test suite and confirm the new seedbed commands are clean in both TTY and non-TTY mode

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add YAML dependency and any new scripts needed for seedbed tests |
| `src/cli/index.ts` | Modify | Register new `seed`, `seeds`, and `swarm` commands |
| `src/cli/commands/seed.ts` | Create | Seed creation, show, and metadata mutation commands |
| `src/cli/commands/seeds.ts` | Create | Seed list and consistency-check command |
| `src/cli/commands/swarm.ts` | Create | Swarm analysis command |
| `src/cli/commands/shared.ts` | Modify | Shared workspace resolution and output formatting |
| `src/seedbed/types.ts` | Create | Seed, analysis, and enum types |
| `src/seedbed/paths.ts` | Create | Workspace paths, slugging, and ID allocation |
| `src/seedbed/store.ts` | Create | File-backed seed CRUD and archive moves |
| `src/seedbed/attachments.ts` | Create | Attachment import and filename sanitization |
| `src/seedbed/markdown.ts` | Create | `seed.md` and normalized analysis markdown writers |
| `src/seedbed/analysis.ts` | Create | Multi-provider analysis orchestration |
| `src/seedbed/consistency.ts` | Create | Placement/schema validation for seeds |
| `test/seedbed/store.test.ts` | Create | Unit tests for store behavior |
| `test/seedbed/attachments.test.ts` | Create | Attachment import tests |
| `test/seedbed/analysis.test.ts` | Create | Analysis normalization and provider-result tests |
| `test/seedbed/consistency.test.ts` | Create | Inconsistency detection tests |
| `test/integration/seed-cli.test.ts` | Create | End-to-end CLI tests for seed creation and triage |
| `test/integration/swarm-cli.test.ts` | Create | End-to-end CLI tests for swarm analysis |

---

## Definition of Done

- [ ] `pollinator seed "text"` creates `seedbed/NNN-slug/` with `seed.md`, `meta.yaml`, `attachments/`, and `analysis/`
- [ ] `pollinator seed` accepts piped stdin when no text argument is provided
- [ ] `meta.yaml` always contains the required fields from `docs/INTENT.md`
- [ ] `pollinator seed set-status` and `set-priority` update `meta.yaml` atomically and refresh `updated_at`
- [ ] Status changes to `honey` move the directory into `honey/`; non-`honey` statuses move it back to `seedbed/`
- [ ] `pollinator seeds` lists both active and archived seeds and supports basic filtering
- [ ] `pollinator seeds --check` detects placement/schema inconsistencies and exits non-zero when any exist
- [ ] `pollinator swarm <id>` writes one normalized markdown file per provider alias (`claude.md`, `codex.md`, `gemini.md`)
- [ ] Missing provider credentials produce `skipped`, provider failures produce `failed`, and successful providers still complete in the same run
- [ ] All analysis files include required front matter and required body sections, even in failure cases
- [ ] The entire seed state remains reconstructable from files alone; there is no hidden DB or sidecar index
- [ ] `npm test` passes with the new seedbed unit and integration tests

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Concurrent `pollinator seed` commands allocate the same numeric ID | Medium | High | Use an atomic lock file in `.nectar/locks/` and create the final seed directory with `mkdir` semantics that fail on collision |
| LLM responses do not follow the requested analysis format | High | Medium | Normalize output locally, synthesize missing front matter, and write explicit failure documents when required sections cannot be recovered |
| One provider is down or unconfigured, causing the whole swarm command to fail | High | Medium | Run providers independently with `Promise.allSettled()` and update `analysis_status` per provider |
| Manual edits to `meta.yaml` or directory moves create inconsistent state | Medium | Medium | Add explicit consistency checks and make the CLI surface them instead of silently guessing |
| Attachment filenames collide or contain unsafe characters | Medium | Low | Sanitize names, preserve extensions, and add numeric suffixes on collision |

---

## Dependencies

- Existing `UnifiedClient.from_env()` provider routing and simulation fallback
- Existing CLI scaffolding with `commander` and current themed renderer behavior
- Node.js 22 filesystem APIs for atomic file writes and directory moves
- A new YAML dependency for `meta.yaml` serialization
- No dependency on the coding agent loop, HTTP server mode, or structured-output SDK work

