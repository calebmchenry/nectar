# Sprint 022: Modular Gardens — Transform Registry, Graph Composition, and Prepared Graph Hashing

## Overview

**Goal:** Close GAP-5 and GAP-6 by turning garden preparation into a first-class subsystem: ordered transforms, programmatic custom registration, and built-in composition of child DOT files into one prepared execution graph. After this sprint, large workflows can be split across reusable child gardens without losing validation, preview, rendering, run, or resume safety.

**Scope:** One built-in composition mechanism (`"compose.dotfile"` on a placeholder node), one ordered custom transform API, prepared-graph serialization and hashing, provenance-aware diagnostics, and end-to-end integration through the CLI, runtime, and HTTP/Hive preview surfaces.

**Why this sprint, why now:**

1. **Single-file graphs are the biggest remaining orchestrator ceiling.** `docs/INTENT.md` positions Nectar as a serious workflow engine. That promise breaks down when every reusable plan/implement/test/review loop has to live in one DOT file.

2. **GAP-5 and GAP-6 are one unit of work, not two.** A custom transform API without a real first-party transform is architecture theater. Graph composition without ordered transforms becomes a one-off hack with no extension story.

3. **The runtime already has child-run supervision.** The missing capability is parse-time modularity. Users can supervise a child pipeline today with `stack.manager_loop`; they still cannot author a clean library of reusable gardens and inline them safely.

4. **Resume integrity must move up one level.** The current graph hash is derived from the root DOT source. Once child files affect execution, the only trustworthy boundary is the normalized prepared graph that the engine will actually run.

5. **The remaining LLM gaps are additive, not blocking.** AUDIO/DOCUMENT support, extra error subclasses, the OpenAI-compatible adapter, and Gemini tool parity all matter, but none unblock Nectar's core multi-step orchestration story as directly as modular gardens.

**Gaps closed:**

| Gap | Type | Why it belongs here |
|-----|------|---------------------|
| GAP-5: Custom Transform Registration API | Core architecture | Composition needs a real ordered transform pipeline, not a hard-coded helper |
| GAP-6: Sub-pipeline Composition | Core workflow capability | Reusable child gardens are the biggest remaining authoring gap in the orchestrator |

**In scope:**

- Async garden preparation API with instance-scoped transform registration
- Built-in composition transform using `"compose.dotfile"` and optional `"compose.prefix"`
- Recursive child loading with workspace path safety and import-cycle detection
- Deterministic namespacing of imported nodes, edges, and subgraphs
- Parent-edge rewiring through child start and exit nodes
- Prepared DOT serialization and prepared-graph hashing
- Run-store, preview, graph rendering, and resume integration based on prepared graphs
- Provenance metadata so diagnostics point at child files instead of only the parent
- Regression tests for validate/run/preview/resume on composed gardens

**Out of scope:**

- Dynamic JavaScript plugin loading from config files, CLI flags, or HTTP requests
- Any new runtime handler semantics or changes to `stack.manager_loop`
- Remote imports, absolute-path imports, or cross-workspace composition
- Inline editing of imported child internals from the Hive UI
- Parameterized composition, graph macros, or parent override maps
- GAP-1, GAP-2, GAP-3, and GAP-4

**Cut line:** If time compresses, cut import-tree niceties in preview responses and sample-garden polish. Do **not** cut the ordered transform API, prepared-graph hashing, or `prepared.dot` persistence. Shipping composition without those would create a feature users cannot trust.

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

   Preparation replaces that placeholder with the child graph, namespaces imported nodes as `review_loop__plan`, `review_loop__critique`, and `review_loop__merge`, and rewires the parent edges automatically.

2. **Validate a modular garden from the CLI.** `nectar validate gardens/release.dot` resolves child imports, reports missing-file and cycle errors against the real child path, and fails before any execution starts.

3. **Preview a composed garden in the Hive.** `POST /gardens/preview` with `dot_source` plus `dot_path` returns SVG for the prepared graph, not the raw placeholder node. The browser sees the same graph the engine would run.

