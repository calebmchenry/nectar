# Sprint 005: Unified LLM Client — Multi-Provider SDK

## Overview

**Goal:** Replace the 80-line Anthropic-only stub with a production-grade, multi-provider LLM client supporting Anthropic, OpenAI, and Gemini — with streaming, tool calling, a proper content model, and composable retry. After this sprint, codergen nodes can target any of the three major providers, stream responses in real-time, invoke tools, and recover from transient failures — transforming Nectar from a shell-command orchestrator into a genuine AI pipeline engine.

**Why this sprint, why now:**

The Unified LLM Client sits at **5% completion** — the largest single gap across all three specs and the critical-path blocker for everything downstream:

| Blocked capability | Why it needs this sprint |
|---|---|
| Coding Agent Loop (GAP-40, 0%) | Tool calling, streaming, multi-turn conversation, provider profiles |
| Model Stylesheet utility (GAP-06) | `llm_provider`/`llm_model` per node requires provider routing |
| Context Fidelity summary modes (GAP-07) | `summary:*` fidelity requires real LLM calls |
| Swarm Intelligence (INTENT 2C-iii) | Same prompt → Claude + Codex + Gemini independently |
| Manager Loop (GAP-04) | Observation/steering loop requires LLM |

Sprints 001–004 delivered a solid attractor engine at ~75% — functional parsing, validation, execution with retry/goal-gates/conditions/human-gates/parallel-fan-out. But codergen nodes still hit a glorified echo stub. This sprint makes the AI part of the AI pipeline engine actually work.

**Scope (GAP-50 decomposition):**
- Core types — tagged-union `ContentPart`, 4 roles, `GenerateRequest`/`GenerateResponse`, `Usage` with reasoning + cache tokens (DoD 8.3)
- Provider adapter interface — the contract every adapter implements (DoD 8.2)
- Anthropic adapter — Messages API with streaming, tool calling, `cache_control`, thinking blocks (DoD 8.2)
- OpenAI adapter — **Responses API** with streaming, tool calling, reasoning tokens (DoD 8.2)
- Gemini adapter — native `generateContent` API with streaming, tool calling, thinking tokens (DoD 8.2)
- `UnifiedClient` — `from_env()` discovery, provider routing, `generate()` + `stream()`, fallback (DoD 8.1, 8.4)
- Tool calling types — `ToolDefinition`, `ToolChoice` modes, cross-provider normalization (DoD 8.7)
- Error taxonomy — 8 error types with retryability flags, `Retry-After` parsing (DoD 8.8)
- Retry middleware — composable adapter wrapper with backoff + jitter (DoD 8.8)
- `reasoning_effort` pass-through to all three providers (DoD 8.5)
- Codergen handler upgrade — streaming output, provider routing from node attributes, single-turn tool loop

**Out of scope:**
- Coding Agent Loop (GAP-40) — separate sprint; this provides its foundation
- Model Stylesheet parsing/transform (GAP-06/GAP-24) — attractor-layer concern, no LLM dependency
- Context Fidelity (GAP-07/GAP-25) — downstream consumer of this client
- `generate_object()` / structured output (DoD 8.4) — not blocking any current feature
- Model catalog / `get_model_info()` (DoD 8.1) — metadata, not functional
- Middleware/interceptor pattern (DoD 8.1) — retry is the only middleware needed now; extensibility is premature
- Node/Edge default blocks (GAP-13), Subgraphs (GAP-14) — Attractor parser work
- Manager Loop handler (GAP-04), HTTP server, Web UI, Seedbed

---

## Use Cases

1. **Codergen node calls Anthropic (default):** A `box` node with `prompt="Analyze this module for bugs"` and no `llm_provider`. `ANTHROPIC_API_KEY` is set. The unified client routes to Anthropic, streams the response token-by-token into `response.md`, and the CLI renderer shows streaming output in real-time.

2. **Multi-provider pipeline:** Three codergen nodes set `llm_provider="anthropic"`, `llm_provider="openai"`, and `llm_provider="gemini"`. The unified client routes each request to the correct adapter using provider-specific APIs. This is the primitive the compliance loop's parallel fan-out was built for — same analysis, three providers, compare results.

3. **Tool-using codergen node:** A codergen node provides tool definitions (e.g., `read_file`, `shell`). The adapter sends tool definitions in provider-native format, receives tool call responses, executes tools locally, sends results back, and gets a final response. Scoped to **single-turn** — the Coding Agent Loop (GAP-40) builds multi-turn agentic sessions on top.

