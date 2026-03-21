# Critique of Sprint Drafts

## 1. NEXT-CLAUDE-DRAFT.md

### Strengths
*   **Fixes Blocking Issues:** Correctly identifies that the 6 failing tests (SSE stream termination and `run_error` emission) are blocking CI and downstream features, and prioritizes them as Workstream A.
*   **Comprehensive Coverage:** Attempts to address all 37 remaining compliance gaps across Attractor, Coding Agent Loop, and Unified LLM.
*   **Structured Phasing:** Breaks down the massive scope into logical phases (SSE, High, Medium, Low severity gaps).
*   **Clear Event Flow:** Provides a clear mental model for the SSE lifecycle fix (engine emits -> handler writes -> `res.end()`).

### Weaknesses
*   **Overly Ambitious Scope:** Attempting to fix 6 failing tests and 37 gaps in a single 5-day sprint is highly risky. It scatters focus across too many different surfaces (HTTP routes, LLM catalog, execution environment, tool naming, error mapping).
*   **Superficial Fixes:** For complex features like `repair_tool_call` (U14), the draft suggests implementing "the interface and wiring only" with a no-op default. This technically closes the interface gap but doesn't solve the underlying runtime reliability issue.

### Gaps in Risk Analysis
*   **Global Unlimited Defaults:** Changing default `max_turns` to unlimited (0) globally without explicitly handling subagents could lead to runaway recursive agent spawns in production, not just in tests.
*   **Merge Conflict Underestimation:** While it mentions batching changes, touching that many files across the entire codebase almost guarantees integration headaches if parallel work is occurring.

### Missing Edge Cases
*   **SSE Client Disconnect:** While it mentions unsubscribing on `res.close()`, it doesn't explore what happens if the engine tries to emit an event to a partially closed stream before the cleanup finishes.
*   **Instruction Precedence:** Reversing the walk direction to git-root-toward-cwd is correct, but the draft doesn't detail how to handle ties (e.g., generic `AGENTS.md` vs. provider-specific files in the same directory).

### Definition of Done Completeness
*   Very thorough and maps 1:1 with the proposed tasks.
*   Explicitly tracks the reduction of failing tests from 6 to 0.

---

## 2. NEXT-CODEX-DRAFT.md

### Strengths
*   **Highly Focused:** Intentionally scopes the sprint to the 11 highest-impact runtime gaps (C1, C2, C6, C7, C8, U13, U14, U15, U16, U17, U18) that actually affect execution stability, deferring cosmetic and catalog updates.
*   **Deep Architectural Insight:** Provides strong, opinionated guidance on *how* to implement the fixes (e.g., actual deterministic tool repair pipeline, process group lifecycle ownership, explicit parent vs. child loop limit semantics).
*   **Robust Precedence Logic:** Clearly defines the instruction precedence rules (repo root to cwd, deeper wins, provider-specific wins over generic).

### Weaknesses
*   **Ignores Broken CI:** Completely misses the 6 currently failing tests related to SSE streams. It assumes `npm test` will pass with zero failures without scheduling the work to fix the existing breakages. A hardening sprint cannot succeed on a broken baseline.

### Gaps in Risk Analysis
*   **Git Dependency:** Relying on `git rev-parse --show-toplevel` for every instruction discovery could introduce latency or fail in constrained environments (like Docker containers missing the `.git` directory). It mentions a fallback, but the performance implications of the shell spawn aren't weighed.
*   **Process Group Semantics:** Process group killing (`kill(-pid)`) can have edge cases if spawned children intentionally `setsid()` or change their own process groups to escape the parent.

### Missing Edge Cases
*   **Complex Tool Repair:** The draft mentions safe coercions (string-to-bool), but doesn't specify how deeply nested object schemas should be traversed during the repair attempt.
*   **Redacted Thinking Constraints:** Storing `redacted_thinking.data` opaquely is good, but it doesn't consider memory bloat if these opaque payloads grow extremely large over a long, unlimited-turn session.

### Definition of Done Completeness
*   Strong alignment with the runtime hardening goals.
*   Fails to include the SSE fixes required to actually get `npm test` to pass.

---

## Recommendations for the Final Merged Sprint

The final sprint should combine the **critical bug fixes from Claude** with the **focused, deep-hardening scope of Codex**.

1.  **Scope Reduction:** Adopt Codex's scope. Drop the 26 low/medium severity cosmetic gaps (A1-A6, U1-U12, U19, C3-C5, C9-C12). They are distractions from system stability.
2.  **Mandatory Baseline Fix:** Make Claude's "Phase 1: SSE Lifecycle Fix" the absolute first priority (Workstream A). The 6 failing tests must be fixed before any agent loop hardening begins.
3.  **Deep Tool Repair:** Adopt Codex's approach to `repair_tool_call`. Build the actual deterministic repair pipeline rather than just wiring up an empty interface.
4.  **Refined Limit Semantics:** Adopt Codex's explicit distinction: Parent sessions become unlimited (`max_turns: 0`) by default, but child sessions spawned via `spawn_agent` remain explicitly bounded unless the caller actively passes `0`.
5.  **Instruction Precedence:** Use Codex's git-root-to-cwd walk and explicit tie-breaking (provider-specific > generic), but ensure the `git rev-parse` is cached or optimized to avoid slowing down session startup.
6.  **Definition of Done:** Merge both DoDs. It must include both "SSE streams close cleanly (6 failing tests -> 0)" AND the rigorous runtime validations (e.g., "deterministic repair fixes safe argument mismatches exactly once").
