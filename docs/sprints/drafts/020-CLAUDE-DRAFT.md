# Sprint 020: The Hive MVP — Pipeline Editor, Live Execution, and Seedbed Kanban

## Overview

**Goal:** Ship a working web UI ("The Hive") that lets a user open a browser, browse and edit DOT pipelines in a dual-pane editor, run them with real-time SSE observation, answer human gate questions, and manage seeds on a drag-and-drop kanban board — all backed by the `nectar serve` runtime from Sprint 019.

**Why this sprint, why now:**

1. **The Hive is 1/3 of Nectar's value proposition and 0% implemented.** INTENT.md defines Nectar as three things: a pipeline engine (done), a CLI (done), and a web UI (untouched). After 19 sprints and ~50 source files, zero lines of frontend code exist. The engine and CLI are mature; the product is invisible to anyone who doesn't live in a terminal.

2. **Sprint 019 fully unblocked it.** The HTTP server, SSE event streaming, garden/seed CRUD endpoints, human gate question/answer endpoints, SVG rendering, and event journal replay are all landing in Sprint 019. The backend contract from INTENT §4 is fulfilled. There are zero remaining backend blockers for the frontend.

3. **The compliance gaps are small; the product gap is massive.** GAP-1 through GAP-5 are collectively ~2-3 days of focused work. They improve spec compliance at the margins. The Hive is what transforms Nectar from a CLI tool into a product — it's the difference between "useful for the author" and "demoable to anyone." Continuing to polish internals while the web UI doesn't exist is the wrong priority call.

4. **Idea capture needs a visual interface.** The seedbed CLI works. The seed CRUD API works. But the kanban board, drag-and-drop triage, and analysis comparison views exist only in the INTENT doc. The seedbed's UX ceiling is the terminal until The Hive ships.

5. **Real-time pipeline observation is a killer demo.** Watching nodes light up as they execute, SSE events streaming in, clicking to approve a human gate — this is what makes people want to use Nectar. The CLI can't deliver this experience. Neither can documentation.

**In scope:**

- Vite + React + TypeScript SPA scaffold under `web/`
- Dual-pane DOT editor: CodeMirror (DOT source) + live SVG graph preview via `@viz-js/viz` WASM
- Pipeline execution view: start run, real-time SSE event stream, node status overlay on graph
- Human gate interaction: pending question UI, answer submission, timeout countdown
- Seedbed kanban board: 5 columns by status, drag-and-drop, seed detail panel
- Seed creation form (title, body, priority, tags)
- Garden file browser: list, select, create, delete
- Watercolor-floral design system per INTENT §3
- Dark mode toggle
- Static file serving from `nectar serve` for production builds
- Dev proxy to `nectar serve` backend

**Out of scope:**

- Natural language → DOT generation (needs prompt engineering work)
- Swarm Intelligence analysis triggers and side-by-side comparison view
- Bidirectional diagram editing (click graph nodes to edit structure)
- File upload for seed attachments
- Remaining attractor compliance gaps (GAP-1 through GAP-5)
- Authentication/authorization (INTENT §7 defers this)
- Mobile optimization (desktop-first per INTENT §4)

**Cut line:** If time compresses, cut the Dashboard page, RunHistory page, and seed detail panel. The core trio — editor, execution view, kanban — is the MVP.

---

## Use Cases

1. **Open The Hive.** User runs `nectar serve` and navigates to `http://localhost:4140`. The SPA loads with sidebar navigation: Gardens, Seedbed, Runs. The dashboard shows a summary: active runs, seed counts by status, garden count.

2. **Browse gardens.** User clicks "Gardens." A card grid shows each `.dot` file with name, node count, and last-modified date. Clicking a card opens the dual-pane editor.

3. **Edit a pipeline.** Left pane: CodeMirror editor with DOT syntax highlighting, line numbers, bracket matching, and autocomplete for node shapes and common attributes. Right pane: live SVG preview rendered by `@viz-js/viz` (client-side WASM, no server round-trip). Edits trigger debounced re-render (300ms). Save writes via `PUT /gardens/:name`.

4. **Create a new garden.** User clicks "New Garden," enters a name, gets a `digraph` template, and starts editing. Save creates the file on disk via the garden API.

