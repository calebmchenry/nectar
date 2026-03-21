# Sprint 021: Seedbed & Swarm Intelligence — Browser Backlog, Multi-AI Analysis, and Compliance Quick Wins

## Overview

**Goal:** Ship the browser Seedbed (idea capture, Kanban triage, seed detail) and Swarm Intelligence (concurrent multi-provider analysis with side-by-side comparison), plus close GAP-7 and GAP-8 as zero-risk compliance fixes. After this sprint, all three pillars of Nectar described in INTENT.md are functional in the browser.

**Why this sprint, why now:**

1. **Two of Nectar's three pillars are invisible in the browser.** INTENT.md §2B (Seedbed) and §2C-iii (Swarm Intelligence) are the features that differentiate Nectar from a generic pipeline runner. Sprint 020 shipped the Garden workbench. The Seedbed and Swarm are the next complete vertical slice — and the one that makes Nectar feel like its own product rather than a DOT file viewer.

2. **The backend is already there.** Sprint 019 shipped seed CRUD routes (`GET/POST/PATCH /seeds`, `GET/POST /seeds/:id/attachments`), workspace SSE, and the filesystem seed model. Sprint 008 built the CLI seedbed foundation. The unified LLM client has `generateObject<T>()` for structured analysis output. This sprint is composition and productization, not foundational infrastructure.

3. **Swarm Intelligence is the killer feature.** Getting three independent AI perspectives on an idea — with structured, comparable output — is something no other tool does well. It's also technically straightforward: fan out to three providers via `Promise.allSettled()`, write deterministic Markdown files, and display them. The hard parts (LLM client, structured output, seed filesystem model) are already built.

4. **GAP-7 and GAP-8 are free.** GAP-7 is three constant changes in one file. GAP-8 is a focused algorithm rewrite in one file. Both are independently testable, have no downstream dependencies, and take less than an hour combined. Bundling them here avoids a future "gap cleanup" sprint for trivial fixes.

5. **The remaining compliance gaps (1-6) are deliberately deferred.** GAP-1 (AUDIO/DOCUMENT types), GAP-2 (error subtypes), GAP-3 (OpenAI-compatible adapter), GAP-4 (Gemini tools), GAP-5 (custom transforms), and GAP-6 (sub-pipeline composition) are each real but none blocks a user workflow today. They belong in a dedicated compliance sprint after the product surface is complete.

**Gaps closed:**

| Gap | Type | Effort | Why it belongs here |
|-----|------|--------|---------------------|
| Missing Hive Seedbed UI | Product | Large | 2nd product pillar, unshipped |
| Missing Swarm Intelligence | Product | Medium | 3rd product pillar, core differentiator |
| GAP-7: Tool output limits | Compliance | Trivial | 3 constant changes, zero risk |
| GAP-8: Loop detection patterns | Compliance | Small | 1 file rewrite, independently testable |

**In scope:**

- Seedbed view in the Hive with five-column Kanban board
- Browser seed capture: title, body, tags, priority, file attachments
- Seed detail drawer with rendered Markdown, attachments, and analysis cards
- Drag-and-drop status transitions with optimistic UI
- `SwarmAnalysisService` — fan-out to Claude, Codex, and Gemini with `generateObject<T>()`
- `POST /seeds/:id/analyze` background job endpoint
- Deterministic `analysis/{provider}.md` files following INTENT.md's analysis contract
- Server-computed synthesis endpoint (`GET /seeds/:id/synthesis`)
- Workspace SSE events for live analysis progress
- GAP-7: Correct tool output char limits (glob→20K, edit_file→10K, apply_patch→10K)
- GAP-8: Multi-step loop detection (patterns of length 1, 2, 3 in window of 10)

**Out of scope:**

- Timeline view, list/table view (Kanban only this sprint)
- Automatic seed-to-pipeline linking and run-driven status transitions
- Audio/video transcription of attachments
- Automatic watched-folder ingestion
- Dark mode for Seedbed components
- GAP-1 through GAP-6 (deferred to a compliance sprint)
- React or router rewrite of the Hive (extend the current DOM component model)

