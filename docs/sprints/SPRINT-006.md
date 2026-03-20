# Sprint 006: Unified LLM Client — Multi-Provider Foundation

## Overview

**Goal:** Replace the Anthropic-only stub in `src/llm/` with a production-grade, multi-provider LLM client supporting Anthropic and OpenAI — with streaming, tool calling, a proper content model, and composable retry. This is explicitly a **GAP-50 foundation sprint**, not a complete unified LLM spec implementation. After this sprint, codergen nodes can target Anthropic or OpenAI, stream responses in real-time, and recover from transient failures — transforming Nectar from a shell-command orchestrator into a genuine AI pipeline engine.

**Why this sprint, why now:**

The Unified LLM Client sits at ~5% completion — the largest single gap and the critical-path blocker for everything downstream:

| Blocked capability | Why it needs this sprint |
|---|---|
| Coding Agent Loop (GAP-40, 0%) | Tool calling, streaming, multi-turn conversation, provider profiles |
| Model Stylesheet utility (GAP-06) | `llm_provider`/`llm_model` per node requires provider routing |
| Context Fidelity summary modes (GAP-07) | `summary:*` fidelity requires real LLM calls |
| Swarm Intelligence (INTENT 2C-iii) | Same prompt → Claude + Codex + Gemini independently |
| Manager Loop (GAP-04) | Observation/steering loop requires LLM |

Sprints 001–005 delivered a solid attractor engine at ~75% — functional parsing, validation, execution with retry/goal-gates/conditions/human-gates/parallel-fan-out. But codergen nodes still hit a glorified echo stub. This sprint makes the AI part of the AI pipeline engine actually work.

**Scope (GAP-50 partial):**
- Core types — tagged-union `ContentPart`, 4 roles, `GenerateRequest`/`GenerateResponse`, `Usage` with reasoning + cache tokens
- Provider adapter interface — the contract every adapter implements
- Anthropic adapter — Messages API with streaming, tool calling, thinking blocks
- OpenAI adapter — Responses API with streaming, tool calling, reasoning tokens
- `UnifiedClient` — `from_env()` discovery, provider routing, `generate()` + `stream()`, fallback
- Tool calling types — `ToolDefinition`, `ToolChoice` modes, cross-provider normalization
- Error taxonomy — 8 error types with retryability flags, `Retry-After` parsing
- Retry middleware — composable adapter wrapper with backoff + jitter, request timeout
- `reasoning_effort` pass-through to both providers
- Codergen handler upgrade — streaming output, provider routing from node attributes
- Fidelity validation fix — correct string enum validation from the Attractor spec (GAP-07 partial)

**Out of scope:**
- Coding Agent Loop (GAP-40) — separate sprint; this provides its foundation
- Single-turn tool execution in codergen — deferred to the Coding Agent Loop sprint to avoid absorbing agent concerns prematurely
- Model Stylesheet parsing/transform (GAP-06/GAP-24) — attractor-layer concern
- Context Fidelity transforms (GAP-07/GAP-25) — downstream consumer of this client
- Subgraph scoping / default blocks (GAP-13/GAP-14) — parser work, no LLM dependency
- Gemini adapter — Tier 2; deferred to Sprint 007 if not completed here
- `generate_object()` / structured output — not blocking any current feature
- Model catalog / `get_model_info()` — metadata, not functional
- Middleware/interceptor pattern — retry is the only middleware needed now
- `image` ContentPart adapter translation — type defined but no adapter implementation this sprint
- `DEVELOPER` role, `provider_options` pass-through — noted as future spec alignment items
- Manager Loop handler, HTTP server, Web UI, Seedbed

---

## Use Cases

1. **Codergen node calls Anthropic (default):** A `box` node with `prompt="Analyze this module for bugs"` and no `llm_provider`. `ANTHROPIC_API_KEY` is set. The unified client routes to Anthropic, streams the response token-by-token into `response.md`, and the CLI renderer shows streaming output in real-time.