5. **Run a pipeline from the editor.** User clicks "Run" in the toolbar. `POST /pipelines` fires with the `dot_path`. UI navigates to the execution view. The SVG graph renders with node status overlays: gray=pending, amber=running (with CSS pulse animation), green=success, red=failure, blue=waiting-for-human. An event log panel below streams SSE events in real-time with timestamps and type badges.

6. **Answer a human gate.** Pipeline hits a `wait.human` node. The node turns blue on the graph. A panel appears with question text, choice buttons (styled with accelerator key hints), and a countdown timer if timeout is set. User clicks a choice. `POST /pipelines/{id}/questions/{qid}/answer` resolves it. Execution continues. Page refresh re-fetches pending questions from `GET /pipelines/{id}/questions` — nothing is lost.

7. **Cancel a running pipeline.** User clicks "Cancel." `POST /pipelines/{id}/cancel` fires. Graph shows interrupted state. A "Resume" button appears.

8. **Resume a pipeline.** User clicks "Resume" on an interrupted run. Backend resumes from checkpoint. SSE stream reconnects with `Last-Event-ID` replay — missed events are replayed before live streaming resumes.

9. **View the seedbed kanban.** User clicks "Seedbed." A kanban board with five columns: Seedling (sage green), Sprouting (lavender), Blooming (coral), Honey (golden), Wilted (warm gray). Each card shows title, priority badge, tag chips, creation date.

10. **Drag a seed between columns.** User drags a card from "Seedling" to "Sprouting." Optimistic UI moves the card immediately. `PATCH /seeds/:id` fires with the new status. On failure, the card reverts with an error toast.

11. **Create a new seed.** Quick-entry bar at the top of the kanban. Enter title (required), body, priority, tags. `POST /seeds` creates the directory structure on disk.

12. **View seed details.** Clicking a seed card opens a slide-out panel: `seed.md` rendered as markdown, `meta.yaml` fields, analysis status indicators (pending/complete/failed per provider), linked gardens.

13. **Toggle dark mode.** Header toggle switches light/dark. Watercolor accent palette desaturates for dark mode. Preference persists in `localStorage`.

14. **Keyboard shortcuts.** `Ctrl+Enter` runs the current garden. `Escape` closes modals. `Ctrl+S` saves in the editor.

---

## Architecture

### Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | React 19 + TypeScript | Largest ecosystem, best CodeMirror and DnD library support |
| Build | Vite 6 | Fast HMR, native ESM, zero-config TS, dev proxy built-in |
| Styling | Tailwind CSS 4 | Design token system maps cleanly to the watercolor palette; `dark:` variants |
| Code editor | CodeMirror 6 | Best code editor for the web; DOT highlighting via custom StreamLanguage |
| Graph render | `@viz-js/viz` (WASM) | Client-side Graphviz — no server round-trip for preview, no system dependency |
| Drag-and-drop | `@dnd-kit/core` + `@dnd-kit/sortable` | Lightweight, accessible, React-native DnD |
| SSE | Native `EventSource` | Browser-native SSE with `Last-Event-ID` reconnection |
| HTTP | `fetch` | No axios needed; thin typed wrapper |
| Markdown | `react-markdown` + `remark-gfm` | Seed content rendering |
| Icons | `lucide-react` | Clean, consistent, tree-shakeable |
| Routing | `react-router-dom` v7 | Standard React routing |
| State | React context + `useReducer` | No Redux/Zustand needed at MVP scale |

### Directory Layout

