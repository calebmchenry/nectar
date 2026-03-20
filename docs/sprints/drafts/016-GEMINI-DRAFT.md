# Sprint NEXT: System Completeness & Observability (LLM & Supervisor)

## Overview

**Goal:** Close the highest-priority functional and observability gaps identified in the latest compliance report, driving both the Unified LLM Client and the core Attractor engine to 100% specification compliance.

**Scope:** 
1. **Unified LLM Client:** Middleware/Interceptor pattern (GAP-L1), Model Catalog (GAP-L3), Cache Token Reporting (GAP-L4/L5), Module-Level Default Client (GAP-L2), RateLimitInfo (GAP-L7), ConfigurationError (GAP-L8), and OpenAI-Compatible endpoints (GAP-L6).
2. **Attractor Engine:** `stack.manager_loop` handler implementation (GAP-A1) to enable supervisor/child pipeline orchestration.

**Out of scope:**
- `loop_restart` edge attribute (GAP-A2) and Tool Call Hooks (GAP-A3), which will be handled in a follow-up execution-focused sprint.
- HTTP Server Mode (GAP-A4), which is optional per spec.

---

## Use Cases

1. **Middleware Interception:** Developers can register middleware functions to log LLM requests, track token usage across providers, and implement circuit breakers, wrapping the core client execution seamlessly without modifying the underlying provider adapters.
2. **Model Catalog:** The system can intelligently select the best model for a task using semantic queries like `get_latest_model('anthropic', 'reasoning')` instead of hardcoding opaque model IDs across pipelines.
3. **Cost Visibility:** Tokens saved via Anthropic and Gemini prefix caching, as well as OpenAI's cached tokens, are accurately reflected in the `Usage.cache_read_tokens` object for precise chargeback and analytics.
4. **Supervisor Orchestration:** A `house` shape (manager loop) can launch a child DOT pipeline (e.g., a focused codebase refactoring loop), monitor its progress, evaluate a conditional stop condition, and steer its execution via telemetry ingestion, fulfilling the supervisor-worker pattern.
5. **OpenAI-Compatible Providers:** Users can point the UnifiedClient at vLLM, Ollama, Together AI, or Groq endpoints using the new `OpenAICompatibleAdapter`, breaking vendor lock-in.

---

## Architecture

### LLM Client Additions
- **Middleware:** Implement a chain-of-responsibility pattern in `src/llm/client.ts`. Add a `Middleware` interface defined as `(request, next) => Promise<Response>` (along with its streaming equivalent).
- **Model Catalog:** Add `src/llm/catalog.ts` containing `ModelInfo` records (context window, capabilities, costs). Implement lookups (`get_model_info`, `list_models`, `get_latest_model`).
- **Adapter Enhancements:**
  - `src/llm/adapters/openai.ts`: Extract `usage.input_tokens_details.cached_tokens`.
  - `src/llm/adapters/gemini.ts`: Extract `usageMetadata.cachedContentTokenCount`.
  - Parse `x-ratelimit-*` headers into a `RateLimitInfo` record on the standard `Response`.
- **OpenAI Compatible:** Add `src/llm/adapters/openai-compatible.ts` that correctly targets the `/v1/chat/completions` API and its SSE payload format.

### Manager Loop Additions
- **Handler:** `src/handlers/manager-loop.ts` mapping to the `house` node shape.
- **Attributes:** Parse `manager.poll_interval`, `manager.max_cycles`, `manager.stop_condition`, `manager.actions`, and `stack.child_dotfile` within `src/garden/parse.ts`.
- **Execution Engine:** The handler initializes and spawns a child `PipelineEngine` in a scoped subdirectory. It polls the child's checkpoint status, evaluates the `manager.stop_condition`, and loops until success, failure, or `max_cycles` is reached.

---

## Implementation Phases

### Phase 1: LLM Middleware & Core Types (GAP-L1, L2, L7, L8)
- **Tasks:**
  - Add `ConfigurationError` to the LLM error hierarchy (`src/llm/errors.ts`).
  - Add `RateLimitInfo` to `src/llm/types.ts` and update existing adapters to parse the corresponding headers.
  - Implement the `Middleware` interface and `applyMiddleware` chaining logic within `UnifiedClient`.
  - Implement `set_default_client()` and lazy module-level initialization in `src/llm/client.ts`.

