# Critique of Sprint 008 Drafts

## 1. NEXT-CLAUDE-DRAFT.md (Model Stylesheet & Parallel Tools)

### Strengths
*   **Data-Driven Focus:** Directly targets specific, high-leverage compliance gaps (GAP-06, GAP-13, GAP-45, etc.) with clear metrics on how they improve the overall engine state.
*   **Clean Independence:** The two clusters (DOT authoring and Agent performance) are cleanly separated, modifying different domains (parser vs. LLM SDK), minimizing merge conflicts and allowing parallel execution.
*   **Clear UX Improvements:** The use cases elegantly demonstrate the boilerplate reduction achieved by default blocks and stylesheets.

### Weaknesses
*   **Ambitious Scope:** Introducing an entire CSS-like specificity and resolution engine alongside a fundamental concurrency change to the agent loop is highly risky for a single sprint.
*   **Batching Assumption:** Parallel tool execution assumes the LLM optimally batches multiple `tool_call` items in a single response, rather than relying on an explicit parallel orchestration graph.
*   **Debugging Complexity:** Glosses over the complexity of debugging interleaved tool events and logging when 8 tools are firing concurrently.

### Gaps in Risk Analysis
*   **Context Window / Rate Limits:** Fails to analyze the risk of parallel `read_file` or `grep` calls returning massive amounts of data simultaneously, blowing out the context window or hitting provider rate limits.
*   **Future Feature Conflicts:** Does not consider how the global/graph-level stylesheet resolution will interact with upcoming child-pipeline features (GAP-04) or nested execution scopes.
*   **Cyclic/Expensive Selectors:** No mention of performance impacts from deeply nested subgraphs or complex CSS-like selector matching on large graphs.

### Missing Edge Cases
*   **Selector Specificity Ties:** What is the exact behavior if two rules have identical specificity and identical source order (e.g., duplicated rules)?
*   **Unclosed Comments:** How does the parser handle an unclosed block comment `/* ...` at the end of a file?
*   **Parallel File Access:** How are parallel mutating tools handled if they attempt to write to or create the same directory structure simultaneously (race conditions on `mkdir`)?

### Definition of Done Completeness
*   **Missing:** A specific DoD item verifying that parallel tool outputs are re-assembled in the *exact original order* requested by the LLM before sending the continuation message.
*   **Missing:** Load testing or rate-limit fallback validation for the parallel execution mode.

---

## 2. NEXT-CODEX-DRAFT.md (Seedbed Foundation)

### Strengths
*   **High Product Value:** Delivers the "thinnest vertical slice" of the core product vision, making Nectar instantly useful for capturing and tracking ideas.
*   **Filesystem-as-API:** Excellent architectural constraint to avoid databases and hidden state, relying purely on the directory tree and `meta.yaml`.
*   **Robust Failure Modes:** Specifically designs Swarm Analysis to tolerate partial successes and single-provider failures (`Promise.allSettled()`).

### Weaknesses
*   **Fragile Normalization:** Heavily relies on LLMs reliably generating specific Markdown headers (`# Summary`, `# Risks`) to parse and normalize the output. This is notoriously brittle across different models.
*   **Lockfile Architecture:** Using `.nectar/locks/seed-id.lock` is prone to staleness and deadlock if the CLI process is killed abruptly.
*   **Scope Creep:** Bundling the multi-agent `swarm` feature with the foundational `seed` capture feature bloats the sprint. They serve different UX paradigms (capture vs. analysis).

### Gaps in Risk Analysis
*   **Stale Locks:** Ignores the risk and recovery mechanism for a stale lockfile preventing all future seed creations.
*   **Data Loss:** While mentioning atomic temp-file renames, it doesn't address the risk of partial writes to `seed.md` or attachment corruption if disk space runs out.
*   **Attachment Abuse:** No mitigation for users attaching massive files (e.g., a 2GB core dump) or executables, beyond simple filename sanitization.

### Missing Edge Cases
*   **Stdin Size Limits:** What happens if `pbpaste | pollinator seed` streams gigabytes of data? There is no bounded limit defined.
*   **Slug Collisions:** What if the slugification of a title results in an exact match with an existing directory (e.g., `pollinator seed "Test"` run twice)?
*   **Tag Normalization:** Are tags case-sensitive? Are spaces allowed? (e.g., `api` vs `API`, `front end` vs `frontend`).

### Definition of Done Completeness
*   **Missing:** Handling and recovery procedures for stale lockfiles.
*   **Missing:** Fallback formatting in `analysis/*.md` if the LLM output completely fails to match the expected normalization schema.
*   **Missing:** Empty or invalid stdin handling.

---

## Recommendations for the Final Merged Sprint

The final merged Sprint 008 should prioritize delivering the foundational user experience while pulling in only the lowest-risk, highest-value engine parser fixes.

1.  **Core Feature: Seedbed Capture (Codex Draft)**
    *   Implement the `pollinator seed` and `pollinator seeds` CLI commands, the `meta.yaml` canonical state, and the directory structure. This delivers immediate, tangible value.
2.  **Engine Quality-of-Life: DOT Parser Enhancements (Claude Draft)**
    *   Incorporate Block Comments (`/* ... */`), Default Blocks (`node [...]`), and Duration Units (`h`, `d`). These are tightly scoped, low-risk parsing tasks that drastically improve DOT authoring without introducing new architectures.
3.  **Defer Stylesheets and Parallel Tools**
    *   The model stylesheet micro-language and parallel tool concurrency (Claude draft) are too heavy to bundle with Seedbed. Move them to Sprint 009.
4.  **Defer Swarm Analysis**
    *   Move the `pollinator swarm` multi-agent analysis feature (Codex draft) to Sprint 009. It relies on the Seedbed existing first, and deferring it allows time to refine the fragile Markdown normalization logic.
5.  **Refine ID Allocation**
    *   Drop the `.nectar/locks/seed-id.lock` approach. Instead, determine the next ID by scanning `seedbed/` and `honey/` for the highest integer prefix. Rely on atomic directory creation (`fs.mkdir` without `recursive`) to catch race conditions and retry with the next ID if a collision occurs.
6.  **Bounded Inputs**
    *   Ensure strict size limits on stdin capture and attachment file sizes in the DoD.