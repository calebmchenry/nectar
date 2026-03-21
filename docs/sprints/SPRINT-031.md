# Sprint 031: SSE Lifecycle Fix & Full Compliance Closure

## Overview

**Goal:** Fix the 6 failing tests (all SSE lifecycle bugs), close all 15 remaining compliance gaps, and ship a green, spec-complete engine. After this sprint: `npm test` is green, and a fresh compliance audit finds zero unimplemented requirements.

**Why this sprint, why now:**

1. **The test suite is red and has been red for multiple sprints.** 6 tests fail, all rooted in SSE streams that never close. Sprints 025–029 all declared "green suite" as a goal and failed to deliver. The SSE lifecycle bug is the single highest-priority defect because it blocks validation of every HTTP-facing feature and erodes trust in the entire test suite.

2. **The SSE bug is one root cause with wide blast radius.** All 6 failing tests share the same failure mode: SSE streams opened by test clients never receive a close signal after a terminal pipeline event. The fix is narrow — the SSE route handler must call `res.end()` after emitting the terminal event — but untested because the streams hang before assertions run. A secondary bug (`run_error` event emission) affects at least one of the 6 tests and is addressed separately.

3. **15 compliance gaps remain and they are all mechanical.** Analysis of the 15 gaps:
   - **3 Attractor gaps:** Answer model enrichment (1), checkpoint `logs` field (2), event payload fields (3). All additive.
   - **6 Agent loop gaps:** Session event emission (4), provider_options (5), unregister (6), glob/grep on ExecutionEnvironment (7), auto-discover project instructions (8), git commit messages (9). All isolated, no cross-cutting changes.
   - **6 Unified LLM gaps:** stream_end response (10), Message.name (11), max_tool_rounds (12), prompt+messages rejection (13), cache disable key (14), ModelInfo naming (15). Most are one-line fixes or renames.

4. **No gap requires new architecture.** Every gap maps to a specific file and a specific spec section. The longest single task is ~2 hours (Answer model enrichment touches 5 interviewer implementations). The rest are 15–60 minutes each.

5. **This is the last sprint before new features can land cleanly.** The INTENT.md §5.1 hard gate — "zero unimplemented features" — cannot be met until these 15 gaps close. Every feature sprint built on a non-compliant engine risks rework.

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

3. **A browser human gate captures a real answer, not just a label.** The interviewer stack stores and returns the canonical spec-rich answer shape. Legacy label-only inputs are accepted at the boundary and normalized immediately. FREEFORM answers carry text explicitly instead of being squeezed through a fake choice label.

4. **A resumed run is inspectable without spelunking the filesystem.** The cocoon includes the log files produced so far, `node_started` events expose a stable ordinal index, and the final `run_completed` event reports artifact count.

5. **A direct `AgentSession` consumer gets the same behavior codergen gets.** Calling `submit()` on an `AgentSession` emits `agent_session_started`, auto-loads project instructions, includes recent commit messages in git context, and can rely on `glob()` / `grep()` in the execution environment.

6. **Streaming consumers get complete lifecycle events.** `stream()` emits `text_start` → `content_delta`* → `text_end` and `tool_call_start` → `tool_call_delta`* → `tool_call_end`. The final `stream_end` always carries a fully assembled `GenerateResponse`.

7. **Catalog consumers can depend on stable spec names.** UI, CLI, and runtime code can read spec-shaped model capability and cost fields without reverse-engineering the current nested `capabilities` / `cost` structure.

8. **Compliance audit returns zero gaps.** An agent reading the three pinned spec documents and diffing against the codebase finds no unimplemented requirements.

---

## Architecture

### No new architecture — two focused workstreams

**Workstream A: SSE Lifecycle Fix.** The SSE event stream routes (`/pipelines/:id/events` and `/gardens/draft`) must detect terminal events and call `res.end()`. The engine already emits terminal events correctly; the HTTP layer fails to act on them.

**Workstream B: Compliance Gap Closure.** 15 independent, well-scoped changes across three spec boundaries.

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

