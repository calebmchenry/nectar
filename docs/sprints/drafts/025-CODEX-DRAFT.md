# Sprint 025: Seed-to-Execution Bridge — Linked Gardens, Run History, and Triage Views

## Overview

**Goal:** Make the Seedbed the source of truth for active work, not just idea capture. After this sprint, a seed can be linked to a garden, launched into a run from the Seedbed, tracked through interruption and resume, and inspected through list and timeline views that reflect real filesystem-backed history.

**Why this sprint, why now:**

1. **The compliance report shows only low-leverage spec gaps left.** GAP-1 (AUDIO/DOCUMENT content parts), GAP-2 (Gemini extended tools), GAP-3 (edit_file fuzzy matching), and GAP-4 (incremental JSON parsing in `streamObject()`) are real, but none changes Nectar’s day-to-day product value as much as the missing bridge between ideas and execution.

2. **The Seedbed contract is currently half-true.** `SeedMeta` already defines `linked_gardens` and `linked_runs`, but nothing writes them. That means the filesystem model advertised in `INTENT.md` is lying by omission: a seed cannot reliably tell an agent or a human what work it actually spawned.

3. **The three pillars are still too disconnected.** Gardens run. Seeds exist. Swarm analysis exists. But a user still cannot move naturally from “this idea matters” to “run the linked garden now” inside the Seedbed. That is the most important remaining product gap.

4. **Kanban-only triage does not scale.** The Hive shipped a solid Kanban board, but `INTENT.md` explicitly calls for list and timeline views. Once the workspace has more than a handful of seeds, Kanban stops being enough for review, search, and stale-work cleanup.

5. **This sprint is a clean one-sprint cut.** It stays inside one vertical slice: seed metadata integrity, seed-aware run launch, activity history, Seedbed list/timeline views, and minimal CLI parity. No engine rewrites. No new providers. No speculative multimodal work.

**In scope:**

- Persist real `linked_gardens` and `linked_runs` data into `meta.yaml`
- Add seed-scoped activity history on disk via `activity.jsonl`
- Add a seed-aware run launch path that links the started run back to the seed
- Auto-promote a seed to `blooming` when a linked run starts or resumes
- Do **not** auto-archive to `honey`; expose a clear “harvest” suggestion instead
- Show linked garden(s), recent linked runs, and status suggestions in the Hive seed detail
- Add Seedbed list view and workspace timeline view in the Hive
- Add CLI parity for missing Seedbed workflows: `nectar swarm <seed-id>` and `nectar seed link|unlink`
- Add integration tests that prove the filesystem state stays truthful through run start, interruption, resume, and completion

**Out of scope:**

- Remaining compliance-report gaps (AUDIO/DOCUMENT, Gemini extended tools, fuzzy `edit_file`, incremental JSON parsing)
- Dark mode
- Bidirectional visual graph editing
- Watched-folder ingestion and automatic seed creation
- Automatic `honey` archiving on successful run completion
- A database or any non-filesystem state layer
- Rewriting the Hive to React or changing the current build/embed model

**Cut line:** If the sprint compresses, cut CLI filter polish and secondary Hive sorting options first. Do **not** cut seed-aware run launch, on-disk activity history, or list/timeline views. Those are the point of the sprint.

---

## Use Cases

1. **Link a seed to a garden:** A user opens Seed #42 in the Hive and links it to `gardens/rate-limiting.dot`. `meta.yaml` now records that relationship, and an agent reading the filesystem can see it without querying the server.

2. **Launch work from the Seedbed:** The user clicks “Run Linked Garden” from the seed detail panel. Nectar starts the pipeline, appends the new run ID to `linked_runs`, records a `run_started` entry in `activity.jsonl`, and promotes the seed from `sprouting` to `blooming`.

3. **Resume work without losing provenance:** A linked run is interrupted. From the same seed detail panel, the user resumes it. The timeline shows both the interruption and the resume, and the run remains attached to the seed.

4. **Understand what happened later:** An agent opens `seedbed/042-rate-limiting/meta.yaml` and `seedbed/042-rate-limiting/activity.jsonl` and can answer: which garden is linked, which runs were launched, whether analysis finished, and whether the latest run succeeded or failed.

5. **Triaging at scale:** The user switches the Seedbed from Kanban to List view, filters to `priority=queens_order`, sorts by most recently updated, and immediately sees which high-priority seeds have failed analysis or no linked garden.

6. **Audit recent work:** The user switches to Timeline view and sees a workspace-wide activity feed: seeds created, statuses changed, analyses completed, gardens linked, runs started, runs interrupted, runs completed.

7. **Refresh swarm analysis from the CLI:** The user runs `nectar swarm 42 --force --provider codex`. Nectar re-runs only Codex for that seed and updates both `analysis/codex.md` and `activity.jsonl`.