**Cut line:** If time compresses, cut the synthesis endpoint, provider-specific rerun buttons, and within-column card reordering. Do **not** cut seed creation, Kanban board, drag-and-drop status changes, analysis file writing, or the side-by-side comparison panel.

---

## Use Cases

1. **Switch to the Seedbed.** User clicks "Seedbed" in the Hive nav. The left rail shows seed counts by status and priority. The center shows the Kanban board. The right column shows the detail drawer for the selected seed.

2. **Capture an idea fast.** User types a title and body, picks "high" priority, adds two tags, drops in a screenshot. Clicks "Plant Seed." Nectar creates the seed directory, writes `seed.md` and `meta.yaml`, uploads the attachment, and optionally kicks off Swarm analysis. The new card appears in the Seedling column immediately.

3. **Triage by dragging.** User drags a card from Seedling to Sprouting. The card moves instantly (optimistic). `PATCH /seeds/:id` writes the new status to `meta.yaml`. If the server rejects it, the card snaps back.

4. **Read a seed in detail.** User clicks a seed card. The detail drawer shows rendered `seed.md`, attached files with download links and image thumbnails, `meta.yaml` metadata, and per-provider analysis cards (or "pending" / "not yet analyzed" states).

5. **Trigger Swarm analysis.** User clicks "Analyze" on a seed. `POST /seeds/:id/analyze` starts background jobs for each configured provider. The UI shows per-provider progress badges updating live via workspace SSE. As each provider completes, its analysis card populates in the detail drawer.

6. **Compare AI perspectives.** Three analysis cards appear side-by-side: Claude, Codex, Gemini. Each shows recommended priority, complexity, feasibility, and the four required Markdown sections. A synthesis banner highlights consensus and divergences.

7. **Handle missing providers gracefully.** Only Anthropic and OpenAI keys are configured. Gemini's analysis writes `status: skipped` with an explanation. The comparison view shows two complete cards and one "skipped" card. No errors, no blocking.

8. **Handle provider failures gracefully.** OpenAI times out. Its analysis writes `status: failed` with the error. The user can rerun just OpenAI later. Claude and Gemini results are unaffected.

9. **Archive completed work.** User drags a card to Honey. The seed directory moves from `seedbed/` to `honey/`. The card disappears from the active board.

10. **Reload without losing context.** The selected seed and view mode are in URL params. Refreshing rehydrates the board, reconnects workspace SSE, and restores the detail drawer.

---

## Architecture

### Design Principles

1. **Extend, don't rewrite.** The Hive is a Vite + TypeScript + DOM-component app. This sprint adds Seedbed components alongside the existing Garden components. No framework change.

2. **Filesystem canonical.** All seed state lives in `seed.md`, `meta.yaml`, `attachments/`, and `analysis/`. The browser is a view layer. The server is the write path.

3. **Analysis is async and observable.** Seed creation is fast. Analysis runs in the background. Progress is pushed via workspace SSE, not polled.

4. **Failure is data, not absence.** Failed and skipped providers write deterministic analysis files. The UI never needs to infer state from missing files.

5. **One write path for `meta.yaml`.** All mutations (user edits, status drags, analysis-status updates) flow through `SeedStore` patch methods to prevent races.

### Swarm Analysis Flow

```text
Hive Seed Composer / Detail Drawer
    │
    ├── POST /seeds (create)
    ├── POST /seeds/:id/attachments (upload)
    └── POST /seeds/:id/analyze
             │
             ▼
        SwarmManager (dedup, lifecycle)
             │
             ▼
    SwarmAnalysisService
      ├── load seed.md + meta.yaml + attachment metadata
      ├── set analysis_status.{provider} = running
      ├── fan-out: generateObject<SeedAnalysis>() per provider
      ├── write analysis/{provider}.md (YAML front matter + 4 sections)
      ├── set analysis_status.{provider} = complete|failed|skipped
      └── emit workspace events per provider
             │
             ▼
      /events SSE → Hive updates live
      GET /seeds/:id → full seed with parsed analyses
      GET /seeds/:id/synthesis → consensus/divergence
```

