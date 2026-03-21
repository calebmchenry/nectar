# Sprint 022: Modular Gardens, Local LLMs & Pipeline Extensibility — Closing GAP-3, GAP-5, and GAP-6

## Overview

**Goal:** Ship sub-pipeline composition so gardens can be split across reusable files, a first-class transform registration API for pipeline extensibility, and an OpenAI Chat Completions adapter that unlocks local and third-party LLM endpoints (Ollama, vLLM, Together AI, Groq). After this sprint, Nectar supports modular multi-file workflows, user-defined graph transforms, and any Chat Completions-compatible model — the three most impactful remaining gaps.

**Why this sprint, why now:**

1. **Single-file graphs are the biggest remaining orchestrator ceiling.** `docs/INTENT.md` positions Nectar as a serious workflow engine. That promise breaks down when every reusable plan/implement/test/review loop must live in one DOT file. Sub-pipeline composition (GAP-6) unblocks modular authoring.

2. **GAP-5 and GAP-6 are one unit of work.** A custom transform API without a real first-party transform is architecture theater. Graph composition without ordered transforms becomes a one-off hack with no extension story. Shipping them together means the API is immediately proven.

3. **GAP-3 is the highest-impact LLM gap.** Every developer who runs Ollama locally, every team with a vLLM deployment, every user of Together AI or Groq — none of them can use Nectar's LLM features today. The Chat Completions ecosystem (`/v1/chat/completions`) is the de facto standard for local and third-party LLM hosting.

4. **Sprint 021 completed the product surface.** All three pillars — pipeline engine, CLI, and Hive with Seedbed/Swarm — are functional. The explicit deferral note in Sprint 021 says the remaining compliance gaps belong in a dedicated sprint after the product surface is complete. This is that sprint.

5. **The remaining gaps (1, 2, 4) are deliberately deferred.** GAP-1 (AUDIO/DOCUMENT content types) supports future modalities no provider fully offers today. GAP-2 (error subtypes) is mechanical and low-risk. GAP-4 (Gemini extended tools) is explicitly optional in the spec.

**Gaps closed:**

| Gap | Spec | Effort | Impact |
|-----|------|--------|--------|
| GAP-5: Custom Transform Registration | attractor-spec §9.3 | Medium | Pipeline authors can register graph rewriting logic |
| GAP-6: Sub-pipeline Composition | attractor-spec §9.4 | Large | Reusable child gardens, modular multi-file workflows |
| GAP-3: OpenAI-Compatible Adapter | unified-llm-spec §7.10 | Large | Unlocks Ollama, vLLM, Together AI, Groq, and any Chat Completions endpoint |

**In scope:**

- Async `PipelinePreparer` API with instance-scoped transform registration
- `Transform` interface and ordered registration (built-ins first, then custom)
- Built-in composition transform using `"compose.dotfile"` on placeholder nodes
- Recursive child loading with workspace path safety and import-cycle detection
- Deterministic namespacing of imported nodes, edges, and subgraphs
- Prepared DOT serialization and prepared-graph hashing for resume safety
- Provenance metadata so diagnostics point at child files, not only the parent
- `OpenAICompatibleAdapter` for Chat Completions API (`/v1/chat/completions`)
- Streaming, tool calling, structured output, and error mapping for Chat Completions
- Configuration via `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`
- Integration tests against mock Chat Completions server and composed garden fixtures

**Out of scope:**

- GAP-1: AUDIO/DOCUMENT content types (future modality)
- GAP-2: Missing error subtypes (mechanical, deferred to next sprint)
- GAP-4: Gemini extended tools — optional per spec
- Dynamic graph mutation during runtime (composition is parse-time only)
- Remote imports, absolute-path imports, or cross-workspace composition
- Inline editing of imported child internals from the Hive UI
- Parameterized composition, graph macros, or parent override maps
- Ollama-specific features beyond Chat Completions (model pulling, embedding API)
- CLI `--transform` flag (programmatic API only in v1; CLI flag is a follow-up)
- Web UI changes for composition (this sprint is engine/library focused)

**Cut line:** If time compresses, cut model catalog entries for well-known providers and sample garden polish. Do **not** cut the ordered transform API, prepared-graph hashing, composition, or the Chat Completions adapter core. These are the load-bearing deliverables.