2. **Multi-provider pipeline:** Two codergen nodes set `llm_provider="anthropic"` and `llm_provider="openai"`. The unified client routes each request to the correct adapter using provider-specific APIs.

3. **Transient failure recovery:** API call returns 429. The retry middleware reads the `Retry-After` header, backs off, retries. A 503 gets exponential backoff. A 401 fails immediately as `AuthenticationError` — no retry. This is request-level retry, orthogonal to engine-level node retry.

4. **Request timeout:** A request hangs with no response. After `timeout_ms` (default 120s for `generate()`, 300s for `stream()`), the client aborts the request and raises `TimeoutError`, which is retryable.

5. **Cancellation mid-stream:** User hits Ctrl+C during a long streaming response. The AbortSignal propagates to the HTTP request, the stream closes, partial content is preserved in the stage directory, and the cocoon checkpoints.

6. **No API keys configured:** `Client.from_env()` finds no keys, returns a client with `SimulationProvider` only. Codergen nodes produce simulated responses. Pipelines run end-to-end without real API calls — essential for CI and development.

7. **Explicit provider not configured:** A node requests `llm_provider="openai"` but no `OPENAI_API_KEY` is set. The client raises an `InvalidRequestError` immediately with a clear message — no silent fallback to a different provider.

---

## Architecture

### Provider Adapter Pattern

```
              UnifiedClient.from_env()
    ┌──── discovers keys from env ────┐
    │                                 │
    ▼                                 ▼
 Anthropic                         OpenAI
 Adapter                           Adapter
    │                                 │
    ├──── withRetry() ────────────────┤
    ▼                                 ▼
 Messages API                   Responses API
 /v1/messages                   /v1/responses
```

Each adapter translates bidirectionally between the unified content model and provider-native wire format. Retry wraps each adapter as composable middleware — not baked into adapter internals.

### Content Model

The current `{ role: 'user' | 'assistant', content: string }` is replaced with a tagged union supporting tool calls, thinking blocks, and multimodal content:

```typescript
type Role = 'system' | 'user' | 'assistant' | 'tool';

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; tool_call_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking' };

interface Message {
  role: Role;
  content: string | ContentPart[];  // string is shorthand for [{ type: 'text', text }]
}
```

### Module Layout

```
src/llm/
├── types.ts              # Message, ContentPart, GenerateRequest/Response, Usage, StreamEvent
├── errors.ts             # LLMError hierarchy: 8 error types with retryability
├── retry.ts              # withRetry(adapter, config) → ProviderAdapter
├── tools.ts              # ToolDefinition, ToolChoice types
├── streaming.ts          # StreamEvent union type, SSE line parser, chunk accumulator
├── client.ts             # UnifiedClient: from_env(), generate(), stream(), provider routing
├── simulation.ts         # SimulationProvider (updated to ProviderAdapter interface)
└── adapters/
    ├── types.ts          # ProviderAdapter interface: generate(), stream(), provider_name
    ├── anthropic.ts      # Anthropic Messages API adapter
    └── openai.ts         # OpenAI Responses API adapter
```

### Key Design Decisions

**No external HTTP libraries.** All adapters use Node.js 22 built-in `fetch`. Zero new runtime dependencies for the entire LLM module.

**OpenAI Responses API, not Chat Completions.** The Responses API is the current-generation API with native reasoning token support. Chat Completions drops reasoning features. If the Responses API has blocking issues during implementation, OpenAI can be demoted to Tier 2 and the sprint ships Anthropic-only.

**Retry as middleware, not inheritance.** `withRetry(adapter, config)` returns a wrapped `ProviderAdapter`. No retry logic inside adapters. Testable, composable, independently configurable per provider.

**Streaming as async iterables.** `stream()` returns `AsyncIterable<StreamEvent>`. Composable with `for await`, cancellable via AbortSignal, lazy by nature.

**String shorthand on Message.content.** `content: "hello"` is sugar for `content: [{ type: 'text', text: 'hello' }]`. Adapters normalize on entry.

**Request timeout built in.** `timeout_ms` on `GenerateRequest` with sensible defaults. The retry middleware treats timeouts as `TimeoutError` (retryable). Prevents hanging requests during provider outages.