### Analysis Document Contract

Each `analysis/{provider}.md` follows INTENT.md's contract:

```markdown
---
provider: claude
generated_at: 2026-03-21T16:00:00Z
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

The structured front matter enables the synthesis endpoint to compute agreement/divergence without parsing Markdown bodies. The four body sections are required for human readability.

### Analysis Prompt Design

The prompt sent to each provider is structured and bounded:

- **Always included:** seed title, body text, tags, priority, attachment filenames with types/sizes
- **Conditionally included:** inline image attachments (only when the provider supports image input)
- **Never included:** raw binary attachments, audio, video
- **Capped:** total prompt content bounded to prevent runaway token costs
- **Output schema:** strict JSON via `generateObject<SeedAnalysis>()` with the six front-matter fields plus four Markdown section strings

Design choice: **single `generateObject` call per provider.** The structured output schema includes both the normalized fields (priority, complexity, feasibility) and the four Markdown section strings. This keeps the analysis atomic — one call, one file, one status update — and avoids the complexity of correlating two separate LLM calls. Modern models produce good prose even within a JSON schema when the schema uses `string` fields for the body sections.

### Synthesis Algorithm

The `GET /seeds/:id/synthesis` endpoint is computed server-side, not persisted:

1. Collect all `status: complete` analysis documents
2. For each normalized field (`recommended_priority`, `estimated_complexity`, `feasibility`):
   - If all providers agree → `consensus`
   - If majority agrees → `majority` with the outlier noted
   - Otherwise → `divergence` with all values
3. Return the structured result. No fourth model call.

### Backend Additions

| Component | Location | Purpose |
|-----------|----------|---------|
| `SwarmAnalysisService` | `src/runtime/swarm-analysis-service.ts` | Orchestrate per-provider analysis with structured output |
| `SwarmManager` | `src/server/swarm-manager.ts` | One active job per seed, dedup, lifecycle |
| `AnalysisDocument` | `src/seedbed/analysis-document.ts` | Parse/render/validate analysis Markdown files |
| `SynthesisService` | `src/seedbed/synthesis.ts` | Compute consensus/divergence from normalized fields |
| `WorkspaceEventBus` | `src/server/workspace-event-bus.ts` | Semantic events for seed and analysis lifecycle |

### API Contracts

**`PATCH /seeds/:id`** — Expand to support `title`, `body`, `status`, `priority`, `tags`:

```json
{ "title": "...", "body": "...", "status": "sprouting", "priority": "high", "tags": ["api"] }
```

All fields optional. Title edits update both `meta.yaml` and `seed.md` heading.

**`POST /seeds/:id/analyze`** — Start background swarm:

```json
{ "providers": ["claude", "codex", "gemini"], "force": false }
```

Returns `202 Accepted`. `force=false` skips `complete` providers. Deduplicates in-flight jobs.

**`GET /seeds/:id`** — Extended to return parsed analysis docs:

```json
{
  "meta": { "..." },
  "seed_md": "...",
  "attachments": [{ "filename": "screenshot.png", "url": "/seeds/42/attachments/screenshot.png" }],
  "analyses": [{ "provider": "claude", "status": "complete", "recommended_priority": "high", "body_md": "..." }]
}
```

**`GET /seeds/:id/synthesis`** — Computed consensus/divergence:

```json
{
  "consensus": { "recommended_priority": "high", "feasibility": "high" },
  "divergences": [{ "field": "estimated_complexity", "values": { "claude": "medium", "gemini": "high" } }],
  "available_providers": ["claude", "codex", "gemini"]
}
```

### Module Layout

```text
src/
├── runtime/
│   └── swarm-analysis-service.ts       # Provider fan-out and structured output
├── server/
│   ├── swarm-manager.ts                # Job dedup and lifecycle
│   ├── workspace-event-bus.ts          # Semantic events for seed/analysis
│   └── routes/
│       ├── seeds.ts                    # Expand detail/edit + analyze endpoint
│       └── events.ts                   # Merge semantic events with file watch
├── seedbed/
│   ├── analysis-document.ts            # Parse/render analysis Markdown
│   └── synthesis.ts                    # Compute agreement/divergence
├── agent-loop/
│   ├── types.ts                        # GAP-7: fix output limits
│   └── loop-detection.ts              # GAP-8: multi-step patterns

