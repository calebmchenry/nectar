# Sprint 008: Agentic Parallelism & Performance

## Overview

**Goal:** Drastically reduce latency and API costs for the Agent Loop by implementing concurrent tool execution and automatic prompt caching. This sprint closes **GAP-45** (Parallel Tool Exec in Agent Loop), **GAP-57** (Parallel Tool Exec in LLM SDK), **GAP-53** (Prompt Caching Auto-Injection), and **GAP-44** (Context Window Awareness).

While previous sprints resolved graph-level parallel execution (fan-out/fan-in), the inner agent loop still processes multiple tool calls sequentially. Enabling parallel tool execution—combined with smart prompt caching—will immediately unblock real-world performance for complex coding tasks where agents perform extensive codebase research.

**Scope:**
- **GAP-57:** LLM SDK layer support for executing multiple tool calls concurrently and packaging the results into a single continuation request.
- **GAP-45:** Agent loop modifications to dispatch `execute()` calls to the `ToolRegistry` concurrently and aggregate results safely.
- **GAP-53:** Anthropic adapter auto-injection of `cache_control` breakpoints for system prompts, tool definitions, and the stable conversation prefix.
- **GAP-44:** Token usage tracking heuristic and threshold warnings (80% context window usage).

**Out of scope:**
- High-Level LLM API Functions (GAP-54)
- Subagents (GAP-41)
- Model Stylesheets (GAP-06)

---

## Use Cases

1. **Parallel Codebase Discovery:** An agent receives a vague feature request. It issues four `grep` commands and two `read_file` calls in a single response. The Agent Loop executes all six concurrently, dropping the round-trip latency from 6x tool execution time to 1x (the longest tool execution).
2. **Cost-Efficient Long Sessions:** A multi-turn debugging session uses Claude 3.5 Sonnet. The system automatically places `cache_control: {"type": "ephemeral"}` on the system prompt and the latest stable turn. As the agent loops, the massive system context is cached, reducing input token costs by up to 90% per turn.
3. **Context Window Warnings:** An agent enters an infinite loop of reading large files. At 80% context window capacity, the engine emits a `WARNING` event, enabling the supervisor or user to gracefully steer or abort the run before hitting a hard token limit error.

---

## Architecture

### Concurrency Model

- **Agent Session (`src/agent-loop/session.ts`):** 
  When the LLM response contains an array of `tool_calls`, the session will map these to an array of `Promise<ToolResultEnvelope>` via `ToolRegistry.execute()`. We will use `Promise.allSettled()` to guarantee that a single failing tool does not crash the entire concurrent batch.
- **Thread Safety in Execution Environment:** 
  The `LocalExecutionEnvironment` is already stateless regarding individual commands, but we must ensure concurrent `execa` calls do not clobber stdout/stderr logs or working directory assumptions. 

### Caching Strategy

- **Anthropic Adapter (`src/llm/adapters/anthropic.ts`):** 
  Implement the Anthropic prompt caching specification. Auto-inject breakpoints (`cache_control: true`) on:
  1. The final block of the `system` parameter (which includes the project instructions).
  2. The final tool in the `tools` array.
  3. The 3rd most recent `user` message to cache the stable prefix of the conversation.

### Context Window Tracking

- **Token Heuristic (`src/agent-loop/session.ts`):** 
  Track a running tally of input tokens + generated tokens based on the usage reported by the LLM client. Cross-reference this against the configured `model_context_limit`. Emit an `AgentEvent` of kind `WARNING` when `current / limit > 0.8`.

---

## Implementation phases

### Phase 1: Context Window Awareness (GAP-44) (~15%)

**Tasks:**
- [ ] Add `model_context_limit` to `AgentConfig` (default to 128k).
- [ ] Update `AgentSession` to maintain a running token count using the `Usage` object returned from each turn.
- [ ] Implement a threshold check: if `total_tokens > 0.8 * model_context_limit`, emit a `WARNING` event.
- [ ] Add tests to verify threshold calculation and event emission.