**Explicit provider errors, not silent fallback.** If a node explicitly requests a provider that isn't configured, the client raises `InvalidRequestError` immediately. Silent fallback only applies when no provider is specified.

---

## Implementation

### Phase 1: Core Types & Error Taxonomy (~15%)

**Files:** `src/llm/types.ts` (rewrite), `src/llm/errors.ts` (new), `src/llm/adapters/types.ts` (new), `src/llm/tools.ts` (new), `src/llm/streaming.ts` (new)

**Tasks:**
- [ ] Define `Role`, `ContentPart` (6-variant tagged union), `Message` (with string shorthand), `ImageSource`
- [ ] Define `GenerateRequest`: messages, model, provider, tools, tool_choice, max_tokens, temperature, stop_sequences, reasoning_effort, system, abort_signal, timeout_ms
- [ ] Define `GenerateResponse`: message (assistant Message), usage, stop_reason, model, provider
- [ ] Define `StopReason`: `'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'` — normalized across providers
- [ ] Define `Usage`: input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens (all optional except input/output)
- [ ] Define `StreamEvent` discriminated union: `stream_start` (model), `content_delta` (text), `tool_call_delta` (id, name?, arguments_delta), `thinking_delta` (text), `usage` (Usage), `stream_end` (stop_reason, message), `error` (LLMError)
- [ ] Define `ToolDefinition`: name, description, input_schema (JSON Schema object)
- [ ] Define `ToolChoice`: `{ type: 'auto' | 'none' | 'required' | 'named'; name?: string }`
- [ ] Define `LLMError` base class extending `Error` with `provider`, `retryable`, `status_code` fields
- [ ] Define 8 error subclasses: `AuthenticationError` (not retryable), `RateLimitError` (retryable, `retry_after_ms`), `OverloadedError` (retryable), `InvalidRequestError` (not retryable), `ContextWindowError` (not retryable), `ContentFilterError` (not retryable), `NetworkError` (retryable), `TimeoutError` (retryable)
- [ ] Define `ProviderAdapter` interface: `generate(request): Promise<GenerateResponse>`, `stream(request): AsyncIterable<StreamEvent>`, `readonly provider_name: string`
- [ ] Helper: `normalizeContent(content: string | ContentPart[]): ContentPart[]`
- [ ] Tests: type construction, ContentPart narrowing, error retryability classification, normalizeContent

### Phase 2: Retry Middleware & SSE Parser (~10%)

**Files:** `src/llm/retry.ts` (new), `src/llm/streaming.ts` (additions), `test/llm/retry.test.ts` (new)

**Tasks:**
- [ ] Implement `RetryConfig`: max_retries (default 3), base_delay_ms (200), max_delay_ms (60_000), jitter (true)
- [ ] Implement `withRetry(adapter: ProviderAdapter, config?: Partial<RetryConfig>): ProviderAdapter`
  - Wraps both `generate()` and `stream()` with retry logic
  - Returns a new object conforming to `ProviderAdapter` — no subclassing
- [ ] Backoff formula: `min(base_delay_ms * 2^(attempt-1), max_delay_ms)` with jitter factor `0.5 + Math.random()`
- [ ] If `RateLimitError` has `retry_after_ms`, use `max(retry_after_ms, computed_delay)` as the wait
- [ ] Only retry when `error.retryable === true` — all others propagate immediately
- [ ] AbortSignal: check between retries; if aborted, throw `AbortError` immediately
- [ ] Request timeout: wrap `fetch` calls with `AbortSignal.timeout(timeout_ms)` merged with caller's signal
- [ ] Stream retry policy: retry the whole stream call if error occurs before any `content_delta` is yielded; once content has been yielded, propagate the error (partial streams cannot be replayed)
- [ ] Implement `parseSSEStream(response: Response, signal?: AbortSignal): AsyncIterable<{event?: string, data: string}>` — shared by Anthropic and OpenAI adapters
- [ ] Tests: retry on 429 with Retry-After, retry on 503, no retry on 401, abort cancels retry loop, max retries exhausted throws last error, stream retry before first delta, stream no-retry after delta, timeout triggers TimeoutError

