# Sprint 027: Finish the Coding-Agent Loop Contract

## Overview

**Goal:** Close the remaining high-impact `coding-agent-loop-spec` gaps in one focused sprint. After this sprint, codergen sessions are observable end to end, the execution environment matches the spec, project instructions resolve deterministically, and tool contracts stop leaking small but compounding quality problems into every agent run.

**Why this sprint, why now:**

1. **The priority note in `INTENT.md` is stale.** It says the next sprint must implement parallel execution, but the compliance report shows `parallel`, `fan-in`, join policies, and branch isolation already exist. Spending another sprint there would be cargo cult planning.

2. **The next real bottleneck is codergen reliability, not more engine surface.** Nectar only becomes a real product when `box` nodes are trustworthy. Right now the remaining coding-agent-loop gaps are exactly in the places the intent document says matter most: observability, debuggability, resumability, and AI-readable filesystem context.

3. **This is the biggest coherent slice that still fits in one sprint.** The remaining unified-llm gaps are broader and more API-disruptive. The remaining attractor gaps are smaller and more scattered. The coding-agent-loop gaps form one bounded, high-leverage layer and can be closed completely without destabilizing the rest of the system.

4. **Fixing this layer improves both the CLI and the Hive without doing frontend work.** Once the session lifecycle is emitted correctly and the environment contract is truthful, existing SSE consumers, transcripts, and codergen artifacts become much more useful immediately.

**Gaps closed from `docs/compliance-report.md`:**

| Gap | Area | Why it is worth a sprint |
|-----|------|--------------------------|
| 9 | Session lifecycle events | The Hive and CLI cannot accurately show what an agent is doing without full session telemetry. |
| 10, 11 | Shell and grep tool schema gaps | Small on paper, but they directly affect model behavior every day. |
| 12, 13, 14 | Environment context omissions | The prompt is currently lying by omission about the machine it runs on. |
| 15, 16, 17, 18, 19 | ExecutionEnvironment contract gaps | The interface is still weaker than the spec, which keeps tool behavior and prompt context from lining up cleanly. |
| 20, 21, 22 | Truncation behavior | Tool output previews are not spec-compliant and lose useful tail context. |
| 23, 24 | `spawn_agent` model override/output limits | Subagents are less controllable than the spec requires. |
| 25 | Project instruction discovery direction | Nested project instructions do not currently win in the right order. |

**Opinionated scope decision:** this sprint closes the remaining `coding-agent-loop` contract and nothing broader. Do not mix in unified-llm response wrappers, attractor diagnostic polish, or Hive UI enhancements. That is how the last few sprints got too wide.

**Out of scope:**

- Unified LLM response contract work (`FinishReason`, `GenerateResult`, `StreamResult`, active/passive tools)
- Attractor diagnostic model cleanup (`INFO`, `fix`, `edge`, `node_id`)
- Additional CLI rendering polish beyond preserving compatibility with new events
- Hive UI changes beyond consuming the richer event stream it already gets
- Unrelated server/SSE timeout debt unless a touched file regresses it

---

## Use Cases

1. **Watch a codergen node honestly:** A user runs a garden with a `box` node and watches `/pipelines/:id/events`. They see: user input queued, processing started, assistant text start, text deltas, tool call started, tool output deltas, steering injected, processing ended, and session ended. Today they only get a partial story.

2. **Get an accurate system prompt:** A codergen node running on macOS or Linux receives an environment block that includes platform, OS version, shell, workspace, date, knowledge cutoff, whether the workspace is a git repository, provider, model, and visible tools. Today the agent gets a thinner and sometimes misleading picture.

3. **Use grep without fighting case:** The model wants to find `TODO`, `Todo`, and `todo` across a repo. It calls `grep` with `case_insensitive=true` and gets predictable results instead of inventing ugly regex workarounds.

4. **Describe expensive commands before running them:** The model calls `shell` with a human-readable `description` like `"Run the slow integration test suite"`. The transcript and session events preserve that description so humans can understand intent without reverse-engineering the raw command string.

5. **Spawn a cheaper or stronger child intentionally:** A parent session running on a strong model spawns a child with `model="gemini-2.5-flash"` for cheap search, or `model="claude-sonnet-4-20250514"` for a harder subtask. Today the child is forced onto the parent model path.

