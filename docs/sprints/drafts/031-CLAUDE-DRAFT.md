# Sprint 031: SSE Lifecycle Fix & Compliance Closure

## Overview

**Goal:** Fix the 6 failing tests (all SSE lifecycle bugs), close all 15 remaining compliance gaps, and ship a green, spec-complete engine. After this sprint: `npm test` is green, and a fresh compliance audit finds zero unimplemented requirements.

**Why this sprint, why now:**

1. **The test suite is red and has been red for multiple sprints.** 6 tests fail, all rooted in SSE streams that never close. Sprints 025–029 all declared "green suite" as a goal and failed to deliver. The SSE lifecycle bug is the single highest-priority defect in the codebase because it blocks validation of every HTTP-facing feature and erodes trust in the entire test suite.

2. **The SSE bug is one root cause with wide blast radius.** All 6 failing tests share the same failure mode: SSE streams opened by test clients never receive a close signal after a terminal pipeline event. The fix is narrow — the SSE route handler must call `res.end()` after emitting the terminal event — but untested because the streams hang before assertions run. Fixing this single issue unblocks 4 integration tests and 2 server tests simultaneously.

3. **15 compliance gaps remain and they are all mechanical.** Analysis of the 15 gaps:
   - **3 Attractor gaps:** Answer model enrichment (1), checkpoint `logs` field (2), event payload fields (3). All additive.
   - **6 Agent loop gaps:** Session event emission (4), provider_options (5), unregister (6), glob/grep on ExecutionEnvironment (7), auto-discover project instructions (8), git commit messages (9). All isolated, no cross-cutting changes.
   - **6 Unified LLM gaps:** stream_end response (10), Message.name (11), max_tool_rounds (12), prompt+messages rejection (13), cache disable key (14), ModelInfo naming (15). Most are one-line fixes or renames.

4. **No gap requires new architecture.** Every gap maps to a specific file and a specific spec section. The longest single task is ~2 hours (Answer model enrichment touches 5 interviewer implementations). The rest are 15–60 minutes each.

5. **This is the last sprint before new features can land cleanly.** The INTENT.md §5.1 hard gate — "zero unimplemented features" — cannot be met until these 15 gaps close. Every feature sprint built on a non-compliant engine risks rework. Closing this now means the next sprint can confidently build the Hive UI, seedbed, or swarm intelligence on a correct foundation.

**Out of scope:**
- New features, CLI commands, or HTTP endpoints beyond what's needed to close gaps
- Web UI / Hive design work
- Seedbed, swarm analysis, or garden authoring enhancements
- Performance optimization
- Shell completions, self-update, single-binary packaging
- Architecture refactoring beyond what's required for SSE fix and gap closure

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures. No timeouts. No skipped tests.

2. **SSE streams close deterministically.** A browser or test client opening `/pipelines/:id/events` receives live events during execution and a clean stream close after the terminal event (`run_completed`, `pipeline_failed`, `run_interrupted`). No orphaned connections, no hanging responses.

3. **Draft a garden from the Hive without hanging.** `POST /gardens/draft` streams `draft_start`, content deltas, then exactly one terminal event (`draft_complete` or `draft_error`), then the response ends.

4. **Cancel and resume works end-to-end over HTTP.** Cancel during active execution produces `interrupted` checkpoint with reason `api_cancel`. Resume continues from the checkpoint. SSE streams close on both operations.

5. **Compliance audit returns zero gaps.** An agent reading the three pinned spec documents and diffing against the codebase finds no unimplemented requirements.

6. **Interviewer answers carry full spec fidelity.** The `Answer` type includes `AnswerValue` enum (YES/NO/SKIPPED/TIMEOUT), `selected_option` index, and `text` for freeform responses. All 5 interviewer implementations produce correctly-typed answers.

7. **Streaming consumers get complete lifecycle events.** `stream()` emits `text_start` → `content_delta`* → `text_end` and `tool_call_start` → `tool_call_delta`* → `tool_call_end`. The final `stream_end` always carries a fully assembled `GenerateResponse`.