### Phase 3: Anthropic Adapter (~20%)

**Files:** `src/llm/adapters/anthropic.ts` (new — replaces old `client.ts` AnthropicProvider), `test/llm/adapters/anthropic.test.ts` (new)

**Tasks:**
- [ ] Request translation: extract system messages to top-level `system` param; convert `ContentPart[]` → Anthropic content blocks (`text`→`text`, `tool_call`→`tool_use` with parsed JSON arguments, `tool_result`→`tool_result`)
- [ ] Tool definitions: `ToolDefinition` → `{ name, description, input_schema }` in Anthropic `tools` array
- [ ] Tool choice: `auto`→`{ type: 'auto' }`, `none`→omit tools, `required`→`{ type: 'any' }`, `named`→`{ type: 'tool', name }`
- [ ] `reasoning_effort`: map to `thinking: { type: 'enabled', budget_tokens }` for extended-thinking-capable models
- [ ] API version header: `anthropic-version: 2023-06-01`; beta headers as needed
- [ ] Response translation: Anthropic content blocks → unified `ContentPart` (`text`→`text`, `tool_use`→`tool_call` with stringified arguments, `thinking`→`thinking`, `redacted_thinking`→`redacted_thinking`)
- [ ] `stop_reason` normalization: `end_turn`→`end_turn`, `max_tokens`→`max_tokens`, `stop_sequence`→`stop_sequence`, `tool_use`→`tool_use`
- [ ] Usage mapping: `cache_creation_input_tokens`→`cache_write_tokens`, `cache_read_input_tokens`→`cache_read_tokens`
- [ ] Streaming: POST with `stream: true`, parse SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) → unified `StreamEvent` async iterable
- [ ] Error mapping: 401→`AuthenticationError`, 429→`RateLimitError` (parse `retry-after` header), 529→`OverloadedError`, 400 with `invalid_request_error`→`InvalidRequestError`, 400 with context-length message→`ContextWindowError`
- [ ] Handle malformed SSE chunks gracefully — log warning and skip rather than crash the stream
- [ ] Base URL override via `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`)
- [ ] Tests: request translation (system extraction, content parts, tools), response translation (all block types), SSE stream parsing, error classification — all with mocked `fetch`

### Phase 4: OpenAI Adapter (~20%)

**Files:** `src/llm/adapters/openai.ts` (new), `test/llm/adapters/openai.test.ts` (new)

**Tasks:**
- [ ] POST to `{base_url}/v1/responses` (Responses API, not Chat Completions)
- [ ] Request translation: unified `Message[]` → Responses API `input` (items with roles); system → `instructions` field; `ContentPart[]` → OpenAI content parts
- [ ] Tool definitions → `tools: [{ type: 'function', name, description, parameters }]`
- [ ] Tool choice: `auto`/`none`/`required` → `tool_choice` string; `named` → `{ type: 'function', name }`
- [ ] `reasoning_effort` → `reasoning: { effort: 'low'|'medium'|'high' }` for o-series models
- [ ] Response translation: Responses API `output` items → unified `ContentPart`
- [ ] `stop_reason` normalization: map provider-specific stop reasons to unified `StopReason`
- [ ] Reasoning token tracking: `usage.output_tokens_details.reasoning_tokens` → `usage.reasoning_tokens`
- [ ] Streaming: POST with `stream: true`, parse SSE events → unified `StreamEvent`
- [ ] Error mapping: 401→`AuthenticationError`, 429→`RateLimitError`, 503→`OverloadedError`, 400→`InvalidRequestError`
- [ ] Handle malformed SSE chunks gracefully
- [ ] Auth header: `Authorization: Bearer {OPENAI_API_KEY}`
- [ ] Base URL via `OPENAI_BASE_URL` (default `https://api.openai.com`)
- [ ] Tests: request/response translation, streaming, error mapping, reasoning tokens — all with mocked `fetch`