4. **Transient failure recovery:** API call returns 429. The retry middleware reads the `Retry-After` header, backs off, retries. A 503 gets exponential backoff. A 401 fails immediately as `AuthenticationError` — no retry. This is request-level retry, orthogonal to engine-level node retry.

5. **Cancellation mid-stream:** User hits Ctrl+C during a long streaming response. The AbortSignal propagates to the HTTP request, the stream closes, partial content is preserved in the stage directory, and the cocoon checkpoints.

6. **No API keys configured:** `Client.from_env()` finds no keys, returns a client with `SimulationProvider` only. Codergen nodes produce simulated responses. Pipelines run end-to-end without real API calls — essential for CI and development.

---

## Architecture

### Provider Adapter Pattern

```
              UnifiedClient.from_env()
    ┌──── discovers keys from env ────┐
    │                │                │
    ▼                ▼                ▼
 Anthropic       OpenAI           Gemini
 Adapter         Adapter          Adapter
    │                │                │
    ├─ withRetry() ──┼─ withRetry() ──┤
    ▼                ▼                ▼
 Messages API   Responses API   generateContent
 /v1/messages   /v1/responses   /v1beta/models/*
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
    ├── openai.ts         # OpenAI Responses API adapter
    └── gemini.ts         # Gemini native generateContent adapter
```

### Key Design Decisions

**No external HTTP libraries.** All adapters use Node.js 22 built-in `fetch`. Zero new runtime dependencies for the entire LLM module. The existing `AnthropicProvider` already proves this works.

**OpenAI Responses API, not Chat Completions.** The spec requires `/v1/responses` — it's the current-generation API with native reasoning token support. Chat Completions is the legacy path that drops reasoning features.

**Gemini native API, not OpenAI-compatible shim.** The spec requires native `generateContent` for thinking token support and native function calling. The OpenAI-compatible shim drops Gemini-specific capabilities.

**Retry as middleware, not inheritance.** `withRetry(adapter, config)` returns a wrapped `ProviderAdapter`. No retry logic inside adapters. Testable, composable, independently configurable per provider.

**Streaming as async iterables.** `stream()` returns `AsyncIterable<StreamEvent>`. Composable with `for await`, cancellable via AbortSignal, lazy by nature. No event emitter registration, no callback hell.

**String shorthand on Message.content.** `content: "hello"` is sugar for `content: [{ type: 'text', text: 'hello' }]`. This keeps simple cases readable while supporting the full tagged union when needed. Adapters normalize on entry.

---

## Implementation

### Phase 1: Core Types & Error Taxonomy (~15%)

**Files:** `src/llm/types.ts` (rewrite), `src/llm/errors.ts` (new), `src/llm/adapters/types.ts` (new), `src/llm/tools.ts` (new), `src/llm/streaming.ts` (new)

**Tasks:**
- [ ] Define `Role`, `ContentPart` (6-variant tagged union), `Message` (with string shorthand), `ImageSource`
- [ ] Define `GenerateRequest`: messages, model, provider, tools, tool_choice, max_tokens, temperature, stop_sequences, reasoning_effort, system, abort_signal, cache_control
- [ ] Define `GenerateResponse`: message (assistant Message), usage, stop_reason, model, provider
- [ ] Define `Usage`: input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens
- [ ] Define `StreamEvent` discriminated union: `stream_start` (model), `content_delta` (text), `tool_call_delta` (id, name?, arguments_delta), `thinking_delta` (text), `usage` (Usage), `stream_end` (stop_reason, message), `error` (LLMError)
- [ ] Define `ToolDefinition`: name, description, input_schema (JSON Schema object)
- [ ] Define `ToolChoice`: `{ type: 'auto' | 'none' | 'required' | 'named'; name?: string }`
- [ ] Define `LLMError` base class extending `Error` with `provider`, `retryable`, `status_code` fields
- [ ] Define 8 error subclasses: `AuthenticationError` (not retryable), `RateLimitError` (retryable, `retry_after_ms`), `OverloadedError` (retryable), `InvalidRequestError` (not retryable), `ContextWindowError` (not retryable), `ContentFilterError` (not retryable), `NetworkError` (retryable), `TimeoutError` (retryable)
- [ ] Define `ProviderAdapter` interface: `generate(request): Promise<GenerateResponse>`, `stream(request): AsyncIterable<StreamEvent>`, `readonly provider_name: string`
- [ ] Helper: `normalizeContent(content: string | ContentPart[]): ContentPart[]`
- [ ] Tests: type construction, ContentPart narrowing, error retryability classification, normalizeContent

