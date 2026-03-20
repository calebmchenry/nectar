# Sprint 012: Subagent Delegation & Session Hardening

## Overview

**Goal:** Close the last high-severity coding-agent-loop gap by adding spec-compliant subagent tools (`spawn_agent`, `send_input`, `wait`, `close_agent`) on top of a stable, observable `AgentSession`. After this sprint, a codergen node can delegate scoped work to child agents, continue its own loop, steer children mid-flight, wait for results only when needed, and tear the whole tree down cleanly on abort or close.

**Why this sprint, why now:**

- `C1` is the only **high-severity** gap left in `docs/compliance-report.md`.
- `docs/INTENT.md` makes multi-step AI workflows a core product promise. Without delegation, every codergen node is still a single-threaded worker that can only serialize work.
- Sprint 011 introduced the right control-plane concepts, but the current implementation still has live-session wiring gaps: profile-specific tool exposure is not actually used at runtime, environment/git prompt context is built but not injected, abort does not stop in-flight tools, and artifact metadata is incomplete. Adding subagents on top of that would create opaque background workers that are hard to supervise and harder to debug.

**This sprint is deliberately opinionated:** finish the control-plane wiring first, then add one level of delegation, and stop. Do **not** mix in manager-loop orchestration, HTTP server work, or context-fidelity runtime in the same sprint.

**In scope:**

- Finish the unfinished live-session wiring from Sprint 011 that subagents depend on
- Add a `SubAgentManager` owned by each parent `AgentSession`
- Add `spawn_agent`, `send_input`, `wait`, and `close_agent` as real model-visible tools
- Add child-session lineage metadata to agent and engine event streams
- Add per-child transcript/artifact storage under the codergen node run directory
- Add `working_dir` scoping through the execution environment without changing the workspace trust boundary

**Out of scope:**

- `A1` manager loop handler (`house` / `stack.manager_loop`)
- `A4` / `A5` context fidelity runtime and `thread_id` session reuse
- `A2` HTTP server mode and all Hive UI work
- `L4`, `L7`, `L8`, `L9`, `L10`, `L11` in the unified LLM client
- Recursive subagents beyond depth `1`
- Automatic supervisor heuristics that spawn children without an explicit model tool call

**Cut-line:** If the sprint runs long, defer only cosmetic parent-side summaries of child work. Do **not** ship partial subagent support without clean abort semantics, lineage metadata, and transcript/artifact persistence.

---

## Use Cases

1. **Parallel codebase exploration:** A codergen node needs both failing test coverage and implementation context. The parent agent spawns one child to inspect `test/` and another to inspect `src/`, keeps reasoning in the parent session, then calls `wait` on both handles and synthesizes the final plan.

2. **Focused work in a subdirectory:** The parent agent spawns a child with `working_dir="packages/cli"` and task `"add zsh completion tests"`. The child resolves relative paths from that subtree and runs shell commands from there, but the workspace boundary still blocks any escape outside the repo root.

3. **Mid-flight correction:** A child starts a broad refactor when the parent only wants a one-file fix. The parent calls `send_input(agent_id, "Stop refactoring. Only fix parser.ts and rerun its tests.")`. If the child is currently processing, that message lands as a developer steer before the next LLM call. If the child is idle/awaiting input, it becomes a queued follow-up.

4. **Alternative approaches with the same provider:** The parent spawns two children with the same task but different `model` overrides. It waits for both, compares their outputs, and keeps the better approach. This is the smallest useful building block for the "multiple AI perspectives" direction in `docs/INTENT.md`.

5. **Graceful shutdown:** The user aborts a run while a parent session has two active children and one in-flight shell command. Nectar cancels the active stream, kills the running command, aborts both children, flushes transcripts, emits terminal events, and leaves no orphaned child sessions behind.

---

## Architecture

### Design Principles

1. **Finish the parent before multiplying children.** Subagents are not worth shipping if the parent session still lies about its visible tools, drops transcript actions, or leaks processes on abort.

2. **A child agent is a real `AgentSession`, not a special callback.** Each child gets its own conversation, loop detector, event stream, transcript, and result object. Reuse the existing session machinery instead of inventing a second orchestration model.

