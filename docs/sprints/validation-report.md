# Sprint 035 Validation Report

**Date:** 2026-03-21
**Sprint:** 035 — Green Suite or Bust — Fix the Four, Close the Contracts
**Validator:** automated

---

## Build

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run build` succeeds with zero errors | **PASS** | Build completes cleanly, Hive assets embedded, tsc reports no errors |

## Tests

| Check | Result | Evidence |
|-------|--------|----------|
| `npm test` passes all tests — zero failures, zero timeouts | **FAIL** | 5 tests failed across 4 test files out of 1217 total |
| No test timeout values increased to achieve green | **PASS** | Diff review shows no inflated timeout values in existing tests |
| No tests `.skip`-ed, `.todo`-ed, or otherwise disabled | **PASS** | Zero `.skip()`, `.todo()`, or `.only()` markers found across all test files |
| No existing tests regressed; test count ≥ pre-sprint count | **PASS** | 1217 total tests (pre-sprint: 1205); 7 new test files added |
| 4 previously-failing tests all pass: fan-in-llm, hive-seedbed-flow, http-server, pipeline-events | **FAIL** | All 4 still fail (see detail below) |

### Failing Tests Detail

1. **test/integration/fan-in-llm.test.ts** — "persists selected branch and rationale in context and artifacts": `expected 'failed' to be 'completed'` at line 93. Run ends in `failed` instead of `completed`.
2. **test/integration/fan-in-llm.test.ts** — "allows downstream routing on context.fan_in_selected_status when prompted fan-in selects a failed branch": `expected 400 to be 202` at line 153. Garden validation rejects `fan-in-routing.dot` (HTTP 400 instead of 202).
3. **test/integration/hive-seedbed-flow.test.ts** — "creates seed, uploads attachment, analyzes, synthesizes, and archives to honey": Hook timed out in 10000ms. `server.close()` does not terminate SSE connections promptly.
4. **test/integration/http-server.test.ts** — "cancels active runs and returns interrupted status with checkpoint_id": `expected undefined to be defined` at line 242. `current_node` is still undefined during active run.
5. **test/server/pipeline-events.test.ts** — "emits stage_failed and pipeline_failed while preserving run_error/node_completed": `expected array to include 'pipeline_failed'`. Terminal failure path does not emit `pipeline_failed`.

## Phase 1: Green Suite (Hard Gate)

| Check | Result | Evidence |
|-------|--------|----------|
| Fan-in-llm test passes | **FAIL** | 2 failures — run ends `failed` instead of `completed`; routing test gets 400 from garden validation |
| Hive-seedbed-flow shutdown test passes | **FAIL** | afterEach hook times out at 10s — `server.close()` not force-closing SSE connections |
| Http-server current_node test passes | **FAIL** | `current_node` undefined during active run — event-based tracking not implemented |
| Pipeline-events pipeline_failed test passes | **FAIL** | `pipeline_failed` not in event stream — terminal failure path still routes through `finishCompleted()` |

## Phase 2: Engine Outcome Contract

| Check | Result | Evidence |
|-------|--------|----------|
| A1: `NodeOutcome` has `notes` field; engine synthesizes fallback | **PASS** | `types.ts:18` has `notes?: string`; `engine.ts:1111-1125` `withSynthesizedOutcomeNotes()` provides fallback using error_message, exit_code, or generic note |
| A2: `writeNodeStatus()` persists canonical spec-shaped fields; codergen no conflicting `status.json` | **PASS** | `engine.ts:1082-1109` writes all 10 canonical fields; codergen writes `agent-status.json` only |
| A3: `condition="my_flag=true"` resolves via `context.my_flag` fallback; reserved roots take precedence | **PASS** | `conditions.ts:28` defines `RESERVED_ROOTS`; lines 195-201 implement context fallback; `conditions.test.ts` covers unqualified keys, dotted keys, reserved-root precedence |
| A5: `CONFIRMATION` type handled in auto-approve and wait.human | **PASS** | `auto-approve.ts:5-16` returns affirmative for CONFIRMATION; `wait-human.ts:213-217` renders affirmative/decline guidance; `wait-human.test.ts:67` verifies |

## Phase 3: Agent Session Accounting and Provider Semantics

| Check | Result | Evidence |
|-------|--------|----------|
| C1: `max_turns` counts across session lifetime; exhaustion emits `agent_turn_limit_reached` | **PASS** | `session.ts:70` `lifetimeTurnCount` incremented on every turn (line 480); never reset between inputs; `session.test.ts:128-159` verifies cross-input counting |
| C4: `agent_session_completed` event emitted with correct counts | **PASS** | `session.ts:1290-1298` emits with `status`, `turn_count`, `tool_call_count`, `duration_ms`; `events.ts:111-119` defines interface |
| C5: `agent_tool_call_completed` always includes `full_content` | **PASS** | `session.ts:973` sets `full_content: result.full_content ?? result.content` for normal calls; `session.ts:1193` sets `full_content: content` for subagent calls |
| C6: `ContextLengthError` emits warning, fails work item, returns to `AWAITING_INPUT` | **PASS** | `session.ts:614-625` catches error, calls `emitContextLengthRecoveryWarning()`, returns failure result; session transitions to `AWAITING_INPUT` (not CLOSED); `session.test.ts:677-731` verifies |
| L1: `StreamError` has `retryable: true`; retry only before content yielded | **PASS** | `errors.ts:122` sets `retryable: true`; `retry.ts:150-152` tracks `yieldedContent`; line 158 blocks retry after content |
| L2: Anthropic adapter raises `ContentFilterError` for filtered responses | **PASS** | `anthropic.ts:471-483` `isContentFiltered()` detects safety/policy keywords; line 572 throws `ContentFilterError`; `anthropic.test.ts:486-491` verifies |
| L6: `ProviderError` base has `retry_after_ms`; retry middleware consults generically | **PASS** | `errors.ts:5` defines `retry_after_ms?: number` on base `LLMError`; `retry.ts:75,129` reads from `lastError?.retry_after_ms`; `anthropic.test.ts:493-503` verifies |

## Phase 4: Compliance Report

| Check | Result | Evidence |
|-------|--------|----------|
| Compliance report reflects actual shipped state with source evidence | **PASS** | All 11 sprint-035 gap closures documented with source file citations |
| Stale entries corrected | **PASS** | Report condensed and updated; no stale claims found |
| Remaining gaps documented as deliberate deferrals with justification | **PASS** | A4, C2, C3, C7, L3-L5, L7, L8 all documented with rationale |

---

## Summary

| Category | Pass | Fail | Total |
|----------|------|------|-------|
| Build | 1 | 0 | 1 |
| Tests | 3 | 2 | 5 |
| Phase 1: Green Suite | 0 | 4 | 4 |
| Phase 2: Engine Outcome | 4 | 0 | 4 |
| Phase 3: Session & Provider | 7 | 0 | 7 |
| Phase 4: Compliance Report | 3 | 0 | 3 |
| **Total** | **18** | **6** | **24** |

## VERDICT: FAIL

### Failures

The **Phase 1 hard gate (green test suite) is not met.** All 4 previously-failing tests still fail:

1. **fan-in-llm** (2 test failures) — Fan-in handler still propagates branch failure status instead of returning success on selection. Additionally, the routing regression test's fixture `fan-in-routing.dot` fails garden validation.
2. **hive-seedbed-flow** (1 failure) — `server.close()` still does not force-close SSE connections, causing afterEach hook timeout.
3. **http-server** (1 failure) — `current_node` still undefined during active run; event-based node tracking not wired up.
4. **pipeline-events** (1 failure) — `pipeline_failed` still not emitted when terminal node fails; `finishCompleted()` path unchanged.

### What Passed

All Phase 2-4 compliance items pass (15/15). The code changes for A1, A2, A3, A5, C1, C4, C5, C6, L1, L2, and L6 are correctly implemented with test coverage. The compliance report is up-to-date with source evidence and deliberate deferrals documented.

### Root Cause

The sprint's own diagnosis holds: the 4 test failures have distinct, known root causes that were not fixed. The Phase 1 "fix first" strategy was not executed — compliance work (Phases 2-3) was completed while the blocking test fixes were not.