---

## Use Cases

1. **Reuse a review loop in multiple gardens.** A parent garden contains a placeholder node:

   ```dot
   review_loop [
     shape=component
     label="Review Loop"
     "compose.dotfile"="gardens/lib/review-loop.dot"
   ]
   ```

   Preparation replaces that placeholder with the child graph, namespaces imported nodes as `review_loop__plan`, `review_loop__critique`, `review_loop__merge`, and rewires parent edges automatically.

2. **Validate a modular garden from the CLI.** `nectar validate gardens/release.dot` resolves child imports, reports missing-file and cycle errors against the real child path, and fails before any execution starts.

3. **Run a composed garden end-to-end.** `nectar run gardens/release.dot` executes the fully prepared graph. The engine remains oblivious to the fact that some nodes came from child files.

4. **Resume safely after a child change.** The user edits `gardens/lib/review-loop.dot`. If the semantic prepared graph changes, `nectar resume <run-id>` fails with a prepared-graph hash mismatch. Whitespace-only or comment-only changes are ignored.

5. **Register a custom transform.** An embedder creates a `PipelinePreparer`, registers a custom transform, and gets a prepared graph where built-ins run first, composition runs next, and the custom transform runs last before validation.

6. **Use Ollama locally.** User sets `OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1` and `OPENAI_COMPATIBLE_API_KEY=ollama`. Pipeline runs use `llm_provider="openai_compatible"` in their model stylesheet. Codergen nodes execute against the local Ollama instance.

7. **Use a team vLLM deployment.** A team runs vLLM serving Llama 3 behind an internal endpoint. They configure the base URL and API key. Nectar's unified client routes requests through the Chat Completions adapter transparently — retry, middleware, streaming, tool calling all work.

8. **Mix providers in one pipeline.** A model stylesheet assigns `openai_compatible` to codergen nodes and `anthropic` to fan-in evaluation nodes. The same pipeline uses local Ollama for drafting and Claude for critical evaluation.

9. **Fail early on unsafe imports.** A child import resolves outside the workspace, refers to a missing file, or creates an import cycle. Nectar returns deterministic diagnostics immediately; no partial run directory is created.

---

## Architecture

### Design Principles

1. **The prepared graph is the source of truth.** Parsing produces an intermediate graph. Validation, preview, rendering, execution, and resume operate on the prepared graph.

2. **Composition is a transform, not a handler.** The runtime engine should not care whether a graph came from one file or ten.

3. **All production paths prepare through one API.** No side door that parses and validates directly.

4. **Custom transforms are instance-scoped.** No process-global registry. Tests, embedders, and future multi-workspace servers need isolation.

5. **Hash semantics, not raw text.** Resume safety keys off the normalized prepared graph. Child comments and formatting do not invalidate a run.

### Preparation Pipeline

The current `transformAndValidate()` helper becomes an async preparation pipeline:

```text
parse root graph
  -> built-in transforms:
       1. goal expansion
       2. stylesheet application
       3. child-garden composition
  -> custom transforms (registration order)
  -> validation
  -> normalized prepared DOT serialization
  -> prepared-graph hash
```

Public result:

```ts
interface PreparedGardenResult {
  graph: GardenGraph;
  diagnostics: Diagnostic[];
  prepared_dot: string;
  graph_hash: string;
  source_files: string[];
}
```

Opinionated rule: **custom transforms run after composition.** A consumer's transform should operate on the same graph that validation, preview, and execution will see.

### Transform API

The API is programmatic and instance-scoped:

```ts
const preparer = new PipelinePreparer({ workspaceRoot });
preparer.registerTransform(new InjectAuditNodesTransform());
const result = await preparer.prepareFromPath("gardens/release.dot");
```

Core contracts:

```ts
interface Transform {
  readonly name: string;
  apply(graph: GardenGraph, context: TransformContext): Promise<TransformResult> | TransformResult;
}

interface TransformContext {
  readonly workspaceRoot: string;
  readonly currentDotPath: string;
  readonly importStack: string[];
  readonly sourceFiles: Set<string>;
  parseFile(dotPath: string): Promise<GardenGraph>;
}
```

The preparer owns built-ins internally and appends custom transforms after them in registration order.

