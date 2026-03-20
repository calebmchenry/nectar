# Sprint NEXT Draft Critique

**Reviewer:** Codex  
**Date:** 2026-03-20

Reviewed against:

- `docs/sprints/drafts/NEXT-CLAUDE-DRAFT.md`
- `docs/sprints/drafts/NEXT-GEMINI-DRAFT.md`
- `docs/compliance-report.md`
- `src/garden/types.ts`
- `src/garden/parse.ts`
- `src/garden/validate.ts`
- `src/engine/engine.ts`
- `src/checkpoint/run-store.ts`
- `src/checkpoint/types.ts`
- `src/agent-loop/session.ts`
- `src/agent-loop/transcript.ts`
- `src/handlers/codergen.ts`
- `src/cli/commands/run.ts`
- `src/cli/commands/resume.ts`
- `src/cli/commands/status.ts`

The Claude draft is the stronger base for the merged sprint. It is materially more implementation-ready, and it matches the current codebase better around run directories, lineage, CLI follow-through, and the actual `AgentSession` tool-execution layer. The Gemini draft is easier to read and narrower in scope, but it leaves too many contracts implicit and it contains a correctness issue in its `loop_restart` design: it restarts from the graph start node instead of the selected edge target.

## Claude Draft

### Strengths

- This is the more executable plan. The architecture, phases, files summary, and Definition of Done are detailed enough to implement without inventing core behavior mid-sprint.
- It aligns well with the current repo shape. The draft builds on `RunStore`, canonical checkpoints, `AgentSession`, `TranscriptWriter`, and existing CLI commands instead of pretending these features can land purely inside `engine.ts`.
- The `loop_restart` design is substantially better than Gemini's. New run ID, lineage fields, target-node restart, context filtering, and `run` / `resume` / `status` follow-through are the right level of completeness for a restart feature.
- The manager-loop design is much stronger on real operational behavior: owned vs attached child runs, stable `stack.child.*` telemetry, bounded polling, and at-most-once steering notes.
- Tool hooks are placed at the correct layer. Wrapping model-visible tool calls inside `AgentSession` matches the current architecture better than engine-level interception would.
- The cut line is sensible. If time compresses, cutting A3 is less dangerous than half-shipping restart lineage or manager-loop cleanup semantics.
- The DoD is the strongest of the two drafts. Most of it is behavioral rather than just "module exists."

### Weaknesses

- The sprint is still large. A1 + A2 + A3 touches parser/types/validation, engine state, checkpoint metadata, CLI behavior, the agent loop, transcript persistence, and multiple new integration tests. That is a broad blast radius for one sprint.
- The in-process child-engine design does not fully reconcile with the current engine's process-level signal handling. `PipelineEngine` currently installs `SIGINT` / `SIGTERM` handlers per engine instance. Running parent and child engines in-process creates a real risk of duplicated interrupt handling unless ownership is made explicit.
- The draft does not say what happens when a supervised child itself hits `loop_restart`. That is load-bearing, because the child run ID can change while the parent is attached to its checkpoint path and lineage.
- Validation coverage is still missing one codebase-specific detail: `house` also needs to be added to the supported shape whitelist, not just to `NodeKind` and `normalizeNodeKind()`. Otherwise validation will still warn on the new shape.
- The tool-hook design is slightly underspecified for the current parallel tool-execution model. `AgentSession` can execute contiguous read-only tools concurrently, and the draft does not say enough about pre/post hook ordering, concurrency, or artifact naming under parallel execution.
- The hook runtime hard-codes `shell: true` without defining cwd/path resolution rules. That is workable, but it is a design choice with quoting and portability implications that should be deliberate.

### Gaps in Risk Analysis

- No explicit risk entry covers parent/child signal-handler interaction for in-process child engines.
- No explicit risk entry covers a child run that itself restarts and produces a successor run ID while under manager supervision.
- No explicit risk entry covers ownership ambiguity if multiple managers attach to the same child run ID or if an attached run disappears between polls.
- No explicit risk entry covers hook behavior under parallel tool execution, especially concurrent read-only tool batches.
- No explicit risk entry covers hook command resolution semantics: working directory, relative paths, and shell quoting failures.

### Missing Edge Cases

- `stack.child_autostart=false` with no `stack.child.run_id` in context.
- `stack.child_autostart=false` with a stale or already-terminal child run ID.
- A supervised child that triggers `loop_restart` and moves to a successor run while the parent is still polling.
- Parent interruption while the child is inside a long-running codergen/tool step or waiting on human input.
- A manager whose `stop_condition` is already true on the first observed snapshot.
- Multiple read-only tool calls in one turn, all with hooks enabled, completing out of order.
- A pre-hook block followed by a post-hook timeout or failure on the same tool call.

### Definition of Done Completeness

- This is a strong DoD, but it still needs a few extra acceptance points.
- Add explicit acceptance for `house` in the validation whitelist so the new shape is not still flagged as unknown.
- Add explicit acceptance for child-restart behavior: either the manager follows successor lineage or the feature is documented as unsupported in this sprint.
- Add acceptance for `stack.child_autostart=false` failure paths: missing run ID, nonexistent run ID, and already-completed child run.
- Add acceptance for interrupt semantics with parent and child engines running in the same process.
- Add acceptance for parallel tool execution with hooks enabled, not just one-tool happy paths.
- Add acceptance for `nectar resume` / `nectar status` when the user passes an older run ID from the middle of a restart chain.