8. **Agent sessions auto-discover project instructions.** `submit()` finds and includes AGENTS.md, CLAUDE.md, GEMINI.md, and .codex/instructions.md without the caller having to pass them manually.

---

## Architecture

### No new architecture — two focused workstreams

**Workstream A: SSE Lifecycle Fix.** The SSE event stream routes (`/pipelines/:id/events` and `/gardens/draft`) must detect terminal events and call `res.end()`. The engine already emits terminal events correctly; the HTTP layer fails to act on them. The fix adds a listener in the SSE route that watches for terminal event types and closes the response.

**Workstream B: Compliance Gap Closure.** 15 independent, well-scoped changes across three spec boundaries. No gap depends on another gap. They group by file proximity:

| Group | Files | Gaps |
|-------|-------|------|
| Interviewer | `src/interviewer/types.ts`, `src/interviewer/*.ts` (5 impls) | 1 |
| Checkpoint | `src/checkpoint/types.ts`, `src/checkpoint/run-store.ts` | 2 |
| Engine events | `src/engine/events.ts`, `src/engine/engine.ts` | 3 |
| Agent session | `src/agent-loop/session.ts` | 4, 8 |
| Provider profiles | `src/agent-loop/provider-profiles.ts` | 5 |
| Tool registry | `src/agent-loop/tool-registry.ts` | 6 |
| Execution env | `src/agent-loop/execution-environment.ts` | 7 |
| Environment context | `src/agent-loop/environment-context.ts` | 9 |
| LLM streaming | `src/llm/streaming.ts`, `src/llm/stream-accumulator.ts` | 10 |
| LLM types | `src/llm/types.ts` | 11 |
| LLM client | `src/llm/client.ts` | 12, 13 |
| Anthropic adapter | `src/llm/adapters/anthropic.ts` | 14 |
| Model catalog | `src/llm/catalog.ts` | 15 |

### Key design decisions

1. **SSE close is listener-based, not polling-based.** The route handler subscribes to engine events. When it sees a terminal event type, it writes that event to the SSE stream and then calls `res.end()` on the next tick. This ensures the terminal event is flushed before close.

2. **Answer model is enriched, not replaced.** `selected_label` and `source` remain for backward compatibility. New fields (`answer_value`, `selected_option`, `text`) are added alongside. Existing code that only reads `selected_label` continues to work.

3. **`max_tool_rounds` aliased, not renamed.** Add `max_tool_rounds` to `GenerateRequest` per spec. Internally it maps to the existing `maxIterations` logic. The old `GenerateOptions.maxIterations` path is preserved but deprecated for direct callers.

4. **ModelInfo naming follows the spec.** `capabilities.tool_calling` → `supports_tools`, `capabilities.vision` → `supports_vision`, `capabilities.thinking` → `supports_reasoning`, `cost.input_per_million` → `input_cost_per_million`, `cost.output_per_million` → `output_cost_per_million`. This is a breaking rename. No known external consumers. Internal references are grep-and-replace.

5. **`glob()` and `grep()` get real implementations.** `LocalExecutionEnvironment.glob()` delegates to the same fast-glob library used by the glob tool. `grep()` delegates to ripgrep via `exec()`. The "Use the tool instead" error was a shortcut that violates the interface contract and prevents alternative environment implementations.

---

## Implementation

### Phase 1: SSE Lifecycle Fix — Green Suite (35% of effort)

**Priority:** This phase must complete first. No compliance work ships until the suite is green.

**Root cause:** The SSE route handlers in `src/server/routes/pipelines.ts` and `src/server/routes/gardens.ts` subscribe to engine/draft events and write them to the HTTP response as SSE, but never close the response after a terminal event. The response stays open indefinitely, causing test clients to hang.

**Tasks:**

- [ ] **Identify terminal events.** In the pipeline SSE route, terminal events are: `run_completed`, `pipeline_failed`, `run_interrupted`, `run_error`. In the gardens draft route, terminal events are: `draft_complete`, `draft_error`.

- [ ] **Add close-on-terminal logic to pipeline SSE route.** After writing a terminal event to the SSE stream, schedule `res.end()` on next tick (to ensure the terminal event is flushed). Remove the event listener on close to prevent leaks.

