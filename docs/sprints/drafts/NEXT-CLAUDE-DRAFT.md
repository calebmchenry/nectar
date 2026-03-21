# Sprint 036: Green Suite and Parallel Compliance Loop

## Overview

**Goal:** Make `npm test` pass with zero failures and update `compliance-loop.dot` to use parallel fan-out/fan-in — proving the engine's most complex feature works end-to-end in the project's flagship pipeline.

**Why this sprint, why now:**

1. **The test suite has been red for 10+ consecutive sprints.** Sprints 025 through 035 all listed "green suite" as a goal. All failed. The common failure mode: mixing test fixes with large feature work, running out of scope, and shipping the features without landing the test fixes. Sprint 035 closed every remaining compliance gap but left 5 tests still failing. This sprint does the opposite — tests first, everything else second.

2. **The 5 failures have distinct, known root causes.** They are not entangled: fan-in handler propagates branch failure status instead of reporting selection success (2 tests), `toStatusResponse()` bypasses `resolveCurrentNode()` logic (1 test), engine never emits `pipeline_failed` when a failed node's edge reaches an exit (1 test), and the hive-seedbed-flow cascades from the above (1 test). Each fix is surgical — 5–20 lines of production code per fix.

3. **The compliance loop is still sequential despite parallel handlers existing since Sprint ~020.** The `compliance-loop.dot` has 3 independent draft nodes and 3 independent critique nodes that could run concurrently. INTENT.md §9 explicitly says: "Next sprint MUST prioritize parallel execution." The parallel and fan-in handlers are implemented and tested. The flagship pipeline simply hasn't been updated to use them. This is a one-file change with high demo value.

4. **No compliance gaps remain to close.** The compliance report shows all gaps either closed or deliberately deferred with justification. This sprint can focus entirely on quality and correctness — no new feature surface area.

**Scope:** Fix 5 failing tests (hard gate). Harden the three integration seams that cause them. Update `compliance-loop.dot` to fan-out/fan-in. Add regression tests.

**Out of scope:**
- New product features, CLI commands, or UI components
- Compliance gap work (all closed or deliberately deferred)
- Shell completions, packaging, or distribution changes
- Deliberate deferrals (A4, C2, C3, L3, L5, L7, L8)
- Performance optimization or refactoring

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures, zero timeouts, no inflated timeout values. No tests `.skip`-ed or disabled.

2. **Fan-in selects a branch and the pipeline completes.** A prompted fan-in pipeline where the LLM selects a successful branch completes the run with `status: 'completed'`. The fan-in handler's job is to *select*, not to re-judge — selection success and branch status are separate concerns.

3. **Fan-in routes on selected branch status.** A fan-in that selects a failed branch still returns `status: 'success'` (selection succeeded). Downstream edges can route on `context.fan_in_selected_status=failure` to handle the failure case explicitly.

4. **Live run state is truthful.** `GET /pipelines/:id` during an active run returns `current_node` reflecting the node currently executing, not `undefined`.

5. **Failed pipelines emit terminal events.** A pipeline where a tool node fails and edges lead to an exit node emits `pipeline_failed` exactly once. The event stream, REST status, and context all agree on the terminal state.

6. **Server shuts down promptly.** `server.close()` terminates all SSE connections and resolves within 5 seconds. No test afterEach hook timeouts.

7. **The compliance loop runs in parallel.** `nectar run gardens/compliance-loop.dot` fans out 3 draft nodes concurrently, fans in, then fans out 3 critique nodes concurrently, fans in, and merges. Wall-clock time drops proportionally.

---

## Architecture

### Principle: Fix First, Prove Second

Phase 1 is a hard gate. Phase 2 does not begin until `npm test` is green. Phase 3 (parallel compliance loop) is the reward — it's the visible, demo-worthy outcome that proves the engine works.

### Design Decisions

**1. Fan-in selection success is orthogonal to branch status.**