```
web/
├── index.html
├── package.json
├── vite.config.ts               # Dev proxy → localhost:4140
├── tailwind.config.ts           # Watercolor palette tokens
├── tsconfig.json
├── public/
│   └── favicon.svg
├── src/
│   ├── main.tsx                 # React root + router
│   ├── App.tsx                  # Shell: sidebar, header, dark mode
│   ├── api/
│   │   ├── client.ts            # Typed fetch wrapper
│   │   ├── gardens.ts           # Garden CRUD
│   │   ├── pipelines.ts         # Pipeline lifecycle
│   │   └── seeds.ts             # Seed CRUD
│   ├── hooks/
│   │   ├── useSSE.ts            # SSE with reconnect + typed events
│   │   ├── usePipeline.ts       # Aggregates SSE → pipeline state
│   │   ├── useGardens.ts        # Garden list + CRUD
│   │   └── useSeeds.ts          # Seed list + CRUD, optimistic updates
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── GardenList.tsx
│   │   ├── GardenEditor.tsx     # Dual-pane editor
│   │   ├── RunView.tsx          # Execution observation
│   │   ├── RunHistory.tsx       # Past runs list
│   │   └── Seedbed.tsx          # Kanban board
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Shell.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── Header.tsx
│   │   ├── editor/
│   │   │   ├── DotEditor.tsx    # CodeMirror wrapper
│   │   │   ├── GraphPreview.tsx # viz.js SVG renderer
│   │   │   └── EditorToolbar.tsx
│   │   ├── execution/
│   │   │   ├── ExecutionView.tsx # Graph + event log composite
│   │   │   ├── GraphOverlay.tsx  # Node status coloring on SVG
│   │   │   ├── EventLog.tsx      # Scrolling SSE event list
│   │   │   └── HumanGate.tsx     # Question/answer panel
│   │   ├── kanban/
│   │   │   ├── KanbanBoard.tsx
│   │   │   ├── KanbanColumn.tsx
│   │   │   ├── SeedCard.tsx
│   │   │   └── SeedDetail.tsx
│   │   ├── seeds/
│   │   │   └── SeedForm.tsx
│   │   └── shared/
│   │       ├── Badge.tsx
│   │       ├── Button.tsx
│   │       ├── Modal.tsx
│   │       └── Spinner.tsx
│   ├── theme/
│   │   ├── tokens.ts            # Palette, spacing, typography
│   │   ├── watercolor.css       # Accent washes, paint-bleed borders
│   │   └── dark-mode.ts         # Context + toggle
│   └── types/
│       ├── garden.ts
│       ├── pipeline.ts
│       ├── seed.ts
│       └── events.ts
```

### Design System — Watercolor-Floral

Per INTENT §3 "Modern and Opinionated":

**Color Palette (Tailwind tokens + CSS custom properties):**

| Token | Light | Dark | Semantic Use |
|-------|-------|------|-------------|
| `nectar-sage` | `#a8c5a0` | `#6b8a63` | Seedling, success, start nodes |
| `nectar-lavender` | `#b8a9c9` | `#7a6b8a` | Sprouting, secondary accent |
| `nectar-coral` | `#e8a598` | `#a06b60` | Blooming, primary action, running |
| `nectar-honey` | `#e8c870` | `#a08840` | Honey/completed, highlights |
| `nectar-wilted` | `#c0b0a0` | `#706050` | Wilted/disabled/canceled |
| `nectar-bg` | `#faf8f5` | `#1a1816` | Page background (warm off-white) |
| `nectar-surface` | `#ffffff` | `#242220` | Cards, panels |
| `nectar-text` | `#2d2a26` | `#e8e4e0` | Primary text |

**Typography:** Inter for UI text. JetBrains Mono for DOT editor and event log. Scale: 12/14/16/20/24/32px.

**Texture:** Subtle watercolor wash backgrounds on empty states and the dashboard hero. CSS `background-image` with low-opacity watercolor SVG or gradient approximations. Cards use slightly irregular `border-radius` per corner to evoke painted edges. Keep it minimal — a hint of texture, not an art project.

### Backend Integration

The Hive consumes the exact API surface from Sprint 019:

| UI Feature | Endpoint(s) |
|------------|-------------|
| Garden list | `GET /gardens` |
| Garden save | `PUT /gardens/:name` |
| Garden delete | `DELETE /gardens/:name` |
| Start pipeline | `POST /pipelines` |
| Run status | `GET /pipelines/{id}` |
| SSE events | `GET /pipelines/{id}/events` (with `Last-Event-ID` replay) |
| Cancel | `POST /pipelines/{id}/cancel` |
| Graph SVG (fallback) | `GET /pipelines/{id}/graph` |
| Human gate questions | `GET /pipelines/{id}/questions` |
| Answer question | `POST /pipelines/{id}/questions/{qid}/answer` |
| Checkpoint | `GET /pipelines/{id}/checkpoint` |
| Context store | `GET /pipelines/{id}/context` |
| Seed list | `GET /seeds` |
| Create seed | `POST /seeds` |
| Update seed | `PATCH /seeds/:id` |
| Workspace events | `GET /events` |

