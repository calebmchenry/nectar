# Sprint 010: Model Stylesheet, Extended Attributes & Parallel Tool Execution

## Overview

**Goal:** Close two independent but high-impact clusters of gaps in one sprint: (1) the DOT authoring layer — model stylesheets, extended node/edge/graph attributes, and validation — so pipeline authors get real multi-model control without per-node boilerplate, and (2) parallel tool execution in the agent loop — so codergen nodes stop sequentially executing tool calls that could run concurrently. One unlocks pipeline *authoring*, the other unlocks pipeline *performance*.

**Why these two clusters, why now:**

Sprint 008 shipped the foundational DOT parser improvements (block comments, default blocks, subgraphs, duration units) and the Seedbed filesystem. Sprint 009 extended stylesheets, runtime attributes, and parallel tools. But the compliance report still shows significant gaps:

| Cluster | Gaps | Impact |
|---------|------|--------|
| **Authoring layer** | GAP-06 (stylesheet, partial), GAP-24 (stylesheet transform), GAP-27/28/29 (missing attrs) | Pipeline authors still lack a complete stylesheet system with 4 selector types and specificity resolution. Several node/edge/graph attributes remain unparsed. |
| **Agent performance** | GAP-45 (parallel tool exec in agent loop), GAP-57 (parallel tool exec in LLM SDK) | When Claude returns multiple tool calls in one response, they execute sequentially. Real-world codergen tasks spend 60-80% of time in tool execution — parallelism cuts this dramatically. |

These clusters are **completely independent** — different files, different test suites, zero shared state. They can be developed and reviewed in parallel.

The authoring cluster is pure parsing/transform/validation — the most testable, lowest-risk category of work. The parallel tool cluster is a focused concurrency change with clear boundaries. Neither requires new npm dependencies or external API calls in tests.

**Scope — what ships:**

*Authoring cluster:*
- Model stylesheet parser with 4 selector types (`*`, shape, `.class`, `#id`) and specificity resolution (GAP-06)
- Stylesheet application AST transform (GAP-24)
- Extended node attributes: `class`, `llm_model`, `llm_provider`, `reasoning_effort`, `auto_status`, `fidelity`, `thread_id` (GAP-27)
- Extended edge attributes: `fidelity`, `thread_id` (GAP-28 partial)
- Extended graph attributes: `model_stylesheet`, `default_fidelity` (GAP-29 partial)
- `stylesheet_syntax` validation rule
- `reasoning_effort` and `llm_provider` value validation
- Runtime plumbing: stylesheet-resolved `llm_provider` and `reasoning_effort` forwarded through `CodergenHandler` → `AgentSession` → `UnifiedClient.stream()`

*Performance cluster:*
- Concurrent tool execution in `AgentSession.processInput()` with read-only/mutating safety classification (GAP-45)
- Concurrent tool call packaging in the LLM SDK layer (GAP-57)

**Scope — what doesn't ship:**

- Context fidelity runtime (GAP-07) — attributes parsed/validated, modes not enforced at runtime
- Preamble transform (GAP-25) — depends on fidelity runtime
- Manager loop handler (GAP-04) — independent engine feature, needs child pipeline design
- Steering / subagents (GAP-40, GAP-41) — separate sprint
- Prompt caching auto-injection (GAP-53) — valuable but Anthropic-only; deferred to Sprint 011
- Context window awareness (GAP-44) — useful but LOW priority; deferred to Sprint 011
- Seedbed swarm analysis — the seedbed filesystem must stabilize first
- `apply_patch` tool for OpenAI profile (GAP-43) — lower priority

**Cut-line:** If behind schedule, **cut Phase 5 (parallel tools)** — the authoring cluster ships alone as a complete, valuable sprint. Parallel tools move to Sprint 011.

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
   Each node in the subgraph inherits class `drafts` and gets routed to Anthropic.

3. **Stylesheet-resolved values drive runtime:** After `applyStylesheet`, `CodergenHandler` reads the resolved `llm_provider` and `reasoning_effort` and passes them through to `UnifiedClient.stream()`. A single stylesheet rule change reroutes an entire class of nodes to a different provider.

4. **Fast codebase research:** A codergen agent investigating a bug returns 5 `grep` calls and 2 `read_file` calls in one response. With parallel tool execution, all 7 run concurrently — the round-trip drops from ~7s (sequential) to ~1.5s (bounded by the slowest call).

5. **Validation catches stylesheet typos early:**
   ```
   $ pollinator validate pipeline.dot
   pipeline.dot:3: error[STYLESHEET_SYNTAX]: Unexpected token 'llm_model' — missing ':' after property name
   ```

