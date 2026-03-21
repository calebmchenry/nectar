# Sprint 032: SSE Lifecycle Fix & Agent Runtime Hardening

## Overview

**Goal:** Fix the 6 failing tests caused by SSE streams that never close, then close the 11 highest-impact compliance gaps that change runtime behavior in the coding-agent loop and unified LLM client. After this sprint: `npm test` is green, agent sessions honor the right project instructions, long-running sessions no longer die at arbitrary default limits, spawned process trees are cleaned up reliably, malformed tool calls are repaired deterministically, and provider error/reasoning data is preserved without lossy translation.

**Why this sprint, why now:**

1. The 6 failing tests have persisted across sprints 025–031. SSE streams opened by HTTP route handlers never call `res.end()` on terminal events, causing test hangs and timeouts. A red suite blocks everything — no compliance work matters until CI is green.
2. The remaining Attractor gaps are mostly validation, event-shape, or naming issues. The remaining agent-loop and LLM gaps still change how work executes, fails, and recovers. Fixing those is the highest-leverage use of a sprint.
3. INTENT.md makes the coding-agent loop the engine inside `codergen` nodes. If that loop reads the wrong instructions, dies after 12 turns, leaks child processes, or loses provider data, every higher-level Nectar feature inherits that instability.

**Scope:** 6 failing test fixes + 12 compliance gaps: **A3, C1, C2, C6, C7, C8, U13, U14, U15, U16, U17, U18**.

**Out of scope:**

- Web UI, Seedbed, Swarm Intelligence, or new CLI commands
- Remaining Attractor gaps (A1, A2, A4, A5, A6)
- Model catalog refresh (U3)
- Optional adapter lifecycle/interface gaps (U1, U2, U4–U12, U19)
- Native-provider prompt parity (C3–C5, C9–C12)
- Architecture refactoring beyond what's required for fixes
- Performance optimization

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures, zero timeouts, zero skipped tests.

2. **SSE streams close when pipelines finish.** A test client (or browser) opening `/pipelines/:id/events` receives events during execution and a clean stream close after the terminal event. No hanging connections.

3. **Pipeline failures emit the full event sequence.** When a node fails fatally, the event stream contains `stage_failed`, `run_error`, and `pipeline_failed` in the correct order.

4. **Nested instructions resolve correctly.** A session launched from `packages/api/` reads instruction files from the repo root down to `packages/api/`, with deeper files taking precedence and provider-specific files winning over `AGENTS.md` in the same directory.

5. **Long-running agent work does not fail by default.** A `codergen` node that needs 27 turns and 19 tool rounds completes normally when no explicit limit is set. `0` means unlimited, not immediate failure.

6. **Child agents can be bounded intentionally.** `spawn_agent` accepts `max_turns`, and a caller can choose either a hard cap (`max_turns: 4`) or explicit unlimited (`max_turns: 0`). Omitting the parameter keeps children bounded by `child_max_turns`.

7. **Timeouts and aborts kill the whole shell tree.** A shell command that spawns background grandchildren is fully terminated on timeout or session abort. No orphan processes continue writing files after Nectar says the command stopped.

8. **Malformed tool calls fail less often and fail more clearly.** If a model emits a valid tool name with slightly wrong arguments, Nectar repairs the call once in a deterministic way, emits a warning, and proceeds. If the call is unsafe or unrecoverable, it fails closed without executing the tool.

9. **Provider errors are classified correctly.** HTTP 408 becomes a non-retryable request-timeout error, HTTP 413 becomes a context-length error, HTTP 422 becomes an invalid-request error, and retry middleware calls `on_retry` before every actual retry.

10. **Anthropic reasoning round-trips without data loss.** `redacted_thinking` blocks preserve their opaque `data` payload across request/response translation so follow-up turns do not silently discard provider state.

---

## Architecture

### Phase 0: SSE Lifecycle Fix

The SSE route handlers must detect terminal events and call `res.end()`. The engine already emits terminal events; the HTTP layer fails to act on them. Additionally, the engine must emit `run_error` when a node fails fatally and no retry/failure edge is available.

```
Terminal event flow (current):
  Engine emits run_completed → SSE handler writes event → ❌ stream stays open

Terminal event flow (fixed):
  Engine emits run_completed → SSE handler writes event → res.end() → ✅ stream closes
```

