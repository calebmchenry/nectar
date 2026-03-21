# Sprint 020: The Hive Garden Workbench — Browser Authoring, Live Execution, and Fan-In LLM

## Overview

**Goal:** Ship a working Hive web UI served by `nectar serve` that lets a user browse and edit DOT gardens in a dual-pane editor, draft pipelines from natural language, run them with real-time SSE observation, and answer `wait.human` questions from the browser — plus close GAP-1 (fan-in LLM evaluation) and GAP-5 (explicit failure events) to improve both the browser experience and spec compliance.

**Why this sprint, why now:**

1. **The Hive is 1/3 of Nectar's value proposition and 0% implemented.** INTENT.md defines Nectar as three things: a pipeline engine (done), a CLI (done), and a web UI (untouched). After 19 sprints, zero lines of frontend code exist. The engine and CLI are mature; the product is invisible to anyone who doesn't live in a terminal.

2. **Sprint 019 fully unblocked it.** The HTTP server, SSE event streaming, garden/seed CRUD endpoints, human gate question/answer endpoints, SVG rendering, and event journal replay all landed in Sprint 019. The backend contract from INTENT §4 is fulfilled. There are zero remaining backend blockers for the frontend.

3. **Garden workbench is the right cut line for one sprint.** It is a complete vertical slice: authoring, validation, execution, observation, and human approval. Seedbed Kanban and Swarm Intelligence are broader surfaces that should build on a reusable frontend shell — not be invented ad hoc in a first sprint.

4. **Two compliance gaps materially improve this slice.** GAP-1 (fan-in LLM evaluation) matters because browser-authored pipelines will immediately want "best of N" merge behavior. GAP-5 (`stage_failed` / `pipeline_failed` events) matters because a browser run timeline should not infer failure from generic events. The other remaining gaps (GAP-2, GAP-3, GAP-4) are real but not the highest-leverage next move.

5. **Real-time pipeline observation is a killer demo.** Watching nodes execute, SSE events streaming in, clicking to approve a human gate — this is what makes people want to use Nectar. The CLI can't deliver this experience.

**Gaps closed in this sprint:**

| Gap | Type | Why it belongs here |
|-----|------|---------------------|
| Missing Hive browser product | Product | Biggest unshipped pillar in INTENT.md |
| GAP-1: Fan-in LLM evaluation | Compliance | Best-of-N fan-in is a high-value workflow; browser run panel should show rationale |
| GAP-5: `pipeline_failed` / `stage_failed` events | Compliance | Browser timeline needs explicit failure events, not inference from generic completions |

**In scope:**

- Same-origin Hive UI served by `nectar serve` (no CORS, no sidecar dev server in production)
- Garden browser for files under `gardens/`
- Dual-pane DOT editor: CodeMirror (DOT source) + live SVG preview
- Server-authoritative preview: unsaved DOT buffers parsed, validated, and rendered server-side
- Natural-language-to-DOT drafting with streaming text deltas
- Pipeline execution view: start run, real-time SSE event stream, graph status updates
- Human gate interaction: pending question UI, answer submission
- Prompted LLM fan-in evaluation in `src/handlers/fan-in.ts`
- Explicit `stage_failed` and `pipeline_failed` events
- Asset build/embed path compatible with single-binary release model
- Dev proxy for local development (Vite → `nectar serve`)

**Out of scope:**

- Seedbed web UI, Kanban board, and drag-and-drop triage
- Swarm Intelligence analysis triggers and comparison view
- Bidirectional visual graph editing (click graph nodes to edit structure)
- Sub-pipeline composition (GAP-4)
- Custom transform registration (GAP-3)
- Gemini extended tool parity (GAP-2)
- Authentication/authorization (INTENT §7 defers this)
- Mobile optimization (desktop-first per INTENT §4)

**Cut line:** If time compresses, cut natural-language drafting, keyboard shortcut polish, and dark mode. Do **not** cut live preview, browser run monitoring, question answering, or the fan-in LLM path. Those are the whole point of the sprint.

---

## Use Cases

1. **Open the Hive.** User runs `nectar serve` and navigates to `http://localhost:4140/`. The SPA loads with a Garden workbench layout: left rail for garden browser, center for the DOT editor, right for SVG preview and run panel.

2. **Browse existing gardens.** The left rail lists `.dot` files under `gardens/` with name and last-modified time. Clicking one loads its source into the editor and triggers a preview.

