# Sprint 036: Agentic Reach and LLM Resilience

## Overview
**Goal:** Close three major high-impact gaps identified in the Nectar Compliance Report (GAP-C3, GAP-L8, GAP-L7) to improve the coding agent's ability to gather up-to-date context and fortify the unified LLM client against cascading provider failures.

**Scope:** 
- Implement `web_search` and `web_fetch` tools for the Gemini Provider Profile.
- Implement Circuit Breaker Middleware for the Unified LLM client to halt requests to overloaded providers.
- Implement top-level `metadata` support in `GenerateRequest` to standardize telemetry routing instead of burying it in provider-specific options.

**Out of scope:**
- Path migration for checkpoints (GAP-A4)
- 1:1 Prompt Mirroring (GAP-C2)
- Changes to the Anthropic or OpenAI profile toolsets.

## Use Cases
1. **Researching current documentation:** An agent needs to use an API that has changed since its training cutoff. It uses `web_search` to find the updated docs, then `web_fetch` to retrieve the content, successfully implementing the requested feature.
2. **Graceful degradation on provider failure:** An LLM provider goes down and starts returning 503 Overloaded or 500 Internal Server Error. Instead of looping infinitely with standard retry-afters, the Circuit Breaker middleware trips after 3 consecutive failures, fast-failing subsequent requests to that provider for a cooldown period (e.g., 60 seconds).
3. **Consistent request tracing:** A monitoring system injects standard `metadata: { run_id: "...", node_id: "..." }` on the `GenerateRequest`. The adapters map this top-level field to `AnthropicOptions.metadata` and equivalent mechanisms seamlessly, avoiding provider-specific plumbing.

## Architecture
- **Web Tools:** `src/agent-loop/tools/web-search.ts` and `src/agent-loop/tools/web-fetch.ts`. Because Nectar runs locally, `web_fetch` will use Node's `fetch` API. `web_search` will require an API key (e.g., Google Custom Search API) managed via the Execution Environment.
- **Circuit Breaker Middleware:** `src/llm/circuit-breaker.ts`. Implements the `Middleware` interface. It will maintain state (failures, last failure time, state: CLOSED, OPEN, HALF_OPEN) per provider. If `OPEN`, it throws a `CircuitBreakerError` immediately.
- **Top-Level Metadata:** Modify `src/llm/types.ts` to add `metadata?: Record<string, unknown>` to `GenerateRequest`. Update the Anthropic and OpenAI adapters to pick this up and map it to their native metadata representations.

## Implementation phases
### Phase 1: Top-Level Metadata (GAP-L7) (~15%)
- Update `GenerateRequest` in `src/llm/types.ts` to include `metadata?: Record<string, unknown>`.
- Update `src/llm/adapters/anthropic.ts` to merge top-level `metadata` with `provider_options.anthropic?.metadata`.
- Update `src/llm/adapters/openai.ts` and `src/llm/adapters/gemini.ts` to attach metadata where supported (or ignore if the provider doesn't support it natively, logging a debug warning).
- Add tests to ensure metadata is passed down to the request payload appropriately.

### Phase 2: Circuit Breaker Middleware (GAP-L8) (~40%)
- Create `src/llm/circuit-breaker.ts`.
- Implement a state machine per-provider:
  - `CLOSED`: Requests pass through.
  - `OPEN`: Requests are rejected instantly with `CircuitBreakerError` (extends `LLMError`).
  - `HALF_OPEN`: Allows a single test request through after the cooldown period.
- Parameters: `failureThreshold` (default 3), `cooldownPeriodMs` (default 60000).
- Integrate it by default in `UnifiedClient.from_env()`, placing it *before* the retry middleware so that it wraps the retry block. (If retry fails completely, circuit trips).
- Tests: Simulate 503 responses, ensure the breaker trips, wait (mock timers), ensure half-open succeeds and closes the breaker.

### Phase 3: Gemini Web Search & Fetch Tools (GAP-C3) (~45%)
- Define `GoogleSearchTool` and `WebFetchTool` in `src/agent-loop/tools/web-search.ts` and `src/agent-loop/tools/web-fetch.ts`.
- `web_fetch`: 
  - Takes a URL. Uses `fetch`.
  - Parses basic HTML, strips scripts/styles, converts to markdown or plain text.
  - Truncates output to `tool_output_limits`.
- `web_search`:
  - Takes a query string.
  - Expects `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` in the environment.
  - If keys are missing, the tool returns an actionable error asking the user to provide them.
- Add these tools to the Gemini provider profile in `src/agent-loop/provider-profiles.ts`.
- Ensure tool outputs gracefully handle timeouts and network errors.

## Files Summary
| File | Action | Purpose |
|------|--------|---------|
| `src/llm/types.ts` | Modify | Add `metadata` to `GenerateRequest` |
| `src/llm/adapters/anthropic.ts` | Modify | Map `metadata` to native Anthropic metadata |
| `src/llm/adapters/openai.ts` | Modify | Map `metadata` to native OpenAI metadata |
| `src/llm/circuit-breaker.ts` | Create | Circuit breaker middleware implementation |
| `src/llm/client.ts` | Modify | Add circuit breaker to default middleware chain |
| `src/agent-loop/tools/web-search.ts` | Create | Tool definition for Google Search |
| `src/agent-loop/tools/web-fetch.ts` | Create | Tool definition for HTML fetching/parsing |
| `src/agent-loop/provider-profiles.ts` | Modify | Add new tools to Gemini Profile |
| `src/llm/errors.ts` | Modify | Add `CircuitBreakerError` |
| `test/llm/circuit-breaker.test.ts` | Create | Tests for circuit breaker state transitions |
| `test/agent-loop/tools/web-search.test.ts` | Create | Tests for search and fetch tools |

## Definition of Done
- `metadata` passed to `generate()` correctly propagates to adapter request payloads.
- Circuit breaker trips after 3 consecutive `ServerError` or `RateLimitError` responses from the same provider.
- Tripped circuit breaker throws `CircuitBreakerError` immediately without making network calls.
- `web_fetch` successfully retrieves and strips a given URL.
- `web_search` successfully performs a search given proper API keys, or returns a helpful missing-key message to the LLM.
- `npm test` passes with full coverage on the new files.

## Risks & Mitigations
- **Risk:** `web_fetch` hangs indefinitely or pulls down a massive file.
  - **Mitigation:** Use an explicit `AbortSignal` with a strict 15s timeout. Check `Content-Length` headers before downloading, and cap reading at 1MB.
- **Risk:** Circuit breaker trips too eagerly during normal rate limiting.
  - **Mitigation:** Ensure `RateLimitError` with explicit `Retry-After` headers are handled by the Retry middleware first. The circuit breaker should only see the failure if the retry middleware exhausts all attempts.

## Security Considerations
- `web_fetch` performs Server-Side Request Forgery (SSRF) by design. Since Nectar runs locally on the user's machine, it's a client-side fetch, but we should restrict fetches to `http:` and `https:` protocols and explicitly block `file:`, `ftp:`, and local IP ranges (127.0.0.0/8, 169.254.0.0/16, etc.) to prevent local network reconnaissance by an adversarial LLM.
- Search API keys must be loaded from the environment and never logged in debugging output.

## Dependencies
- Native `fetch` API (Node 22 built-in).
- Standard regex or lightweight DOM parser (e.g., `cheerio`) for stripping HTML. (Prefer zero-dependency DOM parsing or robust regex for v1 to minimize bloat).
