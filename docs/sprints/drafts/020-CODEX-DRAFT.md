# Sprint 020: The Hive Garden Workbench

## Overview

**Goal:** Ship the first real Hive experience in the browser: a same-origin Garden workbench served by `nectar serve`. After this sprint, a user can open Nectar in a browser, browse and edit `.dot` gardens, preview and validate unsaved DOT buffers, draft a garden from natural language, run it, watch execution live, and answer `wait.human` questions without leaving the page.

**Opinionated call:** The next sprint should **not** be a pure compliance cleanup sprint, and it should **not** try to build the full Seedbed + Kanban + Swarm UI in one shot. `docs/compliance-report.md` shows that the core engine is already largely complete; `docs/INTENT.md` shows that the biggest missing product pillar is still the web UI. The right move is a **Garden-only Hive MVP** that delivers an end-to-end browser workflow on top of the server that already exists.

**Why this sprint, why now:**

1. **The largest remaining gap is an entire unshipped pillar.** Nectar is supposed to be engine + CLI + Hive. The engine, CLI, server, and seed filesystem are largely present. The browser product is still missing.

2. **The backend substrate is already there.** The repo already has garden CRUD, pipeline start/status/SSE/graph/question routes, a graph renderer, and workspace events. This is the moment to cash that investment in instead of building more backend in isolation.

3. **Garden workbench is the right cut line for one sprint.** It is a complete vertical slice: authoring, validation, execution, observation, and human approval. Seedbed Kanban and Swarm Intelligence are still important, but they are broader surfaces and should build on a reusable frontend shell instead of inventing one ad hoc later.

4. **Only two remaining spec gaps materially improve this slice.** `GAP-1` (fan-in LLM evaluation) matters because browser-authored pipelines will immediately want “best of N” merge behavior. `GAP-5` (distinct `pipeline_failed` / `stage_failed` events) matters because a browser run timeline should not infer failure from generic events. The other remaining gaps are real, but they are not the highest-leverage next move.

5. **This sprint satisfies a concrete “done” statement from `INTENT.md`.** It gets Nectar materially closer to: “A user can launch the web UI, create a pipeline by typing what they want in natural language, see it rendered as a graph in real time, edit it, run it, and watch it execute.”

**Gaps closed in this sprint:**

| Gap | Type | Why it belongs here |
|-----|------|---------------------|
| Missing Hive browser product | Product | Biggest unshipped pillar in `INTENT.md` |
| No browser garden drafting / preview loop | Product | Core authoring workflow is absent |
| No browser run monitor / question flow | Product | Existing HTTP runtime is still API-only |
| GAP-1: Fan-in LLM evaluation | Compliance | Best-of-N fan-in is a high-value workflow for Garden authors |
| GAP-5: `pipeline_failed` / `stage_failed` events | Compliance | Browser timeline and status UX need explicit failure events |

**In scope:**

- Same-origin Hive UI served by `nectar serve`
- Garden browser for files under `gardens/`
- Text-first DOT editor with live validation and SVG preview for unsaved buffers
- Natural-language-to-DOT drafting with streaming text deltas
- Browser run monitor built on existing pipeline SSE + graph rendering
- Browser answer flow for `wait.human`
- Prompt-driven LLM fan-in evaluation in `src/handlers/fan-in.ts`
- Explicit `stage_failed` and `pipeline_failed` events, emitted and journaled alongside current events
- Asset build/embed path that still works with the existing single-binary release model

**Out of scope:**

- Seedbed web UI, Kanban board, timeline view, and attachment browsing
- Swarm analysis generation and side-by-side comparison UI
- Bidirectional visual graph editing on the SVG canvas
- Sub-pipeline composition (`GAP-4`)
- Custom transform registration (`GAP-3`)
- Gemini extended tool parity (`GAP-2`)
- Full workspace search, auth, or collaborative editing

**Cut line:** If time compresses, cut model/provider selection UI, keyboard shortcut polish, and graph-node click interactions first. Do **not** cut live preview, browser run monitoring, question answering, or the fan-in LLM path. Those are the whole point of the sprint.

---

## Use Cases

1. **Open the Hive.** A user runs `nectar serve`, opens `http://127.0.0.1:4140/`, and lands in a Garden workbench instead of a bare JSON API.

2. **Browse existing gardens.** The left rail lists `.dot` files under `gardens/`, with modified time and node count. Clicking one loads its source, metadata, and latest validation state.

3. **Edit DOT with live feedback.** The user edits raw DOT in a code editor. After a short debounce, the browser sends the unsaved buffer to the server and receives diagnostics plus an SVG preview. Parse failures do not blank the preview; the last good render remains visible until the next valid render arrives.