2. **Canonical answer shape with compatibility normalization.** The interviewer stack adopts the spec-rich answer model as the canonical in-memory and persisted shape. Legacy `selected_label`-only inputs are accepted at the boundary and normalized immediately. `selected_label` and `source` remain for backward compatibility. New fields (`answer_value`, `selected_option`, `text`) are added alongside. `wait.human` keeps routing by normalized selected option when one exists.

3. **`AgentSession` becomes the source of truth for session lifecycle.** `agent_session_started` is emitted by `AgentSession` itself exactly once per session. `CodergenHandler` should bridge the real session event instead of synthesizing a duplicate.

4. **Search behavior lives below the tool layer.** Extract shared search helpers used by both `LocalExecutionEnvironment.glob()`/`.grep()` and the existing glob/grep tools. One ignore-ordering/matching implementation instead of two drifting ones.

5. **`submit()` becomes the spec-complete entrypoint.** Auto-discover project instructions when no explicit instructions were provided. Respect the 32KB context budget from the spec. Cache discovery result for the session lifetime.

6. **`max_tool_rounds` defaults resolved.** `GenerateRequest.max_tool_rounds` defaults to 1 per spec. `GenerateOptions.maxIterations` remains as a deprecated alias for one sprint with its default of 10. The request field wins when both are set.

7. **Model catalog migration uses one-sprint compatibility aliases.** Expose spec-named flat fields on `ModelInfo`. Keep the current nested `capabilities` / `cost` shape as derived compatibility aliases for this sprint only. Convert internal callers to the new names.

8. **`stream_end` must always be final and self-sufficient.** `StreamAccumulator` is the canonical assembly point. If a stream ends prematurely due to error, emit an `error` event instead of a malformed `stream_end`.

9. **Cocoon `logs` are portable.** Store log paths as run-relative paths, not absolute machine-specific paths. Default to `[]` when loading checkpoints that predate the field.

---

## Implementation

### Phase 1a: SSE Lifecycle Fix (25% of effort)

**Priority:** This phase must complete first. No compliance work ships until the suite is green.

**Tasks:**

- [ ] **Identify terminal events.** Pipeline SSE: `run_completed`, `pipeline_failed`, `run_interrupted`, `run_error`. Gardens draft SSE: `draft_complete`, `draft_error`.

- [ ] **Add close-on-terminal logic to pipeline SSE route.** After writing a terminal event to the SSE stream, schedule `res.end()` on next tick (to ensure the terminal event is flushed). Remove the event listener on close to prevent leaks.

- [ ] **Add close-on-terminal logic to gardens draft SSE route.** Same pattern: write terminal event, then `res.end()` on next tick.

- [ ] **Handle client disconnect.** On `req.on('close')`, remove the event listener and clean up. Ensures tests using ephemeral ports and proper cleanup don't race.

### Phase 1b: Ancillary Test Fixes (10% of effort)

**Separated from SSE fix to avoid blocking compliance work on unrelated bugs.**

- [ ] **Fix `current_node` in context endpoint.** `GET /pipelines/:id/context` should read `current_node` from the engine's live state or checkpoint.

- [ ] **Fix `run_error` event emission.** Verify the engine emits `run_error` when a node fails without a failure edge, and that the SSE route forwards it. This is a separate root cause from the SSE lifecycle issue.

- [ ] **Run full test suite.** All test files must pass. Zero failures. Zero timeout-induced skips.

**Tests fixed:** `test/server/pipeline-events.test.ts`, `test/integration/http-server.test.ts`, `test/server/gardens-draft.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/seed-run-linkage.test.ts`.

**Phase gate:** `npm test` — 0 failures.

### Phase 2: Attractor Spec Gaps (15% of effort)

**Gaps closed: 1, 2, 3**

