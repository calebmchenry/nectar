# Sprint 002 Draft Critique

**Reviewer:** Codex
**Date:** 2026-03-20
**Drafts reviewed:** NEXT-CLAUDE-DRAFT.md (Claude), NEXT-GEMINI-DRAFT.md (Gemini)

---

## Claude Draft

### Strengths

1. **Comprehensive scope with clear justification.** The "Why this sprint, why now" section makes a compelling case for prioritizing GAP-1 and bundling the smaller gaps. The ordering argument (server is structural, swarm is additive) is sound.

2. **Deep architectural detail.** The module layout, key abstractions (PipelineService, RunManager, EventJournal, HttpInterviewer, QuestionStore, GraphRenderer), SSE protocol spec, and run directory layout leave little ambiguity for an implementer. The HTTP API contract is fully tabulated with methods, routes, status codes, and behaviors.

3. **PipelineService extraction is the right call.** Refactoring CLI `run`/`resume` to delegate to a shared service before building the HTTP layer prevents logic duplication and reduces the blast radius of later changes.

4. **Durability-first design for human gates.** Persisting pending questions to disk and listing from disk (not memory) means browser refreshes, SSE reconnects, and even server restarts don't lose approval state. This is a mature design choice.

5. **SSE replay via Last-Event-ID with monotonic sequence numbers.** The EventJournal abstraction with append-only NDJSON and sequence-based replay is well-specified and directly testable.

6. **Closes 5 of 6 gaps in one sprint.** GAP-1 through GAP-3, GAP-5, and GAP-6 are all addressed. Only GAP-4 (optional Gemini extended tools) is excluded, with justification.

7. **Risk table is thorough.** 11 risks identified with concrete mitigations — including WASM bundling with `bun build --compile`, signal handler conflicts in multi-engine mode, and multipart parsing complexity.

8. **Minimal dependency philosophy.** One new dependency (`@viz-js/viz`). No framework. Explicit rationale for `node:http` over Express/Fastify/Hono.

9. **Workspace endpoints from INTENT.md Section 4.** Garden CRUD, Seed CRUD, attachment uploads, and workspace-level SSE are included — not just the attractor-spec pipeline API. This unblocks the full Hive backend contract.

10. **Extensive test plan.** 13 specific integration test scenarios covering lifecycle, human gates, cancel, resume, SSE replay, graph rendering, CRUD, and backward compatibility.

### Weaknesses

1. **Sprint size is enormous.** 15+ new files, 15+ modified files, 40+ test files, 21 route handlers, a framework-level HTTP router, SSE infrastructure, multipart upload handling, WASM graph rendering, and 5 compliance gaps. This is realistically 2–3 sprints of work compressed into one. The "one sprint to zero gaps" narrative is appealing but risks partial delivery on all fronts rather than full delivery on any.

2. **`node:http` with custom router is under-motivated risk.** The draft argues 15 routes don't justify a framework, but those 15 routes need: JSON body parsing, CORS, multipart uploads, SSE streaming, structured error handling, query string parsing, path parameter extraction, content-type negotiation, and graceful shutdown. That's a framework's worth of infrastructure written from scratch. The "~100 lines" claim for the router ignores the surrounding utilities. This is build-vs-buy risk disguised as simplicity.

3. **No `POST /pipelines/{id}/resume` in the spec.** The compliance report's GAP-1 lists 9 endpoints. The draft adds a 10th (resume) and workspace endpoints (gardens, seeds, events). These are valuable, but the draft doesn't clearly separate "spec-required" from "INTENT.md-required" from "nice-to-have." If the sprint needs to be cut, it's unclear what's contractual vs. aspirational.

4. **Context window tracking (GAP-5) estimation is naive.** `totalChars / 4` across all history messages ignores that tool results, system prompts, and thinking tokens consume context differently. The model catalog has `context_window` but not input-vs-output token splits. The "emit at most once per session" constraint means the warning could fire too early (on a padded estimate) or never (if the estimate is wrong). No discussion of provider-specific token counting APIs.

5. **Graph rendering scope creep.** Execution state overlay (green/yellow/gray/red coloring) on SVG nodes requires parsing DOT node IDs, matching them to engine state, and injecting SVG attributes or CSS. This is non-trivial and not required by the spec — the spec says "rendered SVG," not "stateful SVG." If `@viz-js/viz` doesn't support attribute injection, this could become a rabbit hole.

6. **Workspace SSE (`GET /events`) is underspecified.** `fs.watch` with 100ms debounce is mentioned but: what events exactly? What payload schema? How are rename events handled? What about `.nectar/` directory changes during pipeline execution flooding the stream? No schema definition for workspace events despite the pipeline SSE protocol being fully specified.

7. **No load/stress considerations.** 4 concurrent runs is mentioned as a default, but what happens at the limit? Queue? Reject? What about 100 SSE connections to the same run? Memory-mapped NDJSON replay for a run with 10,000 events?

