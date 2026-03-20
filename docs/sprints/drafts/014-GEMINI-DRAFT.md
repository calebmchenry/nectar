# Sprint Draft: LLM SDK High-Level APIs & Structured Output

## Overview

**Goal:** Elevate the Unified LLM Client from a low-level API wrapper to a full-featured developer SDK. This sprint closes the highest-impact gaps in the LLM SDK layer by implementing Structured Output (L4), the High-Level `generate()` Tool Loop (L9), Middleware support (L7), and the Provider Options escape hatch (L20).

**Scope:**
- **ResponseFormat (L4):** `json_schema`, `json_object`, and `text` output modes for all providers.
- **High-Level `generate()` (L9):** Automatic tool execution loop with `max_tool_rounds`.
- **Middleware (L7):** Request/response interceptor chain for caching, logging, and metrics.
- **Provider Options (L20):** Escape hatch for native beta headers and advanced settings.
- **Anthropic Beta Headers (L11) & Prompt Caching (L10):** Integrated via the new options and middleware to reduce token costs.

**Out of scope:**
- Attractor orchestration engine gaps (Manager loop, fidelity, threads).
- Audio and Document content kinds (L1).
- Model catalog (L8 - deferred to a future data-focused sprint).
- Web UI and idea backlog CLI commands.

## Use Cases

1. **Structured Swarm Analysis:** The multi-AI Swarm Intelligence feature requests a strict JSON format via `response_format: { type: 'json_schema', schema: AnalysisSchema }`. The SDK guarantees extraction of feasibility, complexity, and priority fields without brittle regex parsing.
2. **Autonomous Tool Loops:** Developers call a single `client.generate(req)` method that automatically executes tools and feeds results back to the LLM until completion, instead of manually orchestrating the loop in the agent layer.
3. **Observability & Caching:** Using the new Middleware chain, a logging interceptor is injected to record all requests/responses to a local database for the artifact store, without modifying core client logic.
4. **Bleeding-Edge Provider Features:** A developer passes `anthropic-beta: ["interleaved-thinking-2025-05-14"]` via `provider_options` to experiment with new Claude features before unified types are updated.

## Architecture

### Language: TypeScript on Node.js 22+

- Expands the existing `src/llm/` module.
- Middleware pattern similar to standard Fetch interceptors.

### Key Abstractions

**`ResponseFormat`** — Added to `GenerateRequest`. Configures the adapter to use native JSON mode (OpenAI `response_format`, Gemini `responseSchema`) or emulated JSON mode (Anthropic tool-choice hack if native JSON schema enforcement is insufficient).

**`Middleware` Chain** — `type Middleware = (req: GenerateRequest, next: () => Promise<GenerateResponse>) => Promise<GenerateResponse>`. The `UnifiedClient` maintains a stack of these, applied in order.

**`client.generate()`** — A new high-level method wrapping the existing `generateUnified()`. It inspects `StopReason`; if `tool_use`, it executes tools using the existing `executeToolsBatch()`, appends results to the message list, and loops up to `max_tool_rounds`.

**`ProviderOptions`** — A generic `Record<string, unknown>` attached to `GenerateRequest`. Adapters explicitly map known keys (e.g., Anthropic beta headers, cache breakpoints) to their native payloads.

## Implementation phases

### Phase 1: Middleware & Provider Options (~20%)

**Files:** `src/llm/client.ts`, `src/llm/types.ts`, `src/llm/adapters/*.ts`

**Tasks:**
- Define `Middleware` type and add `use(middleware)` to `UnifiedClient`.
- Refactor `generateUnified()` and `stream()` to execute through the middleware chain.
- Add `provider_options` to `GenerateRequest`.
- Update Anthropic adapter to parse `provider_options.anthropic_beta` and apply headers.

### Phase 2: ResponseFormat & Structured Output (~30%)

**Files:** `src/llm/types.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`

**Tasks:**
- Define `ResponseFormat` type (`text`, `json_object`, `json_schema`).
- **OpenAI:** Map to `response_format: { type: "json_schema", json_schema: ... }`.
- **Gemini:** Map to `responseMimeType: "application/json"` and `responseSchema`.
- **Anthropic:** Implement the standard tool-choice hack (force use of a specific JSON-emitting tool) or use native JSON output if available in the targeted API version.

### Phase 3: High-Level `generate()` Tool Loop (~30%)

**Files:** `src/llm/client.ts`, `src/llm/tools.ts`, `test/llm/generate.test.ts`

**Tasks:**
- Create `generate(request: GenerateRequest, options?: { max_tool_rounds?: number }): Promise<GenerateResult>`.
- Implement the loop: Call LLM -> check finish reason -> if `tool_use`, execute tools via `executeToolsBatch()` -> append `TOOL_RESULT` -> repeat.
- Enforce `max_tool_rounds` (default 5). If exceeded, return early with a specific stop reason.
- Accumulate usage metrics across all loop iterations.

### Phase 4: Anthropic Prompt Caching (~20%)

**Files:** `src/llm/adapters/anthropic.ts`, `src/llm/middleware/caching.ts` (optional)

**Tasks:**
- Add logic in the Anthropic adapter to inject `cache_control: { type: "ephemeral" }` breakpoints.
- Auto-inject breakpoints on the system prompt, tool definitions, and the oldest large conversation block to optimize token costs per the spec.

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/types.ts` | Modify | Add `ResponseFormat`, `Middleware`, `GenerateResult`, `provider_options` |
| `src/llm/client.ts` | Modify | Implement middleware chain, add high-level `generate()` loop |
| `src/llm/adapters/openai.ts` | Modify | Support structured output, pass through provider options |
| `src/llm/adapters/anthropic.ts` | Modify | Support structured output, beta headers, prompt caching |
| `src/llm/adapters/gemini.ts` | Modify | Support structured output, provider options |
| `test/llm/middleware.test.ts` | Create | Verify middleware execution order and mutation |
| `test/llm/generate.test.ts` | Create | Verify tool loop exhaustion and aggregation |
| `test/llm/structured.test.ts` | Create | Verify JSON schema extraction across all 3 providers |

## Definition of Done

- [ ] `UnifiedClient` supports adding middleware via `use()`.
- [ ] Middleware chain executes in order and can modify both requests and responses.
- [ ] `GenerateRequest` accepts `response_format` for strict JSON schemas.
- [ ] OpenAI, Anthropic, and Gemini adapters successfully return valid JSON matching the schema when `response_format` is provided.
- [ ] `client.generate()` correctly loops through tool executions without developer intervention, respecting `max_tool_rounds`.
- [ ] Usage metrics from `client.generate()` correctly aggregate all iterations of the tool loop.
- [ ] Anthropic adapter correctly injects `cache_control` breakpoints to reduce costs.
- [ ] All unit tests pass, including new tests for middleware, tool loops, and structured output.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Anthropic native structured output limitations | Medium | High | Use the officially recommended tool-choice hack if native JSON schema enforcement is insufficient. |
| Middleware error swallowing | Low | Medium | Ensure middleware typings and execution chain enforce proper error bubbling. |
| Infinite tool loops | Low | High | Strict enforcement of `max_tool_rounds` (default 5) in `generate()`. |

## Dependencies

- Existing `@types/node` and JSON Schema definitions setup in the project.