- [ ] **Gap 1 — Answer model enrichment.** In `src/interviewer/types.ts`:
  - Add `AnswerValue` enum: `YES`, `NO`, `SKIPPED`, `TIMEOUT`.
  - Add `answer_value?: AnswerValue`, `selected_option?: number`, and `text?: string` to `Answer`.
  - Keep existing `selected_label` and `source` fields as a compatibility path.
  - Update all 5 interviewer implementations to produce canonical answers:
    - `AutoApproveInterviewer`: set `answer_value` based on default choice matching YES/NO patterns.
    - `ConsoleInterviewer`: set `answer_value` from user input; set `text` for freeform responses.
    - `CallbackInterviewer`: pass through `answer_value` from callback.
    - `QueueInterviewer`: exhausted → `AnswerValue.SKIPPED`.
    - `RecordingInterviewer`: record new fields.
  - Tests: assert `answer_value` and `selected_option` present on answers from each implementation.

- [ ] **Gap 2 — Checkpoint `logs` field.** Add `logs: string[]` to `Cocoon` in `src/checkpoint/types.ts`. In `src/checkpoint/run-store.ts`, append log paths (run-relative, not absolute) as nodes complete. Initialize as empty array on new runs. Default to `[]` when deserializing old checkpoints that lack the field. Test: checkpoint after two nodes has two log paths.

- [ ] **Gap 3 — Event payload enrichment.** In `src/engine/events.ts`:
  - Add `artifact_count: number` to `RunCompletedEvent`. Compute from tracked artifact state, not a late filesystem walk.
  - Add `index: number` to `NodeStartedEvent`. Track as 1-based execution ordinal (increment counter per node_started, including retries).
  - In `src/engine/engine.ts`, pass these values when emitting events.
  - Tests: assert `artifact_count` on run_completed, `index` on node_started.

### Phase 3: Coding Agent Loop Gaps (25% of effort)

**Gaps closed: 4, 5, 6, 7, 8, 9**

- [ ] **Gap 4 — `agent_session_started` from session.** Emit `agent_session_started` from `AgentSession` itself exactly once per session. Remove synthetic emission from `CodergenHandler`; bridge the real session event instead. Test: direct `AgentSession` consumer receives `agent_session_started`; exactly one event per session even through codergen.

- [ ] **Gap 5 — `provider_options()` on ProviderProfile.** In `src/agent-loop/provider-profiles.ts`:
  - Add `providerOptions(): Record<string, unknown>` to the `ProviderProfile` interface.
  - `AnthropicProfile`: return Anthropic beta headers.
  - `OpenAIProfile`: return reasoning settings or empty object.
  - `GeminiProfile`: return default safety settings.
  - Session merges profile `providerOptions()` with per-request overrides before LLM calls.
  - Test: each profile returns provider-specific options; session passes them to client.stream().

- [ ] **Gap 6 — `ToolRegistry.unregister()`.** Add `unregister(name: string): boolean` that deletes from the internal map and returns whether it existed. Test: register, unregister, verify `definitions()` no longer includes it. Cover missing-tool case.

- [ ] **Gap 7 — Real `glob()` and `grep()` on LocalExecutionEnvironment.**
  - Extract shared search helpers into `src/agent-loop/search.ts` reusing the existing logic from `src/agent-loop/tools/glob.ts` and `src/agent-loop/tools/grep.ts`.
  - `LocalExecutionEnvironment.glob()` and `.grep()` delegate to the shared helpers.
  - Update the glob/grep tools to also use the shared helpers so behavior stays aligned.
  - Remove the `throw 'Use the glob/grep tool instead'` stubs.
  - Use safe API wrappers (native `fs` traversing or strictly escaped `execa` arguments) to prevent shell injection.
  - Handle missing `rg` binary gracefully: fall back to Node.js `fs.readFileSync` + regex matching, or throw a clear error with install instructions.
  - Test: glob matches files in a temp directory; grep finds content in a temp file.

- [ ] **Gap 8 — Auto-discover project instructions in `submit()`.** When `submit()` is called and no explicit instructions were provided, call `discoverInstructions()` and prepend results to the system prompt. Respect the 32KB context budget from the spec — truncate or omit if files are too large. Handle non-UTF-8 or binary files gracefully. Cache the result for the session lifetime. Test: submit in a directory with AGENTS.md includes its content.