6. **Respect nested project instructions:** A monorepo has `/AGENTS.md` at the repo root and `/apps/hive/.codex/instructions.md` in a subproject. When the current working directory is `/apps/hive`, the root instructions are loaded first and the nested instructions take precedence. Today the walk direction is wrong.

7. **Preserve useful tail context in tool output:** A tool emits 20,000 lines. The model-visible preview keeps both the start and the end with the spec wording, instead of only the head or an arbitrary 80/20 split. That matters for stack traces, test summaries, and compiler footers.

8. **Make tool timeouts first-class:** A shell command times out. The execution result explicitly records `timed_out=true` and `duration_ms`, and that metadata is available to transcripts, events, and any future policy logic.

---

## Architecture

### 1. Session Telemetry Must Match the State Machine

The agent loop already has a real state machine: `IDLE -> PROCESSING -> AWAITING_INPUT -> CLOSED`. The event model needs to reflect that, not just sample pieces of it.

Add the missing agent-loop events as additive types:

- `agent_user_input`
- `agent_steering_injected`
- `agent_assistant_text_start`
- `agent_assistant_text_end`
- `agent_tool_call_output_delta`
- `agent_processing_ended`
- `agent_session_ended`
- `agent_turn_limit_reached`
- `agent_warning`
- `agent_error`

Design rules:

- `agent_session_started` stays at session creation time.
- `agent_session_completed` remains the end of one work item.
- `agent_session_ended` is new and only fires when the session actually closes or aborts.
- `agent_processing_ended` fires every time the session transitions back to `AWAITING_INPUT` after a work item.
- `agent_warning` is a generic umbrella event for things like context-window pressure and tool-output truncation. Keep `context_window_warning` for compatibility, but also emit the generic warning.
- `agent_error` is for fatal loop-level failures, not ordinary tool failures that are already represented as tool results.

This is not just bookkeeping. The intent document says Nectar must be observable and debuggable. A half-telemetry agent loop violates that principle.

### 2. Make `ExecutionEnvironment` the Source of Truth

Right now the environment interface is weaker than the spec, and prompt construction reaches around it with `os.platform()` and raw process globals. That is backwards.

The environment contract should own:

- filesystem access
- process execution
- directory listing
- platform metadata
- lifecycle hooks

Add to `ExecutionEnvironment`:

- `initialize(): Promise<void>`
- `cleanup(): Promise<void>`
- `listDirectory(path: string, depth?: number): Promise<DirEntry[]>`
- `platform(): string`
- `osVersion(): string`

Expand `ExecResult` with:

- `timed_out: boolean`
- `duration_ms: number`

Then make `buildEnvironmentContext()` depend on the environment interface instead of global Node APIs. That keeps prompt context and actual tool behavior aligned.

`list_dir` should stop being its own parallel implementation and become a thin adapter over `env.listDirectory()`. One implementation, one ignore policy, one workspace-boundary policy.

### 3. Instruction Discovery Must Follow Real Workspace Semantics

The compliance report is correct here: walking from the workspace root upward is the wrong direction. The correct rule is:

1. Find the git root.
2. Walk from git root down to the current working directory.
3. Load generic and provider-specific instruction files on each level.
4. Preserve root-level guidance, but let more local files win by being appended later.
5. Enforce the 32KB budget by dropping the least specific content first.

That means `discoverInstructions()` needs to know both the git root and the current working directory, not just the workspace root.

### 4. Tool Contract Fixes Should Be Small and Precise

The remaining tool issues are not glamorous, but they are exactly the kind of low-grade mismatch that makes agents behave worse than they should.

- `shell` gets an optional `description` field and surfaces it in transcripts/events.
- `grep` gets `case_insensitive`.
- `spawn_agent` gets `model`.
- `spawn_agent` gets a default output limit so it cannot dump arbitrarily large JSON into the model context.

Do not reinvent tool behavior. These are schema and plumbing fixes.

### 5. Truncation Should Preserve Both Ends, Not Just the Beginning

The current truncation behavior is not spec-compliant and is also the wrong tradeoff for developer tools. The tail of a command output often carries the only useful information.

Adopt these rules:

