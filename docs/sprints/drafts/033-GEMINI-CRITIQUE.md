# Sprint Draft Critique: NEXT-CLAUDE-DRAFT vs NEXT-CODEX-DRAFT

## Claude Draft (Green Suite & Remaining Compliance Closure)

### Strengths
*   **Precise Root-Cause Analysis:** Accurately identifies the specific technical reasons for the 6 failing integration tests (e.g., `setTimeout(..., 0)` deferred close in SSE, boolean logic error in `withLiveCurrentNode`).
*   **Strict Gating:** Strongly enforces that Phase 1 (fixing the red test suite) must be completed and passing before any new compliance work begins.
*   **Comprehensive:** Leaves no compliance gap behind. If successful, it entirely eliminates compliance debt and achieves a spec-complete engine.

### Weaknesses
*   **Massive Scope:** Attempting to fix 6 deeply-rooted integration test failures *and* implement 25 distinct compliance gaps across the entire stack is highly likely to spill over the sprint timebox.
*   **Lack of Product Cohesion:** The 25 compliance gaps are mostly unrelated (model catalog updates vs. SSE stream closures vs. adapter lifecycle methods), making the sprint feel like a grab-bag of chores rather than a unified product step.

### Gaps in Risk Analysis
*   **Simultaneous Core Changes:** Changing `withLiveCurrentNode` logic and SSE closure behavior at the same time might introduce new race conditions that mask each other, which isn't fully analyzed.
*   **Type Bloat Impact:** While it notes adding 15+ optional fields is low risk, it doesn't account for the increased testing and mocking burden across the test suite for these new fields.

### Missing Edge Cases
*   **SSE Buffer Flushing:** For the synchronous SSE close, what happens if the terminal event payload is exceptionally large and `res.end()` does not flush it to the TCP socket before the connection is closed?
*   **In-flight Legacy Gardens:** When enforcing the exactly-one-exit rule (A1), the draft doesn't address what happens to currently paused or running pipelines that were created with older, multi-exit gardens.

### Definition of Done Completeness
*   Highly complete and strictly tied to the task list.
*   Excellent explicit requirement: "No test timeout values were increased to achieve green."

---

## Codex Draft (Hive Runtime Contract & Single-Exit Compliance)

### Strengths
*   **Product-Driven Focus:** Directly connects the backend work to the needs of the frontend ("The Hive"), ensuring that the server is a trustworthy contract for the UI.
*   **Architectural Clarity:** Addresses deep-seated state management issues, such as moving seed lifecycle tracking out of route-local closures and making `RunManager` the live-state authority.
*   **Ruthless Prioritization:** Correctly identifies that only gaps A1 and U19 are high-severity and block the Hive, intentionally deferring the 23 low-severity gaps to keep the sprint focused.

### Weaknesses
*   **Vague on Test Failures:** While it aims to make the HTTP integration suite green, it doesn't explicitly name or address the known root causes of the 6 currently failing tests, risking another sprint where the tests are "fixed" but still flaky.
*   **Delays Spec Completion:** By leaving 23 compliance gaps open, the "spec-complete engine" milestone is pushed back further.

### Gaps in Risk Analysis
*   **Live-State Authority Races:** Modifying `RunManager` to be the live-state authority overlaying checkpoint state could introduce significant race conditions with database writes if the memory/disk synchronization isn't perfectly locked.
*   **Frontend Contract Breakage:** Changing question states from `timed_out` to `interrupted` might break existing frontend clients or CLI tools that don't know how to handle or render the `interrupted` state.

### Missing Edge Cases
*   **Non-Gate Cancellations:** The draft focuses heavily on "cancel during a human gate." What happens if a run is cancelled while it's actively executing an LLM node or between nodes?
*   **Draft Recovery:** If `POST /gardens/draft` fails the new strict A1 validation and emits `draft_error`, is the user's context/prompt lost, or is there a recovery path to fix the generated DOT?

### Definition of Done Completeness
*   Strong coverage of architectural and behavioral guarantees (e.g., `activity.jsonl` idempotency).
*   Lacks the explicit requirement to fix the specific 6 failing integration tests by name, which is a critical omission given the project's history.

---

## Recommendations for the Final Merged Sprint

To create the most effective final sprint, combine the technical precision of Claude with the product-focused scoping of Codex:

1.  **Adopt Codex's Scope, but Claude's Bug Fixes:** The final sprint should focus *only* on the HTTP runtime truth, human-gate semantics, and the two high-severity compliance gaps (A1, U19) as proposed by Codex. However, it must explicitly include Claude's root-cause fixes for the 6 failing tests (SSE synchronous close, `withLiveCurrentNode` fix) as the mandatory Phase 1.
2.  **Defer Low-Value Compliance:** Agree with Codex to defer the 23 low-severity compliance gaps (model catalogs, optional fields) to a future "Cleanup/Polish" sprint. They are distractions from stabilizing the HTTP contract for The Hive.
3.  **Comprehensive A1 Rollout:** Combine Claude's mitigation strategy (audit existing `.dot` files and add deprecation warnings if necessary) with Codex's authoring-boundary enforcement. Ensure the design accounts for in-flight legacy pipelines.
4.  **Merged Definition of Done:** The final DoD must require:
    *   The 6 named integration tests pass.
    *   No test timeouts are inflated.
    *   `activity.jsonl` writes are idempotent.
    *   `RunManager` serves live truth.
    *   A1 and U19 are closed.