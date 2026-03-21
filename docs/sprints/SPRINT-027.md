# Sprint 027: Green Suite, Agent Observability, and Tool Contract Compliance

## Overview

**Goal:** Make `npm test` pass with zero failures, ship the 3 missing HTTP endpoints so the Hive can fully drive the engine, add the missing agent session lifecycle events so the Hive and CLI can see what codergen nodes are actually doing, and fix the tool-level contract gaps that silently degrade model behavior. After this sprint: CI is trustworthy, the server API is feature-complete, agent sessions are fully observable, and tool schemas match the spec.

**Why this sprint, why now:**

1. **The red suite has survived 4 sprints.** Sprints 022–026 all declared test fixes non-negotiable. 6 tests still fail. The pattern is clear: every sprint that bundles test fixes with feature work ships the features and punts the debugging. This sprint makes the green suite the *only* gate for Phase 1. No subsequent phase starts until `npm test` reports zero failures. The debugging methodology is diagnosis-first: reproduce, instrument, root-cause, fix — not bump timeouts and hope.

2. **The 6 failures decompose into 3 root causes.** (a) `pipeline-events` fails because the `PipelineFailedEvent` message says `"Node 'bad' failed."` but the test asserts `.toContain('failure')` — either the message format or the assertion needs aligning. (b) `gardens-draft` fails because the simulation DOT output changed format (`digraph {` vs `digraph Drafted {`) — the assertion is stale. (c) The 4 timeout failures (`hive-run-flow`, `http-resume`, `seed-run-linkage`, `workspace-events`, `fan-in-llm`) share a common pattern: async SSE/HTTP flows that never resolve, pointing to promise lifecycle bugs in the server layer where `res.end()` is never called or event bus wiring is missing. Fix the promise plumbing, fix 4 tests.

3. **3 HTTP endpoints are missing and the Hive needs all of them.** The attractor spec requires `POST /pipelines/:id/cancel`, `GET /pipelines/:id/checkpoint`, and `GET /pipelines/:id/context`. The Hive's cancel button, checkpoint inspector, and context viewer are dead features without these.

4. **Agent sessions are a black box.** The session state machine exists (`IDLE -> PROCESSING -> AWAITING_INPUT -> CLOSED`) but the event model only tells part of the story. Consumers cannot see user input accepted, steering injected, text start/end, tool output deltas, processing ended, session ended, turn limits reached, or warnings. Adding these events makes codergen nodes observable through the Hive and CLI without touching any frontend code.

5. **Tool contract gaps silently degrade model behavior.** The tool handler writes `{node_id}.stdout` instead of `tool.output` — every downstream consumer reading the spec-defined key gets nothing. `grep` lacks `case_insensitive`, forcing the model into ugly regex workarounds. `shell` lacks `description`, losing human-readable intent from transcripts. `spawn_agent` lacks `model`, forcing child sessions onto the parent model. These are small fixes with outsized impact on agent quality.

6. **Truncation favors the wrong end.** The current 80/20 head/tail split loses stack traces, test summaries, and compiler footers — exactly the information the model needs most. The spec requires 50/50.

**Gaps closed:**

| Phase | Gaps | Count | Description |
|-------|------|-------|-------------|
| 1 | 6 test failures | 6 | Green suite — prerequisite for trustworthy CI |
| 2 | 7 | 1 | Tool handler context key: `tool.output` per spec |
| 2 | 6 | 1 | QueueInterviewer returns SKIPPED instead of throwing |
| 3 | 8 | 1 | Missing HTTP endpoints: cancel, checkpoint, context |
| 4 | 9 | 1 | Session lifecycle events |
| 5 | 10, 11, 23, 24 | 4 | Tool schema gaps: grep case_insensitive, shell description, spawn_agent model/output limit |
| 5 | 20, 21, 22 | 3 | Truncation: 50/50 split, spec marker wording, head/tail line truncation |
| — | **Total** | **17** | 8 compliance gaps + 6 test failures + 3 truncation gaps |

**Cut line (in order):**
1. Truncation changes (gaps 20–22) — important but no runtime correctness impact
2. Tool schema additions (gaps 10, 11, 23, 24) — high value but not blocking
3. Session lifecycle events (gap 9) — large scope, can stand alone in a follow-up

Do **not** cut the test fixes, tool.output key (gap 7), QueueInterviewer (gap 6), or HTTP endpoints (gap 8). These are runtime-correctness or API-completeness issues that block downstream work.