3. **Edit DOT with live feedback.** The user edits raw DOT in a CodeMirror editor. After a short debounce, the browser sends the unsaved buffer to `POST /gardens/preview` and receives diagnostics plus an SVG preview. Parse failures do not blank the preview; the last good render remains visible until the next valid render arrives.

4. **Draft a garden from natural language.** The user types "a pipeline that plans, implements, tests, and loops on failure." `POST /gardens/draft` streams DOT text into the editor as SSE deltas. The preview updates as the draft arrives.

5. **Save deliberately.** `Cmd/Ctrl+S` writes the current buffer through `PUT /gardens/:name`. The dirty indicator clears only after the server accepts the save.

6. **Run a pipeline from the browser.** User clicks "Run." `POST /pipelines` fires with the `dot_path`. The UI subscribes to the SSE stream, refreshes the graph SVG on relevant events, and shows a run timeline with current node, progress, failures, and completion status.

7. **Handle browser-based approvals.** The pipeline reaches a `wait.human` node. The UI shows the pending question and choices from `GET /pipelines/:id/questions`; the user clicks an answer; execution resumes immediately.

8. **Cancel and resume.** User clicks "Cancel" → `POST /pipelines/{id}/cancel`. A "Resume" button appears → `POST /pipelines/{id}/resume`. SSE reconnects with `Last-Event-ID` replay.

9. **Refresh without losing state.** The current garden and active `run_id` are stored in URL search params. On reload, the UI reconnects to the run stream, reloads the graph, and rehydrates pending questions.

10. **Use intelligent fan-in.** A pipeline with parallel branches and a prompted fan-in node uses the LLM to choose the winning branch based on the authored rubric. The browser run panel shows the chosen branch and rationale.

11. **See failures explicitly.** When a node fails, the run timeline receives `stage_failed`. When the run terminates unsuccessfully, it receives `pipeline_failed`. The browser consumes these directly instead of reverse-engineering failure semantics.

---

## Architecture

### Design Principles

1. **Same-origin app.** `nectar serve` serves both the API and the Hive assets from the same host and port. No CORS, no sidecar dev server in production.

2. **Text-first authoring.** DOT text is the source of truth. The SVG is a preview and execution monitor, not a graph editor.

3. **Server-authoritative parsing and rendering.** The browser never implements its own DOT parser or Graphviz renderer. Unsaved buffers go to the server so frontend behavior cannot drift from runtime behavior.

4. **URL-addressable state.** Selected garden and active run belong in URL search params, not only React state. Reload is a normal case.

5. **Keep binary distribution intact.** Frontend assets are built into a generated TypeScript module so `bun build --compile` still produces a single-file Nectar binary with the Hive included.

### Frontend Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | React 19 + TypeScript | Largest ecosystem, best CodeMirror support |
| Build | Vite 6 | Fast HMR, native ESM, dev proxy built-in |
| Styling | CSS variables + handcrafted components | Matches botanical theme; no heavy UI kit at MVP |
| Code editor | CodeMirror 6 | Best code editor for the web; DOT highlighting via StreamLanguage |
| SSE | Native `EventSource` | Browser-native with `Last-Event-ID` reconnection |
| HTTP | `fetch` | Thin typed wrapper, no axios needed |

### Backend Additions

The existing server already exposes most of the runtime surface. This sprint adds:

- `GET /` — serve the Hive HTML shell
- `GET /assets/*` — serve the embedded JS/CSS bundle
- `POST /gardens/preview` — parse, validate, and render an unsaved DOT buffer without writing to disk
- `POST /gardens/draft` — stream model-generated DOT text as SSE

Existing routes reused directly: `GET /gardens`, `GET /gardens/:name`, `PUT /gardens/:name`, `POST /pipelines`, `GET /pipelines/:id`, `GET /pipelines/:id/events`, `GET /pipelines/:id/graph`, `POST /pipelines/:id/cancel`, `POST /pipelines/:id/resume`, `GET /pipelines/:id/questions`, `POST /pipelines/:id/questions/:qid/answer`.

### Fan-In LLM Evaluation

`src/handlers/fan-in.ts` already has the branch results and heuristic ranking path. This sprint adds the spec-required LLM path:

- If `node.prompt` is absent: keep the current heuristic ranking (unchanged).
- If `node.prompt` is present:
  - Build a structured candidate list from each branch result: `branch_id`, `status`, `notes`, and a bounded excerpt of `last_response`.
  - Append the authored fan-in prompt as the evaluation rubric.
  - Call the LLM using structured JSON output: `{ selected_branch_id, rationale }`.
  - Validate that `selected_branch_id` names an actual branch.
  - Persist the evaluation prompt and response under the run directory for debugging.
  - Write `parallel.fan_in.best_id`, `parallel.fan_in.best_outcome`, and `parallel.fan_in.rationale` into context.

**Deliberate behavior:** when prompted fan-in evaluation fails, the handler fails the node. No silent heuristic fallback.

### Failure Event Taxonomy

Add two explicit events without breaking existing consumers:

- `stage_failed` — emitted whenever a node finishes with failure status
- `pipeline_failed` — emitted whenever a run terminates unsuccessfully

Keep current `node_completed` and `run_error` events for backward compatibility.

### Asset Packaging

Two-step frontend packaging:

1. `vite build` outputs a static bundle under `hive/dist/`
2. `scripts/hive/embed-assets.mjs` reads that bundle and generates `src/generated/hive-assets.ts`

`src/server/static-assets.ts` serves those generated assets from memory. This keeps source-mode development simple, the runtime same-origin, and the existing single-binary release path viable.

### Request Contracts

**`POST /gardens/preview`**

Request:
```json
{
  "dot_source": "digraph G { start [shape=Mdiamond]; ... }"
}
```

Response (always 200, diagnostics for invalid buffers):
```json
{
  "parse_ok": true,
  "valid": false,
  "diagnostics": [],
  "metadata": { "node_count": 5, "edge_count": 4 },
  "svg": "<svg .../>"
}
```

**`POST /gardens/draft`**

Request:
```json
{
  "prompt": "Create a pipeline that plans, implements, tests, and loops on failure",
  "provider": "openai",
  "model": "gpt-5.4"
}
```

SSE events: `draft_start`, `content_delta`, `draft_complete`, `draft_error`.

### Module Layout

```text
hive/
├── index.html
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── lib/
    │   ├── api.ts
    │   ├── draft-stream.ts
    │   └── run-stream.ts
    ├── components/
    │   ├── GardenSidebar.tsx
    │   ├── DraftComposer.tsx
    │   ├── DotEditor.tsx
    │   ├── DiagnosticsPanel.tsx
    │   ├── GraphPreview.tsx
    │   ├── RunPanel.tsx
    │   └── QuestionTray.tsx
    └── styles/
        ├── tokens.css
        └── app.css
src/
├── runtime/
│   ├── garden-preview-service.ts
│   └── garden-draft-service.ts
├── server/
│   ├── server.ts
│   ├── static-assets.ts
│   └── routes/
│       ├── gardens.ts
│       └── pipelines.ts
├── handlers/
│   └── fan-in.ts
├── engine/
│   └── events.ts
└── generated/
    └── hive-assets.ts
scripts/
└── hive/
    └── embed-assets.mjs
```

---

## Implementation

### Phase 1: Frontend Shell, Build Pipeline, and Static Serving (~20%)

**Files:** `package.json`, `hive/index.html`, `hive/vite.config.ts`, `hive/tsconfig.json`, `hive/src/main.tsx`, `hive/src/App.tsx`, `hive/src/styles/*`, `scripts/hive/embed-assets.mjs`, `src/generated/hive-assets.ts`, `src/server/static-assets.ts`, `src/server/server.ts`

**Tasks:**
- [ ] Initialize `hive/` with Vite + React + TypeScript
- [ ] Add frontend dependencies: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, CodeMirror 6 packages
- [ ] Configure Vite dev proxy: `/gardens`, `/pipelines`, `/events` → `http://localhost:4140`
- [ ] Add `build:hive` script that runs `vite build` and then `node scripts/hive/embed-assets.mjs`
- [ ] Create `scripts/hive/embed-assets.mjs` to generate `src/generated/hive-assets.ts` from the built bundle
- [ ] Create `src/server/static-assets.ts` to serve `/` and hashed asset files from the generated manifest
- [ ] Register static asset routes in `src/server/server.ts` (before API routes, SPA fallback for HTML requests)
- [ ] Build the Hive shell: left rail (garden browser), center (editor), right column (preview/run), botanical color tokens
- [ ] Define CSS custom properties for the watercolor-botanical palette (nectar-sage, nectar-lavender, nectar-coral, nectar-honey, nectar-wilted, warm off-white background)
- [ ] Verify source-mode `nectar serve` and compiled `bun build --compile` both serve the Hive correctly

