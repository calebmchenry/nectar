# Sprint 022: Extensibility, Composition & Local Models

## Overview

**Goal:** Deliver full support for third-party local LLMs via an OpenAI-Compatible adapter (GAP-3), introduce a custom transform registration API (GAP-5), and implement sub-pipeline composition (GAP-6). This sprint resolves the most critical remaining extensibility and modularity gaps in the Nectar engine, allowing users to run complex, multi-file workflows using any local or cloud model that supports the standard chat completions API.

**Scope:**
- **OpenAI-Compatible Adapter:** A new Layer 1 adapter for the unified LLM client that targets `/v1/chat/completions` (supporting vLLM, Ollama, Together AI, Groq, etc.).
- **Transform Registration API:** Refactoring `src/garden/pipeline.ts` to support injecting custom `Transform` implementations.
- **Sub-Pipeline Composition:** A built-in transform that resolves sub-pipeline nodes (e.g., a node referencing another `.dot` file) by parsing, namespacing, and merging the child graph into the parent AST before validation.

**Out of scope:**
- AUDIO and DOCUMENT content types (GAP-1)
- Comprehensive LLM error hierarchy subtyping (GAP-2)
- Gemini Profile extended native tools (GAP-4)
- Dynamic graph execution (where the graph mutates *during* runtime; we only mutate the AST during the transform phase).

---

## Use Cases

1. **Local LLM Execution:** A developer wants to run a pipeline using Ollama or vLLM to avoid cloud costs and API limits. They set `OPENAI_COMPATIBLE_BASE_URL="http://localhost:11434/v1"` and use the `openai-compatible` provider in their `.nectar/models.css`. The pipeline executes normally.
2. **Modular DOT Files:** A pipeline author splits a massive 100-node graph into reusable components (e.g., `test-loop.dot`, `review-phase.dot`). In `main.dot`, they define a node `test_phase [type="subpipeline" src="test-loop.dot"]`. At parse time, Nectar seamlessly merges them into a single executable `GardenGraph`.
3. **Custom Transforms:** A developer building a custom tool on top of Nectar registers a `SecurityTransform` that automatically injects a "security audit" node before any deployment node in the graph.

---

## Architecture

### OpenAI-Compatible Adapter
- **Location:** `src/llm/adapters/openai-compatible.ts`
- **Design:** Implements the `ProviderAdapter` interface. Unlike the existing OpenAI adapter which uses the newer `/v1/responses` API, this adapter will map Nectar's unified `GenerateRequest` to the standard `/v1/chat/completions` payload.
- **Streaming:** Will parse standard SSE chunks (`data: {...}`) commonly emitted by OpenAI-compatible endpoints.

### Transform Registration API
- **Location:** `src/garden/pipeline.ts` and `src/transforms/registry.ts`
- **Design:** Define a `Transform` interface: `apply(graph: GardenGraph, context: TransformContext): Promise<GardenGraph>`.
- **Registry:** `PipelineEngine` and `transformAndValidate()` will accept an optional `TransformRegistry` or array of custom transforms. Built-in transforms (goal expansion, stylesheet, sub-pipeline) will be applied first, followed by user-registered transforms.

### Sub-pipeline Composition
- **Location:** `src/transforms/subpipeline-composition.ts`
- **Design:** A built-in transform that iterates through all nodes. If a node has `type="subpipeline"` and a `src` attribute (e.g., `src="child.dot"`):
  1. Parse `child.dot` into an AST.
  2. Namespace all node IDs in the child graph (e.g., `child_node_id` -> `parent_node_id::child_node_id`) to prevent collisions.
  3. Re-wire incoming edges targeting the parent node to point to the child's `Mdiamond` (start) node.
  4. Re-wire outgoing edges originating from the parent node to originate from the child's `Msquare` (exit) node.
  5. Remove the parent node and the child's start/exit nodes.

---

## Implementation Phases

### Phase 1: Custom Transform API (GAP-5) (~15%)
**Tasks:**
- [ ] Define the `Transform` interface in `src/transforms/types.ts`.
- [ ] Implement a `TransformRegistry` with `register(name, transform)` and `applyAll(graph)` methods.
- [ ] Refactor `src/garden/pipeline.ts` (`transformAndValidate`) to utilize the registry rather than hardcoding the transform sequence.
- [ ] Ensure existing built-in transforms (Goal Expansion, Stylesheet Apply) adhere to the new `Transform` interface and are registered by default.