### Composition Contract

Any node with `"compose.dotfile"` is treated as a composition placeholder. Optional `"compose.prefix"` overrides the default namespace prefix; otherwise the placeholder node ID is used.

Composition semantics:

1. Resolve the child path relative to the current DOT file.
2. Reject any path that escapes the workspace root.
3. Track an import stack and fail deterministically on cycles.
4. Prepare the child graph recursively (built-ins + composition only; custom transforms deferred to the fully merged parent).
5. Require exactly one child start node and one child exit node.
6. Namespace every imported node ID, edge endpoint, and subgraph ID as `<prefix>__<child_id>`.
7. Rewire parent incoming edges to the namespaced child start node.
8. Rewire parent outgoing edges from the namespaced child exit node.
9. Remove the placeholder node from the prepared graph.

### Child Graph Boundary Rules

Safe child graph settings are materialized onto imported nodes before merge:

- `default_max_retries`, `default_fidelity`
- `tool_hooks.pre`, `tool_hooks.post`
- `goal` (after child-local expansion)
- `model_stylesheet` (after child-local application)

Rejected in v1 composition (with explicit diagnostics):

- `stack.child_dotfile`, `stack.child_workdir`, `max_restart_depth`

These are graph-global runtime controls. Explicit rejection is safer than inventing half-correct merge semantics.

### Provenance and Diagnostics

Imported nodes and edges carry origin metadata: source DOT path, original node/edge identifier, and original line/column when known. This lets a validation error inside `gardens/lib/review-loop.dot` surface against the child file.

### Prepared DOT and Hashing

- `serializeGardenGraph()` emits normalized DOT with stable node and edge ordering
- Excludes comments, whitespace, and provenance-only metadata from normalized output
- `graph_hash = sha256(prepared_dot)`
- Persist `prepared.dot` and `source-manifest.json` under each run directory
- Record `graph_hash_kind: "prepared"` on new runs; legacy runs remain distinguishable
- `/pipelines/:id/graph` renders `prepared.dot`
- Resume compares the prepared-graph hash and fails on semantic changes

### OpenAI-Compatible Adapter

A new adapter targeting the `/v1/chat/completions` endpoint — the de facto standard for third-party and local LLM hosting. This is distinct from the existing OpenAI Responses API adapter.

**Key decisions:**

1. **Separate adapter, not a mode flag.** The Responses API and Chat Completions API have different request/response shapes, streaming formats, and tool calling conventions. A clean adapter is simpler and more testable.

2. **Provider name: `openai_compatible`.** Registered alongside `openai`, `anthropic`, and `gemini`. Configured via `OPENAI_COMPATIBLE_*` environment variables.

3. **Chat Completions message format.** Translates between unified `Message` model and Chat Completions roles (`system`, `user`, `assistant` with `tool_calls`, `tool`).

4. **Streaming.** Parses `data: {"choices": [{"delta": {...}}]}` SSE lines, handles `[DONE]` sentinel, partial JSON deltas, and tool call argument streaming.

5. **Tool calling.** Uses the `tools` format with `type: "function"`. Tool results come back as `tool` role messages. The unified `ToolDefinition` maps directly.

6. **Structured output.** Where the endpoint supports `response_format: { type: "json_schema" }`, pass through. Otherwise fall back to prompt-based JSON extraction.

7. **No automatic provider detection.** Users explicitly configure the endpoint. The adapter is stateless and predictable.

### Module Layout