**Out of scope:**

- Engine retry jitter, preset parameters, should_retry predicate (gaps 1–3) — important but lower urgency than observability; defer to a focused retry sprint
- Unified LLM type system gaps (26–36) — large, self-contained; warrants own sprint
- Error taxonomy and adapter classification (41–50) — same rationale
- ExecutionEnvironment interface additions (gaps 15–19) — large abstraction refactor, no one swaps environments today
- Diagnostic model additions (gaps 4–5) — cosmetic; no runtime behavior change
- Project instruction discovery direction (gap 25) — behavioral difference, not broken; risks monorepo latency
- All Hive UI features, CLI distribution, dark mode, shell completions

---

## Use Cases

1. **CI goes green and stays green.** A developer runs `npm test` after a clean checkout. All test files pass. The 6 persistent failures from sprints 022–026 are resolved. CI can gate merges on test status for the first time.

2. **A downstream consumer reads tool output.** A conditional node checks `context.tool.output` to decide routing. Because the tool handler now writes to the spec-defined key, the condition matches. Previously, the output was written to `{node_id}.stdout` and the condition silently failed.

3. **A test with QueueInterviewer handles exhaustion gracefully.** A pipeline has 3 human gates but the queue only has 2 answers. The third gate returns `SKIPPED` instead of crashing with an unhandled exception. The pipeline continues on the default/fallback edge.

4. **The Hive cancels a running pipeline.** A user clicks "Cancel" in the browser. The Hive sends `POST /pipelines/:id/cancel`. The server checkpoints the current state, terminates execution, and returns the interrupted status.

5. **The Hive inspects a checkpoint.** A user clicks on a completed node in the pipeline graph. The Hive fetches `GET /pipelines/:id/checkpoint` and displays the full checkpoint state: completed nodes, context snapshot, retry counts.

6. **The Hive reads the context store.** During a running pipeline, the Hive polls `GET /pipelines/:id/context` to show live context key-value pairs in a debug panel.

7. **Watch a codergen node honestly.** A user runs a garden with a `box` node and watches `/pipelines/:id/events`. They see: user input queued, processing started, assistant text start, text deltas, tool call started, tool output deltas, steering injected, processing ended, and session ended. Today they only get a partial story.

8. **Use grep without fighting case.** The model wants to find `TODO`, `Todo`, and `todo` across a repo. It calls `grep` with `case_insensitive=true` and gets predictable results instead of inventing ugly regex workarounds.

9. **Describe expensive commands before running them.** The model calls `shell` with a human-readable `description` like `"Run the slow integration test suite"`. The transcript and session events preserve that description so humans can understand intent without reverse-engineering the raw command string.

10. **Spawn a cheaper or stronger child intentionally.** A parent session running on a strong model spawns a child with `model="gemini-2.5-flash"` for cheap search. Today the child is forced onto the parent model path.

11. **Preserve useful tail context in tool output.** A tool emits 20,000 lines. The model-visible preview keeps both the start and the end with 50/50 split. That matters for stack traces, test summaries, and compiler footers.

---

## Architecture

No new modules or major abstractions. This sprint modifies existing files to fix bugs, fill API gaps, and complete event contracts. The changes are surgical.

### Test Fixes (3 root causes → 6 green tests)

**Root cause A — Assertion mismatches (2 tests):**
- `pipeline-events.test.ts` asserts `.toContain('failure')` but the message is `"Node 'bad' failed."`. Fix: update the assertion to match the actual message format, OR update `buildFailureMessage()` to include "failure" as a substring.
- `gardens-draft.test.ts` asserts `payload.toContain('digraph Drafted')` but the simulation DOT output uses a different graph name. Fix: align the output or the test — whichever matches the spec.

**Root cause B — SSE/async lifecycle bugs (4 tests):**
- `hive-run-flow`, `http-resume`, `seed-run-linkage`, and `workspace-events` all timeout waiting for SSE events that never arrive. The common pattern: async operations complete or error but the SSE response stream is never closed (`res.end()` not called), or the event bus isn't wired to the service that emits the events. Audit every SSE endpoint for missing `res.end()` on completion/error paths, and verify event bus wiring in server.ts constructor.

**Anti-pattern:** Timeout values must not be increased to achieve passing tests. If a test still times out after the fix, the root cause is not resolved.

### Tool Handler and Interviewer Fixes (Gaps 6–7)