### Phase 2: Server-Side Garden Preview and Drafting (~15%)

**Files:** `src/runtime/garden-preview-service.ts`, `src/runtime/garden-draft-service.ts`, `src/server/routes/gardens.ts`, `src/server/router.ts`, `test/server/gardens-preview.test.ts`, `test/server/gardens-draft.test.ts`

**Tasks:**
- [ ] Add `POST /gardens/preview` — parse, transform, validate, and render unsaved DOT without writing to disk
- [ ] Reuse the existing parser, transform pipeline, diagnostics, and graph renderer (no browser-only parsing path)
- [ ] Add `POST /gardens/draft` as SSE — stream DOT text deltas from the unified LLM client
- [ ] Use the simulation adapter automatically when no real provider keys are configured
- [ ] Constrain the draft prompt to DOT-only output; reject Markdown-fenced responses
- [ ] Bound draft requests to a single in-flight stream per browser tab; stale requests must be abortable
- [ ] Add endpoint tests covering valid preview, invalid preview, draft streaming, and error surfacing

### Phase 3: Garden Authoring UX (~25%)

**Files:** `hive/src/lib/api.ts`, `hive/src/lib/draft-stream.ts`, `hive/src/components/GardenSidebar.tsx`, `hive/src/components/DraftComposer.tsx`, `hive/src/components/DotEditor.tsx`, `hive/src/components/DiagnosticsPanel.tsx`, `hive/src/components/GraphPreview.tsx`, `hive/src/App.tsx`

**Tasks:**
- [ ] Build `api.ts`: typed fetch wrapper for garden and pipeline operations
- [ ] Load `GET /gardens` on startup and show garden list in the sidebar
- [ ] Load `GET /gardens/:name` into the editor; track dirty buffer separately from last saved version
- [ ] Build `DotEditor.tsx`: CodeMirror 6 with DOT syntax highlighting via StreamLanguage (keywords, strings, comments, shapes)
- [ ] Build `GraphPreview.tsx`: displays server-rendered SVG from preview endpoint
- [ ] Debounce preview requests (300ms) and cancel stale ones as the user types
- [ ] Preserve the last valid SVG when the current buffer is invalid
- [ ] Build `DiagnosticsPanel.tsx`: surface parse/validation errors with severity grouping
- [ ] Implement `Cmd/Ctrl+S` save via `PUT /gardens/:name`; dirty indicator clears on success
- [ ] Build `DraftComposer.tsx`: natural-language input, streams DOT into editor buffer via `POST /gardens/draft`
- [ ] Persist selected garden and active `run_id` in URL search params; reload rehydrates state

### Phase 4: Browser Run Monitoring and Human Gates (~25%)

**Files:** `hive/src/lib/run-stream.ts`, `hive/src/components/RunPanel.tsx`, `hive/src/components/QuestionTray.tsx`, `src/engine/events.ts`, `src/engine/engine.ts`, `src/cli/ui/renderer.ts`, `test/server/pipeline-events.test.ts`, `test/integration/hive-run-flow.test.ts`

**Tasks:**
- [ ] Build `run-stream.ts`: SSE client wrapping `EventSource` with typed events, auto-reconnection, `Last-Event-ID` replay
- [ ] Build `RunPanel.tsx`: start runs via `POST /pipelines`, show run timeline with node status, current node, elapsed time
- [ ] Refresh graph SVG on node lifecycle events
- [ ] Build `QuestionTray.tsx`: fetch pending questions, display choices, submit answers, resume execution
- [ ] Support cancel and resume from the run panel
- [ ] Rehydrate active run state on page reload using `run_id` from URL
- [ ] Add `stage_failed` and `pipeline_failed` events to `src/engine/events.ts`
- [ ] Emit `stage_failed` in engine when a node finishes with failure status
- [ ] Emit `pipeline_failed` in engine when a run terminates unsuccessfully
- [ ] Update CLI renderer to handle new event types
- [ ] Keep current `node_completed` and `run_error` events for backward compatibility
- [ ] Add backend integration tests for SSE failure events and question answer flow

### Phase 5: Prompted Fan-In and Final Hardening (~15%)