Before implementing the fix, grep for all `text/event-stream` response handlers to audit every SSE route — not just the two known ones. Extract a shared `closeOnTerminalEvent()` helper to avoid duplicating cleanup logic.

Handle client disconnects: subscribe to `res.on('close')` to unsubscribe from engine events when the client disconnects before the terminal event fires.

### Workstream A: Session Semantics and Process Control

`discoverInstructions()` must walk from repo root toward the session's effective cwd, not upward from workspace root. Resolve repo root via `git rev-parse --show-toplevel`; if git is unavailable or cwd is outside a repo, fall back to `workspace_root`. Cache the result for the session to avoid repeated shell spawns.

Within a directory, `AGENTS.md` is lower precedence than the provider-specific file. Deeper directories override shallower ones. The 32 KB instruction budget drops lowest-precedence content first.

Loop limits need one shared semantic everywhere: `0` means unlimited, positive integers are hard caps. Add helper predicates so the meaning is explicit and testable — do not scatter raw `while (count < max)` checks. Parent sessions default to unlimited; spawned child sessions stay explicitly bounded unless the caller opts in to unlimited.

Shell execution becomes process-group based. `LocalExecutionEnvironment.exec()` owns subprocess lifecycle: group creation, timeout handling, abort handling, and group teardown. The shell tool stays a thin formatter.

### Workstream B: Tool-Call Contract Hardening

Create one shared, deterministic tool-call repair pipeline in `src/llm/tool-repair.ts`, used by both `UnifiedClient.generate()` and `AgentSession.processWorkItem()`. No second LLM round-trip. Repair must be local, conservative, and auditable.

The repair pipeline does four things only:

1. Validate tool names against `[a-zA-Z][a-zA-Z0-9_]*` and 64-character cap.
2. Parse arguments, with only a very narrow recovery path for empty payloads and trivial JSON issues.
3. Apply safe schema-guided coercions and strip unknown keys when the schema disallows extras.
4. Revalidate with AJV before execution.

If repair cannot produce a valid argument object in one pass, return a structured invalid-tool-call error and do not execute the tool. Emit a warning when repair changed the call so transcripts and event consumers can see Nectar intervened.

### Workstream C: Provider Error and Reasoning Fidelity

Provider adapters normalize raw HTTP/provider behavior into the unified error model. This sprint fixes timeout retryability, adds the missing explicit status mappings (408, 413, 422), and adds the missing retry callback.

Anthropic `redacted_thinking` stays opaque. Store and forward the `data` blob unchanged — never inspect it, never log it, never drop it.

### No New Product Surfaces

This sprint does not add commands, routes, screens, or new user-facing workflows.

---

## Implementation

### Phase 1: SSE Lifecycle Fix (~20%)

**Files:** `src/server/routes/pipelines.ts`, `src/server/routes/gardens.ts`, `src/engine/engine.ts`, `src/engine/events.ts`

**Tasks:**
- [ ] Audit all SSE routes by grepping for `text/event-stream` — confirm the complete list before coding
- [ ] Extract a shared `closeOnTerminalEvent()` helper that subscribes to terminal events and calls `res.end()` after writing the final event
- [ ] In the pipeline events SSE route handler, use the helper to close the stream on `run_completed`, `pipeline_failed`, `run_interrupted`, or `run_error`
- [ ] In the garden draft SSE route handler, close the stream on `draft_complete` or `draft_error`
- [ ] Add cleanup: unsubscribe from engine events on `res.on('close')` (client disconnect) and on terminal event
- [ ] Emit `run_error` from the engine when a node fails fatally and no failure edge or retry is available, before emitting `pipeline_failed`
- [ ] Verify all 6 previously-failing tests now pass
- [ ] Add a regression test: open SSE stream, run a pipeline to completion, assert stream closes within 1 second of terminal event

### Phase 2: Instruction Precedence and Unlimited-Loop Semantics (~20%)

**Files:** `src/agent-loop/project-instructions.ts`, `src/agent-loop/session.ts`, `src/agent-loop/types.ts`, `src/agent-loop/subagent-manager.ts`, `src/agent-loop/tools/spawn-agent.ts`, `src/handlers/codergen.ts`

