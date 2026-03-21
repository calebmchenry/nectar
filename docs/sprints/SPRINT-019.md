# Sprint 019: The Hive Runtime — HTTP Server, SSE, and Browser-Ready Human Gates

## Overview

**Goal:** Ship `nectar serve` — a local HTTP runtime exposing the full attractor pipeline API (10 endpoints + SSE), durable browser-driven human approvals, SVG graph rendering, workspace CRUD endpoints, and remaining spec compliance gaps. After this sprint, `docs/compliance-report.md` reads **zero required gaps** and the local backend contract from INTENT.md §4 is fulfilled.

**Why this sprint, why now:**

1. **GAP-1 (HTTP Server) is the largest remaining gap by an order of magnitude.** Nine REST endpoints plus SSE event streaming — more missing surface area than the other five gaps combined. The attractor spec is not "nearly done" while the entire server API is unimplemented.

2. **The Hive is structurally blocked.** INTENT.md §2C and §4 are explicit: the web UI runs against a local Nectar server on `localhost`. Without this runtime, the entire web frontend — pipeline editor, kanban board, swarm analysis — cannot begin. Every sprint that defers the server pushes 1/3 of Nectar's value proposition further out.

3. **The adjacent gaps belong here.** GAP-2 (ask_multiple/inform), GAP-3 (interview events), GAP-5 (context window warning), and GAP-6 (tool_command) are each 1–3 hours of work. They complete naturally alongside the server. Bundling them achieves full spec compliance without a dedicated "gap cleanup" sprint.

4. **The engine substrate is battle-tested.** 18 sprints built and hardened parsing, validation, execution, checkpointing, resume, 9 handler types, the agent loop, the LLM client, and the seedbed. The server is a thin orchestration layer over proven internals. This is the right time.

5. **Swarm Intelligence is additive; the server is structural.** CLI-only swarm adds value but leaves Nectar without the backend contract that both The Hive and future browser-triggered swarm require. The server must come first.

**Gaps closed:**

| Gap | Severity | Description |
|-----|----------|-------------|
| GAP-1 | **Critical** | HTTP Server Mode — 10 pipeline REST endpoints + SSE |
| GAP-2 | Medium | `Interviewer.ask_multiple()` and `Interviewer.inform()` |
| GAP-3 | Medium | `InterviewStarted`, `InterviewCompleted`, `InterviewTimeout` events |
| GAP-5 | Medium | Context window awareness signal (80% warning) |
| GAP-6 | Low | Tool handler `tool_command` attribute alignment |

**GAP-4 (Gemini extended tools) is explicitly optional in the spec and excluded.**

**In scope:**

- `nectar serve` CLI command
- All 10 attractor-spec pipeline endpoints (REST + SSE)
- INTENT.md §4 local runtime endpoints: garden CRUD, seed CRUD, attachment upload, workspace event streaming
- `PipelineService` — shared run/start/resume orchestration so CLI and HTTP use identical logic
- `RunManager` — in-process registry of active `PipelineEngine` instances
- `HttpInterviewer` — bridges HTTP question/answer to the engine's Interviewer interface
- Durable pending-question files under the run directory
- SSE replay via `Last-Event-ID` for reconnecting clients
- `Interviewer.ask_multiple()` and `Interviewer.inform()` on all interviewer implementations
- `InterviewStarted`, `InterviewCompleted`, `InterviewTimeout` event types + emission
- Context window tracking in `AgentSession` with 80% warning event
- Tool handler accepts `tool_command` (preferred) with `script` as deprecated fallback
- In-process DOT→SVG rendering (no system Graphviz dependency)

**Out of scope:**

- Web UI ("The Hive") — this sprint builds its backend, not its frontend
- Swarm Intelligence analysis
- Authentication/authorization (INTENT.md §7 explicitly defers this)
- WebSocket (SSE is sufficient; WebSocket is a future optimization)
- GAP-4 (Gemini optional extended tools)
- Execution state overlay on SVG (stretch goal only — plain SVG first)

**Cut line:** If time compresses, cut Milestone B work only: Garden/Seed CRUD, workspace SSE, attachment uploads, and GAP-5. Do **not** cut SSE replay, question durability, cancel/resume, or graph rendering. Those are the whole point of the sprint.

---

## Use Cases

1. **Start the local server.** `nectar serve` starts an HTTP server on `127.0.0.1:4140` (configurable via `--port`). Themed output confirms the server is running. The server loads the workspace from the current directory (or `--workspace`).

