# Sprint 010 Merge Notes

## Drafts Reviewed

| Draft | Author | Proposal |
|-------|--------|----------|
| NEXT-CLAUDE-DRAFT.md | Claude | Model Stylesheet, Default Blocks & Parallel Tool Execution — two independent clusters closing 11 GAPs |
| NEXT-CODEX-DRAFT.md | Codex | Seedbed Foundation — filesystem capture and swarm analysis |
| NEXT-GEMINI-DRAFT.md | Gemini | Agentic Parallelism & Performance — parallel tools, prompt caching, context window awareness |

## Critiques Reviewed

| Critique | Author | Key Position |
|----------|--------|-------------|
| NEXT-CLAUDE-CRITIQUE.md | Claude | Take Claude's authoring cluster as primary scope; take parallel tools with Claude's safety model; defer seedbed/caching/context-window to later sprints |
| NEXT-CODEX-CRITIQUE.md | Codex | Use Claude draft as structural base; narrow attribute scope to runtime-relevant fields; rewrite concurrency plan around order preservation (fence model); defer prompt caching and context window |
| NEXT-GEMINI-CRITIQUE.md | Gemini | Ship seedbed capture as core feature plus low-risk parser enhancements; defer stylesheets and parallel tools |

## Key Decisions

### 1. Primary scope: Authoring cluster (from Claude draft)

**Taken from:** Claude draft (Phases 1-5), refined by Codex critique

The stylesheet system, extended attributes, and validation close the remaining authoring gaps and push DOT parsing toward completion. This is high-value, low-risk, highly testable work. The Claude draft provided the most implementation-ready specification for this work.

**Why not Seedbed (Codex draft)?** Sprint 008 already shipped the Seedbed foundation. The remaining seedbed work (swarm analysis) depends on the seedbed filesystem stabilizing first and benefits from having stylesheet-powered pipelines available for `linked_gardens`. Three critiques converged on prioritizing spec compliance over new product surface.

**Why not pure performance (Gemini draft)?** The Gemini draft's scope (parallel tools + prompt caching + context window awareness) lacks a cut-line and bundles Anthropic-only features. Both Claude and Codex critiques recommended deferring caching and context awareness.

### 2. Parallel tool execution with fence-based safety model

**Taken from:** Claude draft (Phase 6 safety classification), significantly improved by Codex critique

The Claude draft proposed partitioning tool calls into read-only and mutating groups. The Codex critique identified a critical flaw: this partitioning can reorder semantics when reads and writes are interleaved (e.g., `read -> write -> read` becomes `read+read in parallel, then write`). The merged sprint adopts a **fence-based model** where mutating calls act as sequential barriers, preserving the original interleaving semantics.

The Gemini draft's omission of any safety classification and its use of `Promise.all()` instead of `Promise.allSettled()` were both flagged as significant gaps by the Claude critique. The merged sprint uses `Promise.allSettled()` throughout.

### 3. Runtime plumbing is explicit (from Codex critique)

**Taken from:** Codex critique recommendation

The Codex critique correctly identified that parsing `llm_provider` and `reasoning_effort` without forwarding them through `CodergenHandler` → `AgentSession` → `UnifiedClient.stream()` would leave the sprint's impact theoretical. Phase 4 (Runtime Plumbing) was added to close this gap, with an end-to-end test proving stylesheet routing actually changes runtime behavior.

### 4. Partial stylesheet parse behavior is specified (from Codex critique)

**Taken from:** Codex critique gap analysis

The Codex critique noted that neither draft specified what happens when a stylesheet has both syntax errors and valid rules. The merged sprint specifies fail-open per-rule / fail-loud at validation: valid rules apply, errors surface as diagnostics.

### 5. Prompt caching and context window deferred

**Taken from:** Claude critique and Codex critique consensus

Both critiques agreed these are valuable but should not be bundled with authoring work. Prompt caching is Anthropic-only (35% of Gemini's sprint for one provider). Context window awareness uses a heuristic that may over-warn. Both deferred to Sprint 011.

### 6. Seedbed swarm analysis deferred

**Taken from:** Claude critique, Gemini critique consensus

The Codex draft's seedbed foundation already shipped in Sprint 008. Swarm analysis depends on stable seedbed filesystem and benefits from stylesheet-powered pipelines being available. Deferred.

### 7. Attribute scope narrowed for must-ship vs nice-to-have (from Codex critique)

**Taken from:** Codex critique recommendation

The Codex critique recommended treating `llm_model`, `llm_provider`, `reasoning_effort`, and `class` as must-ship (runtime-relevant) and deferring `auto_status`, `thread_id`, `default_fidelity` as lower priority. The merged sprint includes all attributes since they are trivial parse-only additions, but the DoD and runtime plumbing focus on the runtime-relevant fields.

## What Was Not Taken

| Proposal | Source | Reason for exclusion |
|----------|--------|---------------------|
| Seedbed as primary scope | Codex draft, Gemini critique | Already shipped in Sprint 008; remaining work (swarm) benefits from waiting |
| Prompt caching auto-injection (GAP-53) | Gemini draft | Anthropic-only, requires broader type work than acknowledged, heuristics not mature enough |
| Context window awareness (GAP-44) | Gemini draft | LOW priority, heuristic-based, pairs better with caching work in Sprint 011 |
| `Promise.all()` for tool batches | Gemini draft | Wrong failure semantics; `Promise.allSettled()` is required for failure isolation |
| Batch-all-reads-then-writes partitioning | Claude draft | Breaks interleaved read/write semantics per Codex critique; fence model adopted instead |
| Block comments, default blocks, subgraphs, duration units | Claude draft Phases 1-2 | Already shipped in Sprint 008 |
| `src/llm/tools.ts` as a new execution layer | Claude draft | Codex critique: don't invent a new layer boundary unless a real caller exists; keep execution in agent-loop |