**Tasks:**
- [ ] Change `discoverInstructions()` to accept the session start directory or effective cwd
- [ ] Resolve repo root via `git rev-parse --show-toplevel`; fall back to `workspace_root` when git is unavailable or cwd is outside a repo
- [ ] Walk from repo root toward cwd, not the other way around
- [ ] Apply precedence: shallower directories first → deeper last; `AGENTS.md` before provider-specific in same directory; provider-specific overrides generic
- [ ] Preserve the 32 KB instruction budget, dropping lowest-precedence content first
- [ ] Change `DEFAULT_SESSION_CONFIG.max_turns` and `max_tool_rounds_per_input` from `12`/`10` to `0`
- [ ] Add helper predicates so `0` means unlimited everywhere: session turn loops, tool-round loops, and the codergen bridge
- [ ] Extend `spawnAgentSchema` to accept `max_turns`; thread it through the subagent path
- [ ] Keep the default child limit finite when `max_turns` is omitted — parent sessions become unlimited by default, spawned children stay bounded unless the caller opts out
- [ ] Add tests for: nested instruction precedence, repo-root-to-cwd ordering, git-unavailable fallback, default unlimited sessions exceeding 12 turns and 10 tool rounds, `spawn_agent(max_turns: 0)` vs `spawn_agent(max_turns: 4)` vs omitted

### Phase 3: Process-Group Execution and Clean Aborts (~15%)

**Files:** `src/agent-loop/execution-environment.ts`, `src/agent-loop/tools/shell.ts`

**Tasks:**
- [ ] Rework `LocalExecutionEnvironment.exec()` so commands run in a dedicated process group on macOS/Linux
- [ ] On timeout, kill the entire process group, not just the immediate shell process
- [ ] On abort, kill the entire process group and return a clean cancelled result
- [ ] Preserve current environment filtering, cwd scoping, stdout/stderr capture, and timeout result shape
- [ ] Keep the shell tool dumb: it formats the result, does not own kill semantics
- [ ] Add a fixture script that spawns a child plus a grandchild (`sleep 60`) and writes a heartbeat file
- [ ] Add tests proving the heartbeat stops after timeout and after abort

### Phase 4: Tool Name Validation and Deterministic Repair (~15%)

**Files:** `src/llm/tool-repair.ts` (new), `src/llm/tools.ts`, `src/llm/client.ts`, `src/agent-loop/tool-registry.ts`, `src/agent-loop/session.ts`

**Tasks:**
- [ ] Add `validateToolName()` enforcing `[a-zA-Z][a-zA-Z0-9_]*` and max length 64
- [ ] Validate names at tool registration and again before provider request translation
- [ ] Create `repairToolCall()` as a deterministic shared helper
- [ ] Limit repair to safe cases: empty payload → `{}`, trivial JSON cleanup, strip unknown keys, lossless type coercions only
- [ ] Never invent missing required fields; never execute a tool after failed repair
- [ ] Emit a warning when repair changed the call
- [ ] Wire repair into both `UnifiedClient.generate()` and `AgentSession.processWorkItem()`
- [ ] Add tests for: invalid names rejected, safe repair succeeds once, unknown keys stripped, lossy coercions rejected, unrecoverable calls fail closed, repaired calls execute exactly once

### Phase 5: Provider Error Mapping, Retry Hooks, and Anthropic Redacted Thinking (~15%)

**Files:** `src/llm/errors.ts`, `src/llm/retry.ts`, `src/llm/types.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`

**Tasks:**
- [ ] Make `TimeoutError` non-retryable with status code 408
- [ ] Add spec-named compatibility subclasses: `RequestTimeoutError`, `ContextLengthError`
- [ ] Map HTTP 408→`RequestTimeoutError`, 413→`ContextLengthError`, 422→`InvalidRequestError` in all provider adapters
- [ ] Add `on_retry(error, attempt, delay)` to `RetryConfig`; call it before each actual retry sleep
- [ ] Ensure timeout-derived errors are never retried by retry middleware
- [ ] Add `data?: unknown` to `RedactedThinkingContentPart`
- [ ] Preserve `redacted_thinking.data` in Anthropic request and response translation — never inspect, log, or drop it
- [ ] Add tests: timeout retryability is false, 408/413/422 mapping in each adapter, `on_retry` callback order and arguments, `redacted_thinking.data` round-trips unchanged across turns

### Phase 6: Engine Observability and Compliance Report (~10%)

**Files:** `src/engine/events.ts`, `src/engine/engine.ts`, `docs/compliance-report.md`

