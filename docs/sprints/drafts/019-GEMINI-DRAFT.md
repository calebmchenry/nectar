# Sprint 002: Attractor HTTP Server & Spec Polish

## Overview

**Goal:** Deliver the fully spec-compliant HTTP Server API to unblock Web UI ("The Hive") development, and close out the remaining core Attractor spec compliance gaps. After this sprint, Nectar can be run as a local background daemon that the web UI connects to for pipeline execution, real-time event streaming, and human-in-the-loop interactions.

**Scope:**
- Implement the HTTP Server API (REST + SSE) defined in `attractor-spec.md` Section 9 (Compliance Report GAP-1).
- Fix the tool handler attribute name to `tool_command` instead of `script` (Compliance Report GAP-6).
- Expand the `Interviewer` interface with `ask_multiple` and `inform` (Compliance Report GAP-2).
- Introduce standard `InterviewStarted`, `InterviewCompleted`, and `InterviewTimeout` events (Compliance Report GAP-3).
- Introduce a new CLI command `nectar serve` to start the local backend.

**Out of scope:**
- Web UI development (The Hive)
- Multi-AI Swarm Intelligence / Idea Backlog (Seedbed)
- Agent Loop and Provider extensions (GAP-4, GAP-5)

---

## Use Cases

1. **Submit and Run Pipeline via HTTP:** The web UI sends a DOT definition via `POST /pipelines`. The server parses, validates, writes it to the workspace, spawns the pipeline engine, and returns a unique run ID.
2. **Stream Execution Events:** The web UI connects to `GET /pipelines/{id}/events` using Server-Sent Events (SSE). As the engine advances, events (e.g., `NodeStarted`, `InterviewStarted`) are streamed in real-time to the browser.
3. **Remote Human-in-the-Loop:** When a pipeline hits a `wait.human` node, it pauses and exposes the pending question. The UI fetches it via `GET /pipelines/{id}/questions` and submits the user's choice via `POST /pipelines/{id}/questions/{qid}/answer`, instantly resuming the pipeline.
4. **Pipeline Cancellation:** A user realizes a pipeline is looping or incorrect and clicks "Cancel" in the UI. A `POST /pipelines/{id}/cancel` request cleanly aborts the pipeline and saves a terminal checkpoint.
5. **Spec-Compliant Tool Nodes:** Existing gardens using the `script` attribute are updated to use `tool_command`, fully aligning with the upstream spec.

---

## Architecture

### Language & Framework
- **Runtime:** TypeScript on Node.js (existing)
- **HTTP Framework:** `fastify` (chosen for performance, robust JSON schema validation, and ecosystem)
- **SSE Support:** Native Fastify response streaming or `@fastify/sse`
- **State Management:** In-memory `RunManager` singleton inside the server process to track active `PipelineEngine` instances, their event emitters, and pending human questions.

### Module Layout Updates

```
nectar/
├── src/
│   ├── cli/
│   │   └── commands/
│   │       └── serve.ts          # nectar serve command
│   ├── server/
│   │   ├── app.ts                # Fastify app initialization
│   │   ├── run-manager.ts        # In-memory tracking of active engines
│   │   └── routes/
│   │       └── pipelines.ts      # HTTP endpoints implementation
│   ├── handlers/
│   │   └── tool.ts               # Updated to use tool_command
│   ├── interviewer/
│   │   ├── types.ts              # Updated with ask_multiple, inform
│   │   └── server.ts             # New HTTP-backed Interviewer
│   └── engine/
│       └── events.ts             # Updated with Interview events
```

### Key Abstractions

**`RunManager`** — Tracks active pipeline executions (`Map<string, PipelineEngine>`). Manages graceful shutdown of runs when the server exits. Holds references to active SSE connections to broadcast engine events.

**`ServerInterviewer`** — An implementation of the `Interviewer` interface that, instead of blocking on the CLI, stores the pending `Question` in memory and returns a Promise that resolves when the `POST /pipelines/{id}/questions/{qid}/answer` endpoint receives the matching answer.

---

## Implementation Phases

### Phase 1: Spec Polish (GAP-2, GAP-3, GAP-6) (~15%)
**Tasks:**
- Rename `script` to `tool_command` in `src/handlers/tool.ts` and update related tests.
- Add `ask_multiple(questions: List<Question>): Promise<List<Answer>>` and `inform(message: string, stage: string): void` to `src/interviewer/types.ts`. Implement stubs/basic logic in existing CLI interviewers.
- Add `InterviewStartedEvent`, `InterviewCompletedEvent`, and `InterviewTimeoutEvent` to `src/engine/events.ts`.
- Update `src/handlers/wait-human.ts` to emit these events around the `ask()` call.