2. **Submit a pipeline via HTTP.** `POST /pipelines` with `{ dot_path: "gardens/my-flow.dot" }` or `{ dot_source: "digraph G { ... }" }`. Nectar validates, starts execution asynchronously, returns `202 Accepted` with `{ run_id, status: "running" }`. Raw DOT submissions are persisted as `input.dot` under the run directory.

3. **Stream execution events in real time.** Browser connects to `GET /pipelines/{id}/events`. SSE pushes every `RunEvent` — node starts, completions, retries, edge selections, parallel branches, interview lifecycle. Late-joining clients receive buffered history from `events.ndjson` via `Last-Event-ID`, then stream live.

4. **Browser-driven human approval.** Pipeline hits a `wait.human` node. `GET /pipelines/{id}/questions` returns a stable pending question with ID, choices, accelerators, default, and timeout. User clicks an option in the UI. `POST /pipelines/{id}/questions/{qid}/answer` resolves the HttpInterviewer's promise and execution resumes. Page refresh doesn't lose the question — it's persisted to disk.

5. **Cancel a runaway pipeline.** `POST /pipelines/{id}/cancel` triggers the engine's abort, writes an interrupted checkpoint with reason `api_cancel`, emits terminal events, and the SSE stream ends cleanly.

6. **Resume an interrupted run from the browser.** `POST /pipelines/{id}/resume` loads the cocoon, follows restart chains, and resumes from the last checkpoint — same semantics as `nectar resume`.

7. **Render the pipeline graph.** `GET /pipelines/{id}/graph` returns SVG generated in-process from the stored DOT source.

8. **Inspect pipeline state.** `GET /pipelines/{id}` returns status, current node, completed nodes, duration. `GET /pipelines/{id}/checkpoint` returns the full cocoon. `GET /pipelines/{id}/context` returns the context key-value store.

9. **Manage gardens via HTTP.** `GET /gardens` lists DOT files. `PUT /gardens/:name` creates/updates with validation. `DELETE /gardens/:name` removes.

10. **Manage seeds via HTTP.** `GET /seeds` lists all seeds with metadata. `POST /seeds` creates a new seed with proper directory structure. `PATCH /seeds/:id` updates metadata. `POST /seeds/:id/attachments` accepts file uploads.

11. **Watch workspace changes.** `GET /events` streams workspace-level filesystem change events (garden edits, new seeds) via SSE with 100ms debounce.

12. **Context window warning.** During an agent session, approximate token usage is tracked. When it exceeds 80% of the model's context window, a `context_window_warning` event is emitted once per session.

13. **Spec-correct tool nodes work without breaking existing gardens.** A tool node declared with `tool_command="npm test"` runs correctly. Existing gardens using `script="npm test"` also keep working, but validation warns that `script` is deprecated.

14. **Multiple runs are isolated.** Two browser tabs start different pipelines simultaneously. Each run gets its own engine, SSE fanout, event journal, checkpoint, and pending-question files under `.nectar/cocoons/<run-id>/`.

---

## Architecture

### Design Principles

1. **The server is an adapter, not a second runtime.** CLI and HTTP paths call the same `PipelineService` for run/start/resume. No duplicated lifecycle logic.

2. **Live state is in memory; authoritative state is on disk.** Active engines, abort handles, and SSE subscribers live in memory. Checkpoints, manifests, event journals, pending questions, and DOT inputs live under the run directory.

3. **Every SSE stream is replayable.** Events are journaled to `events.ndjson` with monotonic sequence numbers. Reconnecting clients resume from `Last-Event-ID`.

4. **Human questions are durable resources.** Pending approvals are persisted as question files under the run directory — addressable by stable ID, not ephemeral in-memory state.

5. **Server owns process signals.** `PipelineEngine` cannot install per-run SIGINT/SIGTERM handlers in server mode. The server owns shutdown and propagates aborts to active engines.

6. **Graph rendering is in-process.** No shelling out to `dot`. A JS/WASM renderer keeps the server self-contained.

7. **Backward compatibility is deliberate.** `tool_command` becomes canonical. `script` remains supported for one compatibility window, with a deprecation warning.

### Framework: None (node:http)

The server uses `node:http` directly with a thin custom router. No Express, Fastify, or Hono.

**Why:** The API surface is a fixed set of routes. A framework adds a dependency, its opinions about middleware ordering, and its bundling quirks for `bun build --compile` — all for routing we can write in ~100 lines. The project has intentionally maintained a minimal dependency posture through 18 sprints. JSON parsing, SSE streaming, and error handling are handled by focused utility functions.

**Fallback:** If multipart upload handling for seed attachments proves too complex with raw `node:http`, `busboy` (zero-dep, battle-tested) may be added as a targeted dependency.

### Module Layout

