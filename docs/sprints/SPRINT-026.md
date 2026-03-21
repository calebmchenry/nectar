# Sprint 026: Kill the Red Suite, Fix the Engine Contract

## Overview

**Goal:** Make `npm test` green, then fix the 5 correctness bugs that make Nectar untrustworthy at runtime. After this sprint: zero test failures, the engine retries and routes failures correctly, loop detection steers instead of killing, images work across providers, and Gemini tool calls don't collide.

**Why this sprint, why now:**

1. **Four sprints have promised green tests and failed to deliver.** Sprints 022–025 all declared test fixes non-negotiable, then shipped feature work on top of a red suite. The problem is scope: each sprint coupled test fixes with 8–12 other deliverables, then ran out of time on the hard debugging work. This sprint cuts scope brutally. The red suite dies first, and the remaining work is 5 focused correctness fixes — not 12.

2. **The 4 failing tests are 3 bugs, not 4.** `pipeline-events` fails because `PipelineFailedEvent` is never emitted — a missing code path in `engine.ts`. The other three (`gardens-draft`, `hive-run-flow`, `seed-run-linkage`) share one root cause: SSE response handlers that don't reliably call `res.end()` when the underlying async operation completes or errors. Fix 2 bugs, 4 tests pass.

3. **Five compliance gaps are runtime-correctness bugs, not spec-conformance nits.** These are things that silently produce wrong results today:
   - **GAP-A1:** A handler returns `failure` with `max_retries=3`. The engine does not retry. The pipeline dies.
   - **GAP-A3:** A node exhausts retries. The spec says to check retry_target, then fallback_retry_target, then graph defaults. The engine skips all of that and terminates.
   - **GAP-C1:** An agent loops. The spec says to inject a steering message. The implementation kills the session immediately.
   - **GAP-U1:** A prompt includes an image. OpenAI drops it silently. Anthropic fails on URLs. The model never sees it.
   - **GAP-U8:** Gemini calls `grep` twice in one response. Both calls share the function name as ID. The second result overwrites the first. Silent data loss.

4. **Everything else can wait.** StopReason renaming (GAP-U2), model catalog updates (GAP-U3), ExecutionEnvironment abstraction (GAP-C8), session state transitions (GAP-C3/C4), codergen label fallback (GAP-A4) — these are all real gaps, but none produce wrong results at runtime. A sprint that fixes 5 real bugs and ships green tests is worth more than a sprint that attempts 12 fixes and leaves 4 tests red again.

**Gaps closed (5 + 4 test failures):**

| Gap | Spec Section | What's Actually Broken |
|-----|-------------|----------------------|
| 4 test failures | validation-report | CI is not trustworthy; failures persist since Sprint 022 |
| GAP-A1 | attractor §3.5 | Engine ignores max_retries when status is `failure` |
| GAP-A3 | attractor §3.7 | Failure routing chain only fires at exit-time goal gates |
| GAP-C1 | agent-loop §2.5 | Loop detection terminates session instead of steering |
| GAP-U1 | unified-llm §7.3 | Image input broken across all 3 providers |
| GAP-U8 | unified-llm §7.3 | Gemini tool call ID collisions cause silent data loss |

**Nothing is cuttable.** This is already the minimum viable correctness sprint. If any single item compresses out, the sprint loses its thesis. If the test fixes alone consume the sprint, that is a valid outcome — the green suite is more valuable than any gap closure.

**Out of scope:**

- StopReason provider-agnostic rename (GAP-U2) — behavioral workaround exists; consumers check specific values
- Model catalog update (GAP-U3) — existing models work, new ones are additive
- Codergen label fallback (GAP-A4) — convenience, not a correctness bug
- Session state transitions (GAP-C3, GAP-C4) — steer() queuing and IDLE resting state are polish
- ExecutionEnvironment grep/glob (GAP-C8) — abstraction refactor, no one swaps environments today
- Truncation algorithm changes (GAP-C5) — 80/20 vs 50/50 is a preference, not a bug
- Retry defaults (GAP-U11) — current values work
- Upstream manifest.json — useful bookkeeping, not a runtime fix
- All low-priority gaps, new CLI commands, Hive UI features, or product-facing work