### Phase 2: HTTP Server & RunManager Initialization (~25%)
**Tasks:**
- Install `fastify` and related types.
- Create `src/server/run-manager.ts` to hold active runs.
- Create `src/server/app.ts` to configure Fastify, CORS, and error handling.
- Add `src/cli/commands/serve.ts` to expose `nectar serve [--port 8080]`.

### Phase 3: REST API Endpoints (~30%)
**Tasks:**
- `POST /pipelines`: Accept DOT payload, write to temp/garden dir, initialize `PipelineEngine`, add to `RunManager`, start execution, return `{ id: run_id }`.
- `GET /pipelines/{id}`: Return current status by querying `RunManager` or reading the latest cocoon from disk.
- `POST /pipelines/{id}/cancel`: Signal the engine to abort, emit `RunInterruptedEvent`, save checkpoint.
- `GET /pipelines/{id}/checkpoint`: Serve the JSON cocoon directly from `.nectar/cocoons/`.
- `GET /pipelines/{id}/context`: Return the context key-value snapshot.
- `GET /pipelines/{id}/graph`: Pass-through DOT content for client-side rendering or SVG (if configured).

### Phase 4: SSE & Human-in-the-Loop API (~30%)
**Tasks:**
- Implement `ServerInterviewer`: pauses execution, registers the question in `RunManager`, and awaits an external answer callback.
- `GET /pipelines/{id}/events`: Establish an SSE connection. Listen to the engine's `RunEvent` stream and forward serialized JSON payloads. Send history if connecting mid-run.
- `GET /pipelines/{id}/questions`: Return pending questions for the run from `RunManager`.
- `POST /pipelines/{id}/questions/{qid}/answer`: Accept user answer, resolve the pending Promise in `ServerInterviewer`, allowing the `wait.human` handler to proceed.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/handlers/tool.ts` | Modify | Change `script` to `tool_command` |
| `src/interviewer/types.ts` | Modify | Add `ask_multiple`, `inform` |
| `src/engine/events.ts` | Modify | Add `InterviewStarted`, `InterviewCompleted`, `InterviewTimeout` |
| `src/cli/commands/serve.ts` | Create | `nectar serve` command |
| `src/server/app.ts` | Create | Fastify application setup |
| `src/server/run-manager.ts` | Create | State tracking for active pipelines and questions |
| `src/server/routes/pipelines.ts` | Create | Route controllers for the API endpoints |
| `src/interviewer/server.ts` | Create | `ServerInterviewer` implementation |
| `test/server/*.test.ts` | Create | HTTP endpoint integration tests |

---

## Definition of Done

- [ ] All 4 core Attractor spec gaps from the compliance report (GAP-1, GAP-2, GAP-3, GAP-6) are completely resolved.
- [ ] `nectar serve` starts an HTTP server on port 8080 (or port specified via flag/env).
- [ ] A client can `POST /pipelines` with a valid DOT file and receive a 201 response with a run ID.
- [ ] A client can connect to `GET /pipelines/{id}/events` and receive valid SSE messages for `node_started`, `node_completed`, etc.
- [ ] A pipeline containing a `wait.human` node pauses execution. `GET /pipelines/{id}/questions` returns the pending question payload.
- [ ] `POST /pipelines/{id}/questions/{qid}/answer` safely resumes the pipeline with the selected answer.
- [ ] Tool nodes correctly use the `tool_command` attribute for execution in both CLI and Server modes.
- [ ] API routes have integration tests (e.g., using Fastify's `.inject()`).
- [ ] `npm test` and `npm run build` pass with zero errors.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Memory leaks in `RunManager` | Medium | High | Ensure engines, event listeners, and pending promises are explicitly cleaned up on run completion, failure, or cancellation. |
| SSE connection drops | High | Medium | Implement replay of missed events (from cocoon history) when a client reconnects to the event stream. |
| Process exits while server is running | Medium | Medium | Hook into `SIGINT`/`SIGTERM` in the server to cancel all active runs, trigger checkpoints, and shut down Fastify gracefully. |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `fastify` | High-performance HTTP server foundation |
| `@fastify/cors` | CORS support for Web UI access |
| `@fastify/sse` (or custom implementation) | Server-Sent Events output |
