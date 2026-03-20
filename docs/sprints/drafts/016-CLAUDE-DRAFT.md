# Sprint 016: Unified LLM Client — Middleware, Model Catalog & Telemetry

## Overview

**Goal:** Close 7 of 8 remaining Unified LLM Client gaps, bringing the spec from ~85% to ~98% compliance. After this sprint, every LLM call in Nectar flows through a composable middleware chain, model selection uses a catalog instead of hardcoded strings, cache-token savings are visible for all three providers, and rate-limit data is surfaced on every response.

**Why this sprint, why now:**

- **The compliance report's two highest-priority gaps are L1 (Middleware) and L3 (Model Catalog).** These aren't checkboxes — they're extensibility multipliers. Middleware unblocks logging, cost tracking, rate limiting, and circuit breaking for every LLM call in the system without touching handler or engine code. The model catalog eliminates the growing pile of stale model ID strings hardcoded across provider profiles and codergen handlers.
- **The LLM client is shared substrate.** Codergen nodes, the coding-agent loop, future swarm analysis, and Hive DOT generation all route through `UnifiedClient`. Every gap here is a gap in every consumer. Fix it once, benefit everywhere.
- **Sprint 015 explicitly recommends this.** Fidelity, threads, and session reuse are landing. The engine has 1 medium gap remaining (A1). The LLM client is the obvious next target for spec closure.
- **Cache token reporting (L4/L5) is free money left on the table.** OpenAI and Gemini both provide prefix caching data in their API responses. We parse it for Anthropic already but silently discard it for the other two providers. These are 5-line fixes each with immediate cost-visibility value.
- **The remaining gaps (L2, L7, L8) are tiny and natural companions.** Module-level default client is ~40 lines. RateLimitInfo is header parsing. ConfigurationError is a single class. Leaving them for separate sprints creates more overhead than doing them.

**What about L6 (OpenAI-compatible adapter)?** Deliberately excluded. L6 is a brand-new adapter with significant surface area: Chat Completions request/response format, different streaming protocol (`data: [DONE]`), tool call format translation, and edge cases across Ollama/vLLM/Together/Groq. It's genuinely useful but it's additive functionality, not a gap in the existing client's correctness or observability. Bundling it here would dilute the sprint's focus from "complete and harden the existing SDK" to "complete, harden, AND extend to new protocols." L6 pairs better with A1 (manager loop) in a "new capabilities" sprint — or stands alone as a focused adapter sprint.

**Gaps closed:**

| Gap | Severity | Description |
|-----|----------|-------------|
| L1  | **High** | Middleware / interceptor pattern for cross-cutting concerns |
| L2  | Medium | Module-level default client with `set_default_client()` |
| L3  | **High** | Model catalog with metadata, capabilities, and lookup functions |
| L4  | Medium | OpenAI cache token reporting |
| L5  | Medium | Gemini cache token reporting |
| L7  | Medium | RateLimitInfo parsed from response headers |
| L8  | Low | ConfigurationError type in error hierarchy |

**Total: 2 High + 4 Medium + 1 Low = 7 gaps closed.**

**In scope:**

- Middleware chain for both `generate()` and `stream()` paths
- Retry converted from adapter-wrapping to middleware (dogfoods the pattern)
- Model catalog with `getModelInfo()`, `listModels()`, `getLatestModel()`
- Provider profiles migrated from stale concrete IDs to logical selectors
- Module-level default client with lazy initialization
- Cache token extraction for OpenAI and Gemini adapters
- RateLimitInfo parsed from all three providers' response headers
- ConfigurationError when no provider is configured
- CodergenHandler fix: stop mutating shared provider profile objects

**Out of scope:**

- L6 (OpenAI-compatible adapter) — new protocol, better as separate sprint
- A1 (Manager loop handler) — engine feature, separate sprint
- A2 (loop_restart) — engine feature
- A3 (Tool call hooks) — engine feature
- A4 (HTTP server mode) — optional per spec
- Built-in middleware implementations beyond retry (logging, cost, circuit breaker) — this sprint ships infrastructure; concrete middleware are follow-ups or user-provided
- Web UI, Seedbed, Swarm Intelligence features