8. **Link from the CLI:** The user runs `nectar seed link 42 gardens/rate-limiting.dot`. The same seed-garden relationship used by the Hive is created without requiring the local server.

9. **Avoid unsafe auto-closing:** A linked run completes successfully. Nectar does not silently move the seed to `honey`. Instead, the Seedbed shows a “Harvest to Honey” suggestion backed by the explicit rule “latest linked run completed successfully and no linked run is active.”

10. **Keep terminal manual control:** A user manually marks a seed `wilted`. Later, a run is started by mistake. Nectar records the event but does not automatically change the seed back to `blooming`. Manual terminal states win.

---

## Architecture

### Design Principles

1. **Current state in `meta.yaml`, history in `activity.jsonl`.** `meta.yaml` remains the canonical current-state record. This sprint adds `activity.jsonl` as the canonical append-only history for seed lifecycle events. No database, no hidden state.

2. **Bridge through explicit links, not heuristics.** Runs are linked to seeds only when started through a seed-aware path or when the user explicitly links them. Nectar should not guess that a random run “probably belonged” to a seed.

3. **Manual terminal states win.** Automatic lifecycle rules can promote `seedling` or `sprouting` work to `blooming`, but they do not override `honey` or `wilted`, and they never silently archive to `honey`.

4. **Keep run history bounded in `meta.yaml`.** `linked_runs` should store the most recent run IDs only (latest 25, newest first). Full history lives in `activity.jsonl` and the cocoon/manifests.

5. **Multiple linked gardens are allowed, but selection must be explicit.** If a seed has exactly one linked garden, “Run Linked Garden” uses it. If it has more than one, the user must choose. No hidden “first array element” behavior.

6. **List and timeline views are read-heavy, not edit-heavy.** This sprint adds triage surfaces, not a second editing system. Editing remains in the existing seed detail pane.

### Filesystem Contract

Each seed directory keeps the existing files:

```text
seedbed/042-rate-limiting/
├── seed.md
├── meta.yaml
├── activity.jsonl
├── attachments/
└── analysis/
```

`meta.yaml` remains the current state. `activity.jsonl` is append-only newline-delimited JSON with one event per line:

```json
{"timestamp":"2026-03-21T15:00:00Z","type":"seed_created","actor":"user"}
{"timestamp":"2026-03-21T15:03:12Z","type":"garden_linked","actor":"user","garden":"gardens/rate-limiting.dot"}
{"timestamp":"2026-03-21T15:04:01Z","type":"run_started","actor":"system","run_id":"...","garden":"gardens/rate-limiting.dot"}
{"timestamp":"2026-03-21T15:05:44Z","type":"run_interrupted","actor":"system","run_id":"...","reason":"api_cancel"}
```

This gives Nectar a durable timeline without forcing the UI to scrape event journals or infer state from timestamps.

### Seed Lifecycle Rules

This sprint freezes a small, explicit ruleset:

- **Rule 1:** Starting or resuming a linked run auto-promotes `seedling` and `sprouting` seeds to `blooming`.
- **Rule 2:** `honey` and `wilted` are never auto-overridden.
- **Rule 3:** Successful linked run completion does **not** auto-set `honey`. It produces a status suggestion only.
- **Rule 4:** `linked_gardens` is unique and stored as workspace-relative `gardens/*.dot` paths only.
- **Rule 5:** `linked_runs` is newest-first and capped at 25 entries.

The suggestion rule exposed in the UI and API is:

- `suggested_status = honey` when the latest linked run completed successfully, no linked run is active, and the current status is `blooming`

This keeps the automation useful without making archival surprising.

### Seed-Aware Run Launch

Add a seed-scoped route instead of overloading the generic pipeline surface:

`POST /seeds/:id/run`

Request:

```json
{
  "garden_path": "gardens/rate-limiting.dot",
  "auto_approve": false
}
```

Behavior:

1. Validate the seed exists
2. Validate the garden path is inside `gardens/`
3. Start the pipeline through `RunManager`
4. Persist the seed-run and seed-garden links
5. Append `run_started` to `activity.jsonl`
6. Apply the `blooming` auto-promotion rule
7. Return the started run ID

`RunStore` manifest data should be extended to include:

```ts
seed_id?: number;
seed_dir?: string;
seed_garden?: string;
launch_origin?: 'seedbed' | 'seed_cli' | 'pipeline_api' | 'garden_hive';
```

That makes the cocoon side truthful too: a run can point back to the seed that spawned it.

### Services

Introduce two small services instead of burying this logic in route handlers:

**`SeedActivityStore`** (`src/seedbed/activity.ts`)

- `append(seedId, event)`
- `list(seedId, options)`
- `listWorkspace(options)` for Timeline view aggregation

**`SeedLifecycleService`** (`src/seedbed/lifecycle.ts`)