```
src/
├── runtime/
│   └── pipeline-service.ts          # Shared run/start/resume orchestration
├── server/
│   ├── server.ts                    # node:http bootstrap, lifecycle, graceful shutdown
│   ├── router.ts                    # Route matching, JSON helpers, SSE helpers
│   ├── types.ts                     # Request/response DTOs, error response format
│   ├── run-manager.ts               # Active-run registry, subscriber fanout
│   ├── event-journal.ts             # events.ndjson append + replay
│   ├── http-interviewer.ts          # Interviewer backed by QuestionStore
│   ├── question-store.ts            # Pending question persistence + answer resolution
│   ├── graph-renderer.ts            # DOT → SVG via @viz-js/viz
│   └── routes/
│       ├── pipelines.ts             # 10 pipeline endpoints + SSE
│       ├── gardens.ts               # Garden CRUD
│       ├── seeds.ts                 # Seed CRUD + attachment upload
│       └── events.ts                # Workspace-level SSE stream
├── cli/
│   └── commands/
│       └── serve.ts                 # nectar serve command
├── engine/
│   └── events.ts                    # + InterviewStarted/Completed/Timeout, ContextWindowWarning
├── interviewer/
│   └── types.ts                     # + ask_multiple(), inform()
└── agent-loop/
    └── session.ts                   # + context window tracking
```

### Key Abstractions

**`PipelineService`** — Extracted from the CLI `run` and `resume` commands. Encapsulates: load graph from `dot_path` or `dot_source`, create or restore `RunStore`, start `PipelineEngine`, follow restart chains, resume from checkpoint. Both CLI commands and HTTP routes call this service. Single source of truth for run lifecycle.

**`RunManager`** — Owns active pipeline executions. Maps run IDs to `{ engine, eventJournal, pendingQuestions, sseSubscribers, status }`. Handles concurrent runs (configurable limit, default 4). Cleans up completed runs after TTL (default 1 hour). Server-level graceful shutdown aborts all active engines and flushes journals.

**`EventJournal`** — Append-only `events.ndjson` under the run directory. Each line is an envelope: `{ seq, timestamp, event }`. SSE uses `seq` as the event ID for reconnect semantics. Replay reads from disk using streaming I/O (`fs.createReadStream` + readline), not bulk memory load, to handle large journals safely. Live events are appended and fanned out to subscribers simultaneously.

**`HttpInterviewer`** — Implements `Interviewer`. On `ask()`: writes a question file to `<run-dir>/questions/<qid>.json` with status `pending`, emits `interview_started`, returns a Promise. On answer submission: validates question is still pending (rejects if already answered or timed out), updates the file to `answered`, resolves the promise, emits `interview_completed`. On timeout: updates to `timed_out`, emits `interview_timeout`. Questions survive server restart because they're on disk.

**`QuestionStore`** — Manages question files. Persists to `<run-dir>/questions/`. Lists pending questions from disk (not only memory) so page refresh works. Handles concurrent questions from parallel execution branches.

**`GraphRenderer`** — Converts stored DOT source into SVG using `@viz-js/viz` (WASM Graphviz). Read-only — does not accept arbitrary caller-supplied DOT. Execution state coloring is a stretch goal.

### HTTP API Contract

Server binds to `127.0.0.1` by default. `--host 0.0.0.0` allowed but requires explicit opt-in (no auth layer). Default port is `4140`. Port conflicts produce a clear, actionable error message.

**Error response format** (consistent across all endpoints):

```json
{ "error": "Human-readable message", "code": "VALIDATION_ERROR", "details": {} }
```

#### Pipeline Endpoints

| Method | Route | Status | Behavior |
|--------|-------|--------|----------|
| `POST` | `/pipelines` | 202 | Start pipeline from `dot_path` or `dot_source` |
| `GET` | `/pipelines/{id}` | 200 | Run status with current node, completed nodes, duration |
| `GET` | `/pipelines/{id}/events` | 200 | SSE replay + live stream |
| `POST` | `/pipelines/{id}/cancel` | 200 | Abort active run, checkpoint with `api_cancel`, return final status |
| `POST` | `/pipelines/{id}/resume` | 202 | Resume interrupted run from checkpoint |
| `GET` | `/pipelines/{id}/graph` | 200 | SVG for the run's DOT source |
| `GET` | `/pipelines/{id}/questions` | 200 | Pending human gate questions |
| `POST` | `/pipelines/{id}/questions/{qid}/answer` | 200 | Submit answer, resume pipeline |
| `GET` | `/pipelines/{id}/checkpoint` | 200 | Cocoon JSON |
| `GET` | `/pipelines/{id}/context` | 200 | Context key-value snapshot |

