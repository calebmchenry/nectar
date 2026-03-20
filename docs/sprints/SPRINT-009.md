# Sprint 009: Model Stylesheets, Runtime Attributes & Parallel Tool Execution

## Overview

**Goal:** Close the authoring-layer gap that prevents multi-model pipeline control, forward parsed node attributes all the way to execution, and make codergen agent tool calls run concurrently. After this sprint, a pipeline author can write one `model_stylesheet` to route different nodes to different LLM providers, and a codergen agent's batch of `grep`/`read_file` calls executes in parallel instead of sequentially.

**Why these two clusters, why now:**

Sprint 008 shipped the seedbed foundation and the DOT parser improvements (default blocks, subgraphs, block comments, duration units). Those parser enhancements give us the building blocks — scope stacks, class derivation, default merging — but pipeline authors still can't control which model runs which node without manually tagging every one. The model stylesheet is the missing piece that turns parser infrastructure into real multi-model routing.

Meanwhile, the coding agent loop still executes tool calls sequentially. When an agent returns 5 `grep` calls in one response, each waits for the previous to finish. This is the single largest latency bottleneck in real codergen sessions.

These clusters are **completely independent** — different directories (`src/garden/` + `src/transforms/` vs `src/llm/` + `src/agent-loop/`), different test suites, zero shared state. They can be developed and reviewed in parallel.

**Scope — what ships:**

*Authoring cluster:*
- 4 new node attributes: `class`, `llm_model`, `llm_provider`, `reasoning_effort` (GAP-27 partial)
- 2 new graph attributes: `model_stylesheet`, `default_fidelity` (GAP-29 partial)
- Model stylesheet parser with 4 selector types and specificity resolution (GAP-06)
- Stylesheet application AST transform (GAP-24)
- `stylesheet_syntax` validation rule
- `reasoning_effort` and `llm_provider` value validation
- Runtime plumbing: `CodergenHandler` and `AgentSession` forward `llm_provider`, `llm_model`, and `reasoning_effort` to `UnifiedClient.stream()`

*Performance cluster:*
- Concurrent tool execution in `AgentSession.processInput()` with tool safety classification (GAP-45)
- Concurrent tool call packaging in the LLM SDK layer (GAP-57)
- Failure isolation via `Promise.allSettled()`, bounded concurrency via semaphore

**Scope — what doesn't ship:**

- Lower-value parse-only attributes (`auto_status`, `fidelity`, `thread_id`, `default_fidelity` on edges) — deferred until runtime behavior exists to drive them
- Prompt caching auto-injection (GAP-53) — Anthropic-only, independent optimization
- Context window awareness (GAP-44) — the token-sum heuristic needs more design to avoid noisy warnings
- Seedbed swarm analysis (`pollinator swarm`) — LLM output normalization needs focused design
- Preamble transform (GAP-25), context fidelity runtime (GAP-07)
- Manager loop (GAP-04), steering/subagents (GAP-40/41)

---

## Use Cases

1. **Multi-model pipeline via stylesheet:** A pipeline has 8 codergen nodes. Instead of tagging each one, the author writes one stylesheet:
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
   All `box` nodes default to Sonnet. `deep_review` overrides to Opus with high reasoning.

