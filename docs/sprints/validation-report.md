# Sprint 017 Validation Report

Validated on `2026-03-20T09:46:33Z` against `docs/sprints/SPRINT-017.md`.

Overall result: **FAIL**

- DoD items checked: `45`
- Passed: `34`
- Failed: `11`
- Required exit status: `1`

## Scope Note

- `git status --short` showed a dirty worktree. Validation was performed against the current tree contents without discarding local changes.
- `npm run build` and `npm test` were run as requested.
- Additional focused runtime probes were run against the built CLI and runtime modules where the DoD required behavior that was not directly covered by the automated tests.

## Commands Run

- `git status --short`
- `npm run build` -> exit `0`
- `npm test` -> exit `0`; Vitest reported `89` passed files and `850` passed tests
- `npx vitest run test/garden/parse.test.ts test/garden/validate.test.ts test/handlers/manager-loop.test.ts test/integration/manager-loop.test.ts test/integration/loop-restart.test.ts test/agent-loop/tool-hooks.test.ts test/agent-loop/parallel-tools.test.ts test/agent-loop/subagent-session-integration.test.ts test/integration/run.test.ts test/integration/resume.test.ts` -> exit `0`; `10` passed files / `142` passed tests
- `node --input-type=module` validation probe against `test/fixtures/manager-basic.dot` -> `0` diagnostics
- `node /Users/caleb.mchenry/code/nectar/dist/cli/index.js run gardens/restart-twice.dot` in a temp workspace -> exit `0`; created a 3-run restart chain and finished successfully
- `node /Users/caleb.mchenry/code/nectar/dist/cli/index.js status <mid-chain-run-id>` in that temp workspace -> exit `0`; printed `Lineage:` with predecessor, successor, and restart depth
- `node /Users/caleb.mchenry/code/nectar/dist/cli/index.js resume <first-run-id> --force` in that temp workspace -> exit `0`; resumed the latest run in the chain and completed it
- `node` runtime probe against `ManagerLoopHandler` attach semantics -> nonexistent run fell through to `exceeded max_cycles`; already-completed child run attached as `success`
- `node` runtime probe against `ManagerLoopHandler` parent-abort semantics -> parent returned after about `1049ms` and the owned child checkpoint still ended `completed`
- `node` runtime probe against `ManagerLoopHandler` max-cycles enforcement -> returned `Manager node 'supervisor' exceeded max_cycles (1).`
- `node` runtime probe against manager steering events -> emitted `child_steer_note_written`

## Failed Items

- Manager attach semantics are incomplete: missing-key failure exists, but nonexistent runs do not fail clearly and already-terminal runs are treated as successful attachments.
- Parent interrupt does not abort owned child runs; the manager waits for the child to finish.
- Post-hook failures are not logged from actual agent sessions.
- Hook artifact persistence is not wired into `AgentSession`, so parallel hook artifact isolation is not implemented.
- Hook subprocesses are not given an explicit run-workspace `cwd`.
- `tool_hook_blocked` is declared and rendered but never emitted.
- Automated coverage is missing required manager attach-failure, parent-interrupt, restart-CLI, mid-chain-status, and hook integration cases.

## Build & Regression

- PASS 1. `npm run build` succeeded with zero errors. Evidence: command exit `0`.
- PASS 2. `npm test` passed all existing tests. Evidence: Vitest summary `89` files / `850` tests.
- PASS 3. Old cocoons without lineage fields resume cleanly. Evidence: `test/integration/loop-restart.test.ts:248-282`.

## Manager Loop

