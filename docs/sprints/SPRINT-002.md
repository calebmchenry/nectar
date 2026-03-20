# Sprint 002: Complete Attractor Core Engine with LLM Integration

## Overview

**Goal:** Deliver the core AI execution capability of Nectar by completing the attractor engine's handler set, validation pipeline, and goal gate enforcement — backed by a single-provider LLM client that enables real API calls. After this sprint, `pollinator run` can execute pipelines containing LLM tasks (`box` nodes) that make real API calls to Anthropic (with simulation mode fallback), enforce goal gates before pipeline exit, route conditionally through diamond nodes, and validate graphs against structural rules.

**Scope:**
- Fix Sprint 001 bugs (parse test node count, engine test timeout)
- Extended outcome statuses: `PARTIAL_SUCCESS`, `RETRY`, `SKIPPED` (GAP-22)
- `!=` operator in condition expressions (GAP-23)
- Codergen handler (`box` shape) with `$goal` expansion and simulation mode (GAP-01, GAP-14)
- Single-provider LLM client — Anthropic (GAP-50, scoped)
- Goal gate enforcement at terminal nodes with retry/fallback routing (GAP-07, GAP-08)
- Conditional handler (`diamond` shape) — pass-through routing (GAP-02 partial)
- AST transform pipeline: parse → transform → validate (GAP-17 partial)
- `$goal` variable expansion as an AST transform
- Structural validation rules (GAP-17)
- Run directory structure with per-node artifacts (GAP-14)

**Out of scope (deferred to Sprint 003+):**
- Wait.human / Interviewer interface (GAP-02 remainder, GAP-09)
- Additional LLM providers — OpenAI, Gemini (GAP-50 remainder)
- Full tool calling in LLM client (text-in/text-out sufficient for MVP)
- Coding Agent Loop (GAP-40)
- Parallel / Fan-in / Manager Loop handlers (GAP-04, GAP-05, GAP-06)
- Model Stylesheets (GAP-10)
- Web UI / HTTP Server

---

## Use Cases

1. **Run an AI-powered pipeline:** `pollinator run gardens/plan-and-execute.dot` executes a pipeline where a `box` node sends a prompt (with `$goal` expanded) to Claude via the Anthropic API, and saves the response to `.nectar/cocoons/<run-id>/<node-id>/response.md`.
2. **Run without API keys:** The same pipeline runs in simulation mode when `ANTHROPIC_API_KEY` is not set, returning a simulated response. This enables local development, CI, and demos without credentials.
3. **Goal gate enforcement:** A pipeline reaches an `Msquare` exit node. The engine checks all visited `goal_gate=true` nodes. If any are not successful, it reroutes to `retry_target` instead of exiting.
4. **Conditional branching:** Diamond nodes route execution based on edge conditions, including the new `!=` operator (e.g., `context.status!=done`).
5. **Pipeline validation:** `pollinator validate` catches structural errors (unreachable nodes, missing start/exit invariants) and warns about missing prompts on LLM nodes.

---

## Architecture

### Module Layout Additions

```
nectar/
├── src/
│   ├── llm/                        # LLM Client (GAP-50, Anthropic-only for now)
│   │   ├── types.ts                # Request/Response/Message models
│   │   ├── client.ts               # Client interface + Anthropic provider
│   │   └── simulation.ts           # Simulation mode (no API key fallback)
│   ├── handlers/
│   │   ├── codergen.ts             # Box shape handler (GAP-01)
│   │   └── conditional.ts          # Diamond shape handler
│   ├── transforms/
│   │   └── goal-expansion.ts       # $goal variable expansion AST transform
│   ...
```

### Key Abstractions

**`LLMClient`** — Interface with a `generate(request): Promise<Response>` method. Two implementations: `AnthropicProvider` (real API calls via `fetch`) and `SimulationProvider` (returns deterministic simulated responses based on the prompt).

**`CodergenHandler`** — Implements `NodeHandler` for `box` shape. Reads node `prompt` attribute (already `$goal`-expanded by the transform pipeline), calls `LLMClient.generate()`, writes `prompt.md`, `response.md`, and `status.json` to the node's run directory.

**`ConditionalHandler`** — Implements `NodeHandler` for `diamond` shape. Pass-through that returns `SUCCESS`; routing is handled by the existing edge selector evaluating conditions on outgoing edges.

**`GoalGate`** — Engine enhancement. Before processing a terminal node, checks all visited `goal_gate=true` nodes. If any did not achieve `success`, overrides the next node with `retry_target` (falling back to `fallback_retry_target`, then graph-level targets).

**Transform Pipeline** — New stage between parsing and validation: `parse → transform → validate`. Transforms modify the parsed graph AST (e.g., expanding `$goal` references in prompt attributes).