**Cut-line:** If the sprint runs long, cut Phase 5 (module-level default client) first — it's the lowest-impact gap and can be a 30-minute follow-up. Do **not** cut middleware (L1) — it's the #1 priority gap in the entire project. Do **not** cut model catalog (L3) — it's #2 and required before provider profiles can stop hardcoding stale model IDs.

---

## Use Cases

1. **Request logging without touching handler code.** A developer registers a logging middleware. Every LLM call — codergen, agent loop, structured output — automatically logs provider, model, latency, and token counts. No handler or engine changes needed.

2. **Cost tracking across a pipeline run.** A cost-tracking middleware accumulates `Usage` records (including `cache_read_tokens` and `cache_write_tokens`) from every LLM response. At pipeline end, the total cost is computable. Prefix cache savings from OpenAI and Gemini are finally visible instead of hidden behind flat input-token numbers.

3. **Rate limit awareness before hitting 429s.** After each response, `RateLimitInfo` shows remaining request and token quotas. A future rate-limiting middleware can preemptively throttle before the provider starts rejecting.

4. **Model discovery for pipeline authoring.** `getLatestModel('anthropic', 'reasoning')` returns the current best reasoning model. `listModels('openai')` shows all known models with context windows. Provider profiles use logical selectors instead of dated concrete IDs that break when providers ship new versions.

5. **Retry as middleware, not magic.** Retry logic moves from an opaque adapter wrapper to a visible middleware in the chain. Users can reorder it (retry before or after logging), replace it, or remove it. The pattern proves middleware works for real cross-cutting concerns.

6. **Clear failure when unconfigured.** User runs a codergen pipeline with no API keys set. Instead of a generic error or silent simulation fallback, they get: `ConfigurationError: No LLM provider configured. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY`.

7. **Simple scripts use module-level defaults.** `import { generate } from './llm'` then `generate({ messages: [...] })` — no client construction. The default client initializes lazily from environment variables. Tests override with `setDefaultClient()`.

8. **Provider profiles stop accumulating tech debt.** `OpenAIProfile` no longer pins `gpt-4o`. It declares a logical selector. The catalog resolves it to the current concrete ID. When OpenAI ships a new model, update one catalog file — not every profile and test.

---

## Architecture

### Design Principles

1. **Middleware is the extension mechanism.** Cross-cutting concerns (retry, logging, cost tracking, rate limiting) compose as middleware. No more bolting features onto individual adapters or the client class.
2. **The catalog is static data, not a live API.** Model metadata ships in-repo as a TypeScript constant. No runtime API calls to discover models. Staleness is self-evident via `release_date`. Users who need bleeding-edge model IDs use them directly — the catalog is for discovery and validation, not enforcement.
3. **Retry is middleware, not special.** Converting retry from `withRetry(adapter)` to `createRetryMiddleware()` proves the middleware pattern handles real concerns. If middleware can't handle retry (the hardest case: streaming restart, error classification, backoff), the abstraction is wrong.
4. **Telemetry is adapter-level, not middleware-level.** Cache tokens and rate-limit headers come from raw HTTP responses. They belong in adapters. Middleware can then read and aggregate the normalized telemetry.
5. **The catalog is advisory, not a gate.** Logical selectors resolve through the catalog. Explicit unknown model IDs pass through when the provider is specified. Nectar doesn't break the day a provider ships a new model string.

### Middleware Architecture

```typescript
interface Middleware {
  name: string;
  generate?(
    request: GenerateRequest,
    next: (request: GenerateRequest) => Promise<GenerateResponse>
  ): Promise<GenerateResponse>;
  stream?(
    request: GenerateRequest,
    next: (request: GenerateRequest) => AsyncIterable<StreamEvent>
  ): AsyncIterable<StreamEvent>;
}
```