4. **Run a composed garden end-to-end.** `nectar run gardens/release.dot` executes the fully prepared graph. The engine remains oblivious to the fact that some nodes came from child files.

5. **Resume safely after a child change.** The user edits `gardens/lib/review-loop.dot`. If the semantic prepared graph changes, `nectar resume <run-id>` fails with a prepared-graph hash mismatch. If the user only changes comments or whitespace, the normalized prepared graph hash stays stable and resume proceeds.

6. **Register an organization-specific transform.** An embedder creates a `PipelinePreparer`, registers `InjectAuditNodesTransform`, and gets a prepared graph where built-ins run first, composition runs next, and the custom transform runs last before validation.

7. **Fail early on unsafe imports.** A child import resolves outside the workspace, refers to a missing file, or creates an import cycle. Nectar returns deterministic diagnostics immediately; no partial run directory is created.

8. **See composed execution state over HTTP.** `/pipelines/:id/graph` renders `prepared.dot`, so node coloring tracks namespaced imported nodes rather than silently omitting them.

---

## Architecture

### Design Principles

1. **The prepared graph is the source of truth.** Parsing produces an intermediate graph. Validation, preview, rendering, execution, and resume operate on the prepared graph.

2. **Composition is a transform, not a handler.** The runtime engine should not care whether a graph came from one file or ten.

3. **All production paths prepare through one API.** No side door that parses and validates directly.

4. **Custom transforms are instance-scoped.** No process-global registry. Tests, embedders, and future multi-workspace servers need isolation.

5. **Hash semantics, not raw text.** Resume safety should key off the normalized prepared graph. Child comments and formatting should not invalidate a run.

6. **Child gardens have explicit boundaries.** The parent can inline a child graph; it does not get magical access to child-global execution settings with ambiguous merge rules.

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

Opinionated rule: **custom transforms run after composition.** If a consumer registers a transform, it should operate on the same graph that validation, preview, and execution will see.

### Transform API

The new API is programmatic, not config-driven:

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
3. Track an import stack and fail on cycles.
4. Prepare the child graph recursively using built-ins and composition, but defer custom transforms until the fully merged parent graph exists.
5. Require the child graph to have exactly one start node and one exit node after child-local preparation.
6. Namespace every imported node ID, edge endpoint, and subgraph ID as `<prefix>__<child_id>`.
7. Rewire every parent incoming edge to the placeholder so it points to the namespaced child start node.
8. Rewire every parent outgoing edge from the placeholder so it originates at the namespaced child exit node.
9. Remove the placeholder node from the final prepared graph.

### Child Graph Boundary Rules

Safe child graph settings are materialized before merge:

- `default_max_retries`
- `default_fidelity`
- `tool_hooks.pre`
- `tool_hooks.post`
- `goal` after child-local expansion
- `model_stylesheet` after child-local application

Rejected in v1 composition:

- `stack.child_dotfile`
- `stack.child_workdir`
- `max_restart_depth`

Reason: these are graph-global runtime controls. This sprint should reject them explicitly instead of inventing half-correct merge semantics.

### Provenance and Diagnostics

Imported nodes and edges need origin metadata:

- source DOT path
- original node/edge identifier
- original line/column when known

That provenance is what lets a validation error inside `gardens/lib/review-loop.dot` surface against the child file instead of blaming the parent placeholder.

### Prepared DOT and Hashing

Composition is not done until preview, rendering, and resume all use the prepared graph.

Implementation rules:

- Add `serializeGardenGraph()` to emit normalized DOT with stable node and edge ordering
- Exclude comments, whitespace, and provenance-only metadata from the normalized DOT
- Compute `graph_hash` as `sha256(prepared_dot)`
- Persist `prepared.dot` under each run directory
- Persist `source-manifest.json` listing every contributing source file and its content hash for provenance and debugging
- Record `graph_hash_kind: "prepared"` on new runs so legacy runs remain distinguishable
- Make `/pipelines/:id/graph` render `prepared.dot`
- Make preview render the prepared DOT whenever composition is involved