6. **Mixed tool batches stay correct:** An agent returns `read_file("a.ts")`, `write_file("b.ts", ...)`, `read_file("c.ts")`. The read-only calls run concurrently, but the write executes in its original position relative to surrounding reads. The second `read_file` does not race with the `write_file`.

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

**Duplicate rules:** If two rules have identical specificity, the later occurrence in the stylesheet string wins (CSS "last declaration wins" semantics).

**Parse error behavior:** When `parseStylesheet` encounters syntax errors, it returns both an `errors` array and a `rules` array containing only the successfully parsed rules. The `stylesheet_syntax` validation rule surfaces errors to the user. Partially valid stylesheets apply only their valid rules — this is fail-open on a per-rule basis, fail-loud at the validation layer.

### Parallel Tool Execution

**Agent loop layer** (`src/agent-loop/session.ts`): When the model returns N tool calls, `processInput()` dispatches them using `executeToolsBatch()`. Results are collected, ordered by original call order, and appended as a single tool-results message. Sequential fallback when `profile.parallel_tool_execution === false`.

**Key invariant — tool safety classification:**

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

Read-only tools are parallelizable. Mutating tools execute sequentially, preserving declaration order. Critically, this preserves ordering across interleaved read/write sequences: `[read, write, read]` does NOT become `[read+read in parallel, then write]`. Instead, execution runs as: `read` (parallel-safe), then `write` (sequential barrier), then `read` (parallel-safe). The write acts as a fence.

**Key invariant — result ordering:** Both OpenAI and Anthropic require tool results to match tool call ordering exactly. After concurrent execution, results are re-assembled in the original call order.

**Failure isolation:** `Promise.allSettled()` (not `Promise.all()`). One failing tool does not crash the batch. Failed tools return structured error results.

**Concurrency bounding:** A semaphore limits concurrent execution to `max_parallel_tools` (default 8).

### Module Layout — New/Modified Files

```
src/garden/
  parse.ts              MODIFY — new attribute parsing
  types.ts              MODIFY — new node/edge/graph attribute fields
  validate.ts           MODIFY — stylesheet_syntax rule, new validations
  stylesheet.ts         CREATE — parser, types, specificity resolver
  pipeline.ts           MODIFY — register stylesheet transform

src/transforms/
  stylesheet-apply.ts   CREATE — AST transform applying resolved styles to nodes

src/handlers/
  codergen.ts           MODIFY — forward stylesheet-resolved llm_provider/reasoning_effort

src/agent-loop/
  session.ts            MODIFY — concurrent tool dispatch
  types.ts              MODIFY — parallel_tool_execution, max_parallel_tools, tool safety
  provider-profiles.ts  MODIFY — parallel_tool_execution per-provider defaults

src/llm/
  tools.ts              MODIFY — executeToolsBatch() utility
```

### Data Flow (Authoring Cluster)

```
DOT source
    |-- (existing parse pipeline from Sprint 008)
    v
GardenGraph                     (defaults applied, classes assigned)
    |-- expandGoalVariables()   (existing)
    |-- applyStylesheet()       NEW: resolve model_stylesheet → per-node llm config
    v
GardenGraph                     (stylesheet-resolved)
    |-- validate()              ENHANCED: stylesheet_syntax, reasoning_effort, llm_provider
    v
Ready for engine
    |
    v
CodergenHandler                 reads resolved llm_provider, llm_model, reasoning_effort
    |                           passes to AgentSession → UnifiedClient.stream()
    v
Runtime execution with correct provider/model/effort
```

---

## Implementation

### Phase 1: New Attributes & Validation (~20%)

**Files:** `src/garden/parse.ts`, `src/garden/types.ts`, `src/garden/validate.ts`, `test/garden/parse.test.ts`, `test/garden/validate.test.ts`

**Tasks:**
- [ ] Add node attribute fields to `GardenNode`: `llmModel?`, `llmProvider?`, `reasoningEffort?`, `autoStatus?` (boolean), `fidelity?`, `threadId?`.
- [ ] Parse `class` attribute as comma-separated string, merge with subgraph-derived classes (deduplicated). Handle class labels that contain spaces or punctuation by normalizing to lowercase alphanumeric with hyphens.
- [ ] Parse node attributes: `llm_model`, `llm_provider`, `reasoning_effort`, `auto_status`, `fidelity`, `thread_id`.
- [ ] Add edge attribute fields: `fidelity?`, `threadId?`. Parse them.
- [ ] Add graph attribute fields: `modelStylesheet?`, `defaultFidelity?`. Parse them.
- [ ] Add validation rules: `INVALID_REASONING_EFFORT` (must be `low`/`medium`/`high`), `UNKNOWN_LLM_PROVIDER` (must be `anthropic`/`openai`/`gemini`/`simulation`), `fidelity_valid` for node/edge/graph.
- [ ] Handle quoted node IDs named `node`, `edge`, or `subgraph` — these must not be broken by reserved keyword detection from Sprint 008.
- [ ] Tests: each new attribute parsed correctly, `class` merging with subgraph-derived classes, class normalization, validation fires on bad values, quoted reserved-word node IDs.

