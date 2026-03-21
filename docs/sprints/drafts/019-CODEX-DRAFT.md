# Sprint NEXT: The Hive Runtime — HTTP Server, SSE, and Human Gates

## Overview

**Goal:** Deliver `nectar serve`, a local HTTP runtime that exposes the full attractor pipeline API, durable SSE event streams, browser-driven human approvals, and SVG graph rendering. After this sprint, Nectar is no longer CLI-only: a browser or local client can submit a pipeline, watch it run live, answer `wait.human` gates, inspect checkpoint/context state, cancel or resume a run, and fetch the rendered graph from `localhost`.

**Why this sprint, why now:**

- **The largest remaining compliance gap is still HTTP server mode.** `docs/compliance-report.md` calls it out explicitly, and nothing else blocks as much downstream work.
- **INTENT.md makes the local server non-optional.** The Hive must run against a local Nectar server on `localhost`; without that runtime, there is no credible path to the web UI.
- **The engine substrate already exists.** Parsing, validation, execution, checkpointing, resume, event emission, seedbed storage, and release/install are already in place. The bottleneck is no longer execution semantics; it is the absence of a local API surface.
- **The adjacent human-interaction gaps belong in the same sprint.** `Interviewer.ask_multiple()`, `Interviewer.inform()`, and interview lifecycle events are exactly what make browser-driven approvals possible.
- **The old “next sprint must prioritize parallel execution” note in INTENT.md is obsolete.** Parallel/fan-in already exist per the 2026-03-20 compliance report. The real blocker now is the missing runtime layer.

**Opinionated sequencing call:** Do **not** spend the next sprint on Swarm Intelligence or the web UI itself. A CLI-only swarm feature adds value, but it still leaves Nectar without the local backend contract that both The Hive and future browser-triggered swarm analysis require. The right next move is to make Nectar scriptable and browser-addressable.

**Gaps closed in this sprint:**

| Gap | Description |
|-----|-------------|
| GAP-1 | HTTP Server Mode |
| GAP-2 | `Interviewer.ask_multiple()` and `Interviewer.inform()` |
| GAP-3 | Human interaction events (`interview_started`, `interview_completed`, `interview_timeout`) |
| GAP-6 | Support spec-correct `tool_command` on tool nodes, while preserving `script` as a compatibility alias |

**In scope:**

- `nectar serve` CLI command
- Full attractor pipeline HTTP API on `localhost`
- SSE event streaming with replay for reconnecting clients
- Durable pending-question resources for `wait.human` nodes
- HTTP answer submission for human gates
- SVG render endpoint for pipeline graphs
- HTTP resume endpoint to honor INTENT.md’s “resumable by default” requirement
- `Interviewer.ask_multiple()` and `Interviewer.inform()` across all implementations
- Interview lifecycle events wired into engine execution
- `tool_command` parsing/validation/runtime support

**Out of scope:**

- The web UI itself
- Garden CRUD APIs
- Seed CRUD APIs
- Attachment upload APIs
- Swarm analysis endpoints
- Workspace file-watch streaming
- WebSocket support
- GAP-4 (Gemini optional extended tools)
- GAP-5 (context-window warning signal)

**Cut line:** If time compresses, cut convenience work only: `GET /healthz`, CLI polish around `nectar serve`, and legacy `human_question`/`human_answer` compatibility events. Do **not** cut SSE replay, question durability, cancel/resume, or graph rendering. Those are the whole point of the sprint.

---

## Use Cases

1. **Browser submits a pipeline and gets a live run.** The UI sends `POST /pipelines` with raw DOT source. Nectar writes the submitted DOT to the run directory as `input.dot`, validates it, starts a real `PipelineEngine`, and returns `{ run_id, status }`.

2. **User refreshes the run page and reconnects without losing context.** The browser reconnects to `GET /pipelines/{id}/events` with `Last-Event-ID`. Nectar replays missed events from `events.ndjson`, then continues streaming live events over SSE.

3. **A `wait.human` node pauses execution for a browser answer.** The run reaches a hexagon node. `GET /pipelines/{id}/questions` returns a stable pending question with `question_id`, labels, accelerators, default choice, and timeout. The user clicks an option; `POST /pipelines/{id}/questions/{qid}/answer` resolves the pending interviewer promise and the run continues.

