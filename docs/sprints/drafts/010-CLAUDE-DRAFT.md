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