### Module Layout

```text
src/
├── garden/
│   ├── preparer.ts             # PipelinePreparer and async prepare helpers
│   ├── pipeline.ts             # Thin compatibility facade
│   ├── serialize.ts            # GardenGraph -> normalized DOT
│   └── types.ts                # provenance metadata on nodes/edges
├── transforms/
│   ├── types.ts                # Transform and TransformContext contracts
│   ├── registry.ts             # ordered instance-scoped registration
│   ├── goal-expansion.ts       # built-in transform
│   ├── stylesheet-apply.ts     # built-in transform
│   └── compose-imports.ts      # recursive child-garden merge
├── runtime/
│   ├── pipeline-service.ts     # parse/prepare/hash integration
│   └── garden-preview-service.ts
├── server/
│   ├── run-manager.ts          # persist prepared.dot and source manifest
│   ├── graph-renderer.ts       # render prepared DOT
│   └── routes/
│       ├── gardens.ts
│       └── pipelines.ts
└── checkpoint/
    ├── types.ts
    └── run-store.ts
```

---

## Implementation Phases

### Phase 1: Preparation API and Ordered Transform Registry (~25%)

**Files:** `src/garden/preparer.ts`, `src/garden/pipeline.ts`, `src/transforms/types.ts`, `src/transforms/registry.ts`, `src/transforms/goal-expansion.ts`, `src/transforms/stylesheet-apply.ts`, `src/runtime/pipeline-service.ts`, `src/cli/commands/shared.ts`, `src/runtime/garden-preview-service.ts`, `src/server/routes/gardens.ts`, `test/transforms/preparer.test.ts`

**Tasks:**

- [ ] Introduce `PipelinePreparer` with `prepareFromPath()` and `prepareFromSource()` async entrypoints
- [ ] Introduce a `Transform` interface and instance-scoped registration
- [ ] Wrap existing goal expansion and stylesheet logic in the new transform contract
- [ ] Replace production uses of `transformAndValidate()` with the async preparation API
- [ ] Keep `src/garden/pipeline.ts` only as a thin facade or compatibility export; the old hard-coded sequencing should disappear
- [ ] Return `PreparedGardenResult` with `graph`, `diagnostics`, `prepared_dot`, `graph_hash`, and `source_files`
- [ ] Add tests proving built-ins run before custom transforms and custom transforms preserve registration order
- [ ] Add tests proving two preparer instances do not share transform state

### Phase 2: Built-In Composition Transform and Merge Semantics (~35%)

**Files:** `src/transforms/compose-imports.ts`, `src/garden/types.ts`, `src/garden/validate.ts`, `test/transforms/compose-imports.test.ts`, `test/fixtures/composed/*.dot`

**Tasks:**

- [ ] Detect placeholders via `"compose.dotfile"` and optional `"compose.prefix"`
- [ ] Resolve child paths relative to the current DOT file and reject workspace escapes
- [ ] Track import depth and import stack; fail deterministically on recursive cycles
- [ ] Prepare child graphs recursively before merge
- [ ] Require exactly one child start node and one child exit node
- [ ] Namespace imported node IDs, edge endpoints, and subgraph IDs as `<prefix>__<id>`
- [ ] Rewire parent incoming edges to the child start and parent outgoing edges from the child exit
- [ ] Materialize safe child graph defaults onto imported nodes before merge
- [ ] Reject unsupported child graph globals (`stack.child_dotfile`, `stack.child_workdir`, `max_restart_depth`) with explicit diagnostics
- [ ] Preserve provenance metadata for imported nodes and edges
- [ ] Add fixtures covering success, nested composition, missing file, outside-workspace path, duplicate prefix collision, and import cycle cases

### Phase 3: Prepared DOT, Hash Semantics, and Runtime/Server Integration (~25%)