`POST /pipelines` request body:

```json
{
  "dot_path": "gardens/compliance-loop.dot",
  "dot_source": "digraph G { ... }",
  "workspace_root": "/abs/path/to/workspace",
  "auto_approve": false
}
```

Rules:
- Exactly one of `dot_path` or `dot_source` is required.
- `dot_path` must resolve under the workspace root (path traversal guard).
- `dot_source` runs are persisted as `input.dot` under the run directory.
- Server returns `202 Accepted` because execution begins asynchronously.

#### Workspace Endpoints (INTENT.md §4)

| Method | Route | Behavior |
|--------|-------|----------|
| `GET` | `/gardens` | List DOT files with metadata |
| `GET` | `/gardens/:name` | DOT content + parsed metadata |
| `PUT` | `/gardens/:name` | Create/update with validation |
| `DELETE` | `/gardens/:name` | Remove DOT file |
| `GET` | `/seeds` | List seeds with meta.yaml contents |
| `GET` | `/seeds/:id` | Seed content, metadata, attachments, analyses |
| `POST` | `/seeds` | Create new seed with directory structure |
| `PATCH` | `/seeds/:id` | Update metadata fields |
| `POST` | `/seeds/:id/attachments` | Multipart file upload |
| `GET` | `/seeds/:id/attachments/:filename` | Serve attachment |
| `GET` | `/events` | Workspace-level SSE (filesystem changes) |

### SSE Protocol

```
id: 42
event: node_completed
data: {"seq":42,"timestamp":"2026-03-20T14:03:11.000Z","event":{"type":"node_completed","run_id":"abc","node_id":"plan","outcome":{"status":"success"}}}

```

- `id` = monotonic sequence number from event journal
- `event` = `RunEvent.type`
- `data` = full JSON envelope
- Keepalive comment every 15 seconds
- `Last-Event-ID` header honored for replay
- Invalid or unknown `Last-Event-ID` values replay from the beginning

### Run Directory Layout

```
.nectar/cocoons/<run-id>/
├── manifest.json
├── checkpoint.json
├── input.dot              # only for dot_source submissions
├── events.ndjson          # append-only event journal
├── questions/
│   ├── <question-id>.json
│   └── ...
├── control/
├── artifacts/
└── <node-id>/
    ├── status.json
    ├── prompt.md
    └── response.md
```

### Human Interaction Model

`Interviewer` interface becomes:

```ts
interface Interviewer {
  ask(question: Question): Promise<Answer>;
  ask_multiple(questions: Question[]): Promise<Answer[]>;
  inform(message: string, stage: string): Promise<void> | void;
}
```

`Question` gains a stable `id` so HTTP resources can address it directly.

`ask_multiple()` default implementation: sequential `ask()` calls. `HttpInterviewer`: registers all questions at once, resolves answers in input order.

`inform(message, stage)` is used for one-way notices. Console prints; HTTP emits a non-blocking informational SSE event.

### Tool Node Attribute Normalization

- `tool_command` is the spec-correct attribute
- `script` is accepted as a deprecated alias
- If both exist, `tool_command` wins
- Validation accepts either, warns when only `script` is used, errors when neither is present

---

## Implementation

### Milestone A: Core Server (Phases 1–3)

This is the minimum viable server. If the sprint runs long, Milestone A alone is a shippable, valuable increment.

### Phase 1: Shared Runtime Service & Server Skeleton (~15%)

**Files:** `src/runtime/pipeline-service.ts` (create), `src/server/server.ts` (create), `src/server/router.ts` (create), `src/server/types.ts` (create), `src/cli/commands/serve.ts` (create), `src/cli/index.ts` (modify), `src/cli/commands/run.ts` (modify), `src/cli/commands/resume.ts` (modify)

**Tasks:**
- [ ] Extract run/start/resume orchestration from CLI commands into `PipelineService`
- [ ] Update CLI `run` and `resume` to delegate to the shared service
- [ ] Build HTTP server on `node:http` with explicit route table in `router.ts`
- [ ] Add JSON body parsing, CORS for `localhost:*`, structured error responses
- [ ] Create `nectar serve [--port 4140] [--host 127.0.0.1] [--workspace .]`
- [ ] Wire `serve` into CLI index
- [ ] Graceful shutdown: stop accepting requests → abort active runs → flush journals → close listeners
- [ ] Print themed banner on startup
- [ ] Port conflict detection with clear error message
- [ ] Verify CLI `run` and `resume` still work after the refactor

### Phase 2: RunManager, Pipeline Endpoints & SSE (~30%)