**Contingency:** If the Responses API has blocking issues during implementation, defer OpenAI to Tier 2 and ship Anthropic-only as Tier 1. A Chat Completions fallback is NOT in scope — it would be a second adapter.

### Phase 5: Unified Client & Codergen Upgrade (~20%)

**Files:** `src/llm/client.ts` (rewrite), `src/llm/simulation.ts` (update), `src/handlers/codergen.ts` (modify), `src/handlers/registry.ts` (modify), `src/engine/engine.ts` (modify), `src/cli/commands/run.ts` (modify), `src/cli/commands/resume.ts` (modify), `test/llm/client.test.ts` (new), `test/handlers/codergen.test.ts` (update)

**Tasks:**
- [ ] Implement `UnifiedClient`:
  - `static from_env(): UnifiedClient` — checks `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`; creates and wraps each discovered adapter with `withRetry()`; always includes `SimulationProvider` as final fallback
  - `generate(request: GenerateRequest): Promise<GenerateResponse>` — routes by `request.provider`; if no provider specified, uses first available real adapter (Anthropic > OpenAI > Simulation); if explicit provider requested but not configured, raise `InvalidRequestError`
  - `stream(request: GenerateRequest): AsyncIterable<StreamEvent>` — streaming variant with same routing
  - `available_providers(): string[]` — returns names of configured providers
  - Constructor accepts explicit `Map<string, ProviderAdapter>` for DI/testing
- [ ] Update `SimulationProvider` to implement `ProviderAdapter` interface:
  - `stream()`: yields `stream_start`, text content in character chunks as `content_delta`, `usage`, `stream_end`
  - Keeps existing fake response generation logic
  - Produces deterministic output for test reproducibility
- [ ] Update codergen handler:
  - Accept `UnifiedClient` instead of old `LLMClient`
  - Read `llm_provider` and `llm_model` from node attributes; set on `GenerateRequest`
  - Read `reasoning_effort` from node attributes; set on `GenerateRequest`
  - Use `stream()` for real-time writing to `response.md` — append each `content_delta` as it arrives
  - Capture full `Usage` in `status.json`
  - On provider error after all retries, produce a clear error message in node output (not a stack trace)
- [ ] Update `HandlerRegistry` to accept `UnifiedClient` and pass to codergen handler
- [ ] Update engine constructor to accept and propagate `UnifiedClient`
- [ ] Update `run.ts` and `resume.ts` CLI commands to create `UnifiedClient.from_env()` and pass to engine
- [ ] Tests: client routing by provider, default provider selection, explicit unknown provider error, explicit unconfigured provider error, simulation streaming determinism, codergen with mocked client

### Phase 6: Fidelity Validation Fix & Smoke Tests (~5%)

**Files:** `src/garden/validate.ts` (modify), `test/garden/validate.test.ts` (modify)

