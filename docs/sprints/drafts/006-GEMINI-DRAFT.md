# Sprint 005: Pipeline Styling, Scoping, and Context Management

## Overview

**Goal:** Close the remaining high-impact Medium gaps in the Attractor specification by implementing graph styling, scoping, and context management. With parallel execution completed in previous sprints, this sprint finishes the core orchestration engine's structural and semantic features before moving into the Agent Loop and Unified LLM Client specs.

**Scope:**
- Parser support for subgraphs and scoped node/edge default blocks (GAP-14, GAP-13)
- Model stylesheet parsing, specificity rules, and the built-in application transform (GAP-06, GAP-24)
- Context fidelity modes (`full`, `truncate`, `compact`, `summary:*`) and the preamble transform (GAP-07, GAP-25)

**Out of scope:**
- Manager Loop Handler (GAP-04) - deferred to a dedicated supervisor sprint.
- Coding Agent Loop (GAP-40) - deferred.
- Unified LLM Client (GAP-50) - deferred.
- Web UI / HTTP Server APIs.

---

## Use Cases

1. **Scoped Defaults:** A user defines `node [timeout="900s"]` at the graph root, and all subsequent nodes inherit this timeout. Inside a `subgraph cluster_fast`, they define `node [timeout="30s"]`, which only applies to nodes in that subgraph.
2. **Model Stylesheets:** A user writes a `model_stylesheet` targeting specific node classes (`.planner { llm_model: "claude-3-5-sonnet-20241022" }`) or shapes (`box { reasoning_effort: "high" }`). The runtime automatically resolves and applies these properties to the nodes via the stylesheet transform before execution.
3. **Context Fidelity:** A user configures a node with `fidelity="summary:high"`. The engine, via the preamble transform, condenses the execution context and past interactions into a dense summary before passing it to the Codergen handler, saving tokens and improving relevance.

---

## Architecture

### Module Additions & Changes

1. **DOT Parser Updates (`src/garden/parse.ts`)**
   - Enhance the custom statement collector to recognize `subgraph` boundaries.
   - Maintain a stack of active scopes (root -> subgraph -> nested subgraph).
   - Track `node [...]` and `edge [...]` default attribute declarations per scope.
   - Apply active defaults to newly encountered nodes and edges during parsing, merging them correctly (Graph Defaults -> Scope Defaults -> Instance Attributes).
   - Extract `class` attributes to support stylesheet targeting.

2. **Model Stylesheet System (`src/garden/stylesheet.ts`)**
   - Parse the `model_stylesheet` graph attribute into a structured CSS-like AST.
   - Implement selector matching (`*`, `shape`, `.class`, `#id`).
   - Implement specificity ordering calculations (universal < shape < class < ID).

3. **Built-in Transforms (`src/transforms/`)**
   - `stylesheet-transform.ts`: Applies the parsed stylesheet to the `GardenGraph`, mutating node attributes (`llm_model`, `llm_provider`, `reasoning_effort`) based on matched selectors.
   - `preamble-transform.ts`: Reads the `fidelity` attribute and synthesizes context carryover text. Modifies the prompt or context payload for nodes not using `full` fidelity.

4. **Validation Rules (`src/garden/validate.ts`)**
   - Add `stylesheet_syntax` rule to validate the `model_stylesheet` string.
   - Fix the `fidelity_valid` rule to check for valid string enums (`full`, `truncate`, `compact`, `summary:low`, `summary:medium`, `summary:high`) instead of a numeric range.

### Data Flow

```text
DOT file → @ts-graphviz/parser
           ↓
Custom Statement Collector (tracks scopes & defaults)
           ↓
GardenGraph (with subgraphs, classes, and raw stylesheet)
           ↓
Transform Pipeline:
  1. expandGoalVariables (existing)
  2. applyModelStylesheet (new)
  3. applyPreambleTransform (new)
           ↓
Validation Pipeline (updated rules)
           ↓
Execution Engine
```

---

## Implementation

### Phase 1: Subgraphs & Default Blocks (GAP-13, GAP-14)
**Files:** `src/garden/parse.ts`, `test/garden/parse.test.ts`
**Tasks:**
- [ ] Refactor `collectStatements` to push/pop a scope context when entering/exiting subgraphs.
- [ ] Add `nodeDefaults` and `edgeDefaults` maps to the scope context.
- [ ] When a `node [attr=val]` or `edge [attr=val]` statement is parsed, update the current scope's defaults.
- [ ] When a specific node or edge is parsed, apply defaults according to the scope hierarchy.
- [ ] Extract the `class` attribute from nodes (comma-separated string).