---

## Use Cases

1. **A contributor opens a PR.** CI runs `npm test`. It passes. The contributor knows any failure is their regression, not inherited debt. This has not been true since Sprint 021.

2. **A codergen node calls an LLM that returns garbage.** The handler returns `{ status: 'failure' }`. The engine sees `max_retries=2` on the node, retries twice with exponential backoff. The second attempt succeeds and the pipeline continues. Today: the node fails permanently regardless of retry config.

3. **A tool node exhausts its retries.** The engine checks: (a) outgoing edges with `condition="outcome=failure"` — one matches, engine follows it to a recovery node. Or: (b) no fail-edges match, but `retry_target=plan` — engine jumps to `plan` and re-executes from there. Today: the pipeline terminates unconditionally.

4. **An agent enters a grep loop.** It runs the same grep command 4 times. Loop detection fires. A developer-role message is injected: "You appear to be repeating the same actions. Try a different approach." The model adjusts. Today: the session crashes with `{ status: 'failure' }`.

5. **A pipeline node analyzes a screenshot.** The prompt includes a base64 image and a URL-referenced diagram. Whether the backend is OpenAI, Anthropic, or Gemini, the adapter converts the image to the provider's native format and the LLM receives it. Today: OpenAI drops images, Anthropic rejects URLs.

6. **A Gemini-backed agent calls `grep` and `read_file` in one response.** Each tool call gets a unique synthetic ID. Tool results route back to the correct calls. Today: if two `grep` calls happen, they share an ID and results collide.

---

## Architecture

### Root Cause Analysis: The Test Failures

The 4 failing tests reduce to 2 root causes:

**Root Cause 1 — Missing `PipelineFailedEvent` emission (`pipeline-events` test):**

The engine's failure path in `engine.ts` emits `RunErrorEvent` on unhandled exceptions but has no code path for the scenario: node fails → retries exhausted → no failure edge exists → pipeline must terminate. The spec requires: `NodeCompletedEvent(failure)` → `PipelineFailedEvent` → `RunErrorEvent`. `PipelineFailedEvent` is defined in `events.ts` but never emitted by the engine. Fix: add emission at the retry-exhaustion termination point.

This overlaps with GAP-A3 — the same code path that needs to emit `PipelineFailedEvent` is the same code path that needs to implement the failure routing chain. Both are a restructure of `engine.ts`'s post-failure logic.

**Root Cause 2 — SSE streams that never close (`gardens-draft`, `hive-run-flow`, `seed-run-linkage` tests):**

All three tests time out waiting for an SSE stream to end. The server-side pattern: the route handler opens an SSE connection, starts an async operation, and pipes events. When the operation completes or errors, the handler must call `res.end()`. The current code either: (a) registers the completion listener after starting the operation (race condition — completion fires before listener is attached), or (b) has no error-path cleanup (operation throws, SSE stream hangs forever).

Fix: establish a single pattern across all SSE routes — register listeners before starting operations, use `try/finally` to guarantee `res.end()`, add `req.on('close')` cleanup for client disconnects.

### Centralized Failure Resolution in the Engine (GAP-A1, GAP-A3)

**Current state:** `engine.ts` only retries when `outcome.status === 'retry'`. Failure routing (retry_target → fallback → graph-level) only runs in exit-handler goal-gate enforcement.

**Change:** Introduce one explicit failure-resolution path with one question per step:

1. Did the node return `failure` or throw an exception?
2. Is there retry budget remaining? If yes, retry (with exponential backoff).
3. Are there outgoing edges matching `condition="outcome=failure"` or `condition="outcome=fail"`? → select via edge selector.
4. Does the node have a `retry_target` attribute? → jump to that node.
5. Does the node have a `fallback_retry_target`? → jump.
6. Does the graph have `retry_target` / `fallback_retry_target`? → jump.
7. None found → emit `PipelineFailedEvent` → terminate pipeline.