**Files:** `src/garden/serialize.ts`, `src/runtime/pipeline-service.ts`, `src/server/run-manager.ts`, `src/server/routes/pipelines.ts`, `src/server/graph-renderer.ts`, `src/checkpoint/types.ts`, `src/checkpoint/run-store.ts`, `test/integration/composed-run.test.ts`, `test/integration/composed-resume.test.ts`, `test/server/gardens-preview.test.ts`

**Tasks:**

- [ ] Serialize prepared graphs to normalized DOT with stable ordering and execution-relevant attributes only
- [ ] Compute `graph_hash` from normalized `prepared.dot`
- [ ] Persist `prepared.dot` and `source-manifest.json` under each run directory
- [ ] Record `graph_hash_kind` in run metadata so legacy raw-hash runs remain readable
- [ ] Make `RunManager` and `PipelineService` pass prepared graphs into execution
- [ ] Make `/pipelines/:id/graph` render `prepared.dot` instead of reusing raw source
- [ ] Make preview return prepared node and edge counts when composition is present
- [ ] Make resume compare the prepared-graph hash and fail on semantic child changes
- [ ] Preserve backwards compatibility for older runs that only have the legacy root-file hash

### Phase 4: Regression Sweep and Manual QA Gardens (~15%)

**Files:** `test/integration/http-server.test.ts`, `test/integration/run.test.ts`, `test/garden/validate.test.ts`, `.nectar/gardens/modular-release.dot`, `.nectar/gardens/lib/review-loop.dot`

**Tasks:**

