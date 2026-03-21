# Sprint NEXT: Agent Runtime Hardening

## Overview

**Goal:** Close the highest-impact remaining compliance gaps in the coding-agent loop and unified LLM client so `codergen` is trustworthy under real workloads. After this sprint, agent sessions honor the right project instructions, no longer fail because of arbitrary default limits, clean up spawned process trees reliably, repair common malformed tool calls deterministically, and preserve provider-specific reasoning/error data without lossy translation.

**Scope:** 11 gaps across the two layers that actually change runtime behavior: **C1, C2, C6, C7, C8, U13, U14, U15, U16, U17, U18**.

**Why this sprint, why now:**

1. The remaining Attractor gaps are mostly validation, event-shape, or naming issues. The remaining agent-loop and LLM gaps still change how work executes, fails, and recovers.
2. INTENT.md makes the coding-agent loop the engine inside `codergen` nodes. If that loop reads the wrong instructions, dies after 12 turns, leaks child processes, or loses provider data, every higher-level Nectar feature inherits that instability.
3. This is one coherent cut across `src/agent-loop/` and `src/llm/`. It improves the same execution path used by CLI runs, HTTP runs, and future Hive workflows without adding product-surface churn.

**Out of scope:**

- Web UI, Seedbed, Swarm Intelligence, or new CLI commands
- Remaining Attractor gaps (A1-A6)
- Model catalog refresh (U3)
- Optional adapter lifecycle/interface gaps (U1, U2, U4-U12, U19)
- Native-provider prompt parity (C12)

**Opinionated call:** do not spend this sprint on model catalog freshness or prompt cosmetics. Fix instruction scope, limit semantics, process cleanup, and tool/error correctness first. Those are the gaps that make the runtime lie to users today.

---

## Use Cases

1. **Nested instructions resolve correctly:** A session launched from `packages/api/` reads instruction files from the repo root down to `packages/api/`, with deeper files taking precedence and provider-specific files winning over `AGENTS.md` in the same directory.

2. **Long-running agent work does not fail by default:** A `codergen` node that needs 27 turns and 19 tool rounds completes normally when no explicit limit is set. `0` means unlimited, not immediate failure.

3. **Child agents can be bounded intentionally:** `spawn_agent` accepts `max_turns`, and a caller can choose either a hard cap (`max_turns: 4`) or an explicit unlimited child (`max_turns: 0`) instead of inheriting hidden behavior.

4. **Timeouts and aborts kill the whole shell tree:** A shell command that spawns background grandchildren is fully terminated on timeout or session abort. No orphan processes continue writing files after Nectar says the command stopped.

5. **Malformed tool calls fail less often and fail more clearly:** If a model emits a valid tool name with slightly wrong arguments, Nectar repairs the call once in a deterministic way, emits a warning, and proceeds. If the call is unsafe or unrecoverable, it fails closed without executing the tool.

6. **Provider errors are classified correctly:** HTTP 408 becomes a non-retryable request-timeout error, HTTP 413 becomes a context-length error, HTTP 422 becomes an invalid-request error, and retry middleware calls `on_retry` before every actual retry.

7. **Anthropic reasoning round-trips without data loss:** `redacted_thinking` blocks preserve their opaque `data` payload across request/response translation so follow-up turns do not silently discard provider state.

---

## Architecture

### Workstream A: Session Semantics and Process Control

`discoverInstructions()` must stop treating `workspace_root` as both the top and the bottom of the precedence chain. The correct model is: find the repo root, walk from repo root toward the session's effective cwd, and compose instruction files in that order so deeper files win. Within a directory, `AGENTS.md` is lower precedence than the provider-specific file for that provider.

Loop limits need one shared semantic everywhere: `0` means unlimited, positive integers are hard caps. That semantic must apply in `AgentSession`, in the subagent path, and in the bridge from `codergen` node attributes into session config. Do not scatter raw `while (count < max)` checks anymore; add helper predicates so the meaning is explicit and testable.

Shell execution should be process-group based, not best-effort child killing. `LocalExecutionEnvironment.exec()` becomes the owner of subprocess lifecycle, including group creation, timeout handling, abort handling, and group teardown. The shell tool stays a thin formatter on top of that primitive.

### Workstream B: Tool-Call Contract Hardening

Create one shared, deterministic tool-call repair pipeline and use it in both places that execute model tool calls: `UnifiedClient.generate()` and `AgentSession.processWorkItem()`. Do not add a second hidden LLM round-trip to "repair" tools. Repair must be local, conservative, and auditable.

The repair pipeline should do four things only:

1. Validate tool names against the spec regex and 64-character cap.
2. Parse arguments, with only a very narrow recovery path for empty payloads and trivial JSON issues.
3. Apply safe schema-guided coercions and key stripping.
4. Revalidate with AJV before execution.