The fan-in handler always returns `status: 'success'` when it successfully selects a branch, regardless of the selected branch's own status. The selected branch's status is available in `context.fan_in_selected_status` for downstream edge conditions. This separates two concerns: "did selection work?" (handler status) and "did the selected work succeed?" (context variable).

Sprint 035's compliance gap work (A1–A5, C1–C6, L1–L6) already established the `context_updates` contract. Fan-in just needs to use it correctly.

**2. `resolveCurrentNode()` is the single source of truth for active node.**

The `getStatus()` method correctly calls `resolveCurrentNode()`. The problem is that the REST endpoint's `toStatusResponse()` helper bypasses it. The fix is to pass the resolved `current_node` through to `toStatusResponse()` rather than duplicating the resolution logic.

**3. `pipeline_failed` must fire when the run's outcome is failure, regardless of which node was last.**

The current check in `resolveTerminalFailure()` only looks at the last completed node. When a failed tool node's edge leads to an exit node, the exit node succeeds, masking the earlier failure. The fix: track whether any non-recovered failure occurred during the run and use that to determine terminal status.

**4. The compliance loop uses `component` (parallel) and `tripleoctagon` (fan-in) shapes.**

The existing sequential `claude_draft -> codex_draft -> gemini_draft` chain becomes: `start -> draft_fan_out [shape=component] -> {claude_draft, codex_draft, gemini_draft}` with `draft_fan_in [shape=tripleoctagon]` collecting results. Same pattern for the critique phase.

### Test Fix Strategy

| Test File | Test Name | Root Cause | Fix |
|-----------|-----------|------------|-----|
| `fan-in-llm.test.ts` | persists selected branch… | Fan-in `runPromptedPath` returns selected branch's status instead of `'success'` for selection | Return `status: 'success'` always; put `selected.status` in `context_updates` only |
| `fan-in-llm.test.ts` | allows downstream routing… | Same handler bug causes pipeline to fail before reaching conditional routing | Same fix as above |
| `http-server.test.ts` | cancels active runs… | `toStatusResponse()` reads `entry.current_node` directly instead of using `resolveCurrentNode()` | Pass resolved `current_node` from `getStatus()` into `toStatusResponse()` |
| `pipeline-events.test.ts` | emits pipeline_failed… | `resolveTerminalFailure()` only checks last completed node; exit node masks prior failure | Track `terminalFailure` when any node fails without recovery; check before `finishCompleted()` |
| `hive-seedbed-flow.test.ts` | creates seed, runs… | Cascading: run never completes due to above engine/server bugs | Fixed by the above three fixes |

---

## Implementation

### Phase 1: Green Suite — Fix the Five Failing Tests (~40%)

**Hard rule:** Phase 2 does not begin until `npm test` passes with zero failures.

#### 1a. Fix fan-in handler status propagation

**Files:** `src/handlers/fan-in.ts`, `test/integration/fan-in-llm.test.ts`

- [ ] In `runPromptedPath()`: change the return to always use `status: 'success'` when selection succeeds. The selected branch's original status goes into `context_updates.fan_in_selected_status` (already partially there). Remove any code path that returns the selected branch's status as the handler's own status.
- [ ] In `runHeuristicPath()`: apply the same fix — return `status: 'success'` for selection success; put branch status in context.
- [ ] Verify both failing fan-in-llm tests pass. Add a regression test: fan-in selects a failed branch, pipeline routes on `context.fan_in_selected_status=failure`, reaches `handled_failure` exit — run completes successfully.

#### 1b. Fix current_node resolution in status endpoint

**Files:** `src/server/run-manager.ts`

- [ ] Modify `toStatusResponse()` to accept an optional `resolvedCurrentNode` parameter. When provided, use it instead of `entry.current_node`.
- [ ] In `getStatus()`, pass the result of `resolveCurrentNode()` into `toStatusResponse()`.
- [ ] Alternatively: subscribe to `node_started`/`node_completed` events on the RunManager entry and maintain `entry.current_node` from those events, so `toStatusResponse()` always has a fresh value.
- [ ] Verify the http-server test passes: `current_node` is defined during active runs.