4. **A user cancels a stuck run from the browser.** `POST /pipelines/{id}/cancel` aborts the live engine, writes an interrupted checkpoint with reason `api_cancel`, emits terminal events, and the SSE stream ends cleanly.

5. **A user resumes an interrupted run from the browser.** `POST /pipelines/{id}/resume` loads the existing cocoon, follows restart lineage if needed, and resumes from the last safe checkpoint using the same execution semantics as `nectar resume`.

6. **The UI renders the current graph without shelling out to the CLI.** `GET /pipelines/{id}/graph` returns SVG generated in-process from the stored DOT source. The browser can display the diagram and highlight nodes based on the SSE event stream.

7. **Spec-correct tool nodes work without breaking existing gardens.** A tool node declared with `tool_command="npm test"` runs correctly. Existing gardens that still use `script="npm test"` also keep working, but validation warns that `script` is deprecated in favor of `tool_command`.

8. **Multiple runs are isolated.** Two browser tabs start different pipelines at the same time. Each run gets its own engine, SSE fanout, event journal, checkpoint, and pending-question files under `.nectar/cocoons/<run-id>/`.

---

## Architecture

### Design Principles

1. **The server is an adapter over existing runtime logic, not a second runtime.** CLI and HTTP paths must call the same run/start/resume code.

2. **Live state is in memory; authoritative state is on disk.** Active runs, abort handles, and SSE subscribers live in memory. Checkpoints, manifests, DOT inputs, event journals, and pending questions live under the run directory.

3. **Every SSE stream is replayable.** Reconnect is normal, not exceptional. Event history is written to `events.ndjson` with monotonically increasing sequence numbers; SSE clients can resume from `Last-Event-ID`.

4. **Human questions are durable resources.** Pending approvals are not ephemeral console prompts. They are addressable question documents with stable IDs, status, timestamps, and answers.

5. **Server mode owns process signals.** `PipelineEngine` cannot install process-level SIGINT/SIGTERM handlers when running inside a multi-run HTTP server. The server owns shutdown and propagates aborts to active engines explicitly.

6. **Graph rendering stays in-process.** Do not shell out to `dot`. Use a JS/WASM renderer so the HTTP server remains a self-contained local runtime.

7. **Backward compatibility is deliberate.** `tool_command` becomes the canonical attribute. `script` remains supported for one compatibility window, but it is no longer the preferred contract.

### Runtime Layout

When a run is created from raw DOT source, its run directory becomes self-describing:

```text
.nectar/cocoons/<run-id>/
├── manifest.json
├── checkpoint.json
├── input.dot
├── events.ndjson
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

`events.ndjson` is append-only. Each line is an envelope:

```json
{
  "seq": 42,
  "timestamp": "2026-03-20T14:03:11.000Z",
  "event": {
    "type": "node_completed",
    "run_id": "..."
  }
}
```

SSE uses:

- `id: <seq>`
- `event: <event.type>`
- `data: <json envelope>`

That gives reconnect semantics without inventing a second event model.

### Shared Runtime Service

Create a shared runtime orchestration layer so the CLI and server stop duplicating run lifecycle logic:

```text
src/runtime/
  pipeline-service.ts
```

`PipelineService` is responsible for:

- loading and validating a graph from `dot_path` or `dot_source`
- creating or restoring the `RunStore`
- starting a `PipelineEngine`
- following restart chains consistently
- resuming interrupted runs from checkpoints
- exposing a public `abort(run_id, reason)` path

The CLI `run` and `resume` commands should call this service after the refactor. The server should call the same service through `RunManager`.

### Server Modules

```text
src/server/
  server.ts            # node:http bootstrap, lifecycle, graceful shutdown
  router.ts            # route matching, JSON helpers, SSE helpers
  types.ts             # request/response DTOs
  run-manager.ts       # active-run registry, start/cancel/resume, subscriber fanout
  event-journal.ts     # events.ndjson append + replay
  http-interviewer.ts  # Interviewer implementation backed by QuestionStore
  question-store.ts    # pending question persistence and answer resolution
  graph-renderer.ts    # DOT -> SVG
