# Sprint 008: Model Stylesheet, Default Blocks & Parallel Tool Execution

## Overview

**Goal:** Close two independent but high-impact clusters of gaps in one sprint: (1) the DOT authoring layer — model stylesheets, default blocks, subgraphs, block comments, and missing attributes — so pipeline authors get real multi-model control, and (2) parallel tool execution in the agent loop and LLM SDK — so codergen nodes stop sequentially executing tool calls that could run concurrently. These are the two highest-leverage investments remaining: one unlocks pipeline *authoring*, the other unlocks pipeline *performance*.

**Why these two clusters, why now:**

The compliance report tells a split story. The engine is ~75%, the agent loop is ~55%, the LLM client is ~45%. But zoom into *what's missing*:

| Cluster | Gaps | Impact |
|---------|------|--------|
| **Authoring layer** | GAP-06 (stylesheet, 0%), GAP-13 (default blocks), GAP-14 (subgraphs), GAP-17 (block comments), GAP-24 (stylesheet transform), GAP-20 (duration units), GAP-27/28/29 (missing attrs) | Pipeline authors must manually tag every node with `llm_model`/`llm_provider`. No `node [shape=box]` defaults. No subgraph scoping. Standard DOT features broken. |
| **Agent performance** | GAP-45 (parallel tool exec in agent loop), GAP-57 (parallel tool exec in LLM SDK) | When Claude returns 4 `grep` calls in one response, they execute sequentially. Real-world codergen tasks spend 60-80% of time in tool execution — parallelism cuts this dramatically. |

These clusters are **completely independent** — different files, different test suites, zero shared state. They can be developed and reviewed in parallel. And together they move Nectar's overall spec compliance from ~58% to ~65% while touching every one of the three specs.

The authoring cluster is pure parsing/transform/validation — the most testable, lowest-risk category of work. The parallel tool cluster is a focused concurrency change in two files with clear boundaries. Neither requires new npm dependencies or external API calls in tests.

**Scope — what ships:**

*Authoring cluster:*
- Block comment (`/* ... */`) stripping in the parser (GAP-17)
- `node [attrs]` and `edge [attrs]` default block parsing with scope stack (GAP-13)
- `subgraph cluster_X { ... }` boundary detection, label extraction, class derivation (GAP-14)
- 7 new node attributes: `class`, `llm_model`, `llm_provider`, `reasoning_effort`, `auto_status`, `fidelity`, `thread_id` (GAP-27)
- 2 new edge attributes: `fidelity`, `thread_id` (GAP-28 partial)
- 2 new graph attributes: `model_stylesheet`, `default_fidelity` (GAP-29 partial)
- Duration `h` and `d` unit support (GAP-20)
- Model stylesheet parser with 4 selector types and specificity resolution (GAP-06)
- Stylesheet application AST transform (GAP-24)
- `stylesheet_syntax` validation rule
- `reasoning_effort` and `llm_provider` value validation

*Performance cluster:*
- Concurrent tool execution in `AgentSession.processInput()` when profile supports it (GAP-45)
- Concurrent tool call packaging in the LLM SDK layer (GAP-57)

**Scope — what doesn't ship:**

- Context fidelity runtime (GAP-07) — attributes parsed/validated, modes not enforced at runtime
- Preamble transform (GAP-25) — depends on fidelity runtime
- Manager loop handler (GAP-04) — independent engine feature, needs child pipeline design
- Steering / subagents (GAP-40, GAP-41) — separate sprint
- Prompt caching auto-injection (GAP-53) — valuable but independent optimization
- Seedbed / web UI / HTTP server — product layer, not engine
- `apply_patch` tool for OpenAI profile (GAP-43) — lower priority

---

## Use Cases

1. **Multi-model pipeline via stylesheet:** A pipeline has 8 codergen nodes. Instead of tagging each one, the author writes one stylesheet at graph level:
   ```dot
   digraph {
     model_stylesheet="
       box { llm_model: claude-sonnet-4-20250514 }
       #deep_review { llm_model: claude-opus-4-20250514; reasoning_effort: high }
     "
     plan [shape=box, prompt="..."]
     implement [shape=box, prompt="..."]
     deep_review [shape=box, prompt="..."]
   }
   ```
   All `box` nodes default to Sonnet. `deep_review` overrides to Opus with high reasoning. No repetition.

