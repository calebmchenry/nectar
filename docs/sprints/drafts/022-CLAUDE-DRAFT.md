# Sprint 022: Local LLMs, Error Ergonomics, and Pipeline Extensibility — Closing GAP-2, GAP-3, and GAP-5

## Overview

**Goal:** Ship an OpenAI Chat Completions adapter that unlocks local and third-party LLM endpoints (Ollama, vLLM, Together AI, Groq), complete the error type hierarchy for consumer ergonomics, and expose a public transform registration API for pipeline authors. After this sprint, `docs/compliance-report.md` drops from six gaps to three — and the three that remain (AUDIO/DOCUMENT, Gemini extended tools, sub-pipeline composition) are all explicitly optional or future-facing in the specs.

**Why this sprint, why now:**

1. **GAP-3 is the highest-impact remaining gap by a wide margin.** Every developer who runs Ollama locally, every team with a vLLM deployment, every user of Together AI or Groq — none of them can use Nectar's LLM features today. The unified client only speaks OpenAI Responses API, Anthropic Messages API, and Gemini native API. The entire Chat Completions ecosystem (`/v1/chat/completions`) — which is the de facto standard for local and third-party LLM hosting — is unreachable. This is the gap that blocks the most real-world users.

2. **Sprint 021 completed the product surface.** All three pillars — pipeline engine, CLI, and Hive with Seedbed/Swarm — are functional. The explicit deferral note in Sprint 021 says: "They belong in a dedicated compliance sprint after the product surface is complete." The surface is complete. This is that compliance sprint.

3. **GAP-2 is mechanical but ergonomically painful.** Consumers catching `LLMError` must inspect `status_code` to distinguish 403 from 401, or 404 from 400. The spec requires distinct error types. This is a straightforward hierarchy expansion with zero behavioral risk — every new error type extends the existing `LLMError` base class.

4. **GAP-5 unblocks community extensibility.** Custom transforms are how pipeline authors inject their own graph rewriting logic — custom variable expansion, node synthesis, conditional graph structure. The existing transform pipeline already applies a fixed set; exposing registration is a small API surface with high leverage.

5. **The remaining three gaps (1, 4, 6) are deliberately deferred.** GAP-1 (AUDIO/DOCUMENT content types) supports future modalities no provider fully offers today. GAP-4 (Gemini extended tools) is explicitly optional in the spec. GAP-6 (sub-pipeline composition) requires a graph merging algorithm that is a sprint-sized effort on its own. None blocks a user workflow.

**Gaps closed:**

| Gap | Spec | Effort | Impact |
|-----|------|--------|--------|
| GAP-3: OpenAI-Compatible Adapter | unified-llm-spec §7.10 | Large | Unlocks Ollama, vLLM, Together AI, Groq, and any Chat Completions-compatible endpoint |
| GAP-2: Missing Error Subtypes | unified-llm-spec §6.1 | Small | Consumer ergonomics — catch specific errors instead of inspecting status codes |
| GAP-5: Custom Transform Registration | attractor-spec §9.3 | Medium | Pipeline authors can register graph rewriting logic |

**In scope:**