3. **Delegation is explicit and bounded.** The model must opt into spawning a child with a clear task. Default maximum nesting depth is `1`. No recursive trees this sprint.

4. **Observability beats convenience.** Every child has its own artifact directory. Every bubbled event carries lineage metadata. The host can always reconstruct who spawned whom and what each child did.

5. **`working_dir` is a starting point, not a new trust boundary.** It changes the default relative path base and shell `cwd`, but all file resolution still stays inside the same workspace root.

### SubAgentManager

Each `AgentSession` gets a `SubAgentManager` responsible for child-session lifecycle:

```text
Parent AgentSession
  ├── conversation / steer queue / follow-up queue
  ├── ToolRegistry
  │   ├── core tools (read/write/edit-or-patch/shell/grep/glob)
  │   └── subagent tools (spawn_agent/send_input/wait/close_agent)
  ├── TranscriptWriter
  └── SubAgentManager
      ├── Map<agent_id, SubAgentHandle>
      ├── spawn(...)
      ├── sendInput(...)
      ├── wait(...)
      ├── close(...)
      └── closeAll(...)
```

`SubAgentHandle` should carry:

- `id`
- `session`
- `status` (`RUNNING`, `COMPLETED`, `FAILED`, `CLOSED`)
- `working_dir`
- `started_at`
- `result_promise`
- `result` (cached when terminal)

`SubAgentManager` lives entirely inside `src/agent-loop/`; codergen only constructs it and forwards events/artifact roots. The engine should remain unaware of subagent implementation details beyond bridged event metadata.

### Dynamic Tool Exposure Per Turn

Tool exposure must become truthful at runtime. Each LLM turn rebuilds its tool definitions from:

1. The provider profile's core tool set
2. `spawn_agent` only when `session_depth < max_subagent_depth`
3. `send_input`, `wait`, and `close_agent` only when the session currently has active child handles

That yields the following behavior:

| Session type | Visible editing tool | Visible subagent tools |
|--------------|----------------------|------------------------|
| OpenAI parent | `apply_patch` | `spawn_agent`, plus `send_input` / `wait` / `close_agent` when children exist |
| Anthropic parent | `edit_file` | same as above |
| Gemini parent | `edit_file` | same as above |
| Any child at max depth | provider-native editing tool | none |

This is better than exposing all four subagent tools all the time. It keeps the prompt honest and reduces wasted tool-call attempts.

### Live Prompt Composition

`AgentSession` should stop using a stale one-time prompt. The system prompt must be rebuilt from the real live tool list and real environment context before each LLM call:

1. Provider base prompt
2. Environment context block
3. Git snapshot block
4. Project instructions

This closes the unfinished Sprint 011 wiring and avoids a subtle failure mode where the model is told one set of tools but receives another.

### Communication Semantics

The four subagent tools should behave as follows:

| Tool | Behavior |
|------|----------|
| `spawn_agent` | Creates a child session, starts it immediately, and returns JSON containing `agent_id`, `status`, `working_dir`, and effective model. |
| `send_input` | If the child is `PROCESSING`, route to `child.steer(message)`. If the child is `IDLE` or `AWAITING_INPUT`, route to `child.followUp(message)` or `child.submit(message)` as appropriate. If terminal, return an error. |
| `wait` | Awaits the child result if still running; otherwise returns the cached terminal result. Return JSON containing `output`, `success`, `turns_used`, and terminal `status`. |
| `close_agent` | Aborts a running child or closes an idle child, waits for terminal cleanup, removes it from the active map, and returns final status JSON. |

`send_input` is intentionally state-aware. A supervising parent should not need two different tools just because the child happens to be between turns.

### Scoped Execution Environment

`ExecutionEnvironment` should gain an explicit concept of `cwd` while preserving `workspaceRoot` as the trust boundary:

- Relative paths resolve from `cwd`
- Absolute paths remain allowed if they stay inside `workspaceRoot`
- `exec()` runs with `cwd`
- `scoped(subdir)` (or equivalent) returns a new environment instance rooted at the same workspace but with a different `cwd`

