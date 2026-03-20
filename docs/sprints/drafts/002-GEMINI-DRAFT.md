# Sprint 002: The Swarm Awakens — Codergen & Goal Gates

## Overview

**Goal:** Deliver the core AI execution capability of Nectar by implementing the `codergen` handler (GAP-01), powered by the Unified LLM Client (GAP-50). In addition, complete the core engine routing logic by implementing Goal Gate Enforcement (GAP-07) and resolving minor condition/status gaps (GAP-22, GAP-23). After this sprint, `pollinator run` will be able to execute pipelines that contain LLM tasks (`box` nodes) that make real API calls to OpenAI, Anthropic, or Gemini, and enforce goal gates before pipeline exit.

**Scope:** 
- Unified LLM Client SDK supporting OpenAI, Anthropic, and Gemini (GAP-50 - limited to core generation and tool calling, omitting advanced image/audio for now).
- `codergen` Node Handler (`box` shape) with `$goal` variable expansion and status/prompt/response persistence (GAP-01, GAP-14).
- Goal Gate Enforcement at terminal nodes with fallback routing (GAP-07, GAP-08).
- Extension of `NodeOutcome` statuses to include `PARTIAL_SUCCESS`, `RETRY`, and `SKIPPED` (GAP-22).
- Addition of `!=` operator in condition expressions (GAP-23).

**Out of scope:**
- Coding Agent Loop (GAP-40) - the `codergen` handler will execute a single LLM call or simple tool loop, but the full autonomous agent session management will be a subsequent sprint.
- Wait.Human / Interviewer Interface (GAP-02, GAP-09).
- Parallel / Fan-in / Manager Loop handlers (GAP-04, GAP-05, GAP-06).
- Model Stylesheets (GAP-10).
- Web UI / HTTP Server.

---

## Use Cases

1. **Run an AI-powered pipeline:** `pollinator run gardens/plan-and-execute.dot` executes a pipeline where a `box` node (codergen) expands the graph's `goal` attribute, sends a prompt to an LLM provider (e.g., Claude), and saves the response to `.nectar/cocoons/<run-id>/<node-id>/response.md`.
2. **Goal Gate Enforcement:** A pipeline finishes the main execution path and hits an `Msquare` exit node. The engine checks all visited nodes marked with `goal_gate=true`. If any are not successful, the engine routes back to the `retry_target` instead of exiting.
3. **Multi-Provider Support:** The user can set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` to route codergen tasks to different providers based on node configuration or default settings.
4. **Advanced Conditions:** Pipeline edges can use `outcome=partial_success` or `context.status!=done` to route execution.

---

## Architecture

### Module Layout Additions

```
nectar/
├── src/
│   ├── llm/                      # Unified LLM Client (GAP-50)
│   │   ├── types.ts              # Request/Response/Message models
│   │   ├── client.ts             # Core client interface
│   │   └── providers/
│   │       ├── openai.ts         # Responses API adapter
│   │       ├── anthropic.ts      # Messages API adapter
│   │       └── gemini.ts         # generateContent API adapter
│   ├── handlers/
│   │   └── codergen.ts           # Box shape handler (GAP-01)
...
```

### Key Abstractions

**`UnifiedLLMClient`** — A multi-provider SDK implementing `generate()` and `stream()`. Handles provider routing based on the requested model (e.g., `gpt-4o` -> OpenAI, `claude-3-7-sonnet` -> Anthropic).

**`CodergenHandler`** — Implements `NodeHandler`. Reads node `prompt` attribute, expands `$goal`, calls `UnifiedLLMClient.generate()`, and writes `prompt.md`, `response.md`, and `status.json` to the node's run directory within the cocoon.

**`GoalGate`** — Engine enhancement. Before the engine processes a terminal node (`exit`), it checks the `context` or run history for any node with `goal_gate=true` that did not achieve `success`. If found, it dynamically selects the next edge based on the node's `retry_target`, effectively overriding the exit.

---

## Implementation

### Phase 1: Engine Enhancements (GAP-22, GAP-23, GAP-07, GAP-08)

- **Tasks:**
  - Update `NodeStatus` type to `'success' | 'failure' | 'partial_success' | 'retry' | 'skipped'`.
  - Update `src/engine/conditions.ts` to support the `!=` operator. Parse and evaluate it safely.
  - Update `src/garden/parse.ts` to parse `goal_gate` (boolean), `retry_target` (string), and `fallback_retry_target` (string) on nodes.
  - Modify `src/engine/engine.ts`: when reaching an exit node, evaluate all visited `goal_gate=true` nodes. If any are not `success`, override the next node ID with `retry_target` (or `fallback_retry_target`, or graph-level retry targets).
- **Validation:** Unit tests for `!=` operator, extended status types, and a test fixture `goal-gate-retry.dot` verifying the engine loops back.

### Phase 2: Unified LLM Client - Foundation (GAP-50)

- **Tasks:**
  - Define canonical unified types in `src/llm/types.ts`: `Message`, `ContentPart`, `Request`, `Response`, `Tool`.
  - Implement `UnifiedLLMClient` class with basic factory routing.
  - Implement `OpenAIProvider` using standard `fetch` against `https://api.openai.com/v1/chat/completions`.
  - Implement `AnthropicProvider` against `https://api.anthropic.com/v1/messages`.
  - Implement `GeminiProvider` against `https://generativelanguage.googleapis.com/v1beta/models/...`.
  - Standardize error handling and API key environment variable loading.
