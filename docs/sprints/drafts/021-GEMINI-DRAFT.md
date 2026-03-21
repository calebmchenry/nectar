# Sprint NEXT: Final Spec Compliance

## Overview

**Goal:** Achieve 100% compliance with the `attractor-spec`, `coding-agent-loop-spec`, and `unified-llm-spec` by closing the final 8 architectural gaps identified in the compliance report. This sprint transitions the Nectar core engine and agent loop from "mostly complete" to "fully spec-compliant."

**Scope:**
- Fix tool output limit discrepancies (GAP-7).
- Implement multi-step loop detection patterns (GAP-8).
- Build the `OpenAICompatibleAdapter` for third-party LLM endpoints (GAP-3).
- Complete the Gemini provider profile with `read_many_files`, `list_dir`, `web_search`, and `web_fetch` tools (GAP-4).
- Add `AUDIO` and `DOCUMENT` content types to the unified LLM client (GAP-1).
- Flesh out the unified LLM error hierarchy (GAP-2).
- Add custom transform registration to the pipeline engine (GAP-5).
- Implement sub-pipeline composition and graph merging via transforms (GAP-6).

**Out of scope:**
- The Hive Web UI and Seedbed functionality.
- HTTP Server extensions (beyond what is required to support the new features).
- New handler types not defined in the attractor spec.

---

## Use Cases

1. **Local Model Execution:** A developer wants to run Nectar completely locally to save costs. They start an Ollama server and configure `OPENAI_BASE_URL=http://localhost:11434/v1`. Nectar automatically falls back to the `OpenAICompatibleAdapter` to call `/v1/chat/completions` seamlessly.
2. **Preventing Complex Agent Loops:** An agent gets stuck in a 3-step loop (e.g., read → grep → edit ... read → grep → edit). The engine detects this repeating ABCABC pattern within the 10-call window and aborts the loop before burning excessive tokens.
3. **Gemini Workspace Mastery:** When using the Gemini provider, the agent can now use `list_dir` to explore the project structure and `read_many_files` to ingest multiple context files in a single tool call, drastically reducing the number of turns required to understand a codebase.
4. **Pipeline Modularity:** A pipeline author defines a reusable `security-scan.dot` and embeds it into `deploy-flow.dot` using sub-pipeline composition, keeping the DOT files modular and maintainable.
5. **Robust Error Handling:** A provider returns a 403. Instead of catching a generic error, the client catches an `AccessDeniedError` and halts immediately, while a 429 correctly raises a `RateLimitError` that triggers the retry middleware.

---

## Architecture

### Module Layout Updates

```
nectar/
├── src/
│   ├── llm/
│   │   ├── types.ts              # Add AudioData, DocumentData
│   │   ├── errors.ts             # Expand LLMError subclasses
│   │   └── adapters/
│   │       └── openai-compatible.ts # New adapter for /v1/chat/completions
│   ├── agent-loop/
│   │   ├── loop-detection.ts     # Rewrite for multi-step patterns
│   │   ├── types.ts              # Adjust truncation limits
│   │   └── tools/
│   │       ├── list-dir.ts       # New tool for Gemini
│   │       ├── read-many-files.ts# New tool for Gemini
│   │       ├── web-search.ts     # New tool for Gemini
│   │       └── web-fetch.ts      # New tool for Gemini
│   └── garden/
│       ├── pipeline.ts           # Expose Transform registry
│       └── transforms/
│           ├── registry.ts       # Custom transform registration
│           └── composition.ts    # Sub-pipeline inline merging
```

### Key Abstractions

**`OpenAICompatibleAdapter`** — A new Layer 1 adapter that implements the `LLMClient` interface but targets the standard `chat/completions` API endpoint rather than the OpenAI-specific Responses API. This unlocks vLLM, Ollama, Together AI, etc.

**Multi-Step Loop Detector** — An algorithm that maintains a sliding window of 10 consecutive tool call fingerprints. It evaluates patterns of length 1, 2, and 3. If the window consists entirely of a repeating pattern (e.g., ABABAB), it triggers a loop detection event.

**Transform Registry** — A pluggable system where consumers can register a class implementing the `Transform` interface (`apply(graph) -> Graph`). The `transformAndValidate` pipeline will execute these in registration order.

**Sub-pipeline Composer** — A transform that identifies nodes designated as sub-pipelines (e.g., via a specific attribute or subgraph reference), loads the external or nested DOT definition, and merges its nodes and edges into the parent AST, correctly rewiring the entry and exit edges.

---

## Implementation

### Phase 1: LLM Client Completion (GAPs 1, 2, 3)

**Files:** `src/llm/types.ts`, `src/llm/errors.ts`, `src/llm/adapters/openai-compatible.ts`, `src/llm/client.ts`