---

## Implementation

### Phase 1: Fix Existing Issues & Engine Foundation (15%)

- Fix parse test (compliance-loop.dot node count: 14 not 13)
- Fix engine test timeout
- Add `PARTIAL_SUCCESS`, `RETRY`, `SKIPPED` to `NodeStatus` type in `src/engine/types.ts`
- Update retry logic to handle `RETRY` status
- Implement `!=` operator in `src/engine/conditions.ts`
- Parse `goal_gate`, `retry_target`, `fallback_retry_target` attributes in `src/garden/parse.ts`
- Update backoff: initial_delay=200ms, jitter via random(0.5, 1.5), max_delay=60s
- **Validation:** Unit tests for `!=` operator, extended status types. All existing tests pass.

### Phase 2: LLM Client & Codergen Handler (35%)

- Define canonical types in `src/llm/types.ts`: `Message`, `Request`, `Response`
- Implement `AnthropicProvider` using `fetch` against `https://api.anthropic.com/v1/messages`
  - Environment variable: `ANTHROPIC_API_KEY`
  - Handle HTTP 429 (rate limit) with exponential backoff
  - Handle missing/invalid API key gracefully
- Implement `SimulationProvider` that returns deterministic simulated responses (echoes prompt summary + fixed completion text)
- Implement `LLMClient` factory: if `ANTHROPIC_API_KEY` is set, use `AnthropicProvider`; otherwise, use `SimulationProvider`
- Implement `CodergenHandler` in `src/handlers/codergen.ts`:
  - Read node `prompt` attribute
  - Call `LLMClient.generate()`
  - Write `prompt.md`, `response.md`, `status.json` to `.nectar/cocoons/<run-id>/<node-id>/`
  - Handle empty LLM response (treat as FAILURE)
  - Handle missing `prompt` attribute (treat as FAILURE with descriptive error)
- Implement `ConditionalHandler` in `src/handlers/conditional.ts`: returns SUCCESS, routing deferred to edge selector
- Register both handlers in `src/handlers/registry.ts`
- Update `SUPPORTED_SHAPES` in validation to allow `box` and `diamond`
- **Validation:** Mocked HTTP tests for AnthropicProvider. End-to-end test with SimulationProvider. Unit tests for ConditionalHandler.

### Phase 3: Goal Gates & Failure Routing (20%)

- Implement goal gate enforcement in `src/engine/engine.ts`:
  - When reaching exit node, collect all visited `goal_gate=true` nodes
  - If any are not `success`, select `retry_target` → `fallback_retry_target` → graph-level retry targets
  - Increment retry counter; if exceeds `max_retries`, fail hard (infinite loop protection)
- Implement graph-level `retry_target` and `fallback_retry_target`
- Handle edge cases:
  - `retry_target` points to non-existent node → FAILURE with descriptive error
  - Multiple goal gates fail → use first failed gate's `retry_target`, fall back to graph-level
  - `retry_target` not defined on node or graph → FAILURE (no silent infinite retry)
- **Validation:** Test fixture `goal-gate-retry.dot`. Tests for infinite loop protection, missing targets, cascading failures.

### Phase 4: Validation Rules & Transform Pipeline (20%)

- Implement transform pipeline: `parse → transform → validate` in a new orchestration function
- Implement `$goal` expansion transform in `src/transforms/goal-expansion.ts`:
  - Replace `$goal` in `prompt` attributes with graph's `goal` attribute value
  - If `$goal` referenced but graph has no `goal` attribute → validation warning
- Implement validation rules in `src/garden/validate.ts`:
  - `start_no_incoming`: start nodes must have no incoming edges (error)
  - `exit_no_outgoing`: exit nodes must have no outgoing edges (error)
  - `reachability`: all nodes reachable from start via BFS (error)
  - `type_known`: node types are recognized (warning)
  - `fidelity_valid`: fidelity values are in valid range (warning)
  - `retry_target_exists`: retry_target references existing nodes (warning)
  - `goal_gate_has_retry`: goal_gate nodes should have retry_target (warning)
  - `prompt_on_llm_nodes`: box nodes should have prompt attribute (warning)
- **Validation:** Unit tests for each rule. Tests for transform pipeline ordering.

### Phase 5: Run Directory & Integration (10%)