**Files:** `src/handlers/fan-in.ts`, `src/engine/context.ts`, `test/handlers/fan-in.test.ts`, `test/integration/fan-in-llm.test.ts`, `hive/src/components/RunPanel.tsx`

**Tasks:**
- [ ] Add LLM fan-in path when `node.prompt` is present
- [ ] Build structured candidate list from branch results (branch_id, status, notes, bounded excerpt of last_response)
- [ ] Define strict structured response schema: `{ selected_branch_id, rationale }`
- [ ] Call LLM via normal node resolution rules (llm_provider, llm_model, stylesheet, defaults)
- [ ] Validate `selected_branch_id` names an actual branch
- [ ] Persist fan-in evaluation prompt and response artifacts under the run directory
- [ ] Write `parallel.fan_in.best_id`, `parallel.fan_in.best_outcome`, and `parallel.fan_in.rationale` into context
- [ ] Fail the node on invalid or missing LLM selection — no silent heuristic fallback
- [ ] Keep existing heuristic path unchanged for fan-in nodes without `prompt`
- [ ] Surface chosen branch and rationale in the browser run panel
- [ ] Add deterministic tests using the simulation adapter for the prompted fan-in path

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add Hive build/test scripts |
| `hive/index.html` | Create | Browser entry HTML |
| `hive/vite.config.ts` | Create | Frontend build + dev proxy config |
| `hive/tsconfig.json` | Create | Frontend TypeScript config |
| `hive/src/main.tsx` | Create | React bootstrap |
| `hive/src/App.tsx` | Create | Garden workbench layout and state |
| `hive/src/lib/api.ts` | Create | Typed HTTP helpers for gardens and pipelines |
| `hive/src/lib/draft-stream.ts` | Create | SSE client for DOT drafting |
| `hive/src/lib/run-stream.ts` | Create | SSE client for run monitoring |
| `hive/src/components/GardenSidebar.tsx` | Create | Garden browser / selector |
| `hive/src/components/DraftComposer.tsx` | Create | Natural-language draft input |
| `hive/src/components/DotEditor.tsx` | Create | CodeMirror DOT editor |
| `hive/src/components/DiagnosticsPanel.tsx` | Create | Validation and parse diagnostics |
| `hive/src/components/GraphPreview.tsx` | Create | SVG preview / execution graph |
| `hive/src/components/RunPanel.tsx` | Create | Run status, timeline, cancel/resume, fan-in rationale |
| `hive/src/components/QuestionTray.tsx` | Create | Browser `wait.human` answer flow |
| `hive/src/styles/tokens.css` | Create | Color, spacing, typography tokens |
| `hive/src/styles/app.css` | Create | Hive layout and theme |
| `scripts/hive/embed-assets.mjs` | Create | Generate TS asset manifest from built frontend |
| `src/generated/hive-assets.ts` | Create | Embedded asset manifest for server |
| `src/server/static-assets.ts` | Create | Serve embedded Hive assets |
| `src/server/server.ts` | Modify | Register static asset routes |
| `src/server/routes/gardens.ts` | Modify | Add preview and draft endpoints |
| `src/runtime/garden-preview-service.ts` | Create | Preview unsaved DOT buffers |
| `src/runtime/garden-draft-service.ts` | Create | Stream DOT drafts from LLM |
| `src/engine/events.ts` | Modify | Add `stage_failed` and `pipeline_failed` events |
| `src/engine/engine.ts` | Modify | Emit new failure events |
| `src/cli/ui/renderer.ts` | Modify | Handle new event types |
| `src/handlers/fan-in.ts` | Modify | Add LLM-driven branch selection |
| `test/server/gardens-preview.test.ts` | Create | Preview endpoint tests |
| `test/server/gardens-draft.test.ts` | Create | Draft SSE endpoint tests |
| `test/server/pipeline-events.test.ts` | Create | Failure event tests |
| `test/handlers/fan-in.test.ts` | Modify | Heuristic vs LLM fan-in coverage |
| `test/integration/hive-run-flow.test.ts` | Create | End-to-end browser run flow |
| `test/integration/fan-in-llm.test.ts` | Create | Prompted fan-in integration test |

---

## Definition of Done