- [ ] Add a manual sample garden that composes at least one reusable child module
- [ ] Verify `nectar validate` succeeds on the sample and errors cleanly on broken imports
- [ ] Verify `nectar run` executes the sample composed garden end-to-end
- [ ] Verify HTTP preview and rendered run graphs show namespaced imported nodes
- [ ] Verify non-composed gardens still validate and run without behavior changes
- [ ] Verify whitespace-only and comment-only child edits do not change the prepared hash

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/preparer.ts` | Create | Async `PipelinePreparer` and preparation result contract |
| `src/garden/pipeline.ts` | Modify | Replace hard-coded helper with thin facade over the new preparer |
| `src/garden/serialize.ts` | Create | Normalize `GardenGraph` into stable DOT for hashing and rendering |
| `src/garden/types.ts` | Modify | Add provenance metadata for imported nodes and edges |
| `src/transforms/types.ts` | Create | `Transform` and `TransformContext` contracts |
| `src/transforms/registry.ts` | Create | Ordered, instance-scoped custom transform registration |
| `src/transforms/goal-expansion.ts` | Modify | Adapt existing logic to the new transform contract |
| `src/transforms/stylesheet-apply.ts` | Modify | Adapt existing logic to the new transform contract |
| `src/transforms/compose-imports.ts` | Create | Recursive child-garden composition transform |
| `src/garden/validate.ts` | Modify | Emit composition-aware diagnostics with child-file provenance |
| `src/runtime/pipeline-service.ts` | Modify | Load, prepare, hash, and execute prepared graphs |
| `src/runtime/garden-preview-service.ts` | Modify | Preview prepared graphs and prepared metadata |
| `src/cli/commands/shared.ts` | Modify | CLI load helpers return prepared graphs and prepared hashes |
| `src/server/routes/gardens.ts` | Modify | Preview and save paths use the async preparation pipeline |
| `src/server/run-manager.ts` | Modify | Persist `prepared.dot` and source manifests with runs |
| `src/server/routes/pipelines.ts` | Modify | Serve rendered prepared graphs over HTTP |
| `src/server/graph-renderer.ts` | Modify | Render prepared DOT reliably for preview and run state |
| `src/checkpoint/types.ts` | Modify | Store prepared-hash metadata and hash kind for safe resume |
| `src/checkpoint/run-store.ts` | Modify | Persist prepared graph artifacts and compatible manifest metadata |
| `test/transforms/preparer.test.ts` | Create | Transform ordering and registry isolation tests |
| `test/transforms/compose-imports.test.ts` | Create | Graph merge and diagnostics unit tests |
| `test/fixtures/composed/*.dot` | Create | Parent/child success and failure fixtures |
| `test/integration/composed-run.test.ts` | Create | Execute composed gardens through runtime and CLI paths |
| `test/integration/composed-resume.test.ts` | Create | Resume mismatch and whitespace-only child edit coverage |
| `test/server/gardens-preview.test.ts` | Modify | Preview prepared graphs and composed metadata |
| `test/integration/http-server.test.ts` | Modify | Verify prepared graph rendering over HTTP |
| `.nectar/gardens/modular-release.dot` | Create | Manual QA example of a composed top-level garden |
| `.nectar/gardens/lib/review-loop.dot` | Create | Reusable child garden used by the manual QA example |

---

## Definition of Done

- [ ] Production code has exactly one garden preparation path, and it is async
- [ ] Built-in transforms run in the defined order: goal expansion, stylesheet, composition
- [ ] Custom transforms register programmatically per preparer instance and run after built-ins in registration order
- [ ] No process-global transform registry exists
- [ ] A node with `"compose.dotfile"` composes a child garden recursively and removes the placeholder from the prepared graph
- [ ] Imported node IDs, edge endpoints, and subgraph IDs are deterministic and collision-free
- [ ] Missing child files, import cycles, outside-workspace paths, and unsupported child graph globals produce clear diagnostics
- [ ] Validation errors inside imported children point at the child file path and location when available
- [ ] `nectar validate` works on composed gardens
- [ ] `nectar run` executes composed gardens end-to-end without any engine special cases
- [ ] `prepared.dot` and `source-manifest.json` are written for new runs
- [ ] New runs store `graph_hash_kind: "prepared"`; legacy runs remain readable
- [ ] `/gardens/preview` renders the prepared graph and reports prepared node and edge counts
- [ ] `/pipelines/:id/graph` renders namespaced imported nodes from `prepared.dot`
- [ ] `nectar resume` rejects semantic child-graph changes but ignores comment-only and whitespace-only child edits
- [ ] Existing non-composed gardens continue to validate and run without regression
- [ ] `npm test` passes
- [ ] `npm run build` passes

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Async preparation refactor leaves one production call site on the old sync path | Medium | High | Make `PipelineService` the single production boundary and remove direct `transformAndValidate()` usage from runtime and server code |
| Composition semantics around child graph globals become ambiguous | High | Medium | Materialize only the safe subset and reject unsupported graph-global controls explicitly in v1 |
| Normalized DOT serialization accidentally changes graph semantics | Medium | High | Add golden tests for labels, conditions, weights, fidelity, retry fields, hook fields, and node kinds before using it for hashing or rendering |
| Prepared-graph hash produces false mismatches | Medium | Medium | Hash only normalized prepared DOT, not raw source text or comments; add fixtures for whitespace-only and comment-only edits |
| Recursive imports create unreadable debugging output | Medium | Medium | Enforce deterministic namespacing, preserve provenance metadata, and cap import depth |
| Preview requests with `compose.dotfile` but no stable `dot_path` cannot resolve relative imports | Medium | Low | Return a direct validation error that composition preview requires `dot_path` context |

---

## Dependencies

No new npm packages are required. This sprint should extend the current parser, renderer, runtime, and run-store infrastructure.

| Dependency | Purpose |
|------------|---------|
| `@ts-graphviz/parser` | Parse root and imported child DOT files |
| `@viz-js/viz` | Render normalized prepared DOT for preview and pipeline graph endpoints |
| `src/runtime/pipeline-service.ts` | Centralize preparation so composition cannot be bypassed accidentally |
| `src/checkpoint/run-store.ts` | Persist prepared graph artifacts and compatible resume metadata |
| `vitest` | Regression coverage for transform ordering, composition, preview, run, and resume |

One internal dependency matters more than any package: every production path that currently goes from `parseGardenFile()` straight to validation or execution must be routed through the new preparation API. If that is not true by sprint end, the sprint is not done.