#### 1c. Fix pipeline_failed emission for masked failures

**Files:** `src/engine/engine.ts`

- [ ] Add a `runHadUnrecoveredFailure: boolean` flag to the engine's run state. Set it to `true` when a node completes with `status: 'failure'` and the failure was not recovered by retry or allow_partial.
- [ ] In the terminal path (before `finishCompleted()`), check `runHadUnrecoveredFailure`. If true, call `emitPipelineFailed()` with the first unrecovered failure's node ID and reason.
- [ ] The existing `pipelineFailedEmitted` guard prevents double-emission.
- [ ] Verify the pipeline-events test passes: a pipeline with `start -> bad_tool(exit 42) -> done(exit)` emits `stage_failed`, `run_error`, and exactly one `pipeline_failed`.

#### 1d. Verify hive-seedbed-flow passes

**Files:** `test/integration/hive-seedbed-flow.test.ts`

- [ ] Run the hive-seedbed-flow test after fixes 1a–1c. It should pass without additional changes since its failure cascades from the above bugs.
- [ ] If it still fails, investigate the specific failure and fix. Most likely cause: SSE connection cleanup. If so, apply the SSE `closeAll()` fix from Phase 2 early.

#### 1e. Gate check

- [ ] Run `npm test`. **All tests must pass. Zero failures, zero timeouts.**

### Phase 2: Integration Seam Hardening (~25%)

**Files:** `src/server/sse.ts`, `src/server/server.ts`, `src/engine/engine.ts`, `src/server/run-manager.ts`

#### 2a. SSE connection lifecycle

- [ ] In `src/server/sse.ts`: maintain a `Set<ServerResponse>` of active SSE connections. Add connections on stream creation. Remove on `close` event (client disconnect) and `error` event. Add a `closeAll()` method that writes a final comment, calls `.end()` on each connection, and clears the set.
- [ ] In `src/server/server.ts`: call `sse.closeAll()` before `httpServer.close()`. Add a 5-second hard timeout on shutdown: if `httpServer.close()` hasn't resolved, force-destroy remaining sockets.
- [ ] Add test: open 3 SSE connections, disconnect 1 client, call `closeAll()`, verify all connections are ended and the set is empty.

#### 2b. Engine terminal event robustness

- [ ] Add integration test: a pipeline with a diamond conditional where one path fails and then routes to exit via a fallback edge — verify `pipeline_failed` is emitted exactly once.
- [ ] Add integration test: a pipeline that succeeds on all nodes — verify `pipeline_failed` is NOT emitted.
- [ ] Add integration test: a pipeline that fails, retries, and succeeds — verify `pipeline_failed` is NOT emitted (retry recovered the failure).

#### 2c. Run-manager event-driven state

- [ ] In `src/server/run-manager.ts`: ensure `node_started` events update `entry.current_node` and `node_completed` events clear it. This makes `current_node` always reflect the engine's live state, even before the engine object is directly queryable.
- [ ] Add test: start a run, poll status immediately, verify `current_node` transitions from the start node through each subsequent node.

### Phase 3: Parallel Compliance Loop (~25%)

**Files:** `gardens/compliance-loop.dot`, `scripts/compliance_loop.mjs`, `test/integration/run.test.ts`

#### 3a. Update compliance-loop.dot

- [ ] Replace the sequential draft chain (`claude_draft -> codex_draft -> gemini_draft`) with:
  ```dot
  audit -> draft_fan_out [shape=component, label="Fan Out Drafts"]
  draft_fan_out -> claude_draft
  draft_fan_out -> codex_draft
  draft_fan_out -> gemini_draft
  claude_draft -> draft_fan_in [shape=tripleoctagon, label="Merge Drafts"]
  codex_draft -> draft_fan_in
  gemini_draft -> draft_fan_in
  ```