### Garden Authoring
- [ ] `nectar serve` serves an HTML Hive app at `/` on the same host and port as the API
- [ ] The browser lists gardens from `GET /gardens` and loads a selected file into the editor
- [ ] DOT syntax highlighting works in the editor (keywords, strings, comments, shapes)
- [ ] Unsaved DOT buffers can be previewed through `POST /gardens/preview` without writing to disk
- [ ] Parse and validation failures show diagnostics without blanking the last good SVG preview
- [ ] `Cmd/Ctrl+S` saves the current garden through `PUT /gardens/:name`
- [ ] Natural-language drafting streams DOT text into the editor through `POST /gardens/draft`

### Pipeline Execution
- [ ] A user can start a pipeline from the browser and watch node-by-node progress live
- [ ] SSE events appear in the run panel in real-time during execution
- [ ] Graph SVG refreshes as nodes progress through the pipeline
- [ ] A `wait.human` node surfaces a question panel with choice buttons
- [ ] Answering a human gate question resumes pipeline execution
- [ ] Canceling a run shows interrupted state with a Resume button
- [ ] Resuming a run picks up from checkpoint; SSE replays missed events
- [ ] Refreshing the page with an active `run_id` reconnects to the run stream

### Failure Events (GAP-5)
- [ ] The engine emits `stage_failed` when a node fails
- [ ] The engine emits `pipeline_failed` when a run terminates unsuccessfully
- [ ] The SSE journal includes the new failure events
- [ ] Existing clients remain backward compatible (current events still emitted)

### Fan-In LLM (GAP-1)
- [ ] Fan-in nodes without `prompt` still use the current heuristic path
- [ ] Fan-in nodes with `prompt` call the LLM, validate the response, and persist the selected branch plus rationale
- [ ] A prompted fan-in evaluation failure causes the node to fail (no silent heuristic fallback)
- [ ] The browser run panel shows the chosen fan-in branch and rationale when present

### Build & Integration
- [ ] `npm run build` succeeds, including the Hive asset generation step
- [ ] `npm test` passes backend and integration coverage for all new code
- [ ] `bun build --compile src/cli/index.ts --outfile /tmp/nectar-smoke` succeeds with the Hive embedded
- [ ] Full flow verified: `nectar serve` → browser → create/edit garden → run → observe SSE → answer human gate

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Frontend assets complicate single-binary release | Medium | High | Generate `src/generated/hive-assets.ts` from built bundle; serve from memory, not filesystem paths |
| Live preview floods the server while typing | High | Medium | Debounce 300ms client-side, cancel stale requests, ignore late responses whose buffer hash no longer matches editor state |
| LLM-generated DOT is often invalid | Medium | Medium | Constrain prompt aggressively, stream into editor (don't auto-save), preserve last valid preview |
| SVG node matching for status overlay is fragile | Medium | Medium | Match on Graphviz `<title>` elements, not generated `id` attributes. Degrade gracefully if match fails |
| No off-the-shelf CodeMirror DOT grammar | High | Low | DOT grammar is simple; ~50-line StreamLanguage mode. Fall back to plain text if needed |
| Prompted fan-in selects nonexistent branches | Medium | High | Strict JSON schema, validate branch IDs, persist model response, fail loudly on invalid selection |
| Browser timeline drifts from server truth | Medium | High | Treat SSE as source of truth, replay from journal on reconnect, re-fetch status/questions |
| Sprint 019 API has bugs or missing endpoints | Medium | High | Start Phase 3 early against Sprint 019's code; mismatches surface immediately |
| Frontend scope is ambitious for one sprint | Medium | Medium | Cut line is explicit: NL drafting and polish drop first. Core trio (editor + preview + run) is the minimum |

---

## Dependencies

| Dependency | Purpose | Install Location |
|------------|---------|-----------------|
| `react` + `react-dom` | UI runtime | hive/ |
| `vite` + `@vitejs/plugin-react` | Frontend build | hive/ (dev) |
| CodeMirror 6 packages | DOT editing | hive/ |
| `@testing-library/react` + `jsdom` | UI tests | hive/ (dev) |
| Existing `@viz-js/viz` | Server-side SVG rendering for preview | already installed |
| Existing unified LLM client | NL drafting and prompted fan-in | already installed |

No new backend framework. No new database. No WebSocket layer. The frontend is entirely under `hive/` with its own `package.json`. Zero new runtime dependencies added to the root backend `package.json`.

**Sprint 019 dependency:** The entire frontend depends on Sprint 019's HTTP server being functional. Phases 1-2 can proceed with mock data, but Phases 3-5 require a working `nectar serve`.