- [ ] **Add close-on-terminal logic to gardens draft SSE route.** Same pattern: write terminal event, then `res.end()` on next tick.

- [ ] **Handle client disconnect.** On `req.on('close')`, remove the event listener and clean up. Prevents orphaned listeners when browsers navigate away.

- [ ] **Fix `current_node` in context endpoint.** The `GET /pipelines/:id/context` handler should read `current_node` from the engine's live state (or checkpoint), not just from the context store. This fixes the `http-server` test assertion `expected undefined to be defined`.

- [ ] **Fix `run_error` event emission.** The `pipeline-events` test expects `run_error` in the event stream. Verify the engine emits `run_error` when a node fails without a failure edge, and that the SSE route forwards it.

- [ ] **Run full test suite.** All 134 test files must pass. Zero failures. Zero timeout-induced skips.

**Tests fixed:** `test/server/pipeline-events.test.ts`, `test/integration/http-server.test.ts`, `test/server/gardens-draft.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/seed-run-linkage.test.ts`.

### Phase 2: Attractor Spec Gaps (15% of effort)

**Gaps closed: 1, 2, 3**

**Tasks:**

- [ ] **Gap 1 — Answer model enrichment.** In `src/interviewer/types.ts`:
  - Add `AnswerValue` enum: `YES`, `NO`, `SKIPPED`, `TIMEOUT`.
  - Add `answer_value?: AnswerValue`, `selected_option?: number`, and `text?: string` to `Answer`.
  - Keep existing `selected_label` and `source` fields.
  - Update `AutoApproveInterviewer`: set `answer_value` based on default choice matching YES/NO patterns.
  - Update `ConsoleInterviewer`: set `answer_value` from user input; set `text` for freeform responses.
  - Update `CallbackInterviewer`: pass through answer_value from callback.
  - Update `QueueInterviewer`: exhausted → `AnswerValue.SKIPPED`.
  - Update `RecordingInterviewer`: record new fields.
  - Tests: assert `answer_value` and `selected_option` present on answers from each implementation.

- [ ] **Gap 2 — Checkpoint `logs` field.** In `src/checkpoint/types.ts`, add `logs: string[]` to `Cocoon`. In `src/checkpoint/run-store.ts`, append log file paths as nodes complete. Initialize as empty array on new runs. Test: checkpoint after two nodes has two log paths.

- [ ] **Gap 3 — Event payload enrichment.** In `src/engine/events.ts`:
  - Add `artifact_count: number` to `RunCompletedEvent`. Compute from artifact store size.
  - Add `index: number` to `NodeStartedEvent`. Track ordinal position in engine (increment counter per node_started).
  - In `src/engine/engine.ts`, pass these values when emitting events.
  - Tests: assert `artifact_count` on run_completed, `index` on node_started.

### Phase 3: Coding Agent Loop Gaps (25% of effort)

**Gaps closed: 4, 5, 6, 7, 8, 9**

**Tasks:**

- [ ] **Gap 4 — `agent_session_started` from session.** In `src/agent-loop/session.ts`, emit `agent_session_started` event at the start of the first `processWorkItem()` call (or in `submit()` before processing begins). Test: direct `AgentSession` consumer receives `agent_session_started` without going through codergen handler.

- [ ] **Gap 5 — `provider_options()` on ProviderProfile.** In `src/agent-loop/provider-profiles.ts`:
  - Add `providerOptions(): Record<string, unknown>` to the `ProviderProfile` interface.
  - `AnthropicProfile`: return `{ anthropic: { betas: ['interleaved-thinking-2025-04-14', 'prompt-caching-2024-07-31'] } }`.
  - `OpenAIProfile`: return `{ openai: { reasoning: { effort: 'medium' } } }` (or empty if no defaults).
  - `GeminiProfile`: return `{ gemini: { safetySettings: [...] } }` with standard permissive settings.
  - Session merges profile `providerOptions()` with any per-request overrides before LLM calls.
  - Test: each profile returns provider-specific options; session passes them to client.stream().