- [ ] **Gap 9 — Git context includes recent commits.** Extend `buildGitSnapshot()` to run `git log --oneline -5` and include the output as `recent_commits`. Handle empty repos (0 commits) gracefully — omit the field rather than error. Truncate individual commit messages to prevent context bloat. Keep existing timeout behavior and fail open if git is unavailable. Test: git snapshot in a git repo includes recent commit lines.

### Phase 4: Unified LLM Spec Gaps (20% of effort)

**Gaps closed: 10, 11, 12, 13, 14, 15**

- [ ] **Gap 10 — `stream_end` carries complete response.** Make `response` required on `StreamEndEvent` in `src/llm/streaming.ts`. `StreamAccumulator` is the canonical assembler — ensure `response()` and `stream_end` cannot disagree. If a stream ends prematurely due to error, emit an `error` event rather than a malformed `stream_end`. Update all three adapters to build the complete response before emitting `stream_end`. Test: `stream_end` event has `response` with usage, stop_reason, and message.

- [ ] **Gap 11 — `Message.name` field.** Add `name?: string` to `Message` in `src/llm/types.ts`. Update `Message.tool_result()` factory to accept optional `name`. Sanitize `name` to match provider regex constraints (e.g., OpenAI requires `^[a-zA-Z0-9_-]+$`). Thread through all adapter stacks. Test: message with `name` round-trips through adapters.

- [ ] **Gap 12 — `max_tool_rounds` on GenerateRequest.** Add `max_tool_rounds?: number` to `GenerateRequest` (default 1 per spec). In `src/llm/client.ts`, `GenerateRequest.max_tool_rounds` is authoritative; deprecated `GenerateOptions.maxIterations` remains as alias for one sprint. Clarify `max_tool_rounds: 0` means "no tool calls allowed." Test: `generate()` with `max_tool_rounds: 2` executes up to 2 tool rounds.

- [ ] **Gap 13 — Reject prompt + messages.** In `src/llm/client.ts` `normalizePromptRequest()`, throw `InvalidRequestError` when both `prompt` and `messages` are provided. Test: calling `generate({ prompt: '...', messages: [...] })` throws.

- [ ] **Gap 14 — Prompt caching disable key.** In `src/llm/adapters/anthropic.ts`, check `provider_options.anthropic.auto_cache === false` (spec key, takes precedence). Keep accepting `provider_options.anthropic.cache_control === false` as a compatibility alias for one sprint. Test: `{ anthropic: { auto_cache: false } }` disables cache_control injection.

- [ ] **Gap 15 — ModelInfo capability naming.** In `src/llm/catalog.ts`:
  - Flatten capabilities: `supports_tools`, `supports_vision`, `supports_reasoning`, `supports_streaming`, `supports_structured_output`.
  - Flatten cost: `input_cost_per_million`, `output_cost_per_million`.
  - Keep nested `capabilities` / `cost` as derived compatibility aliases for this sprint only.
  - Grep internal callers and convert to spec-named flat fields. Use a two-commit approach: (1) add new names as aliases, (2) migrate callers and remove old names.
  - Test: `getModelInfo('claude-opus-4-20250514').supports_tools === true`.

### Phase 5: Verification and Compliance Report Refresh (5%)