This gives `working_dir` real meaning without silently inventing a new sandbox model.

### Event and Artifact Model

Every agent event should carry enough metadata for the host to stitch together nested work:

- `session_id`
- `root_session_id`
- `parent_session_id` when emitted by a child
- `agent_depth`
- `artifact_path` on tool-completion events

In addition, add explicit lifecycle events:

- `agent_subagent_spawned`
- `agent_subagent_completed`
- `agent_subagent_closed`

Child events should bubble through the parent's listener instead of being collapsed into a single `wait` result. The parent needs to see child tool calls in real time; otherwise the delegation layer is a black box.

Artifact layout under each codergen node run directory:

```text
<run_dir>/<node_id>/
├── prompt.md
├── response.md
├── status.json
├── transcript.jsonl
├── tool-calls/
└── subagents/
    └── <agent-id>/
        ├── prompt.md
        ├── response.md
        ├── status.json
        ├── result.json
        ├── transcript.jsonl
        └── tool-calls/
```

Parent transcripts should also record control actions: `steer`, `follow_up`, `subagent_spawn`, `subagent_wait`, `subagent_close`.

As part of the same hardening pass, `apply_patch` artifacts should finally persist `patch.txt`, and `agent_tool_call_completed` should expose the artifact directory path after the write succeeds.

### Abort and Cleanup

Parent shutdown must be single-path and deterministic:

1. Cancel the active LLM stream
2. Propagate the abort signal to the current tool invocation
3. Abort all running child sessions
4. Await bounded child cleanup
5. Flush transcript/status artifacts
6. Emit final session events
7. Transition to `CLOSED`

If a child fails naturally, the parent does **not** automatically fail. Child success/failure becomes data surfaced through `wait`. The model decides how to react.

---

## Implementation Phases

### Phase 1: Finish Live Session Wiring (~20%)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/transcript.ts`, `src/agent-loop/tools/shell.ts`, `src/handlers/codergen.ts`, `src/engine/events.ts`, related tests

**Tasks:**

- [ ] Make live sessions use profile-filtered tool definitions instead of `registry.definitions()`
- [ ] Build the system prompt with `buildFullSystemPrompt(...)` in the real session path, not just in helper tests
- [ ] Recompute visible tool names per turn so the prompt and actual tool list stay aligned
- [ ] Propagate abort signals into shell execution so `abort()` actually stops in-flight commands
- [ ] Wire the real default command timeout into `env.exec()` and keep Anthropic's profile override
- [ ] Record follow-up actions in `transcript.jsonl`
- [ ] Persist `patch.txt` alongside `request.json` and `result.json` for `apply_patch`
- [ ] Emit `artifact_path`, `session_id`, and `workspace_root` from real runtime events before starting subagent work
- [ ] Get the branch back to a green `npm run build` / `npm test` baseline before layering delegation on top

### Phase 2: Add `SubAgentManager` and Scoped Environments (~30%)

**Files:** `src/agent-loop/types.ts`, `src/agent-loop/session.ts`, `src/agent-loop/subagents.ts`, `src/agent-loop/execution-environment.ts`, `src/agent-loop/transcript.ts`

**Tasks:**

- [ ] Add `max_subagent_depth` to session config with default `1`
- [ ] Add internal session-depth tracking so children know whether they may spawn
- [ ] Define `SubAgentHandle`, `SubAgentStatus`, and `SubAgentResult` types
- [ ] Implement `SubAgentManager.spawn/sendInput/wait/close/closeAll`
- [ ] Make child sessions inherit client, provider profile, project instructions, and workspace root from the parent
- [ ] Support `model` override and per-child `max_turns` override on spawn
- [ ] Add `cwd` and `scoped()` behavior to the execution environment so `working_dir` affects both file tools and shell commands
- [ ] Write child artifacts under `subagents/<agent-id>/`
- [ ] Cache terminal child results so repeated `wait` calls are cheap and deterministic

### Phase 3: Expose Subagent Tools to the Model (~30%)