**Execution model:** Registration order for requests, implicit reverse for responses. Each middleware wraps `next()` — the response is processed after `await next(request)` returns, which naturally reverses the order.

```text
Request:  mw[0] → mw[1] → mw[2] → adapter
Response: adapter → mw[2] → mw[1] → mw[0] → caller
```

**Streaming:** Stream middleware wraps `AsyncIterable<StreamEvent>`. The simplest pattern is an async generator that yields from the inner iterable:

```typescript
async function* loggingStream(request, next) {
  const start = Date.now();
  for await (const event of next(request)) {
    yield event;
  }
  console.log(`Stream completed in ${Date.now() - start}ms`);
}
```

**Implementation:** Middleware chain is composed once at `use()` time (not rebuilt per call). The client stores the composed chain as a single function reference.

### Model Catalog

```typescript
interface ModelInfo {
  id: string;                        // "claude-sonnet-4-20250514"
  provider: string;                  // "anthropic"
  display_name: string;              // "Claude Sonnet 4"
  context_window: number;            // 200000
  max_output_tokens: number;         // 16384
  capabilities: {
    streaming: boolean;
    tool_calling: boolean;
    structured_output: boolean;
    vision: boolean;
    thinking: boolean;
  };
  cost?: {
    input_per_million: number;       // USD
    output_per_million: number;      // USD
    cache_read_per_million?: number;
  };
  aliases: string[];                 // ["claude-sonnet", "sonnet-4"]
  release_date: string;              // "2025-05-14"
  deprecated: boolean;
}
```

**Lookup functions:**

- `getModelInfo(id, provider?)` — exact match, then alias. Provider narrows search.
- `listModels(provider?)` — non-deprecated models, sorted by release_date descending.
- `getLatestModel(provider, capability?)` — most recent non-deprecated model, optionally filtered by capability.
- `resolveModelSelector(provider, selector)` — resolves logical selectors like `"default"`, `"fast"`, `"reasoning"` to concrete IDs. Throws `InvalidRequestError` if selector cannot resolve (no silent fallback).

**Opinionated rule:** If the caller passes an explicit concrete model ID that's not in the catalog, the client passes it through unchanged when `provider` is explicit. The catalog gates selectors, not explicit IDs.

### RateLimitInfo

```typescript
interface RateLimitInfo {
  requests_remaining?: number;
  requests_limit?: number;
  tokens_remaining?: number;
  tokens_limit?: number;
  reset_at?: Date;
}
```

Parsed from response headers per provider:
- **OpenAI:** `x-ratelimit-remaining-requests`, `x-ratelimit-limit-requests`, etc.
- **Anthropic:** `anthropic-ratelimit-requests-remaining`, etc.
- **Gemini:** Standard `x-ratelimit-*` when present

All fields optional. Missing headers → `undefined`, not empty object. Rate limit info is attached to `GenerateResponse.rate_limit`.

### Retry as Middleware

The existing `withRetry(adapter)` wrapper becomes `createRetryMiddleware(options)`:

```typescript
function createRetryMiddleware(options?: RetryOptions): Middleware {
  return {
    name: 'retry',
    async generate(request, next) {
      // Existing retry logic: exponential backoff, jitter, retryable error check
      // Retry-After header respected (now available via RateLimitInfo)
    },
    async *stream(request, next) {
      // Only retry before content delivery (existing behavior)
      // Once first content delta yields, errors propagate
    }
  };
}
```

The retry middleware is registered automatically by `UnifiedClient.from_env()` as the first middleware. Users who want custom retry behavior can create a client without it.

### Data Flow

```text
caller → generate(request)
           │
           ├── resolve provider + model via catalog
           │
           ├── middleware chain:
           │     retry → [user middleware] → adapter.generate()
           │                                    │
           │                                    ├── HTTP request
           │                                    ├── Parse cache tokens (L4/L5)
           │                                    ├── Parse rate-limit headers (L7)
           │                                    └── Return GenerateResponse
           │
           └── Return to caller
```