- `OpenAICompatibleAdapter` for Chat Completions API (`/v1/chat/completions`)
- Configuration via `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, and model catalog entries
- Streaming support over Chat Completions SSE format
- Tool calling translation between unified schema and Chat Completions `function` format
- Structured output via `response_format: { type: "json_schema" }` where supported
- Provider-specific options passthrough for custom endpoints
- Six new error types: `AccessDeniedError`, `NotFoundError`, `QuotaExceededError`, `StreamError`, `AbortError`, `UnsupportedToolChoiceError`
- `NoObjectGeneratedError` as a structured-output-specific subtype
- Public `Transform` interface and `TransformRegistry.register()` API
- Custom transforms run after built-in transforms in registration order
- CLI `--transform` flag for ad hoc transform module loading
- Integration tests against a mock Chat Completions server

**Out of scope:**

- GAP-1: AUDIO/DOCUMENT content types (future modality)
- GAP-4: Gemini extended tools (`read_many_files`, `list_dir`) — optional per spec
- GAP-6: Sub-pipeline composition and graph merging (separate sprint)
- Ollama-specific features beyond Chat Completions compatibility (model pulling, embedding API)
- Chat Completions vision/image input (the adapter handles text and tool calling; image support is a follow-up)
- Automatic provider detection (users explicitly configure the compatible endpoint)
- Web UI changes (this is a backend/library sprint)

---

## Use Cases

1. **Use Ollama locally.** User sets `OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1` and `OPENAI_COMPATIBLE_API_KEY=ollama`. Pipeline runs use `llm_provider="openai_compatible"` in their model stylesheet or node attributes. Codergen nodes execute against the local Ollama instance.

2. **Use a team vLLM deployment.** A team runs vLLM serving Llama 3 behind an internal endpoint. They configure the base URL and API key. Nectar's unified client routes requests through the Chat Completions adapter transparently — retry, middleware, streaming, tool calling all work.

3. **Use Together AI or Groq.** User sets the base URL to `https://api.together.xyz/v1` or `https://api.groq.com/openai/v1` with their API key. The adapter handles the standard Chat Completions protocol. Provider-specific options (like Together's model routing) pass through via `provider_options.openai_compatible`.

4. **Mix providers in one pipeline.** A model stylesheet assigns `openai_compatible` to codergen nodes and `anthropic` to fan-in evaluation nodes. The engine resolves each node's provider independently. The same pipeline uses local Ollama for drafting and Claude for critical evaluation.

5. **Catch specific errors.** A consumer wraps an LLM call in a try/catch. Instead of `if (err instanceof LLMError && err.status_code === 403)`, they write `catch (err) { if (err instanceof AccessDeniedError) ... }`. The error hierarchy follows the spec exactly.

6. **Register a custom transform.** A pipeline author writes a transform that injects monitoring nodes before every codergen node. They register it with `TransformRegistry.register('inject-monitors', myTransform)`. The transform runs after stylesheet application and before validation.

7. **Load transforms from CLI.** User runs `nectar run --transform ./my-transforms.ts garden.dot`. The CLI dynamically imports the module, which calls `TransformRegistry.register()` at load time. The pipeline runs with the custom transforms applied.

8. **Fail gracefully on incompatible endpoints.** A Chat Completions endpoint doesn't support tool calling. The adapter receives a 400 with an error about unsupported parameters. Nectar surfaces an `UnsupportedToolChoiceError` so the pipeline author can handle it — or the model stylesheet can route tool-heavy nodes to a capable provider.

---

## Architecture

### OpenAI-Compatible Adapter