- character truncation uses a 50/50 head/tail split
- marker wording matches the spec warning text
- line truncation also uses head/tail rather than head-only

For `agent_tool_call_output_delta`, do not attempt live shell streaming in this sprint. Emit deterministic deltas from the final tool output before `agent_tool_call_completed`. That is enough to close the event contract without reopening the shell runner.

---

## Implementation Phases

### Phase 1: Session Telemetry and Event Bridging (~35%)

**Files:** `src/agent-loop/events.ts`, `src/agent-loop/session.ts`, `src/handlers/codergen.ts`, `src/engine/events.ts`, `test/agent-loop/events.test.ts`, `test/agent-loop/session-control.test.ts`, `test/agent-loop/session.test.ts`, `test/integration/agent-loop.test.ts`

**Tasks:**

- [ ] Add the missing agent event types and payloads in `src/agent-loop/events.ts`
- [ ] Emit `agent_user_input` when `submit()` and `followUp()` accept a prompt into the queue
- [ ] Emit `agent_steering_injected` when queued steer messages are drained into the conversation
- [ ] Emit `agent_assistant_text_start` before the first `content_delta` of a turn
- [ ] Emit `agent_assistant_text_end` when a streamed assistant turn finishes
- [ ] Emit `agent_tool_call_output_delta` in deterministic chunks before `agent_tool_call_completed`
- [ ] Emit `agent_processing_ended` whenever a work item finishes and the session returns to `AWAITING_INPUT`
- [ ] Emit `agent_session_ended` on `close()` and `abort()` with final state and reason
- [ ] Emit `agent_turn_limit_reached` when `max_turns` is exhausted
- [ ] Emit `agent_warning` for context-window pressure and tool-output truncation
- [ ] Emit `agent_error` on fatal loop-level failures
- [ ] Extend `src/engine/events.ts` with run-event equivalents for the new bridged agent events
- [ ] Update `bridgeAgentEvent()` in `src/handlers/codergen.ts` so the engine and SSE consumers receive the richer lifecycle
- [ ] Add focused tests for event ordering and payload contents

### Phase 2: ExecutionEnvironment Parity and Prompt Context (~25%)

**Files:** `src/agent-loop/execution-environment.ts`, `src/agent-loop/environment-context.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/tools/list-dir.ts`, `test/agent-loop/environment-context.test.ts`, `test/agent-loop/execution-environment-scoped.test.ts`, `test/agent-loop/tools/list-dir.test.ts`, `test/agent-loop/execution-environment.test.ts` (new)

**Tasks:**

- [ ] Extend `ExecResult` with `timed_out` and `duration_ms`
- [ ] Extend `ExecutionEnvironment` with `initialize()`, `cleanup()`, `listDirectory()`, `platform()`, and `osVersion()`
- [ ] Implement the new methods in `LocalExecutionEnvironment`
- [ ] Preserve workspace-boundary enforcement and symlink escape checks in the new directory-listing path
- [ ] Refactor `list_dir` to delegate to `env.listDirectory()` instead of maintaining its own filesystem walk
- [ ] Expand environment variable filtering to preserve language/runtime path variables without reintroducing secrets
- [ ] Make `buildEnvironmentContext()` include `OS version`, `Knowledge cutoff`, and `Is git repository`
- [ ] Make environment context depend on the environment contract, not raw `os.*` and ad hoc git checks
- [ ] Add tests for timeout metadata, duration metadata, platform/OS reporting, directory listing, and environment-variable filtering

### Phase 3: Instruction Resolution, Tool Schemas, and Subagent Model Control (~25%)

**Files:** `src/agent-loop/project-instructions.ts`, `src/agent-loop/tools/shell.ts`, `src/agent-loop/tools/grep.ts`, `src/agent-loop/tools/spawn-agent.ts`, `src/agent-loop/subagent-manager.ts`, `src/agent-loop/session.ts`, `src/agent-loop/types.ts`, `test/agent-loop/project-instructions.test.ts`, `test/agent-loop/tools/shell.test.ts`, `test/agent-loop/tools/grep.test.ts`, `test/agent-loop/subagent-session-integration.test.ts`

**Tasks:**