**Files:** `src/server/run-manager.ts` (create), `src/server/event-journal.ts` (create), `src/server/routes/pipelines.ts` (create), `src/engine/engine.ts` (modify)

**Tasks:**
- [ ] Create `RunManager`: `create(dotSource|dotPath, options)`, `get(id)`, `list()`, `cancel(id)`, `resume(id)`. Stores engines, event journals, pending questions, SSE subscribers. Enforces max concurrent runs (default 4). TTL cleanup for completed runs (default 1 hour).
- [ ] Create `EventJournal`: append-only `events.ndjson` with monotonic `seq`. Write events on emit; replay from disk via streaming I/O on SSE connect.
- [ ] Add `PipelineEngine` option to disable process-level signal handler registration in server mode
- [ ] Add public `engine.abort(reason)` API for server-driven cancellation
- [ ] Implement all 10 pipeline endpoints:
  - [ ] `POST /pipelines` — validate, guard against path traversal for `dot_path`, start async, return 202 with run_id
  - [ ] `GET /pipelines/{id}` — merged manifest/checkpoint/live status
  - [ ] `GET /pipelines/{id}/events` — SSE replay + live stream with `Last-Event-ID`
  - [ ] `POST /pipelines/{id}/cancel` — abort, checkpoint with `api_cancel`, return final status
  - [ ] `POST /pipelines/{id}/resume` — load cocoon, follow restart chains, resume
  - [ ] `GET /pipelines/{id}/graph` — SVG (placeholder, wired in Phase 4)
  - [ ] `GET /pipelines/{id}/questions` — pending questions (wired in Phase 3)
  - [ ] `POST /pipelines/{id}/questions/{qid}/answer` — answer submission (wired in Phase 3)
  - [ ] `GET /pipelines/{id}/checkpoint` — raw cocoon JSON
  - [ ] `GET /pipelines/{id}/context` — context key-value store
- [ ] SSE keepalive comments every 15s, clean up on client disconnect
- [ ] Error handler: 400 validation, 404 not found, 409 conflict, 500 internal — all using consistent error response format
- [ ] On server startup, scan `.nectar/cocoons/` for runs with status `running` in manifest but no active process; mark as `interrupted`

### Phase 3: Durable Human Questions & Interview Lifecycle Events (~20%)

**Files:** `src/server/http-interviewer.ts` (create), `src/server/question-store.ts` (create), `src/interviewer/types.ts` (modify), `src/interviewer/auto-approve.ts` (modify), `src/interviewer/console.ts` (modify), `src/interviewer/callback.ts` (modify), `src/interviewer/queue.ts` (modify), `src/interviewer/recording.ts` (modify), `src/handlers/wait-human.ts` (modify), `src/engine/events.ts` (modify), `src/cli/ui/renderer.ts` (modify)

**Tasks:**

**GAP-2: Interviewer.ask_multiple() and Interviewer.inform()**
- [ ] Add `ask_multiple(questions: Question[]): Promise<Answer[]>` to `Interviewer` interface. Default: sequential `ask()` calls. `HttpInterviewer`: registers all at once.
- [ ] Add `inform(message: string, stage: string): void` to `Interviewer` interface. Default: no-op. `ConsoleInterviewer`: prints. `HttpInterviewer`: emits SSE event.
- [ ] Update all interviewer implementations

**GAP-3: Human Interaction Events**
- [ ] Add `InterviewStartedEvent { type: 'interview_started', run_id, node_id, question_id, question_text, stage }`
- [ ] Add `InterviewCompletedEvent { type: 'interview_completed', run_id, node_id, question_id, answer, duration_ms }`
- [ ] Add `InterviewTimeoutEvent { type: 'interview_timeout', run_id, node_id, question_id, stage, duration_ms }`
- [ ] Emit from wait-human handler at appropriate lifecycle points
- [ ] Add to `RunEvent` union type and CLI renderer

**HttpInterviewer & QuestionStore**
- [ ] Extend `Question` with a stable `id` field
- [ ] Build `QuestionStore`: persist question files under `<run-dir>/questions/`, list from disk (not memory), resolve answers, reject answers for already-resolved or timed-out questions
- [ ] Build `HttpInterviewer`: `ask()` writes pending question → emits `interview_started` → awaits resolution. Answer submission validates status → updates file → emits `interview_completed`. Timeout updates file → emits `interview_timeout`.
- [ ] Wire into `GET /pipelines/{id}/questions` and `POST /pipelines/{id}/questions/{qid}/answer`

### Milestone B: Workspace & Polish (Phases 4–5)

These phases complete the full INTENT.md §4 contract. Can be deferred if Milestone A runs long.