If repair cannot produce a valid argument object in one pass, return a structured invalid-tool-call error and do not execute the tool.

### Workstream C: Provider Error and Reasoning Fidelity

Provider adapters are the boundary where raw HTTP/provider behavior must be normalized into the unified error model. This sprint fixes timeout retryability, adds the missing explicit status mappings, and adds the missing retry callback so callers can observe backoff decisions.

Anthropic `redacted_thinking` stays opaque. Nectar should store and forward the `data` blob unchanged, never inspect it, never log it, and never drop it.

### No New Product Surfaces

This sprint does not add commands, routes, screens, or new user-facing workflows. It is a runtime-correctness sprint. The output is higher trust in the execution path Nectar already has.

---

## Implementation phases

### Phase 1: Instruction Precedence and Unlimited-Loop Semantics (~30%)

**Files:** `src/agent-loop/project-instructions.ts`, `src/agent-loop/session.ts`, `src/agent-loop/types.ts`, `src/agent-loop/subagent-manager.ts`, `src/agent-loop/tools/spawn-agent.ts`, `src/handlers/codergen.ts`, `test/agent-loop/project-instructions.test.ts`, `test/agent-loop/session.test.ts`, `test/agent-loop/subagent-manager.test.ts`, `test/integration/agent-loop.test.ts`

**Tasks:**

- [ ] Change `discoverInstructions()` to accept the session start directory or effective cwd, not just `workspace_root`.
- [ ] Resolve repo root via `git rev-parse --show-toplevel`; if git is unavailable or the cwd is outside a repo, fall back to `workspace_root`.
- [ ] Walk from repo root toward cwd, not the other way around.
- [ ] Apply precedence rules explicitly:
  - Shallower directories first, deeper directories last
  - `AGENTS.md` before provider-specific files in the same directory
  - Provider-specific files override generic files in the same directory
- [ ] Preserve the 32 KB total instruction budget while dropping lowest-precedence content first.
- [ ] Change `DEFAULT_SESSION_CONFIG.max_turns` and `DEFAULT_SESSION_CONFIG.max_tool_rounds_per_input` from `12` and `10` to `0`.
- [ ] Add helper semantics for limits so `0` means unlimited everywhere, including session turn loops and tool-round loops.
- [ ] Extend `spawnAgentSchema` to accept `max_turns`.
- [ ] Thread `max_turns` through the subagent path and make `0` a valid explicit override.
- [ ] Keep the default child limit finite when omitted. Parent sessions become unlimited by default; spawned children stay explicitly bounded unless the caller opts out.
- [ ] Add regression tests for:
  - nested instruction precedence
  - repo-root-to-cwd ordering
  - default unlimited sessions exceeding 12 turns and 10 tool rounds
  - `spawn_agent(max_turns: 0)` vs `spawn_agent(max_turns: 4)`

### Phase 2: Process-Group Execution and Clean Aborts (~20%)

**Files:** `src/agent-loop/execution-environment.ts`, `src/agent-loop/tools/shell.ts`, `test/agent-loop/tools/shell.test.ts`, `test/agent-loop/execution-environment-scoped.test.ts`, `test/fixtures/process-tree.mjs`

**Tasks:**

- [ ] Rework `LocalExecutionEnvironment.exec()` so commands run in a dedicated process group on macOS/Linux.
- [ ] On timeout, kill the entire process group, not just the immediate shell process.
- [ ] On abort, kill the entire process group and return a clean cancelled result.
- [ ] Preserve current environment filtering, cwd scoping, stdout/stderr capture, and timeout result shape.
- [ ] Keep the shell tool dumb: it should format the result, not own kill semantics.
- [ ] Add a fixture script that spawns a child plus a grandchild and writes a heartbeat file.
- [ ] Add tests proving the heartbeat stops after timeout and after abort, which is the only evidence that matters here.
- [ ] Do not paper over process cleanup with longer test timeouts.

### Phase 3: Tool Name Validation and Deterministic Repair (~25%)

**Files:** `src/llm/tool-repair.ts`, `src/llm/tools.ts`, `src/llm/client.ts`, `src/agent-loop/tool-registry.ts`, `src/agent-loop/session.ts`, `test/llm/tool-repair.test.ts`, `test/llm/tools.test.ts`, `test/agent-loop/session.test.ts`

**Tasks:**

- [ ] Add `validateToolName()` enforcing `[a-zA-Z][a-zA-Z0-9_]*` and max length 64.
- [ ] Validate names when tools are registered and again before provider request translation.
- [ ] Create `repairToolCall()` as a deterministic helper shared by the unified client and the agent loop.
- [ ] Limit repair to safe cases:
  - empty argument payload -> `{}`
  - trivial JSON cleanup for one narrow malformed-input class
  - strip unknown keys when the schema does not allow extras
  - coerce string-to-boolean / string-to-integer / string-to-number only when lossless