- [ ] Replace the sequential critique chain with the same parallel pattern:
  ```dot
  draft_fan_in -> critique_fan_out [shape=component, label="Fan Out Critiques"]
  critique_fan_out -> claude_critique
  critique_fan_out -> codex_critique
  critique_fan_out -> gemini_critique
  claude_critique -> critique_fan_in [shape=tripleoctagon, label="Merge Critiques"]
  codex_critique -> critique_fan_in
  gemini_critique -> critique_fan_in
  ```
- [ ] Ensure `draft_fan_in` and `critique_fan_in` use heuristic selection (no `prompt` attribute — the compliance loop's fan-in just picks the best by status rank).
- [ ] Validate the updated garden: `nectar validate gardens/compliance-loop.dot` passes with zero errors.

#### 3b. Update fixture script

- [ ] In `scripts/compliance_loop.mjs`: ensure the draft and critique operations are safe for concurrent execution. Each node should write to its own isolated output path using `NECTAR_NODE_ID` (or `POLLINATOR_NODE_ID`) to avoid file conflicts.
- [ ] Verify the script works when 3 instances run simultaneously (no shared mutable state).

#### 3c. Integration test

- [ ] Update or add an integration test that runs the parallel compliance loop end-to-end. Verify:
  - All 3 draft nodes execute (check node_completed events for each)
  - All 3 critique nodes execute
  - Fan-in nodes complete with `status: 'success'`
  - The merge node executes after both fan-in nodes
  - Final run status is `'completed'`
- [ ] Verify the run emits `ParallelStarted`, `BranchStarted`, `BranchCompleted`, and `ParallelCompleted` events for both fan-out phases.

### Phase 4: Verification (~10%)

- [ ] Run `npm run build` — zero TypeScript errors.
- [ ] Run `npm test` — all tests pass, zero failures.
- [ ] Manually run `npx tsx src/cli/index.ts run gardens/compliance-loop.dot` and verify parallel execution is observable in the output (multiple nodes starting before any complete).
- [ ] Update `gardens/compliance-loop.dot` header comment with the new parallel structure description.
- [ ] Remove the memory entry `project_parallel_dotfile_update.md` since the parallel update is now complete.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/handlers/fan-in.ts` | Modify | Always return `status: 'success'` on selection; branch status in context only |
| `src/server/run-manager.ts` | Modify | Pass resolved `current_node` through `toStatusResponse()`; event-driven state tracking |
| `src/engine/engine.ts` | Modify | Track unrecovered failures; emit `pipeline_failed` on masked terminal failures |
| `src/server/sse.ts` | Modify | Track SSE connections in a Set; add `closeAll()` with cleanup |
| `src/server/server.ts` | Modify | Call `sse.closeAll()` before shutdown; add 5s hard timeout |
| `gardens/compliance-loop.dot` | Modify | Replace sequential draft/critique chains with parallel fan-out/fan-in |
| `scripts/compliance_loop.mjs` | Modify | Ensure concurrent-safe execution using per-node output paths |
| `test/integration/fan-in-llm.test.ts` | Verify | Confirm both tests pass; add failed-branch routing regression test |
| `test/integration/http-server.test.ts` | Verify | Confirm `current_node` fix |
| `test/server/pipeline-events.test.ts` | Verify | Confirm `pipeline_failed` fix |
| `test/integration/hive-seedbed-flow.test.ts` | Verify | Confirm cascading fix |
| `test/integration/run.test.ts` | Modify | Add parallel compliance loop integration test |
| `test/server/sse-lifecycle.test.ts` | Modify | Add connection tracking and `closeAll()` tests |
| `test/engine/engine.test.ts` | Modify | Add masked-failure terminal event tests |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts
- [ ] No test timeout values were increased to achieve green
- [ ] No tests were `.skip`-ed, `.todo`-ed, or otherwise disabled to achieve green
- [ ] No existing tests regressed; test count is >= pre-sprint count
- [ ] The 5 previously-failing tests all pass: fan-in-llm (x2), http-server, pipeline-events, hive-seedbed-flow
- [ ] Fan-in handler returns `status: 'success'` on successful selection, regardless of selected branch status
- [ ] `context.fan_in_selected_status` is populated by fan-in and usable in downstream edge conditions
- [ ] `GET /pipelines/:id` returns defined `current_node` while a run is executing a node
- [ ] A pipeline where a tool fails and edges lead to exit emits exactly one `pipeline_failed`
- [ ] A pipeline where all nodes succeed does NOT emit `pipeline_failed`
- [ ] `server.close()` terminates SSE connections and resolves within 5 seconds
- [ ] `gardens/compliance-loop.dot` uses `component` (parallel) and `tripleoctagon` (fan-in) for draft and critique phases
- [ ] `nectar validate gardens/compliance-loop.dot` passes with zero errors
- [ ] Running the compliance loop shows parallel execution: multiple draft nodes start before any complete
- [ ] All 3 draft nodes and all 3 critique nodes execute during a compliance loop run
- [ ] ParallelStarted/BranchStarted/BranchCompleted/ParallelCompleted events are emitted for both fan-out phases

---

## Drop Line

If this sprint runs long, cut in this order (last item cut first):

1. **Keep (non-negotiable):** Phase 1 — green suite. This is the single most important outcome.
2. **Keep:** Phase 2a (SSE lifecycle) — prevents flaky test regressions.
3. **Keep:** Phase 3a (parallel compliance loop .dot file) — one-file change, high demo value.
4. **Defer first:** Phase 2b/2c (extra regression tests) — nice to have, not blocking.
5. **Defer second:** Phase 3b/3c (fixture script + integration test for parallel) — the .dot file itself is the deliverable; tests can follow.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Fan-in fix changes downstream behavior for existing gardens | Medium | High | Fix only changes what the handler returns; `context_updates` remain the same. The selected branch status was already in context — nothing downstream changes. Add regression test. |
| `runHadUnrecoveredFailure` flag is too coarse | Medium | Medium | Only set on genuine unrecovered failures (not retried, not allow_partial). Clear on successful retry. Add tests for retry-then-succeed and allow_partial scenarios. |
| SSE `closeAll()` drops in-flight events | Low | Low | Call `closeAll()` before `server.close()`, not during. Clients must handle reconnection anyway. Mid-write truncation during shutdown is acceptable. |
| Parallel compliance loop has race conditions in fixture script | Medium | Medium | Each node writes to `$NECTAR_RUN_DIR/$NECTAR_NODE_ID/` — fully isolated. No shared mutable state. |
| Parallel compliance loop increases test execution time | Low | Low | Parallel nodes run concurrently, so wall-clock time should decrease. If fixture scripts are CPU-bound, concurrency may not help, but they're I/O trivial. |
| Hive-seedbed-flow failure has a different root cause than assumed | Medium | Medium | Run it after fixes 1a–1c. If it still fails, pull SSE fix (Phase 2a) forward. The drop line allows deferring Phase 2 regression tests to keep scope tight. |
| Sprint scope creep from "just one more fix" | High | High | The drop line is strict. Phase 1 is the minimum viable sprint. Phase 3a is a single file edit. Everything else is bonus. 10 sprints of red suite prove that scope discipline is the #1 risk. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing test infrastructure (vitest, fixtures, SimulationProvider) | All test fixes use existing patterns |
| Existing parallel/fan-in handler implementations | Compliance loop update requires working `component` and `tripleoctagon` handlers |
| Existing `resolveCurrentNode()` in run-manager | Fix wires existing logic through to the status endpoint |
| Existing `pipelineFailedEmitted` dedup guard in engine | Terminal event fix builds on existing safety mechanism |
| No new runtime packages | Every change modifies existing files |