### Phase 2: Stylesheet Parser & Resolver (~25%)

**Files:** `src/garden/stylesheet.ts` (new), `test/garden/stylesheet.test.ts` (new)

**Tasks:**
- [ ] Define types: `StylesheetSelector` (type, value, specificity), `StylesheetRule` (selector, properties, sourceOffset), `ResolvedStyle` (llmModel?, llmProvider?, reasoningEffort?).
- [ ] Implement `parseStylesheet(raw: string): { rules: StylesheetRule[], errors: Diagnostic[] }`.
  - Tokenizer: scan for selectors (`*`, identifier, `.identifier`, `#identifier`), `{`, `}`, property names, `:`, values, `;`.
  - Rule: selector `{` property-declarations `}`. Trailing `;` optional on last declaration.
  - Quoted and unquoted values.
  - Unknown properties → warning diagnostic.
  - Syntax errors → error diagnostic with source offset. Skip to next `}` or `{` and continue parsing.
  - Return both valid rules and errors — partial parsing is expected.
- [ ] Implement `resolveNodeStyle(rules, node): ResolvedStyle`.
  - Match: universal always, shape by `node.shape`, class by `node.classes.includes()`, id by `node.id`.
  - Sort matching rules by specificity ASC, then source order ASC.
  - Merge: iterate sorted rules, higher specificity/later order wins.
- [ ] Tests: each selector type, specificity ordering, same-specificity last-wins, duplicate rules, malformed input (partial parse succeeds for valid rules), empty stylesheet, whitespace tolerance, quoted values, stylesheet with DOT string escaping.

### Phase 3: Transform, Pipeline Integration, Validation (~15%)

**Files:** `src/transforms/stylesheet-apply.ts` (new), `src/garden/pipeline.ts`, `src/garden/validate.ts`, `test/transforms/stylesheet-apply.test.ts` (new), `test/fixtures/stylesheet-basic.dot` (new)

**Tasks:**
- [ ] Implement `applyStylesheet(graph): GardenGraph` transform. Parse stylesheet, resolve per node, apply only if not already set inline.
- [ ] Register `applyStylesheet` in pipeline after `expandGoalVariables`, before validation.
- [ ] Add `stylesheet_syntax` validation rule: runs `parseStylesheet`, surfaces any errors as diagnostics.
- [ ] Create test fixtures and end-to-end tests.
- [ ] Regression test: existing DOT fixtures parse and validate identically.

### Phase 4: Runtime Plumbing (~10%)

**Files:** `src/handlers/codergen.ts`, `src/agent-loop/session.ts`, `test/handlers/codergen.test.ts`, `test/integration/agent-loop.test.ts`

**Tasks:**
- [ ] Update `CodergenHandler` to read stylesheet-resolved `llmProvider`, `llmModel`, and `reasoningEffort` from the node.
- [ ] Forward these values through `AgentSession` into `UnifiedClient.stream()` call parameters.
- [ ] End-to-end test: a DOT fixture with `model_stylesheet` setting `llm_provider` on a codergen node → verify the scripted adapter receives the correct provider/model/reasoning_effort in the stream request.
- [ ] Tests: default behavior when no stylesheet is present (existing behavior unchanged).

### Phase 5: Parallel Tool Execution (~30%)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/types.ts`, `src/agent-loop/provider-profiles.ts`, `src/llm/tools.ts`, `test/agent-loop/parallel-tools.test.ts` (new), `test/llm/tools.test.ts`

**Tasks:**
- [ ] Add `ToolSafetyClassification` to `src/agent-loop/types.ts`.
- [ ] Add profile options to `src/agent-loop/provider-profiles.ts`: `parallel_tool_execution: boolean` (default true for Anthropic/OpenAI, false for Gemini pending testing), `max_parallel_tools: number` (default 8).
- [ ] Implement `executeToolsBatch()` in `src/llm/tools.ts`:
  - Input: array of `ToolCallData`, executor function, safety map, max concurrency.
  - Preserve execution order semantics: process calls left-to-right; consecutive read-only calls form a parallel group; a mutating call acts as a sequential fence.
  - Execute parallel groups via `Promise.allSettled()`.
  - Return results array in original call order.
  - Respect `max_parallel_tools` via semaphore.
