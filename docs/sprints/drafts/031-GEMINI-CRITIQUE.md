# Critique of Sprint Drafts: Claude vs. Codex

## 1. NEXT-CLAUDE-DRAFT.md

### Strengths
*   **Pragmatic Prioritization:** Immediately identifies and addresses the 6 failing tests (SSE lifecycle bugs) as a blocker. Recognizing that a red test suite prevents confident compliance work is a critical insight.
*   **Granular Traceability:** Maps each of the 15 compliance gaps to specific files, functions, and lines of code. The breakdown by group/files/gaps is excellent for execution.
*   **Concrete Testing Strategy:** Links specific bug fixes to the exact tests that will transition from red to green (e.g., `test/server/pipeline-events.test.ts`).

### Weaknesses
*   **Superficial Architecture:** Treats the `glob`/`grep` implementation on `LocalExecutionEnvironment` as a simple delegation to `fast-glob`/`execa` without considering the need for shared semantics with the existing tools (e.g., `.gitignore` adherence).
*   **Answer Model Risk:** Proposes enriching the `Answer` model alongside `selected_label`, but doesn't fully detail the normalization layer needed at the HTTP/CLI boundaries to prevent disjointed state.

### Gaps in Risk Analysis
*   **LLM Model Catalog Breaking Changes:** Assumes grep-and-replace is sufficient for renaming catalog capabilities. It doesn't adequately account for potential external/CLI consumers of this metadata that might break without a deprecation window.
*   **SSE Close Timing:** Mentions a potential race condition but relies solely on `process.nextTick()`. Network buffering might still cause truncated events on the client side before the socket fully closes.

### Missing Edge Cases
*   **`Message.name` Validation:** Provider APIs (like OpenAI) have strict regex requirements for the `name` field (e.g., `^[a-zA-Z0-9_-]+$`). The draft doesn't mention sanitizing or validating this field before passing it to the adapter.
*   **Git Context:** Doesn't explicitly handle the case where a project is initialized with `git` but has zero commits, which causes `git log` to error.

### Definition of Done Completeness
*   **High:** Very complete and actionable. Explicitly mandates 0 test failures and maps DoD items directly to the 15 spec gaps + SSE fixes.

---

## 2. NEXT-CODEX-DRAFT.md

### Strengths
*   **Deep Architectural Insight:** Excellent framing of the "canonical answer shape with compatibility normalization" to safely bridge the old and new `Answer` models.
*   **Holistic Refactoring:** The proposal to extract a shared search helper for `glob`/`grep` (used by both the environment and the tools) is vastly superior to implementing them twice.
*   **Systemic Consistency:** Correctly identifies the duplicate session event issue (`CodergenHandler` vs `AgentSession`) and proposes structural fixes to make `AgentSession` the true source of truth.
*   **Safe Migrations:** Recommends a one-sprint compatibility alias for the Model Catalog changes, avoiding flag-day breakage.

### Weaknesses
*   **Blind Spot on Current State:** Completely ignores the currently failing SSE tests. Proposing a contract-correction sprint without fixing the underlying CI redness means the validation phase will be compromised.
*   **Overly Abstract:** Less concrete about exactly which lines of code need changing compared to the Claude draft.

### Gaps in Risk Analysis
*   **Shared Search Helper Extraction:** Extracting existing tool logic into a shared helper carries a high risk of subtle behavioral regressions in the tools themselves if edge cases (like symlinks or nested ignores) aren't perfectly preserved.
*   **`max_tool_rounds` Transition:** Defaults changing from 10 to 1 could immediately break active agent sessions that rely on the implicit multi-round default, even with the alias in place, if the resolution order favors the spec default too aggressively.

### Missing Edge Cases
*   **Git Snapshot Size:** Including the "last 5 commit messages" could blow out context windows if a user has massive, multi-megabyte commit messages. Needs truncation.
*   **Orphaned Tool Invocations:** When `unregister(name)` is called, what happens if an LLM is currently mid-generation and attempts to call that tool in the same tick?

### Definition of Done Completeness
*   **Moderate to High:** Strong focus on contract enforcement and backward compatibility, but lacks the empirical rigor of Claude's DoD (specifically missing the fix for the currently failing tests).

---

## 3. Recommendations for the Final Merged Sprint

The final sprint should be an amalgamation of Claude's pragmatic execution and Codex's architectural rigor. 

**1. Foundation First (Mandatory):**
Adopt Claude's Phase 1 verbatim. The SSE Lifecycle fix MUST be the first task. Compliance work cannot be validated on a red test suite.

**2. Architecture & Abstractions:**
Adopt Codex's architectural approaches for the compliance gaps:
*   Use Codex's **shared search helper** for `glob`/`grep` instead of Claude's simple delegation.
*   Use Codex's **canonical answer normalization** strategy in the HTTP/Wait-Human boundary.
*   Use Codex's **compatibility alias** strategy for the Model Catalog to ensure smooth transitions.
*   Move `agent_session_started` emission into `AgentSession` and bridge it in `CodergenHandler` (Codex approach).

**3. Address the Edge Cases:**
Add explicit tasks to the merged draft to handle:
*   Sanitizing `Message.name` to match provider regex constraints.
*   Graceful handling of empty git repositories (0 commits).
*   Truncating git commit messages to a reasonable length to prevent context bloat.
*   Strictly prioritizing the `GenerateOptions.maxIterations` fallback during the one-sprint deprecation window to prevent tool-loop regressions.

**4. Execution Structure:**
Use Claude's detailed file-and-task mapping, but replace the implementation details for the tasks mentioned above with Codex's strategies. This provides the best of both worlds: deep architectural correctness with high execution clarity.