**File: `src/handlers/tool.ts`** — Change context_updates keys from `{node_id}.stdout`/`{node_id}.stderr` to `tool.output`, `tool.stderr`, `tool.exit_code`.

**File: `src/interviewer/queue.ts`** — Change `throw new Error('No more queued answers')` to `return { selected_label: 'SKIPPED', source: 'queue_exhausted' }`.

### Missing HTTP Endpoints (Gap 8)

**File: `src/server/routes/pipelines.ts`** — Three new route handlers:

1. **`POST /pipelines/:id/cancel`** — Look up the active run in `RunManager`. Call `engine.abort()` (which triggers checkpoint + graceful shutdown). Return `{ status: 'interrupted', checkpoint_id }`. 404 if run not found, 409 if already completed/cancelled.

2. **`GET /pipelines/:id/checkpoint`** — Read the checkpoint file from the run's cocoon directory. Return the raw checkpoint JSON. 404 if no checkpoint exists.

3. **`GET /pipelines/:id/context`** — Read the context store from the active run (if running) or from the latest checkpoint (if completed/interrupted). Return `{ context: Record<string, string> }`.

### Session Lifecycle Events (Gap 9)

Add the missing agent-loop events as additive types in `src/agent-loop/events.ts`:

- `agent_user_input`, `agent_steering_injected`
- `agent_assistant_text_start`, `agent_assistant_text_end`
- `agent_tool_call_output_delta`
- `agent_processing_ended`, `agent_session_ended`
- `agent_turn_limit_reached`
- `agent_warning`, `agent_error`

Design rules:
- `agent_session_started` and `agent_session_completed` are unchanged.
- `agent_session_ended` is new — fires only when the session actually closes or aborts.
- `agent_processing_ended` fires on every transition back to `AWAITING_INPUT`.
- `agent_warning` covers context-window pressure and tool-output truncation. Keep `context_window_warning` for compatibility.
- `agent_error` is for fatal loop-level failures, not ordinary tool failures.

Bridge new events into engine `RunEvent`s via `bridgeAgentEvent()` in `src/handlers/codergen.ts`.

### Tool Schema Fixes (Gaps 10, 11, 23, 24)

- `shell` gets an optional `description` field, surfaced in transcripts/events.
- `grep` gets `case_insensitive`, implemented in the regex path.
- `spawn_agent` gets `model`, threaded through `SubagentManager` and child-session creation.
- `spawn_agent` gets a default output limit in `TOOL_OUTPUT_LIMITS`.

### Truncation Compliance (Gaps 20–22)

- Character truncation: 80/20 → 50/50 head/tail split.
- Truncation marker wording: match spec warning text exactly.
- Line truncation: head-only → head/tail.
- `ToolRegistry` continues to store full untruncated content when preview truncation occurs.

---

## Implementation

### Phase 1: Green Suite (35% of effort)

**Priority:** This phase is the gate. Nothing else starts until all 6 tests pass.

**Files:** `test/server/pipeline-events.test.ts`, `test/server/gardens-draft.test.ts`, `src/runtime/garden-draft-service.ts`, `src/engine/engine.ts`, `src/server/routes/pipelines.ts`, `src/server/routes/seeds.ts`, `src/server/routes/gardens.ts`, `src/server/routes/events.ts`, `src/server/run-manager.ts`, `src/server/workspace-event-bus.ts`, `src/server/swarm-manager.ts`, `src/runtime/swarm-analysis-service.ts`, `test/integration/fan-in-llm.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/seed-run-linkage.test.ts`, `test/server/workspace-events.test.ts`

**Tasks:**
- [ ] Fix `pipeline-events.test.ts`: Align the assertion with the actual `buildFailureMessage()` output. If the message format is correct per the spec, update the test. If not, update the message format.
- [ ] Fix `gardens-draft.test.ts`: Trace the simulation DOT generation path in `garden-draft-service.ts`. Align whichever side (code or test) doesn't match the spec.
- [ ] Diagnose timeout root causes: Instrument the 4 timeout tests with explicit logging. For each SSE endpoint, verify: (a) the event bus is wired in `server.ts`, (b) `res.end()` is called on every completion and error path, (c) the async operation actually completes (no dangling promises).
- [ ] Fix `workspace-events.test.ts`: Verify `SwarmAnalysisService` receives the `event_bus` in its constructor. Wire it in `server.ts` if missing.
- [ ] Fix `hive-run-flow.test.ts` and `http-resume.test.ts`: Audit the cancel/resume HTTP flow. Verify `RunManager.cancel()` triggers checkpoint and status change, and `RunManager.resume()` restarts execution and re-emits SSE events.
- [ ] Fix `seed-run-linkage.test.ts`: Verify the seed→run linkage writes `linked_runs` to `meta.yaml` and that run lifecycle events propagate through the event bus.
- [ ] Fix `fan-in-llm.test.ts`: Verify the fan-in handler saves artifacts and context updates when using LLM-prompted selection.
- [ ] Run `npm test` — must be 0 failures before proceeding to Phase 2. Timeout values must not be increased to achieve passing tests.