- [ ] Modify `AgentSession.processInput()`:
  - When model returns multiple tool calls and `profile.parallel_tool_execution` is true, use `executeToolsBatch()`.
  - Emit `agent_tool_call_started` / `agent_tool_call_completed` events (events may interleave; `tool_call_id` enables correlation).
  - Assemble results into a single tool-results message, strictly matching original call order.
  - Ensure transcript and tool-artifact numbering remains deterministic (use original call index, not completion order).
- [ ] Tests:
  - Unit: `executeToolsBatch` with mixed read/mutating calls — verify read-only run concurrently, mutating calls act as fences.
  - Unit: interleaved `[read, write, read]` — second read does NOT race with write.
  - Unit: semaphore bounds concurrency to `max_parallel_tools`.
  - Unit: `parallel_tool_execution: false` falls back to fully sequential execution.
  - Integration: agent session with 4 `read_file` calls returns results in correct order.
  - Edge case: one tool fails — other tools still complete, error result included in batch.
  - Edge case: zero tool calls — parallel execution path gracefully no-ops.
  - Edge case: abort signal arrives mid-batch — running tools are cancelled, partial results preserved.
  - Edge case: malformed tool arguments — error result for that tool, others proceed.
  - Verify: transcript `tool-calls/NNN-*` numbering matches original call order, not completion order.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/parse.ts` | Modify | New attribute parsing, class normalization |
| `src/garden/types.ts` | Modify | New node/edge/graph attribute fields |
| `src/garden/validate.ts` | Modify | `stylesheet_syntax` rule, `reasoning_effort` validation, `llm_provider` warning |
| `src/garden/stylesheet.ts` | Create | Stylesheet tokenizer, parser, selector types, specificity resolver |
| `src/garden/pipeline.ts` | Modify | Register stylesheet transform after goal expansion |
| `src/transforms/stylesheet-apply.ts` | Create | AST transform: resolve stylesheet → set node attributes |
| `src/handlers/codergen.ts` | Modify | Forward stylesheet-resolved provider/model/effort to session |
| `src/agent-loop/session.ts` | Modify | Concurrent tool dispatch in `processInput()` |
| `src/agent-loop/types.ts` | Modify | `parallel_tool_execution`, `max_parallel_tools`, tool safety classification |
| `src/agent-loop/provider-profiles.ts` | Modify | Per-provider parallel execution defaults |
| `src/llm/tools.ts` | Modify | `executeToolsBatch()` utility for concurrent tool execution |
| `test/garden/parse.test.ts` | Modify | New attribute, class normalization tests |
| `test/garden/validate.test.ts` | Modify | Stylesheet validation, reasoning_effort, llm_provider tests |
| `test/garden/stylesheet.test.ts` | Create | Stylesheet parser + resolver unit tests |
| `test/transforms/stylesheet-apply.test.ts` | Create | End-to-end transform application tests |
| `test/handlers/codergen.test.ts` | Modify | Verify provider/model forwarding from stylesheet |
| `test/agent-loop/parallel-tools.test.ts` | Create | Parallel tool execution tests |
| `test/llm/tools.test.ts` | Modify | `executeToolsBatch` unit tests |
| `test/integration/agent-loop.test.ts` | Modify | End-to-end stylesheet → codergen runtime test |
| `test/fixtures/stylesheet-basic.dot` | Create | Fixture with model_stylesheet and mixed selectors |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing DOT fixtures parse and validate identically

### New Attributes (GAP-27/28/29)
- [ ] Node: `class`, `llm_model`, `llm_provider`, `reasoning_effort`, `auto_status`, `fidelity`, `thread_id` parsed
- [ ] Edge: `fidelity`, `thread_id` parsed
- [ ] Graph: `model_stylesheet`, `default_fidelity` parsed
- [ ] `class` attribute merges with subgraph-derived classes (deduplicated, normalized)
- [ ] Quoted reserved-word node IDs (`"node"`, `"edge"`) still parse correctly

### Model Stylesheet (GAP-06, GAP-24)
- [ ] `parseStylesheet()` handles `*`, shape, `.class`, `#id` selectors
- [ ] Specificity: universal (0) < shape (1) < class (2) < id (3)
- [ ] Properties: `llm_model`, `llm_provider`, `reasoning_effort` resolved per node
- [ ] Inline node attributes override stylesheet-resolved values
- [ ] Partial parse: syntax errors surface as diagnostics, valid rules still apply
- [ ] `applyStylesheet` transform runs in pipeline between goal expansion and validation

