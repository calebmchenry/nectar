# Sprint 015 Critique: Claude vs. Codex Drafts

## 1. Claude Draft (NEXT-CLAUDE-DRAFT.md)

### Strengths
- **Comprehensive Scope:** Successfully targets a cohesive set of gaps (A3, A4, A5, A8, A10, A11, C3) making it highly effective at driving down medium-severity engine issues.
- **Detailed Fidelity Planning:** Clear mapping of precedence (edge -> node -> graph -> compact) and robust definitions for the different fidelity modes including specific character budgets.
- **Architectural Clarity:** Provides excellent structure for the `SessionRegistry`, `PreambleBuilder`, and `RunStore`, along with explicit handling of parallel branch safety (FIFO lock).
- **Good Edge Case Coverage:** Explicitly handles `Anthropic thinking signatures` (L2 dependency) and the implications of `resume` modifying the target node.

### Weaknesses
- **Scope Creep Potential:** Adding `auto_status` (A11) might be one feature too many for a sprint that is already completely changing how state is persisted and how LLM sessions are managed.
- **Summary Generation Strategy:** Relying purely on deterministic templates for `summary:*` modes is a good starting point, but the implementation detail of truncation priorities could lead to overly rigid and less useful context for complex pipelines.

### Gaps in Risk Analysis
- **Memory Leaks:** Mentions live sessions leaking, but does not deeply analyze the memory overhead of the `SessionRegistry` if a run has dozens of parallel or sequential threads.
- **File System Bottlenecks:** Dual-writing checkpoints (canonical + legacy) could introduce latency issues for high-throughput nodes.
- **Artifact Spillage:** Fails to detail what happens if the 100KB threshold for `ArtifactStore` causes the `artifacts/index.json` to grow excessively due to thousands of tiny artifacts.

### Missing Edge Cases
- **Interrupted Tool Execution:** What happens to an artifact if the run is interrupted mid-write for a payload >100KB?
- **Empty Preamble Context:** If all recent nodes failed and produced no meaningful context, does the model receive a nearly empty prompt?

### Definition of Done Completeness
- Very thorough, covering build/regression, directory structure, fidelity, thread resolution, degraded resume, and explicit testing requirements (55+ new cases).

---

## 2. Codex Draft (NEXT-CODEX-DRAFT.md)

### Strengths
- **Strategic Focus:** Explicitly excludes unrelated features like `auto_status` (A11), keeping the sprint tightly scoped to the filesystem and runtime context (A3, A4, A5, A8, A10, C3).
- **Alignment with INTENT:** Strongly ties the implementation back to `docs/INTENT.md` principles (file-system first, resumable by default).
- **Clear Migration Path:** Emphasizes "Migration without a flag day" and details the exact dual-write mechanism.

### Weaknesses
- **Less Detailed on Preamble Logic:** While it defines the character budgets, it doesn't elaborate as deeply as the Claude draft on how exactly the context filtering will be implemented.
- **Slightly Vague on Thread Inheritance:** Mentions the resolution rules but misses some of the nuances of subgraph class derivation covered in the Claude draft.

### Gaps in Risk Analysis
- **Concurrency Locks:** Mentions a FIFO lock but doesn't explore deadlocks or timeouts if an LLM API hangs indefinitely.
- **Graph Hash Mismatches:** Mentions `resume --force` but doesn't fully assess the risk of schema drift in the middle of a `full` fidelity thread reuse. 

### Missing Edge Cases
- **Provider/Model Freezing Conflicts:** What if a reused thread key explicitly specifies a different reasoning effort, but the provider requires a different model mapping?
- **Large Checkpoint Syncs:** If a `full` fidelity session amasses a massive conversation history, the checkpoint serialization might become a bottleneck.

### Definition of Done Completeness
- Strong, with specific checkboxes for build, runstore, fidelity resolution, session reuse, and CLI integration. It ensures legacy behavior is maintained while new features are introduced safely.

---

## 3. Recommendations for Final Merged Sprint

1. **Adopt Codex's Scope:** Exclude `auto_status` (A11) to maintain strict focus on context fidelity, session reuse, and canonical artifacts. The sprint is already ambitious.
2. **Merge Architecture & Implementation Details:** Use Claude's precise precedence rules and `PreambleBuilder` truncation logic, combined with Codex's strong emphasis on `ArtifactStore` and `docs/INTENT.md` alignment.
3. **Address the Artifact Index Risk:** The `artifacts/index.json` file could balloon if a pipeline generates thousands of small (<100KB) artifacts. Recommend lowering the inline threshold (e.g., 10KB) or strictly bounding the index size.
4. **Refine Degraded Resume:** Clarify exactly how `summary:high` degrades back to `full` or `compact` on subsequent hops. Ensure the `resume_requires_degraded_fidelity` flag is cleared deterministically.
5. **Mitigate Deadlock Risks:** Ensure the per-thread FIFO lock has a timeout or abort signal mechanism so a stalled LLM call doesn't permanently freeze concurrent pipeline branches.
6. **Include the Dual-Write Fallback:** Both drafts correctly identify the need for dual-writing `checkpoint.json` and the legacy flat file for one sprint. Make this a mandatory requirement in the final DoD.
