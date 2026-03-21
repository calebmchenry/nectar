# Sprint 026: Runtime Fidelity — Failure Paths, Loop Recovery, and Multimodal Parity

## Overview

**Goal:** Make Nectar trustworthy on the core path from "run a garden" to "let a codergen node analyze text and images across providers." After this sprint, failure outcomes retry and route per spec, codergen falls back from `prompt` to `label`, loop detection warns and recovers instead of terminating immediately, `grep` and `glob` truly run through the execution environment, and OpenAI, Anthropic, and Gemini normalize image input, stop reasons, and Gemini tool call IDs consistently.

**Why this sprint, why now:**

1. **The highest-priority gaps cluster on one user journey.** `docs/compliance-report.md` flags GAP-A1, GAP-A3, GAP-C1, GAP-C8, GAP-U1, GAP-U2, and GAP-U8 as high priority. They all hit the same runtime path: codergen runs inside an orchestrated pipeline and talks to real providers.
2. **`docs/INTENT.md` makes these contracts non-negotiable.** The attractor implementation is the floor, not the ceiling, and seeds must accept screenshots and images. Right now Nectar is still inconsistent in exactly those places: failure semantics and multimodal/provider parity.
3. **This sprint buys trust, not breadth.** More Hive polish, more CLI sugar, or more catalog churn will not matter if a failed stage skips retries, a looped agent hard-fails, or an image-backed request breaks on provider boundaries.
4. **The sprint is intentionally narrow.** It closes a small number of spec-critical gaps across engine, agent loop, and LLM adapters without opening new product surface area.

**Scope:** Close GAP-A1, GAP-A3, GAP-A4, GAP-C1, GAP-C3, GAP-C4, GAP-C8, GAP-U1, GAP-U2, and GAP-U8.

**Out of scope:**
- GAP-U3 model catalog refresh
- GAP-U4, GAP-U6, and GAP-U7 streaming and high-level tool-loop redesign
- GAP-C2 event-type completeness
- GAP-C7, GAP-C9, GAP-C10, GAP-C11, and GAP-C12 agent-loop polish outside the core recovery path
- GAP-A5 through GAP-A9 schema/model cleanup
- New Hive views, CLI packaging, `nectar upgrade`, shell completions, or release automation

**Cut line:** If the sprint compresses, cut GAP-C3 and GAP-C4 first. Do **not** cut GAP-A1, GAP-A3, GAP-C1, GAP-C8, GAP-U1, GAP-U2, or GAP-U8. Those are the reason this sprint exists.

## Use Cases

1. **Retry a real failure.** A `parallelogram` tool node exits non-zero with `max_retries=2`. Nectar retries twice before entering the failure-routing path instead of treating the first `failure` as terminal.
2. **Route failure deterministically.** A node fails, has a `condition="outcome=failure"` edge, and also has `retry_target` configured. After retry budget is exhausted, Nectar chooses the failure edge first, then node-level targets, then graph-level fallbacks.
3. **Fail even if cleanup reaches exit.** A failure edge routes to a cleanup node and then `Msquare`. The run still ends `failed`, emits failure events, and writes a failed checkpoint instead of being misclassified as `completed`.
4. **Use `label` as a codergen prompt fallback.** A `box` node sets `label="Draft migration plan"` and omits `prompt`. The handler uses the label text instead of failing immediately.
5. **Recover from loop detection.** A codergen session repeats the same read-only tool pattern three rounds in a row. Nectar injects a developer steering warning and gives the model a chance to change tactics on the next turn.
6. **Steer between turns.** A supervisor or user calls `steer()` after a turn completes. The message queues successfully, the session returns to `IDLE`, and the steering is delivered before the next LLM call.
7. **Use `grep` and `glob` through the environment abstraction.** `LocalExecutionEnvironment` implements both methods, tool handlers become thin wrappers, and future Docker, Kubernetes, or WASM environments can provide the same contract without patching tool code.
8. **Analyze an attached screenshot.** A seed or codergen prompt includes a local PNG, a base64 image, or an image URL. OpenAI, Anthropic, and Gemini each receive a valid translated request instead of silently dropping the image.
9. **Handle repeated Gemini tool calls safely.** Gemini returns two calls to the same tool name in one response. Nectar generates unique synthetic `call_*` IDs so tool results map back to the correct request.
10. **Stop reasons are provider-agnostic.** Upstream code no longer branches on `end_turn` vs `tool_use`. All adapters return the same unified stop-reason vocabulary and preserve the raw provider finish reason for debugging.

