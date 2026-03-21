# Sprint 021: The Seedbed and Swarm — Browser Capture, Kanban, and Multi-Provider Analysis

## Overview

**Goal:** Turn the Hive from a garden-only workbench into Nectar's actual workspace. After this sprint, a user can capture a seed from the browser, attach files, triage it on a five-column board, trigger or re-run Claude/Codex/Gemini analysis, and compare the results in one place. The sprint also retires the five hanging HTTP/SSE regressions exposed by Sprint 020, because live seed and analysis updates are not shippable on top of an unreliable stream layer.

**Why this sprint, why now:**

1. **The biggest remaining gap is product, not plumbing.** `docs/compliance-report.md` shows only eight spec gaps left, and most are narrow implementation nits. `docs/INTENT.md` makes the larger gap obvious: Nectar is still missing the browser Seedbed and the Swarm Intelligence experience that define its second and third product pillars.

2. **The substrate already exists.** The filesystem seed model, seed CRUD routes, attachment upload, workspace SSE, unified LLM client, and structured output are already in place. This sprint is mostly composition and UI, not foundational research.

3. **Sprint 020 created the right shell.** The Hive now has a build pipeline, static serving, a browser workbench, and a server-backed event model. The correct next move is to extend that shell into the Seedbed, not to replatform the frontend or spend another sprint on low-leverage compliance cleanup.

4. **Swarm is now technically safe to ship.** Earlier drafts deferred multi-model analysis because Markdown normalization was too brittle. That is no longer true. Structured output exists, the server can persist deterministic files, and the remaining work is productization.

5. **This is the smallest complete slice that makes Nectar feel like Nectar.** Garden authoring without backlog capture is a demo. Seed capture plus triage plus three-model comparison is the first browser workflow that matches the intent doc's actual promise.

**Gaps closed in this sprint:**

| Gap | Type | Why it belongs here |
|-----|------|---------------------|
| Missing Hive Seedbed UI | Product | The browser still has no backlog surface at all |
| Missing Swarm Intelligence workflow | Product | The three-model comparison experience is a core differentiator in `INTENT.md` |
| Sprint 020 HTTP/SSE hang regressions | Reliability | Seed and analysis progress need trustworthy long-lived streams |

**In scope:**

- Seedbed mode in the existing Hive UI
- Browser quick-capture flow for seeds: title, body, tags, priority, attachments
- Editing existing seed title/body/metadata through the local server
- Five-column Kanban board (`seedling`, `sprouting`, `blooming`, `honey`, `wilted`)
- Drag-and-drop status changes with optimistic UI and rollback on failure
- Seed detail drawer with rendered `seed.md`, attachments, metadata, parsed analysis docs, and synthesis
- `POST /seeds/:id/analyze` background swarm analysis for Claude, Codex, and Gemini
- Deterministic analysis file writing that follows the `analysis/{provider}.md` contract from `INTENT.md`
- Deterministic synthesis view derived from normalized analysis fields, not a fourth model call
- Workspace event-bus improvements needed for live seed and analysis updates
- Fixing the five failing Sprint 020 tests and keeping the Garden workbench stable

**Out of scope:**

- Timeline view
- Automatic watched-folder ingestion or OS-level share-sheet capture
- Automatic seed-to-pipeline linking and run-driven status transitions via `linked_runs`
- Audio/video transcription or deep multimodal attachment analysis
- React, router, or state-library replatforming of the Hive
- OpenAI-compatible third-party adapter, Gemini extended tools, custom transforms, sub-pipeline composition, tool output limit cleanup, or loop-detection expansion

**Cut line:** If time compresses, cut provider-specific rerun buttons, card reordering within a column, and a secondary table/list view. Do **not** cut the Sprint 020 stability fixes, browser seed creation/editing/upload, `POST /seeds/:id/analyze`, per-provider analysis persistence, or the side-by-side comparison panel.

---

## Use Cases

1. **Open the Seedbed.** User runs `nectar serve`, opens the Hive, and switches from Gardens to Seedbed. The left rail shows counts by status and priority. The center column shows quick capture and the Kanban board. The right column shows the currently selected seed.