The adapter targets the [Chat Completions API](https://platform.openai.com/docs/api-reference/chat) — specifically the `/v1/chat/completions` endpoint that virtually all third-party services implement. This is distinct from the existing OpenAI Responses API adapter at `src/llm/adapters/openai.ts`.

**Key design decisions:**

1. **Separate adapter, not a mode flag.** The Responses API and Chat Completions API have different request/response shapes, streaming formats, and tool calling conventions. A clean adapter is simpler and more testable than branching inside the existing OpenAI adapter.

2. **Provider name: `openai_compatible`.** Registered alongside `openai`, `anthropic`, and `gemini` in the client. Configured via `OPENAI_COMPATIBLE_*` environment variables. Multiple compatible endpoints are supported by registering additional instances with custom names.

3. **Chat Completions message format.** The adapter translates between the unified `Message` model and Chat Completions messages: `system`, `user`, `assistant` (with `tool_calls`), and `tool` roles. Content parts map to the Chat Completions `content` array format where supported, or concatenated text for simpler endpoints.

4. **Streaming format.** Chat Completions streams `data: {"choices": [{"delta": {...}}]}` lines. The adapter translates these to unified `StreamEvent`s. It handles the `[DONE]` sentinel, partial JSON deltas, and tool call argument streaming.

5. **Tool calling.** Chat Completions uses `functions` (legacy) or `tools` (current). The adapter uses the `tools` format with `type: "function"`. Tool results come back as `tool` role messages. The unified `ToolDefinition` maps directly.

6. **Structured output.** Where the endpoint supports `response_format: { type: "json_schema", json_schema: { ... } }`, the adapter passes it through. For endpoints that don't, the adapter falls back to prompt-based JSON extraction (same as the existing Gemini path).

7. **No automatic provider detection.** Users explicitly configure the endpoint. The adapter does not probe the endpoint to determine capabilities. This keeps the adapter stateless and predictable.

### Error Hierarchy Expansion

The six new error types slot into the existing `LLMError` hierarchy:

```
LLMError
├── AuthenticationError (401)        # existing
├── AccessDeniedError (403)          # NEW
├── NotFoundError (404)              # NEW
├── RateLimitError (429)             # existing
├── QuotaExceededError               # NEW — billing/quota, not rate limit
├── InvalidRequestError (400)        # existing
├── ContextWindowError               # existing
├── ContentFilterError               # existing
├── OverloadedError (503)            # existing
├── NetworkError                     # existing
├── TimeoutError                     # existing
├── ConfigurationError               # existing
├── StreamError                      # NEW — SSE parse failure, unexpected close
├── AbortError                       # NEW — replaces DOM AbortError
├── StructuredOutputError            # existing
│   └── NoObjectGeneratedError       # NEW — model returned no parseable object
└── UnsupportedToolChoiceError       # NEW — endpoint doesn't support tool choice mode
```

Each new type:
- Extends `LLMError` with the correct `retryable` flag
- Has a stable `code` string for programmatic matching
- Is exported from `src/llm/errors.ts`
- Is mapped from HTTP status codes in each adapter's error handling

**Retryability:** `AccessDeniedError`, `NotFoundError`, `QuotaExceededError`, and `UnsupportedToolChoiceError` are non-retryable. `StreamError` is retryable. `AbortError` is non-retryable (user-initiated). `NoObjectGeneratedError` is retryable (model may produce valid output on retry).

### Custom Transform API

```typescript
// src/garden/transforms.ts
export interface Transform {
  name: string;
  apply(graph: GardenGraph): GardenGraph;
}

export class TransformRegistry {
  static register(name: string, transform: Transform): void;
  static unregister(name: string): void;
  static getCustomTransforms(): Transform[];
  static clear(): void;
}
```

The existing `transformAndValidate()` pipeline in `src/garden/pipeline.ts` is extended:

1. Goal expansion (built-in)
2. Stylesheet application (built-in)
3. **Custom transforms in registration order** (new)
4. Validation

Custom transforms receive a mutable `GardenGraph` and return the (possibly modified) graph. They run after built-in transforms so they can see fully resolved models and expanded variables.

### Module Layout

```text
src/
├── llm/
│   ├── adapters/
│   │   ├── openai.ts                    # Existing Responses API adapter
│   │   ├── openai-compatible.ts         # NEW: Chat Completions adapter
│   │   ├── anthropic.ts                 # Existing
│   │   └── gemini.ts                    # Existing
│   ├── errors.ts                        # Expand with 6 new error types
│   ├── client.ts                        # Register openai_compatible provider
│   ├── catalog.ts                       # Add openai_compatible model entries
│   └── streaming.ts                     # Chat Completions SSE parsing
├── garden/
│   ├── transforms.ts                    # NEW: Transform interface + registry
│   └── pipeline.ts                      # Integrate custom transforms
├── cli/
│   └── commands/
│       └── run.ts                       # Add --transform flag

test/
├── llm/
│   ├── openai-compatible.test.ts        # Adapter unit tests
│   └── errors.test.ts                   # Error hierarchy tests
├── garden/
│   ├── transforms.test.ts              # Transform registry tests
│   └── pipeline.test.ts                # Custom transform integration
├── integration/
│   ├── chat-completions-server.test.ts  # Mock server end-to-end
│   └── custom-transforms.test.ts       # CLI --transform flow
└── helpers/
    └── mock-chat-completions.ts         # Reusable mock Chat Completions server
```

---

## Implementation

### Phase 1: Error Hierarchy Expansion — GAP-2 (~15%)

**Files:** `src/llm/errors.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `src/llm/retry.ts`, `src/llm/client.ts`, `test/llm/errors.test.ts`

**Tasks:**
- [ ] Add `AccessDeniedError` (non-retryable, status 403) with `code: 'access_denied'`
- [ ] Add `NotFoundError` (non-retryable, status 404) with `code: 'not_found'`
- [ ] Add `QuotaExceededError` (non-retryable) with `code: 'quota_exceeded'` — distinct from `RateLimitError` (billing vs. rate)
- [ ] Add `StreamError` (retryable) with `code: 'stream_error'` — SSE parse failures, unexpected connection close
- [ ] Add `AbortError` (non-retryable) with `code: 'abort'` — replaces raw `DOMException('Aborted', 'AbortError')`
- [ ] Add `UnsupportedToolChoiceError` (non-retryable) with `code: 'unsupported_tool_choice'`
- [ ] Add `NoObjectGeneratedError` extending `StructuredOutputError` (retryable) with `code: 'no_object_generated'`
- [ ] Update `mapHttpStatusToError()` in each adapter to produce the new types for 403 and 404 responses
- [ ] Update the Anthropic adapter to map `permission_error` to `AccessDeniedError` and `not_found_error` to `NotFoundError`
- [ ] Update the OpenAI adapter to map 403/404 status codes to the new types
- [ ] Update the Gemini adapter to map `PERMISSION_DENIED` to `AccessDeniedError` and `NOT_FOUND` to `NotFoundError`
- [ ] Replace `DOMException` abort handling in streaming code with `AbortError`
- [ ] Update retry middleware to respect `retryable` flags on new error types
- [ ] Ensure `generateObject()` throws `NoObjectGeneratedError` when the model returns no parseable JSON after all retries
- [ ] Add unit tests for each new error type: construction, `retryable` flag, `instanceof` checks, serialization
- [ ] Add tests verifying adapter error mapping for 403, 404, quota, and stream failures
- [ ] Verify all existing error-handling tests still pass

### Phase 2: OpenAI-Compatible Adapter Core — GAP-3 (~35%)

**Files:** `src/llm/adapters/openai-compatible.ts`, `src/llm/client.ts`, `src/llm/catalog.ts`, `src/llm/streaming.ts`, `test/llm/openai-compatible.test.ts`, `test/helpers/mock-chat-completions.ts`

**Tasks:**
- [ ] Create `src/llm/adapters/openai-compatible.ts` implementing the `LLMAdapter` interface
- [ ] Implement request translation: unified `GenerateRequest` → Chat Completions request body
  - [ ] Map `Message` roles to Chat Completions roles (`system`, `user`, `assistant`, `tool`)
  - [ ] Translate `ContentPart` arrays to Chat Completions `content` format (text concatenation for simple endpoints, structured array for multimodal-capable ones)
  - [ ] Map unified `ToolDefinition` to Chat Completions `tools` array with `type: "function"`
  - [ ] Translate `ToolChoice` (`auto`, `none`, `required`, `named`) to Chat Completions `tool_choice`
  - [ ] Pass `max_tokens`, `temperature`, `top_p`, `stop` directly
  - [ ] Forward `provider_options.openai_compatible` as additional request body fields
- [ ] Implement response translation: Chat Completions response → unified `GenerateResponse`
  - [ ] Extract `choices[0].message` content and tool calls
  - [ ] Map `finish_reason` (`stop`, `tool_calls`, `length`) to unified `StopReason`
  - [ ] Parse `usage` into unified `Usage` model (input_tokens, output_tokens)
  - [ ] Preserve `id` and `model` from response for tracing
- [ ] Implement streaming: Chat Completions SSE → unified `StreamEvent`s
  - [ ] Parse `data: {...}` lines with `choices[0].delta` incremental format
  - [ ] Handle `content` text deltas → `content_delta` events
  - [ ] Handle `tool_calls` argument deltas → `tool_call_delta` events (accumulate tool call index and arguments)
  - [ ] Handle `[DONE]` sentinel → `stream_end` event
  - [ ] Extract streaming usage from final chunk if present
  - [ ] Translate stream errors to `StreamError`
- [ ] Implement error mapping: HTTP status codes → error hierarchy
  - [ ] 401 → `AuthenticationError`
  - [ ] 403 → `AccessDeniedError`
  - [ ] 404 → `NotFoundError`
  - [ ] 429 → `RateLimitError` (with `retry_after_ms` from `Retry-After` header)
  - [ ] 500+ → `OverloadedError`
  - [ ] Parse error response body for `error.message` and `error.type` fields
- [ ] Implement structured output passthrough
  - [ ] When endpoint supports `response_format: { type: "json_schema" }`, pass through the schema
  - [ ] When endpoint doesn't support it (400 on attempt), fall back to prompt-based JSON in the system message
  - [ ] Detect capability via a single probe request on first structured-output call, cache the result
- [ ] Register `openai_compatible` provider in `Client.from_env()`
  - [ ] Read `OPENAI_COMPATIBLE_API_KEY` and `OPENAI_COMPATIBLE_BASE_URL` environment variables
  - [ ] Skip registration when neither variable is set
  - [ ] Support `OPENAI_COMPATIBLE_MODEL` for a default model name
- [ ] Add model catalog entries for common compatible endpoints (ollama, together, groq) with capability flags
- [ ] Create `test/helpers/mock-chat-completions.ts`: lightweight HTTP server implementing the Chat Completions contract
  - [ ] Support `/v1/chat/completions` for both streaming and non-streaming
  - [ ] Configurable responses, tool calls, and error codes
  - [ ] Automatic port allocation for test isolation
- [ ] Write adapter unit tests covering:
  - [ ] Basic text generation (non-streaming and streaming)
  - [ ] Multi-turn conversation threading
  - [ ] Tool calling (single and parallel tool calls)
  - [ ] Tool result round-trip
  - [ ] Structured JSON output
  - [ ] Error mapping for all status codes
  - [ ] `AbortSignal` cancellation
  - [ ] Provider options passthrough
  - [ ] Missing/invalid API key handling

### Phase 3: Adapter Integration and Provider Profiles (~15%)

**Files:** `src/llm/client.ts`, `src/llm/rate-limit.ts`, `src/llm/middleware.ts`, `src/agent-loop/provider-profiles.ts`, `src/engine/session-registry.ts`, `test/integration/chat-completions-server.test.ts`

**Tasks:**
- [ ] Verify retry middleware works correctly with the new adapter (backoff, rate limit headers, abort safety)
- [ ] Verify rate limit header parsing for Chat Completions-style headers (`x-ratelimit-*`)
- [ ] Verify middleware chain (logging, retry, custom) applies to the new adapter
- [ ] Add an `openai_compatible` provider profile in `src/agent-loop/provider-profiles.ts`
  - [ ] System prompt adapted for generic Chat Completions models (no provider-specific personality)
  - [ ] Tool set: same core tools as OpenAI profile (read_file, write_file, edit_file/apply_patch, shell, grep, glob)
  - [ ] `parallel_tool_execution: false` by default (not all endpoints support it)
  - [ ] Configurable command timeout (120s default)
- [ ] Ensure session registry creates sessions for `openai_compatible` provider correctly
- [ ] Add integration test: spin up mock Chat Completions server → configure adapter → run a simple pipeline with a codergen node → verify LLM interaction and response
- [ ] Add integration test: tool calling round-trip through the mock server
- [ ] Add integration test: streaming with mid-stream abort
- [ ] Add integration test: retry on 429 with `Retry-After` header

### Phase 4: Custom Transform Registration — GAP-5 (~20%)

**Files:** `src/garden/transforms.ts`, `src/garden/types.ts`, `src/garden/pipeline.ts`, `src/cli/commands/run.ts`, `src/cli/commands/shared.ts`, `test/garden/transforms.test.ts`, `test/garden/pipeline.test.ts`, `test/integration/custom-transforms.test.ts`

**Tasks:**
- [ ] Create `src/garden/transforms.ts` with `Transform` interface and `TransformRegistry` class
  - [ ] `Transform` interface: `{ name: string; apply(graph: GardenGraph): GardenGraph }`
  - [ ] `TransformRegistry.register(name, transform)`: add to ordered list; error on duplicate names
  - [ ] `TransformRegistry.unregister(name)`: remove by name
  - [ ] `TransformRegistry.getCustomTransforms()`: return transforms in registration order
  - [ ] `TransformRegistry.clear()`: remove all custom transforms (used in tests)
- [ ] Modify `src/garden/pipeline.ts` `transformAndValidate()`:
  - [ ] After built-in transforms (goal expansion, stylesheet), iterate over `TransformRegistry.getCustomTransforms()` and apply each
  - [ ] Wrap each custom transform in a try/catch; on error, produce a diagnostic with the transform name and error message rather than crashing
  - [ ] Log transform application order when verbose logging is enabled
- [ ] Add `--transform <path>` flag to `nectar run` command
  - [ ] Accept one or more `--transform` flags (repeatable)
  - [ ] Dynamically import each path before pipeline execution
  - [ ] Expect each module to self-register via `TransformRegistry.register()` at import time
  - [ ] Error clearly if the module fails to load or doesn't register any transforms
- [ ] Add the same `--transform` flag to `nectar validate` so users can validate with transforms applied
- [ ] Export `Transform` and `TransformRegistry` from the package's public API
- [ ] Write unit tests:
  - [ ] Register and apply a transform that adds a node attribute
  - [ ] Register multiple transforms; verify execution order
  - [ ] Duplicate name registration throws
  - [ ] Transform error produces diagnostic, doesn't crash pipeline
  - [ ] Unregister removes transform; clear removes all
- [ ] Write pipeline integration test: register a transform that injects a monitoring attribute on all codergen nodes, run `transformAndValidate()`, verify the attribute is present
- [ ] Write CLI integration test: create a `.ts` transform module in a temp dir, run `nectar validate --transform ./my-transform.ts garden.dot`, verify the transform applied

### Phase 5: Documentation, Catalog, and Final Verification (~15%)

**Files:** `src/llm/catalog.ts`, `docs/compliance-report.md`, `test/integration/chat-completions-server.test.ts`

**Tasks:**
- [ ] Add model catalog entries for well-known compatible providers:
  - [ ] Ollama: common model names (llama3, codellama, mistral) with context window estimates and capability flags
  - [ ] Together AI: popular models with correct context windows
  - [ ] Groq: popular models with correct context windows
  - [ ] Mark all compatible-provider models with `supports_tool_calling` and `supports_structured_output` flags where known
- [ ] Update `docs/compliance-report.md`:
  - [ ] Move GAP-2 (error subtypes) to IMPLEMENTED section with file references
  - [ ] Move GAP-3 (OpenAI-compatible adapter) to IMPLEMENTED section with file references
  - [ ] Move GAP-5 (custom transform registration) to IMPLEMENTED section with file references
- [ ] Run the full test suite and verify zero regressions
- [ ] Verify `npm run build` succeeds
- [ ] Verify `bun build --compile src/cli/index.ts --outfile /tmp/nectar-smoke` produces a working binary
- [ ] End-to-end smoke test: configure mock Chat Completions server → `nectar run --transform ./test-transform.ts garden.dot` → verify pipeline completes with the compatible adapter and custom transform applied

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/errors.ts` | Modify | Add 6 new error types to hierarchy |
| `src/llm/adapters/openai-compatible.ts` | Create | Chat Completions adapter for third-party endpoints |
| `src/llm/adapters/openai.ts` | Modify | Update error mapping for 403/404 |
| `src/llm/adapters/anthropic.ts` | Modify | Update error mapping for 403/404 |
| `src/llm/adapters/gemini.ts` | Modify | Update error mapping for 403/404 |
| `src/llm/client.ts` | Modify | Register `openai_compatible` provider from env |
| `src/llm/catalog.ts` | Modify | Add compatible-provider model entries |
| `src/llm/streaming.ts` | Modify | Chat Completions SSE delta parsing |
| `src/llm/retry.ts` | Modify | Verify new error types respected |
| `src/agent-loop/provider-profiles.ts` | Modify | Add `openai_compatible` provider profile |
| `src/engine/session-registry.ts` | Modify | Handle new provider in session creation |
| `src/garden/transforms.ts` | Create | Transform interface and TransformRegistry |
| `src/garden/pipeline.ts` | Modify | Integrate custom transforms after built-ins |
| `src/garden/types.ts` | Modify | Export Transform-related types |
| `src/cli/commands/run.ts` | Modify | Add `--transform` flag |
| `src/cli/commands/shared.ts` | Modify | Shared transform loading logic |
| `docs/compliance-report.md` | Modify | Move GAP-2, GAP-3, GAP-5 to IMPLEMENTED |
| `test/llm/errors.test.ts` | Create | Error hierarchy tests |
| `test/llm/openai-compatible.test.ts` | Create | Adapter unit tests |
| `test/helpers/mock-chat-completions.ts` | Create | Reusable mock Chat Completions server |
| `test/garden/transforms.test.ts` | Create | Transform registry unit tests |
| `test/garden/pipeline.test.ts` | Modify | Custom transform pipeline integration |
| `test/integration/chat-completions-server.test.ts` | Create | End-to-end adapter integration |
| `test/integration/custom-transforms.test.ts` | Create | CLI `--transform` flow |

---

## Definition of Done

### Error Hierarchy (GAP-2)
- [ ] `AccessDeniedError`, `NotFoundError`, `QuotaExceededError`, `StreamError`, `AbortError`, `UnsupportedToolChoiceError`, and `NoObjectGeneratedError` are exported from `src/llm/errors.ts`
- [ ] Each new error extends `LLMError` with the correct `retryable` flag and `code` string
- [ ] 403 responses produce `AccessDeniedError` in all three existing adapters
- [ ] 404 responses produce `NotFoundError` in all three existing adapters
- [ ] `generateObject()` throws `NoObjectGeneratedError` when the model fails to produce parseable JSON
- [ ] `AbortError` replaces raw `DOMException` usage in streaming abort handling
- [ ] Retry middleware correctly skips non-retryable new error types

### OpenAI-Compatible Adapter (GAP-3)
- [ ] `src/llm/adapters/openai-compatible.ts` implements the `LLMAdapter` interface
- [ ] `Client.from_env()` registers `openai_compatible` when `OPENAI_COMPATIBLE_BASE_URL` is set
- [ ] Non-streaming text generation works against the mock Chat Completions server
- [ ] Streaming text generation produces correct `StreamEvent` sequence
- [ ] Tool calling round-trips correctly: tool definitions → model tool calls → tool results → model response
- [ ] Structured JSON output works via `response_format` passthrough (with prompt-based fallback)
- [ ] Error mapping produces the correct error type for 401, 403, 404, 429, and 500+ responses
- [ ] Rate limit `Retry-After` header is parsed and respected
- [ ] `AbortSignal` cancellation stops streaming and raises `AbortError`
- [ ] Provider options pass through to the request body
- [ ] An `openai_compatible` provider profile exists with core tools and system prompt
- [ ] Pipeline execution works end-to-end with a codergen node using the compatible adapter

### Custom Transforms (GAP-5)
- [ ] `Transform` interface and `TransformRegistry` are exported from `src/garden/transforms.ts`
- [ ] `TransformRegistry.register()` adds transforms; duplicate names throw
- [ ] Custom transforms run after built-in transforms in `transformAndValidate()`
- [ ] A failing custom transform produces a diagnostic, not a crash
- [ ] `nectar run --transform ./my-transform.ts garden.dot` loads and applies the transform
- [ ] `nectar validate --transform ./my-transform.ts garden.dot` validates with transforms applied
- [ ] Multiple `--transform` flags are supported and applied in order

### Build & Integration
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all new and existing test suites
- [ ] `bun build --compile src/cli/index.ts` produces a working binary
- [ ] `docs/compliance-report.md` shows GAP-2, GAP-3, and GAP-5 as IMPLEMENTED
- [ ] Only GAP-1 (AUDIO/DOCUMENT), GAP-4 (Gemini tools), and GAP-6 (sub-pipeline) remain as gaps

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Chat Completions endpoints vary in undocumented ways | High | Medium | Test against a strict mock server; document known provider quirks in catalog entries; error clearly on unexpected response shapes |
| Tool calling format varies between Chat Completions implementations | Medium | High | Use the current `tools` format (not legacy `functions`); validate tool call responses defensively; surface `UnsupportedToolChoiceError` when endpoint rejects tool parameters |
| Structured output is not universally supported | High | Medium | Probe-and-cache approach: try `json_schema` once, fall back to prompt-based extraction, cache the decision per endpoint |
| Some endpoints return non-standard streaming formats | Medium | Medium | Parse SSE lines defensively; skip malformed chunks with a warning rather than crashing; configurable strict mode for well-known providers |
| Custom transform modules fail to load at runtime | Medium | Low | Dynamic import in a try/catch; clear error message with the module path and load error; pipeline does not run if `--transform` flag was explicitly provided and the module fails |
| Transform registry is global mutable state | Low | Medium | `TransformRegistry.clear()` in test teardown; document that transforms are process-global. Tests using custom transforms must clean up. |
| Rate limit headers differ between compatible providers | Medium | Low | Parse both `x-ratelimit-*` and `ratelimit-*` prefixes; fall back gracefully when headers are absent |
| Scope creep into Ollama-specific features (model management, embedding) | Medium | Medium | Explicit out-of-scope. The adapter speaks Chat Completions only. Ollama management is not Nectar's job. |

---

## Dependencies

**Already shipped (no new work required):**

| Component | Sprint | Used For |
|-----------|--------|----------|
| Unified LLM client architecture | Multiple | Adapter registration, middleware, streaming |
| Provider adapters (OpenAI, Anthropic, Gemini) | Multiple | Pattern for the new adapter |
| Error hierarchy base | Multiple | Extending with new types |
| Transform pipeline | 001+ | Integration point for custom transforms |
| Model catalog | 016 | Adding compatible-provider entries |
| Agent loop provider profiles | Multiple | Adding compatible provider profile |

**No new runtime dependencies.** The adapter uses `fetch` for HTTP (same as existing adapters) and the existing SSE parser for streaming. The mock Chat Completions server for tests uses Node's built-in `http` module.

**Explicit non-dependencies:**
- No Ollama client library (we speak raw Chat Completions HTTP)
- No additional HTTP client (fetch is sufficient)
- No transform plugin framework (simple dynamic import + registry)
- No new frontend packages (this sprint is backend/library only)
