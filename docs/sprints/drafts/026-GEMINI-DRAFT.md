# Sprint 002: Engine Resilience & LLM Parity

## Overview

**Goal:** Close the highest-impact compliance gaps in the core execution engine and unified LLM client. This sprint addresses critical reliability issues (failure routing, retries, loop detection) and multi-provider parity (image inputs, Gemini tool IDs, stop reasons) identified in the latest compliance report.

**Scope:** 
- **Attractor Engine:** Fix retry logic to trigger on `failure` (GAP-A1) and implement the full failure routing fallback chain (GAP-A3).
- **Agent Loop:** Update loop detection to steer rather than terminate (GAP-C1) and fix the `grep`/`glob` abstraction leak in the Execution Environment (GAP-C8).
- **Unified LLM:** Fix image input parsing across all providers (GAP-U1), standardize `StopReason` (GAP-U2), update the model catalog (GAP-U3), and fix Gemini tool call ID collisions (GAP-U8).

**Out of scope:**
- Medium/Low priority gaps (e.g., streaming events, system prompts).
- Web UI ("The Hive") and Idea Backlog ("The Seedbed").
- HTTP Server features.

---

## Use Cases

1. **Robust Pipeline Recovery:** A tool node fails with exit code 1. The engine checks `max_retries` and retries automatically. If it still fails, the engine evaluates the full fallback chain: fail-condition edge → `retry_target` → `fallback_retry_target` → graph-level targets → termination, rather than just terminating or checking goal gates.
2. **Graceful Agent Loop Steering:** When the agent loop detects a repetition pattern (e.g., trying the same broken command 3 times), instead of crashing the session, it injects a `SteeringTurn` warning the LLM that it is looping, allowing the model to correct its approach.
3. **Provider-Agnostic Image Support:** A user submits a prompt with a local file path to an image or a URL. The Unified LLM Client correctly resolves, encodes, and passes the image to Anthropic, OpenAI, or Gemini without adapter-specific omissions.
4. **Reliable Gemini Tool Calling:** An agent running on Gemini calls the same tool multiple times in parallel. The adapter assigns synthetic unique UUIDs, preventing tool call ID collisions and allowing proper tool result mapping.

---

## Architecture

No new major architectural components are introduced. Work is strictly corrective within existing boundaries:
- **Engine Core:** `src/engine/engine.ts` will be updated to handle the `failure` state uniformly alongside `retry`, and the fallback routing logic will be expanded to a 5-step fallback chain.
- **Agent Loop:** `src/agent-loop/session.ts` logic will be patched to catch loop detection events and push a system-level steering message. `LocalExecutionEnvironment` will implement native `grep` and `glob` to properly encapsulate file system searches.
- **Unified LLM:** Adapters (`src/llm/adapters/*.ts`) will be updated to conform to standard `StopReason` types. Image processing logic will be centralized to detect local paths, convert them to base64, and format them for each provider's specific API requirements. `catalog.ts` will be refreshed.

---

## Implementation phases

### Phase 1: Engine Resilience (GAP-A1, GAP-A3)

**Tasks:**
- Modify `engine.ts` to trigger retry logic when a handler returns `status === 'failure'`, not just `status === 'retry'`, if `max_retries` allows.
- Implement the full failure fallback chain in the engine's edge/target selection logic:
  1. Check for outgoing edges with a fail condition (`condition="outcome=fail"`).
  2. If none, jump to the node's `retry_target`.
  3. If none, jump to the node's `fallback_retry_target`.
  4. If none, check graph-level `fallback_retry_target`.
  5. If none, terminate pipeline with error.
- Add unit tests verifying the fallback chain order of precedence.

### Phase 2: Agent Loop Corrections (GAP-C1, GAP-C8)