### Serving Strategy

**Development:** Vite dev server on `:5173` proxies API calls (`/gardens`, `/seeds`, `/pipelines`, `/events`) to `nectar serve` on `:4140`.

**Production:** `nectar serve` serves the built SPA from a known static directory. When `web/dist/` exists (relative to the Nectar install or workspace), serve it at the root path with SPA fallback — any `GET` request accepting `text/html` that doesn't match an API route returns `index.html`. API routes take precedence.

This requires one small addition to `src/server/server.ts`: static file serving middleware.

### Data Flow

```
Browser (The Hive SPA)
  │
  ├── REST (fetch)  ────────→  nectar serve (:4140)  ────→  filesystem
  │                                   │
  ├── SSE (EventSource)  ───→  /pipelines/{id}/events  ──→  event journal replay + live
  │
  └── @viz-js/viz (WASM)  ──→  client-side DOT→SVG (no server needed for preview)
```

---

## Implementation

### Phase 1: Scaffold, Design System, & Layout Shell (~15%)

**Files:** `web/package.json`, `web/vite.config.ts`, `web/tailwind.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/theme/*`, `web/src/components/layout/*`, `web/src/components/shared/*`, `web/src/api/client.ts`

**Tasks:**
- [ ] Initialize `web/` with `npm create vite@latest -- --template react-ts`
- [ ] Install dependencies: `tailwindcss`, `@tailwindcss/vite`, `react-router-dom`, `@codemirror/view`, `@codemirror/state`, `@codemirror/language`, `@viz-js/viz`, `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `react-markdown`, `remark-gfm`, `lucide-react`
- [ ] Configure Vite dev proxy: `/gardens`, `/seeds`, `/pipelines`, `/events` → `http://localhost:4140`
- [ ] Define Tailwind theme: watercolor palette tokens, Inter + JetBrains Mono fonts, border-radius variants
- [ ] Create `watercolor.css`: subtle gradient backgrounds for empty states, paint-bleed border treatment on cards
- [ ] Build `Shell.tsx`: sidebar (Gardens, Seedbed, Runs links with lucide icons), header (workspace name, dark mode toggle), main content area
- [ ] Build shared components: `Button` (primary/secondary/ghost variants with palette colors), `Badge` (status + priority), `Modal` (overlay with backdrop blur), `Spinner`
- [ ] Implement dark mode: React context, `localStorage` persistence, Tailwind `dark:` class on `<html>`
- [ ] Set up React Router: `/` → Dashboard, `/gardens` → GardenList, `/gardens/:name` → GardenEditor, `/runs/:id` → RunView, `/runs` → RunHistory, `/seedbed` → Seedbed
- [ ] Build `api/client.ts`: typed `fetch` wrapper with error handling, base URL config, JSON/text response helpers

### Phase 2: DOT Editor & Garden Management (~25%)

**Files:** `web/src/pages/GardenList.tsx`, `web/src/pages/GardenEditor.tsx`, `web/src/components/editor/*`, `web/src/hooks/useGardens.ts`, `web/src/api/gardens.ts`, `web/src/types/garden.ts`