### Phase 2: Model Stylesheets (GAP-06, GAP-24)
**Files:** `src/garden/stylesheet.ts`, `src/transforms/stylesheet.ts`, `src/garden/validate.ts`, `src/garden/pipeline.ts`, `test/transforms/stylesheet.test.ts`
**Tasks:**
- [ ] Implement a lightweight CSS parser in `stylesheet.ts` supporting `*`, `shape`, `.class`, `#id` selectors and specific properties (`llm_model`, `llm_provider`, `reasoning_effort`).
- [ ] Add a `stylesheet_syntax` validation rule to verify the graph's `model_stylesheet` attribute.
- [ ] Create `applyModelStylesheet` transform that computes the winning properties for each node based on specificity rules and assigns them as node attributes.
- [ ] Wire the transform into `pipeline.ts` to run before validation.

### Phase 3: Context Fidelity & Preamble Transform (GAP-07, GAP-25)
**Files:** `src/transforms/preamble.ts`, `src/garden/validate.ts`, `src/garden/pipeline.ts`, `test/transforms/preamble.test.ts`
**Tasks:**
- [ ] Update `validate.ts` to enforce valid `fidelity` string modes (`full`, `truncate`, `compact`, `summary:low`, `summary:medium`, `summary:high`).
- [ ] Implement resolution chain for fidelity: Edge -> Node -> Graph -> Default.
- [ ] Create `applyPreambleTransform` that reads the resolved fidelity mode.
- [ ] For non-`full` modes, synthesize a preamble payload (placeholder implementation for `summary:*` modes this sprint: simple text reduction or warning, deferring actual LLM summarization calls if they introduce circular dependencies).
- [ ] Inject the preamble into the node's execution configuration.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/parse.ts` | Modify | Support subgraphs, scoped defaults, and `class` attributes |
| `src/garden/stylesheet.ts` | Create | Parse model stylesheets and calculate selector specificity |
| `src/transforms/stylesheet.ts` | Create | Transform to apply stylesheet properties to nodes |
| `src/transforms/preamble.ts` | Create | Transform to apply context fidelity and synthesize preambles |
| `src/garden/validate.ts` | Modify | Add stylesheet validation, fix fidelity enum validation |
| `src/garden/pipeline.ts` | Modify | Register new built-in transforms |
| `test/garden/parse.test.ts` | Modify | Test subgraphs and default block scoping |
| `test/transforms/stylesheet.test.ts` | Create | Test stylesheet parsing and specificity application |
| `test/transforms/preamble.test.ts` | Create | Test fidelity resolution and preamble synthesis |

---

## Definition of Done

- [ ] Nodes correctly inherit attributes from `node [...]` blocks in their scope.
- [ ] Edges correctly inherit attributes from `edge [...]` blocks in their scope.
- [ ] `model_stylesheet` graph attribute is parsed correctly; invalid syntax yields a validation error.
- [ ] Stylesheet transform applies `llm_model`, `llm_provider`, and `reasoning_effort` respecting specificity rules (`#id` > `.class` > `shape` > `*`).
- [ ] `fidelity` attribute validation correctly checks for spec-defined string enums.
- [ ] Fidelity mode resolution correctly cascades (Edge > Node > Graph > Default).
- [ ] Preamble transform successfully modifies node context based on the resolved fidelity mode.
- [ ] All unit and integration tests pass.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Custom CSS parser becomes complex and brittle | Medium | Medium | Restrict parser to strictly the subset defined in the Attractor spec. Do not support combinators (e.g., `A B`, `A > B`) or pseudo-classes. |
| Subgraph parsing conflicts with `@ts-graphviz/parser` | Low | High | `@ts-graphviz/parser` natively supports subgraphs; ensure the custom statement collector maps the AST nodes correctly without losing attributes. |
| Context Fidelity summaries require complex LLM calls | High | Medium | For this sprint, implement `truncate` and `compact` fully, but stub `summary:*` modes with a simpler text reduction, deferring actual LLM summarization calls until the Unified LLM Client is fully built out in a future sprint. |

---

## Dependencies

- None. Relies on existing architecture and standard library/regex.