**Tasks:**
- [ ] Fix `fidelity_valid` validation rule to check for spec-defined string enums (`full`, `truncate`, `compact`, `summary:low`, `summary:medium`, `summary:high`) instead of numeric range
- [ ] Add `test:smoke:llm` script to `package.json` — runs one real request per configured provider (manual, not CI)
- [ ] Tests: fidelity validation accepts valid enums, rejects invalid values

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/types.ts` | **Rewrite** | Message, ContentPart (6 variants), GenerateRequest/Response, Usage, StopReason |
| `src/llm/errors.ts` | **Create** | LLMError base + 8 error subclasses with retryability |
| `src/llm/retry.ts` | **Create** | `withRetry()` composable middleware with timeout |
| `src/llm/tools.ts` | **Create** | ToolDefinition, ToolChoice types |
| `src/llm/streaming.ts` | **Create** | StreamEvent union, SSE line parser |
| `src/llm/client.ts` | **Rewrite** | UnifiedClient: from_env(), generate(), stream(), routing |
| `src/llm/simulation.ts` | **Modify** | Conform to ProviderAdapter, add stream(), deterministic output |
| `src/llm/adapters/types.ts` | **Create** | ProviderAdapter interface contract |
| `src/llm/adapters/anthropic.ts` | **Create** | Anthropic Messages API (streaming, tools, thinking) |
| `src/llm/adapters/openai.ts` | **Create** | OpenAI Responses API (streaming, tools, reasoning) |
| `src/handlers/codergen.ts` | **Modify** | Wire to UnifiedClient, streaming output, provider routing |
| `src/handlers/registry.ts` | **Modify** | Pass UnifiedClient through |
| `src/engine/engine.ts` | **Modify** | Accept and propagate UnifiedClient |
| `src/cli/commands/run.ts` | **Modify** | Create UnifiedClient.from_env(), pass to engine |
| `src/cli/commands/resume.ts` | **Modify** | Create UnifiedClient.from_env(), pass to engine |
| `src/garden/validate.ts` | **Modify** | Fix fidelity enum validation |
| `test/llm/retry.test.ts` | **Create** | Retry middleware: backoff, Retry-After, abort, timeout, stream retry |
| `test/llm/client.test.ts` | **Create** | UnifiedClient routing, default selection, fallback, error cases |
| `test/llm/adapters/anthropic.test.ts` | **Create** | Anthropic: translation, streaming, errors |
| `test/llm/adapters/openai.test.ts` | **Create** | OpenAI: translation, streaming, errors, reasoning |
| `test/handlers/codergen.test.ts` | **Modify** | Update for UnifiedClient interface |
| `test/garden/validate.test.ts` | **Modify** | Fidelity enum validation tests |

---

## Definition of Done

### Build & Tests
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests (no regressions) plus all new LLM client tests
- [ ] All adapter tests use mocked `fetch` — zero real API calls in `npm test`
- [ ] Manual `npm run test:smoke:llm` executes successfully against at least one real provider

### UnifiedClient
- [ ] `UnifiedClient.from_env()` discovers providers from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- [ ] `client.generate(request)` routes to correct provider based on `request.provider`
- [ ] `client.stream(request)` returns `AsyncIterable<StreamEvent>` yielding content deltas
- [ ] When no provider specified, routes to first available (Anthropic > OpenAI > Simulation)
- [ ] When explicit provider requested but not configured, raises `InvalidRequestError` with clear message
- [ ] `client.available_providers()` returns list of configured provider names
- [ ] When no API keys configured, falls back to `SimulationProvider`

### Content Model
- [ ] `ContentPart` supports all 6 variants: text, image, tool_call, tool_result, thinking, redacted_thinking
- [ ] `Message.content` accepts both `string` and `ContentPart[]`
- [ ] `Usage` tracks: input_tokens, output_tokens, and optionally reasoning_tokens, cache_read_tokens, cache_write_tokens
- [ ] `StopReason` is normalized across providers: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`

### Provider Adapters
- [ ] Anthropic adapter: Messages API (`/v1/messages`), streaming SSE, tool calling, thinking blocks
- [ ] OpenAI adapter: Responses API (`/v1/responses`), streaming SSE, tool calling, reasoning tokens
- [ ] `ToolDefinition` translates correctly to each provider's native format
- [ ] `ToolChoice` modes (auto, none, required, named) translate for each provider
- [ ] `reasoning_effort` passes through to each provider's native parameter
- [ ] Base URL override via `*_BASE_URL` env vars for each provider
- [ ] Malformed SSE chunks are handled gracefully (log + skip, not crash)

### Error Handling, Retry & Timeout
- [ ] Error taxonomy classifies HTTP responses into correct `LLMError` subclass with `retryable` flag
- [ ] `RateLimitError` parses `Retry-After` header when present
- [ ] `withRetry()` retries transient errors (429, 503, network, timeout) with exponential backoff + jitter
- [ ] `withRetry()` does NOT retry non-transient errors (401, 400)
- [ ] `timeout_ms` on requests aborts hanging connections after the configured duration
- [ ] AbortSignal cancels in-flight HTTP requests and pending retries