- [ ] **Gap 6 — `ToolRegistry.unregister()`.** In `src/agent-loop/tool-registry.ts`, add `unregister(name: string): boolean` that deletes from the internal map and returns whether it existed. Test: register a tool, unregister it, verify `definitions()` no longer includes it.

- [ ] **Gap 7 — Real `glob()` and `grep()` on LocalExecutionEnvironment.** In `src/agent-loop/execution-environment.ts`:
  - `glob(pattern, opts)`: delegate to `fast-glob` (already a dependency via the glob tool). Return matched file paths.
  - `grep(pattern, path, opts)`: delegate to `exec('rg', ...)` with appropriate flags. Return matching lines.
  - Remove the `throw 'Use the glob/grep tool instead'` stubs.
  - Test: glob matches files in a temp directory; grep finds content in a temp file.

- [ ] **Gap 8 — Auto-discover project instructions in `submit()`.** In `src/agent-loop/session.ts`, when `submit()` is called and the conversation has no prior system messages with project instructions, call `discoverInstructions()` from `project-instructions.ts` and prepend results to the system prompt. Cache the result for the session lifetime (instructions don't change mid-session). Test: submit on a session in a directory with AGENTS.md includes its content in the system prompt.

- [ ] **Gap 9 — Git context includes recent commits.** In `src/agent-loop/environment-context.ts`, extend `buildGitSnapshot()` to run `git log --oneline -10` and include the output as `recent_commits` in the context block. Handle non-git directories gracefully (omit the field). Test: git snapshot in a git repo includes recent commit lines.

### Phase 4: Unified LLM Spec Gaps (25% of effort)

**Gaps closed: 10, 11, 12, 13, 14, 15**

**Tasks:**

- [ ] **Gap 10 — `stream_end` carries complete response.** In `src/llm/streaming.ts`, change `response` from optional to required on `StreamEndEvent`. In `src/llm/stream-accumulator.ts`, ensure `response()` is called and passed into the `stream_end` event. Update all three adapter stream methods to build the complete response before emitting `stream_end`. Test: `stream_end` event has `response` with usage, stop_reason, and message.

- [ ] **Gap 11 — `Message.name` field.** In `src/llm/types.ts`, add `name?: string` to the `Message` interface. Update `Message.tool_result()` factory to accept optional `name`. Update adapters to pass `name` through when present. Test: message with `name` set round-trips through Anthropic adapter.

- [ ] **Gap 12 — `max_tool_rounds` on GenerateRequest.** In `src/llm/types.ts`, add `max_tool_rounds?: number` to `GenerateRequest` (default 1 per spec). In `src/llm/client.ts`, read `request.max_tool_rounds` in `generate()` and `stream()` tool loops, falling back to `GenerateOptions.maxIterations` for backward compatibility. Test: `generate()` with `max_tool_rounds: 2` executes up to 2 tool rounds.

- [ ] **Gap 13 — Reject prompt + messages.** In `src/llm/client.ts` `normalizePromptRequest()`, throw `InvalidRequestError` when both `prompt` and `messages` are provided. Test: calling `generate({ prompt: '...', messages: [...] })` throws.

- [ ] **Gap 14 — Prompt caching disable key.** In `src/llm/adapters/anthropic.ts`, check `provider_options.anthropic.auto_cache === false` (in addition to the existing `cache_control !== false` check). Accept both keys — the spec key (`auto_cache`) takes precedence. Test: `{ anthropic: { auto_cache: false } }` disables cache_control injection.

- [ ] **Gap 15 — ModelInfo capability naming.** In `src/llm/catalog.ts`:
  - Rename `capabilities.tool_calling` → `supports_tools`
  - Rename `capabilities.vision` → `supports_vision`
  - Rename `capabilities.thinking` → `supports_reasoning`
  - Rename `capabilities.streaming` → `supports_streaming`
  - Rename `capabilities.structured_output` → `supports_structured_output`
  - Flatten capabilities from nested object to top-level booleans on `ModelInfo`.
  - Rename `cost.input_per_million` → `input_cost_per_million`, `cost.output_per_million` → `output_cost_per_million`. Flatten cost to top-level fields.
  - Update all internal references (grep for `capabilities.` and `cost.` in catalog consumers).
  - Test: `getModelInfo('claude-opus-4-20250514').supports_tools === true`.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/routes/pipelines.ts` | Modify | Close SSE stream on terminal events; fix current_node in context endpoint |
| `src/server/routes/gardens.ts` | Modify | Close SSE stream on draft terminal events |
| `src/interviewer/types.ts` | Modify | Add AnswerValue enum, enrich Answer type |
| `src/interviewer/auto-approve.ts` | Modify | Produce enriched Answer |
| `src/interviewer/console.ts` | Modify | Produce enriched Answer with freeform text |
| `src/interviewer/callback.ts` | Modify | Pass through enriched Answer |
| `src/interviewer/queue.ts` | Modify | Use AnswerValue.SKIPPED on exhaustion |
| `src/interviewer/recording.ts` | Modify | Record enriched Answer fields |
| `src/checkpoint/types.ts` | Modify | Add `logs: string[]` to Cocoon |
| `src/checkpoint/run-store.ts` | Modify | Populate logs array as nodes complete |
| `src/engine/events.ts` | Modify | Add artifact_count to RunCompletedEvent, index to NodeStartedEvent |
| `src/engine/engine.ts` | Modify | Pass artifact_count and index when emitting events |
| `src/agent-loop/session.ts` | Modify | Emit agent_session_started; auto-discover project instructions |
| `src/agent-loop/provider-profiles.ts` | Modify | Add providerOptions() method |
| `src/agent-loop/tool-registry.ts` | Modify | Add unregister() method |
| `src/agent-loop/execution-environment.ts` | Modify | Implement real glob() and grep() |
| `src/agent-loop/environment-context.ts` | Modify | Include recent git commits |
| `src/llm/streaming.ts` | Modify | Make response required on stream_end |
| `src/llm/stream-accumulator.ts` | Modify | Build complete response for stream_end |
| `src/llm/types.ts` | Modify | Add Message.name, max_tool_rounds on GenerateRequest |
| `src/llm/client.ts` | Modify | Read max_tool_rounds; reject prompt+messages |
| `src/llm/adapters/anthropic.ts` | Modify | Accept auto_cache disable key |
| `src/llm/catalog.ts` | Modify | Flatten capabilities and cost naming |
| `test/server/pipeline-events.test.ts` | Verify | Should pass after SSE fix |
| `test/integration/http-server.test.ts` | Verify | Should pass after SSE + current_node fix |
| `test/server/gardens-draft.test.ts` | Verify | Should pass after draft SSE fix |
| `test/integration/hive-run-flow.test.ts` | Verify | Should pass after SSE fix |
| `test/integration/http-resume.test.ts` | Verify | Should pass after SSE fix |
| `test/integration/seed-run-linkage.test.ts` | Verify | Should pass after SSE fix |
| `test/interviewer/interviewer.test.ts` | Modify | Add AnswerValue assertions |
| `test/checkpoint/run-store.test.ts` | Modify | Assert logs field populated |
| `test/engine/engine.test.ts` | Modify | Assert artifact_count and index on events |
| `test/agent-loop/session.test.ts` | Modify | Assert agent_session_started emission; project instruction discovery |
| `test/agent-loop/tool-registry.test.ts` | Modify | Test unregister() |
| `test/agent-loop/execution-environment.test.ts` | Modify | Test real glob/grep |
| `test/agent-loop/environment-context.test.ts` | Modify | Assert recent commits in git snapshot |
| `test/llm/stream-accumulator.test.ts` | Modify | Assert response on stream_end |
| `test/llm/types.test.ts` | Modify | Assert Message.name field |
| `test/llm/client.test.ts` | Modify | Test max_tool_rounds; test prompt+messages rejection |
| `test/llm/adapters/anthropic.test.ts` | Modify | Test auto_cache disable |
| `test/llm/catalog.test.ts` | Create | Assert flattened ModelInfo field names |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `npm test` passes with 0 failures across all test files — no timeouts, no skips
- [ ] No test timeout values were increased to achieve green
- [ ] `/pipelines/:id/events` SSE stream closes automatically after terminal pipeline event
- [ ] `/gardens/draft` SSE stream closes automatically after `draft_complete` or `draft_error`
- [ ] `GET /pipelines/:id/context` returns `current_node` during active runs
- [ ] `Answer` type includes `AnswerValue` enum, `selected_option`, and `text` fields
- [ ] All 5 interviewer implementations produce correctly-typed `Answer` objects
- [ ] `Cocoon` type includes `logs: string[]` field, populated as nodes complete
- [ ] `RunCompletedEvent` includes `artifact_count`; `NodeStartedEvent` includes `index`
- [ ] `AgentSession` emits `agent_session_started` without relying on codergen handler
- [ ] `ProviderProfile` interface has `providerOptions()` method, implemented by all 3 profiles
- [ ] `ToolRegistry.unregister()` exists and works
- [ ] `LocalExecutionEnvironment.glob()` and `.grep()` return real results instead of throwing
- [ ] `submit()` auto-discovers and includes project instruction files
- [ ] `buildGitSnapshot()` includes last 10 commit messages
- [ ] `stream_end` event always carries a complete `GenerateResponse` (not optional)
- [ ] `Message` interface has optional `name` field
- [ ] `GenerateRequest` has `max_tool_rounds` field; `generate()` respects it
- [ ] `generate({ prompt, messages })` throws `InvalidRequestError`
- [ ] `provider_options.anthropic.auto_cache = false` disables prompt caching
- [ ] `ModelInfo` uses flat `supports_*` booleans and `input_cost_per_million`/`output_cost_per_million`
- [ ] Compliance report updated to show zero gaps

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE close-on-terminal has race condition — terminal event not flushed before `res.end()` | Medium | High | Use `process.nextTick()` or `setImmediate()` to schedule close after write. Test with real HTTP client, not mocks. |
| ModelInfo flatten (Gap 15) breaks internal consumers in non-obvious places | Medium | Medium | Grep for `capabilities.` and `cost.` across entire codebase before renaming. TypeScript compiler catches most breakage. Run full suite after. |
| `glob()` / `grep()` real implementations introduce new failure modes in agent sessions | Low | Medium | Delegate to the same libraries already used by the tool implementations. Match error handling patterns from tool code. |
| Auto-discovering project instructions in `submit()` adds latency to first LLM call | Low | Low | Cache discovery result on the session. File discovery is fast (< 50ms) and only runs once per session. |
| `max_tool_rounds` default change (10 → 1) breaks existing callers | Medium | Medium | Only apply spec default (1) when `max_tool_rounds` is explicitly set on `GenerateRequest`. Preserve existing `maxIterations` default (10) on the options path for backward compatibility. |
| SSE fix masks a deeper engine event ordering bug | Low | High | After fixing, add a test that asserts the exact event sequence for a 3-node pipeline: run_started → node_started(0) → node_completed → ... → run_completed → stream close. |

---

## Dependencies

No new dependencies. All changes use existing libraries and patterns:

| Dependency | Already in project | Used for |
|------------|-------------------|----------|
| `fast-glob` | Yes (via glob tool) | Gap 7 — real `glob()` on ExecutionEnvironment |
| `execa` | Yes | Gap 7 — `grep()` delegates to `rg` via exec |
| `vitest` | Yes | All new tests |

---

## Open Questions

| Question | Proposed Resolution |
|----------|-------------------|
| Should `max_tool_rounds` default to 1 (spec) or 10 (current) when set on GenerateRequest? | Default to 1 per spec. The GenerateOptions path keeps its default of 10 for backward compatibility. Document the difference. |
| Should ModelInfo rename be done in a single commit or phased? | Single commit. TypeScript will catch every reference. No external consumers to coordinate with. |
| Should `glob()`/`grep()` on ExecutionEnvironment match the tool's exact output format? | Match the interface contract types, not the tool's string formatting. The tools format for LLM consumption; the interface methods return structured data. |