2. **Class-based routing via subgraphs:** Three draft nodes grouped in a subgraph:
   ```dot
   subgraph cluster_drafts {
     label="drafts"
     claude_draft; gemini_draft; codex_draft;
   }
   model_stylesheet=".drafts { llm_provider: anthropic; llm_model: claude-sonnet-4-20250514 }"
   ```
   Each node in the subgraph inherits class `drafts` and gets routed to Anthropic. Changing providers for all three drafts means editing one stylesheet rule.

3. **Default blocks eliminate boilerplate:**
   ```dot
   digraph {
     node [shape=box, timeout="120s"]
     plan [prompt="Plan the approach"]
     implement [prompt="Write the code"]
     review [prompt="Review the code"]
     test [shape=parallelogram, script="npm test"]
   }
   ```
   `plan`, `implement`, and `review` inherit `shape=box` and `timeout=120s`. `test` explicitly overrides shape.

4. **Fast codebase research:** A codergen agent investigating a bug returns 5 `grep` calls and 2 `read_file` calls in one response. With parallel tool execution, all 7 run concurrently — the round-trip drops from ~7s (sequential) to ~1.5s (bounded by the slowest call).

5. **Validation catches stylesheet typos early:**
   ```
   $ pollinator validate pipeline.dot
   pipeline.dot:3: error[STYLESHEET_SYNTAX]: Unexpected token 'llm_model' — missing ':' after property name
   ```

6. **Block comments for inline documentation:**
   ```dot
   /* This pipeline implements the compliance loop.
      Each iteration drafts from three providers,
      critiques each draft, then merges the best. */
   ```

7. **Scoped defaults inside subgraphs:**
   ```dot
   subgraph cluster_fast { node [timeout="30s"]; quick_lint; quick_check; }
   subgraph cluster_deep { node [timeout="600s"]; deep_review; deep_test; }
   ```
   `quick_lint` gets 30s. `deep_review` gets 600s. Scoping prevents leak.

---

## Architecture

### Stylesheet System

The model stylesheet is a micro-language embedded as a DOT graph attribute string. Four selector types, three properties, deterministic resolution.

```
model_stylesheet string
        |
        v
  parseStylesheet()           → StylesheetRule[]
  (tokenizer + recursive        { selector, specificity, properties[] }
   descent parser)
        |
        v
  applyStylesheet transform   → mutated GardenGraph
  (for each node:
    collect matching rules
    sort by specificity ASC
    merge: last-wins at same specificity
    set node attrs if not already inline)
```

**Selector grammar:**

| Selector | Example | Matches | Specificity |
|----------|---------|---------|-------------|
| `*` | `* { ... }` | All nodes | 0 |
| shape | `box { ... }` | Nodes with `shape=box` | 1 |
| `.class` | `.drafts { ... }` | Nodes with class `drafts` | 2 |
| `#id` | `#review { ... }` | Node with ID `review` | 3 |

**Resolution order:**

1. Collect all rules whose selector matches the node
2. Sort by specificity ascending, then source order ascending
3. Merge properties: later/higher-specificity wins
4. Inline node attributes override everything

### Default Block & Subgraph Scope Stack

The parser maintains a stack of attribute scopes. Entering a subgraph pushes a **copy** of the current scope. Changes inside don't affect the parent. Exiting pops.

```
Graph level:                [ { nodeDefaults: {}, edgeDefaults: {} } ]
After `node [shape=box]`:   [ { nodeDefaults: {shape: "box"} } ]
Enter subgraph cluster_X:  [ ..., { nodeDefaults: {shape: "box"} } ]  ← pushed copy
After `node [timeout=30s]`: [ ..., { nodeDefaults: {shape: "box", timeout: "30s"} } ]
Exit subgraph:              [ { nodeDefaults: {shape: "box"} } ]      ← popped
```

### Parallel Tool Execution

Two layers, same pattern:

**LLM SDK layer** (`src/llm/client.ts`): When a `GenerateResponse` contains multiple `tool_call` content parts, the SDK exposes them as a batch. A new `executeToolsBatch(calls, executor)` utility runs them concurrently via `Promise.allSettled()` and packages results into a single continuation message.