### Phase 4: Graph Rendering, Garden/Seed CRUD & Workspace Events (~20%)

**Files:** `src/server/graph-renderer.ts` (create), `src/server/routes/gardens.ts` (create), `src/server/routes/seeds.ts` (create), `src/server/routes/events.ts` (create), `package.json` (modify)

**Tasks:**
- [ ] Add `@viz-js/viz` dependency for in-process SVG rendering
- [ ] Smoke-test `@viz-js/viz` with `bun build --compile` early as a go/no-go gate
- [ ] Implement `GraphRenderer`: DOT source → SVG (plain rendering; execution state coloring is stretch)
- [ ] Wire `GET /pipelines/{id}/graph` to render stored DOT
- [ ] Garden endpoints:
  - [ ] `GET /gardens` — list .dot files with metadata (name, size, modified_at, node count)
  - [ ] `GET /gardens/:name` — DOT content + parsed metadata
  - [ ] `PUT /gardens/:name` — validate then write
  - [ ] `DELETE /gardens/:name` — remove file (reject if active pipeline run references it)
- [ ] Seed endpoints:
  - [ ] `GET /seeds` — list seeds with meta.yaml
  - [ ] `GET /seeds/:id` — full seed: content, metadata, attachment list, analyses
  - [ ] `POST /seeds` — create with auto-assigned ID and proper directory structure
  - [ ] `PATCH /seeds/:id` — update metadata fields
  - [ ] `POST /seeds/:id/attachments` — multipart upload to `attachments/`
  - [ ] `GET /seeds/:id/attachments/:filename` — serve file
- [ ] Workspace SSE (`GET /events`): `fs.watch` on `gardens/` and `seedbed/` with 100ms debounce. Events: `garden_changed`, `seed_created`, `seed_updated`, `seed_deleted`. Exclude `.nectar/` directory changes.

### Phase 5: Remaining Spec Gaps & Integration Tests (~15%)

**Files:** `src/handlers/tool.ts` (modify), `src/garden/validate.ts` (modify), `src/garden/parse.ts` (modify), `src/agent-loop/session.ts` (modify), `src/engine/events.ts` (modify), `test/server/*.test.ts` (create), `test/integration/http-*.test.ts` (create)

**Tasks:**

**GAP-5: Context Window Awareness**
- [ ] In `AgentSession`, after each LLM response, compute approximate token usage: `totalChars / 4` across all history messages
- [ ] Look up `context_window` from model catalog for the active model
- [ ] When usage exceeds 80%, emit `ContextWindowWarningEvent { type: 'context_window_warning', session_id, usage_pct, estimated_tokens, context_window }`
- [ ] Emit at most once per session

**GAP-6: tool_command Attribute**
- [ ] In `src/handlers/tool.ts`, read `tool_command` first, fall back to `script`
- [ ] In `src/garden/validate.ts`, accept both; warn if only `script` is present; error if neither
- [ ] In `src/garden/parse.ts`, normalize `tool_command` onto the node

