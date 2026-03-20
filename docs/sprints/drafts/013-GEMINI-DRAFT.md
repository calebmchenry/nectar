# Sprint NEXT: Subagents & Manager Loop

## Overview

**Goal:** Achieve full compliance with the Coding Agent Loop spec by implementing the missing subagent tools (C1) and the high-level `generate()` loop (L9). To complement task delegation at the pipeline level, we will also implement the missing Manager loop handler (A1). This sprint closes the only remaining "High" severity gap blocking spec compliance.

**Scope:** 
- Subagent tools for parallel task decomposition: `spawn_agent`, `send_input`, `wait`, `close_agent` (C1)
- High-level `generate()` function in the Unified LLM SDK with tool execution loop and `StepResult` tracking (L9)
- Manager loop handler (`house` shape) for child pipeline observation and steering (A1)
- Un-truncated `TOOL_CALL_END` event to complete the agent transcript logging (C3)

**Out of scope:**
- HTTP server mode and REST APIs (A2)
- Artifact store (A3)
- Model catalog (L8) and Middleware support (L7)
- Context fidelity enforcement (A4)
- Web UI ("The Hive") and CLI Seedbed commands

---

## Use Cases

1. **Parallel Task Decomposition (Subagents):** A complex Codergen node (e.g., "Implement a large feature") decides to split the work. It uses `spawn_agent` to create two sub-sessions, sends them instructions via `send_input`, and uses `wait` to collect their results concurrently. Finally, it uses `close_agent` to clean them up.
2. **High-Level SDK Generation:** Developers using the Nectar Unified LLM Client can call `client.generate()` instead of manually looping over `generateUnified()`. The high-level method automatically executes tools and tracks the conversation history up to `max_tool_rounds`.
3. **Manager Loop / Supervisor Pipeline:** A DOT pipeline defines a `house` shaped node (`stack.manager_loop`). This node monitors the execution of a child pipeline, allowing it to step in, provide steering instructions, or abort the child run if it detects a loop or failure.
4. **Complete Tool Transcripts:** When a tool call completes, the event stream fires `TOOL_CALL_END` with the exact, un-truncated output from the tool, allowing the transcript logger to record full details even if the LLM context only received truncated output.

---

## Architecture

### Module Additions & Modifications

1. **Subagent Tool Handlers (`src/agent-loop/tools/subagent/`)**
   - We need a `SubagentManager` inside the `AgentSession` context to manage the lifecycle of spawned child sessions.
   - `spawn_agent(name, system_prompt)`: Instantiates a child `AgentSession` and tracks it.
   - `send_input(agent_id, message)`: Pushes a message into the child session's steering queue or as a standard input.
   - `wait(agent_id, timeout)`: Awaits the resolution of the child session's current processing state.
   - `close_agent(agent_id)`: Gracefully terminates the child session.
   - *Constraint:* Subagent depth limits must be enforced to prevent infinite recursive spawning.

2. **High-Level Generate Loop (`src/llm/client.ts` & `src/llm/generate.ts`)**
   - Add `generate(request, options)` to `UnifiedClient` that wraps the existing `generateUnified()` and `executeToolsBatch()`.
   - Implement the `StepResult` tracking to capture each round of LLM turn -> Tool execution -> Result.
   - Introduce `max_tool_rounds` to prevent runaway generation.

3. **Manager Loop Handler (`src/handlers/manager.ts`)**
   - Mapped to `shape="house"`.
   - The handler takes a `pipeline_ref` (path to another DOT file) and starts a child `PipelineEngine`.
   - It hooks into the child engine's events to monitor progress.
   - It exposes a context interface that allows the manager node to steer the child pipeline or extract outcomes.

4. **Event Updates (`src/agent-loop/events.ts`)**
   - Update `agent_tool_call_completed` to include `full_output: string` alongside the truncated `output` field.

### Data Flow for Subagents

```
Parent AgentSession 
  ├── executes `spawn_agent` tool 
  │     └── SubagentManager creates Child AgentSession
  ├── executes `send_input` tool
  │     └── Child AgentSession processes input via `AgentSession.submit()`
  ├── executes `wait` tool
  │     └── Parent pauses until Child AgentSession completes turn
  └── executes `close_agent` tool
        └── Child AgentSession is aborted and removed
```

---

## Implementation Phases

### Phase 1: High-Level `generate()` Loop (L9)

**Files:** `src/llm/client.ts`, `src/llm/generate.ts`, `src/llm/types.ts`, `test/llm/generate.test.ts`

**Tasks:**
- Define `StepResult` type to track individual LLM turns and their associated tool calls.
- Implement `UnifiedClient.generate()` to orchestrate the loop:
  1. Call `generateUnified()`.
  2. If `stop_reason === 'tool_use'`, execute tools via `executeToolsBatch()`.
  3. Append tool results to messages and repeat until `end_turn`, `max_tokens`, or `max_tool_rounds` is reached.
- Return the final `Response` with the full array of `StepResult`s attached.