- `linkGarden(seedId, gardenPath)`
- `unlinkGarden(seedId, gardenPath)`
- `attachRun(seedId, runId, gardenPath, origin)`
- `recordRunTransition(seedId, runEvent)`
- `computeStatusSuggestion(seedMeta, linkedRunSummaries)`

`SeedLifecycleService` owns all automatic state transitions and keeps them serialized through the existing `SeedStore` patch queue.

### API Surface

Add or expand the following local routes:

- `PATCH /seeds/:id`
  - Accept `linked_gardens_add?: string[]`
  - Accept `linked_gardens_remove?: string[]`
- `POST /seeds/:id/run`
  - Start a seed-aware run
- `GET /seeds/:id`
  - Extend response with `linked_run_summaries` and `status_suggestion`
- `GET /seeds/activity`
  - Workspace-wide seed timeline, paginated and newest-first
- `GET /seeds`
  - Add optional query params for `status`, `priority`, `q`, and `sort`

Do **not** add a separate timeline database or background index. Read from the filesystem and existing manifests.

### Hive UX

The Seedbed center column becomes a view switcher:

- `Kanban`
- `List`
- `Timeline`

The existing detail pane gains:

- Linked gardens section
- “Link garden” action
- “Run linked garden” action
- Recent linked runs section
- Status suggestion banner (`Harvest to Honey`)

The List view is a sortable table optimized for triage:

- Title
- Status
- Priority
- Linked garden count
- Latest run state
- Analysis health
- Updated time

The Timeline view is workspace-wide, newest-first, and click-through:

- `Seed created`
- `Status changed`
- `Garden linked`
- `Analysis started/completed/failed`
- `Run started/interrupted/completed/failed`

### CLI Surface

Ship the missing product-level command from `INTENT.md`:

```text
nectar swarm <seed-id> [--provider <name> ...] [--force] [--no-attachments]
```

Add seed linking commands:

```text
nectar seed link <seed-id> <garden-path>
nectar seed unlink <seed-id> <garden-path>
```

These commands should operate directly against the filesystem-backed services, not require `nectar serve`.

---

## Implementation phases

### Phase 1: Seed Activity and Linkage Backbone (~25%)

**Files:** `src/seedbed/types.ts`, `src/seedbed/store.ts`, `src/seedbed/activity.ts` (new), `src/seedbed/lifecycle.ts` (new), `test/seedbed/activity.test.ts` (new), `test/seedbed/store.test.ts`

**Tasks:**

- [ ] Add `SeedActivityEvent` types and JSONL serialization helpers
- [ ] Create `SeedActivityStore` with append, per-seed read, and workspace aggregate read
- [ ] Extend `SeedStore.patch()` to support link mutations without clobbering unrelated fields
- [ ] Enforce `linked_gardens` uniqueness and workspace-relative normalization
- [ ] Enforce `linked_runs` newest-first with a hard cap of 25
- [ ] Append activity events for seed creation, edits, status changes, garden link, and garden unlink
- [ ] Unit test duplicate-link handling, bounded run history, and activity append/read behavior

### Phase 2: Seed-Aware Run Launch and Lifecycle Reconciliation (~30%)

**Files:** `src/checkpoint/run-store.ts`, `src/server/types.ts`, `src/server/routes/seeds.ts`, `src/server/run-manager.ts`, `src/runtime/pipeline-service.ts`, `test/server/seeds-run.test.ts` (new), `test/integration/seed-run-linkage.test.ts` (new)

**Tasks:**

- [ ] Extend run manifest schema with optional seed metadata (`seed_id`, `seed_dir`, `seed_garden`, `launch_origin`)
- [ ] Add `POST /seeds/:id/run`
- [ ] Thread optional seed context through `RunManager.startPipeline()`
- [ ] On seed-aware run start, append the new run ID to `linked_runs` and record `run_started`
- [ ] On run interruption, completion, and failure, append activity entries for the linked seed
- [ ] Apply the `seedling|sprouting -> blooming` auto-promotion rule on start/resume only
- [ ] Compute and expose `status_suggestion` for successful completed runs without mutating `meta.yaml`
- [ ] Integration test: link seed -> start run -> interrupt -> resume -> complete -> filesystem reflects all transitions

### Phase 3: Hive Triage Views and Seed Detail Bridge (~30%)

**Files:** `hive/src/App.ts`, `hive/src/lib/api.ts`, `hive/src/components/SeedDetail.ts`, `hive/src/components/SeedListView.ts` (new), `hive/src/components/SeedTimelineView.ts` (new), `hive/src/components/SeedViewToggle.ts` (new), `hive/src/styles/app.css`, `test/integration/hive-seedbed-flow.test.ts`

**Tasks:**