- PASS 4. `house` shape maps to `stack.manager_loop` and passes validation without warnings. Evidence: `src/garden/types.ts:1`, `src/garden/types.ts:97-145`, `test/garden/parse.test.ts:162-183`, plus the runtime validation probe on `test/fixtures/manager-basic.dot` returned `0` diagnostics.
- PASS 5. `ManagerLoopHandler` starts a child `PipelineEngine` and polls to completion. Evidence: `src/engine/child-run-controller.ts:48-80`, `src/handlers/manager-loop.ts:35-54`, `test/handlers/manager-loop.test.ts:71-86`, `test/integration/manager-loop.test.ts:29-76`.
- FAIL 6. `stack.child_autostart=false` does not fail clearly for nonexistent or already-terminal runs. Evidence: `src/engine/child-run-controller.ts:83-87` performs no attach validation; `src/handlers/manager-loop.ts:55-63` only checks the missing-key case; the attach probe returned `Manager node 'supervisor' exceeded max_cycles (2).` for a nonexistent run and returned `status: "success"` when attaching to a completed child run.
- PASS 7. `manager.poll_interval` is duration-parsed and the validator enforces the 1s minimum. Evidence: `src/garden/parse.ts:165-171`, `src/garden/validate.ts:316-367`, `test/garden/validate.test.ts:305-335`.
- PASS 8. `manager.max_cycles` exceeding returns `FAILURE`. Evidence: `src/handlers/manager-loop.ts:172-177`, plus the runtime max-cycles probe returned `Manager node 'supervisor' exceeded max_cycles (1).`
- PASS 9. `manager.stop_condition` is evaluated against parent context including `stack.child.*`, and missing keys evaluate false. Evidence: `src/handlers/manager-loop.ts:137-149`, `test/handlers/manager-loop.test.ts:132-160`.
- PASS 10. `manager.actions` validation and the `steer` -> prompt requirement are enforced as errors. Evidence: `src/garden/validate.ts:285-355`, `test/garden/validate.test.ts:182-202`, `test/garden/validate.test.ts:237-303`.
- PASS 11. Steering notes are guarded at-most-once per tuple and written through atomic control-file writes. Evidence: `src/handlers/manager-loop.ts:121-135`, `src/engine/child-run-controller.ts:113-132`, `src/checkpoint/run-store.ts:142-145`, `src/checkpoint/run-store.ts:176-188`.
- PASS 12. Child engines consume steering notes before executing the next node. Evidence: `src/engine/engine.ts:292-300`, `src/engine/engine.ts:534-545`.
- FAIL 13. Parent interrupt does not abort owned child runs. Evidence: `src/handlers/manager-loop.ts:69-76` calls `abortOwnedChild()`, but `src/engine/child-run-controller.ts:134-144` only waits for the child promise to settle; the runtime abort probe took about `1049ms` and the owned child checkpoint still finished `completed`.
- PASS 14. `stack.child.*` context keys are populated from child snapshots. Evidence: `src/handlers/manager-loop.ts:102-110`, `test/handlers/manager-loop.test.ts:120-130`, `test/integration/manager-loop.test.ts:104-144`.
- PASS 15. Manager-loop events are emitted. Evidence: `src/handlers/manager-loop.ts:48-53`, `src/handlers/manager-loop.ts:112-119`, `src/handlers/manager-loop.ts:128-132`, `test/handlers/manager-loop.test.ts:71-86`, `test/handlers/manager-loop.test.ts:106-118`, plus the runtime steering probe emitted `child_steer_note_written`.

## loop_restart

