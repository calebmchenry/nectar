# Sprint NEXT Draft Critique

**Reviewer:** Codex
**Date:** 2026-03-20

Reviewed against:

- `docs/sprints/drafts/NEXT-CLAUDE-DRAFT.md`
- `docs/sprints/drafts/NEXT-GEMINI-DRAFT.md`
- `src/garden/parse.ts`
- `src/garden/types.ts`
- `src/agent-loop/session.ts`
- `src/agent-loop/provider-profiles.ts`

The Claude draft is the stronger basis for the final merged sprint. It is substantially more implementation-ready, especially on checkpointing, resume semantics, and deterministic fidelity handling. The Gemini draft contributes two important ideas the final merge should keep: the graph-default step in A5 thread resolution and the inclusion of C1 context-window warnings. The merged sprint should stay centered on A4/A5 runtime fidelity and session reuse, preserve Claude's deterministic approach, and defer A1 manager loop unless scope expands intentionally.

## Claude Draft

### Strengths

- This is the more executable plan. The architecture, phase breakdown, files summary, and DoD are detailed enough that an implementer could start without inventing core behavior during the sprint.
- The fidelity design is much stronger than Gemini's. Deterministic preambles with explicit character budgets make A4 testable and keep the sprint from depending on a second LLM call just to summarize context.
- The resume story is a major advantage. `pending_transition`, degraded resume after interrupted `full` sessions, and canonical checkpoints make A5 much more believable as a production feature rather than a happy-path demo.
- The run-directory migration strategy is pragmatic. Dual-write plus canonical-first reads is the right shape if the team decides A3/A8/A10 belong in this sprint.
- The draft treats concurrency as a real problem. Per-thread FIFO locking is the first draft mechanism that clearly acknowledges that shared `thread_id` plus parallel branches can corrupt conversation state.
- The DoD is the strongest of the two drafts. It is mostly behavioral, not just "component exists."

### Weaknesses

- The A5 thread-resolution chain is incomplete. The draft uses `node -> edge -> class -> previous`, but the compliance target for A5 is `node -> edge -> graph default -> subgraph class -> previous`. This omission appears in the architecture, tasks, tests, and DoD, so it is not just wording drift.
- Scope is still large. A4/A5/C3/A11 are coherent together, but adding A3/A8/A10 plus artifact persistence and CLI migration creates a much wider blast radius across engine, checkpointing, handlers, artifacts, and CLI.
- The default behavior change to `compact` is bigger than the draft frames it. Existing pipelines without fidelity annotations will change behavior materially, and the draft does not offer a compatibility flag, staged rollout, or stronger migration guidance.
- The run-directory contract is internally uneven. The architecture promises per-node `status.json`, `prompt.md`, and `response.md`, but the phases and DoD never commit to writing them.
- The conversation persistence story is slightly inconsistent. The runtime flow says thread conversation is written back after `full` runs, but the implementation plan says sessions stay live only in `SessionRegistry` and are not serialized, with degraded resume used instead.
- `ArtifactStore` is underspecified for binary payloads and long-term index growth. The interface accepts `Buffer | string`, but the storage plan only describes JSON-backed artifacts.

### Gaps in Risk Analysis

- There is no explicit risk entry for the missing graph-default thread-resolution step, even though it would leave A5 partially open.
- There is no explicit risk entry for partial or corrupt writes during dual-write migration. `checkpoint.json` plus legacy flat cocoon writes need atomicity or at least clear recovery behavior.
- There is no explicit risk entry for sensitive-data or disk-growth implications from persisting prompts, responses, preambles, and artifacts under `.nectar/cocoons/`.
- There is no explicit risk entry for head-of-line blocking when many parallel branches intentionally share one thread key and serialize behind the FIFO lock.
- There is no explicit risk entry for binary or non-UTF8 artifact payloads, especially near the inline/file-backed boundary.

### Missing Edge Cases

- A graph-level `thread_id` default with no node or edge override.
- A `full`-fidelity codergen node with no resolved thread id.
- A resume where canonical checkpoint and legacy flat cocoon disagree because one write succeeded and the other did not.
- Multiple incoming edges to the same target with different `fidelity` or `thread_id` values, followed by resume from `pending_transition`.
- Artifact payloads exactly at the 100KB threshold and payloads that are binary rather than text.
- Parallel branches sharing a thread where one branch fails or aborts while another branch is queued on the lock.

### Definition of Done Completeness

- This is the better DoD, but it still misses a few load-bearing acceptance points.
- Add explicit acceptance for graph-default thread resolution and tests for that precedence step.
- Add explicit acceptance for atomic write behavior or corruption handling for checkpoint and artifact persistence.
- Add explicit acceptance for `full` fidelity with no thread id, since that is a distinct runtime path.
- Add boundary tests for exactly-100KB artifacts and binary payloads.
- Either add per-node file outputs (`status.json`, `prompt.md`, `response.md`) to the DoD or remove them from the architecture section.