---

## Implementation Phases

### Phase 1: Types, ConfigurationError & Cache Tokens (~10%)

**Files:** `src/llm/types.ts` (modify), `src/llm/errors.ts` (modify), `src/llm/adapters/openai.ts` (modify), `src/llm/adapters/gemini.ts` (modify), `test/llm/cache-tokens.test.ts` (create), `test/llm/errors.test.ts` (modify)

The low-hanging fruit. Establishes the type surface that later phases depend on.

**Tasks:**

- [ ] Add `RateLimitInfo` interface to `src/llm/types.ts`
- [ ] Add optional `rate_limit?: RateLimitInfo` field to `GenerateResponse`
- [ ] Add `ConfigurationError` class to `src/llm/errors.ts` extending `LLMError` with `retryable: false`
- [ ] **L4:** In `OpenAIAdapter.generate()` and stream path, extract `usage.input_tokens_details.cached_tokens` → `Usage.cache_read_tokens`
- [ ] **L5:** In `GeminiAdapter.generate()` and stream path, extract `usageMetadata.cachedContentTokenCount` → `Usage.cache_read_tokens`
- [ ] Missing cache token fields gracefully produce `undefined` (not 0)
- [ ] Tests:
  - `ConfigurationError` is instance of `LLMError` with `retryable: false`
  - OpenAI adapter maps `cached_tokens` → `cache_read_tokens` in generate and stream
  - Gemini adapter maps `cachedContentTokenCount` → `cache_read_tokens` in generate and stream
  - Missing cache fields produce `undefined`

### Phase 2: RateLimitInfo Parsing (~15%)

**Files:** `src/llm/adapters/openai.ts` (modify), `src/llm/adapters/anthropic.ts` (modify), `src/llm/adapters/gemini.ts` (modify), `src/llm/rate-limit.ts` (create), `test/llm/rate-limit.test.ts` (create)

**Tasks:**

- [ ] Create `parseRateLimitHeaders(headers: Headers, prefix?: string): RateLimitInfo | undefined` in `src/llm/rate-limit.ts`
  - Standard prefix: `x-ratelimit-`
  - Anthropic prefix: `anthropic-ratelimit-`
  - Returns `undefined` if no rate-limit headers present
- [ ] In `OpenAIAdapter.generate()`: capture response headers, parse with standard prefix, attach to response
- [ ] In `AnthropicAdapter.generate()`: parse with `anthropic-ratelimit-` prefix
- [ ] In `GeminiAdapter.generate()`: parse with standard prefix
- [ ] For streaming: parse from initial HTTP response headers if accessible via fetch; otherwise `undefined`
- [ ] Handle `reset_at` from both ISO 8601 and Unix timestamp formats
- [ ] Tests:
  - Full header set → complete `RateLimitInfo`
  - Partial headers → partial info (only populated fields)
  - No headers → `undefined`
  - Anthropic-prefixed headers parsed correctly
  - `reset_at` from ISO 8601 and Unix timestamp
  - Rate limit on `GenerateResponse` after adapter call

### Phase 3: Middleware Infrastructure (~25%)

**Files:** `src/llm/middleware.ts` (create), `src/llm/client.ts` (modify), `src/llm/retry.ts` (modify), `test/llm/middleware.test.ts` (create)

The core of the sprint. Middleware must work for both unary and streaming paths, and retry must be converted to prove the pattern.

**Tasks:**