```text
src/
├── garden/
│   ├── preparer.ts                  # PipelinePreparer and async prepare helpers
│   ├── pipeline.ts                  # Thin compatibility facade
│   ├── serialize.ts                 # GardenGraph -> normalized DOT
│   └── types.ts                     # Provenance metadata on nodes/edges
├── transforms/
│   ├── types.ts                     # Transform and TransformContext contracts
│   ├── registry.ts                  # Ordered instance-scoped registration
│   ├── goal-expansion.ts            # Built-in transform (adapt existing)
│   ├── stylesheet-apply.ts          # Built-in transform (adapt existing)
│   └── compose-imports.ts           # Recursive child-garden merge
├── llm/
│   ├── adapters/
│   │   └── openai-compatible.ts     # Chat Completions adapter
│   ├── client.ts                    # Register openai_compatible provider
│   ├── catalog.ts                   # Compatible-provider model entries
│   └── streaming.ts                 # Chat Completions SSE parsing
├── runtime/
│   ├── pipeline-service.ts          # Prepare/hash/execute prepared graphs
│   └── garden-preview-service.ts    # Preview prepared graphs
├── server/
│   ├── run-manager.ts               # Persist prepared.dot and manifests
│   ├── graph-renderer.ts            # Render prepared DOT
│   └── routes/
│       ├── gardens.ts
│       └── pipelines.ts
└── checkpoint/
    ├── types.ts                     # Prepared-hash metadata
    └── run-store.ts                 # Persist prepared graph artifacts

test/
├── transforms/
│   ├── preparer.test.ts             # Transform ordering and isolation
│   └── compose-imports.test.ts      # Graph merge and diagnostics
├── llm/
│   └── openai-compatible.test.ts    # Adapter unit tests
├── fixtures/composed/*.dot          # Parent/child success and failure cases
├── helpers/
│   └── mock-chat-completions.ts     # Reusable mock server
├── integration/
│   ├── composed-run.test.ts         # Execute composed gardens
│   ├── composed-resume.test.ts      # Resume mismatch coverage
│   └── chat-completions-server.test.ts  # Mock server end-to-end
└── server/
    └── gardens-preview.test.ts      # Preview prepared/composed graphs
```

---

## Implementation

### Phase 1: Preparation API and Ordered Transform Registry — GAP-5 (~20%)

**Files:** `src/garden/preparer.ts`, `src/garden/pipeline.ts`, `src/transforms/types.ts`, `src/transforms/registry.ts`, `src/transforms/goal-expansion.ts`, `src/transforms/stylesheet-apply.ts`, `src/runtime/pipeline-service.ts`, `test/transforms/preparer.test.ts`

**Tasks:**

- [ ] Define `Transform` interface with `name` and async-compatible `apply()` in `src/transforms/types.ts`
- [ ] Define `TransformContext` with workspace root, current DOT path, import stack, source file tracking, and `parseFile()` helper
- [ ] Create `TransformRegistry` in `src/transforms/registry.ts` — instance-scoped, ordered, with `register()`, `unregister()`, `getAll()`, and `clear()`
- [ ] Introduce `PipelinePreparer` in `src/garden/preparer.ts` with `prepareFromPath()` and `prepareFromSource()` async entrypoints
- [ ] Wrap existing goal expansion and stylesheet logic in the new `Transform` contract
- [ ] Return `PreparedGardenResult` with `graph`, `diagnostics`, `prepared_dot`, `graph_hash`, and `source_files`
- [ ] Replace production uses of `transformAndValidate()` with the async preparation API
- [ ] Keep `src/garden/pipeline.ts` only as a thin facade or compatibility export
- [ ] Add tests proving built-ins run before custom transforms in registration order
- [ ] Add tests proving two preparer instances do not share transform state

### Phase 2: Built-In Composition Transform — GAP-6 (~30%)

**Files:** `src/transforms/compose-imports.ts`, `src/garden/types.ts`, `src/garden/validate.ts`, `src/garden/serialize.ts`, `test/transforms/compose-imports.test.ts`, `test/fixtures/composed/*.dot`

**Tasks:**

- [ ] Create `src/transforms/compose-imports.ts` implementing the composition transform
- [ ] Detect placeholder nodes via `"compose.dotfile"` and optional `"compose.prefix"`
- [ ] Resolve child paths relative to the current DOT file; reject workspace escapes
- [ ] Track import depth and import stack; fail deterministically on recursive cycles
- [ ] Prepare child graphs recursively (built-ins + composition only) before merge
- [ ] Require exactly one child start node and one child exit node
- [ ] Namespace imported node IDs, edge endpoints, and subgraph IDs as `<prefix>__<id>`
- [ ] Rewire parent incoming edges to child start; outgoing edges from child exit
- [ ] Materialize safe child graph defaults onto imported nodes before merge
- [ ] Reject unsupported child graph globals (`stack.child_dotfile`, `stack.child_workdir`, `max_restart_depth`) with explicit diagnostics
- [ ] Preserve provenance metadata for imported nodes and edges
- [ ] Add `serializeGardenGraph()` for normalized DOT serialization with stable ordering
- [ ] Compute `graph_hash` as `sha256(prepared_dot)`
- [ ] Add fixtures: success, nested composition, missing file, outside-workspace path, duplicate prefix collision, import cycle

