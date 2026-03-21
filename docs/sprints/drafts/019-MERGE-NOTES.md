# Sprint 019 Merge Notes

## Sources

| File | Author | Role |
|------|--------|------|
| NEXT-CLAUDE-DRAFT.md | Claude | Primary draft |
| NEXT-GEMINI-DRAFT.md | Gemini | Alternative draft |
| NEXT-CODEX-DRAFT.md | Codex | Alternative draft |
| NEXT-GEMINI-CRITIQUE.md | Gemini | Critique of Claude + Codex |
| NEXT-CODEX-CRITIQUE.md | Codex | Critique of Claude + Gemini |

## What Was Taken and Why

### From Claude Draft (primary structure)

The Claude draft became the backbone of SPRINT-019 because it was the most comprehensive and architecturally detailed:

- **Full scope including all 5 gaps.** Both critiques agreed GAP-5 should be included (Codex called Gemini's exclusion "not compelling"). Claude was the only draft that included it.
- **Workspace endpoints (Garden/Seed CRUD).** Required by INTENT.md §4. Codex explicitly excluded these; Gemini didn't mention them. Both critiques flagged this as a gap in the other drafts.
- **`node:http` over Fastify.** Codex's critique acknowledged the bundling risk with Fastify + `bun build --compile` and recommended testing Fastify first as a gate. Given the project's 18-sprint history of minimal dependencies, `node:http` is the safer default. The Codex critique's concern about utility cost is addressed by noting the focused utility functions approach.
- **Disk-backed QuestionStore.** Both critiques called this "non-negotiable" vs Gemini's in-memory-only approach.
- **SSE protocol with monotonic sequence numbers.** Codex's critique noted Gemini had "no SSE replay mechanism." Claude's EventJournal design was adopted wholesale.
- **Module layout and key abstractions.** PipelineService, RunManager, EventJournal, HttpInterviewer, QuestionStore, GraphRenderer — all from Claude with refinements.
- **`tool_command` backward compatibility.** Accept both, prefer `tool_command`, warn on `script`-only. Codex's critique flagged Gemini's "rename" approach as a breaking change.
- **Port 4140.** Codex's critique noted 8080 (Gemini's default) conflicts with common local services.
- **202 status for POST /pipelines.** Codex's critique flagged Gemini's 201 as incorrect for async execution.

### From Codex Draft

- **Cut line strategy.** Codex introduced a clear "cut line" distinguishing core work from convenience work. This was elevated into the Milestone A/B split structure.
- **Explicit out-of-scope for workspace endpoints.** While we *included* workspace endpoints (per critiques), we adopted Codex's pragmatism by making them deferrable in Milestone B.
- **Narrower SVG scope.** Codex didn't promise execution state coloring on SVG. This was adopted — plain SVG first, state overlay as a stretch goal. Codex's critique flagged Claude's SVG state overlay as "scope creep" that "requires DOT-to-SVG node ID mapping that may be brittle."
- **`control/` directory in run layout.** Codex's run directory layout included this; Claude's did not initially.
- **`inform()` semantics.** Codex's description of `inform()` as "non-blocking informational event" in server mode was cleaner than Claude's.

### From Gemini Draft

- **Phase 1 spec polish ordering.** Gemini proposed handling GAP-2/3/6 before the server. While not adopted as Phase 1 (the PipelineService extraction is more foundational), this influenced keeping the gap work tightly coupled with the server phases rather than deferring it all to Phase 5.
- **Fastify `.inject()` testing pattern.** While Fastify itself wasn't chosen, the critique's note about testability influenced ensuring the `node:http` router design supports similar test patterns.

### From Gemini Critique

- **Milestone A/B split.** Gemini's critique recommended "Adopt Claude's Full Scope, but Codex's Cut Line" — this directly became the Milestone A (Core Server) / Milestone B (Workspace & Polish) structure.
- **RunManager TTL.** "Explicitly specify a TTL for in-memory run tracking. Completed runs should be evicted after 1 hour." Added to RunManager spec.
- **Concurrent human gates.** "Ensure the HttpInterviewer and QuestionStore can handle multiple pending questions concurrently from parallel execution branches." Added to QuestionStore description.
- **Streaming replay.** "SSE replay should use Node streams rather than loading the entire events.ndjson into memory." Changed EventJournal to specify `fs.createReadStream` + readline.
- **Orphaned run detection.** "On startup, scan .nectar/cocoons/ for runs interrupted by server crash and mark as interrupted." Added as a Phase 2 task and DoD item.
- **Stale answer rejection.** "Add validation to reject answers for questions that are already resolved or timed out." Added to QuestionStore and as a 409 Conflict response.

### From Codex Critique

- **Path traversal guard.** "What happens when POST /pipelines is called with a dot_path that points outside the workspace?" Added explicit path traversal validation and DoD item.
- **Consistent error response format.** "Missing error response schemas." Added `{ error, code, details }` format to the API contract.
- **Port conflict handling.** "No risk for port conflicts." Added EADDRINUSE detection with clear error message.
- **Invalid Last-Event-ID handling.** "What if a client sends a Last-Event-ID that doesn't exist?" Added rule: replay from beginning.
- **Sprint size risk.** "This is realistically 2–3 sprints compressed into one." This reinforced the Milestone A/B split as the top risk mitigation.
- **NDJSON growth risk.** "No risk for NDJSON file growth." Added journal size warning at 50MB and streaming replay.
- **Concurrent file write risk.** "Multiple browser tabs or CLI + browser could race on file writes." Documented as last-write-wins for this sprint.
- **Expanded risk table.** Merged from 10 (Claude) + 3 (Gemini) + critique suggestions into 16 consolidated risks.
- **DoD expansion.** Started from Claude's 31 items, added 7 items from critique recommendations (path traversal, error format, orphaned runs, stale answers, port conflict, TTL cleanup, milestone split).

## What Was Rejected and Why

- **Fastify (Gemini).** Bundling risk with `bun build --compile` and the project's minimal-dependency philosophy. Codex's critique agreed this was a real concern.
- **In-memory-only questions (Gemini).** Both critiques called disk-backed questions "non-negotiable."
- **Breaking `script` rename (Gemini).** Would break existing gardens. Backward-compatible alias is strictly safer.
- **Execution state SVG overlay as required (Claude).** Demoted to stretch goal per Codex critique — plain SVG satisfies the spec.
- **GAP-5 exclusion (Gemini, Codex).** Both critiques agreed it should be included. It's small work with no server dependencies.
- **`docs/server-api.md` (Codex).** Not needed this sprint — the sprint document itself is the API contract. Documentation follows implementation.
- **`GET /healthz` (Codex).** Listed as "if time permits" in the draft. Cut entirely — not needed for the Hive contract.
- **`@fastify/cors`, `@fastify/sse` (Gemini).** Unnecessary with `node:http`. CORS is a few headers.