- [ ] Define `Middleware` interface in `src/llm/middleware.ts`
- [ ] Implement `composeGenerateChain(middlewares: Middleware[], terminal: GenerateFn): GenerateFn`
- [ ] Implement `composeStreamChain(middlewares: Middleware[], terminal: StreamFn): StreamFn`
- [ ] Add `use(middleware: Middleware): this` to `UnifiedClient`
- [ ] Recompose chains on each `use()` call (or defer to first request)
- [ ] Modify `UnifiedClient.generate()` to route through the composed generate chain
- [ ] Modify `UnifiedClient.stream()` to route through the composed stream chain
- [ ] Verify `generateObject()` and `streamObject()` inherit middleware (they call `generate`/`stream` internally)
- [ ] **Convert retry:** Create `createRetryMiddleware(options?: RetryOptions): Middleware`
  - Move exponential backoff, jitter, Retry-After, and retryable-error logic from `withRetry()`
  - Streaming: only retry before first content delivery (preserve existing behavior)
  - `UnifiedClient.from_env()` registers retry middleware automatically
- [ ] Deprecate `withRetry()` adapter wrapper (keep as compat shim calling the middleware internally)
- [ ] Tests:
  - Single middleware modifies request before `next()`
  - Single middleware modifies response after `next()`
  - Multi-middleware: registration-order for requests, reverse for responses
  - Streaming middleware wraps async iterable correctly (all events pass through)
  - Middleware error propagates to caller
  - Middleware with only `generate` (no `stream`) passes stream calls through
  - Middleware with only `stream` (no `generate`) passes generate calls through
  - Empty middleware list: direct passthrough
  - `use()` returns `this` for chaining
  - Retry middleware retries on retryable errors with backoff
  - Retry middleware does NOT retry non-retryable errors
  - Retry middleware respects `max_retries` config
  - Streaming retry: retries before first delta, not after
  - `generateObject()` calls flow through middleware

### Phase 4: Model Catalog (~20%)

**Files:** `src/llm/catalog.ts` (create), `src/llm/client.ts` (modify), `src/agent-loop/provider-profiles.ts` (modify), `src/handlers/codergen.ts` (modify), `test/llm/catalog.test.ts` (create)

**Tasks:**

- [ ] Define `ModelInfo` interface in `src/llm/catalog.ts`
- [ ] Populate static catalog with current models:
  - **Anthropic:** claude-opus-4-20250514, claude-sonnet-4-20250514, claude-sonnet-4-5-20250514, claude-haiku-4-5-20251001
  - **OpenAI:** o3, o3-mini, o4-mini, gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o (legacy alias)
  - **Gemini:** gemini-2.5-pro, gemini-2.5-flash
  - Include: id, provider, display_name, context_window, max_output_tokens, capabilities, cost, aliases, release_date
- [ ] Implement `getModelInfo(id: string, provider?: string): ModelInfo | undefined`
  - Exact `id` match first, then alias match
  - Provider narrows search when specified
- [ ] Implement `listModels(provider?: string): ModelInfo[]`
  - Filter by provider if given
  - Exclude deprecated, sort by release_date descending
- [ ] Implement `getLatestModel(provider: string, capability?: string): ModelInfo | undefined`
  - Most recent non-deprecated model
  - Capability filter: `'vision'`, `'tool_calling'`, `'thinking'`, `'structured_output'`
- [ ] Implement `resolveModelSelector(provider: string, selector: string): string`
  - Logical selectors: `"default"`, `"fast"`, `"reasoning"`
  - Throws `InvalidRequestError` if selector unresolvable
- [ ] Update `UnifiedClient` to resolve selector → concrete model before adapter dispatch
- [ ] **Update provider profiles:** Replace stale concrete model IDs with logical selectors
  - `OpenAIProfile`: `"default"` instead of `"gpt-4o"`
  - `AnthropicProfile`: `"default"` instead of dated Sonnet string
  - `GeminiProfile`: `"default"` instead of `"gemini-2.5-flash"` or similar