- PASS 16. `loop_restart` is parsed as a boolean edge field. Evidence: `src/garden/parse.ts:241-256`, `test/garden/parse.test.ts:202-210`.
- PASS 17. Restart creates a new run ID and run directory. Evidence: `src/engine/engine.ts:562-609`, `src/cli/commands/run.ts:41-69`, and the CLI runtime probe created a 3-run canonical chain.
- PASS 18. Predecessor runs are marked `interrupted` with reason `loop_restart` and linked forward via `restarted_to`. Evidence: `src/engine/engine.ts:564-574`, `test/integration/loop-restart.test.ts:74-113`, and the CLI probe manifest chain.
- PASS 19. Successor manifests get `restart_of` and `restart_depth`. Evidence: `src/cli/commands/run.ts:44-56`, `src/cli/commands/resume.ts:108-120`, `test/integration/loop-restart.test.ts:284-321`, and the CLI probe chain metadata.
- PASS 20. Context filtering preserves business keys and strips internal and routing keys. Evidence: `src/engine/engine.ts:576-585`, `test/integration/loop-restart.test.ts:115-149`.
- PASS 21. Retry state, thread continuity state, and session registry are reset in successor runs. Evidence: fresh successor engines create a new `SessionRegistry` at `src/engine/engine.ts:67`, start with `retryState = {}` at `src/engine/engine.ts:123-143`, and do not carry forward `previousThreadId`, which is initialized as `null` at `src/engine/engine.ts:57`; only filtered business context is forwarded by `src/cli/commands/run.ts:65-66` and `src/cli/commands/resume.ts:129-130`.
- PASS 22. Successor runs start at the selected edge target, not the graph start. Evidence: `src/engine/engine.ts:467-468`, `src/cli/commands/run.ts:64-67`, `test/integration/loop-restart.test.ts:151-176`.
- PASS 23. The restart depth cap defaults to 25 and honors `max_restart_depth`. Evidence: `src/engine/engine.ts:548-559`, `src/garden/parse.ts:300-316`, `test/integration/loop-restart.test.ts:178-246`.
- PASS 24. `nectar run` follows restart chains automatically. Evidence: `src/cli/commands/run.ts:41-69`; the CLI probe exited `0`, printed two restart hops, and finished the third run successfully.
- PASS 25. `nectar resume` resumes the latest run in a chain. Evidence: `src/cli/commands/resume.ts:36-46`, `src/cli/commands/resume.ts:105-134`; the CLI probe resumed the last run when invoked with the first run ID and completed that last checkpoint.
- PASS 26. `nectar status` shows lineage for mid-chain run IDs. Evidence: `src/cli/commands/status.ts:35-52`; the CLI probe on the middle run printed `Lineage:`, its predecessor, its successor, and `Restart depth: 1`.
- PASS 27. `run_restarted` is emitted. Evidence: `src/engine/engine.ts:587-593`, `test/integration/loop-restart.test.ts:110-112`.

## Tool Call Hooks

- PASS 28. `tool_hooks.pre` and `tool_hooks.post` parse at graph and node level. Evidence: `src/garden/parse.ts:174-175`, `src/garden/parse.ts:298-299`, `test/garden/parse.test.ts:212-233`.
- PASS 29. Node-level hooks override graph-level hooks. Evidence: `src/agent-loop/tool-hooks.ts:121-133`, `src/handlers/codergen.ts:124-149`, `test/agent-loop/tool-hooks.test.ts:31-48`.
- PASS 30. Pre-hook exit `0` allows the call; non-zero blocks with a synthetic tool error. Evidence: `src/agent-loop/tool-hooks.ts:61-89`, `src/agent-loop/session.ts:557-597`, `test/agent-loop/tool-hooks.test.ts:59-72`, `test/agent-loop/tool-hooks.test.ts:154-169`.
- PASS 31. Post-hooks run after every tool call, including blocked calls. Evidence: `src/agent-loop/session.ts:583-593`, `src/agent-loop/session.ts:603-618`, `src/agent-loop/session.ts:655-670`, `test/agent-loop/tool-hooks.test.ts:161-169`.
- FAIL 32. Post-hook failures do not block, but they are not logged from actual agent sessions. Evidence: `src/agent-loop/session.ts:603-618` and `src/agent-loop/session.ts:655-670` ignore the returned `PostHookResult`; `src/agent-loop/tool-hooks.ts:101-110` only persists metadata when a `toolCallDir` is supplied, which the session never passes.
- PASS 33. Both regular tool calls and subagent control tools flow through the hook wrapper. Evidence: `src/agent-loop/session.ts:552-621`; the hook wrapper runs before both the `isSubagent` branch and the normal registry branch.
- FAIL 34. Parallel read-only batches do not have integrated hook artifact isolation. Evidence: `src/agent-loop/session.ts:675-695` does run hooks per call in parallel, but every `runPreHook` and `runPostHook` call at `src/agent-loop/session.ts:567`, `src/agent-loop/session.ts:592`, `src/agent-loop/session.ts:617`, and `src/agent-loop/session.ts:669` omits the `toolCallDir` needed for per-call persisted hook artifacts.
- PASS 35. Hook timeout is fixed at 15 seconds. Evidence: `src/agent-loop/tool-hooks.ts:38`, `src/agent-loop/tool-hooks.ts:153-160`.
- PASS 36. Hooks receive JSON on stdin and `NECTAR_*` environment variables. Evidence: `src/agent-loop/tool-hooks.ts:66-69`, `src/agent-loop/tool-hooks.ts:96-99`, `src/agent-loop/tool-hooks.ts:136-145`, `test/agent-loop/tool-hooks.test.ts:88-103`, `test/agent-loop/tool-hooks.test.ts:189-198`.
- FAIL 37. Hook subprocesses are not given an explicit run-workspace `cwd`. Evidence: `src/agent-loop/tool-hooks.ts:153-162` invokes `execaCommand()` without a `cwd` option, and `ToolHookRunner` receives no workspace path.
- FAIL 38. Hook artifacts are not persisted from actual agent sessions. Evidence: `src/agent-loop/tool-hooks.ts:72-80` and `src/agent-loop/tool-hooks.ts:102-110` require `toolCallDir`, but `AgentSession` never supplies it at `src/agent-loop/session.ts:567`, `src/agent-loop/session.ts:592`, `src/agent-loop/session.ts:617`, and `src/agent-loop/session.ts:669`.
- FAIL 39. `tool_hook_blocked` is never emitted. Evidence: blocked calls in `src/agent-loop/session.ts:568-596` emit only `agent_tool_call_started`; `bridgeAgentEvent()` in `src/handlers/codergen.ts:273-376` has no `tool_hook_blocked` branch even though the engine event type exists in `src/engine/events.ts:255-262`.
- PASS 40. With no hooks configured, the session takes the passthrough path. Evidence: `src/agent-loop/session.ts:93-97`, `src/agent-loop/tool-hooks.ts:61-64`, `src/agent-loop/tool-hooks.ts:91-94`, `test/agent-loop/tool-hooks.test.ts:114-122`.

