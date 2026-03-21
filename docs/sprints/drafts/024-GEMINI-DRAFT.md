# Sprint NEXT: Unified LLM Hardening & Gemini Profile Completion

## Overview

**Goal:** Close the most impactful remaining gaps in the Unified LLM Client and Agent Loop to ensure rock-solid streaming, robust error handling, and complete provider capabilities. This sprint focuses on hardening `streamObject` behavior, unifying the reasoning lifecycle events, adding granular timeout controls, and fully fleshing out the Gemini tool profile.

**Scope:** 
- Implement `REASONING_START` and `REASONING_END` event lifecycle for all streaming adapters (GAP-6).
- Implement incremental JSON parsing for `streamObject()` to yield partial parsed objects (GAP-7).
- Implement granular `TimeoutConfig` and map to adapters (GAP-8).
- Implement `QuotaExceededError` and `StreamError` to improve error recoverability (GAP-3).
- Implement Gemini-specific extended tools (`read_many_files`, `list_dir`) and update the Gemini profile (GAP-2).

**Out of scope:**
- Web UI ("The Hive") implementation.
- Audio and Document content types (GAP-1) - defer to a dedicated multimodal sprint.
- Edit file fuzzy matching (GAP-5) - defer to a dedicated tool refinement sprint.
- Named Retry Preset Policies (GAP-4) - defer to an attractor engine scheduling sprint.

---

## Use Cases

1. **Progressive UI Rendering:** A developer using `streamObject()` to generate a complex structured payload (like a pipeline DOT definition) receives valid, partially-parsed JSON objects as chunks arrive, allowing the UI to render the graph structure progressively before the stream completes.
2. **Reliable Reasoning UI:** A consumer of the event stream receives explicit `REASONING_START` and `REASONING_END` events, allowing a web client to robustly show and hide a "thinking" spinner or accordion without relying on fragile timeouts or text heuristics.
3. **Granular Timeout Recovery:** A slow model inference doesn't trigger a global timeout. The `TimeoutConfig` allows a 10s connection timeout, but a 120s request timeout, and a 30s stream read timeout, preventing zombie connections while accommodating long reasoning phases.
4. **Billing vs. Throttling Differentiation:** When an LLM provider returns a 429, the client correctly distinguishes between a transient rate limit (`RateLimitError` -> retries) and a hard billing limit (`QuotaExceededError` -> fails fast and alerts the user).
5. **Gemini Workspace Exploration:** A Gemini codergen node leverages its native `list_dir` and `read_many_files` tools to quickly orient itself in a large workspace, significantly reducing the number of tool turns compared to reading files one by one.

---

## Architecture

### Module Updates