8. **Missing error response schemas.** The route table specifies status codes (400, 404, 409, 500) but doesn't define the error response body format. Consistency here matters for the web UI.

### Gaps in Risk Analysis

- **No risk identified for the PipelineService extraction breaking existing behavior.** This is listed as a task but not a risk, despite it being a refactor of the most critical code path (CLI run/resume). "Keep integration tests green throughout" is a mitigation, not a risk acknowledgment.
- **No risk for NDJSON file growth.** Long-running pipelines with verbose events could produce large journal files. No rotation, truncation, or size-based policy is discussed.
- **No risk for port conflicts.** Default port 4140 could conflict with other local services. No automatic port selection or clear error message is specified.
- **No consideration of concurrent garden/seed writes.** Multiple browser tabs or CLI + browser could race on file writes. No file locking or last-write-wins policy is stated.

### Missing Edge Cases

- What happens when `POST /pipelines` is called with a `dot_path` that points outside the workspace?
- What if the server is restarted while a pipeline is mid-execution? The draft says questions survive restart, but what about the engine itself? Is the run marked as interrupted?
- SSE connection limit per client — can a single browser tab open unlimited SSE connections?
- What if `DELETE /gardens/:name` targets a garden file that has an active pipeline run?

### Definition of Done Completeness

Strong. 31 items covering all routes, compliance gaps, backward compatibility, build, and test. Two gaps:
- No DoD item for error response format consistency.
- No DoD item for the `POST /pipelines` path-traversal guard (preventing `dot_path` from escaping the workspace).

---

## Gemini Draft

### Strengths

1. **Clean prioritization.** Phase 1 tackles spec polish (GAP-2, GAP-3, GAP-6) before touching the server. This reduces coupling — the interview and tool fixes land independently and can be tested in CLI mode first.

2. **Fastify is a defensible choice.** JSON schema validation, built-in CORS via plugin, `.inject()` for testing without a running server, and a mature ecosystem reduce the amount of custom infrastructure code.

3. **Concise and readable.** The draft is roughly 1/3 the length of Claude's. For a sprint document that will be executed by an AI agent, brevity can be a virtue — less room for contradictory instructions.

4. **Correctly identifies the core use cases.** The 5 use cases cover the essential flows: submit, stream, human-in-the-loop, cancel, and spec alignment.

### Weaknesses

1. **Significantly under-scoped.** Only 4 of 6 gaps addressed — GAP-5 (context window warning) is explicitly excluded with the vague note "Agent Loop and Provider extensions (GAP-4, GAP-5)." GAP-5 is a 1–2 hour task involving a counter and a threshold check; grouping it with GAP-4 (optional Gemini tools) to justify exclusion is not compelling. The sprint would leave required compliance gaps open.

2. **Missing workspace endpoints.** No garden CRUD, seed CRUD, attachment upload, or workspace-level SSE. These are required by INTENT.md Section 4 for the Hive backend contract. Without them, the server unblocks only pipeline execution in the browser — not the full web UI.

3. **Shallow architecture section.** RunManager is described in one sentence. ServerInterviewer gets two sentences. No discussion of: event journaling, SSE replay semantics, question durability, concurrent run limits, graceful shutdown behavior, or run directory layout. An implementer would need to make significant design decisions not addressed by the draft.

4. **In-memory-only question state.** The ServerInterviewer "stores the pending Question in memory." This means browser refresh loses the question, server restart loses the question, and there's no way to list questions from a reconnecting client. The Claude draft's disk-backed question store is strictly superior here.

5. **No SSE replay mechanism.** The draft mentions "replay of missed events (from cocoon history)" in the risk table but doesn't specify how. There's no event journal, no sequence numbering, no `Last-Event-ID` support. This is a critical gap for any browser client that might lose connectivity.

6. **Graph endpoint is hand-waved.** "Pass-through DOT content for client-side rendering or SVG (if configured)" — this is neither a decision nor a design. The spec requires SVG. Pushing rendering to the client means adding a client-side Graphviz dependency to the Hive, which is a deferred cost, not a savings.

7. **Port default is 8080.** This conflicts with many common local services (webpack-dev-server, various proxies). The Claude draft's 4140 is more distinctive. Minor but avoidable friction.

8. **Three new dependencies.** `fastify`, `@fastify/cors`, and potentially `@fastify/sse`. The project currently has a minimal dependency posture. Adding a full web framework introduces upgrade risk, bundling complexity with `bun build --compile`, and opinion lock-in. The draft doesn't discuss bundling implications.

9. **`tool_command` handling is incomplete.** "Rename `script` to `tool_command`" — this is a breaking change. Existing DOT files using `script` would stop working. The Claude draft's approach (accept both, prefer `tool_command`, warn on `script`-only) is backward-compatible and safer.

10. **No file summary for modified files.** The files table lists 9 entries. Claude's lists 44. The Gemini draft doesn't account for updating all 5 existing interviewer implementations for `ask_multiple`/`inform`, updating the CLI renderer for new event types, updating the garden parser/validator for `tool_command`, or any test files beyond a vague "test/server/*.test.ts."

