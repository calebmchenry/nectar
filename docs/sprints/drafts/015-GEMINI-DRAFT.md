# Sprint NEXT: Engine Fidelity & Supervisor Loop

## Overview

**Goal:** Close the most impactful remaining gaps in the core Attractor engine (A1, A4, A5) and the Coding Agent Loop (C1, C3). This sprint completes the engine's execution semantics by implementing runtime context fidelity enforcement, thread-based LLM session reuse, and the manager loop handler. 

**Scope:**
- Context fidelity runtime enforcement (`full`, `truncate`, `compact`, `summary:*`) (A4)
- Thread resolution for session reuse via `thread_id` (A5)
- Manager loop handler (`shape="house"`) (A1)
- Context window awareness and warnings (C1)
- Mid-session `reasoning_effort` updates (C3)
- `auto_status` runtime fallback (A11)

**Out of scope:**
- HTTP Server Mode and API (A2)
- Artifact Store formalization (A3)
- Unified LLM Client SDK additions (L7, L8, L9)

---

## Use Cases

1. **Context Fidelity Control:** A pipeline defines a `codergen` node with `fidelity="summary:high"`. Instead of passing the full raw execution history (which might blow out the context window), the engine automatically generates a summarized preamble of the context store and passes that to the LLM.
2. **Stateful Session Reuse:** Two sequential `codergen` nodes share `thread_id="feature-x"`. The engine reuses the exact same `AgentSession` for both nodes, maintaining the LLM's conversation history seamlessly across graph edges without redundant token copying.
3. **Supervisor Loops:** A `manager_loop` node oversees a sub-graph of execution. It acts as an intelligent supervisor, dynamically evaluating the outcomes of its child nodes, applying steering logic, and deciding whether to re-trigger children or exit the loop.
4. **Context Window Warnings:** During a long-running codergen session, token usage hits 80% of the provider's `context_window_size`. The engine automatically emits a warning event, allowing the CLI or UI to notify the user before the run crashes.

---

## Architecture

### Context Fidelity & Thread Management
The handling of LLM context must transition from "pass everything" to a structured, budget-aware pipeline.
- **ThreadResolver:** A new utility that resolves the effective `thread_id` for a node by checking (in order): node attribute -> incoming edge attribute -> graph default -> subgraph class -> previous node.
- **SessionStore:** Active `AgentSession`s will be cached in the `ExecutionContext` (or a dedicated `SessionStore` attached to it) keyed by `thread_id`.
- **FidelityProcessor:** Before a session is invoked, this processor applies the requested fidelity mode:
  - `full`: Uses the resolved session as-is.
  - `truncate`: Drops oldest context keys to fit a fixed token budget.
  - `compact`: Removes metadata and truncates values while keeping keys.
  - `summary:*`: Triggers a fast, cheap utility LLM call to summarize the context before prepending it.

### Manager Loop Handler
- **ManagerLoopHandler (`src/handlers/manager-loop.ts`):** Implements the `NodeHandler` interface.
- Maps to `shape="house"` in `HandlerRegistry`.
- It executes a specialized prompt (acting as a supervisor) that takes the outcomes of the nodes in its managed sub-graph, evaluates them against the loop's exit condition, and yields a decision to either loop back or continue down the pipeline.

### Agent Loop Refinements
- **Context Awareness:** `AgentSession` will track accumulated token usage against the `ProviderProfile.context_window_size`. When `usage > 0.8 * size`, it emits an `AgentContextWarningEvent`.
- **Dynamic Reasoning Effort:** Modifying `reasoning_effort` on the context or session midway through a run will be checked before the next `generate` call and applied dynamically.
- **Auto Status:** In `src/engine/engine.ts`, if a handler completes without returning an explicit `status`, and `auto_status=true` on the node, it will implicitly resolve to `SUCCESS`.

---

## Implementation Phases

### Phase 1: Thread Resolution & Session State (A5, C3)
**Tasks:**
- Implement `ThreadResolver` to compute the active `thread_id` following spec precedence.
- Update `PipelineEngine` and `ExecutionContext` to persist `AgentSession` instances across node boundaries based on `thread_id`.
- Modify `CodergenHandler` to retrieve an existing session or initialize a new one.
- Update `AgentSession` to allow mid-run updates to `reasoning_effort` before the next LLM call (C3).

