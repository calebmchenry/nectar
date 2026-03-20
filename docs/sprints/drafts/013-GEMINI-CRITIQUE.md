# Sprint 012 Critique: Subagent Tools

This document provides a comparative analysis of the two draft proposals for Sprint 012: `NEXT-CLAUDE-DRAFT.md` and `NEXT-CODEX-DRAFT.md`.

## Claude Draft (`NEXT-CLAUDE-DRAFT.md`)

### Strengths
*   **Architectural Clarity:** Provides excellent sequence diagrams for the subagent lifecycle and clearly outlines the `SubagentManager`'s responsibilities.
*   **Budget & Concurrency Controls:** Explicitly defines crucial safeguards like `max_concurrent_children`, `child_timeout_ms`, and `child_max_tool_rounds` to prevent runaway token usage and system hangs.
*   **Filesystem Layout:** Clearly visualizes the transcript and artifact directory structure for nested agents.
*   **Tool Definitions:** Provides concrete JSON schemas for the four new subagent tools, making the exact interface clear.

### Weaknesses
*   **Assumes a Perfect Foundation:** Fails to acknowledge or address the existing technical debt and incomplete live-session wiring from Sprint 011.
*   **Workspace Naivety:** Treats the `workspace` parameter as a simple string override without detailing how path resolution (relative vs. absolute) actually changes within the `ExecutionEnvironment`.
*   **Overly Ambitious Recursion:** Defaults to a `max_depth` of 3, which introduces significant complexity and risk for a first iteration of subagents.

### Gaps in Risk Analysis
*   **Token Context Inflation:** Does not thoroughly analyze the risk of parent context window inflation if the `wait()` tool returns massive amounts of raw output from multiple children.
*   **Concurrency Conflicts:** Acknowledges same-workspace file conflicts but relies entirely on the model to "coordinate via task scoping" without any system-level mitigation or warning mechanisms.

### Missing Edge Cases
*   **Dynamic Tool Context:** Fails to consider what happens if a child reaches the maximum depth; it still has the `spawn_agent` tool in its prompt but will receive a runtime error if it uses it.
*   **Model/Provider Overrides:** Mentions inheritance but doesn't handle the edge case where a specific task might require a different model (e.g., using a cheaper model for a simple formatting child).

### Definition of Done Completeness
*   Strong coverage of its own proposed features, particularly around lifecycle, limits, and events.
*   Missing validation for environment path resolution and lacks constraints ensuring the parent's core tools are accurately represented.

---

## Codex Draft (`NEXT-CODEX-DRAFT.md`)

### Strengths
*   **Pragmatic Hardening:** Correctly identifies that subagents cannot be built on an unstable foundation and prioritizes fixing the live-session wiring (dynamic tool exposure, system prompt rebuilding).
*   **Dynamic Tool Exposure:** Elegantly solves prompt clutter and invalid tool usage by hiding `spawn_agent` at max depth and only showing management tools (`wait`, `send_input`, `close_agent`) when children actually exist.
*   **Robust Environment Scoping:** Introduces `cwd` to `ExecutionEnvironment` and a `scoped()` method, providing a technically sound implementation for the `working_dir` concept while maintaining the workspace trust boundary.
*   **Conservative Scope:** Limits `max_subagent_depth` to 1, significantly reducing the risk profile of the initial launch.

### Weaknesses
*   **Lacks Concurrency Limits:** Does not define a maximum number of concurrent children a parent can spawn, leaving the system vulnerable to a model spawning dozens of children in a loop.
*   **Weak Child Budgeting:** Mentions inheriting limits but lacks explicit per-child timeouts or tool-round limits, which are necessary because child tasks are fundamentally different from parent tasks.
*   **Less Concrete Interfaces:** Describes what the tools should do but lacks the exact JSON schemas and event payloads provided in the Claude draft.

### Gaps in Risk Analysis
*   **Runaway Spawning:** Fails to mitigate the risk of a "fork bomb" equivalent where a parent spawns an unbounded number of siblings (even if depth is limited to 1).
*   **Child Hangs:** Without explicit child timeouts (only inheriting the parent's or relying on shell aborts), a child session looping on an LLM logic error could indefinitely block a parent `wait()`.

### Missing Edge Cases
*   **Result Caching Eviction:** Mentions caching terminal results so repeated `wait` calls are cheap, but doesn't cover if/how those caches are managed if a parent runs for a very long time.
*   **Partial `wait` failures:** Doesn't explicitly state what `wait([id1, id2])` returns if one child succeeds and the other fails or is aborted.

### Definition of Done Completeness
*   Excellent coverage of hardening tasks (e.g., `patch.txt` persistence, correct provider tool visibility).
*   Lacks assertions regarding strict concurrency boundaries and timeout enforcement.

---

## Recommendations for the Final Merged Sprint

The final Sprint 012 plan should synthesize the robust control-plane hardening of the Codex draft with the strict runtime limits and structural clarity of the Claude draft.

1.  **Adopt Codex's Session Hardening:** Begin the implementation by fixing the dynamic tool exposure and live system prompt composition. Subagents must be built on a truthful representation of available tools.
2.  **Adopt Codex's Dynamic Tool Exposure:** Only expose `send_input`, `wait`, and `close_agent` when a parent has active or completed children. Hide `spawn_agent` when `session_depth >= max_subagent_depth`.
3.  **Merge Concurrency & Depth Limits:** 
    *   Set `max_subagent_depth = 1` initially (Codex) to reduce risk.
    *   Implement `max_concurrent_children` (Claude) to prevent horizontal fork-bombing.
4.  **Merge Environment Scoping:** Implement Codex's `cwd` and `scoped()` `ExecutionEnvironment` to handle `working_dir` properly, avoiding Claude's naive string replacement.
5.  **Adopt Claude's Budget Controls:** Implement explicit `child_timeout_ms` and `child_max_tool_rounds`. Children need tighter leashes than parent sessions to prevent hanging the pipeline.
6.  **Combine Event Metadata:** Use Claude's explicit event types (`SubagentSpawnedEvent`, etc.) but ensure they carry Codex's required lineage metadata (`parent_session_id`, `root_session_id`, `agent_depth`).
7.  **Artifact Layout:** Adopt the `subagents/<agent_id>/` directory structure agreed upon by both drafts, ensuring `patch.txt` is persisted (Codex).
8.  **Output Summarization:** To address the context inflation risk, ensure `wait()` returns a bounded summary or final answer of the child's work, rather than dumping the entire child transcript into the parent's prompt.