### Phase 2: Subagent Manager & Tools (C1)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/subagent-manager.ts`, `src/agent-loop/tools/spawn-agent.ts`, `src/agent-loop/tools/send-input.ts`, `src/agent-loop/tools/wait.ts`, `src/agent-loop/tools/close-agent.ts`, `src/agent-loop/tool-registry.ts`

**Tasks:**
- Create `SubagentManager` to track spawned agent IDs, their instances, and enforce the maximum nesting depth (default 3).
- Implement `spawn_agent` tool handler: initializes an `AgentSession`, returns `agent_id`.
- Implement `send_input` tool handler: calls `session.submit(message)` on the target child.
- Implement `wait` tool handler: awaits the Promise from the child's `submit` or `followUp`.
- Implement `close_agent` tool handler: calls `session.close()` and cleans up.
- Register these tools in the default toolset for provider profiles.

### Phase 3: Untruncated Tool Output Event (C3)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/events.ts`, `src/agent-loop/transcript.ts`

**Tasks:**
- Update the internal tool execution loop to preserve the original, untruncated tool output.
- Emit the untruncated output in the `AgentToolCompleted` event.
- Ensure `TranscriptWriter` uses this untruncated output for `status.json` and tool log files, while the LLM context only receives the truncated version.

### Phase 4: Manager Loop Handler (A1)

**Files:** `src/handlers/manager.ts`, `src/handlers/registry.ts`, `src/garden/validate.ts`, `test/handlers/manager.test.ts`

**Tasks:**
- Create `ManagerLoopHandler` mapped to `shape="house"`.
- Implement child pipeline invocation using a new `PipelineEngine` instance.
- Pass parent context selectively to the child, and merge child outcomes back to the parent.
- Update `src/garden/validate.ts` to allow `shape="house"`.
- Write unit tests proving the manager node blocks until the child pipeline reaches an exit node.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/generate.ts` | Create | High-level tool execution loop logic |
| `src/llm/client.ts` | Modify | Expose `generate()` method |
| `src/llm/types.ts` | Modify | Add `StepResult` type |
| `src/agent-loop/subagent-manager.ts` | Create | Track child agents and depth limits |
| `src/agent-loop/tools/spawn-agent.ts` | Create | Subagent `spawn_agent` tool |
| `src/agent-loop/tools/send-input.ts` | Create | Subagent `send_input` tool |
| `src/agent-loop/tools/wait.ts` | Create | Subagent `wait` tool |
| `src/agent-loop/tools/close-agent.ts` | Create | Subagent `close_agent` tool |
| `src/agent-loop/tool-registry.ts` | Modify | Register subagent tools |
| `src/agent-loop/session.ts` | Modify | Integrate `SubagentManager`, pass untruncated tool outputs |
| `src/agent-loop/events.ts` | Modify | Update `AgentToolCompleted` type |
| `src/agent-loop/transcript.ts` | Modify | Write untruncated outputs to logs |
| `src/handlers/manager.ts` | Create | `house` shape / manager loop handler |
| `src/handlers/registry.ts` | Modify | Map `house` to ManagerLoopHandler |
| `src/garden/validate.ts` | Modify | Allow `house` shape in validation |
| `test/llm/generate.test.ts` | Create | Tests for high-level tool loop |
| `test/agent-loop/subagents.test.ts` | Create | Integration tests for subagent tool usage |
| `test/handlers/manager.test.ts` | Create | Unit tests for manager loop child pipeline |

---

## Definition of Done

- [ ] `client.generate()` correctly manages `StepResult` iterations up to `max_tool_rounds`.
- [ ] Subagent tools (`spawn_agent`, `send_input`, `wait`, `close_agent`) execute successfully and maintain independent child session contexts.
- [ ] Subagent spawning enforces a hard depth limit to prevent infinite recursion.
- [ ] `TOOL_CALL_END` (via `AgentToolCompleted` event) explicitly includes the untruncated output, and `TranscriptWriter` captures it correctly.
- [ ] Pipelines containing `shape="house"` (Manager Loop) validate successfully and execute their target child pipelines.
- [ ] Unit and integration tests pass for all new modules (`npm test`).
- [ ] The `docs/compliance-report.md` can be updated to mark C1, C3, L9, and A1 as "IMPLEMENTED".

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Infinite Subagent Recursion:** A codergen node spawned agents that spawn agents infinitely. | High | High | Enforce a strict `max_depth` (e.g., 3) at the `SubagentManager` level. Exceeding it returns a tool error to the LLM. |
| **Tool Loop Runaway:** `client.generate()` gets stuck in a loop of failed tool calls. | Medium | Medium | Strict enforcement of `max_tool_rounds` (default 10). The loop aborts with a clear error reason. |
| **Manager Loop Deadlock:** Child pipeline requires human interaction but the parent CLI isn't forwarding stdin. | Low | Medium | Ensure `Interviewer` instances are shared or correctly proxied down to child `PipelineEngine` instances. |
| **Context Bleed:** Child agents accidentally mutate the parent agent's context or history. | Low | High | Ensure `AgentSession` contexts and `ExecutionContext` clones are fully isolated upon initialization. |

---

## Dependencies

- No new external npm dependencies required for this sprint. All features leverage existing core abstractions (`AgentSession`, `PipelineEngine`, `UnifiedClient`).