**Tasks:**
- [ ] Build `api/gardens.ts`: list, get, create, update, delete garden API calls
- [ ] Build `useGardens` hook: garden list with loading/error states, CRUD mutations
- [ ] Build `GardenList` page: card grid showing garden name, node count (parsed client-side), last modified. "New Garden" button.
- [ ] Build `DotEditor.tsx`: CodeMirror 6 wrapper. DOT syntax highlighting via `StreamLanguage` with a simple mode that highlights keywords (`digraph`, `subgraph`, `->`, shape names like `box`, `diamond`, `hexagon`), strings, comments, and attributes. Line numbers, bracket matching, basic autocomplete for shape names.
- [ ] Build `GraphPreview.tsx`: initializes `@viz-js/viz` WASM instance (lazy-loaded on first render). Takes DOT source, renders to SVG string, displays via `dangerouslySetInnerHTML` with sanitization. Shows error overlay with Graphviz parse error when DOT is malformed. Debounced (300ms after last edit).
- [ ] Build `EditorToolbar.tsx`: Save button (Ctrl+S), Validate button, Run button (Ctrl+Enter). Save indicator (checkmark/spinner).
- [ ] Build `GardenEditor` page: horizontal split pane with draggable divider. CodeMirror left, SVG preview right, toolbar top. Loads garden content via API on mount.
- [ ] New garden flow: modal with name input → create with template `digraph { start [shape=Mdiamond]; exit [shape=Msquare]; start -> exit; }` → navigate to editor
- [ ] Save: `PUT /gardens/:name` with editor content. Show save confirmation in toolbar.

### Phase 3: Pipeline Execution & SSE (~25%)

**Files:** `web/src/pages/RunView.tsx`, `web/src/pages/RunHistory.tsx`, `web/src/components/execution/*`, `web/src/hooks/useSSE.ts`, `web/src/hooks/usePipeline.ts`, `web/src/api/pipelines.ts`, `web/src/types/events.ts`, `web/src/types/pipeline.ts`

**Tasks:**
- [ ] Build `api/pipelines.ts`: start, status, cancel, resume, list runs, get checkpoint, get context
- [ ] Build `useSSE` hook: wraps `EventSource`. Typed event parsing (JSON per event data field). Auto-reconnection with exponential backoff. `Last-Event-ID` sent on reconnect for replay. Connection status indicator (connected/reconnecting/disconnected). Cleanup on unmount.
- [ ] Build `usePipeline` hook: starts SSE subscription for a run ID. Accumulates events into pipeline state: map of node ID → status (pending/running/success/failure/waiting), current node, event log array, pending questions. Derives pipeline status from events (running/completed/failed/interrupted).
- [ ] Build `EventLog.tsx`: scrolling list of events. Each row: timestamp, event type badge (color-coded), message. Event types mapped to human-readable messages (e.g. `node_started` → "Petal [plan] blooming", `node_completed` → "sweet success (3.2s)"). Auto-scroll with "scroll to bottom" button when user scrolls up.
- [ ] Build `GraphOverlay.tsx`: takes the DOT source, renders SVG via `@viz-js/viz`, then post-processes the SVG DOM to add status classes to node groups. Strategy: Graphviz outputs `<g>` groups with `<title>` elements containing the node ID. Query `<title>` text to match node IDs, then add CSS classes to the parent `<g>` for status coloring. CSS: `.node-running { fill: var(--nectar-coral); animation: pulse 1.5s infinite; }`, `.node-success { fill: var(--nectar-sage); }`, etc.
- [ ] Build `HumanGate.tsx`: when `usePipeline` detects a pending question (from `GET /pipelines/{id}/questions`), show a panel anchored to the bottom of the execution view. Displays question text, choice buttons with accelerator key labels, countdown timer bar (width decreasing CSS animation). Button click fires `POST /pipelines/{id}/questions/{qid}/answer`. Poll for questions on page load and when a `wait.human` node starts (from SSE events).
- [ ] Build `ExecutionView.tsx`: top = graph with overlay (takes ~60% height), bottom = event log (~40%), floating human gate panel when active. Status bar: run ID, elapsed time, current node name.
- [ ] Build `RunView` page: loads run status on mount, connects SSE, renders `ExecutionView`. Cancel/Resume buttons in toolbar based on run state.
- [ ] "Run from editor" flow: Run button → `POST /pipelines { dot_path }` → get `run_id` → `navigate(/runs/${run_id})` → SSE connects → live execution view
- [ ] Build `RunHistory` page: list of past runs with status badge, pipeline name, duration, started_at. Click navigates to RunView.
- [ ] Build `Dashboard` page: summary cards (active runs, seeds by status, garden count). Recent activity feed from workspace SSE (`GET /events`).

### Phase 4: Seedbed Kanban (~25%)