## Test Coverage

- PASS 41. There are at least 45 relevant sprint test cases. Evidence: the focused count across sprint-related test files was `131` `it(...)` cases, and the targeted suite passed `142` tests across `10` files.
- FAIL 42. Manager-loop coverage is missing required automated cases. Evidence: `test/handlers/manager-loop.test.ts:60-69` only covers the missing-key attach failure; there is no automated test for nonexistent or already-terminal attached runs, no automated parent-interrupt cleanup test, and the existing max-cycles test at `test/handlers/manager-loop.test.ts:88-104` does not assert failure.
- FAIL 43. Restart coverage is missing automated CLI follow-through and mid-chain status tests. Evidence: `test/integration/loop-restart.test.ts` covers engine-level restart mechanics and lineage, but there is no repo test that exercises `nectar run` restart following, `nectar resume` chain resolution, or `nectar status` lineage display for mid-chain IDs.
- FAIL 44. Tool-hook coverage is missing required automated cases for `cwd`, hooked subagent tool paths, and parallel-call hook behavior. Evidence: `test/agent-loop/tool-hooks.test.ts` covers allow/block/post/env/stdin basics, but it does not exercise run-workspace `cwd`, `AgentSession` hook artifact persistence, subagent tool calls under hooks, or parallel hook execution.
- FAIL 45. The required integration coverage is incomplete. Evidence: the repo has parent/child and restart integration tests (`test/integration/manager-loop.test.ts`, `test/integration/loop-restart.test.ts`), but no automated test for a 3-run CLI restart chain or for a pre-hook block followed by model adaptation.

## Extra Observations

- `restarted_to` is written to the predecessor manifest, but not to the checkpoint or cocoon even though `Cocoon` includes an optional `restarted_to` field (`src/checkpoint/types.ts:31`). This was not counted separately because the DoD item required the predecessor link, not a specific storage location.
- Steering-note consumption sets `context["stack.manager.note"]` before node execution (`src/engine/engine.ts:292-300`), but codergen prompt injection for that note is not implemented in `CodergenHandler`. This was not counted separately because the DoD item only required note consumption before the next node executes.

## Conclusion

`docs/sprints/SPRINT-017.md` does not fully pass validation. `34` of `45` Definition of Done items pass; `11` fail. The correct validation outcome is **exit status `1`**.