## Architecture

### 1. Centralize failure resolution in the engine

The engine currently spreads failure behavior across retry handling, edge selection, and terminal-exit detection. That is why GAP-A1 and GAP-A3 exist.

This sprint should introduce one explicit failure-resolution path with one question per step:

1. Did the node return `failure` or throw an exception?
2. Is there retry budget remaining for this node?
3. If not, is there a matching failure-conditioned edge?
4. If not, is there a node-level `retry_target`?
5. If not, is there a node-level `fallback_retry_target`?
6. If not, is there a graph-level retry target?
7. If not, terminate the run as failed.

Two design rules matter:

- **Retry happens before routing, but only until budget is exhausted.** Failure edges are post-retry routing, not a replacement for retries.
- **Run status is not inferred from the last node shape.** Reaching `Msquare` through a failure path must not erase the failed terminal state.

### 2. Session recovery is queue-based, not state-gated

The agent loop already has the primitives it needs: pending inputs, pending steers, loop detection, and developer-role messages. The problem is policy.

This sprint should make recovery semantics simple and durable:

- `steer()` queues while `IDLE`, `AWAITING_INPUT`, or `PROCESSING`; only `CLOSED` rejects.
- Natural completion returns the session to `IDLE`.
- Loop detection injects steering and gives the model one recovery window before hard failure.
- The warning path and the manual steering path should use the same queue and delivery order.

That keeps human steering, manager-loop steering, and automatic loop recovery on one mechanism instead of three special cases.

### 3. `ExecutionEnvironment` must own filesystem search semantics

GAP-C8 exists because the public environment interface advertises `grep()` and `glob()`, but the local implementation throws and the tool handlers bypass it with their own filesystem walkers.

That inversion is wrong. The tools should be thin adapters over the environment, not the place where filesystem semantics live.

The contract should move to `LocalExecutionEnvironment`:

- workspace-bound path resolution
- `.gitignore` handling
- binary-file skipping for `grep`
- `maxResults` enforcement
- `glob` result ordering by mtime with lexical tiebreak

Once that logic lives in the environment, alternate runtimes can implement the same contract cleanly.

### 4. Normalize media and finish reasons before provider-specific quirks leak outward

INTENT requires screenshot and file capture, and the compliance report says image input is still broken across providers. The fix should not be three unrelated adapter hacks.

Add one normalization layer that resolves image inputs into a canonical form before adapter translation:

- local file path -> MIME detection + base64 encoding
- image URL -> provider-native URL form when supported, otherwise normalized fallback
- base64 image -> pass through with validated media type

Then keep provider-specific translation at the adapter boundary:

- OpenAI Responses: emit image input blocks
- Anthropic Messages: emit image blocks for both base64 and URL-backed images
- Gemini: emit `inlineData` or `fileData` parts for images

At the same boundary, normalize finish reasons and Gemini tool call IDs:

- adapters emit one unified stop-reason vocabulary
- raw provider finish reason is preserved for debugging
- Gemini function calls receive synthetic unique IDs on ingestion, and the same IDs are used for tool-result correlation

## Implementation phases

### Phase 1: Attractor failure semantics and codergen fallback (~25%)