- [ ] `npm run build` — zero TypeScript errors
- [ ] `npm test` — zero failures, zero timeout-induced skips
- [ ] Update `docs/compliance-report.md` so all 15 gaps move from GAPS to IMPLEMENTED
- [ ] Manually diff updated codebase against gap list — confirm zero remaining drift
- [ ] Add event-sequence integration test: `run_started → node_started(0) → node_completed → ... → run_completed → SSE close`

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/routes/pipelines.ts` | Modify | Close SSE stream on terminal events; fix current_node |
| `src/server/routes/gardens.ts` | Modify | Close SSE stream on draft terminal events |
| `src/interviewer/types.ts` | Modify | Add AnswerValue enum, enrich Answer type |
| `src/interviewer/auto-approve.ts` | Modify | Produce enriched Answer |
| `src/interviewer/console.ts` | Modify | Produce enriched Answer with freeform text |
| `src/interviewer/callback.ts` | Modify | Pass through enriched Answer |
| `src/interviewer/queue.ts` | Modify | Use AnswerValue.SKIPPED on exhaustion |
| `src/interviewer/recording.ts` | Modify | Record enriched Answer fields |
| `src/checkpoint/types.ts` | Modify | Add `logs: string[]` to Cocoon |
| `src/checkpoint/run-store.ts` | Modify | Populate logs with run-relative paths |
| `src/engine/events.ts` | Modify | Add artifact_count to RunCompletedEvent, index to NodeStartedEvent |
| `src/engine/engine.ts` | Modify | Pass artifact_count and index when emitting |
| `src/agent-loop/session.ts` | Modify | Emit agent_session_started; auto-discover instructions; merge provider options |
| `src/handlers/codergen.ts` | Modify | Bridge real session event instead of synthesizing |
| `src/agent-loop/provider-profiles.ts` | Modify | Add providerOptions() method |
| `src/agent-loop/tool-registry.ts` | Modify | Add unregister() method |
| `src/agent-loop/search.ts` | Create | Shared ignore-aware search helpers |
| `src/agent-loop/execution-environment.ts` | Modify | Implement real glob() and grep() via shared helpers |
| `src/agent-loop/tools/glob.ts` | Modify | Reuse shared search helpers |
| `src/agent-loop/tools/grep.ts` | Modify | Reuse shared search helpers |
| `src/agent-loop/environment-context.ts` | Modify | Include recent git commits |
| `src/llm/streaming.ts` | Modify | Make response required on stream_end |
| `src/llm/stream-accumulator.ts` | Modify | Canonical response assembly for stream_end |
| `src/llm/types.ts` | Modify | Add Message.name, max_tool_rounds on GenerateRequest |
| `src/llm/client.ts` | Modify | Read max_tool_rounds; reject prompt+messages |
| `src/llm/adapters/anthropic.ts` | Modify | Accept auto_cache disable key |
| `src/llm/adapters/openai.ts` | Modify | Thread Message.name, consistent stream contract |
| `src/llm/adapters/gemini.ts` | Modify | Thread Message.name, consistent stream contract |
| `src/llm/catalog.ts` | Modify | Flatten capabilities and cost naming with compat aliases |
| `docs/compliance-report.md` | Modify | Record zero remaining gaps |
| Tests (verify) | — | `test/server/pipeline-events.test.ts`, `test/integration/http-server.test.ts`, `test/server/gardens-draft.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/seed-run-linkage.test.ts` |
| Tests (modify) | — | `test/interviewer/interviewer.test.ts`, `test/checkpoint/run-store.test.ts`, `test/engine/engine.test.ts`, `test/agent-loop/session.test.ts`, `test/agent-loop/events.test.ts`, `test/agent-loop/provider-profiles.test.ts`, `test/agent-loop/tool-registry.test.ts`, `test/agent-loop/execution-environment-scoped.test.ts`, `test/agent-loop/environment-context.test.ts`, `test/agent-loop/tools/glob.test.ts`, `test/agent-loop/tools/grep.test.ts`, `test/handlers/codergen.test.ts`, `test/llm/stream-accumulator.test.ts`, `test/llm/client.test.ts`, `test/llm/types.test.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/gemini.test.ts`, `test/llm/catalog.test.ts` |

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
- [ ] Legacy label-only inputs are accepted and normalized at the boundary
- [ ] `Cocoon` type includes `logs: string[]` field (run-relative paths), populated as nodes complete
- [ ] Old checkpoints without `logs` load successfully (default to `[]`)
- [ ] `RunCompletedEvent` includes `artifact_count`; `NodeStartedEvent` includes `index`
- [ ] `AgentSession` emits `agent_session_started` without relying on codergen handler
- [ ] Exactly one session-start event per session, even when codergen is involved
- [ ] `ProviderProfile` interface has `providerOptions()` method, implemented by all 3 profiles
- [ ] `ToolRegistry.unregister()` exists and works
- [ ] `LocalExecutionEnvironment.glob()` and `.grep()` return real results via shared helpers
- [ ] Existing glob/grep tools also use the shared helpers
- [ ] `submit()` auto-discovers and includes project instruction files (respecting 32KB budget)
- [ ] `buildGitSnapshot()` includes last 5 commit messages
- [ ] `stream_end` event always carries a complete `GenerateResponse` (not optional)
- [ ] Premature stream termination emits `error` event, not malformed `stream_end`
- [ ] `Message` interface has optional `name` field, sanitized for provider constraints
- [ ] `GenerateRequest` has `max_tool_rounds` field (default 1); `generate()` respects it
- [ ] `GenerateOptions.maxIterations` remains as deprecated alias for one sprint
- [ ] `generate({ prompt, messages })` throws `InvalidRequestError`
- [ ] `provider_options.anthropic.auto_cache = false` disables prompt caching
- [ ] Legacy `provider_options.anthropic.cache_control = false` still works as alias
- [ ] `ModelInfo` uses flat `supports_*` booleans and `input_cost_per_million`/`output_cost_per_million`
- [ ] Nested `capabilities`/`cost` remain as compatibility aliases for this sprint
- [ ] Internal callers migrated to spec-named flat fields
- [ ] Compliance report updated to show zero gaps

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE close-on-terminal has race condition — terminal event not flushed before `res.end()` | Medium | High | Use `process.nextTick()` or `setImmediate()` to schedule close after write. Network buffering may still truncate — test with real HTTP client, not mocks. |
| `run_error` emission is a separate root cause from SSE lifecycle | Medium | Medium | Separated into Phase 1b so SSE fix is not blocked. Investigate whether `run_error` is a distinct event type, alias, or test bug. |
| Answer-model migration breaks HTTP human-gate API | Medium | High | Normalize legacy `selected_label` inputs at boundary. Keep POST compatibility. Add explicit compatibility tests. |
| Moving `agent_session_started` into `AgentSession` creates duplicate events | Medium | High | Make `AgentSession` the only emitter. Convert codergen to bridge. Add exact-once assertion. |
| Shared search helper extraction regresses glob/grep tool behavior | Medium | Medium | Extract existing logic rather than rewriting. Run tool tests before and after extraction. |
| Shell injection via `glob()`/`grep()` with untrusted patterns | Low | High | Use safe API wrappers — native `fs` traversing or strictly escaped `execa` arguments. Never pass raw patterns to shell. |
| `glob()`/`grep()` fail when `rg` is unavailable (CI, containers) | Low | Medium | Fall back to Node.js `fs.readFileSync` + regex matching, or throw clear error. |
| Auto-discovering instructions inflates context window | Medium | Medium | Respect spec 32KB budget. Truncate or omit if files are too large. Handle non-UTF-8 gracefully. |
| Git snapshot errors on empty repos or non-git directories | Low | Low | Fail open. Omit `recent_commits` field rather than erroring. Truncate individual commit messages. |
| ModelInfo flatten breaks internal consumers | Medium | Medium | Two-commit approach: add aliases first, migrate callers, then remove old shape. TypeScript compiler catches breakage. |
| `max_tool_rounds` default change (10 → 1) breaks callers | Medium | Medium | Only apply spec default on `GenerateRequest`. Preserve `maxIterations` default (10) on options path. Request field wins. |
| `stream_end` required `response` breaks error states | Medium | Medium | Premature stream termination emits `error` event, not `stream_end`. `StreamAccumulator` is canonical assembler. |
| `Message.name` validation across providers | Low | Low | Sanitize to `^[a-zA-Z0-9_-]+$` before passing to adapters. |
| Checkpoint deserialization breaks on old cocoons without `logs` | Low | Medium | Default to `[]` when field is absent during deserialization. |
| SSE test isolation — port conflicts between parallel test runs | Low | Medium | Ensure tests use ephemeral ports and proper cleanup. |

---

## Dependencies

No new external dependencies. All changes use existing libraries and patterns:

| Dependency | Already in project | Used for |
|------------|-------------------|----------|
| `fast-glob` | Yes (via glob tool) | Gap 7 — shared search helpers |
| `execa` | Yes | Gap 7 — grep fallback, git snapshot |
| `ignore` | Yes | Gap 7 — .gitignore-aware filesystem matching |
| `vitest` | Yes | All new tests |
