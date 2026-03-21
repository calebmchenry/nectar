# Sprint 020: Spec Compliance & Gemini Profile Alignment

## Overview

**Goal:** Close the final five compliance gaps (GAP-1 through GAP-5) to achieve 100% adherence to the `attractor-spec.md` and `coding-agent-loop-spec.md` standards. This sprint will unlock LLM-based fan-in evaluation, deliver the required Gemini-specific tools, enable pipeline modularity through custom transforms and sub-pipelines, and align the event taxonomy.

**Scope:** 
- Implement LLM evaluation logic in the fan-in handler when `prompt` is present (GAP-1).
- Add `read_many_files`, `list_dir`, `web_search`, and `web_fetch` to the Gemini profile and core toolset (GAP-2).
- Create a public `TransformRegistry` API for custom pipeline transforms (GAP-3).
- Implement sub-pipeline composition via graph merging at parse/transform time (GAP-4).
- Rename/alias failure events to strictly match the `PipelineFailed` and `StageFailed` spec requirements (GAP-5).

**Out of scope:**
- Web UI / Hive updates for these features (CLI and core engine only).
- Changes to OpenAI or Anthropic tool profiles.
- Modifying the existing heuristic-based fan-in logic (it remains the fallback when `prompt` is missing).

---

## Use Cases

1. **Intelligent Fan-in:** A `tripleoctagon` fan-in node is configured with `prompt="Review the implementations and select the most performant one."` Instead of relying on heuristic status ranking, the engine passes the parallel branch contexts to an LLM session to evaluate and choose the winning branch ID.

2. **Gemini Native Tools:** A `codergen` node using the `gemini` profile calls `read_many_files` to batch-read five configuration files in a single turn, minimizing LLM request overhead.

3. **Sub-pipeline Composition:** A user defines a master `deploy.dot` pipeline that includes a `build` subgraph loaded from an external `build.dot` file. The engine merges these at runtime, enabling reusable modular pipelines.

4. **Custom Transforms:** A Nectar API consumer registers a custom transform that automatically injects default `max_retries` into any node lacking the attribute before validation occurs.

5. **Spec-Compliant Observability:** External systems subscribing to the Nectar event stream successfully filter for `pipeline_failed` and `stage_failed` events rather than inferring failure from generic completion events.

---

## Architecture

### Module Layout Updates

- **`src/handlers/fan-in.ts`**: Will be expanded to inject an `AgentSession` or `UnifiedClient` call when `node.prompt` is defined, wrapping the branch context data into a synthesized evaluation prompt.
- **`src/agent-loop/tools/`**: New implementations for `read-many-files.ts`, `list-dir.ts`, `web-search.ts`, and `web-fetch.ts`. The web tools will need a basic fetch wrapper, while filesystem tools will expand on existing local execution environment utilities.
- **`src/agent-loop/provider-profiles.ts`**: Update the Gemini profile to register the new tools.
- **`src/garden/transforms.ts`**: Introduce `TransformRegistry` and `PipelineComposer` (for subgraph loading and AST merging).
- **`src/engine/events.ts`**: Update event type unions and emission points in `src/engine/engine.ts`.

### Key Abstractions

**`FanInEvaluator`** — A new class/module used by the fan-in handler. It serializes the outcomes and context of all incoming parallel branches into an LLM prompt, requests a structured output (the ID of the best branch and the rationale), and returns the selected branch to the handler.

**`SubPipelineComposer`** — A pre-validation transform that looks for nodes or subgraphs representing external pipelines (e.g., via a custom `pipeline_path` attribute) and inlines the external DOT AST into the main graph, namespacing node IDs to prevent collisions.

**`TransformRegistry`** — A singleton or engine-level registry where consumers can append functions matching the `Transform` interface (`(graph: GardenGraph) => GardenGraph`).

---

## Implementation

### Phase 1: Event Taxonomy Alignment (GAP-5) (~10%)
**Files:** `src/engine/events.ts`, `src/engine/engine.ts`, `src/cli/ui/renderer.ts`
**Tasks:**
- Introduce `PipelineFailedEvent` (type: `'pipeline_failed'`) to replace or run alongside `RunErrorEvent`.
- Introduce `StageFailedEvent` (type: `'stage_failed'`) emitted alongside `NodeCompletedEvent` when status is failure.
- Update the CLI renderer to handle the new event types gracefully.