- [ ] Never invent missing required fields.
- [ ] Never execute a tool after failed repair.
- [ ] Emit a warning when repair changed the call so transcripts and event consumers can see that Nectar intervened.
- [ ] Add tests for:
  - invalid tool names rejected
  - safe repair succeeds once
  - unknown keys are stripped
  - lossy coercions are rejected
  - unrecoverable calls fail closed
  - repaired calls execute exactly once

### Phase 4: Provider Error Mapping, Retry Hooks, and Anthropic Redacted Thinking (~20%)

**Files:** `src/llm/errors.ts`, `src/llm/retry.ts`, `src/llm/types.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `test/llm/errors.test.ts`, `test/llm/retry.test.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/gemini.test.ts`, `test/llm/openai-compatible.test.ts`, `test/llm/redacted-thinking.test.ts`

**Tasks:**

- [ ] Make `TimeoutError` non-retryable and give it status code `408`.
- [ ] Add spec-named compatibility subclasses:
  - `RequestTimeoutError extends TimeoutError`
  - `ContextLengthError extends ContextWindowError`
- [ ] Map HTTP 408 to `RequestTimeoutError`, HTTP 413 to `ContextLengthError`, and HTTP 422 to `InvalidRequestError` in all provider adapters.
- [ ] Add `on_retry(error, attempt, delay)` to `RetryConfig` and call it before each actual retry sleep.
- [ ] Ensure timeout-derived errors are never retried by retry middleware.
- [ ] Add `data?: unknown` to `RedactedThinkingContentPart`.
- [ ] Preserve `redacted_thinking.data` in Anthropic request translation and response translation.
- [ ] Add tests covering:
  - timeout retryability is false
  - 408/413/422 mapping in each adapter
  - `on_retry` callback order and arguments
  - `redacted_thinking.data` round-trips unchanged across turns

### Phase 5: Verification and Compliance Report Refresh (~5%)

**Files:** `docs/compliance-report.md`

**Tasks:**

- [ ] `npm run build` passes with zero TypeScript errors.
- [ ] `npm test` passes with zero failures.
- [ ] Update `docs/compliance-report.md` so C1, C2, C6, C7, C8, U13, U14, U15, U16, U17, and U18 move from **GAPS** to **IMPLEMENTED**.
- [ ] Verify the report language matches the shipped behavior, especially the opinionated choice that parent sessions default to unlimited while child sessions remain finite unless explicitly overridden.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/project-instructions.ts` | Modify | Correct repo-root-to-cwd instruction discovery and precedence |
| `src/agent-loop/session.ts` | Modify | Use effective cwd for instruction loading; honor unlimited loop semantics; run repaired tool calls |
| `src/agent-loop/types.ts` | Modify | Change default session limits to `0` and document unlimited semantics |
| `src/agent-loop/subagent-manager.ts` | Modify | Thread explicit child `max_turns` and support `0` override |
| `src/agent-loop/tools/spawn-agent.ts` | Modify | Expose `max_turns` in the tool schema |
| `src/handlers/codergen.ts` | Modify | Bridge node/session config cleanly into the new limit semantics |
| `src/agent-loop/execution-environment.ts` | Modify | Move command execution to process-group lifecycle control |
| `src/agent-loop/tools/shell.ts` | Modify | Keep shell tool formatting aligned with new timeout/abort behavior |
| `src/agent-loop/tool-registry.ts` | Modify | Reject invalid tool names at registration time |
| `src/llm/tool-repair.ts` | Create | Shared deterministic tool-call validation and repair helpers |
| `src/llm/tools.ts` | Modify | Reuse shared tool-name validation helpers |
| `src/llm/client.ts` | Modify | Apply tool-call repair in the unified tool loop |
| `src/llm/errors.ts` | Modify | Fix timeout retryability and add spec-named compatibility subclasses |
| `src/llm/retry.ts` | Modify | Add `on_retry` callback and respect non-retryable timeouts |
| `src/llm/types.ts` | Modify | Add opaque `data` field to `redacted_thinking` content parts |
| `src/llm/adapters/anthropic.ts` | Modify | Round-trip `redacted_thinking.data`; map HTTP status codes correctly |
| `src/llm/adapters/openai.ts` | Modify | Add explicit 408/413/422 error mapping |
| `src/llm/adapters/gemini.ts` | Modify | Add explicit 408/413/422 error mapping |
| `src/llm/adapters/openai-compatible.ts` | Modify | Add explicit 408/413/422 error mapping |
| `test/agent-loop/project-instructions.test.ts` | Modify | Verify nested precedence and budget trimming |
| `test/agent-loop/session.test.ts` | Modify | Verify unlimited defaults and repaired tool-call execution path |
| `test/agent-loop/subagent-manager.test.ts` | Modify | Verify explicit child `max_turns` behavior |
| `test/agent-loop/tools/shell.test.ts` | Modify | Verify timeout/abort kills the full process tree |
| `test/integration/agent-loop.test.ts` | Modify | End-to-end proof that long sessions no longer fail at old defaults |
| `test/fixtures/process-tree.mjs` | Create | Deterministic child/grandchild fixture for killability tests |
| `test/llm/tool-repair.test.ts` | Create | Unit tests for deterministic repair rules |
| `test/llm/tools.test.ts` | Modify | Validate tool-name enforcement and repair integration |
| `test/llm/errors.test.ts` | Modify | Verify timeout/context error taxonomy and retryability |
| `test/llm/retry.test.ts` | Modify | Verify `on_retry` callback and timeout no-retry behavior |
| `test/llm/adapters/anthropic.test.ts` | Modify | Verify HTTP mapping and `redacted_thinking.data` round-trip |
| `test/llm/adapters/openai.test.ts` | Modify | Verify HTTP mapping |
| `test/llm/adapters/gemini.test.ts` | Modify | Verify HTTP mapping |
| `test/llm/openai-compatible.test.ts` | Modify | Verify HTTP mapping |
| `test/llm/redacted-thinking.test.ts` | Create | Focused regression coverage for opaque redacted-thinking payloads |
| `docs/compliance-report.md` | Modify | Mark the sprint's closed gaps as implemented |