### Phase 2: Context Fidelity Modes (A4) & Budget Warnings (C1)
**Tasks:**
- Implement `FidelityProcessor` with `truncate` and `compact` algorithms.
- Implement the `summary:*` fidelity mode using a secondary LLM call (using a fast model, e.g., Claude 3.5 Haiku or Gemini 1.5 Flash) to generate the preamble.
- Wire `FidelityProcessor` into `CodergenHandler` so context is processed before the system prompt is finalized.
- Add `context_window_size` limits to `ProviderProfile` definitions.
- Implement tracking in `AgentSession` to emit `agent_context_warning` at the 80% threshold.

### Phase 3: Manager Loop Handler (A1) & Minor Engine Gaps (A11)
**Tasks:**
- Create `src/handlers/manager-loop.ts`.
- Implement supervisor logic: evaluate child outcomes, produce a routing decision.
- Register `shape="house"` to `ManagerLoopHandler` in `src/handlers/registry.ts`.
- Update `src/engine/engine.ts` (Step 3: Collect Outcome) to default to `{ status: 'success' }` if `outcome.status` is empty and `node.auto_status === true`.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/thread-resolver.ts` | Create | Resolves `thread_id` per spec precedence (A5) |
| `src/engine/fidelity-processor.ts` | Create | Applies truncate/compact/summary context modes (A4) |
| `src/handlers/manager-loop.ts` | Create | Supervisor loop handler implementation (A1) |
| `src/handlers/codergen.ts` | Modify | Integrate ThreadResolver and FidelityProcessor |
| `src/handlers/registry.ts` | Modify | Register `house` shape to `ManagerLoopHandler` |
| `src/engine/engine.ts` | Modify | Implement `auto_status` fallback (A11) |
| `src/engine/context.ts` | Modify | Support storing `AgentSession` references |
| `src/agent-loop/session.ts` | Modify | Context window warning (C1), dynamic reasoning (C3) |
| `src/agent-loop/provider-profiles.ts` | Modify | Add `context_window_size` to profiles (C1) |
| `src/agent-loop/events.ts` | Modify | Add `AgentContextWarningEvent` definition |
| `test/engine/thread-resolver.test.ts` | Create | Tests for `thread_id` precedence |
| `test/engine/fidelity-processor.test.ts` | Create | Tests for fidelity transformations |
| `test/handlers/manager-loop.test.ts` | Create | Tests for supervisor routing logic |

---

## Definition of Done

- [ ] `ThreadResolver` correctly determines `thread_id` from node -> edge -> default -> class -> previous.
- [ ] `CodergenHandler` reuses the same `AgentSession` across nodes if they share a `thread_id`.
- [ ] `FidelityProcessor` correctly truncates, compacts, and summarizes context based on the `fidelity` attribute.
- [ ] `ManagerLoopHandler` correctly observes child nodes and steers graph execution.
- [ ] Changing `reasoning_effort` takes effect immediately on the next LLM call.
- [ ] A warning event is emitted when a session exceeds 80% of its provider's context window.
- [ ] Nodes with `auto_status=true` automatically succeed if their handler returns no explicit status.
- [ ] All new components have comprehensive unit tests.
- [ ] `npm test` passes without errors.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Context summarization (`summary:*`) introduces latency | High | Medium | Use the fastest available model (e.g. Flash/Haiku) for the summarization pass and aggressively cache. |
| Session reuse causes state pollution between unrelated nodes | Medium | High | Strict enforcement of `thread_id` scoping. If `thread_id` changes, force a clean session. |
| Supervisor loops become infinite loops | Medium | High | Rely on the existing `LoopDetection` module in the agent loop to catch repetitive behaviors, and enforce a strict `max_retries` or iteration limit on the `manager_loop` node itself. |

---

## Dependencies
- Existing `AgentSession` and `ProviderProfile` infrastructure.
- Existing `@ts-graphviz/parser` integration for extracting fidelity and thread attributes.