### Phase 2: Retry Middleware & SSE Parser (~10%)

**Files:** `src/llm/retry.ts` (new), `test/llm/retry.test.ts` (new)

**Tasks:**
- [ ] Implement `RetryConfig`: max_retries (default 3), base_delay_ms (200), max_delay_ms (60_000), jitter (true)
- [ ] Implement `withRetry(adapter: ProviderAdapter, config?: Partial<RetryConfig>): ProviderAdapter`
  - Wraps both `generate()` and `stream()` with retry logic
  - Returns a new object conforming to `ProviderAdapter` — no subclassing
- [ ] Backoff formula: `min(base_delay_ms * 2^(attempt-1), max_delay_ms)` with jitter factor `0.5 + Math.random()`
- [ ] If `RateLimitError` has `retry_after_ms`, use `max(retry_after_ms, computed_delay)` as the wait
- [ ] Only retry when `error.retryable === true` — all others propagate immediately
- [ ] AbortSignal: check between retries; if aborted, throw `AbortError` immediately
- [ ] Stream retry policy: retry the whole stream call if error occurs before any `content_delta` is yielded; once content has been yielded to the consumer, propagate the error (partial streams cannot be replayed)
- [ ] Implement `parseSSEStream(response: Response, signal?: AbortSignal): AsyncIterable<{event?: string, data: string}>` in `streaming.ts` — shared by Anthropic and OpenAI adapters
- [ ] Tests: retry on 429 with Retry-After, retry on 503, no retry on 401, abort cancels retry loop, max retries exhausted throws last error, stream retry before first delta, stream no-retry after delta

### Phase 3: Anthropic Adapter (~20%)

**Files:** `src/llm/adapters/anthropic.ts` (new — replaces old `client.ts` AnthropicProvider), `test/llm/adapters/anthropic.test.ts` (new)

**Tasks:**
- [ ] Request translation: extract system messages to top-level `system` param; convert `ContentPart[]` → Anthropic content blocks (`text`→`text`, `tool_call`→`tool_use` with parsed JSON arguments, `tool_result`→`tool_result`, `image`→`image` with base64 source)
- [ ] Tool definitions: `ToolDefinition` → `{ name, description, input_schema }` in Anthropic `tools` array
- [ ] Tool choice: `auto`→`{ type: 'auto' }`, `none`→omit tools, `required`→`{ type: 'any' }`, `named`→`{ type: 'tool', name }`
- [ ] `cache_control`: when enabled, set `{ type: 'ephemeral' }` on system prompt content blocks and first N eligible user messages
- [ ] `reasoning_effort`: map to `thinking: { type: 'enabled', budget_tokens }` for extended-thinking-capable models
- [ ] API version header: `anthropic-version: 2023-06-01`; beta headers as needed (`prompt-caching-2024-07-31`, `output-128k-2025-02-19`)
- [ ] Response translation: Anthropic content blocks → unified `ContentPart` (`text`→`text`, `tool_use`→`tool_call` with stringified arguments, `thinking`→`thinking`, `redacted_thinking`→`redacted_thinking`)
- [ ] Usage mapping: `cache_creation_input_tokens`→`cache_write_tokens`, `cache_read_input_tokens`→`cache_read_tokens`
- [ ] Streaming: POST with `stream: true`, parse SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) → unified `StreamEvent` async iterable
- [ ] Error mapping: 401→`AuthenticationError`, 429→`RateLimitError` (parse `retry-after` header), 529→`OverloadedError`, 400 with `invalid_request_error`→`InvalidRequestError`, 400 with context-length message→`ContextWindowError`
- [ ] Base URL override via `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`)
- [ ] Tests: request translation (system extraction, content parts, tools), response translation (all block types), SSE stream parsing, error classification, cache_control headers — all with mocked `fetch`

### Phase 4: OpenAI Adapter (~20%)

**Files:** `src/llm/adapters/openai.ts` (new), `test/llm/adapters/openai.test.ts` (new)