- **`src/llm/errors.ts`:** Add `QuotaExceededError` and `StreamError`. Update `RateLimitError` logic to distinguish based on provider-specific headers or error codes (e.g., OpenAI's `insufficient_quota`).
- **`src/llm/types.ts`:** Add `TimeoutConfig` interface. Add `REASONING_START` and `REASONING_END` to `StreamEvent` union. Add `read_many_files` and `list_dir` to tool schemas.
- **`src/llm/client.ts` (`streamObject`):** Integrate an incremental JSON parser (e.g., `best-effort-json-parser` or a custom lightweight stack-based parser) to emit `{ type: 'partial', object: Partial<T> }` during streaming.
- **`src/llm/streaming.ts`:** Update the SSE stream normalizer to artificially synthesize `REASONING_START` upon the first `thinking_delta` and `REASONING_END` when thinking transitions to text or tool calls (since underlying providers like Anthropic only emit deltas).
- **`src/agent-loop/tools/`:** 
  - `read-many-files.ts`: Accept an array of file paths and return a concatenated, truncated output.
  - `list-dir.ts`: Implement recursive directory listing with depth limits and ignore patterns.
- **`src/agent-loop/provider-profiles.ts`:** Register the new tools exclusively for the Gemini profile.

### Key Abstractions

**`IncrementalJSONParser`** — A stateful utility that takes text chunks and attempts to return the deepest valid JSON parse. Since LLMs generate JSON left-to-right, it handles closing open strings, arrays, and objects to produce a valid partial AST.

**`TimeoutController`** — An internal mechanism that wraps `fetch` calls. It uses multiple `AbortController` timers to enforce `connect` (time to first byte), `request` (time to complete non-streaming response), and `stream_read` (max idle time between chunks).

---

## Implementation

### Phase 1: Error Types and Timeouts (GAP-3, GAP-8)

**Files:** `src/llm/errors.ts`, `src/llm/types.ts`, `src/llm/adapters/*.ts`

**Tasks:**
- [ ] Define `TimeoutConfig` in `types.ts` (`connect`, `request`, `stream_read`, `total`, `per_step`).
- [ ] Define `QuotaExceededError` and `StreamError` in `errors.ts`. `QuotaExceededError` must be non-retryable.
- [ ] Update `RateLimitError` detection in all 4 adapters to explicitly check for quota/billing codes and throw `QuotaExceededError` instead.
- [ ] Update `Client.generateUnified()` and `streamObject()` to respect `TimeoutConfig` using an advanced `AbortSignal` orchestration (clearing and resetting timers on stream reads).

### Phase 2: Reasoning Event Lifecycle (GAP-6)

**Files:** `src/llm/streaming.ts`, `src/llm/types.ts`, `test/llm/streaming.test.ts`

**Tasks:**
- [ ] Add `stream_reasoning_start` and `stream_reasoning_end` to the `StreamEvent` type.
- [ ] Modify `parseSSEStream()`: 
  - Maintain a state variable `is_reasoning`.
  - When the first reasoning delta arrives and `!is_reasoning`, emit `stream_reasoning_start` before the delta.
  - When a text delta or tool call arrives and `is_reasoning`, emit `stream_reasoning_end` before the new content.
  - At `stream_end`, if `is_reasoning`, emit `stream_reasoning_end`.
- [ ] Add unit tests simulating provider SSE streams to verify exact event ordering.

### Phase 3: Incremental JSON Parsing (GAP-7)

**Files:** `src/llm/client.ts`, `src/llm/incremental-json.ts`, `test/llm/incremental-json.test.ts`

**Tasks:**
- [ ] Create `src/llm/incremental-json.ts` with an `IncrementalParser` class. It should balance brackets/braces and close strings to make incomplete JSON valid for `JSON.parse()`.
- [ ] Update `streamObject()` to use the parser. Yield events with `{ type: 'partial', object: any }`.
- [ ] Ensure schema validation is bypassed or relaxed for partial objects, running full AJV validation only at `stream_end`.
- [ ] Add test coverage for incomplete strings, nested objects, and arrays.

### Phase 4: Gemini Extended Tools (GAP-2)

**Files:** `src/agent-loop/tools/list-dir.ts`, `src/agent-loop/tools/read-many-files.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/tool-registry.ts`

**Tasks:**
- [ ] Implement `list_dir` tool: accepts `path` and `max_depth`. Use `fs.readdir` recursively. Respect `.gitignore`.
- [ ] Implement `read_many_files` tool: accepts `paths` (string[]). Re-use `read-file` logic internally but concatenate results with clear file headers. Apply a combined truncation limit (e.g., 100K chars total).
- [ ] Register tools in `tool-registry.ts`.
- [ ] Update the `GeminiProfile` in `provider-profiles.ts` to include these tools in its `visibleTools` array. Ensure Anthropic and OpenAI profiles do not load them.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/types.ts` | Modify | Add `TimeoutConfig`, `stream_reasoning_start`, `stream_reasoning_end` |
| `src/llm/errors.ts` | Modify | Add `QuotaExceededError`, `StreamError` |
| `src/llm/adapters/*.ts` | Modify | Distinguish quota vs rate limit; implement timeout mechanics |
| `src/llm/streaming.ts` | Modify | Synthesize reasoning lifecycle boundaries |
| `src/llm/incremental-json.ts` | Create | Best-effort parsing of incomplete JSON strings |
| `src/llm/client.ts` | Modify | Update `streamObject` to yield partial objects |
| `src/agent-loop/tools/list-dir.ts` | Create | Gemini native directory listing tool |
| `src/agent-loop/tools/read-many-files.ts` | Create | Gemini native batch file reading tool |
| `src/agent-loop/provider-profiles.ts` | Modify | Add tools to Gemini profile |
| `src/agent-loop/tool-registry.ts` | Modify | Register new tools |
| `test/llm/streaming.test.ts` | Modify | Assert new event lifecycle |
| `test/llm/incremental-json.test.ts` | Create | Test parser with various cut-off points |

---

## Definition of Done

- [ ] `QuotaExceededError` is correctly thrown when an adapter encounters a billing error (e.g., OpenAI HTTP 429 with `insufficient_quota`).
- [ ] `TimeoutConfig` is respected: connection timeouts fail fast, while stream read timeouts only trigger if chunks stop arriving.
- [ ] SSE streams consistently emit `stream_reasoning_start` -> `thinking_delta`* -> `stream_reasoning_end` before text or tool calls.
- [ ] `streamObject()` yields partially constructed JSON objects during streaming, rather than just raw text buffers.
- [ ] `list_dir` and `read_many_files` are available when the agent session uses the Gemini profile.
- [ ] `list_dir` respects `.gitignore` and `max_depth` limits.
- [ ] `read_many_files` successfully batches reads and gracefully truncates if the combined output exceeds token budgets.
- [ ] All new code has >90% test coverage and `npm test` passes.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Custom incremental JSON parser is slow or throws | High | Medium | Use a lightweight regex-based closing approach or adopt a small proven library. Wrap in `try/catch` and gracefully fall back to returning `null` for the partial object on that tick. |
| Timeouts interfere with long reasoning blocks | Medium | High | Separate `stream_read` timeout from `request` timeout. Reasoning chunks arrive steadily, so resetting a `stream_read` timer on every chunk prevents timeouts during valid thought generation. |
| Synthesized reasoning events miss edge cases | Low | Medium | Exhaustive unit testing against captured raw SSE streams from Anthropic and Gemini APIs. |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `best-effort-json-parser` (or similar) | Optional: To handle the heavy lifting of `incremental-json.ts` if a custom implementation proves too complex. |
| `fs` / `fs/promises` (Node native) | Directory traversal for `list_dir`. |