```

### HTTP API Contract

The server binds to `127.0.0.1` by default. `--host 0.0.0.0` is allowed, but only behind an explicit flag because there is no auth layer.

#### Pipeline endpoints

| Method | Route | Behavior |
|--------|-------|----------|
| `POST` | `/pipelines` | Start a pipeline from `dot_path` or `dot_source` |
| `GET` | `/pipelines/{id}` | Return merged manifest/checkpoint/live-run status |
| `GET` | `/pipelines/{id}/events` | SSE replay + live stream |
| `POST` | `/pipelines/{id}/cancel` | Abort an active run |
| `POST` | `/pipelines/{id}/resume` | Resume an interrupted run from checkpoint |
| `GET` | `/pipelines/{id}/graph` | Return SVG for the run’s DOT source |
| `GET` | `/pipelines/{id}/questions` | List pending human questions |
| `POST` | `/pipelines/{id}/questions/{qid}/answer` | Submit a human answer |
| `GET` | `/pipelines/{id}/checkpoint` | Return current checkpoint JSON |
| `GET` | `/pipelines/{id}/context` | Return current context snapshot |

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
- `dot_path` must resolve under the workspace root.
- `dot_source` runs are persisted as `input.dot` under the run directory.
- Server returns `202 Accepted`, not `200`, because execution begins asynchronously.

### Human Interaction Model

`Interviewer` becomes:

```ts
interface Interviewer {
  ask(question: Question): Promise<Answer>;
  ask_multiple(questions: Question[]): Promise<Answer[]>;
  inform(message: string, stage: string): Promise<void> | void;
}
```

`Question` gains a stable `id` so HTTP resources can address it directly.

`HttpInterviewer` behavior:

- `ask()` writes `questions/<qid>.json` with status `pending`
- emits `interview_started`
- waits on an in-memory resolver owned by `QuestionStore`
- answer submission updates the same file to `answered`
- emits `interview_completed`
- timeout updates the file to `timed_out` and emits `interview_timeout`

`ask_multiple()` writes one file per question and resolves answers in input order. Console-based interviewers may still prompt sequentially; only the HTTP interviewer needs true batch resource handling this sprint.

`inform(message, stage)` is used for one-way notices such as “review required” or “waiting on human approval.” In server mode it emits a non-blocking informational event and writes nothing to checkpoint state.

### Event Model Changes

Add spec-defined interview events:

- `interview_started`
- `interview_completed`
- `interview_timeout`

Keep `human_question` and `human_answer` only if needed to avoid breaking the current CLI renderer during the refactor. New HTTP/UI work should consume the `interview_*` events instead.

### Graph Rendering

Use `@viz-js/viz` to render stored DOT into SVG inside the server process. The renderer reads the same DOT source the engine ran:

- raw submission: `<run-dir>/input.dot`
- file-backed submission: original `dot_path`, or a persisted copy if the file changed after launch

The graph endpoint is read-only and deterministic. It is not allowed to re-parse arbitrary caller-supplied DOT at request time.

### Tool Node Attribute Normalization

Canonical rule:

- `tool_command` is the spec-correct attribute
- `script` is accepted as a deprecated alias
- if both exist, `tool_command` wins

Validation should:

- accept either attribute for now
- warn when only `script` is used
- error when neither is present on a tool node

---

## Implementation Phases

### Phase 1: Shared Runtime Service and `nectar serve` Skeleton (~15%)

**Files:**
- `src/runtime/pipeline-service.ts` (create)
- `src/cli/commands/serve.ts` (create)
- `src/cli/index.ts` (modify)
- `src/server/server.ts` (create)
- `src/server/router.ts` (create)
- `src/server/types.ts` (create)
- `test/server/server.test.ts` (create)

**Tasks:**
- [ ] Extract run/start/resume orchestration out of CLI commands into `PipelineService`
- [ ] Update CLI `run` and `resume` to call the shared service instead of owning lifecycle logic directly
- [ ] Add `nectar serve` with `--host` and `--port` flags; default bind `127.0.0.1`
- [ ] Build the HTTP server on `node:http` with explicit route tables, not Express/Fastify
- [ ] Add shared JSON response helpers and consistent error payloads
- [ ] Add graceful shutdown: stop accepting new requests, abort active runs, flush journals, close listeners
- [ ] Add `GET /healthz` as a convenience endpoint if time permits

### Phase 2: Active Run Manager, Abort/Resume, and SSE Replay (~30%)

**Files:**
- `src/server/run-manager.ts` (create)
- `src/server/event-journal.ts` (create)
- `src/engine/engine.ts` (modify)
- `src/checkpoint/run-store.ts` (modify)
- `src/cli/commands/run.ts` (modify)
- `src/cli/commands/resume.ts` (modify)
- `test/server/run-manager.test.ts` (create)
- `test/integration/http-server.test.ts` (create)

**Tasks:**
- [ ] Create `RunManager` to own active engines, live subscribers, and abort handles keyed by `run_id`
- [ ] Add `PipelineEngine.abort(reason)` public API for server-driven cancellation
- [ ] Add `PipelineEngine` option to disable process-level signal handler registration in server mode
- [ ] Journal every emitted `RunEvent` to `events.ndjson` with monotonic `seq`
- [ ] Implement `GET /pipelines/{id}/events` as replay-then-tail SSE
- [ ] Support `Last-Event-ID` for reconnecting clients
- [ ] Implement:
  - [ ] `POST /pipelines`
  - [ ] `GET /pipelines/{id}`
  - [ ] `POST /pipelines/{id}/cancel`
  - [ ] `POST /pipelines/{id}/resume`
  - [ ] `GET /pipelines/{id}/checkpoint`
  - [ ] `GET /pipelines/{id}/context`
- [ ] Ensure cancel writes interrupted checkpoints with reason `api_cancel`
- [ ] Ensure resume follows restart chains exactly like the CLI path

### Phase 3: Durable Human Questions and Interview Lifecycle Events (~25%)

**Files:**
- `src/server/http-interviewer.ts` (create)
- `src/server/question-store.ts` (create)
- `src/interviewer/types.ts` (modify)
- `src/interviewer/console.ts` (modify)
- `src/interviewer/auto-approve.ts` (modify)
- `src/interviewer/callback.ts` (modify)
- `src/interviewer/queue.ts` (modify)
- `src/interviewer/recording.ts` (modify)
- `src/handlers/wait-human.ts` (modify)
- `src/engine/events.ts` (modify)
- `test/server/http-interviewer.test.ts` (create)
- `test/interviewer/interviewer.test.ts` (create)
- `test/integration/http-human-gate.test.ts` (create)

**Tasks:**
- [ ] Extend `Question` with a stable `id`
- [ ] Add `ask_multiple()` and `inform()` to the `Interviewer` interface
- [ ] Implement `ask_multiple()` and `inform()` across all five interviewer implementations
- [ ] Build `QuestionStore` that persists question files under `<run-dir>/questions/`
- [ ] Build `HttpInterviewer` that blocks on API answers rather than stdin
- [ ] Emit `interview_started`, `interview_completed`, and `interview_timeout` with durations and question IDs
- [ ] Implement:
  - [ ] `GET /pipelines/{id}/questions`
  - [ ] `POST /pipelines/{id}/questions/{qid}/answer`
- [ ] Keep page-refresh reconnect working by listing pending questions from disk, not only from memory
- [ ] Preserve the existing console-driven flow for CLI runs

### Phase 4: Graph Rendering and Spec-Correct Tool Attributes (~15%)

**Files:**
- `src/server/graph-renderer.ts` (create)
- `package.json` (modify)
- `src/garden/types.ts` (modify)
- `src/garden/parse.ts` (modify)
- `src/garden/validate.ts` (modify)
- `src/handlers/tool.ts` (modify)
- `test/server/graph-renderer.test.ts` (create)
- `test/handlers/tool.test.ts` (modify)
- `test/garden/parse.test.ts` (modify)
- `test/garden/validate.test.ts` (modify)

**Tasks:**
- [ ] Add `@viz-js/viz` for in-process SVG rendering
- [ ] Implement `GET /pipelines/{id}/graph`
- [ ] Resolve graph source from stored `input.dot` or persisted launch copy
- [ ] Parse `tool_command` and normalize it onto tool nodes
- [ ] Preserve `script` as a deprecated alias
- [ ] Prefer `tool_command` when both attributes are present
- [ ] Update validator messaging: require one of the two, warn on `script`-only usage

### Phase 5: Hardening, Compatibility, and Docs (~15%)

**Files:**
- `docs/server-api.md` (create)
- `src/cli/ui/renderer.ts` (modify)
- `test/integration/http-resume.test.ts` (create)
- `test/integration/http-sse-replay.test.ts` (create)

**Tasks:**
- [ ] Document the HTTP API and event stream contract for the future web UI
- [ ] Verify the CLI renderer still behaves correctly if legacy `human_*` events are retained during transition
- [ ] Add integration coverage for:
  - [ ] SSE replay after reconnect
  - [ ] cancel -> checkpoint -> resume flow
  - [ ] browser-driven `wait.human` answer submission
  - [ ] raw `dot_source` submissions that persist `input.dot`
- [ ] Update `docs/compliance-report.md` after implementation to remove GAP-1, GAP-2, GAP-3, and GAP-6

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/runtime/pipeline-service.ts` | Create | Shared run/start/resume orchestration for CLI and HTTP |
| `src/cli/commands/serve.ts` | Create | `nectar serve` command |
| `src/cli/index.ts` | Modify | Register `serve` command |
| `src/cli/commands/run.ts` | Modify | Delegate to shared pipeline service |
| `src/cli/commands/resume.ts` | Modify | Delegate to shared pipeline service |
| `src/server/server.ts` | Create | HTTP server bootstrap and lifecycle |
| `src/server/router.ts` | Create | Route matching, JSON responses, SSE helpers |
| `src/server/types.ts` | Create | Server DTOs and API shapes |
| `src/server/run-manager.ts` | Create | Active run registry, start/cancel/resume, subscribers |
| `src/server/event-journal.ts` | Create | `events.ndjson` append and replay |
| `src/server/http-interviewer.ts` | Create | Browser-facing interviewer implementation |
| `src/server/question-store.ts` | Create | Pending question persistence and answer resolution |
| `src/server/graph-renderer.ts` | Create | DOT-to-SVG rendering |
| `src/engine/engine.ts` | Modify | Public abort API, optional signal handler disable, server-safe lifecycle |
| `src/engine/events.ts` | Modify | Add interview lifecycle events |
| `src/checkpoint/run-store.ts` | Modify | Helpers for event journals, persisted DOT inputs, question files |
| `src/interviewer/types.ts` | Modify | Add `Question.id`, `ask_multiple()`, and `inform()` |
| `src/interviewer/console.ts` | Modify | Sequential batch prompting, informational notices |
| `src/interviewer/auto-approve.ts` | Modify | Batch auto-answer support |
| `src/interviewer/callback.ts` | Modify | Batch callback support |
| `src/interviewer/queue.ts` | Modify | Batch queued-answer support |
| `src/interviewer/recording.ts` | Modify | Record batch questions and informational notices |
| `src/handlers/wait-human.ts` | Modify | Stable question IDs and interview lifecycle events |
| `src/garden/types.ts` | Modify | Canonical tool command field/normalization support |
| `src/garden/parse.ts` | Modify | Parse `tool_command`, preserve `script` alias |
| `src/garden/validate.ts` | Modify | Require `tool_command` or `script`; warn on alias usage |
| `src/handlers/tool.ts` | Modify | Execute normalized tool command |
| `src/cli/ui/renderer.ts` | Modify | Handle interview event transition if needed |
| `package.json` | Modify | Add SVG rendering dependency |
| `docs/server-api.md` | Create | Browser/backend contract for the future Hive |
| `test/server/server.test.ts` | Create | HTTP bootstrap and routing tests |
| `test/server/run-manager.test.ts` | Create | Active-run lifecycle tests |
| `test/server/http-interviewer.test.ts` | Create | Question persistence and answer resolution tests |
| `test/server/graph-renderer.test.ts` | Create | DOT-to-SVG endpoint tests |
| `test/interviewer/interviewer.test.ts` | Create | Cross-implementation `ask_multiple()` / `inform()` coverage |
| `test/integration/http-server.test.ts` | Create | End-to-end pipeline submission/status/cancel tests |
| `test/integration/http-human-gate.test.ts` | Create | Browser-driven human-gate flow |
| `test/integration/http-resume.test.ts` | Create | Cancel + resume over HTTP |
| `test/integration/http-sse-replay.test.ts` | Create | Replay and reconnect semantics |
| `test/handlers/tool.test.ts` | Modify | `tool_command` compatibility tests |
| `test/garden/parse.test.ts` | Modify | `tool_command` parsing tests |
| `test/garden/validate.test.ts` | Modify | validator behavior for `tool_command` / `script` |