### Phase 3: Runtime and Server Integration (~15%)

**Files:** `src/runtime/pipeline-service.ts`, `src/server/run-manager.ts`, `src/server/routes/pipelines.ts`, `src/server/graph-renderer.ts`, `src/runtime/garden-preview-service.ts`, `src/checkpoint/types.ts`, `src/checkpoint/run-store.ts`, `test/integration/composed-run.test.ts`, `test/integration/composed-resume.test.ts`, `test/server/gardens-preview.test.ts`

**Tasks:**

- [ ] Make `PipelineService` pass prepared graphs into execution
- [ ] Persist `prepared.dot` and `source-manifest.json` under each run directory
- [ ] Record `graph_hash_kind: "prepared"` in run metadata; legacy runs remain readable
- [ ] Make `/pipelines/:id/graph` render `prepared.dot` instead of raw source
- [ ] Make preview return prepared node and edge counts when composition is present
- [ ] Make resume compare prepared-graph hash; fail on semantic child changes
- [ ] Add integration test: execute a composed garden end-to-end through runtime
- [ ] Add integration test: resume rejects semantic child changes, accepts whitespace-only edits
- [ ] Verify non-composed gardens continue to work without regression

### Phase 4: OpenAI-Compatible Adapter Core — GAP-3 (~25%)

**Files:** `src/llm/adapters/openai-compatible.ts`, `src/llm/client.ts`, `src/llm/catalog.ts`, `src/llm/streaming.ts`, `test/llm/openai-compatible.test.ts`, `test/helpers/mock-chat-completions.ts`, `test/integration/chat-completions-server.test.ts`

**Tasks:**

- [ ] Create `src/llm/adapters/openai-compatible.ts` implementing the `LLMAdapter` interface
- [ ] Implement request translation: unified `GenerateRequest` → Chat Completions request body
  - [ ] Map `Message` roles to Chat Completions roles (`system`, `user`, `assistant`, `tool`)
  - [ ] Translate `ContentPart` arrays to Chat Completions `content` format
  - [ ] Map unified `ToolDefinition` to Chat Completions `tools` with `type: "function"`
  - [ ] Translate `ToolChoice` (`auto`, `none`, `required`, `named`) to Chat Completions format
  - [ ] Pass `max_tokens`, `temperature`, `top_p`, `stop` directly
  - [ ] Forward `provider_options.openai_compatible` as additional request body fields
- [ ] Implement response translation: Chat Completions response → unified `GenerateResponse`
  - [ ] Extract `choices[0].message` content and tool calls
  - [ ] Map `finish_reason` to unified `StopReason`
  - [ ] Parse `usage` into unified `Usage` model
- [ ] Implement streaming: Chat Completions SSE → unified `StreamEvent`s
  - [ ] Parse `data: {...}` lines with `choices[0].delta` incremental format
  - [ ] Handle content text deltas, tool call argument deltas, `[DONE]` sentinel
  - [ ] Translate stream errors to appropriate error types
- [ ] Implement error mapping: 401→`AuthenticationError`, 403→`AccessDeniedError`, 404→`NotFoundError`, 429→`RateLimitError`, 500+→`OverloadedError`
- [ ] Implement structured output passthrough with prompt-based fallback
- [ ] Register `openai_compatible` provider in `Client.from_env()` from `OPENAI_COMPATIBLE_*` env vars
- [ ] Add model catalog entries for well-known compatible providers (Ollama, Together, Groq)
- [ ] Create `test/helpers/mock-chat-completions.ts`: lightweight HTTP server for testing
- [ ] Write adapter unit tests: text generation, streaming, tool calling, structured output, error mapping, abort handling
- [ ] Add integration test: end-to-end pipeline with codergen node using the compatible adapter

### Phase 5: Regression Sweep and QA (~10%)

**Files:** `test/integration/http-server.test.ts`, `test/garden/validate.test.ts`, `.nectar/gardens/modular-release.dot`, `.nectar/gardens/lib/review-loop.dot`

