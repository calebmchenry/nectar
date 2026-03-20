# Sprint NEXT: Advanced Agent Capabilities

## Overview

**Goal:** Deliver the missing high-severity capabilities for the Coding Agent Loop: steering/follow-up queues, subagent orchestration, and the `apply_patch` tool. Closing these gaps (C1, C2, C3, C4, C5) will allow the agent to be interrupted and guided mid-task, spawn child agents for parallel or complex tasks, and use the efficient v4a patch format required for optimal OpenAI model performance.

**Scope:** 
- Implement `SessionState` and the `steer()` / `follow_up()` queues in `AgentSession`.
- Implement subagent orchestration through `spawn_agent`, `send_input`, `wait`, and `close_agent` tools.
- Implement the `apply_patch` tool for the OpenAI provider profile.

**Out of scope:** 
- UI or CLI changes not strictly required to interact with the steering queue.
- Gaps in the Attractor Spec or Unified LLM Client Spec (unless blocking).

---

## Use Cases

1. **Mid-Task Steering:** A user notices the agent is modifying the wrong file during a long-running task. The user sends a steering message ("Stop editing X, focus on Y"). The agent receives this at the start of its next tool round, acknowledges it in its internal reasoning, and changes course without losing its accumulated context.
2. **Follow-up Queuing:** While the agent is working, the user thinks of another task ("Also update the README"). They use `follow_up()`. The agent finishes its current work, transitions to IDLE, and immediately picks up the queued task.
3. **Efficient Code Editing (OpenAI):** When using the OpenAI provider, the agent needs to change 5 lines in a 1,000-line file. Instead of re-writing the whole file or struggling with line-number based search/replace, it uses the `apply_patch` tool with the v4a format, matching exact context lines.
4. **Subagent Delegation:** The agent is asked to implement a feature and write a complex test suite. It calls `spawn_agent` to create a subagent for the tests, sends it the requirements via `send_input`, and periodically checks its status using `wait` while continuing its own implementation work.

---

## Architecture

### Steering & State Machine
The `AgentSession` requires an explicit state machine: `IDLE`, `PROCESSING`, `AWAITING_INPUT`, and `CLOSED`.
- **Steering Queue:** Processed *during* the `PROCESSING` state. Before each LLM generation step, the loop checks the steering queue. If messages exist, they are injected into the message history as user interruptions, forcing the model to read them before deciding its next tool call.
- **Follow-up Queue:** Processed when transitioning to `IDLE`. If the queue is non-empty, the session immediately transitions back to `PROCESSING` with the follow-up message.

### Subagent Orchestration
A new `SubagentManager` (or extensions to `ExecutionEnvironment`) will track active child sessions.
- Child sessions are instances of `AgentSession` initialized with a constrained `SubagentEnvironment` to prevent them from breaking out of workspace bounds or exceeding budget limits.
- A depth limit (e.g., max 2 or 3 levels) will prevent infinite recursion.
- The parent agent uses 4 new tools to interact with this manager: `spawn_agent`, `send_input`, `wait_agent` (blocking or polling), and `close_agent`.

### Apply Patch Tool
The `apply_patch` tool parses the v4a patch format (search/replace blocks with context). 
- It will read the target file, locate the exact text block, verify the context, and apply the replacement.
- If context is ambiguous or missing, it will return a highly descriptive error so the LLM can try again.
- This tool will be added to the registry and set as the primary editing tool in the OpenAI `ProviderProfile`.

---

## Implementation Phases

### Phase 1: Session State & Steering Queues
**Files:** `src/agent-loop/types.ts`, `src/agent-loop/session.ts`, `test/agent-loop/session.test.ts`
**Tasks:**
- Implement the `SessionState` enum.
- Add `steer(message)` and `follow_up(message)` methods to the session interface.
- Refactor the core `processInput` loop to evaluate state transitions.
- Inject dequeued steering messages at the boundary of LLM turns.