### Phase 2: Gemini Extended Tools (GAP-2) (~30%)
**Files:** `src/agent-loop/tools/read-many-files.ts`, `src/agent-loop/tools/list-dir.ts`, `src/agent-loop/tools/web-search.ts`, `src/agent-loop/tools/web-fetch.ts`, `src/agent-loop/provider-profiles.ts`
**Tasks:**
- Implement `read_many_files` (accepts array of paths, returns concatenated/delineated content, respects truncation limits).
- Implement `list_dir` (accepts path, returns shallow or recursive directory listing, respects `.gitignore`).
- Implement `web_fetch` (simple HTTP GET to text/markdown conversion).
- Implement `web_search` (mock or via optional API key integration, returning search result snippets).
- Add tools to Gemini profile in `provider-profiles.ts`.

### Phase 3: Fan-in LLM Evaluation (GAP-1) (~35%)
**Files:** `src/handlers/fan-in.ts`, `src/engine/fan-in-evaluator.ts`, `test/handlers/fan-in.test.ts`
**Tasks:**
- Update `FanInHandler` to check for `node.prompt`.
- If `prompt` exists, gather all branch outcomes and context payloads.
- Construct a meta-prompt wrapping `node.prompt` and the branch data.
- Invoke the configured LLM using structured output (`generateObject`) to strictly return a `selected_branch_id` and `rationale`.
- Fall back to heuristic ranking if LLM evaluation fails or returns an invalid ID.

### Phase 4: Sub-pipelines & Custom Transforms (GAP-3, GAP-4) (~25%)
**Files:** `src/garden/transform-registry.ts`, `src/transforms/sub-pipeline.ts`, `src/garden/pipeline.ts`
**Tasks:**
- Create `TransformRegistry` to manage the list of active transforms.
- Refactor `transformAndValidate()` to iterate over the registry.
- Implement `SubPipelineTransform`: scans for nodes with `pipeline_path` attribute, loads the referenced DOT file, parses it, and merges its nodes/edges into the current graph (handling ID namespacing).

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/events.ts` | Modify | Add `PipelineFailedEvent` and `StageFailedEvent` |
| `src/engine/engine.ts` | Modify | Emit new failure events |
| `src/cli/ui/renderer.ts` | Modify | Render new event types |
| `src/agent-loop/tools/read-many-files.ts` | Create | Gemini batch file reader |
| `src/agent-loop/tools/list-dir.ts` | Create | Gemini directory lister |
| `src/agent-loop/tools/web-search.ts` | Create | Gemini web search tool |
| `src/agent-loop/tools/web-fetch.ts` | Create | Gemini web fetch tool |
| `src/agent-loop/provider-profiles.ts` | Modify | Register tools to Gemini profile |
| `src/engine/fan-in-evaluator.ts` | Create | LLM prompt synthesis for fan-in |
| `src/handlers/fan-in.ts` | Modify | Integrate LLM evaluator if `prompt` is set |
| `src/garden/transform-registry.ts` | Create | Custom transform registration API |
| `src/transforms/sub-pipeline.ts` | Create | Transform to inline external DOT pipelines |
| `src/garden/pipeline.ts` | Modify | Use registry and apply sub-pipeline transform |
| `test/handlers/fan-in.test.ts` | Modify | Tests for LLM-based branch selection |
| `test/garden/sub-pipeline.test.ts`| Create | Tests for graph merging and namespacing |

---

## Definition of Done

- [ ] `StageFailedEvent` and `PipelineFailedEvent` are successfully emitted on node/pipeline failure.
- [ ] Gemini profile makes `read_many_files`, `list_dir`, `web_search`, and `web_fetch` available.
- [ ] Fan-in nodes with a `prompt` attribute invoke an LLM to determine the winning branch, falling back to heuristics only on network/parse failure.
- [ ] Users can register custom transforms via a public `TransformRegistry` API.
- [ ] Sub-pipelines can be referenced from a DOT file and are successfully merged and executed.
- [ ] Unit and integration tests pass for all new modules.
- [ ] Zero GAPs remain in the compliance report for these specified features.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Fan-in LLM Context Overflow | High | High | Sub-branch context data may be large. Apply the same token-budget truncation logic used in preamble synthesis before sending to the evaluator. |
| Sub-pipeline ID Collisions | High | Medium | Implement strict namespacing (e.g., `subpipeline_id_original_node_id`) during the merge transform to prevent cross-graph conflicts. |
| Web Search Tool Dependencies | Medium | Low | Make `web_search` fallback to a simulated response or require an explicit API key (e.g., `TAVILY_API_KEY`) documented in setup. |
| Transform Order Issues | Medium | Medium | Define clear execution phases in the registry (e.g., `PRE_VALIDATION`, `POST_VALIDATION`) so sub-pipelines expand before validation runs. |

---

## Dependencies

- No new external runtime dependencies required. `web_fetch` can use the native Node `fetch` API.