- [ ] **Fix CodergenHandler:** Stop mutating shared provider profile objects when a node sets `llm_model`. Per-node model overrides flow through session-scoped config only.
- [ ] Tests:
  - `getModelInfo('claude-sonnet-4-20250514')` → correct ModelInfo
  - `getModelInfo('sonnet-4')` → alias match
  - `getModelInfo('nonexistent')` → undefined
  - `listModels()` → all non-deprecated models
  - `listModels('anthropic')` → only Anthropic models
  - `getLatestModel('anthropic')` → most recent
  - `getLatestModel('openai', 'vision')` → most recent with vision
  - `getLatestModel('nonexistent')` → undefined
  - `resolveModelSelector('anthropic', 'default')` → concrete ID
  - `resolveModelSelector('anthropic', 'bogus')` → throws
  - Unknown explicit model ID passes through when provider is explicit
  - Every catalog entry has required fields
  - Provider profiles no longer contain stale concrete IDs
  - CodergenHandler override doesn't mutate shared profile

### Phase 5: Module-Level Default Client (~10%)

**Files:** `src/llm/client.ts` (modify), `test/llm/default-client.test.ts` (create)

**Tasks:**

- [ ] Implement `setDefaultClient(client: UnifiedClient): void`
- [ ] Implement `getDefaultClient(): UnifiedClient`
  - Returns set client, or lazily initializes from `UnifiedClient.from_env()` on first call
  - Throws `ConfigurationError` if no providers configured and no default set
- [ ] Implement `clearDefaultClient(): void` for test teardown
- [ ] Implement module-level `generate(request, opts?)` and `stream(request, opts?)` that delegate to default client
- [ ] Each helper accepts optional `{ client }` parameter to override the default
- [ ] Lazy initialization is singleton — multiple calls return same instance
- [ ] Tests:
  - `getDefaultClient()` without prior set lazily initializes
  - `setDefaultClient()` overrides the lazy default
  - Per-call client override works
  - `ConfigurationError` thrown when no providers available
  - Multiple `getDefaultClient()` calls return same instance
  - `clearDefaultClient()` resets for next test

### Phase 6: Integration, Regression & Smoke (~10% buffer)

**Files:** `test/llm/integration.test.ts` (create), existing test files (verify)

**Tasks:**