**Integration Tests:**
- [ ] Pipeline lifecycle: POST → GET status → stream events → verify completion
- [ ] Human gate flow: POST pipeline with wait.human → GET questions → POST answer → verify resume
- [ ] Stale answer rejection: POST answer to already-answered or timed-out question → 409 Conflict
- [ ] Cancel flow: POST → cancel → verify checkpoint with `api_cancel` reason
- [ ] Resume flow: cancel → resume via HTTP → verify completion
- [ ] SSE replay: connect late → verify buffered history via `Last-Event-ID`
- [ ] SSE with invalid `Last-Event-ID` → replay from beginning
- [ ] Graph rendering: GET graph → verify valid SVG
- [ ] Garden CRUD: list → create → read → update → delete
- [ ] Seed CRUD: create → list → read → update status → upload attachment
- [ ] Workspace events: connect SSE → create garden file → verify event
- [ ] ask_multiple with QueueInterviewer
- [ ] Context window warning at 80%
- [ ] tool_command preferred over script
- [ ] CLI run and resume still work after refactor
- [ ] Path traversal guard on `dot_path`
- [ ] Concurrent pipeline runs (verify isolation)
- [ ] Orphaned run detection on server startup

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/runtime/pipeline-service.ts` | Create | Shared run/start/resume orchestration for CLI and HTTP |
| `src/server/server.ts` | Create | node:http bootstrap, lifecycle, graceful shutdown |
| `src/server/router.ts` | Create | Route matching, JSON helpers, SSE streaming helpers |
| `src/server/types.ts` | Create | Request/response DTOs, error response format |
| `src/server/run-manager.ts` | Create | Active-run registry, subscriber fanout, concurrent run limits, TTL cleanup |
| `src/server/event-journal.ts` | Create | events.ndjson append and streaming replay |
| `src/server/http-interviewer.ts` | Create | Browser-facing Interviewer implementation |
| `src/server/question-store.ts` | Create | Pending question persistence and answer resolution |
| `src/server/graph-renderer.ts` | Create | DOT → SVG via @viz-js/viz |
| `src/server/routes/pipelines.ts` | Create | 10 pipeline endpoint handlers |
| `src/server/routes/gardens.ts` | Create | Garden CRUD endpoints |
| `src/server/routes/seeds.ts` | Create | Seed CRUD + attachment upload endpoints |
| `src/server/routes/events.ts` | Create | Workspace-level SSE stream |
| `src/cli/commands/serve.ts` | Create | `nectar serve` CLI command |
| `src/cli/index.ts` | Modify | Register `serve` command |
| `src/cli/commands/run.ts` | Modify | Delegate to shared PipelineService |
| `src/cli/commands/resume.ts` | Modify | Delegate to shared PipelineService |
| `src/engine/engine.ts` | Modify | Public abort API, optional signal handler disable |
| `src/engine/events.ts` | Modify | Add Interview* events, ContextWindowWarning |
| `src/cli/ui/renderer.ts` | Modify | Render new event types |
| `src/interviewer/types.ts` | Modify | Add Question.id, ask_multiple(), inform() |
| `src/interviewer/auto-approve.ts` | Modify | Implement ask_multiple/inform |
| `src/interviewer/console.ts` | Modify | Implement ask_multiple/inform |
| `src/interviewer/callback.ts` | Modify | Implement ask_multiple/inform |
| `src/interviewer/queue.ts` | Modify | Implement ask_multiple/inform |
| `src/interviewer/recording.ts` | Modify | Implement ask_multiple/inform |
| `src/handlers/wait-human.ts` | Modify | Stable question IDs, interview lifecycle events |
| `src/handlers/tool.ts` | Modify | Prefer tool_command, fall back to script |
| `src/garden/types.ts` | Modify | tool_command field |
| `src/garden/parse.ts` | Modify | Parse tool_command, preserve script alias |
| `src/garden/validate.ts` | Modify | Accept both attributes, warn on script-only |
| `src/agent-loop/session.ts` | Modify | Context window usage tracking + warning |
| `package.json` | Modify | Add @viz-js/viz |
| `test/server/*.test.ts` | Create | Server unit tests |
| `test/integration/http-*.test.ts` | Create | End-to-end HTTP integration tests |
| `test/interviewer/*.test.ts` | Create | Cross-implementation ask_multiple/inform tests |

---

## Definition of Done

**Core Server (Milestone A):**
- [ ] `nectar serve` starts a local HTTP server on `127.0.0.1:4140` and prints a themed banner
- [ ] Port conflict produces a clear error message, not a crash
- [ ] `POST /pipelines` accepts `dot_path` or `dot_source`, starts execution, returns 202 with `run_id`
- [ ] `POST /pipelines` with `dot_path` rejects paths outside the workspace (path traversal guard)
- [ ] Raw DOT submissions are persisted as `input.dot` under the run directory
- [ ] `GET /pipelines/{id}` returns run status with current node, completed nodes, duration
- [ ] `GET /pipelines/{id}/events` streams valid SSE, replays buffered history, and streams live events
- [ ] SSE reconnect via `Last-Event-ID` does not duplicate or drop events
- [ ] `POST /pipelines/{id}/cancel` aborts active run and writes checkpoint with reason `api_cancel`
- [ ] `POST /pipelines/{id}/resume` resumes an interrupted run using shared PipelineService semantics
- [ ] `GET /pipelines/{id}/checkpoint` returns cocoon JSON
- [ ] `GET /pipelines/{id}/context` returns context key-value store
- [ ] `GET /pipelines/{id}/graph` returns valid SVG
- [ ] `GET /pipelines/{id}/questions` returns stable pending question resources with `question_id`
- [ ] `POST /pipelines/{id}/questions/{qid}/answer` unblocks a waiting `wait.human` node
- [ ] Answering an already-resolved or timed-out question returns 409 Conflict
- [ ] Pending questions survive page refresh (persisted to disk, listed from disk)
- [ ] `Interviewer.ask_multiple()` works on all interviewer implementations
- [ ] `Interviewer.inform()` works on all interviewer implementations
- [ ] `InterviewStarted`, `InterviewCompleted`, `InterviewTimeout` events are emitted by wait-human handler
- [ ] `PipelineEngine` can run under server mode without installing per-run process signal handlers
- [ ] Server handles concurrent pipeline runs (up to 4 simultaneous)
- [ ] Completed runs are cleaned up from memory after TTL (default 1 hour)
- [ ] SSE connections clean up on client disconnect (no resource leaks)
- [ ] Server graceful shutdown aborts active runs and flushes journals
- [ ] On startup, server marks orphaned in-flight runs as `interrupted`
- [ ] Error responses use consistent format across all endpoints
- [ ] CLI `run` and `resume` still work correctly after the PipelineService refactor

**Workspace & Polish (Milestone B):**
- [ ] `GET /gardens` lists DOT files; `PUT /gardens/:name` creates/updates with validation
- [ ] `GET /seeds` lists seeds; `POST /seeds` creates a seed with proper directory structure
- [ ] `POST /seeds/:id/attachments` accepts file uploads
- [ ] `GET /events` streams workspace-level filesystem change events via SSE
- [ ] `AgentSession` emits `context_window_warning` when token usage exceeds 80% of model context window (once per session)
- [ ] Tool handler reads `tool_command` first, falls back to `script`
- [ ] Validation warns on `script`-only tool nodes, errors when neither attribute is present
- [ ] `npm run build` succeeds with zero type errors
- [ ] `npm test` passes with all new unit and integration tests
- [ ] `docs/compliance-report.md` can be updated to remove GAP-1, GAP-2, GAP-3, GAP-5, and GAP-6

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Sprint is too large for a single iteration | High | High | Milestone A/B split provides a natural cut point. Milestone A alone is shippable. |
| Multiple in-process engines conflict over SIGINT/SIGTERM | High | High | Add explicit server mode on `PipelineEngine` that disables internal signal registration. Server owns shutdown. |
| PipelineService refactor breaks CLI behavior | Medium | High | Extract shared orchestration first, port CLI, keep integration tests green throughout. Only then add HTTP routes. |
| SSE replay produces duplicate or out-of-order events | Medium | High | Journal every event with a monotonic seq. Honor `Last-Event-ID`. Dedicated reconnect integration tests. |
| Browser approval state lost on page refresh | Medium | High | Persist every pending question as a file under the run directory. List from disk, not memory. |
| `@viz-js/viz` doesn't bundle with `bun build --compile` | Medium | High | WASM is static data. Smoke-test bundling in Phase 4 as go/no-go gate. Fall back to text layout if rendering fails. |
| Path traversal on `dot_path` escapes workspace | Medium | High | Validate resolved path is under workspace root before proceeding. |
| Binding server to non-local interface without auth | Medium | High | Default `127.0.0.1`. Require explicit `--host` flag. Print warning. |
| `node:http` is too low-level for multipart uploads | Medium | Medium | Multipart parsing is ~50 lines for the boundary/header/body protocol. Fall back to `busboy` if complexity grows. |
| NDJSON journal grows large for long-running pipelines | Medium | Medium | Use streaming I/O for replay. Log a warning at 50MB. Document rotation as a future sprint item. |
| Server crash leaves orphaned runs | Medium | Medium | On startup, scan cocoons for `running` status with no active process; mark as `interrupted`. |
| Race condition: two clients answer same question | Low | Medium | QuestionStore validates status before accepting answer. First write wins; second gets 409. |
| Concurrent garden/seed writes from multiple clients | Low | Medium | Last-write-wins for this sprint. File locking or ETags are a future enhancement. |
| `tool_command` rename breaks existing DOT files | Low | Medium | Accept both attributes. `script` works as deprecated fallback. Warn, don't error. |
| Port 4140 conflicts with another local service | Low | Low | Clear error message on EADDRINUSE. `--port` flag for override. |
| Large concurrent run count exhausts memory | Low | Medium | Default max 4 concurrent runs. TTL cleanup. Configurable limits. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| `@viz-js/viz` | In-process DOT → SVG rendering (WASM Graphviz, no system dependency) |

**No framework. No database. No WebSocket library.** One new dependency.

Existing infrastructure leveraged:
- `src/engine/engine.ts` — `PipelineEngine`
- `src/checkpoint/` — cocoon read/write
- `src/garden/parse.ts` + `validate.ts` — pipeline validation
- `src/seedbed/` — seed creation, listing, metadata
- `src/interviewer/` — existing implementations
- `src/handlers/wait-human.ts` — human gate flow
- `src/agent-loop/session.ts` — agent session with model catalog access
- `src/llm/catalog.ts` — model context window sizes
- Node built-ins: `http`, `fs`, `stream`, `events`, `crypto`