**Tasks:**
- [ ] Add `CheckpointSaved` event type to `src/engine/events.ts`
- [ ] Emit `CheckpointSaved` from the engine after each checkpoint write
- [ ] `npm run build` passes with zero TypeScript errors
- [ ] `npm test` passes with zero failures
- [ ] Update `docs/compliance-report.md`: move A3, C1, C2, C6, C7, C8, U13, U14, U15, U16, U17, U18 from GAPS to IMPLEMENTED
- [ ] Verify report language matches shipped behavior, especially parent-unlimited / child-finite defaults

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/routes/pipelines.ts` | Modify | Close SSE streams on terminal events via shared helper |
| `src/server/routes/gardens.ts` | Modify | Close draft SSE streams on completion |
| `src/engine/engine.ts` | Modify | Emit `run_error` before `pipeline_failed`; emit `CheckpointSaved` |
| `src/engine/events.ts` | Modify | Add `CheckpointSaved` event type |
| `src/agent-loop/project-instructions.ts` | Modify | Correct repo-root-to-cwd instruction discovery and precedence |
| `src/agent-loop/session.ts` | Modify | Honor unlimited loop semantics; run repaired tool calls |
| `src/agent-loop/types.ts` | Modify | Change default session limits to `0`; document unlimited semantics |
| `src/agent-loop/subagent-manager.ts` | Modify | Thread explicit child `max_turns` and support `0` override |
| `src/agent-loop/tools/spawn-agent.ts` | Modify | Expose `max_turns` in the tool schema |
| `src/handlers/codergen.ts` | Modify | Bridge node/session config into new limit semantics |
| `src/agent-loop/execution-environment.ts` | Modify | Process-group lifecycle: creation, timeout, abort, teardown |
| `src/agent-loop/tools/shell.ts` | Modify | Keep shell tool aligned with new timeout/abort behavior |
| `src/agent-loop/tool-registry.ts` | Modify | Reject invalid tool names at registration time |
| `src/llm/tool-repair.ts` | Create | Shared deterministic tool-call validation and repair |
| `src/llm/tools.ts` | Modify | Reuse shared tool-name validation |
| `src/llm/client.ts` | Modify | Apply tool-call repair in the unified tool loop |
| `src/llm/errors.ts` | Modify | Fix timeout retryability; add compatibility subclasses |
| `src/llm/retry.ts` | Modify | Add `on_retry` callback; respect non-retryable timeouts |
| `src/llm/types.ts` | Modify | Add opaque `data` field to `RedactedThinkingContentPart` |
| `src/llm/adapters/anthropic.ts` | Modify | Round-trip `redacted_thinking.data`; map HTTP status codes |
| `src/llm/adapters/openai.ts` | Modify | Add explicit 408/413/422 error mapping |
| `src/llm/adapters/gemini.ts` | Modify | Add explicit 408/413/422 error mapping |
| `src/llm/adapters/openai-compatible.ts` | Modify | Add explicit 408/413/422 error mapping |
| `test/server/sse-lifecycle.test.ts` | Create | Regression test: SSE close timing |
| `test/fixtures/process-tree.mjs` | Create | Child/grandchild fixture for killability tests |
| `test/llm/tool-repair.test.ts` | Create | Unit tests for deterministic repair rules |
| `docs/compliance-report.md` | Modify | Mark closed gaps as implemented |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts (6 failing → 0 failing)
- [ ] No test timeout values were increased to achieve green
- [ ] SSE streams for `/pipelines/:id/events` close within 1 second of the terminal pipeline event
- [ ] SSE stream for `/gardens/draft` closes after `draft_complete` or `draft_error`
- [ ] `run_error` event is emitted when a node fails fatally with no retry/failure edge
- [ ] `CheckpointSaved` event is emitted after each checkpoint write
- [ ] `discoverInstructions()` walks from repo root toward cwd; deeper directories override shallower ones; provider-specific files override `AGENTS.md`
- [ ] The 32 KB instruction budget still applies after precedence changes
- [ ] Instruction discovery falls back to `workspace_root` when git is unavailable or cwd is outside a repo
- [ ] `DEFAULT_SESSION_CONFIG.max_turns === 0` and `max_tool_rounds_per_input === 0`
- [ ] `0` is interpreted as unlimited in session turn loops and tool-round loops
- [ ] An integration test proves a session can exceed 12 turns and 10 tool rounds without failing
- [ ] `spawn_agent` accepts `max_turns`; child sessions honor explicit finite values and explicit `0`
- [ ] Spawned child agents default to finite limits when `max_turns` is omitted
- [ ] Timeout or abort kills the full command process group, including grandchildren
- [ ] Tool names outside `[a-zA-Z][a-zA-Z0-9_]*` or longer than 64 characters are rejected before execution
- [ ] Deterministic repair fixes safe argument mismatches exactly once and emits a warning
- [ ] Failed repair never executes the underlying tool handler
- [ ] Repaired tool calls execute exactly once in both `UnifiedClient` and `AgentSession` paths
- [ ] `TimeoutError.retryable === false`
- [ ] Adapters map HTTP 408→`RequestTimeoutError`, 413→`ContextLengthError`, 422→`InvalidRequestError`
- [ ] Retry middleware invokes `on_retry(error, attempt, delay)` before every actual retry sleep
- [ ] `redacted_thinking.data` round-trips through Anthropic request/response translation unchanged
- [ ] `docs/compliance-report.md` no longer lists A3, C1, C2, C6, C7, C8, U13, U14, U15, U16, U17, U18 as open gaps
- [ ] Report language reflects the parent-unlimited / child-finite default design decision

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE fix is insufficient — other routes also leak streams | Medium | High | Audit prerequisite: grep all `text/event-stream` handlers before coding. Extract shared `closeOnTerminalEvent()` helper. |
| Unlimited defaults cause runaway parent sessions in production | Medium | High | Keep loop detection enabled. Keep explicit per-node overrides. Keep child sessions finite by default. Document the design decision. |
| Instruction precedence change breaks snapshot expectations | Medium | Medium | Add explicit ordering tests. Keep precedence rules small, documented, and deterministic. |
| Process-group behavior differs between macOS and Linux | Medium | High | Use one POSIX implementation with feature detection. Prove killability with a real process-tree fixture, not mocks. |
| Deterministic repair overreaches and mutates valid calls | Medium | High | Single-pass, schema-driven, fail-closed. Never invent required fields. Emit a warning on every repaired call. |
| Error taxonomy aliases break existing callers | Low | Medium | Add compatibility subclasses instead of renaming existing base classes. |
| Changing default limits requires lockstep test updates | Medium | Medium | Tests that create agent sessions should set explicit limits. Run full suite after Phase 2 before proceeding. |
| `git rev-parse` latency or failure in constrained environments | Low | Medium | Cache the result per session. Fall back to `workspace_root`. |
| Redacted-thinking payloads grow unexpectedly large | Low | Medium | Treat as opaque data. Avoid logging. Keep only where the message content model already stores provider data. |
| Compliance report is stale relative to current branch | Medium | Low | Re-verify each target gap against the current codebase before marking as implemented in Phase 6. |

---

## Security Considerations

- **Tool name validation (U13)** prevents injection through tool names containing special characters.
- **Process group cleanup (C8)** prevents orphaned child processes from lingering after timeout.
- **Deterministic repair** never invents required fields and never executes a tool after failed validation — fail-closed by design.
- **No `eval`/`Function`** anywhere — all condition parsing remains allowlist-only.

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Pinned spec snapshot via `docs/compliance-report.md` | Source of truth for exact gap definitions |
| `git` CLI (when available) | Resolve repo root for instruction precedence; falls back to `workspace_root` |
| `execa` | Existing subprocess library; reused for process-group execution and teardown |
| `ajv` | Existing schema validator; reused for post-repair revalidation |
| `vitest` | Existing test runner |

No new runtime packages should be added unless process-group teardown proves unreliable on both macOS and Linux with the existing stack.

---

## Open Questions

| Question | Proposed Resolution |
|----------|-------------------|
| Should `run_error` fire when a node fails but has a failure edge? | No — `run_error` is for fatal failures only. If a failure edge exists, the engine routes to it without emitting `run_error`. |
| Should the `git rev-parse` result be cached? | Yes — cache per session startup. Instruction discovery happens once, not per-turn. |
| Should repair traverse deeply nested object schemas? | No in this sprint — keep repair shallow (top-level keys and simple coercions). Deep schema traversal is a future enhancement. |
| Should `CheckpointSaved` fire during resume for the restored checkpoint? | No — it fires only on new writes. The restored checkpoint was already saved in a previous run. |