4. **Draft a garden from natural language.** The user types “a pipeline that plans, implements, tests, and loops on failure.” Nectar streams DOT text into the editor as it is generated. The diagnostics panel updates as the draft arrives.

5. **Save deliberately.** `Cmd/Ctrl+S` writes the current buffer through `PUT /gardens/:name`. The dirty badge clears only after the server accepts the updated DOT.

6. **Run a garden from the browser.** The user clicks `Run`. Nectar starts the pipeline via `POST /pipelines`, subscribes to the SSE stream, refreshes the graph image on relevant events, and shows a run timeline with current node, retries, failures, and completion.

7. **Handle browser-based approvals.** The pipeline reaches a `wait.human` node. The UI shows the pending question and choices from `GET /pipelines/:id/questions`; the user clicks an answer; execution resumes immediately.

8. **Refresh without losing state.** The current garden and active `run_id` are stored in URL search params. On reload, the UI reconnects to the run stream, reloads the graph, and rehydrates pending questions.

9. **Use intelligent fan-in, not just heuristic fan-in.** A pipeline with parallel branches and a prompted fan-in node uses the LLM to choose the winning branch based on the fan-in rubric, not just `success > partial > failure`.

10. **See failures explicitly.** When a node fails, the run timeline receives `stage_failed`. When the run terminates unsuccessfully, it receives `pipeline_failed`. The browser does not have to reverse-engineer failure semantics from generic completion events.

---

## Architecture

### Design Principles

1. **Same-origin app, not “frontend later.”** `nectar serve` should serve both the API and the Hive assets from the same host and port. No CORS layer, no sidecar dev server in production.

2. **Text-first authoring.** DOT text is the source of truth this sprint. The SVG is a preview and execution monitor, not a graph editor.

3. **Server-authoritative parsing, validation, and rendering.** The browser never implements its own DOT parser or Graphviz renderer. Unsaved buffers go to the server so frontend behavior cannot drift from runtime behavior.

4. **URL-addressable state.** Selected garden and active run belong in the URL search params, not only React state. Reload is a normal case, not an error case.

5. **No silent fan-in fallback.** If a fan-in node has `prompt` set, the handler must call the LLM and return an explicit selection. If that evaluation fails, the node fails. Falling back silently to heuristics would both violate the spec and hide the reason the pipeline behaved differently than authored.

6. **Keep binary distribution intact.** Frontend assets must be buildable into a generated TypeScript module so `bun build --compile` still produces a single-file Nectar binary with the Hive included.

### Frontend Stack

- **React + TypeScript + Vite** for the browser shell
- **CodeMirror 6** for the DOT editor
- **Native `EventSource`** for pipeline and workspace SSE
- **Local CSS variables and handcrafted components**, not a generic UI kit
- **Light-first visual direction** with botanical color tokens that match the CLI/Hive theme

### Backend Additions

The existing server already exposes most of the runtime surface the browser needs. This sprint adds only the missing authoring and asset-serving pieces:

- `GET /` — serve the Hive HTML shell
- `GET /assets/*` — serve the embedded JS/CSS bundle
- `POST /gardens/preview` — parse, transform, validate, and render an unsaved DOT buffer without writing it to disk
- `POST /gardens/draft` — stream model-generated DOT text as SSE

Existing routes reused directly:

- `GET /gardens`
- `GET /gardens/:name`
- `PUT /gardens/:name`
- `POST /pipelines`
- `GET /pipelines/:id`
- `GET /pipelines/:id/events`
- `GET /pipelines/:id/graph`
- `POST /pipelines/:id/cancel`
- `POST /pipelines/:id/resume`
- `GET /pipelines/:id/questions`
- `POST /pipelines/:id/questions/:qid/answer`

### Fan-In LLM Evaluation

`src/handlers/fan-in.ts` already has the branch results and heuristic ranking path. This sprint adds the spec-required LLM path:

- If `node.prompt` is absent: keep the current heuristic ranking.
- If `node.prompt` is present:
  - Build a structured candidate list from each branch result: `branch_id`, `status`, `notes`, `preferred_label`, and a bounded excerpt of `last_response` / relevant artifacts.
  - Append the authored fan-in prompt as the evaluation rubric.
  - Call the LLM selected by normal node resolution rules (`llm_provider`, `llm_model`, stylesheet, defaults).
  - Require structured JSON output: `{ selected_branch_id, rationale }`.
  - Validate that `selected_branch_id` names an actual branch.
  - Persist the evaluation prompt and response under the run directory for debugging.
  - Write `parallel.fan_in.best_id`, `parallel.fan_in.best_outcome`, and `parallel.fan_in.rationale` into context.