### Phase 2: Tool Handler and Interviewer Fixes (10% of effort)

**Files:** `src/handlers/tool.ts`, `src/interviewer/queue.ts`, `test/handlers/tool.test.ts`, `test/interviewer/interviewer.test.ts`

**Tasks:**
- [ ] Tool handler: Change context_updates keys from `{node_id}.stdout`/`{node_id}.stderr` to `tool.output`, `tool.stderr`, `tool.exit_code`.
- [ ] Update any engine code or tests that read the old key names.
- [ ] Add test: tool handler sets `tool.output` in context after execution.
- [ ] QueueInterviewer: Replace `throw new Error(...)` with `return { selected_label: 'SKIPPED', source: 'queue_exhausted' }`.
- [ ] Add test: QueueInterviewer with 1 answer and 2 questions returns answer then SKIPPED.

### Phase 3: Missing HTTP Endpoints (15% of effort)

**Files:** `src/server/routes/pipelines.ts`, `src/server/run-manager.ts`, `src/server/types.ts`, `test/server/pipeline-events.test.ts`, `test/integration/http-server.test.ts`

**Tasks:**
- [ ] Implement `POST /pipelines/:id/cancel`: look up run in RunManager, call `abort()` on AbortController, wait for graceful shutdown, return `{ status: 'interrupted', run_id, checkpoint_id }`. 404 if not found, 409 if already completed.
- [ ] Implement `GET /pipelines/:id/checkpoint`: read `checkpoint.json` from run directory, return raw JSON. 404 if not found.
- [ ] Implement `GET /pipelines/:id/context`: read from engine's live context store (if active) or checkpoint's `context_values` (if completed). Return `{ context: Record<string, string> }`. 404 if not found.
- [ ] Tests: cancel active → 200 + interrupted; cancel completed → 409; GET checkpoint → valid JSON; GET context → matches engine state.

### Phase 4: Session Lifecycle Events (25% of effort)

**Files:** `src/agent-loop/events.ts`, `src/agent-loop/session.ts`, `src/handlers/codergen.ts`, `src/engine/events.ts`, `test/agent-loop/events.test.ts`, `test/agent-loop/session.test.ts`, `test/integration/agent-loop.test.ts`

**Tasks:**
- [ ] Add missing agent event types and payloads in `src/agent-loop/events.ts`.
- [ ] Emit `agent_user_input` when `submit()` and `followUp()` accept a prompt.
- [ ] Emit `agent_steering_injected` when queued steer messages are drained.
- [ ] Emit `agent_assistant_text_start` before first `content_delta` of a turn.
- [ ] Emit `agent_assistant_text_end` when a streamed assistant turn finishes.
- [ ] Emit `agent_tool_call_output_delta` in deterministic chunks before `agent_tool_call_completed`.
- [ ] Emit `agent_processing_ended` on transition back to `AWAITING_INPUT`.
- [ ] Emit `agent_session_ended` on `close()` and `abort()` with final state and reason.
- [ ] Emit `agent_turn_limit_reached` when `max_turns` is exhausted.
- [ ] Emit `agent_warning` for context-window pressure and tool-output truncation.
- [ ] Emit `agent_error` on fatal loop-level failures.
- [ ] Extend `src/engine/events.ts` with run-event equivalents for new bridged agent events.
- [ ] Update `bridgeAgentEvent()` in `src/handlers/codergen.ts`.
- [ ] Add tests for event ordering and payload contents.

### Phase 5: Tool Schema Fixes and Truncation (15% of effort)

**Files:** `src/agent-loop/tools/shell.ts`, `src/agent-loop/tools/grep.ts`, `src/agent-loop/tools/spawn-agent.ts`, `src/agent-loop/subagent-manager.ts`, `src/agent-loop/truncation.ts`, `src/agent-loop/tool-registry.ts`, `test/agent-loop/truncation.test.ts`, `test/agent-loop/tool-registry.test.ts`, `test/agent-loop/tools/grep.test.ts`