**Tasks:**
- In `session.ts`, catch `AgentLoopDetectedEvent` during the processing cycle. Instead of returning a failure result and terminating, append a `SteeringTurn` with a warning message to the conversation history and continue the loop.
- Add `grep(pattern, options)` and `glob(pattern, options)` methods to the `ExecutionEnvironment` interface and implement them in `LocalExecutionEnvironment`.
- Refactor `grep.ts` and `glob.ts` tools to use the `ExecutionEnvironment` abstraction instead of direct `fs` or `child_process` calls.

### Phase 3: Unified LLM Client Parity (GAP-U1, GAP-U2, GAP-U3, GAP-U8)

**Tasks:**
- Unify `StopReason` enum to use `stop`, `tool_calls`, `content_filter`, `error`, `other` across all adapters. Map native provider reasons to these standard values.
- Fix Image Input: Add a pre-processing step to resolve local file paths in image content parts to base64. Fix the Anthropic adapter to handle URL-based images (by fetching them if necessary, or stripping if unsupported per spec), and implement image passing in the OpenAI adapter.
- Update `gemini.ts` to generate synthetic `call_<uuid>` tool call IDs instead of using the function name, storing a mapping if necessary to resolve the response.
- Update `catalog.ts` with the latest specified models (e.g., GPT-5.2 family, Gemini 3.1 preview) per the spec requirements.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/engine.ts` | Modify | Fix failure retries (GAP-A1) and failure routing chain (GAP-A3) |
| `src/agent-loop/session.ts` | Modify | Update loop detection to steer instead of terminate (GAP-C1) |
| `src/agent-loop/execution-environment.ts` | Modify | Add `grep` and `glob` to `LocalExecutionEnvironment` (GAP-C8) |
| `src/agent-loop/tools/grep.ts` | Modify | Use environment abstraction |
| `src/agent-loop/tools/glob.ts` | Modify | Use environment abstraction |
| `src/llm/adapters/openai.ts` | Modify | Standardize StopReason (GAP-U2), fix image input (GAP-U1) |
| `src/llm/adapters/anthropic.ts` | Modify | Standardize StopReason (GAP-U2), fix image URLs (GAP-U1) |
| `src/llm/adapters/gemini.ts` | Modify | Standardize StopReason (GAP-U2), fix tool call IDs (GAP-U8) |
| `src/llm/catalog.ts` | Modify | Update to spec-mandated models (GAP-U3) |
| `src/llm/types.ts` | Modify | Ensure provider-agnostic StopReason type |
| `test/engine/engine.test.ts` | Modify | Add tests for fallback chain and failure retries |
| `test/agent-loop/session.test.ts` | Modify | Test `SteeringTurn` injection on loop detection |
| `test/agent-loop/execution-environment.test.ts` | Modify | Verify grep/glob encapsulation |

---

## Definition of Done

- [ ] Engine retries handlers that return `status === 'failure'` when `max_retries > 0`.
- [ ] Engine correctly routes unhandled failures through the 5-step fallback chain.
- [ ] Loop detection injects a `SteeringTurn` warning rather than aborting the session.
- [ ] Tools `grep` and `glob` execute solely through the `ExecutionEnvironment` abstraction.
- [ ] All three LLM adapters return standard `StopReason` values.
- [ ] Local file path and URL image inputs are consistently handled across Anthropic, OpenAI, and Gemini adapters.
- [ ] Gemini tool calls utilize synthetic UUIDs, allowing multiple concurrent calls to the same tool.
- [ ] Model catalog accurately reflects the spec's target models (e.g., GPT-5.2).
- [ ] All unit and integration tests pass.

---

## Risks

- **Image Pre-processing Overhead:** Fetching URLs or reading large local images synchronously before dispatching LLM requests might cause UI blocking or delays. Must ensure async processing.
- **Gemini Tool Mapping:** Creating synthetic UUIDs for Gemini requires maintaining a map of `uuid -> function_name` to correctly format the tool result back to the Gemini API. Needs careful state tracking in the adapter.
- **Fallback Chain Complexity:** The 5-step fallback chain interacts heavily with existing condition edge evaluation. Thorough tests needed to prevent regressions in standard success routing.

---

## Dependencies

- None (all fixes are internal logic corrections).