### Codergen Integration
- [ ] Codergen handler uses `UnifiedClient`, reads `llm_provider`/`llm_model`/`reasoning_effort` from node attributes
- [ ] Codergen handler streams response to `response.md` incrementally via `stream()`
- [ ] Provider errors after retry exhaustion produce a clear node-level error message
- [ ] `SimulationProvider` conforms to `ProviderAdapter` with `stream()` support and deterministic output

### Backward Compatibility
- [ ] Existing pipelines that don't set `llm_provider` work identically (Anthropic-first fallback)
- [ ] Pipelines using simulation (no API keys) produce equivalent output before and after this sprint
- [ ] Fidelity validation accepts spec-defined string enums and rejects invalid values

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| OpenAI Responses API has underdocumented edge cases | Medium | High | Build against recorded response fixtures. If Responses API has blocking issues, demote OpenAI to Tier 2 and ship Anthropic-only. Do NOT build a Chat Completions fallback — that's a separate adapter. |
| Two full adapters is ambitious for one sprint | Medium | Medium | Priority tiers create real cut lines. Tier 1 must-ship is scoped to one production adapter + client + codergen. |
| Mocked tests miss real API incompatibilities | High | Medium | Record real API responses as fixtures during development. `test:smoke:llm` script runs one real request per provider (manual, not CI). Document quirks as discovered. |
| Provider APIs change during sprint | Low | Medium | Pin API versions: Anthropic `2023-06-01`, OpenAI responses `v1`. Adapter isolation contains blast radius. |
| Streaming cancellation is flaky across providers | Medium | Medium | `AbortController` is native to `fetch`. Test cancellation per adapter. Set reasonable timeout on abort. |
| Migration churn from string to structured content | Medium | Medium | The codergen handler is the only consumer today. Keep the `string` shorthand on `Message.content` so existing simple cases remain readable. |
| Malformed JSON in streaming chunks | Medium | Low | SSE parser skips malformed chunks with a warning log rather than crashing the stream. |
| Partial stream written before cancellation/error | Medium | Medium | Preserve partial `response.md` content. Cocoon checkpoint captures partial state. Document that partial output is expected on cancellation. |
| `reasoning_effort` semantic divergence across providers | Medium | Low | Accept a string union (`'low' | 'medium' | 'high'`) as the unified interface. Each adapter maps to its native format (Anthropic: budget_tokens, OpenAI: effort enum). |
| Sprint ships partial GAP-50 | Certain | Low | This is intentional and documented. The Overview and DoD explicitly state this is a foundation sprint. Remaining spec items are tracked for future sprints. |

---

## Dependencies

**Runtime (new):** None. All HTTP via Node.js 22 built-in `fetch`.

**External services (optional, for development/smoke testing):**

| Service | Env Var | Fallback | API Endpoint |
|---------|---------|----------|--------------|
| Anthropic | `ANTHROPIC_API_KEY` | SimulationProvider | Messages API `/v1/messages` |
| OpenAI | `OPENAI_API_KEY` | SimulationProvider | Responses API `/v1/responses` |

All providers are optional. No API key = simulation fallback. Pipelines always run.

---

## Priority Tiers

Cut from the bottom if behind schedule:

| Tier | Scope | GAP-50 progress |
|------|-------|-----------------|
| **Tier 1 — must ship** | Core types + error taxonomy + retry middleware (with timeout) + Anthropic adapter (streaming + tools) + UnifiedClient routing + codergen handler upgrade + SimulationProvider update + CLI wiring + fidelity validation fix | ~45% |
| **Tier 2 — should ship** | OpenAI adapter (streaming + tools) + `reasoning_effort` for both providers + reasoning token tracking + `stop_reason` normalization | ~65% |
| **Tier 3 — stretch** | Thinking block support (both providers) + `cache_read`/`cache_write` token tracking + `test:smoke:llm` script + SimulationProvider deterministic streaming | ~75% |

**Minimum viable sprint is Tier 1.** One production adapter with streaming, wired into codergen nodes with proper error handling and timeout. This alone transforms Nectar from a shell orchestrator into a real AI pipeline engine and unblocks the Coding Agent Loop sprint.