**Tasks:**

- [ ] Add a sample garden that composes at least one reusable child module
- [ ] Verify `nectar validate` succeeds on the sample and errors cleanly on broken imports
- [ ] Verify `nectar run` executes the sample composed garden end-to-end
- [ ] Verify HTTP preview and rendered run graphs show namespaced imported nodes
- [ ] Verify non-composed gardens still validate and run without behavior changes
- [ ] Verify whitespace-only and comment-only child edits do not change the prepared hash
- [ ] Run full test suite and verify zero regressions
- [ ] Verify `npm run build` succeeds
- [ ] Verify `bun build --compile` produces a working binary

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/preparer.ts` | Create | Async `PipelinePreparer` and preparation result contract |
| `src/garden/pipeline.ts` | Modify | Replace hard-coded helper with thin facade over preparer |
| `src/garden/serialize.ts` | Create | Normalize `GardenGraph` into stable DOT for hashing |
| `src/garden/types.ts` | Modify | Add provenance metadata for imported nodes and edges |
| `src/transforms/types.ts` | Create | `Transform` and `TransformContext` contracts |
| `src/transforms/registry.ts` | Create | Ordered, instance-scoped custom transform registration |
| `src/transforms/goal-expansion.ts` | Modify | Adapt existing logic to new transform contract |
| `src/transforms/stylesheet-apply.ts` | Modify | Adapt existing logic to new transform contract |
| `src/transforms/compose-imports.ts` | Create | Recursive child-garden composition transform |
| `src/garden/validate.ts` | Modify | Composition-aware diagnostics with child-file provenance |
| `src/llm/adapters/openai-compatible.ts` | Create | Chat Completions adapter for third-party endpoints |
| `src/llm/client.ts` | Modify | Register `openai_compatible` provider from env |
| `src/llm/catalog.ts` | Modify | Add compatible-provider model entries |
| `src/llm/streaming.ts` | Modify | Chat Completions SSE delta parsing |
| `src/runtime/pipeline-service.ts` | Modify | Prepare/hash/execute prepared graphs |
| `src/runtime/garden-preview-service.ts` | Modify | Preview prepared graphs and metadata |
| `src/server/run-manager.ts` | Modify | Persist `prepared.dot` and source manifests |
| `src/server/routes/gardens.ts` | Modify | Preview/save use async preparation pipeline |
| `src/server/routes/pipelines.ts` | Modify | Serve rendered prepared graphs over HTTP |
| `src/server/graph-renderer.ts` | Modify | Render prepared DOT for preview and run state |
| `src/checkpoint/types.ts` | Modify | Store prepared-hash metadata and hash kind |
| `src/checkpoint/run-store.ts` | Modify | Persist prepared graph artifacts |
| `test/transforms/preparer.test.ts` | Create | Transform ordering and registry isolation tests |
| `test/transforms/compose-imports.test.ts` | Create | Graph merge and diagnostics unit tests |
| `test/fixtures/composed/*.dot` | Create | Parent/child success and failure fixtures |
| `test/llm/openai-compatible.test.ts` | Create | Adapter unit tests |
| `test/helpers/mock-chat-completions.ts` | Create | Reusable mock Chat Completions server |
| `test/integration/composed-run.test.ts` | Create | Execute composed gardens through runtime |
| `test/integration/composed-resume.test.ts` | Create | Resume mismatch and whitespace coverage |
| `test/integration/chat-completions-server.test.ts` | Create | Mock server end-to-end adapter integration |
| `test/server/gardens-preview.test.ts` | Modify | Preview prepared/composed graphs |
| `.nectar/gardens/modular-release.dot` | Create | Manual QA composed garden example |
| `.nectar/gardens/lib/review-loop.dot` | Create | Reusable child garden for QA example |

---

## Definition of Done

### Transform API and Preparation Pipeline (GAP-5)
- [ ] Production code has exactly one garden preparation path, and it is async
- [ ] Built-in transforms run in defined order: goal expansion, stylesheet, composition
- [ ] Custom transforms register programmatically per preparer instance and run after built-ins in registration order
- [ ] No process-global transform registry exists
- [ ] Two preparer instances do not share transform state

### Sub-pipeline Composition (GAP-6)
- [ ] A node with `"compose.dotfile"` composes a child garden recursively and removes the placeholder
- [ ] Imported node IDs, edge endpoints, and subgraph IDs are deterministic and collision-free
- [ ] Missing child files, import cycles, outside-workspace paths, and unsupported child globals produce clear diagnostics
- [ ] Validation errors inside imported children point at the child file path
- [ ] `nectar validate` works on composed gardens
- [ ] `nectar run` executes composed gardens end-to-end without engine special cases
- [ ] `prepared.dot` and `source-manifest.json` are written for new runs
- [ ] New runs store `graph_hash_kind: "prepared"`; legacy runs remain readable
- [ ] `/gardens/preview` renders the prepared graph with prepared node and edge counts
- [ ] `/pipelines/:id/graph` renders namespaced imported nodes from `prepared.dot`
- [ ] `nectar resume` rejects semantic child changes but ignores comment/whitespace-only edits
- [ ] Existing non-composed gardens continue to work without regression

### OpenAI-Compatible Adapter (GAP-3)
- [ ] `src/llm/adapters/openai-compatible.ts` implements the `LLMAdapter` interface
- [ ] `Client.from_env()` registers `openai_compatible` when `OPENAI_COMPATIBLE_BASE_URL` is set
- [ ] Non-streaming and streaming text generation works against mock Chat Completions server
- [ ] Tool calling round-trips correctly: definitions → model calls → tool results → response
- [ ] Structured JSON output works via `response_format` passthrough (with prompt-based fallback)
- [ ] Error mapping produces correct types for 401, 403, 404, 429, and 500+ responses
- [ ] Rate limit `Retry-After` header is parsed and respected
- [ ] `AbortSignal` cancellation stops streaming
- [ ] Provider options pass through to request body
- [ ] Pipeline execution works end-to-end with a codergen node using the compatible adapter

### Build & Integration
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all new and existing test suites
- [ ] `bun build --compile src/cli/index.ts` produces a working binary

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Async preparation refactor leaves one call site on old sync path | Medium | High | Make `PipelineService` the single production boundary; remove direct `transformAndValidate()` usage |
| Composition semantics around child graph globals become ambiguous | High | Medium | Materialize only the safe subset; reject unsupported graph-global controls explicitly in v1 |
| Normalized DOT serialization accidentally changes graph semantics | Medium | High | Golden tests for labels, conditions, weights, fidelity, retry, hook fields before using for hashing |
| Prepared-graph hash produces false mismatches on resume | Medium | Medium | Hash only normalized prepared DOT; add fixtures for whitespace/comment-only edits |
| Chat Completions endpoints vary in undocumented ways | High | Medium | Test against strict mock server; document known quirks in catalog; error clearly on unexpected responses |
| Tool calling format varies between Chat Completions implementations | Medium | High | Use current `tools` format; validate defensively; surface errors when endpoint rejects tool parameters |
| Structured output not universally supported by compatible endpoints | High | Medium | Try `json_schema` once, fall back to prompt-based extraction, cache the decision per endpoint |
| Recursive imports create unreadable debugging output | Medium | Medium | Deterministic namespacing, provenance metadata, and capped import depth |
| Sprint scope is ambitious (3 gaps) | Medium | Medium | Phases are ordered by dependency — composition builds on transforms, adapter is independent. Cut catalog polish before cutting core deliverables |

---

## Dependencies

No new npm packages. This sprint extends the current parser, renderer, runtime, run-store, and LLM client infrastructure.

| Dependency | Purpose |
|------------|---------|
| `@ts-graphviz/parser` | Parse root and imported child DOT files |
| `@viz-js/viz` | Render normalized prepared DOT for preview and pipeline graph endpoints |
| `src/runtime/pipeline-service.ts` | Centralize preparation so composition cannot be bypassed |
| `src/checkpoint/run-store.ts` | Persist prepared graph artifacts and resume metadata |
| `vitest` | Test coverage for transforms, composition, adapter, preview, run, and resume |

Critical internal dependency: every production path that currently calls `parseGardenFile()` → validation → execution must route through the new `PipelinePreparer`. If that is not true by sprint end, the sprint is not done.