2. **Capture an idea with near-zero friction.** User pastes a paragraph, adds two tags, marks it `high`, drags in a screenshot, and leaves "Analyze now" checked. Nectar creates `seedbed/NNN-slug/`, writes `seed.md` and `meta.yaml`, uploads the attachment, and immediately starts background analysis.

3. **Upload files after creation.** User opens an existing seed and drops a PDF into the attachment zone. Nectar stores it under `attachments/`, appends a reference into `seed.md`, updates `updated_at`, and refreshes the detail drawer without a full-page reload.

4. **Triaging stays file-backed.** User drags a card from `seedling` to `sprouting`. The UI moves the card immediately. `PATCH /seeds/:id` writes `meta.yaml`. Dragging a card to `honey` moves the directory from `seedbed/` to `honey/` through the existing archive rule.

5. **Run swarm analysis on demand.** User clicks "Analyze" on a seed created last week. Nectar starts one background job for that seed, fans out to the configured providers, writes `analysis/claude.md`, `analysis/codex.md`, and `analysis/gemini.md`, and updates `analysis_status` live as each provider completes.

6. **Missing credentials do not poison the whole workflow.** Anthropic is not configured, but OpenAI and Gemini are. Anthropic writes a deterministic `status: skipped` analysis file with an explanation. OpenAI and Gemini still complete normally. The seed remains browsable and comparable.

7. **Failures are preserved as artifacts.** Gemini times out. Nectar writes a `status: failed` analysis file with the error summary, marks `analysis_status.gemini=failed`, and leaves the other provider files intact. The user can re-run only Gemini later.

8. **Compare the hive mind.** The detail drawer shows three provider cards side-by-side. Each card exposes normalized fields (`recommended_priority`, `estimated_complexity`, `feasibility`) and the four required Markdown sections. A synthesis panel above them highlights where the models agree and where they diverge.

9. **Refresh is a normal case.** User reloads the page mid-analysis. The selected seed is preserved in the URL, the board rehydrates from `GET /seeds`, the detail drawer re-fetches `GET /seeds/:id`, and the workspace stream resumes live updates. No provider is shown as "running forever" after a server restart.

10. **The Garden workbench does not regress.** Draft streaming still ends cleanly, pipeline SSE streams close at terminal states, and the five previously failing Sprint 020 tests are green.

---

## Architecture

### Design Principles

1. **Do not replatform the Hive.** The current frontend is a lightweight Vite + TypeScript + DOM-component app under `hive/`. This sprint extends that codebase. No React rewrite, no router rewrite, no parallel frontend architecture.

2. **The filesystem stays canonical.** All seed state still lives in `seed.md`, `meta.yaml`, `attachments/`, and `analysis/`. The browser is a view and edit layer over those files, not a second state system.

3. **Long-running analysis is asynchronous and observable.** Seed creation must be fast. Swarm analysis runs in the background, updates `analysis_status` incrementally, emits workspace events, and can be re-run without blocking the UI thread or the HTTP request.

4. **Provider failure is still data.** `failed` and `skipped` outcomes write analysis files just like `complete` does. The UI should never infer missing state from a missing file.

5. **Synthesis is derived, not hallucinated.** The comparison panel is computed from normalized front matter and required sections. Do not spend a fourth model call to summarize three model calls.

6. **One write path owns `meta.yaml`.** UI edits, analysis-status updates, and archive moves must flow through `SeedStore` patch methods. Direct ad hoc writes from separate services will create race conditions.

### Existing Frontend Baseline

The current Hive has one `HiveApp` class, custom DOM components, Vite build output embedded into the server, and a three-column layout. This sprint should preserve that model:

- Add a minimal view switcher inside `HiveApp`
- Reuse the left / center / right column layout
- Add Seedbed-specific components next to the existing garden components
- Keep URL state in `URLSearchParams` rather than introducing a routing framework

### Backend Additions

**`SwarmManager`** — A server-level manager for active seed analysis jobs. It ensures one active swarm job per seed, deduplicates duplicate "Analyze" clicks, tracks provider progress, and emits explicit workspace events (`seed_analysis_started`, `seed_analysis_completed`, `seed_analysis_failed`).