**Agent loop layer** (`src/agent-loop/session.ts`): When the model returns N tool calls, `processInput()` dispatches all N to `ToolRegistry.execute()` concurrently (bounded by profile's `max_parallel_tools`, default 8). Results are collected, ordered by original call order, and appended as a single tool-results message. Sequential fallback when `profile.parallel_tool_execution === false`.

Key invariant: tool calls that *mutate* (write_file, edit_file, shell) are execution-order-sensitive. The profile declares which tools are safe for parallel execution. Read-only tools (read_file, grep, glob) are always parallelizable. Write tools execute sequentially within the batch.

### Module Layout — New/Modified Files

```
src/garden/
  parse.ts              MODIFY — block comments, default blocks, subgraphs, new attrs
  types.ts              MODIFY — Subgraph type, classes on GardenNode, new attr fields
  validate.ts           MODIFY — stylesheet_syntax rule, new validations
  stylesheet.ts         CREATE — parser, types, specificity resolver
  pipeline.ts           MODIFY — register stylesheet transform

src/transforms/
  stylesheet-apply.ts   CREATE — AST transform applying resolved styles to nodes

src/llm/
  tools.ts              MODIFY — executeToolsBatch() utility

src/agent-loop/
  session.ts            MODIFY — concurrent tool dispatch
  types.ts              MODIFY — parallel_tool_execution profile option, tool safety classification
```

### Data Flow (Authoring Cluster)

```
DOT source
    |-- stripComments()         ENHANCED: /* block */ comments
    |-- collectStatements()     ENHANCED: scope stack, default blocks, subgraphs
    v
GardenGraph                     (defaults applied, classes assigned, new attrs parsed)
    |-- expandGoalVariables()   (existing)
    |-- applyStylesheet()       NEW: resolve model_stylesheet → per-node llm config
    v
GardenGraph                     (stylesheet-resolved)
    |-- validate()              ENHANCED: stylesheet_syntax, reasoning_effort, llm_provider
    v
Ready for engine
```

---

## Implementation

### Phase 1: Block Comments, Default Blocks, Duration Units (~15%)

**Files:** `src/garden/parse.ts`, `test/garden/parse.test.ts`

**Tasks:**
- [ ] Enhance `stripComments()` to handle `/* ... */` block comments. Character-by-character scan with `insideBlockComment` state. Handle `/*` inside string literals (don't strip). Multi-line. No nesting (standard Graphviz behavior).
- [ ] Detect `node [attrs]` statements: when `parseStatement` sees keyword `node` followed by `[`, parse attributes and push onto the current scope's `nodeDefaults`. Same for `edge [attrs]` → `edgeDefaults`. These keywords must no longer create spurious node entries.
- [ ] When creating a node, merge current scope's `nodeDefaults` as baseline — explicit attributes override.
- [ ] When creating an edge, merge current scope's `edgeDefaults` similarly.
- [ ] Initialize scope stack with one empty scope at graph level.
- [ ] Add `h` (3,600,000 ms) and `d` (86,400,000 ms) units to `parseTimeoutMs()`.
- [ ] Tests: block comments (single-line, multi-line, inside string literals), default blocks applied to nodes, explicit attrs override defaults, edge defaults, `2h` and `1d` duration parsing.

### Phase 2: Subgraph Extraction & Class Derivation (~15%)

**Files:** `src/garden/parse.ts`, `src/garden/types.ts`, `test/garden/parse.test.ts`

**Tasks:**
- [ ] Add to `types.ts`: `Subgraph` interface with `id`, `label?`, `nodeIds: string[]`. Add `subgraphs: Subgraph[]` to `GardenGraph`. Add `classes: string[]` to `GardenNode`.
- [ ] Detect `subgraph <name> {` in `collectStatements()`. On entry: push new scope (copy of current). Track which nodes are declared inside. On closing `}`: pop scope, record `Subgraph`.
- [ ] Derive class name from subgraph: if subgraph has `label` attribute, use that. Otherwise strip `cluster_` prefix from name. Add derived class to every node declared inside.
- [ ] Handle nested subgraphs: each level pushes its own scope. Inner nodes get classes from all enclosing subgraphs.
- [ ] Tests: subgraph with `label`, with `cluster_` prefix, nested subgraphs, scoped defaults don't leak, nodes get correct classes.

### Phase 3: New Attributes (~10%)

**Files:** `src/garden/parse.ts`, `src/garden/types.ts`, `src/garden/validate.ts`, `test/garden/parse.test.ts`, `test/garden/validate.test.ts`

**Tasks:**
- [ ] Add node attribute fields to `GardenNode`: `llmModel?`, `llmProvider?`, `reasoningEffort?`, `autoStatus?` (boolean), `fidelity?`, `threadId?`.
- [ ] Parse `class` attribute as comma-separated string, merge with subgraph-derived classes (deduplicated).
- [ ] Parse node attributes: `llm_model`, `llm_provider`, `reasoning_effort`, `auto_status`, `fidelity`, `thread_id`.
- [ ] Add edge attribute fields: `fidelity?`, `threadId?`. Parse them.
- [ ] Add graph attribute fields: `modelStylesheet?`, `defaultFidelity?`. Parse them.
- [ ] Add validation rules: `INVALID_REASONING_EFFORT` (must be `low`/`medium`/`high`), `UNKNOWN_LLM_PROVIDER` (must be `anthropic`/`openai`/`gemini`/`simulation`), fix `fidelity_valid` for node/edge/graph `fidelity`.
- [ ] Tests: each new attribute parsed correctly, `class` merging, validation fires on bad values.

### Phase 4: Stylesheet Parser & Resolver (~20%)

**Files:** `src/garden/stylesheet.ts` (new), `test/garden/stylesheet.test.ts` (new)

**Tasks:**
- [ ] Define types: `StylesheetSelector` (type, value, specificity), `StylesheetRule` (selector, properties, sourceOffset), `ResolvedStyle` (llmModel?, llmProvider?, reasoningEffort?).
- [ ] Implement `parseStylesheet(raw: string): { rules: StylesheetRule[], errors: Diagnostic[] }`.
  - Tokenizer: scan for selectors (`*`, identifier, `.identifier`, `#identifier`), `{`, `}`, property names, `:`, values, `;`.
  - Rule: selector `{` property-declarations `}`. Trailing `;` optional on last declaration.
  - Quoted and unquoted values.
  - Unknown properties → warning diagnostic.
  - Syntax errors → error diagnostic with source offset.
- [ ] Implement `resolveNodeStyle(rules, node): ResolvedStyle`.
  - Match: universal always, shape by `node.shape`, class by `node.classes.includes()`, id by `node.id`.
  - Sort matching rules by specificity ASC, then source order ASC.
  - Merge: iterate sorted rules, higher specificity/later order wins.
- [ ] Tests: each selector type, specificity ordering, same-specificity last-wins, malformed input, empty stylesheet, whitespace tolerance, quoted values.

### Phase 5: Transform, Pipeline Integration, Validation (~10%)

**Files:** `src/transforms/stylesheet-apply.ts` (new), `src/garden/pipeline.ts`, `src/garden/validate.ts`, `test/transforms/stylesheet-apply.test.ts` (new), `test/fixtures/stylesheet-basic.dot` (new), `test/fixtures/default-blocks.dot` (new), `test/fixtures/subgraph-classes.dot` (new)

**Tasks:**
- [ ] Implement `applyStylesheet(graph): GardenGraph` transform. Parse stylesheet, resolve per node, apply only if not already set inline.
- [ ] Register `applyStylesheet` in pipeline after `expandGoalVariables`, before validation.
- [ ] Add `stylesheet_syntax` validation rule.
- [ ] Create test fixtures and end-to-end tests.
- [ ] Regression test: existing DOT fixtures parse and validate identically.

### Phase 6: Parallel Tool Execution (~30%)

**Files:** `src/llm/tools.ts`, `src/agent-loop/session.ts`, `src/agent-loop/types.ts`, `test/agent-loop/parallel-tools.test.ts` (new), `test/llm/tools.test.ts`

**Tasks:**
- [ ] Add `ToolSafetyClassification` to `src/agent-loop/types.ts`:
  ```typescript
  type ToolSafety = 'read_only' | 'mutating';
  const TOOL_SAFETY: Record<string, ToolSafety> = {
    read_file: 'read_only',
    grep: 'read_only',
    glob: 'read_only',
    write_file: 'mutating',
    edit_file: 'mutating',
    shell: 'mutating',
  };
  ```
- [ ] Add profile options: `parallel_tool_execution: boolean` (default true for Anthropic/OpenAI profiles, false for Gemini pending testing), `max_parallel_tools: number` (default 8).
- [ ] Implement `executeToolsBatch()` in `src/llm/tools.ts`:
  - Input: array of `ToolCallData`, executor function, safety map.
  - Partition calls into read-only and mutating.
  - Execute all read-only calls concurrently via `Promise.allSettled()`.
  - Execute mutating calls sequentially (preserving order).
  - Return results array in original call order.
  - Respect `max_parallel_tools` — use a semaphore/pool for bounding concurrency.
- [ ] Modify `AgentSession.processInput()` in `src/agent-loop/session.ts`:
  - When model returns multiple tool calls and `profile.parallel_tool_execution` is true, use `executeToolsBatch()` instead of sequential loop.
  - Emit `agent_tool_call_started` / `agent_tool_call_completed` events for each call (events may interleave — this is expected).
  - Assemble all results into a single tool-results message for the next LLM turn.
- [ ] Tests:
  - Unit: `executeToolsBatch` with mixed read/mutating calls — verify read-only run concurrently, mutating run sequentially.
  - Unit: semaphore bounds concurrency to `max_parallel_tools`.
  - Unit: `parallel_tool_execution: false` falls back to fully sequential execution.
  - Integration: agent session with 4 read_file calls returns results in correct order.
  - Edge case: one tool fails — other tools still complete, error result included in batch.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/parse.ts` | Modify | Block comments, default blocks, subgraph extraction, new attribute parsing, scope stack |
| `src/garden/types.ts` | Modify | `Subgraph` type, `classes` on `GardenNode`, new node/edge/graph attribute fields |
| `src/garden/validate.ts` | Modify | `stylesheet_syntax` rule, `reasoning_effort` validation, `llm_provider` warning |
| `src/garden/stylesheet.ts` | Create | Stylesheet tokenizer, parser, selector types, specificity resolver |
| `src/garden/pipeline.ts` | Modify | Register stylesheet transform after goal expansion |
| `src/transforms/stylesheet-apply.ts` | Create | AST transform: resolve stylesheet → set node attributes |
| `src/llm/tools.ts` | Modify | `executeToolsBatch()` utility for concurrent tool execution |
| `src/agent-loop/session.ts` | Modify | Concurrent tool dispatch in `processInput()` |
| `src/agent-loop/types.ts` | Modify | `parallel_tool_execution`, `max_parallel_tools`, tool safety classification |
| `test/garden/parse.test.ts` | Modify | Block comment, default block, subgraph, new attribute tests |
| `test/garden/validate.test.ts` | Modify | Stylesheet validation, reasoning_effort, llm_provider tests |
| `test/garden/stylesheet.test.ts` | Create | Stylesheet parser + resolver unit tests |
| `test/transforms/stylesheet-apply.test.ts` | Create | End-to-end transform application tests |
| `test/agent-loop/parallel-tools.test.ts` | Create | Parallel tool execution tests |
| `test/llm/tools.test.ts` | Modify | `executeToolsBatch` unit tests |
| `test/fixtures/stylesheet-basic.dot` | Create | Fixture with model_stylesheet and mixed selectors |
| `test/fixtures/default-blocks.dot` | Create | Fixture using `node [...]` and `edge [...]` default blocks |
| `test/fixtures/subgraph-classes.dot` | Create | Fixture with subgraphs and class-based targeting |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing DOT fixtures parse and validate identically

### Block Comments (GAP-17)
- [ ] `/* ... */` block comments stripped, including multi-line
- [ ] Block comment delimiters inside string literals not treated as comments

### Default Blocks (GAP-13)
- [ ] `node [shape=box, timeout="120s"]` sets baseline attributes for subsequent nodes
- [ ] `edge [weight=0]` sets baseline attributes for subsequent edges
- [ ] Explicit attributes override defaults
- [ ] `node` and `edge` keywords no longer create spurious node entries

### Subgraphs (GAP-14)
- [ ] `subgraph cluster_X { ... }` boundaries detected and `Subgraph` records created
- [ ] Subgraph label extracted; nodes inside receive derived class
- [ ] Default blocks inside subgraphs are scoped — they don't leak out
- [ ] Nested subgraphs work

### New Attributes (GAP-27/28/29)
- [ ] Node: `class`, `llm_model`, `llm_provider`, `reasoning_effort`, `auto_status`, `fidelity`, `thread_id` parsed
- [ ] Edge: `fidelity`, `thread_id` parsed
- [ ] Graph: `model_stylesheet`, `default_fidelity` parsed

### Duration Units (GAP-20)
- [ ] `parseTimeoutMs` handles `h` and `d`

### Model Stylesheet (GAP-06, GAP-24)
- [ ] `parseStylesheet()` handles `*`, shape, `.class`, `#id` selectors
- [ ] Specificity: universal (0) < shape (1) < class (2) < id (3)
- [ ] Properties: `llm_model`, `llm_provider`, `reasoning_effort` resolved per node
- [ ] Inline node attributes override stylesheet-resolved values
- [ ] `applyStylesheet` transform runs in pipeline between goal expansion and validation

### Validation
- [ ] `stylesheet_syntax` catches malformed `model_stylesheet`
- [ ] `reasoning_effort` validated as `low`/`medium`/`high`
- [ ] `llm_provider` produces warning on unknown values

### Parallel Tool Execution (GAP-45, GAP-57)
- [ ] Multiple read-only tool calls execute concurrently in agent loop
- [ ] Mutating tool calls execute sequentially within a batch
- [ ] Concurrency bounded by `max_parallel_tools`
- [ ] `parallel_tool_execution: false` falls back to sequential
- [ ] Results returned in original call order regardless of completion order
- [ ] One tool failure doesn't prevent other tools from completing

### Test Coverage
- [ ] At least 40 new tests across stylesheet, parser, transform, parallel tools

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `@ts-graphviz/parser` already handles default blocks/subgraphs in its AST | Medium | Positive | Check library AST output first. If it extracts these, use its output. The facade pattern makes this seamless. |
| `node`/`edge` keyword detection breaks existing fixtures using them as node IDs | Medium | Medium | They're DOT reserved words. Audit all fixtures. Rename any that use them. |
| Tool safety classification too coarse — some `shell` commands are read-only | Medium | Low | Conservative default: `shell` is always `mutating`. Users who know better can override via profile. Correctness over speed. |
| Concurrent tool events interleave in event stream | Low | Low | Events already include tool_call_id. Renderer can correlate. Document that events may interleave when parallel. |
| Stylesheet string escaping conflicts with DOT string quoting | Medium | Medium | Parser already strips outer quotes. Parse stylesheet from unquoted value. Test with edge cases. |
| Sprint is too large — two clusters are ambitious | Medium | Medium | Clusters are independent. If behind schedule, **cut Phase 6 (parallel tools)** — the authoring cluster ships alone as a complete, valuable sprint. Parallel tools move to Sprint 009. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| (no new packages) | Both clusters are pure internal logic | N/A |

Zero new runtime or dev dependencies. The authoring cluster touches `src/garden/` and `src/transforms/`. The parallel tools cluster touches `src/llm/` and `src/agent-loop/`. No overlap.

---

## GAP Closure Summary

| GAP | Description | Priority | Status After Sprint |
|-----|-------------|----------|-------------------|
| GAP-06 | Model Stylesheet | MEDIUM | **Closed** |
| GAP-13 | Node/Edge Default Blocks | MEDIUM | **Closed** |
| GAP-14 | Subgraph Support | MEDIUM | **Closed** |
| GAP-17 | Block Comment Stripping | LOW | **Closed** |
| GAP-20 | Duration `h` and `d` Units | LOW | **Closed** |
| GAP-24 | Stylesheet Application Transform | MEDIUM | **Closed** |
| GAP-27 | Missing Node Attributes | LOW | **Closed** (all 7 parsed) |
| GAP-28 | Missing Edge Attributes (partial) | LOW | **Partially closed** (`fidelity`, `thread_id`) |
| GAP-29 | Missing Graph Attributes (partial) | LOW | **Partially closed** (`model_stylesheet`, `default_fidelity`) |
| GAP-45 | Parallel Tool Exec — Agent Loop | MEDIUM | **Closed** |
| GAP-57 | Parallel Tool Exec — LLM SDK | MEDIUM | **Closed** |

**6 MEDIUM + 3 LOW gaps fully closed. 2 LOW gaps partially closed.**

Projected completion after sprint:
- Attractor DOT Parsing: ~80% → **~95%**
- Attractor Model Stylesheet: 0% → **100%**
- Attractor Transforms: ~25% → **~60%**
- Unified LLM Tool Calling: ~30% → **~55%**
- Coding Agent Loop Tool Execution: ~75% → **~90%**
- **Overall across all three specs: ~58% → ~65%**