**Tasks:**
- [ ] POST to `{base_url}/v1/responses` (Responses API, not Chat Completions)
- [ ] Request translation: unified `Message[]` → Responses API `input` (items with roles); system → `instructions` field; `ContentPart[]` → OpenAI content parts (`text`→text, `tool_call`→`function_call` item, `tool_result`→`function_call_output` item)
- [ ] Tool definitions → `tools: [{ type: 'function', name, description, parameters }]`
- [ ] Tool choice: `auto`/`none`/`required` → `tool_choice` string; `named` → `{ type: 'function', name }`
- [ ] `reasoning_effort` → `reasoning: { effort: 'low'|'medium'|'high' }` for o-series models
- [ ] Response translation: Responses API `output` items → unified `ContentPart` (`message.content[].text`→`text`, `function_call`→`tool_call`)
- [ ] Reasoning token tracking: `usage.output_tokens_details.reasoning_tokens` → `usage.reasoning_tokens`
- [ ] Streaming: POST with `stream: true`, parse SSE events (`response.created`, `response.output_item.added`, `response.content_part.delta`, `response.output_item.done`, `response.completed`) → unified `StreamEvent`
- [ ] Error mapping: 401→`AuthenticationError`, 429→`RateLimitError`, 503→`OverloadedError`, 400→`InvalidRequestError`
- [ ] Auth header: `Authorization: Bearer {OPENAI_API_KEY}`
- [ ] Base URL via `OPENAI_BASE_URL` (default `https://api.openai.com`)
- [ ] Tests: request/response translation, streaming, error mapping, reasoning tokens — all with mocked `fetch`

### Phase 5: Gemini Adapter (~15%)

**Files:** `src/llm/adapters/gemini.ts` (new), `test/llm/adapters/gemini.test.ts` (new)

**Tasks:**
- [ ] POST to `{base_url}/v1beta/models/{model}:generateContent` (non-streaming) and `:streamGenerateContent?alt=sse` (streaming)
- [ ] Request translation: unified `Message[]` → Gemini `contents` (parts: `text`, `functionCall`, `functionResponse`); system → `system_instruction`
- [ ] Tool definitions → `tools: [{ function_declarations: [{ name, description, parameters }] }]`
- [ ] Tool choice: `auto`→`AUTO`, `none`→`NONE`, `required`→`ANY`, `named`→`{ allowed_function_names: [name] }` in `tool_config.function_calling_config`
- [ ] `reasoning_effort` → `generation_config.thinking_config.thinking_budget` for Gemini 2.5 models
- [ ] Response translation: `candidates[0].content.parts` → unified `ContentPart` (`text`→`text`, `functionCall`→`tool_call` with stringified args, `thought: true`→`thinking`)
- [ ] Thinking token tracking: `usage_metadata.thoughts_token_count` → `usage.reasoning_tokens`; `candidates_token_count` → `output_tokens`; `prompt_token_count` → `input_tokens`
- [ ] Streaming: Gemini streaming uses SSE format with `?alt=sse` — parse `data:` lines containing JSON response chunks, aggregate deltas into unified `StreamEvent` sequence
- [ ] Error mapping: 401/403→`AuthenticationError`, 429→`RateLimitError`, 503→`OverloadedError`, 400→`InvalidRequestError`
- [ ] API key: `?key={GEMINI_API_KEY}` query param; accept `GOOGLE_API_KEY` as fallback
- [ ] Base URL via `GEMINI_BASE_URL` (default `https://generativelanguage.googleapis.com`)
- [ ] Tests: request/response translation, streaming chunk parsing, error mapping, thinking tokens — mocked `fetch`

### Phase 6: Unified Client & Codergen Upgrade (~20%)

**Files:** `src/llm/client.ts` (rewrite), `src/llm/simulation.ts` (update), `src/handlers/codergen.ts` (modify), `src/handlers/registry.ts` (modify), `src/engine/engine.ts` (modify), `test/llm/client.test.ts` (new), `test/handlers/codergen.test.ts` (update)

**Tasks:**
- [ ] Implement `UnifiedClient`:
  - `static from_env(): UnifiedClient` — checks `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`; creates and wraps each discovered adapter with `withRetry()`; always includes `SimulationProvider` as final fallback
  - `generate(request: GenerateRequest): Promise<GenerateResponse>` — routes by `request.provider`; if no provider specified, uses first available real adapter (Anthropic > OpenAI > Gemini > Simulation)
  - `stream(request: GenerateRequest): AsyncIterable<StreamEvent>` — streaming variant with same routing
  - `available_providers(): string[]` — returns names of configured providers
  - Constructor accepts explicit `Map<string, ProviderAdapter>` for DI/testing