**`SwarmAnalysisService`** — The orchestration layer that:

- loads the seed content and attachments
- selects which providers to run
- maps user-facing swarm targets (`claude`, `codex`, `gemini`) to actual LLM providers (`anthropic`, `openai`, `gemini`)
- builds a structured prompt
- calls `UnifiedClient.generateObject<T>()`
- writes normalized Markdown files
- updates `analysis_status`

This service is pure business logic; it should not know about HTTP or DOM concerns.

**`AnalysisDocument`** — A small parser/renderer for `analysis/{provider}.md`. It owns:

- YAML front matter serialization and parsing
- required section ordering
- deterministic failure/skipped document rendering
- conversion to a typed read model for the UI

**`WorkspaceEventBus`** — The current `/events` endpoint is based on shallow filesystem watching. That is not enough for live seed-analysis progress. Add an explicit in-process event bus for semantic events, and let `/events` merge those events with the existing file-watch layer. File watch remains useful for out-of-band edits; semantic events become the primary path for analysis progress.

### API Contracts

**`PATCH /seeds/:id`**

Expand the current patch surface so the browser can edit more than status:

```json
{
  "title": "Add rate limiting to the API gateway",
  "body": "# Add rate limiting\n\nNeed per-tenant burst control...",
  "status": "sprouting",
  "priority": "high",
  "tags": ["api", "infra"]
}
```

Rules:

- Any omitted field is unchanged.
- `body` rewrites `seed.md`.
- `title` updates both `meta.yaml.title` and the H1 in `seed.md`.
- `updated_at` always changes on a successful patch.

**`POST /seeds/:id/analyze`**

Request:

```json
{
  "providers": ["claude", "codex", "gemini"],
  "force": false,
  "include_attachments": true
}
```

Response:

```json
{
  "seed_id": 42,
  "job_status": "started",
  "accepted_providers": ["claude", "codex", "gemini"],
  "already_running": false
}
```

Behavior:

- Returns `202 Accepted`
- If the same seed is already analyzing, returns `already_running: true` and does not start a duplicate job
- `force=false` skips providers that already have `status: complete`
- `force=true` overwrites existing provider files

**`GET /seeds/:id`**

Extend the detail response to return parsed analysis docs, not just filenames:

```json
{
  "meta": { "...": "..." },
  "seed_md": "# Add rate limiting ...",
  "attachments": [
    { "filename": "screenshot.png", "url": "/seeds/42/attachments/screenshot.png" }
  ],
  "analyses": [
    {
      "provider": "codex",
      "status": "complete",
      "generated_at": "2026-03-21T15:12:00Z",
      "recommended_priority": "high",
      "estimated_complexity": "medium",
      "feasibility": "high",
      "body_md": "# Summary\n..."
    }
  ]
}
```

**`GET /seeds/:id/synthesis`**

Response:

```json
{
  "consensus": {
    "recommended_priority": "high",
    "estimated_complexity": "medium",
    "feasibility": "high"
  },
  "divergences": [
    {
      "field": "estimated_complexity",
      "values": {
        "claude": "medium",
        "codex": "medium",
        "gemini": "high"
      }
    }
  ],
  "available_providers": ["claude", "codex", "gemini"]
}
```

This is computed server-side from parsed documents. Do not persist a separate synthesis file in this sprint.

### Swarm Analysis Flow

```text
Hive Seed Composer
    │
    ├── POST /seeds
    ├── POST /seeds/:id/attachments (0..N)
    └── POST /seeds/:id/analyze
             │
             ▼
        SwarmManager
             │
             ▼
    SwarmAnalysisService
      ├── load seed.md/meta.yaml
      ├── set analysis_status.* = running
      ├── generateObject() per provider
      ├── write analysis/{provider}.md
      ├── set analysis_status.* = complete|failed|skipped
      └── emit workspace events
             │
             ▼
      /events SSE + GET /seeds/:id + GET /seeds/:id/synthesis
             │
             ▼
      Hive Seed Detail + Swarm Compare
```

### Analysis Input Policy

This sprint should be explicit and conservative about what is sent to models:

- Always include the seed title, body, tags, priority, and attachment filenames
- Inline image attachments only when they are already supported by the unified content model
- For other attachments, include filename + media type + size metadata in the prompt
- Do **not** implement audio/video transcription in this sprint
- Cap attachments included in the prompt so one giant seed cannot create runaway token costs

### Module Layout

```text
src/
├── runtime/
│   └── swarm-analysis-service.ts
├── server/
│   ├── swarm-manager.ts
│   ├── workspace-event-bus.ts
│   └── routes/
│       ├── seeds.ts
│       └── events.ts
├── seedbed/
│   ├── store.ts
│   ├── analysis-document.ts
│   ├── synthesis.ts
│   └── markdown.ts
└── llm/
    └── errors.ts                  # only if richer provider failure mapping is needed

hive/src/
├── App.ts
├── lib/
│   ├── api.ts
│   └── workspace-stream.ts
├── components/
│   ├── ViewNav.ts
│   ├── SeedComposer.ts
│   ├── SeedBoard.ts
│   ├── SeedColumn.ts
│   ├── SeedCard.ts
│   ├── SeedDetail.ts
│   └── SwarmCompare.ts
└── styles/
    └── app.css

test/
├── runtime/
│   └── swarm-analysis-service.test.ts
├── server/
│   ├── seeds-detail.test.ts
│   ├── seeds-analyze.test.ts
│   └── workspace-events.test.ts
└── integration/
    └── hive-seedbed-flow.test.ts
```

---

## Implementation phases

### Phase 0: Stability Gate — Fix Sprint 020 Stream Hangs (~15%)

**Files:** `src/server/routes/pipelines.ts`, `src/server/run-manager.ts`, `src/server/routes/gardens.ts`, `src/runtime/garden-draft-service.ts`, `test/integration/http-sse-replay.test.ts`, `test/server/gardens-draft.test.ts`, `test/server/pipeline-events.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/fan-in-llm.test.ts`

**Tasks:**

- [ ] Close pipeline SSE streams when the run reaches a terminal state, not only after active-run TTL cleanup
- [ ] Ensure `POST /gardens/draft` always terminates its SSE stream after `draft_complete` or `draft_error`
- [ ] Fix the hanging HTTP execution path that causes `fan-in-llm`, `pipeline-events`, and `hive-run-flow` to time out
- [ ] Make server shutdown deterministic in tests so `afterEach` does not hang on open SSE connections
- [ ] Re-enable the five currently failing Sprint 020 tests as the baseline before adding new Seedbed/Swarm behavior

### Phase 1: Expand the Seed Write Model and Server Surface (~20%)

**Files:** `src/seedbed/store.ts`, `src/seedbed/markdown.ts`, `src/seedbed/types.ts`, `src/server/routes/seeds.ts`, `test/server/seeds-detail.test.ts`

**Tasks:**

- [ ] Extend `SeedStore` with a general patch API that can update `title`, `body`, `status`, `priority`, and `tags` without clobbering `linked_*` or `analysis_status`
- [ ] Make `PATCH /seeds/:id` support `title` and `body`, not only status/priority/tags
- [ ] Ensure title edits update both `meta.yaml.title` and the heading in `seed.md`
- [ ] Extend `GET /seeds/:id` to return structured attachment metadata and parsed analysis docs
- [ ] Preserve atomic writes for both `meta.yaml` and `seed.md`
- [ ] Keep the existing `honey/` archive move rule intact when status changes to or from `honey`

### Phase 2: Swarm Job Management and Deterministic Analysis Files (~25%)

**Files:** `src/runtime/swarm-analysis-service.ts`, `src/server/swarm-manager.ts`, `src/seedbed/analysis-document.ts`, `src/server/routes/seeds.ts`, `test/runtime/swarm-analysis-service.test.ts`, `test/server/seeds-analyze.test.ts`

**Tasks:**