- Per-node directory: `.nectar/cocoons/<run-id>/<node-id>/`
- `status.json` written after each node completes (status, duration, timestamps)
- `prompt.md` and `response.md` for codergen nodes
- Ensure parent directories created before writes (handle file system errors)
- Create sample pipeline `gardens/plan-and-execute.dot` exercising codergen + goal gates
- Update compliance report with gap closures
- **Validation:** End-to-end test running sample pipeline in simulation mode.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/types.ts` | Modify | Add `partial_success`, `retry`, `skipped` statuses |
| `src/engine/conditions.ts` | Modify | Implement `!=` operator |
| `src/engine/engine.ts` | Modify | Goal gate enforcement, retry routing |
| `src/garden/parse.ts` | Modify | Parse `goal_gate`, `retry_target`, `fallback_retry_target` |
| `src/garden/validate.ts` | Modify | Add 8 validation rules, allow `box`/`diamond` shapes |
| `src/handlers/registry.ts` | Modify | Register CodergenHandler, ConditionalHandler |
| `src/llm/types.ts` | Create | Unified LLM types (Message, Request, Response) |
| `src/llm/client.ts` | Create | LLM client interface, AnthropicProvider, factory |
| `src/llm/simulation.ts` | Create | SimulationProvider for offline/CI use |
| `src/handlers/codergen.ts` | Create | Handler for `box` nodes (LLM execution) |
| `src/handlers/conditional.ts` | Create | Handler for `diamond` nodes (pass-through routing) |
| `src/transforms/goal-expansion.ts` | Create | `$goal` variable expansion AST transform |
| `test/engine/conditions.test.ts` | Modify | Tests for `!=` operator |
| `test/engine/engine.test.ts` | Modify | Tests for goal gates, retry routing |
| `test/llm/client.test.ts` | Create | Mocked tests for AnthropicProvider |
| `test/llm/simulation.test.ts` | Create | Tests for SimulationProvider |
| `test/handlers/codergen.test.ts` | Create | Tests for CodergenHandler |
| `test/handlers/conditional.test.ts` | Create | Tests for ConditionalHandler |
| `test/transforms/goal-expansion.test.ts` | Create | Tests for $goal transform |
| `test/garden/validate.test.ts` | Modify | Tests for new validation rules |
| `test/fixtures/goal-gate-retry.dot` | Create | Fixture for goal gate testing |
| `gardens/plan-and-execute.dot` | Create | Sample pipeline exercising codergen + goal gates |

---

## Definition of Done

- [ ] All existing tests pass (regression gate) — parse test and engine test bugs fixed
- [ ] `pollinator run` executes a DOT file with a `box` node making a real LLM call (with `ANTHROPIC_API_KEY` set)
- [ ] `pollinator run` executes the same file in simulation mode without API keys
- [ ] `$goal` expansion works via the transform pipeline (not handler-level)
- [ ] Conditional (diamond) nodes route correctly based on edge conditions
- [ ] `!=` operator works in edge conditions (unit tested)
- [ ] Goal gate enforcement blocks exit and reroutes to `retry_target` (test fixture)
- [ ] Infinite loop protection: goal gate retries respect `max_retries` and fail hard
- [ ] Per-node artifacts (`prompt.md`, `response.md`, `status.json`) written to run directory
- [ ] 8 new validation rules implemented with tests (errors and warnings)
- [ ] `pollinator validate` accepts `box` and `diamond` shapes
- [ ] Sample pipeline `gardens/plan-and-execute.dot` runs end-to-end in simulation mode
- [ ] `npm run build && npm test` passes
- [ ] Compliance report updated with gap closures

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Anthropic API schema changes or rate limits during development | Medium | Medium | Use `fetch` with pinned API version header. Handle 429 with exponential backoff. SimulationProvider as fallback for development. |
| Goal gate routing creates infinite loops | Medium | High | Enforce `max_retries` counter on goal gate retries. If exceeded, fail hard with descriptive error. Explicit test for this scenario. |
| Sprint scope too broad — 5 phases is ambitious | Medium | Medium | Phases are prioritized: P1-P3 are must-haves, P4-P5 can be partially deferred. Validation rules and sample pipeline are the most deferrable items. |
| Simulation mode diverges from real LLM behavior | Low | Medium | SimulationProvider returns structured responses matching AnthropicProvider's response shape. Both implement the same `LLMClient` interface. |
| New statuses break checkpoint deserialization | Low | Medium | Ensure backward-compatible parsing — unknown statuses treated as `failure`. Add migration note to checkpoint types. |
| Transform pipeline introduces regressions in parsing | Low | High | Transform is a new stage inserted between existing parse and validate — does not modify either. Existing tests serve as regression gate. |

---

## Dependencies

- **External:** No new packages required. LLM client uses standard `fetch`. Avoiding vendor SDKs per spec.
- **Upstream Specs:** `attractor-spec.md`, `unified-llm-spec.md` (for LLM type definitions and provider behavior).
- **Sprint 001:** Depends on existing engine, parser, handlers, and checkpoint infrastructure.