- [ ] Update `SimulationProvider` to implement `ProviderAdapter` interface:
  - `stream()`: yields `stream_start`, text content in character chunks as `content_delta`, `usage`, `stream_end`
  - Keeps existing fake response generation logic
- [ ] Update codergen handler:
  - Accept `UnifiedClient` instead of old `LLMClient`
  - Read `llm_provider` and `llm_model` from node attributes; set on `GenerateRequest`
  - Use `stream()` for real-time writing to `response.md` — append each `content_delta` as it arrives
  - Single-turn tool loop: if response contains `tool_call` parts, execute each tool, append `tool_result` messages, call `generate()` once more for final response
  - Capture full `Usage` in `status.json`
- [ ] Update `HandlerRegistry` to accept `UnifiedClient` and pass to codergen handler
- [ ] Update engine constructor to accept and propagate `UnifiedClient`
- [ ] Update `run.ts` and `resume.ts` CLI commands to create `UnifiedClient.from_env()` and pass to engine
- [ ] Tests: client routing by provider, default provider selection, unknown provider error, simulation streaming, codergen with mocked client

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/types.ts` | **Rewrite** | Message, ContentPart (6 variants), GenerateRequest/Response, Usage |
| `src/llm/errors.ts` | **Create** | LLMError base + 8 error subclasses with retryability |
| `src/llm/retry.ts` | **Create** | `withRetry()` composable middleware |
| `src/llm/tools.ts` | **Create** | ToolDefinition, ToolChoice types |
| `src/llm/streaming.ts` | **Create** | StreamEvent union, SSE line parser |
| `src/llm/client.ts` | **Rewrite** | UnifiedClient: from_env(), generate(), stream(), routing |
| `src/llm/simulation.ts` | **Modify** | Conform to ProviderAdapter, add stream() |
| `src/llm/adapters/types.ts` | **Create** | ProviderAdapter interface contract |
| `src/llm/adapters/anthropic.ts` | **Create** | Anthropic Messages API (streaming, tools, cache, thinking) |
| `src/llm/adapters/openai.ts` | **Create** | OpenAI Responses API (streaming, tools, reasoning) |
| `src/llm/adapters/gemini.ts` | **Create** | Gemini generateContent API (streaming, tools, thinking) |
| `src/handlers/codergen.ts` | **Modify** | Wire to UnifiedClient, streaming output, tool loop |
| `src/handlers/registry.ts` | **Modify** | Pass UnifiedClient through |
| `src/engine/engine.ts` | **Modify** | Accept and propagate UnifiedClient |
| `src/cli/commands/run.ts` | **Modify** | Create UnifiedClient.from_env(), pass to engine |
| `src/cli/commands/resume.ts` | **Modify** | Create UnifiedClient.from_env(), pass to engine |
| `test/llm/retry.test.ts` | **Create** | Retry middleware: backoff, Retry-After, abort, stream retry |
| `test/llm/client.test.ts` | **Create** | UnifiedClient routing, default selection, fallback |
| `test/llm/adapters/anthropic.test.ts` | **Create** | Anthropic: translation, streaming, errors, cache |
| `test/llm/adapters/openai.test.ts` | **Create** | OpenAI: translation, streaming, errors, reasoning |
| `test/llm/adapters/gemini.test.ts` | **Create** | Gemini: translation, streaming, errors, thinking |
| `test/handlers/codergen.test.ts` | **Modify** | Update for UnifiedClient interface |

---

## Definition of Done

### Build & Tests
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests (no regressions) plus all new LLM client tests
- [ ] All adapter tests use mocked `fetch` — zero real API calls in `npm test`

### UnifiedClient
- [ ] `UnifiedClient.from_env()` discovers providers from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`
- [ ] `client.generate(request)` routes to correct provider based on `request.provider`
- [ ] `client.stream(request)` returns `AsyncIterable<StreamEvent>` yielding content deltas
- [ ] When no provider specified, routes to first available (Anthropic > OpenAI > Gemini > Simulation)
- [ ] `client.available_providers()` returns list of configured provider names
- [ ] When no API keys configured, falls back to `SimulationProvider`

### Content Model
- [ ] `ContentPart` supports all 6 variants: text, image, tool_call, tool_result, thinking, redacted_thinking
- [ ] `Message.content` accepts both `string` and `ContentPart[]`
- [ ] `Usage` tracks: input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens

### Provider Adapters
- [ ] Anthropic adapter: Messages API (`/v1/messages`), streaming SSE, tool calling, `cache_control`, thinking blocks
- [ ] OpenAI adapter: Responses API (`/v1/responses`), streaming SSE, tool calling, reasoning tokens
- [ ] Gemini adapter: native API (`/v1beta/models/*/generateContent`), streaming, tool calling, thinking tokens
- [ ] `ToolDefinition` translates correctly to each provider's native format
- [ ] `ToolChoice` modes (auto, none, required, named) translate for each provider
- [ ] `reasoning_effort` passes through to each provider's native parameter
- [ ] Base URL override via `*_BASE_URL` env vars for each provider

### Error Handling & Retry
- [ ] Error taxonomy classifies HTTP responses into correct `LLMError` subclass with `retryable` flag
- [ ] `RateLimitError` parses `Retry-After` header when present
- [ ] `withRetry()` retries transient errors (429, 503, network) with exponential backoff + jitter
- [ ] `withRetry()` does NOT retry non-transient errors (401, 400)
- [ ] AbortSignal cancels in-flight HTTP requests and pending retries

### Codergen Integration
- [ ] Codergen handler uses `UnifiedClient`, reads `llm_provider`/`llm_model` from node attributes
- [ ] Codergen handler streams response to `response.md` incrementally via `stream()`
- [ ] Codergen handler supports single-turn tool calling (tools → execute → final response)
- [ ] `SimulationProvider` conforms to `ProviderAdapter` with `stream()` support

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| OpenAI Responses API has underdocumented edge cases | Medium | High | Build against recorded response fixtures. The Responses API is newer than Chat Completions — pin behavior with snapshot tests. Fall back to Chat Completions only as last resort (would lose reasoning tokens). |
| Three full adapters is ambitious for one sprint | Medium | High | Priority tiers below. Gemini is Tier 2. Core types + retry + Anthropic + OpenAI is the minimum viable sprint. Two adapters still transforms what Nectar can do. |
| Gemini streaming format differs from SSE | Low | Medium | Gemini now supports `?alt=sse` which returns standard SSE. The old newline-delimited JSON format is fallback only. |
| Provider APIs change during sprint | Low | Medium | Pin API versions: Anthropic `2023-06-01`, OpenAI responses `v1`, Gemini `v1beta`. Adapter isolation contains blast radius — an API change breaks one adapter, not the client. |
| Streaming cancellation is flaky across providers | Medium | Medium | `AbortController` is native to `fetch`. Test cancellation per adapter. Accept that some providers lag on connection close — set a reasonable timeout on the abort. |
| Mocked tests miss real API incompatibilities | High | Medium | Record real API responses as fixtures during development. Add `test:smoke:llm` script that runs one real request per provider (manual, not CI). Document provider-specific quirks as they're discovered. |
| Tool calling semantics vary across providers | Medium | Medium | Normalize to lowest common denominator: name + JSON arguments + string result. Provider-specific extensions (e.g., Anthropic's `is_error` on tool results) are mapped where supported, ignored where not. |

---

## Dependencies

**Runtime (new):** None. All HTTP via Node.js 22 built-in `fetch`.

**External services (optional, for development/smoke testing):**

| Service | Env Var | Fallback | API Endpoint |
|---------|---------|----------|--------------|
| Anthropic | `ANTHROPIC_API_KEY` | SimulationProvider | Messages API `/v1/messages` |
| OpenAI | `OPENAI_API_KEY` | SimulationProvider | Responses API `/v1/responses` |
| Google AI Studio | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | SimulationProvider | `generateContent` `/v1beta/models/*` |

All providers are optional. No API key = simulation fallback. Pipelines always run.

---

## Priority Tiers

Cut from the bottom if behind schedule:

| Tier | Scope | Moves GAP-50 to |
|------|-------|-----------------|
| **Tier 1 — must ship** | Core types + error taxonomy + retry middleware + Anthropic adapter (streaming + tools) + OpenAI adapter (streaming + tools) + UnifiedClient routing + codergen handler upgrade | ~60% |
| **Tier 2 — should ship** | Gemini adapter (streaming + tools) + `reasoning_effort` for all providers + reasoning token tracking | ~80% |
| **Tier 3 — stretch** | Anthropic `cache_control` + thinking block support (all providers) + `cache_read`/`cache_write` token tracking + SimulationProvider streaming | ~85% |

**Minimum viable sprint is Tier 1.** Two production adapters with streaming and tool support, wired into codergen nodes. This alone transforms Nectar from a shell orchestrator into a real AI pipeline engine and unblocks the Coding Agent Loop sprint.