**Files:** `src/agent-loop/tools/spawn-agent.ts`, `src/agent-loop/tools/send-input.ts`, `src/agent-loop/tools/wait.ts`, `src/agent-loop/tools/close-agent.ts`, `src/agent-loop/session.ts`, `src/handlers/codergen.ts`

**Tasks:**

- [ ] Create JSON schemas and descriptions for all four subagent tools
- [ ] Register subagent tools in codergen sessions after the parent session and manager exist, so handlers can close over live state
- [ ] Ensure `spawn_agent` starts the child immediately and returns a stable `agent_id`
- [ ] Make `send_input` state-aware: steer during `PROCESSING`, queue follow-up otherwise
- [ ] Make `wait` block on a running child and return cached results for a completed one
- [ ] Make `close_agent` clean up active children and remove handles from the manager map
- [ ] Hide subagent tools entirely when `session_depth` is already at the configured maximum
- [ ] Keep provider semantics intact: OpenAI still edits with `apply_patch`; Anthropic/Gemini still edit with `edit_file`

### Phase 4: Event Fan-Out, Integration Tests, and Failure Modes (~20%)

**Files:** `src/agent-loop/events.ts`, `src/handlers/codergen.ts`, `src/engine/events.ts`, `test/helpers/scripted-adapter.ts`, `test/agent-loop/subagents.test.ts`, `test/agent-loop/session-control.test.ts`, `test/agent-loop/environment-context.test.ts`, `test/agent-loop/apply-patch-integration.test.ts`, `test/handlers/codergen.test.ts`, `test/integration/agent-loop.test.ts`

**Tasks:**