Two design rules:

- **Retry happens before routing, but only until budget is exhausted.** Failure edges are post-retry routing, not a replacement for retries.
- **Run status is not inferred from the last node shape.** Reaching `Msquare` through a failure path must not erase the failed terminal state.

This function replaces the duplicated goal-gate logic. The exit handler's goal-gate path calls the same function, just with different triggering conditions.

### Loop Detection Steering (GAP-C1)

**Current state:** `session.ts` returns `{ status: 'failure' }` on loop detection, killing the session.

**Change:** On first loop detection trigger, inject a developer-role steering message: *"Loop detected: you have repeated the same tool call pattern N times. Try a different approach — use different parameters, a different tool, or reconsider the problem."* Reset the detection window and continue the agentic loop. Add a counter: if loop detection fires 3 times in the same session, then terminate with failure. This prevents infinite steering cycles while giving the model a real chance to recover.

The warning path and any future manual steering path should use the same queue and delivery mechanism so ordering stays deterministic.

### Image Input Normalization (GAP-U1)

Add one normalization layer that resolves image inputs into a canonical form before adapter translation:

- Local file path → MIME detection + base64 encoding (with file-exists and size checks)
- Image URL → provider-native URL form when supported
- Base64 image → pass through with validated media type

Then provider-specific translation at the adapter boundary:

- **OpenAI (`openai.ts`):** Map URL images to `{ type: "input_image", image_url: url }` and base64 to `{ type: "input_image", source: { type: "base64", media_type, data } }`. Remove the skip/warn code path that currently drops image parts.
- **Anthropic (`anthropic.ts`):** Keep existing base64 path. Add URL support via `source: { type: "url", url: imageUrl }`.
- **Gemini (`gemini.ts`):** Use `inlineData: { mimeType, data }` for base64 images. Use `fileData: { mimeType, fileUri }` for URL images.

### Gemini Tool Call IDs (GAP-U8)

**Current state:** `gemini.ts` uses the function name as the tool call ID. When a response contains two calls to `grep`, both get ID `grep`, and the second result overwrites the first.

**Change:** Generate synthetic unique IDs using an incrementing counter per response: `call_0`, `call_1`, `call_2`, etc. Maintain an `idToName` map so tool results route back to the correct function name. IDs are scoped per-response and never reused across responses.

---

## Implementation

### Phase 1: Green Suite (~40% of sprint)

**Hard gate: Phase 2 does not begin until `npm test` reports zero failures.**

This phase gets 40% of the sprint budget. Previous sprints underbudgeted debugging time and it showed. The approach is diagnosis-first: instrument the failing code path, reproduce the failure with added logging, identify the exact root cause, then write the minimal fix.

**Files:** `src/engine/engine.ts`, `src/server/routes/pipelines.ts`, `src/server/routes/gardens.ts`, `src/server/routes/seeds.ts`, `src/runtime/garden-draft-service.ts`, `src/runtime/pipeline-service.ts`

**Tasks:**

- [ ] Add instrumentation logging to `engine.ts` finalization path — trace every event emission after node failure
- [ ] Identify the exact point where `PipelineFailedEvent` should emit (between `NodeCompletedEvent(failure)` and `RunErrorEvent`)
- [ ] Add `PipelineFailedEvent` emission in the engine's retry-exhaustion termination path
- [ ] Run `pipeline-events` test in isolation — confirm it passes
- [ ] Audit every SSE route handler in `src/server/routes/` for the listener-before-start pattern
- [ ] Fix `gardens.ts` SSE route: register completion listener before starting draft generation, add `try/finally` with `res.end()`
- [ ] Fix `pipelines.ts` SSE route: same pattern — listener before start, guaranteed `res.end()` on completion, error, and client disconnect
- [ ] Fix `seeds.ts` route: identify the async lifecycle that hangs and apply the same SSE cleanup pattern
- [ ] Add `req.on('close', ...)` handlers to all SSE routes for client disconnect cleanup
- [ ] Run each failing test in isolation — confirm each passes
- [ ] Run full `npm test` — confirm zero failures
- [ ] Add a comment at each fix site explaining the root cause