### Validation
- [ ] `stylesheet_syntax` catches malformed `model_stylesheet` and surfaces errors
- [ ] `reasoning_effort` validated as `low`/`medium`/`high`
- [ ] `llm_provider` produces warning on unknown values

### Runtime Plumbing
- [ ] Stylesheet-resolved `llm_provider`, `llm_model`, and `reasoning_effort` are forwarded through `CodergenHandler` → `AgentSession` → `UnifiedClient.stream()`
- [ ] End-to-end test proves stylesheet routing changes the provider/model used by codergen

### Parallel Tool Execution (GAP-45, GAP-57)
- [ ] Multiple read-only tool calls execute concurrently in agent loop
- [ ] Mutating tool calls act as sequential fences — no reordering across read/write boundaries
- [ ] Concurrency bounded by `max_parallel_tools`
- [ ] `parallel_tool_execution: false` falls back to sequential
- [ ] Results returned in original call order regardless of completion order
- [ ] One tool failure doesn't prevent other tools from completing (`Promise.allSettled`)
- [ ] Tool results correctly re-aggregated matching provider ordering requirements
- [ ] Transcript and tool-artifact numbering is deterministic (original call order)
- [ ] Abort during parallel batch cancels running tools and preserves partial results

### Test Coverage
- [ ] At least 35 new tests across stylesheet, parser, transform, runtime plumbing, parallel tools

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Stylesheet string escaping conflicts with DOT string quoting | Medium | Medium | Parser already strips outer quotes. Parse stylesheet from unquoted value. Test with edge cases including embedded quotes. |
| Subgraph-derived class labels collide or contain spaces/punctuation | Medium | Low | Normalize class names to lowercase alphanumeric with hyphens. Document normalization rules. Test collision cases. |
| Tool safety classification too coarse — some `shell` commands are read-only | Medium | Low | Conservative default: `shell` is always `mutating`. Correctness over speed. |
| Mixed tool batches reordered incorrectly | Medium | High | Fence-based execution: mutating calls are sequential barriers. Extensive tests for interleaved read/write sequences. |
| Concurrent tool events interleave in event stream | Low | Low | Events include `tool_call_id`. Renderer correlates. Transcript numbering uses original call order. |
| Sprint is too large — two clusters are ambitious | Medium | Medium | Clusters are independent. If behind schedule, **cut Phase 5 (parallel tools)** — authoring cluster ships alone. |
| Parallel `read_file`/`grep` calls return massive data | Low | Medium | Existing per-tool truncation limits bound individual results. Context window awareness deferred to Sprint 011. |
| Stylesheet parse errors leave graph in ambiguous state | Medium | Medium | Explicit fail-open per-rule / fail-loud at validation. Document and test partial-parse behavior. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| Sprint 008 parser work | Block comments, default blocks, subgraphs, scope stack | Prerequisite |
| Sprint 009 stylesheet/attribute foundation | Initial type definitions, partial implementation | Prerequisite |
| (no new packages) | Both clusters are pure internal logic | N/A |

Zero new runtime or dev dependencies. The authoring cluster touches `src/garden/` and `src/transforms/`. The parallel tools cluster touches `src/llm/` and `src/agent-loop/`. Overlap only at `src/handlers/codergen.ts` (runtime plumbing).

---

## GAP Closure Summary

| GAP | Description | Priority | Status After Sprint |
|-----|-------------|----------|-------------------|
| GAP-06 | Model Stylesheet | MEDIUM | **Closed** |
| GAP-24 | Stylesheet Application Transform | MEDIUM | **Closed** |
| GAP-27 | Missing Node Attributes | LOW | **Closed** (all 7 parsed) |
| GAP-28 | Missing Edge Attributes (partial) | LOW | **Partially closed** (`fidelity`, `thread_id`) |
| GAP-29 | Missing Graph Attributes (partial) | LOW | **Partially closed** (`model_stylesheet`, `default_fidelity`) |
| GAP-45 | Parallel Tool Exec — Agent Loop | MEDIUM | **Closed** |
| GAP-57 | Parallel Tool Exec — LLM SDK | MEDIUM | **Closed** |

**4 MEDIUM gaps fully closed. 1 LOW gap fully closed. 2 LOW gaps partially closed.**