hive/src/
├── App.ts                              # Add Seedbed mode
├── lib/
│   ├── api.ts                          # Add seed/analysis client methods
│   └── workspace-stream.ts             # EventSource for workspace events
├── components/
│   ├── ViewNav.ts                      # Gardens ↔ Seedbed switcher
│   ├── SeedComposer.ts                 # Quick capture form + upload
│   ├── SeedBoard.ts                    # Five-column Kanban
│   ├── SeedColumn.ts                   # Single status column
│   ├── SeedCard.ts                     # Draggable card
│   ├── SeedDetail.ts                   # Detail drawer
│   └── SwarmCompare.ts                 # Side-by-side analysis + synthesis
└── styles/
    └── app.css                         # Seedbed styles, status colors

test/
├── runtime/
│   └── swarm-analysis-service.test.ts
├── seedbed/
│   ├── analysis-document.test.ts
│   └── synthesis.test.ts
├── server/
│   ├── seeds-analyze.test.ts
│   └── workspace-events.test.ts
├── agent-loop/
│   └── loop-detection.test.ts          # GAP-8 coverage
└── integration/
    └── hive-seedbed-flow.test.ts
```

---

## Implementation

### Phase 1: Compliance Quick Wins — GAP-7 and GAP-8 (~5%)

**Files:** `src/agent-loop/types.ts`, `src/agent-loop/loop-detection.ts`, `test/agent-loop/loop-detection.test.ts`

**Tasks:**
- [ ] Change default char limits in `src/agent-loop/types.ts`: `glob: 10000→20000`, `edit_file: 5000→10000`, `apply_patch: 5000→10000`
- [ ] Rewrite `src/agent-loop/loop-detection.ts` to use a sliding window of 10 fingerprints and check for repeating patterns of length 1, 2, and 3 per the spec algorithm
- [ ] Add tests: single-step repeat (AAAAAA), two-step repeat (ABABAB), three-step repeat (ABCABCABC), non-repeating sequences, window boundary conditions
- [ ] Verify existing loop detection tests still pass with the new algorithm

### Phase 2: Seed Write Model and Server Surface (~15%)

**Files:** `src/seedbed/store.ts`, `src/seedbed/analysis-document.ts`, `src/seedbed/synthesis.ts`, `src/server/routes/seeds.ts`, `test/seedbed/analysis-document.test.ts`, `test/seedbed/synthesis.test.ts`, `test/server/seeds-analyze.test.ts`

**Tasks:**
- [ ] Extend `SeedStore` with a general patch API: update `title`, `body`, `status`, `priority`, `tags` atomically without clobbering `linked_*` or `analysis_status`
- [ ] Ensure title edits update both `meta.yaml.title` and the `# heading` in `seed.md`
- [ ] Implement `AnalysisDocument`: parse YAML front matter from `analysis/{provider}.md`, validate required fields, render complete/failed/skipped documents deterministically
- [ ] Implement `SynthesisService`: compute consensus/majority/divergence from completed analysis front matter
- [ ] Expand `PATCH /seeds/:id` to support `title` and `body` fields
- [ ] Expand `GET /seeds/:id` to return parsed analysis documents and structured attachment metadata
- [ ] Add `GET /seeds/:id/synthesis` endpoint
- [ ] Keep the `honey/` archive move rule intact for status transitions
- [ ] Add server contract tests for the expanded seed surface and synthesis

### Phase 3: Swarm Analysis Engine (~20%)

**Files:** `src/runtime/swarm-analysis-service.ts`, `src/server/swarm-manager.ts`, `src/server/workspace-event-bus.ts`, `src/server/routes/seeds.ts`, `src/server/routes/events.ts`, `test/runtime/swarm-analysis-service.test.ts`, `test/server/workspace-events.test.ts`