### Phase 2: Engine Retry & Failure Routing (~25%)

**Files:** `src/engine/engine.ts`, `src/engine/retry.ts`, `src/engine/types.ts`, `test/engine/retry.test.ts`, `test/integration/conditions.test.ts`, `test/fixtures/retry-failure-routing.dot`

**Tasks:**

- [ ] Modify the retry decision in `engine.ts`: treat `failure` outcomes and handler exceptions as retry-eligible when retry budget remains (GAP-A1)
- [ ] Extract `resolveFailureTarget(node, graph, context, edgeSelector)` as a standalone function
- [ ] Implement the 7-step failure resolution chain in `resolveFailureTarget()`:
  1. Check outgoing edges with failure conditions → select via edge selector
  2. Check node `retry_target` → return target node ID
  3. Check node `fallback_retry_target` → return target node ID
  4. Check graph-level `retry_target` / `fallback_retry_target` → return target node ID
  5. Return null (caller emits `PipelineFailedEvent` and terminates)
- [ ] Wire `resolveFailureTarget()` into the main engine loop at the retry-exhaustion point
- [ ] Replace the exit handler's goal-gate routing with a call to `resolveFailureTarget()` (no duplication)
- [ ] Track terminal run status independently from the physical exit node so cleanup-to-exit paths do not erase failure
- [ ] Create `test/fixtures/retry-failure-routing.dot` — a pipeline with: node A (fails, max_retries=1) → retry_target=B → node B → exit
- [ ] Unit test: `failure` status + `max_retries=2` → engine retries 2 times then routes via failure chain
- [ ] Unit test: `failure` status + `max_retries=0` → engine goes straight to failure routing, no retry
- [ ] Unit test: failure routing selects fail-condition edge when one matches
- [ ] Unit test: failure routing falls through to node `retry_target` when no fail-edge
- [ ] Unit test: failure routing falls through to graph-level `fallback_retry_target` when node has no targets
- [ ] Unit test: failure routing emits `PipelineFailedEvent` when no target exists at any level
- [ ] Unit test: failure path through cleanup to `Msquare` still ends run as `failed`
- [ ] Integration test: run `retry-failure-routing.dot` end-to-end — verify retry + routing behavior
- [ ] Run `npm test` — confirm zero regressions

### Phase 3: Loop Detection Steering (~10%)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/loop-detection.ts`, `test/agent-loop/loop-detection.test.ts`

**Tasks:**

- [ ] Replace the `return { status: 'failure' }` at the loop detection site in `session.ts` with:
  1. Inject a developer-role message with spec-defined warning text
  2. Reset the loop detection fingerprint window
  3. Increment a per-session `loopSteeringCount` counter
  4. If `loopSteeringCount >= 3`, then terminate with `{ status: 'failure', error_message: 'Loop detected 3 times after steering attempts' }`
  5. Otherwise, continue the agentic loop
- [ ] Emit `AgentLoopDetectedRunEvent` before injecting the steering message (event should fire regardless of whether we steer or terminate)
- [ ] Unit test: first loop detection injects steering message and loop continues
- [ ] Unit test: agent recovers after steering — loop detection resets, different tool calls succeed
- [ ] Unit test: 3 consecutive loop detections → session terminates with failure
- [ ] Run `npm test` — confirm zero regressions

### Phase 4: Provider Image Handling & Gemini Tool IDs (~25%)

**Files:** `src/llm/types.ts`, `src/llm/client.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/gemini.test.ts`

**Tasks:**

- [ ] Add a request-normalization path for image inputs: local file paths → MIME detection + base64 encoding, URLs → pass through, base64 → validate media type
- [ ] **OpenAI:** Add image ContentPart handling in the request builder:
  - URL images → `{ type: "input_image", image_url: url }`
  - Base64 images → `{ type: "input_image", source: { type: "base64", media_type, data } }`
  - Remove the skip/warn code path that currently drops image parts