**Deliberate behavior:** when prompted fan-in evaluation fails, the handler fails the node. No heuristic fallback.

### Failure Event Taxonomy

Add two explicit events without breaking existing consumers:

- `stage_failed` — emitted whenever a node finishes with failure status
- `pipeline_failed` — emitted whenever a run terminates unsuccessfully

Keep current `node_completed` and `run_error` events for compatibility, but make the browser consume the new explicit failure events.

### Asset Packaging

Use a two-step frontend packaging path:

1. `vite build` outputs a small static bundle under `hive/dist/`
2. `scripts/hive/embed-assets.mjs` reads that bundle and generates `src/generated/hive-assets.ts`

`src/server/static-assets.ts` serves those generated assets from memory. This keeps:

- source-mode development simple
- the runtime same-origin
- the existing single-binary release path viable

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

### Request Contracts

**`POST /gardens/preview`**

Request:

```json
{
  "dot_source": "digraph G { start [shape=Mdiamond]; ... }"
}
```

Response:

```json
{
  "parse_ok": true,
  "valid": false,
  "diagnostics": [],
  "metadata": {
    "node_count": 5,
    "edge_count": 4,
    "graph_attributes": {}
  },
  "svg": "<svg .../>"
}
```

Design choice: return `200` with diagnostics for invalid buffers. The editor needs feedback while the user is typing, not transport-layer failures.

**`POST /gardens/draft`**

Request:

```json
{
  "prompt": "Create a pipeline that plans, implements, tests, and loops on failure",
  "provider": "openai",
  "model": "gpt-5.4"
}
```

SSE events:

- `draft_start`
- `content_delta`
- `draft_complete`
- `draft_error`

Prompt contract: output raw DOT only, exactly one `digraph`, no Markdown fences, and only Nectar-supported shapes and attributes.

---

## Implementation phases

### Phase 1: Frontend Shell, Build Pipeline, and Static Serving (~20%)

**Files:** `package.json`, `hive/index.html`, `hive/vite.config.ts`, `hive/tsconfig.json`, `hive/src/main.tsx`, `hive/src/App.tsx`, `hive/src/styles/*`, `scripts/hive/embed-assets.mjs`, `src/generated/hive-assets.ts`, `src/server/static-assets.ts`, `src/server/server.ts`

**Tasks:**

- [ ] Add frontend dependencies: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, CodeMirror 6 packages
- [ ] Add UI test dependencies: `@testing-library/react`, `jsdom`
- [ ] Add `build:hive` script that runs `vite build` and then `node scripts/hive/embed-assets.mjs`
- [ ] Update the main `build` pipeline so backend compilation consumes the generated `src/generated/hive-assets.ts`
- [ ] Create a small static asset server that serves `/` and hashed asset files from the generated manifest
- [ ] Keep the current `/health`, `/gardens`, `/seeds`, and `/pipelines` API routes unchanged
- [ ] Create the first-page shell with a left rail, center editor, right preview/run column, and light-first botanical styling
- [ ] Verify that source-mode `nectar serve` and compiled `bun build --compile` both still serve the Hive correctly

### Phase 2: Server-Side Garden Preview and Drafting (~20%)

**Files:** `src/runtime/garden-preview-service.ts`, `src/runtime/garden-draft-service.ts`, `src/server/routes/gardens.ts`, `src/server/router.ts`, `test/server/gardens-preview.test.ts`, `test/server/gardens-draft.test.ts`

**Tasks:**

- [ ] Add `POST /gardens/preview` to validate and render unsaved DOT without writing it to disk
- [ ] Reuse the existing parser, transform pipeline, diagnostics, and graph renderer; do not create a browser-only parsing path
- [ ] Add `POST /gardens/draft` as SSE; stream DOT text deltas from the unified LLM client
- [ ] Use the simulation adapter automatically when no real provider keys are configured so the feature remains testable and demoable
- [ ] Constrain the draft prompt to DOT-only output and reject Markdown-fenced responses
- [ ] Bound draft requests to a single in-flight stream per browser tab; stale requests must be abortable
- [ ] Add endpoint tests covering valid preview, invalid preview, draft streaming, and error surfacing

### Phase 3: Garden Authoring UX (~25%)

**Files:** `hive/src/lib/api.ts`, `hive/src/lib/draft-stream.ts`, `hive/src/components/GardenSidebar.tsx`, `hive/src/components/DraftComposer.tsx`, `hive/src/components/DotEditor.tsx`, `hive/src/components/DiagnosticsPanel.tsx`, `hive/src/components/GraphPreview.tsx`, `hive/src/App.tsx`, `hive/src/App.test.tsx`