### Phase 2: Parallel Tool Execution in LLM SDK & Agent Loop (GAP-45, GAP-57) (~50%)

**Tasks:**
- [ ] Update `AgentSession.processInput()` to detect multiple tool calls in a `GenerateResponse`.
- [ ] Refactor the tool execution loop to use `Promise.all()` over `toolRegistry.execute(call, env)`.
- [ ] Ensure that `transcript.jsonl` and individual tool attempt files are written atomically and do not interleave incorrectly when executing concurrently.
- [ ] Update the LLM client's internal loop (if used by higher-level APIs) to correctly format the array of tool results into the next user message to satisfy provider requirements (Anthropic and OpenAI both require all tool results in a single turn).
- [ ] Emit `agent_tool_call_started` and `agent_tool_call_completed` events safely from asynchronous contexts.

### Phase 3: Anthropic Prompt Caching Auto-Injection (GAP-53) (~35%)

**Tasks:**
- [ ] Update `src/llm/adapters/anthropic.ts` to support the `cache_control` type on content parts and tools.
- [ ] Implement `injectCacheBreakpoints(request: GenerateRequest)`:
  - Add breakpoint to the system prompt string/array.
  - Add breakpoint to the last tool in the `tools` list.
  - Traverse the `messages` array backwards to find the appropriate stable prefix boundary (e.g., the last turn prior to the current execution step) and inject a breakpoint.
- [ ] Validate that `cache_read_tokens` and `cache_write_tokens` are correctly populated in the `Usage` output.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent-loop/session.ts` | Modify | Implement concurrent `Promise.all` execution, token tracking |
| `src/agent-loop/types.ts` | Modify | Add `model_context_limit` to config, define `WARNING` event |
| `src/llm/adapters/anthropic.ts` | Modify | Implement auto-injection of `cache_control` breakpoints |
| `src/llm/types.ts` | Modify | Add `cache_control` fields to `ToolDefinition` and `Message` types |
| `test/agent-loop/session.test.ts` | Modify | Add tests for parallel tool execution and token warnings |
| `test/llm/adapters/anthropic.test.ts` | Create | Test caching breakpoint auto-injection logic |
| `test/integration/parallel-tools.test.ts`| Create | End-to-end test of an agent calling multiple tools at once |

---

## Definition of Done

- [ ] When an LLM model returns 3 tool calls, `AgentSession` dispatches them concurrently. The total elapsed execution time should be approximately `max(t1, t2, t3)`, not `t1 + t2 + t3`.
- [ ] Tool results are correctly re-aggregated and sent back to the LLM in a well-formed continuation request.
- [ ] Anthropic requests automatically include up to 3 `cache_control` breakpoints without manual user configuration.
- [ ] The engine correctly surfaces `cache_read_tokens` in the event stream, proving that caching is working.
- [ ] Exceeding 80% of the context window correctly emits a `WARNING` event to the `EventRenderer`.
- [ ] All new components have >90% unit test coverage.
- [ ] Integration tests verify parallel execution behavior using a mock tool that sleeps.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Concurrency clobbering file system | Medium | High | `read_file` and `grep` are read-only and safe. `write_file` and `edit_file` should technically be safe if modifying different files, but we must ensure `LocalExecutionEnvironment` isolation. Add integration tests writing to disparate files. |
| Provider Tool-Result Formatting | High | Medium | Both OpenAI and Anthropic are very strict about matching tool call IDs and ordering. Ensure the order of the tool results strictly matches the order of the tool calls received. |
| Anthropic Caching Limits | Medium | Medium | Anthropic currently allows a maximum of 4 `cache_control` breakpoints per request. The auto-injection logic must count and cap breakpoints to prevent 400 Bad Request errors. |

---

## Dependencies

| Dependency | Purpose |
|---------|---------|
| N/A | No external dependencies are introduced in this sprint. |
