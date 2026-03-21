# Sprint Critique: NEXT-CLAUDE vs NEXT-CODEX

## 1. NEXT-CLAUDE-DRAFT.md

### Strengths
- **Comprehensive Scope:** Explicitly addresses the entirety of `INTENT.md` §4, including the Workspace Endpoints (Garden/Seed CRUD and Workspace SSE) and GAP-5 (Context Window Awareness).
- **Architectural Depth:** Provides a highly detailed module layout, run directory structure, and an explicit SSE protocol design.
- **Clear Rationale:** Excellent justification for *why* the server is the immediate next step, tying it directly to unblocking "The Hive" web UI.
- **Implementation Phasing:** Breaks down the work into logical, well-sized phases (Runtime, SSE, Human Questions, Graph/Workspace, Gaps).

### Weaknesses
- **Overly Ambitious:** Including all 9 pipeline endpoints, SSE streaming, durable human gates, *plus* full Garden/Seed CRUD, multipart file uploads, and GAP-5 risks overflowing a single sprint.
- **Dependency Complexity:** Suggests potentially needing `busboy` for multipart uploads, which contradicts the project's "no framework/few dependencies" ethos if not carefully managed.

### Gaps in Risk Analysis
- **Disk I/O and Memory Limits:** Fails to consider the performance impact of appending every event to `events.ndjson` synchronously, or memory limits when serving large histories to late-joining SSE clients.
- **Race Conditions:** Doesn't address potential race conditions between CLI-initiated runs and HTTP-initiated runs modifying the same files in `.nectar/cocoons/`.

### Missing Edge Cases
- **Concurrent Human Gates:** Doesn't specify how `ask_multiple` interacts with the HTTP API. If multiple `wait.human` nodes trigger simultaneously in parallel branches, how are they presented and resolved?
- **Stale Answers:** What happens if a user submits an answer to a question that has already timed out or been answered by another client/browser tab?

### Definition of Done Completeness
- Very complete for the proposed scope. Explicitly checks off all Gaps (GAP-1, GAP-2, GAP-3, GAP-5, GAP-6).

---

## 2. NEXT-CODEX-DRAFT.md

### Strengths
- **Laser Focus:** Intentionally cuts Garden/Seed CRUD and GAP-5 to focus exclusively on the hardest problem: Pipeline Execution, SSE, and Durable Human Gates. This makes the sprint highly achievable.
- **Pragmatic Prioritization:** Includes a clear "Cut line" specifying what to drop if time compresses (e.g., legacy event compatibility, `GET /healthz`).
- **Clear Runtime Layout:** Excellent visualization of the `.nectar/cocoons/<run-id>/` directory structure.

### Weaknesses
- **Incomplete Compliance:** By cutting the Workspace Endpoints (Garden/Seed CRUD), it fails to fully satisfy `INTENT.md` §4, meaning the web UI ("The Hive") still won't have a backend to list available pipelines or seeds to start runs from.
- **Lacks Protocol Specifics:** Lacks the concrete SSE protocol definitions and HTTP payload examples present in the Claude draft.

### Gaps in Risk Analysis
- **Event Replay Scale:** Doesn't address how to handle `Last-Event-ID` if the event journal grows to thousands of lines. Reading the whole file into memory to serve a reconnecting client could cause out-of-memory errors.
- **Run Manager Leaks:** Doesn't explicitly discuss TTLs or cleanup for inactive runs in the `RunManager` memory registry.

### Missing Edge Cases
- **Orphaned Runs:** If the server crashes, active runs are abruptly interrupted. On reboot, how does the UI know which runs can be resumed vs. which are permanently dead?
- **Invalid Reconnects:** What happens if a client sends a `Last-Event-ID` that doesn't exist in the journal or is malformed?

### Definition of Done Completeness
- Solid, but strictly limited to its reduced scope. Misses the broader workspace requirements necessary for a fully functional frontend.

---

## 3. Recommendations for Final Merged Sprint

To create the optimal `NEXT` sprint, merge the best aspects of both drafts using the following recommendations:

1. **Adopt Claude's Full Scope, but Codex's Cut Line:** 
   Aim for the full `INTENT.md` §4 compliance (including Gardens and Seeds) as proposed by Claude, because the Web UI requires them to function. However, adopt Codex's strategy of a firm "Cut line". Put Garden/Seed CRUD, multipart uploads, and GAP-5 in the final implementation phase so they can be dropped if the core Pipeline/SSE work takes too long.
2. **Standardize the SSE Protocol:** 
   Use Claude's explicit SSE protocol design (`id`, `event`, `data` with monotonic sequence numbers) to ensure robust reconnects.
3. **Refine RunManager Lifecycle:** 
   Explicitly specify a TTL for in-memory run tracking. Completed or failed runs should be evicted from memory after a set time (e.g., 1 hour), with subsequent requests reading entirely from the disk footprint.
4. **Address Concurrent Human Gates:** 
   Ensure the `HttpInterviewer` and `QuestionStore` can handle multiple pending questions concurrently (e.g., from parallel execution branches) and that the API returns an array of pending questions. Add validation to reject answers for questions that are already resolved or timed out.
5. **Handle Replay Efficiency:** 
   Specify that SSE replay should use Node streams (e.g., `fs.createReadStream` piped through a readline parser) rather than loading the entire `events.ndjson` into memory, preventing OOM crashes on long runs.
6. **Graceful Server Restarts (Orphaned Runs):** 
   Add a requirement to the DoD: On startup, the server should scan `.nectar/cocoons/` for runs that were interrupted by a server crash (e.g., status `running` in the manifest but no active process) and mark them as `interrupted` so they can be cleanly resumed via the UI.