**Tasks:**

- [ ] Load `GET /gardens` on startup and show a stable list of existing `.dot` files
- [ ] Load `GET /gardens/:name` into the editor and track a dirty buffer separately from the last saved version
- [ ] Debounce preview requests and cancel stale ones as the user types
- [ ] Preserve the last valid SVG when the current buffer is invalid
- [ ] Surface diagnostics in a dedicated panel with error/warning grouping
- [ ] Implement `Cmd/Ctrl+S` save
- [ ] Disable save while validation errors are present
- [ ] Implement natural-language drafting panel with streamed DOT inserted directly into the current editor buffer
- [ ] Persist the selected garden and active `run_id` in URL search params, and keep the unsaved editor buffer in session-local state so refresh behaves predictably

### Phase 4: Browser Run Monitoring and Human Gates (~20%)

**Files:** `hive/src/lib/run-stream.ts`, `hive/src/components/RunPanel.tsx`, `hive/src/components/QuestionTray.tsx`, `src/engine/events.ts`, `src/server/routes/pipelines.ts`, `test/server/pipeline-events.test.ts`, `test/integration/hive-run-flow.test.ts`

**Tasks:**

- [ ] Start runs from the browser via `POST /pipelines`
- [ ] Subscribe to `GET /pipelines/:id/events` with reconnect-safe SSE handling
- [ ] Refresh the graph SVG on node lifecycle and failure events
- [ ] Add `stage_failed` and `pipeline_failed` events while keeping current event names for compatibility
- [ ] Fetch pending questions from `GET /pipelines/:id/questions` and answer them via `POST /pipelines/:id/questions/:qid/answer`
- [ ] Support cancel and resume directly from the run panel
- [ ] Rehydrate active run state on reload using `run_id` from the URL
- [ ] Add backend integration tests for SSE failure events and question answer flow

### Phase 5: Prompted Fan-In and Final Hardening (~15%)

**Files:** `src/handlers/fan-in.ts`, `src/engine/context.ts`, `test/handlers/fan-in.test.ts`, `test/integration/fan-in-llm.test.ts`, `hive/src/components/RunPanel.tsx`

**Tasks:**

- [ ] Add the spec-required LLM fan-in path when `node.prompt` is present
- [ ] Define a strict structured response schema: `selected_branch_id` + `rationale`
- [ ] Persist fan-in evaluation prompt/response artifacts under the run directory
- [ ] Fail the node on invalid or missing LLM selection; do not silently revert to heuristics
- [ ] Surface the chosen branch and rationale in the browser run panel
- [ ] Keep the existing heuristic path unchanged for fan-in nodes without prompts
- [ ] Add deterministic tests using the simulation adapter for the prompted fan-in path

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add Hive build/test scripts and frontend dependencies |
| `hive/index.html` | Create | Browser entry HTML for the Hive shell |
| `hive/vite.config.ts` | Create | Frontend build configuration |
| `hive/tsconfig.json` | Create | Frontend TypeScript configuration |
| `hive/src/main.tsx` | Create | React bootstrap |
| `hive/src/App.tsx` | Create | Main Garden workbench layout and state wiring |
| `hive/src/lib/api.ts` | Create | Typed HTTP helpers for gardens and pipelines |
| `hive/src/lib/draft-stream.ts` | Create | SSE client for DOT drafting |
| `hive/src/lib/run-stream.ts` | Create | SSE client for run monitoring |
| `hive/src/components/GardenSidebar.tsx` | Create | Garden browser / selector |
| `hive/src/components/DraftComposer.tsx` | Create | Natural-language draft input |
| `hive/src/components/DotEditor.tsx` | Create | CodeMirror DOT editor |
| `hive/src/components/DiagnosticsPanel.tsx` | Create | Validation and parse diagnostics UI |
| `hive/src/components/GraphPreview.tsx` | Create | SVG preview / execution graph view |
| `hive/src/components/RunPanel.tsx` | Create | Run status, timeline, cancel/resume, fan-in rationale |
| `hive/src/components/QuestionTray.tsx` | Create | Browser `wait.human` answer flow |
| `hive/src/styles/tokens.css` | Create | Shared color, spacing, and typography tokens |
| `hive/src/styles/app.css` | Create | Hive-specific layout and theme |
| `scripts/hive/embed-assets.mjs` | Create | Generate a TypeScript asset manifest from the built frontend |
| `src/generated/hive-assets.ts` | Create | Embedded asset manifest consumed by the server |
| `src/server/static-assets.ts` | Create | Serve embedded Hive assets |
| `src/server/server.ts` | Modify | Register static asset routes before API routes |
| `src/runtime/garden-preview-service.ts` | Create | Preview unsaved DOT buffers via the existing graph pipeline |
| `src/runtime/garden-draft-service.ts` | Create | Stream DOT drafts from the unified LLM client |
| `src/server/routes/gardens.ts` | Modify | Add preview and draft endpoints |
| `src/server/routes/pipelines.ts` | Modify | Support browser-friendly run monitoring details where needed |
| `src/engine/events.ts` | Modify | Add `stage_failed` and `pipeline_failed` events |
| `src/handlers/fan-in.ts` | Modify | Add LLM-driven branch selection when `prompt` is set |
| `test/server/gardens-preview.test.ts` | Create | Backend tests for preview behavior |
| `test/server/gardens-draft.test.ts` | Create | Backend tests for draft SSE behavior |
| `test/server/pipeline-events.test.ts` | Create | Backend tests for explicit failure events |
| `test/handlers/fan-in.test.ts` | Modify | Unit coverage for heuristic vs LLM fan-in |
| `test/integration/hive-run-flow.test.ts` | Create | End-to-end server/browser run flow smoke test |
| `test/integration/fan-in-llm.test.ts` | Create | Prompted fan-in integration coverage |