### Gaps in Risk Analysis

- **Only 3 risks identified.** For a sprint that introduces an HTTP server, SSE streaming, and a new interviewer implementation, this is insufficient.
- **No risk for Fastify + `bun build --compile` compatibility.** This is a known pain point — Fastify uses dynamic requires and plugin loading that can break under bundlers.
- **No risk for signal handler conflicts** between the server process and PipelineEngine instances.
- **No risk for the `script` → `tool_command` rename breaking existing gardens.**
- **No risk for concurrent pipeline execution** (no max run limit discussed).

### Missing Edge Cases

- What happens when a pipeline completes or fails while no SSE client is connected? Are events lost?
- What if two clients try to answer the same question simultaneously?
- How does the server handle malformed DOT submissions (parse errors, validation failures)?
- What if the workspace directory doesn't exist or isn't writable?

### Definition of Done Completeness

Weak. 9 items vs. Claude's 31. Notable omissions:
- No DoD item for SSE reconnect/replay.
- No DoD item for graceful server shutdown.
- No DoD item for concurrent run handling.
- No DoD item for `ask_multiple`/`inform` on all interviewer implementations.
- No DoD item for backward compatibility of CLI `run`/`resume` after refactoring.
- No DoD item for `InterviewStarted`/`Completed`/`Timeout` events being emitted (only mentioned in implementation, not in DoD).
- Response code is listed as 201 for `POST /pipelines`; the spec's async semantics suggest 202 is more appropriate.

---

## Recommendations for the Final Merged Sprint

### 1. Adopt Claude's scope with Gemini's phasing strategy

Claude's scope is correct — GAP-5 should be included, workspace endpoints are required for the Hive contract, and question durability is non-negotiable. But the sprint should be split into two deliverable milestones:

- **Milestone A (Core Server):** PipelineService extraction, `nectar serve`, 9 pipeline endpoints + SSE with replay, HttpInterviewer with disk-backed questions, GAP-2/GAP-3/GAP-6. This is the minimum viable server.
- **Milestone B (Workspace & Polish):** Garden CRUD, Seed CRUD, workspace SSE, graph rendering with state overlay, GAP-5 (context window). This completes the INTENT.md contract.

If the sprint runs long, Milestone A alone is still a shippable, valuable increment.

### 2. Use Fastify, not `node:http`

Claude's argument for `node:http` underestimates the utility cost. Fastify provides: schema-validated routes, `.inject()` testing (no port binding needed), plugin-scoped lifecycle hooks, built-in CORS, structured error handling, and graceful shutdown. The `bun build --compile` risk is real but testable early — add a smoke build in Phase 1 as a go/no-go gate. If Fastify fails bundling, fall back to `node:http` with full awareness of the cost. **However**, if the project already builds with `bun build --compile` and has avoided frameworks intentionally, `node:http` may be the pragmatic choice. This decision should be made by testing Fastify bundling before committing.

### 3. Disk-backed question store (from Claude)

Non-negotiable. In-memory-only questions are a reliability regression. Adopt Claude's QuestionStore design with question files under `<run-dir>/questions/`.

### 4. SSE replay with EventJournal (from Claude)

Adopt the NDJSON journal with monotonic sequence numbers and `Last-Event-ID` replay. Add a journal size warning at 50MB and document that long-running pipelines may need event rotation in a future sprint.

### 5. Backward-compatible `tool_command` (from Claude)

Accept both `tool_command` and `script`. Prefer `tool_command`. Warn on `script`-only. Don't break existing gardens.

### 6. Strengthen the risk table

Merge both drafts' risks and add:
- Fastify/`node:http` bundling with `bun build --compile` (test early)
- NDJSON journal growth for long-running pipelines
- Port conflicts (auto-detect or clear error message)
- Concurrent file writes from multiple clients (last-write-wins with ETag or advisory lock)
- Path traversal on `dot_path` parameter (validate within workspace boundary)
- Server restart with mid-execution pipelines (mark runs as interrupted, don't silently lose them)

### 7. Expand the Definition of Done

Start from Claude's 31-item DoD and add:
- Error response body format is consistent across all endpoints (`{ error: string, code: string, details?: object }`)
- `POST /pipelines` with `dot_path` rejects paths outside the workspace
- Server restart marks in-flight runs as interrupted with checkpoint
- Port conflict produces a clear, actionable error message

### 8. In-process SVG rendering with cautious scope

Adopt `@viz-js/viz` for server-side SVG. Start with plain rendering (no execution state overlay). Add state coloring as a stretch goal — it requires DOT-to-SVG node ID mapping that may be brittle. The spec requires SVG, not stateful SVG.

### 9. Include GAP-5

It's small (counter + threshold + emit once), it closes a required compliance gap, and it has no dependencies on the server work. There's no reason to defer it.

### 10. Default port: 4140

More distinctive than 8080, less likely to conflict. Match the Claude draft.