- **Validation:** Mocked HTTP tests for each provider ensuring the correct payload shape is sent and responses are correctly mapped to the unified `Response` type.

### Phase 3: Codergen Handler (GAP-01, GAP-14)

- **Tasks:**
  - Update `SUPPORTED_SHAPES` in validation to allow `box`.
  - Implement `src/handlers/codergen.ts`.
  - Add logic to expand `$goal` in the node's `label` or `prompt` attribute based on the graph's `goal` attribute.
  - Ensure the handler writes `prompt.md` and `response.md` to `.nectar/cocoons/<run-id>/<node-id>/` to satisfy GAP-14 (Run Directory Structure).
  - Register `CodergenHandler` in `src/handlers/registry.ts` mapped to `box` shape and `codergen` type.
- **Validation:** End-to-end execution of a DOT file containing a `box` node using a mock LLM provider, verifying that files are written to the cocoon directory and the context is updated.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/types.ts` | Modify | Add `partial_success`, `retry`, `skipped` to statuses |
| `src/engine/conditions.ts` | Modify | Implement `!=` operator |
| `src/garden/parse.ts` | Modify | Parse `goal_gate`, `retry_target`, `fallback_retry_target` |
| `src/engine/engine.ts` | Modify | Implement Goal Gate enforcement logic |
| `src/llm/types.ts` | Create | Unified LLM types (Message, Request, Response) |
| `src/llm/client.ts` | Create | Core LLM client and provider routing |
| `src/llm/providers/openai.ts` | Create | OpenAI API adapter |
| `src/llm/providers/anthropic.ts` | Create | Anthropic API adapter |
| `src/llm/providers/gemini.ts` | Create | Gemini API adapter |
| `src/handlers/codergen.ts` | Create | Handler for `box` nodes (LLM execution) |
| `src/handlers/registry.ts` | Modify | Register `CodergenHandler` |
| `src/garden/validate.ts` | Modify | Allow `box` shape in `SUPPORTED_SHAPES` |
| `test/engine/conditions.test.ts`| Modify | Add tests for `!=` |
| `test/engine/engine.test.ts` | Modify | Add tests for goal gates |
| `test/llm/*` | Create | Unit tests for LLM client and providers |
| `test/handlers/codergen.test.ts`| Create | Unit tests for CodergenHandler |
| `test/fixtures/goal-gate.dot` | Create | Fixture to test goal gate logic |

---

## Definition of Done

- [ ] All new types and operators (`!=`, `partial_success`) evaluate correctly and are covered by tests.
- [ ] Engine successfully catches failed `goal_gate` nodes at terminal exit and reroutes to `retry_target`.
- [ ] Unified LLM Client is implemented and can send/receive basic text generation requests to OpenAI, Anthropic, and Gemini (via mock or live integration tests).
- [ ] The `codergen` handler (`box` shape) is executed successfully during pipeline runs.
- [ ] The `codergen` handler correctly expands the `$goal` variable from the graph's attributes.
- [ ] Per-node LLM artifacts (`prompt.md`, `response.md`) are persisted correctly within the run's cocoon directory.
- [ ] `pollinator validate` no longer rejects `box` shapes.
- [ ] `npm run test` passes with full coverage of the newly added modules.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| API schema differences across LLM providers are difficult to unify | High | Medium | Start with a minimal subset of features for the unified client (text-in, text-out) before tackling complex tool-calling and image inputs. |
| Goal Gate routing creates infinite loops | Medium | High | Rely on the existing `max_retries` counter. If the goal gate forces a retry, increment the node's retry counter; if it exceeds `max_retries`, fail hard instead of looping forever. |
| Large LLM responses bloat memory | Low | Medium | Stream responses directly to the filesystem (`response.md`) where possible, or limit max tokens during this initial implementation phase. |

---

## Dependencies

- **External Packages:** May need `zod` or similar if robust validation of LLM JSON outputs is required, though standard `JSON.parse` with basic type guarding can suffice for MVP. We will avoid heavy vendor SDKs (e.g., `@anthropic-ai/sdk`, `openai`) in favor of direct standard `fetch` to keep the unified client lightweight, per spec.
- **Upstream Specs:** Requires close alignment with `unified-llm-spec.md` and `attractor-spec.md`.