- [ ] Add `POST /seeds/:id/analyze` as a background job endpoint returning `202 Accepted`
- [ ] Create `SwarmManager` with one active job per seed and duplicate-click deduplication
- [ ] Define a strict `SeedAnalysis` schema for `generateObject<T>()`
- [ ] Implement provider fan-out with `Promise.allSettled()`, bounded to three providers
- [ ] Write `analysis/{provider}.md` with required YAML front matter and required body sections
- [ ] On provider misconfiguration, write a deterministic `status: skipped` document
- [ ] On provider failure, write a deterministic `status: failed` document that preserves the error summary
- [ ] Support `force=true` reruns that overwrite existing analysis files
- [ ] Recover stale `analysis_status=running` on server boot by rewriting those provider states to `failed` with a restart reason

### Phase 3: Workspace Events and Synthesis Read Model (~10%)

**Files:** `src/server/workspace-event-bus.ts`, `src/server/routes/events.ts`, `src/seedbed/synthesis.ts`, `test/server/workspace-events.test.ts`, `test/seedbed/synthesis.test.ts`

**Tasks:**

- [ ] Add an explicit workspace event bus for semantic events emitted by seed edits and analysis jobs
- [ ] Extend `/events` to emit `seed_created`, `seed_updated`, `seed_analysis_started`, `seed_analysis_completed`, and `seed_analysis_failed`
- [ ] Keep file-watch events for out-of-band filesystem edits, but treat semantic events as the primary path for analysis progress
- [ ] Implement deterministic synthesis over normalized fields:
  - [ ] consensus when all available providers agree
  - [ ] majority when two of three agree
  - [ ] divergence payload when they do not
- [ ] Expose `GET /seeds/:id/synthesis`

### Phase 4: Hive Seedbed UI (~30%)

**Files:** `hive/src/App.ts`, `hive/src/lib/api.ts`, `hive/src/lib/workspace-stream.ts`, `hive/src/components/ViewNav.ts`, `hive/src/components/SeedComposer.ts`, `hive/src/components/SeedBoard.ts`, `hive/src/components/SeedColumn.ts`, `hive/src/components/SeedCard.ts`, `hive/src/components/SeedDetail.ts`, `hive/src/components/SwarmCompare.ts`, `hive/src/styles/app.css`

**Tasks:**

- [ ] Add a lightweight view switcher inside `HiveApp` for `gardens` vs `seedbed`
- [ ] Persist `view` and selected `seed` in `URLSearchParams`
- [ ] Build `SeedComposer`:
  - [ ] title input
  - [ ] body textarea
  - [ ] tags input
  - [ ] priority selector
  - [ ] attachment picker / drop zone
  - [ ] "Analyze now" checkbox, checked by default
- [ ] Build `SeedBoard` as a five-column Kanban board grouped by status
- [ ] Use native desktop drag-and-drop for status changes; do not introduce a large DnD dependency
- [ ] Implement optimistic status changes with rollback if `PATCH /seeds/:id` fails
- [ ] Build `SeedDetail` drawer that renders sanitized `seed.md`, shows attachments, metadata, and per-provider status badges
- [ ] Build `SwarmCompare` that renders side-by-side provider cards plus the synthesis banner
- [ ] Add rerun actions:
  - [ ] analyze all
  - [ ] rerun failed providers
  - [ ] force rerun all if time remains
- [ ] Subscribe to `/events` through `WorkspaceStream` so the board and detail drawer refresh live during analysis

### Phase 5: Integration, Build, and Regression Coverage (~10%)

**Files:** `test/integration/hive-seedbed-flow.test.ts`, `test/integration/hive-run-flow.test.ts`, `package.json`

**Tasks:**