---

## Definition of Done

- [ ] `nectar serve` serves an HTML Hive app at `/` on the same host and port as the API
- [ ] The browser lists gardens from `GET /gardens` and loads a selected file into the editor
- [ ] Unsaved DOT buffers can be previewed through `POST /gardens/preview` without writing to disk
- [ ] Parse and validation failures show diagnostics in the UI without blanking the last good SVG preview
- [ ] `Cmd/Ctrl+S` saves the current garden through `PUT /gardens/:name`
- [ ] Natural-language drafting streams DOT text into the editor through `POST /gardens/draft`
- [ ] A user can start a pipeline from the browser and watch node-by-node progress live
- [ ] A user can answer `wait.human` questions from the browser and the run resumes immediately
- [ ] Refreshing the page with an active `run_id` reconnects to the run stream and reloads the current graph state
- [ ] The engine emits `stage_failed` when a node fails and `pipeline_failed` when a run fails
- [ ] The SSE journal includes the new failure events and existing clients remain backward compatible
- [ ] Fan-in nodes without `prompt` still use the current heuristic path
- [ ] Fan-in nodes with `prompt` call the LLM, validate the response, and persist the selected branch plus rationale
- [ ] A prompted fan-in evaluation failure causes the node to fail rather than silently reverting to heuristics
- [ ] The browser run panel shows the chosen fan-in branch and rationale when present
- [ ] `npm run build` succeeds, including the Hive asset generation step
- [ ] `npm test` passes backend, UI, and integration coverage for the new flow
- [ ] `bun build --compile src/cli/index.ts --outfile /tmp/nectar-smoke` still succeeds with the Hive embedded

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Frontend assets complicate the existing single-binary release flow | Medium | High | Generate `src/generated/hive-assets.ts` from the built bundle and serve assets from memory; do not rely on runtime-relative filesystem paths. |
| Live preview floods the server while typing | High | Medium | Debounce requests client-side, cancel stale requests, and ignore late responses whose buffer hash no longer matches the editor state. |
| LLM-generated DOT is often invalid | Medium | Medium | Constrain the prompt aggressively, stream into the editor instead of auto-saving, and preserve the last valid preview while the draft is imperfect. |
| Browser timeline drifts from server truth | Medium | High | Treat SSE as the source of truth, replay from the journal on reconnect, and re-fetch status / questions on reconnect. |
| Prompted fan-in is unstable or selects nonexistent branches | Medium | High | Use a strict JSON schema, validate branch IDs, persist the model response, and fail loudly on invalid selections. |
| Scope expands into Seedbed and Swarm UI work | High | High | Keep the sprint to Gardens only. Reuse the frontend shell next sprint; do not start Kanban or analysis views here. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| `react` | Hive UI runtime |
| `react-dom` | Browser rendering |
| `vite` | Frontend build pipeline |
| `@vitejs/plugin-react` | React support in Vite |
| CodeMirror 6 packages | DOT editing experience |
| `@testing-library/react` | UI smoke and interaction tests |
| `jsdom` | Browser-like environment for UI tests |
| Existing `@viz-js/viz` | Server-side SVG rendering for preview and run graph refresh |
| Existing unified LLM client | Natural-language DOT drafting and prompted fan-in evaluation |

No new backend framework. No new database. No WebSocket layer. Keep the architecture text-first, same-origin, and file-system-backed.