**Tasks:**
- [ ] Create `SwarmManager`: track active jobs per seed, reject duplicate analyze requests, expose job status
- [ ] Create `SwarmAnalysisService`:
  - [ ] Load seed content (title, body, tags, priority, attachment metadata)
  - [ ] Map user-facing targets (`claude`, `codex`, `gemini`) to LLM provider names
  - [ ] Build structured analysis prompt with bounded token content
  - [ ] Define `SeedAnalysis` JSON schema for `generateObject<T>()` — includes both normalized fields and Markdown section strings
  - [ ] Fan out with `Promise.allSettled()` — each provider runs independently
  - [ ] On success: write `analysis/{provider}.md` with full front matter and four body sections
  - [ ] On missing credentials: write `status: skipped` document with explanation
  - [ ] On failure: write `status: failed` document preserving error summary
  - [ ] Update `meta.yaml` `analysis_status` via `SeedStore` patch after each provider completes
- [ ] Add `POST /seeds/:id/analyze` returning `202 Accepted`
- [ ] Support `force=true` to overwrite existing complete analyses
- [ ] Create `WorkspaceEventBus`: in-process event emitter for semantic events
- [ ] Emit `seed_analysis_started`, `seed_analysis_provider_completed`, `seed_analysis_completed` events
- [ ] Merge workspace events into the `/events` SSE stream alongside file-watch events
- [ ] Recover stale `analysis_status=running` on server boot by rewriting to `failed`
- [ ] Add unit tests using the simulation adapter for all analysis paths

### Phase 4: Hive Seedbed UI (~50%)

**Files:** `hive/src/App.ts`, `hive/src/lib/api.ts`, `hive/src/lib/workspace-stream.ts`, `hive/src/components/ViewNav.ts`, `hive/src/components/SeedComposer.ts`, `hive/src/components/SeedBoard.ts`, `hive/src/components/SeedColumn.ts`, `hive/src/components/SeedCard.ts`, `hive/src/components/SeedDetail.ts`, `hive/src/components/SwarmCompare.ts`, `hive/src/styles/app.css`

**Tasks:**
- [ ] Add `ViewNav` component: Gardens ↔ Seedbed switcher, persisted in URL params
- [ ] Extend `api.ts` with seed CRUD, attachment upload, analyze trigger, and synthesis client methods
- [ ] Build `WorkspaceStream`: EventSource wrapper for `/events` with typed seed/analysis events
- [ ] Build `SeedComposer`:
  - [ ] Title input, body textarea, tag chips, priority dropdown
  - [ ] Attachment drop zone (drag files or click to browse)
  - [ ] "Analyze now" checkbox (default checked)
  - [ ] Create → `POST /seeds` + `POST /seeds/:id/attachments` + optionally `POST /seeds/:id/analyze`
- [ ] Build `SeedBoard` as five-column Kanban:
  - [ ] Columns: Seedling (sage green), Sprouting (lavender), Blooming (coral), Honey (golden), Wilted (warm gray)
  - [ ] Column header with count badge
  - [ ] Load seeds from `GET /seeds` and group by status
- [ ] Build `SeedCard`: title, priority indicator, tag pills, analysis status dots
- [ ] Implement native HTML drag-and-drop for cross-column moves:
  - [ ] `dragstart` sets seed ID in dataTransfer
  - [ ] `dragover`/`drop` on columns triggers `PATCH /seeds/:id` with new status
  - [ ] Optimistic UI: move card immediately, snap back on server error
- [ ] Build `SeedDetail` drawer:
  - [ ] Rendered `seed.md` (sanitize HTML before insertion)
  - [ ] Attachment list with download links and thumbnails for images
  - [ ] Metadata section showing tags, priority, timestamps
  - [ ] "Analyze" / "Rerun" action button
  - [ ] Per-provider analysis status badges