### Phase 2: Model Catalog & Cache Tokens (GAP-L3, L4, L5)
- **Tasks:**
  - Create `src/llm/catalog.ts` populated with static `ModelInfo` definitions for current OpenAI, Anthropic, and Gemini models.
  - Expose `get_model_info(model_id)`, `list_models(provider?)`, and `get_latest_model(provider, capability?)`.
  - Update the OpenAI and Gemini adapters to correctly map cached API tokens to `Usage.cache_read_tokens`.

### Phase 3: OpenAI-Compatible Adapter (GAP-L6)
- **Tasks:**
  - Implement `src/llm/adapters/openai-compatible.ts` conforming to the standard `/v1/chat/completions` specification.
  - Handle standard streaming delta parsing (`data: [DONE]`, delta objects), which differs from the OpenAI Responses API.
  - Wire into the client factory based on provider configuration.

### Phase 4: Manager Loop Handler (GAP-A1)
- **Tasks:**
  - Update `NodeKind` union and `normalizeNodeKind` to map the `house` shape to `stack.manager_loop`.
  - Parse new manager loop attributes in `src/garden/parse.ts`.
  - Implement `ManagerLoopHandler` that:
    1. Resolves `stack.child_dotfile`.
    2. Instantiates a child `PipelineEngine` with an isolated state directory.
    3. Executes the child asynchronously, respecting `poll_interval`.
    4. Evaluates `stop_condition` using `src/engine/conditions.ts`.
    5. Returns a `NodeOutcome` reflecting the child's result or failure on `max_cycles`.
  - Register the handler in `src/handlers/registry.ts`.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/client.ts` | Modify | Add middleware chain execution, lazy default client logic. |
| `src/llm/types.ts` | Modify | Define `Middleware`, `RateLimitInfo`, `ModelInfo` types. |
| `src/llm/catalog.ts` | Create | Contains static model catalog data and lookup functions. |
| `src/llm/errors.ts` | Modify | Add `ConfigurationError`. |
| `src/llm/adapters/openai.ts` | Modify | Extract cached tokens, parse rate limits. |
| `src/llm/adapters/gemini.ts` | Modify | Extract cached tokens, parse rate limits. |
| `src/llm/adapters/openai-compatible.ts` | Create | New adapter for Chat Completions endpoints (e.g., vLLM). |
| `src/garden/types.ts` | Modify | Add `stack.manager_loop` to `NodeKind` union. |
| `src/garden/parse.ts` | Modify | Map `house` shape, parse `manager.*` and `stack.*` attributes. |
| `src/handlers/manager-loop.ts` | Create | Core orchestration logic for supervisor/child execution. |
| `src/handlers/registry.ts` | Modify | Register `stack.manager_loop` handler. |

---

## Definition of Done

- [ ] All 8 Unified LLM gaps (GAP-L1 through GAP-L8) are fully implemented and unit-tested.
- [ ] `stack.manager_loop` (GAP-A1) correctly parses from a `house` node and successfully executes a child pipeline to completion in tests.
- [ ] Test coverage exists for middleware chaining, verifying correct execution order for both standard calls and streaming endpoints.
- [ ] `Usage` objects reliably report prefix cache hits for OpenAI and Gemini adapters.
- [ ] `ConfigurationError` is properly thrown when a client is instantiated without provider credentials.
- [ ] No regressions exist in the `Coding Agent Loop` or core `PipelineEngine` specifications.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Middleware Streaming Complexity** | High | Wrapping `AsyncIterator` streams in middleware can drop events or corrupt the stream if not handled carefully. Mitigation: Implement a robust generator wrapper utility in `src/llm/streaming.ts` and write exhaustive tests asserting event preservation. |
| **Child Pipeline State Bleed** | High | The manager loop might unintentionally share or overwrite the parent pipeline's context or checkpoint file. Mitigation: Enforce strict separation by explicitly configuring the child engine's `ExecutionContext` and passing isolated cocoon/log directories. |
| **Model Catalog Stale Data** | Low | Hardcoded model contexts/costs change frequently. Mitigation: Expose a way to inject or override catalog definitions via configuration files in the future; keep definitions generalized where possible. |

---

## Dependencies

- No new external package dependencies are required for this sprint. All HTTP fetching, header parsing, and AST validation rely on existing abstractions (`@ts-graphviz/parser` and native fetch).