**Files:** `src/engine/engine.ts`, `src/engine/retry.ts`, `src/engine/types.ts`, `src/handlers/codergen.ts`, `test/engine/engine.test.ts`, `test/engine/retry.test.ts`, `test/handlers/codergen.test.ts`, `test/fixtures/failure-routing.dot` (new), `test/fixtures/failure-to-exit.dot` (new)

**Tasks:**

- [ ] Treat `failure` outcomes and handler exceptions as retry-eligible when retry budget remains (GAP-A1).
- [ ] Refactor retry evaluation so retry budget is checked before failure routing, but only for retry-eligible failure states.
- [ ] Implement the full post-failure routing chain after retries are exhausted: failure-conditioned edge -> node `retry_target` -> node `fallback_retry_target` -> graph-level targets -> terminal failure (GAP-A3).
- [ ] Track terminal run status independently from the physical exit node so cleanup-to-exit paths do not erase failure.
- [ ] Update codergen prompt resolution to fall back from `node.prompt` to `node.label` before failing (GAP-A4).
- [ ] Add regression coverage for non-zero tool exit with retry budget.
- [ ] Add regression coverage for a thrown handler exception with retry budget.
- [ ] Add regression coverage for failure-edge precedence over `retry_target`.
- [ ] Add regression coverage for graph-level fallback routing.
- [ ] Add regression coverage for a failure path that still reaches `Msquare`.
- [ ] Add regression coverage for codergen `label` fallback.

### Phase 2: Agent-loop recovery semantics and environment fidelity (~25%)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/types.ts`, `src/agent-loop/loop-detection.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/tools/grep.ts`, `src/agent-loop/tools/glob.ts`, `test/agent-loop/session-control.test.ts`, `test/agent-loop/session.test.ts`, `test/agent-loop/loop-detection.test.ts`, `test/agent-loop/execution-environment-scoped.test.ts`, `test/agent-loop/tools/grep.test.ts`, `test/agent-loop/tools/glob.test.ts`

**Tasks:**

- [ ] Make `steer()` queue outside `PROCESSING`; only reject in `CLOSED` state (GAP-C3).
- [ ] Return completed sessions to `IDLE` instead of leaving them in `AWAITING_INPUT` (GAP-C4).
- [ ] Replace loop-detected hard failure with warning injection plus one recovery attempt window (GAP-C1).
- [ ] Reuse the same pending-steer queue for manual steering and loop-recovery steering so ordering stays deterministic.
- [ ] Implement `LocalExecutionEnvironment.grep()` with the same behavior the tool currently owns: workspace boundary enforcement, `.gitignore`, binary skipping, include filters, and `maxResults` (GAP-C8).
- [ ] Implement `LocalExecutionEnvironment.glob()` with the same behavior the tool currently owns: workspace boundary enforcement, `.gitignore`, glob matching, and mtime-first ordering (GAP-C8).
- [ ] Refactor `src/agent-loop/tools/grep.ts` and `src/agent-loop/tools/glob.ts` into thin wrappers over the environment implementation so future runtime backends do not duplicate filesystem logic.
- [ ] Add regression coverage for steering before submit.
- [ ] Add regression coverage for steering between turns.
- [ ] Add regression coverage for the `PROCESSING -> IDLE` transition.
- [ ] Add regression coverage for a loop warning followed by a successful alternate tool choice.
- [ ] Add regression coverage for a repeated loop after warning still failing explicitly.
- [ ] Add regression coverage for environment-backed `grep` and `glob` output parity with current tool behavior.

### Phase 3: Unified LLM multimodal parity and response normalization (~35%)