- [ ] Add one end-to-end HTTP integration test for create → upload → analyze → rerun → move to `honey`
- [ ] Keep the Sprint 020 garden workbench integration tests green
- [ ] Verify `npm run build` still embeds the Hive assets correctly
- [ ] Verify `npm test` passes with the new Seedbed/Swarm suite plus the previously failing Sprint 020 tests

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/runtime/swarm-analysis-service.ts` | Create | Orchestrate per-provider analysis generation |
| `src/server/swarm-manager.ts` | Create | Deduplicate active seed-analysis jobs and expose job lifecycle |
| `src/server/workspace-event-bus.ts` | Create | Emit semantic workspace events for seed and analysis updates |
| `src/server/routes/seeds.ts` | Modify | Expand seed detail/edit surface and add `POST /seeds/:id/analyze` |
| `src/server/routes/events.ts` | Modify | Merge semantic workspace events with file-watch events |
| `src/seedbed/store.ts` | Modify | Add safe patch methods for `meta.yaml` + `seed.md` |
| `src/seedbed/analysis-document.ts` | Create | Parse/render normalized analysis Markdown files |
| `src/seedbed/synthesis.ts` | Create | Build deterministic agreement/divergence summaries |
| `hive/src/App.ts` | Modify | Add Seedbed mode and view-level state management |
| `hive/src/lib/api.ts` | Modify | Add seed detail, update, analyze, and synthesis client methods |
| `hive/src/lib/workspace-stream.ts` | Create | EventSource wrapper for workspace-level updates |
| `hive/src/components/SeedComposer.ts` | Create | Browser quick-capture form and upload staging |
| `hive/src/components/SeedBoard.ts` | Create | Five-column Kanban container |
| `hive/src/components/SeedDetail.ts` | Create | Seed detail drawer |
| `hive/src/components/SwarmCompare.ts` | Create | Side-by-side provider comparison and synthesis view |
| `hive/src/styles/app.css` | Modify | Seedbed layout, board, drawer, and status styles |
| `test/server/seeds-analyze.test.ts` | Create | Server contract tests for background analysis |
| `test/integration/hive-seedbed-flow.test.ts` | Create | End-to-end seed capture and swarm flow |

---

## Definition of Done

- [ ] The five previously failing Sprint 020 tests are fixed and `npm test` is green again
- [ ] `PATCH /seeds/:id` can edit `title`, `body`, `status`, `priority`, and `tags`
- [ ] `POST /seeds/:id/analyze` starts one background job per seed and does not double-start on repeated clicks
- [ ] Each provider writes exactly one analysis file in `analysis/{provider}.md` with valid YAML front matter and the four required sections
- [ ] Providers with missing credentials write `status: skipped` files; provider failures write `status: failed` files; neither case blocks the other providers
- [ ] `GET /seeds/:id` returns parsed analysis documents and attachment metadata, not only filenames
- [ ] `GET /seeds/:id/synthesis` returns deterministic agreement/divergence data derived from available analyses
- [ ] The Hive can create a seed, upload attachments, edit the seed, drag it between statuses, and view the on-disk result correctly
- [ ] The Hive shows per-provider analysis progress live through `/events` without requiring a manual refresh
- [ ] Refreshing the page mid-analysis rehydrates the selected seed and shows correct non-stale provider statuses
- [ ] `npm run build` succeeds with the expanded Hive embedded into the server bundle

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `meta.yaml` races between user edits and analysis-status writes | Medium | High | Route all seed writes through `SeedStore` patch helpers and serialize writes per seed |
| Workspace SSE still misses nested seed changes | Medium | High | Add an explicit semantic event bus; do not rely on shallow `fs.watch` alone |
| Provider latency or cost makes "Analyze now" feel slow | Medium | Medium | Start analysis asynchronously, cap attachment inclusion, and show per-provider progress immediately |
| A restarted server leaves providers stuck in `running` | Medium | Medium | Recover stale `running` states on boot and rewrite them to deterministic failure docs |
| Rendering model-generated Markdown creates unsafe HTML | Medium | Medium | Sanitize all rendered Markdown in the browser before injection |
| Native drag-and-drop gets messy across browsers | Low | Medium | Keep this sprint desktop-first and support only column moves, not arbitrary card ordering |
| Scope creeps into seed-to-run linking, timeline views, or a frontend rewrite | High | High | Keep those explicitly out of scope and enforce the cut line above |

---

## Dependencies

**Internal dependencies already shipped:**

- Seed filesystem model and CLI/store from Sprint 008
- Structured output support from Sprint 014
- `nectar serve`, seed CRUD routes, attachment upload, and workspace events from Sprint 019
- Hive shell, asset embedding, and browser workbench from Sprint 020

**Likely new package additions:**

- `marked` for Markdown-to-HTML rendering in the detail drawer
- `dompurify` for sanitizing rendered Markdown before insertion

**Explicit non-dependencies:**

- No React
- No router library
- No heavy drag-and-drop framework unless native drag-and-drop proves unworkable during implementation