2. **Class-based routing via subgraphs:** Three draft nodes grouped in a subgraph (using Sprint 008's subgraph extraction):
   ```dot
   subgraph cluster_drafts {
     label="drafts"
     claude_draft; gemini_draft; codex_draft;
   }
   model_stylesheet=".drafts { llm_provider: anthropic; llm_model: claude-sonnet-4-20250514 }"
   ```
   Each node inherits class `drafts` and gets routed to Anthropic. Changing providers for all three means editing one stylesheet rule.

3. **Stylesheet resolves to actual execution:** The `llm_provider` and `llm_model` resolved by the stylesheet are forwarded through `CodergenHandler` into `AgentSession` and down to `UnifiedClient.stream()`. This isn't just parsed metadata — it changes which API gets called.

4. **Fast codebase research:** A codergen agent investigating a bug returns 5 `grep` calls and 2 `read_file` calls in one response. All 7 run concurrently — round-trip drops from ~7s to ~1.5s.

5. **Safe mutation ordering:** The same agent returns `read_file("a.ts")`, `write_file("b.ts")`, `read_file("c.ts")`. Read-only calls run concurrently, but the write executes in its original position in the sequence to preserve correctness.

6. **Validation catches stylesheet typos early:**
   ```
   $ pollinator validate pipeline.dot
   pipeline.dot:3: error[STYLESHEET_SYNTAX]: Unexpected token 'llm_model' — missing ':' after property name
   ```

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

**Stylesheet parse-error behavior:** Syntax errors in the stylesheet produce error diagnostics. If the stylesheet contains *both* valid rules and syntax errors, the valid rules are still applied and the errors are surfaced via validation. This prevents a single typo from silently disabling all model routing.

### Runtime Plumbing

Sprint 008 parses `llm_model`, `llm_provider`, and `reasoning_effort` on nodes. This sprint ensures those values flow through execution:

```
GardenNode.llmProvider / llmModel / reasoningEffort
    |
    v
CodergenHandler.handle()
    |-- reads resolved attributes from node
    |-- passes to AgentSession or UnifiedClient
    v
AgentSession.processInput()
    |-- overrides provider/model from node config
    v
UnifiedClient.stream()
    |-- routes to correct adapter with model + reasoning_effort
```

`src/agent-loop/provider-profiles.ts` already defines per-provider defaults. This sprint adds the ability for node-level attributes to override those defaults.

### Parallel Tool Execution

**Tool safety classification:**

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

**Execution strategy — order-preserving partitioned dispatch:**

Given a batch of tool calls `[t1, t2, t3, t4, t5]`, the executor partitions into contiguous runs of read-only and mutating calls, then processes each run:

- Read-only run → execute all concurrently via `Promise.allSettled()`, bounded by `max_parallel_tools` semaphore
- Mutating run → execute sequentially, in order

This preserves ordering semantics for interleaved sequences like `[read, read, write, read, read]` → `[parallel(read, read), sequential(write), parallel(read, read)]`. The second batch of reads observes the write.

**Two layers:**

- **LLM SDK layer** (`src/llm/tools.ts`): `executeToolsBatch()` utility implementing the partitioned dispatch above.
- **Agent loop layer** (`src/agent-loop/session.ts`): When model returns N tool calls and `profile.parallel_tool_execution` is true, uses `executeToolsBatch()`. Falls back to sequential when false.

### Module Layout — New/Modified Files

```
src/garden/
  types.ts              MODIFY — new node/graph attribute fields
  parse.ts              MODIFY — parse new attributes
  validate.ts           MODIFY — stylesheet_syntax, reasoning_effort, llm_provider validation
  stylesheet.ts         CREATE — parser, types, specificity resolver
  pipeline.ts           MODIFY — register stylesheet transform

src/transforms/
  stylesheet-apply.ts   CREATE — AST transform applying resolved styles to nodes

src/handlers/
  codergen.ts           MODIFY — forward llm_provider/llm_model/reasoning_effort

src/agent-loop/
  session.ts            MODIFY — accept node-level provider overrides, concurrent tool dispatch
  types.ts              MODIFY — parallel_tool_execution, max_parallel_tools, tool safety
  provider-profiles.ts  MODIFY — expose override mechanism for node-level config

src/llm/
  tools.ts              MODIFY — executeToolsBatch() utility
```

---

## Implementation

### Phase 1: New Attributes & Attribute Parsing (~15%)

**Files:** `src/garden/parse.ts`, `src/garden/types.ts`, `src/garden/validate.ts`, `test/garden/parse.test.ts`, `test/garden/validate.test.ts`

**Tasks:**
- [ ] Add node attribute fields to `GardenNode`: `llmModel?`, `llmProvider?`, `reasoningEffort?`
- [ ] Parse `class` attribute as comma-separated string, merge with subgraph-derived classes (deduplicated)
- [ ] Parse node attributes: `llm_model`, `llm_provider`, `reasoning_effort`
- [ ] Add graph attribute field: `modelStylesheet?`. Parse it.
- [ ] Add validation rules: `INVALID_REASONING_EFFORT` (must be `low`/`medium`/`high`), `UNKNOWN_LLM_PROVIDER` (must be `anthropic`/`openai`/`gemini`/`simulation`)
- [ ] Ensure `node` and `edge` keywords in attribute names don't collide with default block detection from Sprint 008
- [ ] Tests: each new attribute parsed correctly, `class` merging with subgraph-derived classes, validation fires on bad values

### Phase 2: Stylesheet Parser & Resolver (~25%)

**Files:** `src/garden/stylesheet.ts` (new), `test/garden/stylesheet.test.ts` (new)

**Tasks:**
- [ ] Define types: `StylesheetSelector` (type, value, specificity), `StylesheetRule` (selector, properties, sourceOffset), `ResolvedStyle` (llmModel?, llmProvider?, reasoningEffort?)
- [ ] Implement `parseStylesheet(raw: string): { rules: StylesheetRule[], errors: Diagnostic[] }`
  - Tokenizer: scan for selectors (`*`, identifier, `.identifier`, `#identifier`), `{`, `}`, property names, `:`, values, `;`
  - Rule: selector `{` property-declarations `}`. Trailing `;` optional on last declaration
  - Quoted and unquoted values
  - Unknown properties → warning diagnostic
  - Syntax errors → error diagnostic with source offset
  - On mixed valid/invalid rules: parse what's valid, report errors for the rest
- [ ] Implement `resolveNodeStyle(rules, node): ResolvedStyle`
  - Match: universal always, shape by `node.shape`, class by `node.classes.includes()`, id by `node.id`
  - Sort matching rules by specificity ASC, then source order ASC
  - Merge: iterate sorted rules, higher specificity/later order wins
- [ ] Tests: each selector type, specificity ordering, same-specificity last-wins, malformed input, partial parse recovery, empty stylesheet, whitespace tolerance, quoted values, DOT string escaping edge cases

### Phase 3: Stylesheet Transform & Pipeline Integration (~10%)

**Files:** `src/transforms/stylesheet-apply.ts` (new), `src/garden/pipeline.ts`, `src/garden/validate.ts`, `test/transforms/stylesheet-apply.test.ts` (new), `test/fixtures/stylesheet-basic.dot` (new)

**Tasks:**
- [ ] Implement `applyStylesheet(graph): GardenGraph` transform. Parse stylesheet, resolve per node, apply only if not already set inline
- [ ] Register `applyStylesheet` in pipeline after `expandGoalVariables`, before validation
- [ ] Add `stylesheet_syntax` validation rule that catches malformed `model_stylesheet` values
- [ ] Create test fixtures and end-to-end parse-transform-validate tests
- [ ] Regression test: existing DOT fixtures parse and validate identically

### Phase 4: Runtime Plumbing — Attributes to Execution (~15%)

**Files:** `src/handlers/codergen.ts`, `src/agent-loop/session.ts`, `src/agent-loop/provider-profiles.ts`, `test/handlers/codergen.test.ts`, `test/integration/stylesheet-runtime.test.ts` (new)

**Tasks:**
- [ ] Modify `CodergenHandler.handle()` to read `llmProvider`, `llmModel`, and `reasoningEffort` from the resolved node
- [ ] Pass these values into `AgentSession` (or directly to `UnifiedClient`) as overrides to the provider profile defaults
- [ ] Modify `AgentSession.processInput()` to accept and forward provider/model/reasoning_effort overrides
- [ ] Ensure `UnifiedClient.stream()` uses the overridden values when routing to adapters
- [ ] End-to-end test: a DOT file with `model_stylesheet` → `CodergenHandler` → verify the correct provider/model is selected (using simulation provider to avoid real API calls)
- [ ] Test: node with inline `llm_provider` overrides stylesheet-resolved value

### Phase 5: Parallel Tool Execution (~25%)

**Files:** `src/llm/tools.ts`, `src/agent-loop/session.ts`, `src/agent-loop/types.ts`, `src/agent-loop/provider-profiles.ts`, `test/agent-loop/parallel-tools.test.ts` (new), `test/llm/tools.test.ts`

**Tasks:**
- [ ] Add `ToolSafetyClassification` to `src/agent-loop/types.ts` with `read_only` and `mutating` categories
- [ ] Add profile options: `parallel_tool_execution: boolean` (default true for Anthropic/OpenAI, false for Gemini), `max_parallel_tools: number` (default 8)
- [ ] Implement `executeToolsBatch()` in `src/llm/tools.ts`:
  - Partition call sequence into contiguous runs of read-only and mutating calls
  - Execute read-only runs concurrently via `Promise.allSettled()`, bounded by semaphore
  - Execute mutating runs sequentially, preserving original order
  - Return results array in original call order
- [ ] Modify `AgentSession.processInput()`:
  - When model returns multiple tool calls and `profile.parallel_tool_execution` is true, use `executeToolsBatch()`
  - Emit `agent_tool_call_started` / `agent_tool_call_completed` events (may interleave)
  - Assemble results into a single tool-results message, preserving tool_call_id ordering for provider compliance
  - When `parallel_tool_execution` is false, fall back to fully sequential execution
- [ ] Handle abort: if session is aborted mid-batch, cancel pending calls where possible
- [ ] Tests:
  - `executeToolsBatch` with mixed read/mutating calls — verify read-only run concurrently, mutating run sequentially
  - Semaphore bounds concurrency to `max_parallel_tools`
  - `parallel_tool_execution: false` falls back to sequential
  - Interleaved sequence `[read, read, write, read]` preserves write ordering
  - One tool fails — other tools still complete, error result included in batch
  - Results returned in original call order regardless of completion order
  - Tool result ordering matches tool call ordering (provider compliance)

### Phase 6: Integration Testing & Finish Quality (~10%)

**Files:** various test files

**Tasks:**
- [ ] Run the full test suite and confirm zero regressions
- [ ] Verify existing DOT fixtures parse and validate identically
- [ ] End-to-end test: DOT file with stylesheet → parse → transform → codergen handler → verify provider/model selection
- [ ] End-to-end test: agent session with 4 read_file calls → verify parallel execution and correct result ordering
- [ ] Verify transcript/tool-artifact serialization is deterministic under concurrent tool completion
- [ ] `npm run build && npm test` as final gate

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/garden/parse.ts` | Modify | Parse `llm_model`, `llm_provider`, `reasoning_effort`, `class`, `model_stylesheet` |
| `src/garden/types.ts` | Modify | New node attribute fields, graph `modelStylesheet` field |
| `src/garden/validate.ts` | Modify | `stylesheet_syntax`, `reasoning_effort`, `llm_provider` validation |
| `src/garden/stylesheet.ts` | Create | Stylesheet tokenizer, parser, selector types, specificity resolver |
| `src/garden/pipeline.ts` | Modify | Register stylesheet transform after goal expansion |
| `src/transforms/stylesheet-apply.ts` | Create | AST transform: resolve stylesheet → set node attributes |
| `src/handlers/codergen.ts` | Modify | Forward `llm_provider`/`llm_model`/`reasoning_effort` to agent session |
| `src/agent-loop/session.ts` | Modify | Accept provider overrides, concurrent tool dispatch |
| `src/agent-loop/types.ts` | Modify | `parallel_tool_execution`, `max_parallel_tools`, tool safety classification |
| `src/agent-loop/provider-profiles.ts` | Modify | Node-level config override mechanism |
| `src/llm/tools.ts` | Modify | `executeToolsBatch()` utility with partitioned dispatch |
| `test/garden/parse.test.ts` | Modify | New attribute parsing tests |
| `test/garden/validate.test.ts` | Modify | Stylesheet validation, reasoning_effort, llm_provider tests |
| `test/garden/stylesheet.test.ts` | Create | Stylesheet parser + resolver unit tests |
| `test/transforms/stylesheet-apply.test.ts` | Create | End-to-end transform application tests |
| `test/handlers/codergen.test.ts` | Modify | Runtime plumbing tests |
| `test/agent-loop/parallel-tools.test.ts` | Create | Parallel tool execution tests |
| `test/llm/tools.test.ts` | Modify | `executeToolsBatch` unit tests |
| `test/integration/stylesheet-runtime.test.ts` | Create | End-to-end stylesheet → execution test |
| `test/fixtures/stylesheet-basic.dot` | Create | Fixture with `model_stylesheet` and mixed selectors |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing DOT fixtures parse and validate identically

### New Attributes (GAP-27/29 partial)
- [ ] Node: `class`, `llm_model`, `llm_provider`, `reasoning_effort` parsed
- [ ] Graph: `model_stylesheet` parsed
- [ ] `class` attribute merges with subgraph-derived classes (from Sprint 008), deduplicated

### Model Stylesheet (GAP-06, GAP-24)
- [ ] `parseStylesheet()` handles `*`, shape, `.class`, `#id` selectors
- [ ] Specificity: universal (0) < shape (1) < class (2) < id (3)
- [ ] Properties: `llm_model`, `llm_provider`, `reasoning_effort` resolved per node
- [ ] Inline node attributes override stylesheet-resolved values
- [ ] `applyStylesheet` transform runs in pipeline between goal expansion and validation
- [ ] Partial parse: valid rules apply even when other rules have syntax errors

### Validation
- [ ] `stylesheet_syntax` catches malformed `model_stylesheet` and reports source offsets
- [ ] `reasoning_effort` validated as `low`/`medium`/`high`
- [ ] `llm_provider` produces warning on unknown values

### Runtime Plumbing
- [ ] `CodergenHandler` reads `llmProvider`, `llmModel`, `reasoningEffort` from resolved node
- [ ] Values are forwarded through `AgentSession` to `UnifiedClient.stream()`
- [ ] End-to-end proof: stylesheet sets `llm_provider=simulation` on a node, codergen handler uses the simulation provider

### Parallel Tool Execution (GAP-45, GAP-57)
- [ ] Multiple read-only tool calls execute concurrently in agent loop
- [ ] Mutating tool calls execute sequentially within their position in the batch
- [ ] Interleaved `[read, read, write, read]` sequences preserve write ordering — later reads observe the write
- [ ] Concurrency bounded by `max_parallel_tools` (default 8)
- [ ] `parallel_tool_execution: false` falls back to fully sequential
- [ ] Results returned in original call order regardless of completion order
- [ ] One tool failure doesn't prevent other tools from completing (`Promise.allSettled`)
- [ ] Tool result ordering matches tool call ordering for provider compliance

### Test Coverage
- [ ] At least 40 new tests across stylesheet, attributes, runtime plumbing, parallel tools

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `@ts-graphviz/parser` already extracts `model_stylesheet` in its AST | Low | Positive | Check library AST output first. The facade pattern makes this seamless. |
| Stylesheet string escaping conflicts with DOT string quoting | Medium | Medium | Parser already strips outer quotes. Parse stylesheet from unquoted value. Test with edge cases including embedded quotes and backslash escapes. |
| Tool safety classification too coarse — some `shell` commands are read-only | Medium | Low | Conservative default: `shell` is always `mutating`. Correctness over speed. Profile can override later. |
| Mixed tool batches whose correctness depends on execution order | Medium | High | Order-preserving partitioned dispatch: only parallelize contiguous read-only runs. Never reorder across a mutation boundary. Explicit tests for interleaved sequences. |
| `CodergenHandler` → `AgentSession` → `UnifiedClient` plumbing touches multiple layers | Medium | Medium | Each layer has a clear override contract. Test the full chain end-to-end with simulation provider. |
| Concurrent tool events interleave in transcript/event stream | Medium | Low | Events already include `tool_call_id`. Transcript writes use tool_call_id-based filenames. Document that events may interleave. |
| Sprint is too large — two clusters are ambitious | Medium | Medium | Clusters are independent. **Cut line: if behind schedule, ship Phases 1-4 (authoring + runtime plumbing) and defer Phase 5 (parallel tools) to Sprint 010.** The authoring cluster is independently valuable and coherent. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| Sprint 008 parser infrastructure | Default blocks, subgraphs, class derivation, scope stack | Must be complete |
| Sprint 008 seedbed | Independent — no dependency | N/A |
| (no new packages) | Both clusters are pure internal logic | N/A |

Zero new runtime or dev dependencies. The authoring cluster builds on Sprint 008's parser. The parallel tools cluster is independent.

---

## GAP Closure Summary

| GAP | Description | Priority | Status After Sprint |
|-----|-------------|----------|-------------------|
| GAP-06 | Model Stylesheet | MEDIUM | **Closed** |
| GAP-24 | Stylesheet Application Transform | MEDIUM | **Closed** |
| GAP-27 | Missing Node Attributes (partial) | LOW | **Partially closed** (`class`, `llm_model`, `llm_provider`, `reasoning_effort`) |
| GAP-29 | Missing Graph Attributes (partial) | LOW | **Partially closed** (`model_stylesheet`) |
| GAP-45 | Parallel Tool Exec — Agent Loop | MEDIUM | **Closed** |
| GAP-57 | Parallel Tool Exec — LLM SDK | MEDIUM | **Closed** |

**4 MEDIUM gaps fully closed. 2 LOW gaps partially closed.**

Remaining for Sprint 010+:
- GAP-27 remainder: `auto_status`, `fidelity`, `thread_id` (awaiting runtime behavior)
- GAP-28: Edge attributes `fidelity`, `thread_id` (awaiting runtime behavior)
- GAP-29 remainder: `default_fidelity` (awaiting fidelity runtime)
- GAP-53: Prompt caching auto-injection
- GAP-44: Context window awareness