**Tasks:**
- [ ] Add `description` to `shellSchema` and preserve it in event/transcript metadata.
- [ ] Add `case_insensitive` to `grepSchema` and implement in regex path.
- [ ] Add `model` to `spawnAgentSchema`, thread through `SubagentManager` and child-session creation.
- [ ] Add `spawn_agent` to `TOOL_OUTPUT_LIMITS`.
- [ ] Change character truncation from 80/20 to 50/50 head/tail split.
- [ ] Change truncation marker wording to spec warning text.
- [ ] Change line truncation from head-only to head/tail.
- [ ] Ensure `ToolRegistry` stores full untruncated content when preview truncation occurs.
- [ ] Add tests for case-insensitive grep, shell descriptions, child-model override, truncation split and marker text.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/engine.ts` | Modify | Fix buildFailureMessage if needed for test alignment |
| `src/handlers/tool.ts` | Modify | Fix context key from {node_id}.stdout to tool.output |
| `src/handlers/codergen.ts` | Modify | Bridge richer agent events into engine RunEvents |
| `src/interviewer/queue.ts` | Modify | Return SKIPPED instead of throwing on exhaustion |
| `src/server/routes/pipelines.ts` | Modify | Add cancel, checkpoint, context endpoints |
| `src/server/routes/seeds.ts` | Modify | Fix SSE lifecycle (res.end on completion) |
| `src/server/routes/gardens.ts` | Modify | Fix SSE lifecycle (res.end on completion) |
| `src/server/routes/events.ts` | Modify | Fix SSE lifecycle (res.end on completion) |
| `src/server/run-manager.ts` | Modify | Add cancel(), getCheckpoint(), getContext() methods |
| `src/server/workspace-event-bus.ts` | Modify | Verify event wiring |
| `src/server/swarm-manager.ts` | Modify | Wire event bus if missing |
| `src/runtime/garden-draft-service.ts` | Modify | Fix simulation DOT output format if needed |
| `src/runtime/swarm-analysis-service.ts` | Modify | Wire event bus if missing |
| `src/agent-loop/events.ts` | Modify | Add missing session lifecycle event types |
| `src/agent-loop/session.ts` | Modify | Emit new lifecycle events at state transitions |
| `src/agent-loop/types.ts` | Modify | Extend types for output limits |
| `src/agent-loop/truncation.ts` | Modify | 50/50 split, spec marker wording, head/tail lines |
| `src/agent-loop/tool-registry.ts` | Modify | Preserve full content, emit truncation warnings |
| `src/agent-loop/tools/shell.ts` | Modify | Add description to schema |
| `src/agent-loop/tools/grep.ts` | Modify | Add case_insensitive behavior |
| `src/agent-loop/tools/spawn-agent.ts` | Modify | Add model to schema |
| `src/agent-loop/subagent-manager.ts` | Modify | Thread child-model overrides |
| `src/engine/events.ts` | Modify | Run-event counterparts for new agent events |
| `src/server/types.ts` | Modify | Types for new endpoints |
| `test/server/pipeline-events.test.ts` | Modify | Fix assertion, add endpoint tests |
| `test/server/gardens-draft.test.ts` | Modify | Fix assertion to match actual output |
| `test/integration/fan-in-llm.test.ts` | Modify | Fix timeout root cause |
| `test/integration/hive-run-flow.test.ts` | Modify | Fix timeout root cause |
| `test/integration/http-resume.test.ts` | Modify | Fix timeout root cause |
| `test/integration/seed-run-linkage.test.ts` | Modify | Fix timeout root cause |
| `test/server/workspace-events.test.ts` | Modify | Fix event bus wiring |
| `test/handlers/tool.test.ts` | Modify | Update context key assertions |
| `test/interviewer/interviewer.test.ts` | Modify | Add QueueInterviewer exhaustion test |
| `test/agent-loop/events.test.ts` | Modify | Verify new event types |
| `test/agent-loop/session.test.ts` | Modify | Verify lifecycle event emission |
| `test/integration/agent-loop.test.ts` | Modify | Verify codergen loop with richer events |
| `test/agent-loop/truncation.test.ts` | Modify | Verify 50/50 split and spec marker |
| `test/agent-loop/tool-registry.test.ts` | Modify | Verify truncation warnings |
| `test/agent-loop/tools/grep.test.ts` | Modify | Verify case-insensitive search |
| `test/integration/http-server.test.ts` | Modify | Add cancel/checkpoint/context tests |

---

## Definition of Done

- [ ] `npm test` passes with 0 failures on a clean checkout
- [ ] `pipeline-events` test passes: `pipeline_failed` event is emitted with correct fields
- [ ] `gardens-draft` test passes: SSE stream contains expected DOT output
- [ ] `hive-run-flow` test passes: full preview/save/run/question/cancel/resume flow completes within timeout
- [ ] `http-resume` test passes: cancel + resume flow completes within timeout
- [ ] `seed-run-linkage` test passes: seed lifecycle tracks linked runs on filesystem
- [ ] `workspace-events` test passes: seed analysis lifecycle events stream via SSE
- [ ] `fan-in-llm` test passes: fan-in handler persists context and artifacts
- [ ] No timeout values were increased to achieve passing tests
- [ ] Tool handler writes `tool.output` context key (not `{node_id}.stdout`)
- [ ] QueueInterviewer returns `{ selected_label: 'SKIPPED' }` when queue is exhausted (no throw)
- [ ] `POST /pipelines/:id/cancel` returns 200 with interrupted status for active runs
- [ ] `POST /pipelines/:id/cancel` returns 409 for already-completed runs
- [ ] `GET /pipelines/:id/checkpoint` returns the checkpoint JSON
- [ ] `GET /pipelines/:id/context` returns the context key-value pairs
- [ ] `agent_user_input`, `agent_steering_injected`, `agent_assistant_text_start`, `agent_assistant_text_end`, `agent_tool_call_output_delta`, `agent_processing_ended`, `agent_session_ended`, `agent_turn_limit_reached`, `agent_warning`, and `agent_error` are implemented and tested
- [ ] `close()` and `abort()` emit `agent_session_ended` exactly once
- [ ] Codergen bridges new agent events into engine `RunEvent`s without breaking existing consumers
- [ ] `shell` accepts `description`
- [ ] `grep` accepts `case_insensitive`
- [ ] `spawn_agent` accepts `model` and child sessions use the override
- [ ] `spawn_agent` has an explicit default output limit
- [ ] Character truncation uses a 50/50 head/tail split
- [ ] Line truncation uses head/tail, not head-only
- [ ] Truncation marker wording matches the spec warning text
- [ ] `ToolRegistry` preserves `full_content` whenever preview truncation occurs
- [ ] All new and modified code has corresponding test coverage
- [ ] `npm run build` succeeds with zero TypeScript errors

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE timeout root causes are deeper than res.end() — could be event loop starvation or deadlocked promises | Medium | High | Instrument with explicit debug logging before fixing. If root cause is architectural, fix the minimum needed to unblock tests and file a follow-up. |
| Changing tool handler context key (`tool.output` vs `{node_id}.stdout`) breaks existing condition expressions | Medium | Medium | Grep for all references to the old key pattern. Update conditions in test fixtures and built-in gardens. The old key was never spec-compliant. |
| Additive event types break downstream consumers with exhaustive switches | Medium | Medium | Keep changes additive, preserve existing event names, make CLI/UI consumers ignore unknown events by default. |
| Phase 1 debugging consumes the entire sprint | Medium | Medium | Acceptable outcome. The green suite is worth more than any compliance gap. If Phase 1 takes 80%, cut Phases 4–5 (session events, tool schemas, truncation). |
| Cancel endpoint races with engine checkpoint | Low | High | Use the existing AbortController pattern. Engine already handles SIGINT gracefully — cancel is the same signal via HTTP. |
| `agent_tool_call_output_delta` interpreted as live streaming though it is post-execution chunking | Medium | Low | Document the contract clearly in code comments. Emit deterministic deltas from the final output; defer true live streaming. |
| Child-model override produces invalid provider/model combinations | Medium | Medium | Validate against configured providers and fail the tool call cleanly with a structured error. |

---

## Dependencies

No new dependencies. All changes use existing libraries and patterns:

| Existing Dependency | Used For |
|---|---|
| `vitest` | Test framework (existing) |
| `execa` | Tool handler subprocess execution (existing) |
| `src/llm/errors.ts` | Error classification hierarchy (existing) |
| `src/server/router.ts` | HTTP route registration (existing) |
| `src/checkpoint/run-store.ts` | Checkpoint read/write (existing) |
| `ajv` | Tool schema validation (existing) |
| `ignore` | .gitignore handling for grep (existing) |