**Files:** `web/src/pages/Seedbed.tsx`, `web/src/components/kanban/*`, `web/src/components/seeds/*`, `web/src/hooks/useSeeds.ts`, `web/src/api/seeds.ts`, `web/src/types/seed.ts`

**Tasks:**
- [ ] Build `api/seeds.ts`: list (with optional status/priority filter), create, update
- [ ] Build `useSeeds` hook: fetches seed list, groups by status into columns, handles optimistic updates on drag, reverts on API failure
- [ ] Build `KanbanBoard.tsx`: 5 columns matching seed lifecycle. Column headers use semantic accent colors. `DndContext` + `SortableContext` wrapping.
- [ ] Build `KanbanColumn.tsx`: droppable area with column header (status name, count badge, colored left border). Scrollable card list.
- [ ] Build `SeedCard.tsx`: `useSortable` draggable. Shows title (truncated), priority badge (queens_order gets a crown icon from lucide), tag chips, relative timestamp. Hover state with subtle elevation. Click opens detail panel.
- [ ] Implement drag-and-drop: `@dnd-kit` `DndContext` with `closestCorners` collision detection. `onDragEnd`: optimistic state update → `PATCH /seeds/:id { status }` → revert + error toast on failure.
- [ ] Build `SeedDetail.tsx`: slide-out panel from right edge. Shows `seed.md` rendered via `react-markdown`, metadata table (priority, tags, created_at, updated_at), analysis status indicators (green check / amber spinner / red X / gray dash per provider). Close button + Escape key.
- [ ] Build `SeedForm.tsx`: modal form. Title (required text input), body (markdown textarea with preview toggle), priority (select: low/normal/high/queens_order), tags (comma-separated input that creates chips). Submit → `POST /seeds` → close modal → new card appears in Seedling column.
- [ ] Quick-entry bar at top of Seedbed page: title input + Enter to fast-create a seedling with default priority.

### Phase 5: Static Serving & Integration (~10%)

**Files:** `src/server/server.ts` (modify), `src/cli/commands/serve.ts` (modify), `package.json` (modify)