### Phase 2: Apply Patch Tool
**Files:** `src/agent-loop/tools/apply-patch.ts`, `src/agent-loop/provider-profiles.ts`, `test/agent-loop/tools/apply-patch.test.ts`
**Tasks:**
- Implement a robust parser for the v4a patch format.
- Implement the application logic with strict context verification.
- Register `apply_patch` in the tool registry.
- Enable it natively for the OpenAI provider profile, adjusting the system prompt to instruct the model on its use.

### Phase 3: Subagent Tools
**Files:** `src/agent-loop/subagents.ts`, `src/agent-loop/tools/subagent-tools.ts`, `test/agent-loop/subagents.test.ts`
**Tasks:**
- Create the `SubagentManager` to lifecycle child sessions.
- Implement `spawn_agent` (returns an agent ID).
- Implement `send_input` (dispatches text to a subagent).
- Implement `wait_agent` (polls or blocks until subagent is IDLE or CLOSED, returning its output).
- Implement `close_agent` (terminates and cleans up the child session).
- Enforce the `max_subagent_depth` configuration.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/types.ts` | Modify | Add SessionState enum and steering/follow-up methods. |
| `src/agent-loop/session.ts` | Modify | Implement state machine, queues, and message injection. |
| `src/agent-loop/subagents.ts` | Create | Manage child AgentSession lifecycles and depth limits. |
| `src/agent-loop/tools/apply-patch.ts` | Create | Implement the v4a patch tool. |
| `src/agent-loop/tools/spawn-agent.ts` | Create | Tool: start a subagent. |
| `src/agent-loop/tools/send-input.ts` | Create | Tool: send input to subagent. |
| `src/agent-loop/tools/wait-agent.ts` | Create | Tool: wait for subagent completion. |
| `src/agent-loop/tools/close-agent.ts` | Create | Tool: terminate subagent. |
| `src/agent-loop/provider-profiles.ts` | Modify | Update OpenAI profile to use `apply_patch`. |
| `test/agent-loop/session.test.ts` | Modify | Assert steering interrupts active tools, follow-ups queue correctly. |
| `test/agent-loop/tools/apply-patch.test.ts`| Create | Exhaustive valid/invalid patch application tests. |
| `test/agent-loop/subagents.test.ts` | Create | Assert subagent lifecycle, tools, and recursion limits. |

---

## Definition of Done

- [ ] `AgentSession` properly tracks state (`IDLE`, `PROCESSING`, `AWAITING_INPUT`, `CLOSED`).
- [ ] `session.steer()` immediately injects a message into the active loop.
- [ ] `session.follow_up()` queues messages that trigger automatically when the session becomes `IDLE`.
- [ ] `apply_patch` tool is fully implemented and passes a suite of valid/invalid v4a patch tests.
- [ ] OpenAI profile uses `apply_patch` natively and successfully.
- [ ] `spawn_agent`, `send_input`, `wait_agent`, and `close_agent` tools allow the agent to orchestrate a child session.
- [ ] Subagent depth limit is strictly enforced to prevent infinite recursion.
- [ ] All new components have >90% test coverage.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Patch Application Flakiness** | High | High | Diff parsing can be brittle if models hallucinate whitespace. *Mitigation:* Implement strict v4a parsing but fallback to slightly fuzzier context matching if an exact match fails, or return highly descriptive errors so the LLM can auto-correct. |
| **Subagent Resource Exhaustion** | Medium | High | Runaway subagents could spawn indefinitely, consuming rate limits and CPU. *Mitigation:* Strict depth limits (e.g., 2 levels deep max) and a global cap on total active subagents per workspace. |
| **Steering Race Conditions** | Medium | Medium | Steering messages arriving exactly as the LLM is responding could be dropped or applied out of order. *Mitigation:* Ensure atomic queueing and clear sequence points in the `processInput` loop where steering messages are safely consumed. |

---

## Dependencies

- Existing Unified LLM Client SDK.
- The `AgentSession` architecture established in previous sprints.
- No new external runtime dependencies are anticipated, though a patch application library could be evaluated if the manual v4a implementation proves too brittle.