---

## Definition of Done

- [ ] `nectar serve` starts a local server and binds to `127.0.0.1` by default
- [ ] `POST /pipelines` accepts exactly one of `dot_path` or `dot_source` and returns `202` with a `run_id`
- [ ] Raw DOT submissions are persisted as `input.dot` under the run directory
- [ ] `GET /pipelines/{id}` returns merged manifest/checkpoint/live-run status
- [ ] `GET /pipelines/{id}/events` is valid SSE, replays prior events, and streams live events
- [ ] SSE reconnect via `Last-Event-ID` does not duplicate or drop events
- [ ] `POST /pipelines/{id}/cancel` aborts the active run and writes interruption reason `api_cancel`
- [ ] `POST /pipelines/{id}/resume` resumes an interrupted run from checkpoint using the same semantics as CLI resume
- [ ] `GET /pipelines/{id}/checkpoint` returns the current cocoon JSON
- [ ] `GET /pipelines/{id}/context` returns the current context snapshot
- [ ] `GET /pipelines/{id}/graph` returns valid SVG for the launched DOT source
- [ ] `GET /pipelines/{id}/questions` returns stable pending question resources with `question_id`
- [ ] `POST /pipelines/{id}/questions/{qid}/answer` unblocks a waiting `wait.human` node
- [ ] `Interviewer.ask_multiple()` and `Interviewer.inform()` exist and work across all five interviewer implementations
- [ ] `interview_started`, `interview_completed`, and `interview_timeout` are emitted with question IDs and durations
- [ ] `PipelineEngine` can run under server mode without installing per-run process signal handlers
- [ ] Tool nodes accept `tool_command`; `script` remains supported as a deprecated alias
- [ ] Validation warns on `script`-only tool nodes and errors when neither command attribute is present
- [ ] CLI `run` and `resume` still work after the runtime-service refactor
- [ ] `npm run build` passes
- [ ] `npm test` passes with new unit and integration coverage
- [ ] `docs/compliance-report.md` can be updated to remove GAP-1, GAP-2, GAP-3, and GAP-6

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Multiple in-process engines conflict over SIGINT/SIGTERM handling | High | High | Add explicit server mode on `PipelineEngine` that disables internal signal registration; the server owns shutdown and aborts active runs itself |
| SSE replay produces duplicate or out-of-order events on reconnect | Medium | High | Journal every event with a monotonic sequence number; honor `Last-Event-ID`; add reconnect integration tests |
| Browser approval flow becomes memory-only and breaks on page refresh | Medium | High | Persist every pending question as a file under the run directory and list questions from disk, not just from in-memory waiters |
| Graph rendering via JS/WASM diverges from Graphviz behavior on edge cases | Medium | Medium | Render the exact stored DOT source, add golden tests, and keep the renderer isolated behind `graph-renderer.ts` |
| The runtime-service refactor breaks existing CLI behavior | Medium | High | Extract shared orchestration first, then port CLI to it before adding HTTP endpoints; keep CLI integration tests green throughout |
| Binding the server to a non-local interface without auth is dangerous | Medium | High | Default to `127.0.0.1`; require explicit `--host` override for broader binding and print a warning |
| `script` -> `tool_command` migration breaks old gardens | Low | Medium | Accept both attributes, prefer `tool_command`, warn instead of error for `script`-only usage this sprint |
| Server restart interrupts active runs mid-question | Medium | Medium | Lean on existing checkpoint/resume semantics; document that active server-owned runs can be resumed via HTTP after restart rather than pretending live state survived |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing `PipelineEngine`, `RunStore`, and checkpoint/cocoon infrastructure | Core execution, persistence, and resume |
| Existing interviewer abstraction and `wait.human` handler | Human-in-the-loop execution path |
| Existing CLI run/resume behavior | Source of truth for shared runtime-service semantics |
| Node built-ins (`http`, `fs`, `stream`, `events`) | Local HTTP server, SSE, persistence |
| `@viz-js/viz` | In-process DOT-to-SVG rendering |

No database. No external HTTP framework. No shell dependency on Graphviz.