- [ ] Add a Seedbed view switcher for `Kanban | List | Timeline`
- [ ] Implement List view with client controls for status filter, priority filter, text search, and sort
- [ ] Implement Timeline view backed by `GET /seeds/activity`
- [ ] Extend `SeedDetail` with linked-garden controls and recent linked-run summaries
- [ ] Add “Run linked garden” action with explicit garden selection when multiple links exist
- [ ] Show `status_suggestion` banner with a one-click “Move to Honey” action that still writes through `PATCH /seeds/:id`
- [ ] Preserve URL state for selected seed and active Seedbed subview
- [ ] Extend integration coverage for link -> run -> timeline visibility in the browser

### Phase 4: CLI Parity and Workflow Hardening (~15%)

**Files:** `src/cli/index.ts`, `src/cli/commands/seed.ts`, `src/cli/commands/swarm.ts` (new), `test/integration/seed-cli.test.ts`, `test/integration/swarm-cli.test.ts` (new)

**Tasks:**

- [ ] Add `nectar swarm <seed-id>` command with provider selection and force/no-attachments flags
- [ ] Add `nectar seed link` and `nectar seed unlink`
- [ ] Extend `nectar seed show` to display linked gardens, recent linked runs, and any status suggestion
- [ ] Keep command output themed but pipe-friendly
- [ ] Add integration tests for linking and CLI-triggered swarm analysis

---

## Files Summary

**Seed lifecycle core**

- `src/seedbed/types.ts`
- `src/seedbed/store.ts`
- `src/seedbed/activity.ts` (new)
- `src/seedbed/lifecycle.ts` (new)

**Run integration**

- `src/checkpoint/run-store.ts`
- `src/server/run-manager.ts`
- `src/server/routes/seeds.ts`
- `src/server/types.ts`
- `src/runtime/pipeline-service.ts`

**Hive**

- `hive/src/App.ts`
- `hive/src/lib/api.ts`
- `hive/src/components/SeedDetail.ts`
- `hive/src/components/SeedListView.ts` (new)
- `hive/src/components/SeedTimelineView.ts` (new)
- `hive/src/components/SeedViewToggle.ts` (new)
- `hive/src/styles/app.css`

**CLI**

- `src/cli/index.ts`
- `src/cli/commands/seed.ts`
- `src/cli/commands/swarm.ts` (new)

**Tests**

- `test/seedbed/activity.test.ts` (new)
- `test/server/seeds-run.test.ts` (new)
- `test/integration/seed-run-linkage.test.ts` (new)
- `test/integration/hive-seedbed-flow.test.ts`
- `test/integration/seed-cli.test.ts`
- `test/integration/swarm-cli.test.ts` (new)

---

## Definition of Done

- `meta.yaml` for an active seed contains truthful `linked_gardens` and recent `linked_runs`
- Each seed directory has an append-only `activity.jsonl` that records creation, edits, analysis transitions, links, and linked run transitions
- Starting a run from the Seedbed or seed-aware API path promotes eligible seeds to `blooming`
- No automatic path silently archives work to `honey`
- Run manifests in `.nectar/cocoons/<run-id>/manifest.json` include seed linkage metadata when applicable
- The Hive Seedbed ships `Kanban`, `List`, and `Timeline` views
- The Hive seed detail can link a garden, start a linked run, and show recent linked runs plus status suggestion
- `nectar swarm <seed-id>` works without the server running
- `nectar seed link|unlink` works without the server running
- New tests cover filesystem truth, link/run lifecycle, Hive timeline rendering, and CLI swarm/link workflows
- `npm test` is green

---

## Risks

- **Race conditions between manual edits and automatic lifecycle updates:** `SeedStore` already serializes patches per seed. All automatic lifecycle updates must flow through that same queue.

- **Activity log duplication on resume/restart paths:** Run-linked events need idempotency keys based on `(seed_id, run_id, event_type)` so a resume or replay path does not append duplicates.

- **Large workspace timeline reads:** `GET /seeds/activity` should be paginated and bounded. Read newest-first with a fixed limit rather than loading every event into memory.

- **Ambiguous multiple-garden linkage:** The UI and CLI must force explicit selection whenever a seed has more than one linked garden. Hidden defaults will create accidental runs.

- **Schema drift in hand-edited files:** `activity.jsonl` and the new route responses should degrade gracefully if a user hand-edits `meta.yaml` or deletes a linked run directory. Missing linked runs should render as `unknown`, not crash the Seedbed.

---

## Dependencies

- Existing `SeedStore` patch queue and filesystem workspace layout
- Existing `RunManager`, `RunStore`, cocoon manifests, and event journal pipeline
- Existing Hive Seedbed shell, API client, and build/embed asset pipeline
- Existing `SwarmAnalysisService` for `nectar swarm`
- No new external services
- No new persistence layer beyond the filesystem