## Gemini Draft

### Strengths

- The draft has a simpler top-level story if the goal is pure engine semantics. It focuses on A4/A5/A1/C1/C3/A11 and avoids Claude's larger run-directory migration.
- It correctly includes the graph-default step in A5 thread resolution, which the Claude draft misses.
- It includes C1 context-window warnings, which are a legitimate operational safeguard and a useful companion to fidelity work.
- The use cases are easy to follow and make the value of thread reuse, fidelity enforcement, and manager loops readable quickly.
- If A1 were isolated into its own sprint, the manager-loop inclusion would be directionally correct. It is the main remaining medium-severity engine capability after A4/A5.

### Weaknesses

- The draft is under-specified relative to its scope. `ManagerLoopHandler` is described conceptually, not operationally: no child-graph selection model, no iteration-state contract, no exit semantics, no failure semantics, and no resume story.
- The fidelity design is much weaker than Claude's. `truncate`, `compact`, and `summary:*` are described at a high level, but there are no concrete budgets, no truncation priorities, and no durable prompt-shaping contract.
- `summary:*` depends on an extra LLM call, which adds latency, cost, provider coupling, and failure modes right in the middle of an engine-safety sprint.
- There is no persistence or degraded-resume design for A5. Session reuse without a checkpoint and resume story is incomplete.
- There is no concurrency model for shared `thread_id` use, and no provider/model mismatch semantics for reused sessions.
- C1 depends on accurate `context_window_size` data in `ProviderProfile`. That is real implementation work in the current codebase, but the draft does not treat it as a dependency or acceptance criterion.
- There is no cut-line. That is a serious planning problem because A1, A4/A5, and C1 do not carry equal design risk.

### Gaps in Risk Analysis

- There is no explicit risk entry for resumed runs losing live sessions after a `full`-fidelity node.
- There is no explicit risk entry for the secondary summarization call failing, timing out, or producing low-quality summaries.
- There is no explicit risk entry for inaccurate or missing `context_window_size` values causing noisy or incorrect C1 warnings.
- There is no explicit risk entry for manager loops that involve human-input nodes, nested event trees, or child graphs that never settle cleanly.
- There is no explicit risk entry for shared-thread parallelism and interleaved session access.
- There is no explicit risk entry for the parser/type/runtime plumbing required to make `shape="house"` a first-class node kind in the current codebase.

### Missing Edge Cases

- Graph-default `thread_id` interacting with node overrides, edge overrides, and previous-node inheritance.
- `summary:*` with empty context, very large context, or context dominated by large artifact references.
- Resume after interruption of a `full`-fidelity session.
- A `manager_loop` with zero managed children, a missing subgraph, or a child that never reaches terminal status.
- Context-window warnings at exactly 80%, repeated warnings after the threshold is crossed, or providers with no known window size.
- `reasoning_effort` changes on reused sessions across providers that expose different or no reasoning controls.

### Definition of Done Completeness

- The DoD is too thin for the set of gap closures the draft claims.
- Add `npm run build` and regression gates, not just feature checks.
- Add acceptance for shared-thread serialization, provider/model mismatch handling, and degraded resume.
- Add acceptance for the `context_window_size` data work needed to make C1 meaningful.
- Add explicit manager-loop acceptance criteria: iteration limit, child failure handling, human-input blocking behavior, and exit routing.
- Add summary-mode failure-path criteria: what happens when the secondary summary call errors or returns unusable output.
- Add end-to-end tests; unit tests alone are not enough for this design.

## Recommendations For The Final Merged Sprint

- Use the Claude draft as the structural base. It is much closer to an implementation plan than the Gemini draft.
- Fix A5 in that merged draft by restoring the full thread-resolution chain: `node -> edge -> graph default -> subgraph class -> previous`.
- Keep Claude's deterministic preamble approach. Do not adopt Gemini's extra-LLM summarization path in this sprint.
- Keep the sprint centered on A4/A5 first. If scope needs to stay tight, make A3/A8/A10 the cut-line rather than half-shipping filesystem migration.
- Pull in Gemini's C1 warning work only if the sprint explicitly includes the provider-profile data changes needed to support `context_window_size`. Otherwise defer C1 cleanly.
- Defer A1 manager loop to the next sprint. It deserves focused design once fidelity, thread reuse, and resume semantics are stable.
- Resolve the run-directory contract before implementation starts: either commit to per-node prompt/response/status files and test them, or remove them from the promised architecture.
- Strengthen the merged DoD around graph-default thread resolution, degraded resume, dual-write failure handling, binary artifacts, and shared-thread concurrency.
- If the team wants a sprint title that matches the likely merged scope, prefer something like `Sprint 015: Runtime Fidelity, Thread Reuse & Resume Safety` or `Sprint 015: Runtime Fidelity, Thread Reuse & Canonical Run State`.
