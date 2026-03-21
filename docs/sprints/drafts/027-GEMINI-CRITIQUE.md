# Critique of Sprint 027 Drafts

## 1. NEXT-CLAUDE-DRAFT: Green Suite, Engine Contract, and Server API

### Strengths
- **Ruthless Prioritization:** Making the "green suite" the non-negotiable gate is excellent engineering discipline. It correctly identifies that building features on top of failing CI is compounding technical debt.
- **High Leverage:** Fixing the server API endpoints (cancel, checkpoint, context) immediately unblocks downstream UI (Hive) features that are currently dead.
- **Clear Scope:** The tasks are surgical, well-bounded, and explicitly list the files to be modified.

### Weaknesses
- **Heavy on Tech Debt, Light on Product Value:** While crucial, this sprint delivers mostly invisible stability improvements to the end user, with no direct improvements to the AI/agent behavior or capabilities.
- **Debugging Optimism:** Test timeout bugs involving SSE and event buses can be notorious rabbit holes. Assuming this is only "40% of effort" might be overly optimistic.

### Gaps in Risk Analysis
- **Cascading Failures:** Adding jitter and changing retry presets could introduce race conditions or timing-dependent test failures in previously passing tests that implicitly relied on the old, deterministic timing.
- **Data Migration / Backward Compatibility:** Changing the `context` keys (e.g., from `{node_id}.stdout` to `tool.output`) or adding `error_category` to outcomes might break existing pipelines or checkpoints without a migration path.

### Missing Edge Cases
- **Cancellation Edge Cases:** What happens to active sub-processes (like a long-running shell command) when `POST /pipelines/:id/cancel` is called? Does `engine.abort()` guarantee forceful process termination if graceful shutdown hangs?
- **Checkpoint Write Failures:** If the cancellation triggers a checkpoint write, and the disk is full or the write fails, what state is the pipeline left in?

### Definition of Done Completeness
- Very strong and measurable. However, it lacks a specific DoD item ensuring that fixing the 6 failing tests doesn't just involve bumping timeouts (e.g., "Timeout values were not increased to achieve passing tests").

---

## 2. NEXT-CODEX-DRAFT: Finish the Coding-Agent Loop Contract

### Strengths
- **Product-Focused:** Directly addresses the core value proposition: agent reliability, observability, and tool correctness.
- **Holistic Telemetry:** Adding the full state machine lifecycle events is critical for debugging and UI transparency.
- **Sensible Truncation Fix:** Moving to a 50/50 head/tail truncation split is highly practical for LLMs reading logs, where the crucial error is often at the very end.

### Weaknesses
- **Ignores Foundational Instability:** It ignores the fact that CI is currently failing (the "red suite" mentioned in the Claude draft). Adding more complex event bridging and telemetry on top of a flaky event bus is risky.
- **Fake Streaming Hack:** Emitting `agent_tool_call_output_delta` in "deterministic chunks" after execution finishes is a stopgap that doesn't provide true live streaming, which might frustrate users and UIs expecting real-time shell output.

### Gaps in Risk Analysis
- **Performance Overhead:** Walking from the Git root to CWD for instruction discovery on every run could introduce noticeable latency in large monorepos.
- **Ecosystem Breakage:** Expanding `ExecutionEnvironment` and refactoring `buildEnvironmentContext()` might break custom integrations if the interface changes are not strictly backwards compatible.

### Missing Edge Cases
- **Symlink Escapes in Instruction Discovery:** What happens if the path from Git root to CWD traverses symlinks that point outside the workspace?
- **Truncation Boundary Corruption:** When splitting output 50/50, how does the truncation logic handle slicing through multi-byte UTF-8 characters or ANSI color escape sequences at the boundary?

### Definition of Done Completeness
- Thorough regarding the feature checklist, but missing performance benchmarks (e.g., "Instruction discovery adds <50ms overhead"). Also lacks a DoD item verifying that the simulated "delta" chunking doesn't break SSE event ordering or overwhelm the event bus.

---

## Recommendations for the Final Merged Sprint

The final sprint should combine the **foundational stability** of the Claude draft with the **high-leverage observability/tooling fixes** of the Codex draft, creating a release that stabilizes the core while delivering immediate value to the AI loop.

1. **Phase 1: The Green Suite Gate (Must-Have)**
   - Adopt Claude's Phase 1 wholesale. No new feature work begins until the 6 failing tests are root-caused and fixed. A reliable test suite is a prerequisite for modifying the agent loop.

2. **Phase 2: Agent Observability & API Completeness**
   - Combine Claude's missing HTTP endpoints (cancel, checkpoint, context) with Codex's Session Telemetry (`agent_*` events). Both are essential for UI/Hive integration. If the Hive can't see what the agent is doing or cancel it, the product is fundamentally broken.

3. **Phase 3: Tool Contracts & Truncation Quality**
   - Adopt Codex's tool schema fixes (`grep` case-insensitive, `shell` descriptions, subagent model overrides) and the 50/50 truncation fix. These are low-effort, high-impact changes that immediately improve model performance without requiring deep architectural refactoring.

4. **Cut/Defer:**
   - **Claude's Engine Retry Correctness:** Defer jitter and preset tweaking. While important, it's less critical than tool execution correctness.
   - **Codex's ExecutionEnvironment Parity:** Defer the large refactor of `ExecutionEnvironment` and `list_dir`. It's a large structural change that risks distracting from the core goal of green CI and basic telemetry.
   - **Codex's Simulated Output Streaming:** Do not implement fake "post-execution chunking" for tool output. Wait until true live streaming can be implemented properly in a future sprint to avoid shipping hacky technical debt.

**Final Scope Summary:** Get CI green -> Ship missing server API endpoints -> Add full agent lifecycle events -> Fix core tool schemas and truncation.