- [ ] **Anthropic:** Add URL-based image support:
  - Keep existing base64 path via `source: { type: "base64", media_type, data }`
  - Add URL path via `source: { type: "url", url: imageUrl }`
- [ ] **Gemini:** Add image ContentPart handling:
  - Base64 images → `inlineData: { mimeType, data }`
  - URL images → `fileData: { mimeType, fileUri }`
- [ ] **Gemini:** Fix tool call ID generation:
  - Replace `functionName` as ID with `call_${counter++}` per response
  - Maintain `idToName: Map<string, string>` for routing tool results back to function names
  - Update the response-building code that matches tool results to function calls
- [ ] Test: OpenAI adapter sends image with URL → request body contains `input_image` part
- [ ] Test: OpenAI adapter sends image with base64 → request body contains base64 `input_image`
- [ ] Test: Anthropic adapter sends URL image → request body contains `url` source type
- [ ] Test: Anthropic adapter sends base64 image → existing behavior preserved
- [ ] Test: Gemini adapter sends base64 image → request body contains `inlineData`
- [ ] Test: Gemini adapter sends URL image → request body contains `fileData`
- [ ] Test: Gemini response with 2 calls to same function → unique IDs assigned, results route correctly
- [ ] Test: Gemini response with 3 different function calls → IDs are `call_0`, `call_1`, `call_2`
- [ ] Run `npm test` — confirm zero regressions

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/engine.ts` | Modify | PipelineFailedEvent emission; retry on `failure`; centralized failure routing chain |
| `src/engine/retry.ts` | Modify | Make retry eligibility apply to `failure` outcomes, not only explicit `retry` |
| `src/engine/types.ts` | Modify | Carry terminal failure state through cleanup-to-exit paths |
| `src/server/routes/pipelines.ts` | Modify | Fix SSE stream closure on run completion/error |
| `src/server/routes/gardens.ts` | Modify | Fix SSE stream closure on draft completion/error |
| `src/server/routes/seeds.ts` | Modify | Fix async lifecycle for seed-run linkage |
| `src/runtime/garden-draft-service.ts` | Modify | Ensure draft completion signals stream end |
| `src/runtime/pipeline-service.ts` | Modify | Ensure run completion signals stream end |
| `src/agent-loop/session.ts` | Modify | Loop detection → steering injection with safety valve |
| `src/agent-loop/loop-detection.ts` | Modify | Support warn-and-recover behavior instead of immediate termination |
| `src/llm/types.ts` | Modify | Normalize image input surface |
| `src/llm/client.ts` | Modify | Add shared request normalization for image handling |
| `src/llm/adapters/openai.ts` | Modify | Image content part handling (URL + base64) |
| `src/llm/adapters/anthropic.ts` | Modify | URL-based image support |
| `src/llm/adapters/gemini.ts` | Modify | Image handling + synthetic tool call IDs |
| `test/engine/retry.test.ts` | Modify | Failure-status retry + routing chain tests |
| `test/integration/conditions.test.ts` | Modify | End-to-end failure routing integration test |
| `test/fixtures/retry-failure-routing.dot` | Create | Fixture for failure routing integration test |
| `test/llm/adapters/openai.test.ts` | Modify | Image content part tests |
| `test/llm/adapters/anthropic.test.ts` | Modify | URL image tests |
| `test/llm/adapters/gemini.test.ts` | Modify | Image + tool ID tests |
| `test/agent-loop/loop-detection.test.ts` | Modify | Steering injection + safety valve tests |

---

## Definition of Done

### Phase 1: Green Suite (MUST pass before any other phase begins)
- [ ] `npm test` passes with zero failures on a clean checkout
- [ ] `pipeline-events` test: event sequence includes `PipelineFailedEvent` in correct position
- [ ] `gardens-draft` test: SSE stream closes within timeout
- [ ] `hive-run-flow` test: HTTP lifecycle completes within timeout
- [ ] `seed-run-linkage` test: seed-run lifecycle completes within timeout
- [ ] Every SSE route handler has: listener-before-start, `try/finally` with `res.end()`, `req.on('close')` cleanup
- [ ] Each fix site has a comment explaining the root cause

### Phase 2: Engine Retry & Failure Routing
- [ ] Engine retries on `failure` status when `max_retries > 0` (GAP-A1 closed)
- [ ] After retry exhaustion, engine follows the full chain: fail-condition edge → node retry_target → node fallback_retry_target → graph-level targets → `PipelineFailedEvent` + terminate (GAP-A3 closed)
- [ ] Exit handler's goal-gate path uses the same `resolveFailureTarget()` function (no duplication)
- [ ] Failure path through cleanup to `Msquare` still ends run as `failed`
- [ ] Existing pipelines with fail-condition edges route identically (no regression)

### Phase 3: Loop Detection Steering
- [ ] Loop detection injects steering message and resets detection window (GAP-C1 closed)
- [ ] After 3 steering attempts in one session, loop detection terminates with failure
- [ ] `AgentLoopDetectedRunEvent` emits on every detection (both steer and terminate paths)

### Phase 4: Provider Image Handling & Gemini Tool IDs
- [ ] OpenAI adapter handles URL and base64 image content parts (GAP-U1 partial)
- [ ] Anthropic adapter handles URL images in addition to base64 (GAP-U1 partial)
- [ ] Gemini adapter handles URL and base64 image content parts (GAP-U1 closed)
- [ ] Gemini adapter generates unique synthetic tool call IDs per response (GAP-U8 closed)
- [ ] Tool results route back to correct function calls when multiple calls share a name

### Meta
- [ ] All previously passing tests still pass (zero regressions)
- [ ] `npm run build` succeeds with zero errors
- [ ] Compliance report can be updated: GAP-A1, GAP-A3, GAP-C1, GAP-U1, GAP-U8 marked closed

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Test failures have deeper root causes than diagnosed | Medium | High | Phase 1 gets 40% of sprint budget. Diagnosis-first: instrument, reproduce, root-cause, fix. If root cause analysis proves wrong, the extra budget absorbs investigation. No other work starts until tests pass. |
| SSE fixes require changes to service layer, not just route handlers | Medium | Medium | Root cause 2 may live in `garden-draft-service.ts` or `pipeline-service.ts` rather than the routes. Files list includes both. Follow the event chain from service to route to response. |
| Failure routing chain creates edge cases in existing pipelines | Low | Medium | The chain is strictly additive — it only activates after retry exhaustion when today's behavior would terminate anyway. Existing fail-condition edges hit step 1 and route as before. Run every existing integration test. |
| Loop detection steering creates infinite retry cycles | Low | High | Hard cap at 3 steering attempts per session. After that, terminate with failure — same as today's behavior, just delayed by 3 recovery attempts. |
| Image format differences cause subtle cross-provider bugs | Low | Medium | Each provider has well-documented image APIs. Tests verify both URL and base64 for each adapter. Provider docs are the source of truth. |
| Gemini tool ID change breaks result routing | Medium | Medium | The ID→name map is maintained within a single response. Tests verify multi-call responses with both same-name and different-name tools. The synthetic ID format (`call_N`) cannot collide with function names. |
| Phase 1 consumes the entire sprint | Medium | Low | This is explicitly an acceptable outcome. A green suite is more valuable than any gap closure. The sprint is designed so Phase 1 alone justifies its existence. |
| Failure path through cleanup to exit erases failed status | Low | Medium | Track terminal run status independently from exit node. Codex's architecture insight: run status is not inferred from the last node shape. |

---

## Dependencies

No new packages. All changes modify existing source files.

| Dependency | Type | Notes |
|------------|------|-------|
| Sprint 025 state | Soft | Sprint 025's seed-run-linkage test exists in the codebase. If it wasn't fixed by 025, Phase 1 inherits it. |
| Provider API docs | External | OpenAI Responses API, Anthropic Messages API, Gemini generateContent API image input formats. All stable and well-documented. |