---

## Definition of Done

- [ ] `discoverInstructions()` walks from repo root toward cwd, not upward from workspace root.
- [ ] Deeper directories override shallower ones, and provider-specific files override `AGENTS.md` in the same directory.
- [ ] The 32 KB instruction budget still applies after precedence changes.
- [ ] `DEFAULT_SESSION_CONFIG.max_turns === 0` and `DEFAULT_SESSION_CONFIG.max_tool_rounds_per_input === 0`.
- [ ] `0` is interpreted as unlimited in session turn loops and tool-round loops.
- [ ] An integration test proves a session can exceed 12 turns and 10 tool rounds without failing when limits are omitted.
- [ ] `spawn_agent` accepts `max_turns`, and child sessions honor both explicit finite values and explicit `0`.
- [ ] Timeout or abort kills the full command process group, including grandchildren.
- [ ] Tool names outside `[a-zA-Z][a-zA-Z0-9_]*` or longer than 64 characters are rejected before execution.
- [ ] Deterministic repair fixes safe argument mismatches exactly once and emits a warning.
- [ ] Failed repair never executes the underlying tool handler.
- [ ] `TimeoutError.retryable === false`.
- [ ] Adapters map HTTP 408 to `RequestTimeoutError`, 413 to `ContextLengthError`, and 422 to `InvalidRequestError`.
- [ ] Retry middleware invokes `on_retry(error, attempt, delay)` before every actual retry sleep.
- [ ] `redacted_thinking.data` round-trips through Anthropic request/response translation unchanged.
- [ ] `docs/compliance-report.md` no longer lists C1, C2, C6, C7, C8, U13, U14, U15, U16, U17, or U18 as open gaps.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] No test timeout values were increased to achieve green.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Instruction precedence change breaks brittle snapshot expectations | Medium | Medium | Add explicit ordering tests and keep precedence rules small, documented, and deterministic |
| Unlimited defaults allow runaway parent sessions | Medium | High | Keep loop detection enabled, keep explicit per-node overrides, and keep child sessions finite by default |
| Process-group behavior differs between macOS and Linux | Medium | High | Use one POSIX implementation with feature detection, and prove killability with a real process-tree fixture |
| Deterministic repair overreaches and mutates valid calls | Medium | High | Keep repair conservative, single-pass, and schema-driven; emit a warning on every repaired call |
| Error taxonomy aliases break existing callers | Low | Medium | Add compatibility subclasses instead of renaming existing base classes out from under callers |
| Redacted-thinking payloads grow unexpectedly large | Low | Medium | Treat the payload as opaque data, avoid logging it, and keep it only where the message content model already stores provider data |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Pinned spec snapshot already reflected by `docs/compliance-report.md` | Source of truth for the exact gap definitions this sprint closes |
| `git` CLI when available | Resolve repo root for instruction precedence; fall back to `workspace_root` when unavailable |
| `execa` | Existing subprocess library; reused for process-group execution and teardown |
| `ajv` | Existing schema validator; reused for post-repair revalidation |
| `vitest` | Existing test runner for unit and integration coverage |

No new runtime package should be added unless process-group teardown proves unreliable on both macOS and Linux with the existing stack.