**Files:** `src/llm/types.ts`, `src/llm/client.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `test/llm/types.test.ts`, `test/llm/client.test.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/gemini.test.ts`, `test/fixtures/llm/sample-image.png` (new)

**Tasks:**

- [ ] Add one request-normalization path for image inputs so local file paths, image URLs, and base64 images become canonical image parts before adapter translation (GAP-U1).
- [ ] Detect local image files, infer or validate MIME type, and base64-encode them with explicit size and error handling.
- [ ] OpenAI adapter: translate normalized image parts into Responses API image input blocks instead of silently dropping them (GAP-U1).
- [ ] Anthropic adapter: support URL-backed image inputs in addition to base64 images (GAP-U1).
- [ ] Gemini adapter: add image serialization using `inlineData` and `fileData`; it currently only handles audio and document media parts (GAP-U1).
- [ ] Normalize provider finish reasons to the spec’s provider-agnostic stop-reason values and preserve the raw provider reason on the unified response object (GAP-U2).
- [ ] Generate synthetic unique Gemini tool call IDs at response-translation time and reuse them for streaming and tool-result correlation (GAP-U8).
- [ ] Add regression coverage for an OpenAI base64 image request.
- [ ] Add regression coverage for an Anthropic image URL request.
- [ ] Add regression coverage for a Gemini local-file image request.
- [ ] Add regression coverage for unified stop-reason mapping across all three adapters.
- [ ] Add regression coverage for repeated same-name Gemini tool calls producing distinct IDs.

### Phase 4: Compliance lock-in and report refresh (~15%)

**Files:** `docs/upstream/manifest.json` (new), `docs/compliance-report.md`, `test/engine/engine.test.ts`, `test/agent-loop/session-control.test.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/gemini.test.ts`

**Tasks:**

- [ ] Record the local pinned upstream snapshot in `docs/upstream/manifest.json` as required by `docs/INTENT.md`.
- [ ] Update `docs/compliance-report.md` after implementation so GAP-A1, GAP-A3, GAP-A4, GAP-C1, GAP-C3, GAP-C4, GAP-C8, GAP-U1, GAP-U2, and GAP-U8 are removed.
- [ ] Ensure each closed gap is backed by at least one named regression test, not just prose in the report.
- [ ] Run the full verification gate: `npm run build` and `npm test`.

## Files Summary

| File | Action | Why |
|------|--------|-----|
| `src/engine/engine.ts` | Modify | Centralize failure retry and routing and preserve failed terminal status through cleanup-to-exit paths |
| `src/engine/retry.ts` | Modify | Make retry eligibility apply to real failures, not only explicit `retry` outcomes |
| `src/engine/types.ts` | Modify | Carry terminal failure state cleanly through the engine |
| `src/handlers/codergen.ts` | Modify | Fall back from empty `prompt` to `label` |
| `src/agent-loop/session.ts` | Modify | Queue steering across idle states and restore `IDLE` as the resting state |
| `src/agent-loop/types.ts` | Modify | Align session-state semantics with the recovery behavior |
| `src/agent-loop/loop-detection.ts` | Modify | Support warn-and-recover behavior instead of immediate termination |
| `src/agent-loop/execution-environment.ts` | Modify | Make `grep()` and `glob()` real environment capabilities |
| `src/agent-loop/tools/grep.ts` | Modify | Convert tool logic into an environment-backed wrapper |
| `src/agent-loop/tools/glob.ts` | Modify | Convert tool logic into an environment-backed wrapper |
| `src/llm/types.ts` | Modify | Normalize image input and unified stop-reason surface |
| `src/llm/client.ts` | Modify | Add shared request normalization for local file and image handling |
| `src/llm/adapters/openai.ts` | Modify | Add Responses API image translation and unified stop-reason mapping |
| `src/llm/adapters/anthropic.ts` | Modify | Add URL-image support and unified stop-reason mapping |
| `src/llm/adapters/gemini.ts` | Modify | Add image translation, stop-reason mapping, and synthetic tool call IDs |
| `docs/upstream/manifest.json` | Create | Pin the upstream compliance target locally |
| `docs/compliance-report.md` | Modify | Reflect closed gaps against the pinned snapshot |
| `test/engine/engine.test.ts` | Modify | Lock failure retry and routing behavior |
| `test/engine/retry.test.ts` | Modify | Lock retry-on-failure semantics |
| `test/handlers/codergen.test.ts` | Modify | Lock `label` prompt fallback |
| `test/agent-loop/session-control.test.ts` | Modify | Lock `IDLE`, steering, and lifecycle behavior |
| `test/agent-loop/loop-detection.test.ts` | Modify | Lock warn-and-recover loop handling |
| `test/agent-loop/tools/grep.test.ts` | Modify | Lock environment-backed grep parity |
| `test/agent-loop/tools/glob.test.ts` | Modify | Lock environment-backed glob parity |
| `test/llm/adapters/openai.test.ts` | Modify | Lock OpenAI image translation and stop-reason normalization |
| `test/llm/adapters/anthropic.test.ts` | Modify | Lock Anthropic URL-image support and stop-reason normalization |
| `test/llm/adapters/gemini.test.ts` | Modify | Lock Gemini image support and synthetic tool call IDs |
| `test/fixtures/llm/sample-image.png` | Create | Stable local image fixture for adapter tests |

## Definition of Done

- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] GAP-A1 is closed: `failure` outcomes and handler exceptions retry when retry budget remains.
- [ ] GAP-A3 is closed: post-failure routing follows the documented order after retries are exhausted.
- [ ] GAP-A4 is closed: codergen falls back from empty `prompt` to `label`.
- [ ] GAP-C1 is closed: loop detection injects steering before terminal failure.
- [ ] GAP-C3 is closed: `steer()` works outside `PROCESSING`.
- [ ] GAP-C4 is closed: sessions return to `IDLE` after work completes.
- [ ] GAP-C8 is closed: `LocalExecutionEnvironment.grep()` and `glob()` are implemented and used by the tool handlers.
- [ ] GAP-U1 is closed: OpenAI, Anthropic, and Gemini adapter tests cover working image input paths.
- [ ] GAP-U2 is closed: unified callers receive provider-agnostic stop reasons plus the raw provider reason.
- [ ] GAP-U8 is closed: repeated same-name Gemini tool calls get unique IDs.
- [ ] `docs/upstream/manifest.json` exists and records the local pinned upstream snapshot.
- [ ] `docs/compliance-report.md` no longer lists GAP-A1, GAP-A3, GAP-A4, GAP-C1, GAP-C3, GAP-C4, GAP-C8, GAP-U1, GAP-U2, or GAP-U8.

## Risks

- **Failure-routing order is easy to get subtly wrong.** The mitigation is to encode the order once in the engine and lock it with fixture-driven tests covering retries, failure edges, node targets, graph targets, and cleanup-to-exit paths.
- **Changing session resting state may break callers that expect `AWAITING_INPUT`.** The mitigation is to audit `getState()` consumers and treat `IDLE` as the only public post-turn resting state.
- **Moving `grep` and `glob` into the environment could change output ordering or ignore behavior.** The mitigation is to keep the tool output contract stable in tests before and after the refactor.
- **Local file image support widens I/O surface area.** The mitigation is to only auto-encode explicitly referenced files, enforce file-exists and size checks, and fail loudly instead of silently skipping media.
- **Gemini synthetic IDs must be stable within one response but never reused accidentally across responses.** The mitigation is to generate them at translation time with per-response scope and cover repeated same-tool-name cases in tests.
- **Stop-reason normalization can break callers that still compare against `end_turn` or `tool_use`.** The mitigation is to migrate call sites in the same sprint and let the TypeScript type surface force the cleanup.

## Dependencies

- **Pinned upstream snapshot:** Before implementation begins, record the current local upstream snapshot in `docs/upstream/manifest.json`. If the pinned docs and the current compliance report disagree, the pinned docs are the source of truth.
- **Deterministic local fixtures:** The multimodal work needs checked-in image fixtures and mocked provider responses. No live provider calls should be required for acceptance.
- **No new surface area during the sprint:** Do not add new Hive features, packaging work, or distribution tasks until these runtime gaps are closed and the compliance report is refreshed.