**Tasks:**
- [ ] Add static file serving to `nectar serve`: if `web/dist/` exists (checked relative to workspace root, then relative to binary), serve static files. SPA fallback: `GET` requests accepting `text/html` that don't match `/gardens`, `/seeds`, `/pipelines`, `/events` API prefixes return `index.html`.
- [ ] Add `--open` flag to `nectar serve`: auto-opens `http://localhost:{port}` in default browser via `open` (macOS) or `xdg-open` (Linux).
- [ ] Add `"web:dev": "cd web && npm run dev"` and `"web:build": "cd web && npm run build"` scripts to root `package.json`
- [ ] Verify full flow: `nectar serve` → open browser → create garden → edit DOT → run → observe SSE → answer human gate → check seedbed kanban
- [ ] Verify dark mode renders correctly in both themes
- [ ] Verify SSE reconnection: stop/start server → client reconnects → replays missed events
- [ ] Verify graph overlay correctly colors nodes (test with a pipeline that exercises all statuses)

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `web/package.json` | Create | Frontend manifest and dependencies |
| `web/vite.config.ts` | Create | Build config + dev proxy |
| `web/tailwind.config.ts` | Create | Watercolor palette tokens |
| `web/tsconfig.json` | Create | Strict TS for frontend |
| `web/index.html` | Create | SPA entry point |
| `web/src/main.tsx` | Create | React root + router setup |
| `web/src/App.tsx` | Create | Layout shell with sidebar/header |
| `web/src/theme/tokens.ts` | Create | Color palette, spacing, typography |
| `web/src/theme/watercolor.css` | Create | Accent backgrounds, border treatments |
| `web/src/theme/dark-mode.ts` | Create | Dark mode context + toggle |
| `web/src/api/client.ts` | Create | Typed fetch wrapper |
| `web/src/api/gardens.ts` | Create | Garden CRUD calls |
| `web/src/api/pipelines.ts` | Create | Pipeline lifecycle calls |
| `web/src/api/seeds.ts` | Create | Seed CRUD calls |
| `web/src/hooks/useSSE.ts` | Create | SSE subscription with reconnect + replay |
| `web/src/hooks/usePipeline.ts` | Create | Pipeline state from SSE events |
| `web/src/hooks/useGardens.ts` | Create | Garden list/CRUD hook |
| `web/src/hooks/useSeeds.ts` | Create | Seed list/CRUD with optimistic updates |
| `web/src/pages/Dashboard.tsx` | Create | Summary cards + activity feed |
| `web/src/pages/GardenList.tsx` | Create | Garden browser |
| `web/src/pages/GardenEditor.tsx` | Create | Dual-pane DOT editor |
| `web/src/pages/RunView.tsx` | Create | Pipeline execution view |
| `web/src/pages/RunHistory.tsx` | Create | Past runs list |
| `web/src/pages/Seedbed.tsx` | Create | Kanban board page |
| `web/src/components/layout/Shell.tsx` | Create | Layout wrapper |
| `web/src/components/layout/Sidebar.tsx` | Create | Navigation sidebar |
| `web/src/components/layout/Header.tsx` | Create | Top bar + dark mode toggle |
| `web/src/components/editor/DotEditor.tsx` | Create | CodeMirror DOT editor |
| `web/src/components/editor/GraphPreview.tsx` | Create | viz.js SVG renderer |
| `web/src/components/editor/EditorToolbar.tsx` | Create | Save/Validate/Run buttons |
| `web/src/components/execution/ExecutionView.tsx` | Create | Graph + event log composite |
| `web/src/components/execution/GraphOverlay.tsx` | Create | Node status CSS overlay |
| `web/src/components/execution/EventLog.tsx` | Create | Scrolling SSE event list |
| `web/src/components/execution/HumanGate.tsx` | Create | Question/answer panel |
| `web/src/components/kanban/KanbanBoard.tsx` | Create | 5-column kanban |
| `web/src/components/kanban/KanbanColumn.tsx` | Create | Droppable column |
| `web/src/components/kanban/SeedCard.tsx` | Create | Draggable seed card |
| `web/src/components/kanban/SeedDetail.tsx` | Create | Seed detail slide-out |
| `web/src/components/seeds/SeedForm.tsx` | Create | Seed create/edit form |
| `web/src/components/shared/Badge.tsx` | Create | Status/priority badges |
| `web/src/components/shared/Button.tsx` | Create | Themed button variants |
| `web/src/components/shared/Modal.tsx` | Create | Overlay modal |
| `web/src/components/shared/Spinner.tsx` | Create | Loading spinner |
| `web/src/types/garden.ts` | Create | Garden TS types |
| `web/src/types/pipeline.ts` | Create | Pipeline/run TS types |
| `web/src/types/seed.ts` | Create | Seed TS types |
| `web/src/types/events.ts` | Create | SSE event TS types |
| `src/server/server.ts` | Modify | Add static file serving for `web/dist/` |
| `src/cli/commands/serve.ts` | Modify | Add `--open` flag |
| `package.json` | Modify | Add `web:dev` and `web:build` scripts |

---

## Definition of Done

### Garden Editor
- [ ] `GET /gardens` populates the garden list page with all `.dot` files
- [ ] Opening a garden shows dual-pane editor: CodeMirror left, SVG preview right
- [ ] DOT syntax highlighting works (keywords, strings, comments, shapes)
- [ ] Editing DOT source updates SVG preview within 500ms
- [ ] Malformed DOT shows an error overlay in the preview pane (not a crash)
- [ ] Saving a garden via the editor persists changes to disk
- [ ] Creating a new garden creates the `.dot` file on disk
- [ ] Deleting a garden from the list removes the file

### Pipeline Execution
- [ ] Clicking "Run" starts a pipeline and navigates to the execution view
- [ ] SSE events appear in the event log in real-time during execution
- [ ] Node status overlays update on the SVG graph as nodes progress
- [ ] Running nodes show a pulse animation
- [ ] A `wait.human` node surfaces a question panel with choice buttons
- [ ] Answering a human gate question resumes pipeline execution
- [ ] Canceling a run shows interrupted state with a Resume button
- [ ] Resuming a run picks up from checkpoint; SSE replays missed events
- [ ] Page refresh during execution reconnects SSE and restores state