- [ ] Build `SwarmCompare` panel:
  - [ ] Three provider cards side-by-side with normalized fields at the top
  - [ ] Expandable Markdown body sections below each card
  - [ ] Synthesis banner showing consensus (green) and divergences (amber)
  - [ ] Skipped/failed provider cards with explanation text
- [ ] Subscribe to workspace SSE so analysis progress updates live in both the board (status dots) and detail drawer (provider cards)
- [ ] Persist `view=seedbed`, selected `seed`, and scroll position in URL search params
- [ ] Apply INTENT.md's watercolor-botanical palette: status columns use semantic accent colors, cards use warm off-white backgrounds, analysis badges use provider-specific subtle tints

### Phase 5: Integration and Build Verification (~10%)

**Files:** `test/integration/hive-seedbed-flow.test.ts`, `package.json`

**Tasks:**
- [ ] Integration test: create seed → upload attachment → trigger analyze → verify analysis files on disk → verify synthesis endpoint → move to honey
- [ ] Verify Garden workbench still works (no regressions from adding Seedbed view)
- [ ] Verify `npm run build` succeeds with expanded Hive assets embedded
- [ ] Verify `npm test` is green across all new and existing suites
- [ ] Verify `bun build --compile src/cli/index.ts --outfile /tmp/nectar-smoke` produces a working binary with the Seedbed UI

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/types.ts` | Modify | GAP-7: correct tool output char limits |
| `src/agent-loop/loop-detection.ts` | Modify | GAP-8: multi-step pattern detection |
| `src/seedbed/analysis-document.ts` | Create | Parse/render/validate analysis Markdown files |
| `src/seedbed/synthesis.ts` | Create | Compute consensus/divergence from analysis front matter |
| `src/seedbed/store.ts` | Modify | Expand patch API for title, body, tags |
| `src/runtime/swarm-analysis-service.ts` | Create | Fan-out structured analysis to multiple providers |
| `src/server/swarm-manager.ts` | Create | Deduplicate active analysis jobs per seed |
| `src/server/workspace-event-bus.ts` | Create | Semantic events for seed and analysis lifecycle |
| `src/server/routes/seeds.ts` | Modify | Add analyze endpoint, expand detail/edit surface |
| `src/server/routes/events.ts` | Modify | Merge semantic workspace events with file-watch |
| `hive/src/App.ts` | Modify | Add Seedbed mode and view routing |
| `hive/src/lib/api.ts` | Modify | Add seed/analyze/synthesis client methods |
| `hive/src/lib/workspace-stream.ts` | Create | EventSource wrapper for workspace events |
| `hive/src/components/ViewNav.ts` | Create | Gardens ↔ Seedbed view switcher |
| `hive/src/components/SeedComposer.ts` | Create | Quick-capture form with attachment upload |
| `hive/src/components/SeedBoard.ts` | Create | Five-column Kanban container |
| `hive/src/components/SeedColumn.ts` | Create | Single status column |
| `hive/src/components/SeedCard.ts` | Create | Draggable seed card |
| `hive/src/components/SeedDetail.ts` | Create | Seed detail drawer |
| `hive/src/components/SwarmCompare.ts` | Create | Side-by-side analysis comparison + synthesis |
| `hive/src/styles/app.css` | Modify | Seedbed layout, Kanban columns, status accent colors |
| `test/agent-loop/loop-detection.test.ts` | Modify | GAP-8 multi-step pattern tests |
| `test/seedbed/analysis-document.test.ts` | Create | Analysis parse/render tests |
| `test/seedbed/synthesis.test.ts` | Create | Consensus/divergence computation tests |
| `test/runtime/swarm-analysis-service.test.ts` | Create | Provider fan-out tests (simulation adapter) |
| `test/server/seeds-analyze.test.ts` | Create | Analyze endpoint contract tests |
| `test/server/workspace-events.test.ts` | Create | Workspace SSE event tests |
| `test/integration/hive-seedbed-flow.test.ts` | Create | End-to-end seedbed + swarm flow |

---

## Definition of Done

### Seedbed UI
- [ ] The Hive has a Gardens ↔ Seedbed view switcher
- [ ] Seeds load from `GET /seeds` and display in a five-column Kanban board grouped by status
- [ ] A user can create a seed from the browser with title, body, tags, priority, and attachments
- [ ] Dragging a card between columns updates `meta.yaml` status via `PATCH /seeds/:id`
- [ ] Dragging to Honey moves the seed directory from `seedbed/` to `honey/`
- [ ] Clicking a card opens a detail drawer with rendered seed content, attachments, and analysis cards
- [ ] Refreshing the page rehydrates the board and selected seed from URL params

### Swarm Intelligence
- [ ] `POST /seeds/:id/analyze` starts background analysis for configured providers and returns 202
- [ ] Duplicate analyze requests for the same seed are deduplicated
- [ ] Each provider writes exactly one `analysis/{provider}.md` with valid YAML front matter and four required sections
- [ ] Missing credentials produce `status: skipped` files; failures produce `status: failed` files; neither blocks other providers
- [ ] Analysis progress updates appear live in the browser via workspace SSE
- [ ] The detail drawer shows three provider cards side-by-side with normalized fields
- [ ] `GET /seeds/:id/synthesis` returns computed consensus/divergence data
- [ ] The synthesis banner displays in the comparison panel

### Compliance
- [ ] GAP-7: Tool output char limits match spec (glob: 20K, edit_file: 10K, apply_patch: 10K)
- [ ] GAP-8: Loop detection catches repeating patterns of length 1, 2, and 3 in a window of 10 calls
- [ ] All new and existing tests pass via `npm test`

### Build
- [ ] `npm run build` succeeds with the expanded Hive embedded
- [ ] `bun build --compile src/cli/index.ts` produces a working binary with the Seedbed UI
- [ ] Garden workbench does not regress

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `meta.yaml` write races between user drags and analysis-status updates | Medium | High | All writes route through `SeedStore` patch methods; serialize writes per seed ID |
| Provider analysis latency makes "Analyze now" feel unresponsive | Medium | Medium | Analysis is fully async; per-provider progress badges update live via SSE; seed creation returns instantly |
| Model-generated analysis Markdown contains unsafe HTML | Medium | Medium | Sanitize all rendered Markdown before DOM insertion; never use `innerHTML` on raw model output |
| Native drag-and-drop has cross-browser quirks | Low | Medium | Desktop-first scope; test on Chrome and Firefox; graceful degradation (click-to-move fallback not required this sprint) |
| Workspace SSE misses nested seed directory changes | Medium | Medium | Use explicit semantic event bus for analysis updates; file-watch is supplementary, not primary |
| Sprint 020 SSE stream hangs leak into this sprint | Medium | High | Phase 5 runs the full existing test suite; any Sprint 020 regressions surface immediately and are addressed before declaring done |
| Scope creep into timeline view, run-seed linking, or frontend rewrite | High | High | Explicit cut line and out-of-scope list; review scope before each phase |
| Stale `running` analysis status after server restart | Medium | Medium | Recover on boot by rewriting stale `running` states to `failed` with restart reason |

---

## Dependencies

**Already shipped (no new work required):**

| Component | Sprint | Used For |
|-----------|--------|----------|
| Seed filesystem model + CLI seedbed | 008 | `SeedStore`, directory layout |
| Structured output (`generateObject<T>()`) | 014 | Analysis generation |
| Seed CRUD routes, attachment upload, workspace SSE | 019 | Server surface for Seedbed UI |
| Hive shell, asset embedding, browser workbench | 020 | Extending the frontend |

**Likely new packages:**

| Package | Purpose | Install Location |
|---------|---------|-----------------|
| `marked` | Markdown → HTML rendering for seed detail drawer | hive/ |
| `dompurify` | Sanitize rendered Markdown before DOM insertion | hive/ |

**Explicit non-dependencies:**

- No React (extend the existing DOM component model)
- No router library (URL params via `URLSearchParams`)
- No heavy drag-and-drop framework (native HTML5 drag-and-drop API)
- No database (filesystem is the source of truth)