- [ ] Change `discoverInstructions()` to walk from git root to current working directory
- [ ] Load root-level files first and more-local files later so nested instructions win naturally
- [ ] Preserve the 32KB budget while dropping least-specific files first
- [ ] Add `description` to `shellSchema` and preserve it in event/transcript metadata
- [ ] Add `case_insensitive` to `grepSchema` and implement it in the regex path
- [ ] Add `model` to `spawnAgentSchema`
- [ ] Thread the model override through `SubagentManager` and child-session creation
- [ ] Return the effective child model in `spawn_agent` results
- [ ] Add `spawn_agent` to `TOOL_OUTPUT_LIMITS`
- [ ] Add tests for nested instruction precedence, case-insensitive grep, shell descriptions, and child-model override behavior

### Phase 4: Truncation Compliance and Compliance Proof (~15%)

**Files:** `src/agent-loop/truncation.ts`, `src/agent-loop/tool-registry.ts`, `test/agent-loop/truncation.test.ts`, `test/agent-loop/tool-registry.test.ts`, `docs/compliance-report.md`

**Tasks:**

- [ ] Change character truncation from 80/20 to 50/50
- [ ] Change the truncation marker wording to the spec warning text
- [ ] Change line truncation from head-only to head/tail
- [ ] Ensure `ToolRegistry` still stores full untruncated content when preview truncation occurs
- [ ] Emit `agent_warning` when output is truncated for model visibility
- [ ] Update truncation tests to check head/tail balance and exact marker text
- [ ] Regenerate and update `docs/compliance-report.md` so the coding-agent-loop section reflects the new truth

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/events.ts` | Modify | Add missing session lifecycle, warning, and output-delta event types |
| `src/agent-loop/session.ts` | Modify | Emit new events, propagate child-model overrides, and report processing/session end correctly |
| `src/agent-loop/types.ts` | Modify | Extend `ExecResult`-adjacent types and default output limits |
| `src/agent-loop/execution-environment.ts` | Modify | Complete the environment interface and local implementation |
| `src/agent-loop/environment-context.ts` | Modify | Build a truthful environment block with OS version, git flag, and knowledge cutoff |
| `src/agent-loop/provider-profiles.ts` | Modify | Adapt prompt-building helpers to the richer environment context path |
| `src/agent-loop/project-instructions.ts` | Modify | Fix instruction discovery order from git root to cwd |
| `src/agent-loop/truncation.ts` | Modify | Make preview truncation spec-compliant |
| `src/agent-loop/tool-registry.ts` | Modify | Preserve full content while emitting spec-compliant previews and warnings |
| `src/agent-loop/tools/list-dir.ts` | Modify | Delegate directory listing to the environment contract |
| `src/agent-loop/tools/shell.ts` | Modify | Add `description` to the tool schema and metadata flow |
| `src/agent-loop/tools/grep.ts` | Modify | Add `case_insensitive` behavior |
| `src/agent-loop/tools/spawn-agent.ts` | Modify | Add `model` to the tool schema |
| `src/agent-loop/subagent-manager.ts` | Modify | Carry child-model overrides through spawn and execution |
| `src/handlers/codergen.ts` | Modify | Bridge the richer agent events into engine run events |
| `src/engine/events.ts` | Modify | Define run-event counterparts for the new agent-loop events |
| `test/agent-loop/events.test.ts` | Modify | Verify new event types and payloads |
| `test/agent-loop/session-control.test.ts` | Modify | Verify state transitions now emit processing/session end events |
| `test/agent-loop/session.test.ts` | Modify | Verify assistant-text lifecycle, turn-limit events, and output-delta behavior |
| `test/agent-loop/environment-context.test.ts` | Modify | Verify environment-block completeness |
| `test/agent-loop/execution-environment-scoped.test.ts` | Modify | Verify new environment methods respect scoping and boundaries |
| `test/agent-loop/execution-environment.test.ts` | Create | Verify timeout metadata, duration metadata, and directory listing |
| `test/agent-loop/project-instructions.test.ts` | Modify | Verify root-to-cwd precedence and budget behavior |
| `test/agent-loop/tools/list-dir.test.ts` | Modify | Verify `list_dir` still behaves correctly through the environment interface |
| `test/agent-loop/tools/shell.test.ts` | Modify | Verify `description` handling and timeout metadata formatting |
| `test/agent-loop/tools/grep.test.ts` | Modify | Verify case-insensitive search behavior |
| `test/agent-loop/subagent-session-integration.test.ts` | Modify | Verify child model override and spawn metadata |
| `test/agent-loop/truncation.test.ts` | Modify | Verify 50/50 truncation and spec marker wording |
| `test/agent-loop/tool-registry.test.ts` | Modify | Verify truncation warnings and preserved full content |
| `test/integration/agent-loop.test.ts` | Modify | Verify the whole codergen loop still works with the richer contract |
| `docs/compliance-report.md` | Modify | Mark the closed coding-agent-loop gaps as implemented |

---

## Definition of Done

- [ ] All remaining `coding-agent-loop-spec` gaps listed in `docs/compliance-report.md` are closed or explicitly removed from the report as stale
- [ ] `agent_user_input`, `agent_steering_injected`, `agent_assistant_text_start`, `agent_assistant_text_end`, `agent_tool_call_output_delta`, `agent_processing_ended`, `agent_session_ended`, `agent_turn_limit_reached`, `agent_warning`, and `agent_error` are implemented and tested
- [ ] `agent_session_completed` still marks the end of a work item and is not conflated with session shutdown
- [ ] `close()` and `abort()` emit `agent_session_ended` exactly once
- [ ] Codergen bridges the new agent events into engine `RunEvent`s without breaking existing event consumers
- [ ] `ExecutionEnvironment` exposes `initialize()`, `cleanup()`, `listDirectory()`, `platform()`, and `osVersion()`
- [ ] `exec()` returns `timed_out` and `duration_ms` for both success and timeout paths
- [ ] `buildEnvironmentContext()` includes `Platform`, `OS version`, `Shell`, `Workspace`, `Date`, `Knowledge cutoff`, `Is git repository`, `Provider`, `Model`, and `Tools`
- [ ] Language/runtime path variables are preserved in filtered environments, while secret-like variables are still removed
- [ ] `discoverInstructions()` walks from git root to cwd and nested instructions win over root-level files
- [ ] `shell` accepts `description`
- [ ] `grep` accepts `case_insensitive`
- [ ] `spawn_agent` accepts `model` and child sessions use the override
- [ ] `spawn_agent` has an explicit default output limit
- [ ] Character truncation uses a 50/50 head/tail split
- [ ] Line truncation uses head/tail, not head-only
- [ ] Truncation marker wording matches the spec warning text
- [ ] `ToolRegistry` preserves `full_content` whenever preview truncation occurs
- [ ] `npm run build` succeeds
- [ ] All touched `test/agent-loop/*` suites and `test/integration/agent-loop.test.ts` pass
- [ ] `npm test` introduces no new failures outside the touched area

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Additive event types break downstream consumers with exhaustive switches | Medium | Medium | Keep changes additive, preserve existing event names, and make CLI/UI consumers ignore unknown events by default. |
| `buildEnvironmentContext()` becoming richer ripples through prompt construction unexpectedly | Medium | Medium | Keep the environment block builder isolated and cover it with explicit snapshot-style tests. |
| Fixing instruction precedence silently changes prompts in nested workspaces | Medium | High | Add fixture-style tests with root and nested instruction files and assert exact ordering. |
| Preserving more env vars accidentally leaks secrets | Low | High | Apply deny rules first, then allow only a tight list of language/runtime path vars; add regression tests for secret filtering. |
| `agent_tool_call_output_delta` is interpreted as live streaming though it is post-execution chunking | Medium | Low | Document the contract clearly in code comments and emit deterministic deltas from the final output this sprint. |
| Child-model override produces invalid provider/model combinations | Medium | Medium | Validate against configured providers and fail the tool call cleanly with a structured error. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| `execa` | Execution timing, timeout handling, git-root discovery, and OS/process metadata plumbing already depend on it |
| `ajv` | Tool schema validation continues to enforce the richer tool inputs |
| `ignore` | Shared `.gitignore` handling for `grep` and `list_dir` |
| `vitest` | Contract-level regression coverage for the agent loop |
| Node built-ins (`fs/promises`, `path`, `os`) | No new runtime package should be needed for this sprint |

**Expected package churn:** none. This sprint should land without adding a new npm dependency.