### Seedbed Kanban
- [ ] Kanban shows all seeds in 5 columns (seedling/sprouting/blooming/honey/wilted)
- [ ] Column headers use the correct semantic accent colors
- [ ] Dragging a seed card to a different column updates its status
- [ ] Failed drag-and-drop reverts with an error indicator
- [ ] Creating a seed from the form creates the directory structure on disk
- [ ] Quick-entry bar creates a seedling with minimal friction
- [ ] Clicking a seed card opens a detail panel with rendered markdown

### Design & UX
- [ ] Watercolor palette consistently applied across all pages
- [ ] Dark mode toggle works and persists across page reloads
- [ ] `Ctrl+S` saves in the editor; `Ctrl+Enter` runs the pipeline
- [ ] `Escape` closes modals and panels
- [ ] No layout/style regressions between light and dark modes

### Serving & Integration
- [ ] `cd web && npm install && npm run build` succeeds with zero errors
- [ ] `nectar serve` serves the built SPA at `http://localhost:4140/`
- [ ] `nectar serve --open` opens the browser automatically
- [ ] SPA routing works (direct navigation to `/gardens/my-pipeline` serves the app)
- [ ] API routes take precedence over SPA fallback

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Sprint 019 API has bugs or missing endpoints | Medium | High | Start Phase 2 early against Sprint 019's staged code. File backend fixes as blockers. API contract is well-defined — mismatches surface immediately. |
| `@viz-js/viz` WASM bundle is large (~5MB) | Medium | Low | Lazy-load WASM on first editor open. Acceptable for a local dev tool. Show spinner during init. |
| SVG node matching for status overlay is fragile | Medium | Medium | Graphviz outputs `<title>` elements with node IDs inside `<g>` groups. Match on `<title>` text, not generated `id` attributes. Test with varied graph shapes. |
| No off-the-shelf CodeMirror DOT grammar | High | Low | DOT grammar is simple. Write a ~50-line `StreamLanguage` mode covering `digraph`, `subgraph`, `->`, attribute blocks, strings, and comments. Fall back to plain text if this takes too long. |
| Kanban DnD race conditions on rapid drags | Low | Medium | Optimistic UI + sequential PATCH. If PATCH fails, revert and show toast. Debounce rapid drag events. |
| Watercolor aesthetic requires design iteration | Medium | Low | Start with flat palette + token system. Add texture progressively. Function over beauty for MVP — the palette and semantic colors carry the identity even without watercolor effects. |
| `web/dist/` not bundled into compiled binary | Medium | High | Ship `web/dist/` alongside the binary (same directory or a `lib/` subdirectory). Document the expected layout. Bun compile with `--asset-dir` if available, otherwise runtime file serving from disk. |
| Frontend scope is ambitious for one sprint | High | Medium | Cut line is explicit: Dashboard, RunHistory, and SeedDetail drop first. Core trio (editor + execution + kanban) is the minimum. Each phase is independently valuable — partial delivery is still a win. |

---

## Dependencies

| Package | Purpose | Install Location |
|---------|---------|-----------------|
| `react` + `react-dom` | UI framework | web/ |
| `react-router-dom` | Client-side routing | web/ |
| `vite` + `@vitejs/plugin-react` | Build + dev server | web/ (dev) |
| `tailwindcss` + `@tailwindcss/vite` | Styling | web/ (dev) |
| `@codemirror/view` + `@codemirror/state` + `@codemirror/language` | Code editor | web/ |
| `@viz-js/viz` | Client-side Graphviz WASM | web/ |
| `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` | Kanban drag-and-drop | web/ |
| `react-markdown` + `remark-gfm` | Markdown rendering | web/ |
| `lucide-react` | Icons | web/ |
| `typescript` | Language | web/ (dev) |

The frontend is entirely under `web/` with its own `package.json`. Zero new dependencies added to the root backend `package.json`.

**Sprint 019 dependency:** The entire frontend depends on Sprint 019's HTTP server being functional. Phases 1-2 can be developed with mock data or against the Vite dev proxy if Sprint 019 is still in progress, but Phases 3-5 require a working `nectar serve`.