## Gemini Draft

### Strengths

- The draft is easier to scan quickly. The scope, files, phases, and DoD are simpler and more concise.
- If the team intentionally wants an A1/A2-only sprint, the narrower focus is easier to reason about than Claude's all-three-gaps plan.
- The use cases are clear at a high level and communicate the product value of supervisor workflows and continuous execution without a lot of extra machinery.
- The risk table at least catches the obvious first-order issues: child-resource cleanup, runaway restart loops, nested-context isolation, and renderer behavior.

### Weaknesses

- The draft claims "100% compliance for core Attractor flow control features" while explicitly deferring GAP-A3. That is not consistent with the current compliance report, which still lists A3 as a remaining high-priority attractor gap.
- The `loop_restart` semantics are wrong in both the use case and the architecture. Restarting from the `Mdiamond` start node breaks valid cases like `review -> implement [loop_restart=true]` and contradicts the target-edge semantics called out in the compliance gap.
- A2 is under-specified relative to the current codebase. There is no lineage model, no manifest/cocoon metadata plan, no `resume` or `status` chain behavior, and no context-filtering contract beyond a vague reset.
- A1 is also under-specified. The draft mentions observe/guard/steer cycles, but it does not define attach vs autostart behavior, owned-child cleanup, telemetry namespace, steering persistence, or stop-condition evaluation against mirrored child state.
- The file plan misses real implementation surfaces. Current restart support would require `src/checkpoint/run-store.ts`, `src/checkpoint/types.ts`, and CLI command changes, not just `engine.ts`, `events.ts`, and tests.
- Validation is too thin. Requiring `stack.child_dotfile` is not enough; the current parser/validator will also need `house` shape support, action validation, duration parsing, positive integer validation, and stop-condition parsing.
- There is no cut line. That matters because even the narrower A1/A2 scope still has engine, checkpoint, CLI, and handler complexity.

### Gaps in Risk Analysis

- No risk entry covers the correctness problem in the restart-to-start-node design.
- No risk entry covers the missing lineage/resume/status story for restart chains.
- No risk entry covers in-process parent/child signal handling, even though the manager-loop design implies nested engines.
- No risk entry covers child attachment semantics, ownership rules, or missing/stale child run IDs.
- No risk entry covers a child that restarts while being supervised.
- No risk entry covers backward compatibility for old cocoons without lineage metadata.
- No risk entry covers the product risk of claiming full gap closure while A3 stays out of scope.

### Missing Edge Cases

- `review -> implement [loop_restart=true]` should restart at `implement`, not at the graph start node.
- `stack.child_autostart=false` with a missing, invalid, or already-finished child run ID.
- A child that fails or restarts between two poll intervals.
- `manager.stop_condition` parse errors or conditions that reference `stack.child.*` keys that were never mirrored.
- Invalid `manager.actions` values or `steer` enabled with no prompt.
- Restart depth exactly at the configured cap and one step beyond it.
- `nectar resume <old-run-id>` after a restart chain already produced newer successors.
- `house` parsing implemented but `SUPPORTED_SHAPES` / validation not updated, leaving the node type technically functional but still linting as unknown.

### Definition of Done Completeness

- The DoD is too thin for the gaps it claims to close.
- Add regression acceptance, not just `build`: existing tests should pass, and old cocoons should still resume cleanly.
- Add explicit A2 acceptance for lineage fields, target-node restart, context filtering, retry/session reset, depth guard, and restart-aware `run` / `resume` / `status` behavior.
- Add explicit A1 acceptance for attach mode, owned-child cleanup, child failure handling, `stack.child.*` telemetry, stop-condition evaluation, and parent interrupt behavior.
- Add validation acceptance for `house` support, `manager.actions`, `manager.poll_interval`, `manager.max_cycles`, and `manager.stop_condition`.
- If A3 remains out of scope, remove the compliance-complete claim from the overview and title language. If the sprint is meant to close the attractor floor, A3 has to appear in scope and in DoD.

## Recommendations For The Final Merged Sprint

- Use the Claude draft as the structural base. It is much closer to an implementation plan and fits the current codebase better.
- Keep Gemini's scope discipline, but not its restart design. The merged sprint should preserve Claude's target-node restart semantics, lineage metadata, and CLI follow-through.
- Keep A1 and A2 as non-negotiable scope. Keep A3 in scope only if the team is willing to treat it as the clear cut line. If A3 slips, the sprint should not claim the attractor floor is complete.
- Add four explicit design callouts before implementation starts:
  - `house` must be added to the shape whitelist and validation path, not just parse/type normalization.
  - Parent/child signal handling must be defined for in-process child engines.
  - Manager behavior when a child itself restarts must be defined.
  - Tool-hook behavior under parallel read-only tool execution must be defined.
- Keep the manager loop deterministic and file-backed. Claude's "real child engine + checkpoint polling + next-node steering note" is the right scope for this sprint.
- Keep restart lineage in both manifest and checkpoint data, and make `run` / `resume` / `status` restart-aware. Anything less will leave A2 only half-shipped.
- Keep tool hooks at the `AgentSession` layer only. Do not expand the sprint by also trying to hook engine-level `parallelogram` tool nodes.
- Strengthen the merged DoD around attach failures, child restart-follow behavior, interrupt cleanup, old-cocoon compatibility, and parallel-hook execution.

Recommended merged title:

`Sprint 017: Manager Loop, Fresh-Run Restart, and Tool Hooks`