### Phase 2: Sub-Pipeline Composition Transform (GAP-6) (~40%)
**Tasks:**
- [ ] Create `src/transforms/subpipeline-composition.ts`.
- [ ] Implement logic to detect `type="subpipeline"` nodes and extract the `src` attribute.
- [ ] Implement recursive parsing of the referenced `src` DOT file (with circular dependency detection to prevent infinite loops).
- [ ] Implement AST merging: namespace child node IDs, remap child edges, and splice the child graph into the parent graph's entry and exit points.
- [ ] Register `SubPipelineTransform` in the default transform sequence (must run *before* validation).
- [ ] Write unit tests verifying deep merging, collision prevention, and circular dependency errors.

### Phase 3: OpenAI-Compatible Adapter (GAP-3) (~30%)
**Tasks:**
- [ ] Create `src/llm/adapters/openai-compatible.ts`.
- [ ] Implement the `generate()` method mapping unified `Message` and `Tool` arrays to the `/v1/chat/completions` format.
- [ ] Implement the `stream()` method with SSE parsing optimized for standard chat completion chunks.
- [ ] Register the adapter in `src/llm/client.ts` (`Client.from_env()`) handling `OPENAI_COMPATIBLE_API_KEY` and `OPENAI_COMPATIBLE_BASE_URL`.
- [ ] Implement error handling mapping standard HTTP status codes (400, 401, 429) to the unified `LLMError` hierarchy.

### Phase 4: Integration & Validation (~15%)
**Tasks:**
- [ ] Create a complex fixture `gardens/modular-test/` with a parent and multiple nested sub-pipelines.
- [ ] Update `nectar validate` and `nectar run` tests to ensure seamless execution of composed graphs.
- [ ] Write an integration test utilizing a mock local LLM endpoint to verify the OpenAI-Compatible adapter handles tool calls and streaming correctly.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/transforms/types.ts` | Modify | Define `Transform` interface |
| `src/transforms/registry.ts` | Create | Manage transform registration and ordering |
| `src/garden/pipeline.ts` | Modify | Hook up the TransformRegistry |
| `src/transforms/subpipeline-composition.ts` | Create | Splice child DOT graphs into parent graphs |
| `src/llm/adapters/openai-compatible.ts` | Create | `/v1/chat/completions` adapter implementation |
| `src/llm/client.ts` | Modify | Expose the new adapter via ENV instantiation |
| `test/transforms/subpipeline.test.ts` | Create | Unit tests for graph splicing and circular refs |
| `test/llm/openai-compatible.test.ts` | Create | Unit tests for standard completions API payload mapping |
| `test/integration/modular-pipelines.test.ts` | Create | E2E test for running a composed graph |

---

## Definition of Done

- [ ] A pipeline with `type="subpipeline"` nodes is correctly expanded at parse time.
- [ ] Node ID collisions between parent and child pipelines are automatically resolved via namespacing.
- [ ] Circular sub-pipeline references throw a clear validation error during the transform phase.
- [ ] Custom `Transform` classes can be passed into `transformAndValidate()` programmatic calls.
- [ ] `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY` correctly route to the new adapter.
- [ ] The OpenAI-Compatible adapter successfully translates unified tool calls and streams standard `/v1/chat/completions` SSE events.
- [ ] `npm test` passes all new unit and integration tests.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Circular dependencies in sub-pipelines | High | High (Infinite Loop) | Track visited file paths in `TransformContext` during parsing and explicitly throw an error if a cycle is detected. |
| AST Edge Rewiring introduces dangling edges | Medium | High | Rely on the existing `validate.ts` reachability and target-existence rules which run *after* transforms to catch graph malformations. |
| Third-party API quirks | High | Medium | The OpenAI-Compatible adapter will strictly adhere to the documented standard. We will not support proprietary extensions of minor providers in this core adapter. |

---

## Dependencies

- No new external runtime dependencies.
- `vitest` for mocking the OpenAI-compatible HTTP server during integration testing.