- [ ] Bubble child agent events through the parent with lineage metadata
- [ ] Add explicit subagent lifecycle events for spawn, completion, and close
- [ ] Bridge child metadata through codergen into engine run events
- [ ] Add deterministic scripted-adapter coverage for parent/child coordination
- [ ] Add tests for depth limiting, `working_dir`, repeated `wait`, invalid `agent_id`, and close-on-abort behavior
- [ ] Add end-to-end tests showing a parent spawns multiple children, waits for results, and finishes with the same conversation intact
- [ ] Add regression tests for the Sprint 011 hardening items folded into this sprint

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/types.ts` | Modify | Add subagent config, depth metadata, handle/result types |
| `src/agent-loop/session.ts` | Modify | Dynamic tool visibility, live prompt rebuild, subagent lifecycle ownership, deterministic abort cleanup |
| `src/agent-loop/events.ts` | Modify | Add lineage metadata and explicit subagent lifecycle events |
| `src/agent-loop/subagents.ts` | Create | `SubAgentManager` and child-session bookkeeping |
| `src/agent-loop/execution-environment.ts` | Modify | Add `cwd`-aware path resolution, scoped environments, and real timeout/abort wiring |
| `src/agent-loop/provider-profiles.ts` | Modify | Use the full prompt builder in live sessions and keep tool-list guidance accurate |
| `src/agent-loop/transcript.ts` | Modify | Record follow-ups/control actions, persist `patch.txt`, write child result artifacts, return artifact paths |
| `src/agent-loop/tools/shell.ts` | Modify | Use session-aware timeout and abort signal when executing commands |
| `src/agent-loop/tools/spawn-agent.ts` | Create | Schema, description, and handler factory for child spawning |
| `src/agent-loop/tools/send-input.ts` | Create | Schema, description, and handler factory for child messaging |
| `src/agent-loop/tools/wait.ts` | Create | Schema, description, and handler factory for child result waiting |
| `src/agent-loop/tools/close-agent.ts` | Create | Schema, description, and handler factory for child termination |
| `src/handlers/codergen.ts` | Modify | Construct `SubAgentManager`, register tools, and bridge nested events/artifacts into run events |
| `src/engine/events.ts` | Modify | Preserve child session lineage and artifact paths in bridged engine events |
| `test/helpers/scripted-adapter.ts` | Modify | Support deterministic parent/child scripted responses in tests |
| `test/agent-loop/subagents.test.ts` | Create | Unit tests for subagent lifecycle, state routing, and depth limits |
| `test/agent-loop/session-control.test.ts` | Modify | Cover abort cleanup, dynamic tool exposure, and follow-up transcript persistence |
| `test/agent-loop/environment-context.test.ts` | Modify | Prove environment/git blocks appear in live sessions |
| `test/agent-loop/apply-patch-integration.test.ts` | Modify | Verify `patch.txt` and artifact-path wiring |
| `test/handlers/codergen.test.ts` | Modify | Verify nested event bridging and child artifact locations |
| `test/integration/agent-loop.test.ts` | Modify | End-to-end parent/child delegation scenarios |

---

## Definition of Done

- [ ] `npm run build` succeeds on a clean checkout
- [ ] `npm test` passes with zero regressions
- [ ] Live OpenAI sessions expose `apply_patch` and do **not** expose `edit_file`
- [ ] Live Anthropic and Gemini sessions expose `edit_file` and do **not** expose `apply_patch`
- [ ] Real agent sessions include environment context and git snapshot blocks in the system prompt when available
- [ ] `followUp()` writes a transcript entry in `transcript.jsonl`
- [ ] `apply_patch` writes `patch.txt` into the tool-call artifact directory
- [ ] `spawn_agent` creates a child session, starts it immediately, and returns a stable `agent_id`
- [ ] Child sessions write transcripts and status artifacts under `subagents/<agent-id>/`
- [ ] `send_input` reaches a running child on the next turn and changes child behavior in a deterministic test
- [ ] `send_input` queues a follow-up correctly when the child is not currently processing
- [ ] `wait` blocks for a running child and returns cached results for a completed child
- [ ] `close_agent` terminates a running child and removes it from the manager's active map
- [ ] `max_subagent_depth=1` prevents a child from spawning another child
- [ ] `working_dir` changes relative-path resolution and shell `cwd` while still enforcing the workspace-root boundary
- [ ] Parent `abort()` stops the active shell command and aborts all running children
- [ ] No orphaned child sessions remain after parent completion, failure, close, or abort
- [ ] Child tool calls appear in the parent agent event stream with `session_id`, `parent_session_id`, and `agent_depth`
- [ ] Engine-bridged agent events preserve lineage metadata and `artifact_path`
- [ ] Tool-completion events expose full untruncated output to the host and truncated previews to the model
- [ ] An integration test proves a parent can spawn multiple children, wait for both, and finish with the correct final answer

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Parent/child abort races leave orphaned shell processes | Medium | High | One shutdown path only: stream cancel -> tool abort -> child abort -> bounded cleanup -> final event. Test with a long-running shell command. |
| Dynamic tool visibility changes confuse the model | Medium | Medium | Rebuild prompt + tool definitions every turn. Never hide `wait` / `close_agent` while active children still exist. |
| `working_dir` semantics become inconsistent across read/write/shell tools | Medium | High | Put `cwd` in `ExecutionEnvironment`, not in ad hoc tool wrappers. Add tests covering all three operations. |
| Child event fan-out becomes noisy or duplicated | Medium | Medium | Add lineage metadata to every event and assert exact event counts in codergen + integration tests. |
| Large child outputs bloat parent context | Medium | Medium | Keep child outputs in artifacts, return bounded JSON summaries from `wait`, and preserve full output only in host-visible events/artifacts. |
| Models spawn children too eagerly and waste turns | Low | Medium | Limit nesting depth to `1`, preserve existing session turn/tool-round limits for children, and keep tool descriptions explicit about when delegation is worthwhile. |
| Subagent cleanup bugs corrupt parent transcripts | Low | High | Give every child its own transcript root and append parent control records only after child operations reach a durable state. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing `UnifiedClient` + provider adapters | Child sessions reuse the same multi-provider client and provider-specific tool semantics |
| Existing `execa` integration | Needed for abortable shell execution and the 2-second kill escalation path |
| Existing `ajv` validation in `ToolRegistry` | Validates new subagent tool inputs without adding a new schema layer |
| Existing `vitest` suite + scripted adapter | Deterministic coverage for parent/child lifecycle races and event ordering |

No new runtime package should be added for this sprint. The hard part is orchestration correctness, not library acquisition.