- [ ] Integration test: middleware + retry + catalog + telemetry working together in a realistic codergen-like flow
- [ ] Verify `generateObject()` and `streamObject()` carry `rate_limit` and full `usage` through to caller
- [ ] Verify existing tests pass with retry as middleware (no behavioral regression)
- [ ] Verify simulation adapter still works when explicitly requested (test-only path)
- [ ] Verify `from_env()` without any API keys throws `ConfigurationError` (not generic error)
- [ ] Run full `npm test` and fix any breakage

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/middleware.ts` | Create | `Middleware` interface, `composeGenerateChain`, `composeStreamChain` |
| `src/llm/catalog.ts` | Create | `ModelInfo`, catalog data, `getModelInfo()`, `listModels()`, `getLatestModel()`, `resolveModelSelector()` |
| `src/llm/rate-limit.ts` | Create | `parseRateLimitHeaders()` — shared header parsing utility |
| `src/llm/types.ts` | Modify | `RateLimitInfo` interface, `rate_limit` field on `GenerateResponse` |
| `src/llm/client.ts` | Modify | `use()`, middleware chain, default client lifecycle, selector resolution |
| `src/llm/errors.ts` | Modify | `ConfigurationError` class |
| `src/llm/retry.ts` | Modify | `createRetryMiddleware()`, deprecate `withRetry()` |
| `src/llm/adapters/openai.ts` | Modify | Cache token extraction, rate-limit header parsing |
| `src/llm/adapters/anthropic.ts` | Modify | Rate-limit header parsing (Anthropic-specific prefix) |
| `src/llm/adapters/gemini.ts` | Modify | Cache token extraction, rate-limit header parsing |
| `src/agent-loop/provider-profiles.ts` | Modify | Replace stale concrete model IDs with logical selectors |
| `src/handlers/codergen.ts` | Modify | Stop mutating shared profile; per-session overrides only |
| `test/llm/middleware.test.ts` | Create | Chain ordering, streaming, error propagation, retry as middleware |
| `test/llm/catalog.test.ts` | Create | Lookup, listing, latest, alias, selector resolution |
| `test/llm/cache-tokens.test.ts` | Create | OpenAI + Gemini cache token extraction |
| `test/llm/rate-limit.test.ts` | Create | Header parsing, per-provider prefixes, partial/missing headers |
| `test/llm/default-client.test.ts` | Create | Lazy init, override, per-call override, singleton, ConfigurationError |
| `test/llm/errors.test.ts` | Modify | `ConfigurationError` type assertions |
| `test/llm/integration.test.ts` | Create | End-to-end: middleware + catalog + telemetry |
| `test/agent-loop/provider-profiles.test.ts` | Modify | Logical default selectors, no stale IDs |
| `test/handlers/codergen.test.ts` | Modify | Profile mutation regression test |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing code using `UnifiedClient` without middleware works identically
- [ ] `createLLMClient()` backward compat preserved

### Middleware (L1)
- [ ] `Middleware` interface defined with optional `generate` and `stream` methods
- [ ] `UnifiedClient.use(middleware)` registers middleware
- [ ] `generate()` and `stream()` execute through middleware chain
- [ ] `generateObject()` and `streamObject()` inherit middleware automatically
- [ ] Registration order = request processing order
- [ ] Middleware without one method passes that call type through
- [ ] Middleware errors propagate to caller
- [ ] Retry converted to middleware (`createRetryMiddleware`)
- [ ] Retry middleware registered automatically by `from_env()`

### Module-Level Default Client (L2)
- [ ] `setDefaultClient()` and `getDefaultClient()` work as specified
- [ ] Module-level `generate()` and `stream()` delegate to default client
- [ ] Per-call `{ client }` override supported
- [ ] Lazy initialization is singleton

### Model Catalog (L3)
- [ ] `ModelInfo` type with all specified fields
- [ ] Catalog covers current Anthropic, OpenAI, and Gemini models
- [ ] `getModelInfo(id)` finds by exact ID or alias
- [ ] `listModels(provider?)` returns filtered, non-deprecated, sorted list
- [ ] `getLatestModel(provider, capability?)` returns most recent match
- [ ] `resolveModelSelector(provider, selector)` resolves logical selectors
- [ ] Unknown explicit model IDs pass through when provider is explicit
- [ ] Provider profiles use logical selectors, not stale concrete IDs
- [ ] CodergenHandler does not mutate shared profile objects

### Cache Token Reporting (L4, L5)
- [ ] OpenAI: `input_tokens_details.cached_tokens` → `Usage.cache_read_tokens`
- [ ] Gemini: `cachedContentTokenCount` → `Usage.cache_read_tokens`
- [ ] Both work in generate and stream paths
- [ ] Missing cache fields → `undefined`

### RateLimitInfo (L7)
- [ ] `RateLimitInfo` type with 5 optional fields
- [ ] `rate_limit` field on `GenerateResponse`
- [ ] All three adapters parse their provider's rate-limit headers
- [ ] Missing headers → `undefined`

### ConfigurationError (L8)
- [ ] `ConfigurationError` extends `LLMError` with `retryable: false`
- [ ] Thrown when no provider configured and no default set
- [ ] Distinct from `InvalidRequestError`

### Test Coverage
- [ ] At least 50 new test cases across all phases
- [ ] Middleware: ordering, streaming, errors, empty chain, `use()` chaining, retry integration
- [ ] Catalog: exact match, alias, list, filter, latest, selector resolution, deprecated, unknown
- [ ] Cache tokens: OpenAI + Gemini, generate + stream, missing fields
- [ ] Rate limit: full/partial/missing headers, per-provider prefixes, `reset_at` parsing
- [ ] Default client: lazy init, override, per-call, singleton, ConfigurationError
- [ ] Integration: middleware + retry + catalog + telemetry end-to-end

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Streaming middleware complexity** | Medium | High | Streaming middleware wraps `AsyncIterable<StreamEvent>`. Provide an async generator pattern in tests as the canonical example. Do not attempt to re-buffer or re-chunk — passthrough and inspect only. The retry middleware's "only retry before first content" rule is the hardest case; test it exhaustively. |
| **Retry-to-middleware conversion breaks existing behavior** | Medium | High | The retry middleware must reproduce existing `withRetry()` semantics exactly: same backoff curve, same error classification, same streaming-restart rules. Keep `withRetry()` as a deprecated compat shim that wraps the middleware. Run existing retry tests against both paths during migration. |
| **Model catalog stale on arrival** | High | Low | Expected. The catalog is a best-effort snapshot with `release_date` for self-evident staleness. Users who need new model IDs use them directly. The catalog helps with discovery, not enforcement. |
| **Rate limit headers differ per provider** | Medium | Low | Shared `parseRateLimitHeaders()` with configurable prefix. Missing headers → `undefined`, not errors. The feature is best-effort. |
| **Provider profile migration breaks agent loop** | Medium | Medium | Regression test: provider profile → model resolution → adapter dispatch. Logical selectors that fail resolution throw immediately (no silent fallback). Test the full codergen → agent session path with logical selectors. |
| **Default client global state causes test isolation issues** | Medium | Medium | Provide `clearDefaultClient()` for test teardown. Document in test utilities. Run existing test suite to verify no implicit global state leaks. |
| **Middleware overhead per call** | Low | Low | Middleware is plain function composition — nanoseconds versus seconds-long LLM calls. Not measurable in practice. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `UnifiedClient` base class | Extension target for middleware and default client | Implemented |
| `ProviderAdapter` interface | Existing adapters gain telemetry fields | Implemented |
| `GenerateResponse`, `Usage` types | Extended with `rate_limit`, `cache_read_tokens` | Implemented (partial — Anthropic only) |
| `LLMError` hierarchy | Extended with `ConfigurationError` | Implemented |
| `StreamEvent` types | Used by streaming middleware | Implemented |
| `withRetry()` wrapper | Converted to middleware; compat shim preserved | Implemented |
| `parseSSEStream()` | Existing streaming infrastructure | Implemented |
| Provider profiles | Migration target for logical selectors | Implemented |
| CodergenHandler | Fix shared-state mutation bug | Implemented |

**Zero new npm dependencies.** All work extends existing types, adapters, and client infrastructure. The model catalog is static TypeScript data. Header parsing uses standard `Headers` API.

---

## Gap Closure Summary

| Gap | Description | Severity | Status After Sprint |
|-----|-------------|----------|-------------------|
| L1 | Middleware / interceptor pattern | **High** | **Closed** |
| L2 | Module-level default client | Medium | **Closed** |
| L3 | Model catalog | **High** | **Closed** |
| L4 | OpenAI cache token reporting | Medium | **Closed** |
| L5 | Gemini cache token reporting | Medium | **Closed** |
| L6 | OpenAI-compatible adapter | Medium | Open (deferred) |
| L7 | RateLimitInfo on response | Medium | **Closed** |
| L8 | ConfigurationError type | Low | **Closed** |

**2 High + 4 Medium + 1 Low = 7 gaps closed.**

**After this sprint:**
- Unified LLM Client: 1 gap remaining (L6 — new adapter, additive feature)
- Coding Agent Loop: 0 gaps — already 100%
- Attractor Engine: 4 gaps remain (A1 medium, A2-A4 low/optional)
- **Total remaining gaps across all specs: 5** (down from 12)

**Recommended next sprint (017):**
- **A1 (Manager loop handler) + L6 (OpenAI-compatible adapter)** — the last medium-severity gap in the attractor engine paired with the last LLM client gap. Both are "new capabilities" (new handler type, new adapter) rather than hardening existing code. With middleware and the model catalog in place, A1's child pipeline orchestration and L6's third-party endpoints both benefit from the Sprint 016 infrastructure. This would bring all three specs to zero medium+ gaps.