**Tasks:**
- [ ] Add `AUDIO` (AudioData with `url`/`data`/`media_type`) and `DOCUMENT` (DocumentData with `url`/`data`/`media_type`/`file_name`) to `ContentPart` types.
- [ ] Expand the `LLMError` hierarchy to include `AccessDeniedError` (403), `NotFoundError` (404), `QuotaExceededError`, `StreamError`, `AbortError`, `UnsupportedToolChoiceError`, and `NoObjectGeneratedError`.
- [ ] Update existing OpenAI, Anthropic, and Gemini adapters to map HTTP status codes to the new error types.
- [ ] Implement `OpenAICompatibleAdapter` targeting `/v1/chat/completions`.
- [ ] Update `Client.from_env()` to fallback to `OpenAICompatibleAdapter` if an unknown `BASE_URL` is provided with an OpenAI key format.

### Phase 2: Agent Loop Polish & Gemini Tools (GAPs 4, 7, 8)

**Files:** `src/agent-loop/types.ts`, `src/agent-loop/loop-detection.ts`, `src/agent-loop/provider-profiles.ts`, `src/agent-loop/tools/list-dir.ts`, `src/agent-loop/tools/read-many-files.ts`, `src/agent-loop/tools/web-search.ts`, `src/agent-loop/tools/web-fetch.ts`

**Tasks:**
- [ ] Update default char limits in `src/agent-loop/types.ts`: glob to 20,000, edit_file to 10,000, and apply_patch to 10,000.
- [ ] Rewrite `loop-detection.ts` to implement the spec's pattern-matching algorithm: sliding window of 10, check for repeating patterns of length 1, 2, and 3.
- [ ] Implement `list_dir` tool (directory listing with depth).
- [ ] Implement `read_many_files` tool (batch file reading).
- [ ] Implement `web_search` and `web_fetch` tools.
- [ ] Register the new tools in `src/agent-loop/provider-profiles.ts` specifically for the Gemini profile.

### Phase 3: Engine Extensibility & Composition (GAPs 5, 6)

**Files:** `src/garden/pipeline.ts`, `src/garden/transforms/registry.ts`, `src/garden/transforms/composition.ts`

**Tasks:**
- [ ] Create `TransformRegistry` to allow runtime registration of custom transforms.
- [ ] Update `transformAndValidate()` to execute registered custom transforms after the built-in ones.
- [ ] Implement a `CompositionTransform` that searches for nodes marked as sub-pipelines (e.g., `type="sub_pipeline"` and `src="path/to/child.dot"`), parses the child graph, and merges its AST into the parent graph, mapping entry and exit edges appropriately.
- [ ] Add tests validating that a custom transform can mutate the graph successfully and that sub-pipelines execute correctly end-to-end.

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/llm/types.ts` | Modify | Add AUDIO and DOCUMENT content types. |
| `src/llm/errors.ts` | Modify | Add missing error classes. |
| `src/llm/adapters/*.ts` | Modify | Update status code to error type mapping. |
| `src/llm/adapters/openai-compatible.ts` | Create | New adapter for `/v1/chat/completions`. |
| `src/agent-loop/types.ts` | Modify | Update default tool output limits. |
| `src/agent-loop/loop-detection.ts` | Modify | Implement multi-step pattern detection. |
| `src/agent-loop/tools/*.ts` | Create | Add Gemini-specific tools (`list_dir`, etc.). |
| `src/agent-loop/provider-profiles.ts` | Modify | Attach new tools to Gemini profile. |
| `src/garden/transforms/registry.ts` | Create | Custom transform registration system. |
| `src/garden/transforms/composition.ts` | Create | AST merging for sub-pipelines. |
| `src/garden/pipeline.ts` | Modify | Integrate TransformRegistry and CompositionTransform. |

---

## Definition of Done

- All 8 gaps identified in the compliance report are resolved.
- `vitest` suite passes for all new modules (`loop-detection`, `openai-compatible`, composition transform).
- Sub-pipelines can be embedded via DOT attributes and execute correctly as part of a single unified graph run.
- Agent loops cleanly abort when an ABBC pattern loops repeatedly over a 10-call window.
- The `OpenAICompatibleAdapter` successfully communicates with a mock or local `/v1/chat/completions` server.
- The next compliance report run shows **0 GAPS REMAINING** for the core engine specs.

---

## Risks

- **AST Merging Complexity:** Merging DOT subgraphs requires careful ID rewriting to prevent namespace collisions and correct re-routing of edges.
- **Provider Tool Quotas:** `read_many_files` could easily blow past context limits if a user requests too many large files; the tool needs robust internal truncation and token awareness.

---

## Dependencies

- Requires the existing HTTP client infrastructure from `src/llm/client.ts`.
- The `web_search` and `web_fetch` tools may require deciding on a default external API provider (e.g., Exa, Tavily, or simply native fetch with JSDOM) as Nectar currently has no external dependencies for this. Defaulting to a simple `fetch` + `cheerio` for `web_fetch` is recommended to minimize dependencies.
