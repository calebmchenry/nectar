# Sprint NEXT Draft Critique

**Reviewer:** Codex
**Date:** 2026-03-19

Reviewed against:

- `docs/sprints/drafts/NEXT-CLAUDE-DRAFT.md`
- `docs/sprints/drafts/NEXT-GEMINI-DRAFT.md`
- `docs/compliance-report.md`
- `src/agent-loop/session.ts`
- `src/agent-loop/types.ts`
- `src/agent-loop/events.ts`
- `src/agent-loop/transcript.ts`
- `src/agent-loop/provider-profiles.ts`
- `src/llm/client.ts`
- `src/llm/types.ts`
- `src/handlers/codergen.ts`
- `src/handlers/registry.ts`
- `src/engine/context.ts`
- `src/engine/events.ts`
- `src/engine/engine.ts`
- `src/garden/types.ts`
- `src/garden/validate.ts`

The Claude draft is the better basis for the final sprint. It is narrower, better sequenced against the current repo, and much closer to something that can be implemented directly. The Gemini draft has a better "close several compliance gaps at once" story, but that breadth is exactly the problem: it mixes four different change surfaces in one sprint, and several implementation details do not match the code as it exists today. The merged sprint should stay centered on C1 subagents, optionally absorb the nearby C3 event-bridge fix, and defer L9 and A1.

## Claude Draft

### Strengths

- This is the more implementation-ready draft. The phase ordering, file plan, and lifecycle detail map directly onto existing primitives in `AgentSession`, `TranscriptWriter`, `ToolRegistry`, and provider profiles.
- It picks the right dependency direction. `docs/compliance-report.md` makes C1 the only High gap, and Claude correctly treats A1 as something that should come after subagents, not in the same sprint.
- The plan is grounded in the current session control plane. `submit()`, `followUp()`, `steer()`, `abort()`, and persistent conversation history already exist in `src/agent-loop/session.ts`, so the draft is extending a real abstraction rather than inventing a parallel one.
- The draft is materially stronger on operational detail than Gemini: depth limiting, concurrency limiting, per-child budgets, abort propagation, nested transcripts, and engine event bridging are all called out.
- The Definition of Done is the stronger of the two drafts. It is mostly behavior-based, testable, and tied to the actual gap closures the sprint claims.

### Weaknesses

- The cut line is not actually clean. Phase 5 is described as deferrable, but timeout handling already appears in Phase 2 and is also required by the Definition of Done. That means the sprint has overlapping timeout ownership and no true "core vs optional" boundary.
- `ExecutionContext.appendLog()` is treated as a low-friction add-on, but `src/engine/context.ts` is currently a `Map<string, string>` wrapper. An append-only run log implies either richer typing, serialization into strings, or special clone/restore rules. The draft does not commit to one.
- Completed-child cleanup is underspecified. The plan uses an `activeChildren` map and a concurrency cap, and the DoD says completed children free slots, but the implementation phases do not clearly define when a completed child is removed if the parent never calls `close_agent`.
- Workspace override handling is looser on paper than it is in code. The current execution environment is rooted once in `LocalExecutionEnvironment`; "child workspace override within the parent root" needs a concrete re-rooting or cwd policy, not just a validation rule.
- Usage aggregation is mentioned in the risk section, but it is not part of the phase plan or Definition of Done. If aggregate parent-plus-child cost reporting matters, it should be explicit. If it does not, it should be removed from the sprint narrative.
- Transcript and event ordering are likely trickier than the draft suggests. Current transcript writes are async fire-and-forget in several places, and the engine bridge in `src/handlers/codergen.ts` only knows about the current agent event set.

### Gaps in Risk Analysis

- There is no explicit risk entry for completed children remaining retained in memory or blocking new spawns if cleanup semantics are wrong.
- There is no explicit risk entry for workspace override path normalization, symlink traversal, or nonexistent child workspaces.
- There is no explicit risk entry for transcript and event ordering under concurrent child activity, including races between parent and child writes.
- There is no explicit risk entry for sibling-child file conflicts. The draft mentions parent/child overlap, but sibling agents editing the same file is equally plausible.
- There is no explicit risk entry for simulator and test-harness complexity. Multi-session tests tend to become timing-sensitive, and the sprint depends heavily on them.

### Missing Edge Cases

- `wait` called with an empty array, duplicate child IDs, or a mixed set of known and unknown IDs.
- `send_input` racing with child completion after the state check but before `steer()` or `followUp()` is applied.
- `close_agent` called on a child that already completed successfully but has not yet been evicted from tracking.
- A parent that never calls `wait` but still expects child transcripts and cleanup to be correct on parent shutdown.
- A workspace override that uses `..`, points through a symlink, or targets a directory that does not exist.
- A child that produces no final text but does produce tool output or an error; `wait` still needs a stable result shape.
- A grandchild inheriting limits and workspace overrides from a child session rather than the top-level parent.

### Definition of Done Completeness

- This is the better DoD, but it still needs a few repo-specific acceptance points.
- It should explicitly require `npm run build` in addition to tests.
- It should require at least one end-to-end codergen integration test proving the subagent tools are actually visible to the model through provider profiles and usable through the existing session loop.
- It should state exactly when completed children release concurrency slots and whether `wait` alone is sufficient or `close_agent` is required.
- It should define the external semantics of timeout versus abort. Right now the draft uses `timeout` as a child result status, but the existing session result type only knows `success`, `failure`, and `aborted`.
- It should require workspace override boundary tests, including rejection of out-of-root paths.
- It should require deterministic transcript/event assertions for nested child runs, not just existence of nested directories.

## Gemini Draft

### Strengths

- The draft does a good job of identifying adjacent compliance wins. C1, L9, A1, and C3 are all real entries in `docs/compliance-report.md`.
- The use cases are clear and readable. A reader can understand what the sprint is trying to make possible.
- It is directionally correct that manager-loop work becomes much more meaningful once subagents exist.
- Pulling C3 into the conversation is useful. The current code already carries `full_content` on `AgentToolCallCompletedEvent` and writes full tool output to transcript artifacts, so there is a plausible small adjacent fix here.

### Weaknesses

- The scope is too broad for one sprint. C1 touches the agent loop, L9 touches the LLM SDK, A1 touches the engine and handler layer, and C3 touches the event bridge. That is not one sprint theme; it is four.
- Several implementation details do not match the current repo. `UnifiedClient.generate()` already exists in `src/llm/client.ts` with the legacy `LLMClient.generate(LLMRequest)` shape, so adding a high-level tool-loop `generate()` needs an API migration plan, not just a new method body.
- The subagent tool plan is technically wrong in places. `send_input` calling `session.submit(message)` conflicts with current session semantics because `submit()` rejects while a session is PROCESSING; the correct mechanisms are `steer()` and `followUp()`.
- `close_agent` is also underspecified. In the current session model, `close()` is a graceful state transition, but it does not abort in-flight work. A processing child needs `abort()`, not just `close()`.
- The manager-loop plan misses required type and parser work. Adding `shape="house"` is not just `validate.ts` and `registry.ts`; `NodeKind`, shape normalization, and parser/runtime handling all need to know about the new kind.
- C3 is overstated as a standalone phase. The event type already exposes `full_content`; the obvious missing piece is the bridge to engine-level events and any downstream consumers.
- The draft has the weaker Definition of Done and no real cut line. If any one of the four tracks slips, the whole sprint story becomes ambiguous.

### Gaps in Risk Analysis

- There is no explicit risk entry for API compatibility around `UnifiedClient.generate()`, which is already a public method with a different contract.
- There is no explicit risk entry for introducing a new `house` shape into the garden type system and execution engine.
- There is no explicit risk entry for recursive event volume or event-shape complexity when a manager node observes a child pipeline that itself emits agent and parallel events.
- There is no explicit risk entry for child-pipeline abort semantics, especially if the child manager loop is blocked on human input.
- There is no explicit risk entry for coupling risk: combining C1, L9, A1, and C3 means failure in one track can block claiming success on the others.
- There is no explicit risk entry for the current string-only `ExecutionContext` and `RunState.context` surfaces, which limit how rich manager-loop control data can be.

### Missing Edge Cases

- `send_input` to a PROCESSING child, an AWAITING_INPUT child, an already CLOSED child, and an unknown child ID.
- `wait` on multiple children, duplicate IDs, or children that finished before the wait call starts.
- A manager node pointing at a nonexistent pipeline, the current pipeline, or a cycle of manager-managed pipelines.
- Child pipeline runs that request human input while the parent manager also needs to remain responsive.
- A `client.generate()` loop receiving malformed tool-call JSON, unknown tool names, or repeated tool-use turns until the max-round limit is exceeded.
- `shape="house"` parsing when a node also uses `type=` overrides or unsupported attributes.
- Very large tool outputs in C3, where event payload size may be inappropriate even if transcript artifacts can store the full output.
- A manager loop observing a child run that itself spawns subagents, producing nested event trees.

### Definition of Done Completeness

- This DoD is too thin to be the final merged checklist.
- It should require `npm run build` in addition to tests.
- It should include explicit API-compatibility acceptance for the existing `UnifiedClient.generate()` callers.
- It should specify the parser/type/runtime work required to make `shape="house"` a first-class node kind rather than only a validator change.
- It should define the exact behavior of `send_input`, `wait`, and `close_agent` against current session states.
- It should separate "fully closed" gaps from "partially addressed" gaps. As written, it claims four closures without enough behavior-level proof for any of them.
- It should include a cut line. Without one, the team could implement half of C1 and half of A1 and still not know whether the sprint succeeded.

## Recommendations For The Final Merged Sprint

- Use the Claude draft as the structural base.
- Keep the sprint centered on C1 subagent tools. That is the only High gap, and it maps best to the current `AgentSession` architecture.
- Pull in only the small adjacent part of Gemini's C3 work if capacity allows: bridge `full_content` from agent events into engine-level events or an artifact reference. Do not let that turn into a broader transcript redesign.
- Defer L9 high-level `generate()` and A1 manager loop to the next sprint. Both are real gaps, but both deserve focused design after C1 stabilizes.
- Tighten the merged plan around completed-child eviction semantics before implementation starts: decide whether children are removed on completion, on `wait`, or only on `close_agent`.
- Tighten the merged plan around timeout semantics before implementation starts: decide whether timeout is a first-class child status or is represented as `aborted` plus structured reason.
- Tighten the merged plan around `ExecutionContext.appendLog()` before implementation starts: decide how it is stored and cloned in a string-only context model.
- Tighten the merged plan around workspace overrides before implementation starts: decide exactly how child workspaces are rooted and validated.
- Strengthen the merged Definition of Done with `npm run build && npm test`.
- Strengthen the merged Definition of Done with integration coverage for `spawn_agent`, `send_input`, `wait`, and `close_agent` through the real codergen session path.
- Strengthen the merged Definition of Done with explicit tests for duplicate and unknown child IDs, empty-wait policy, workspace escape rejection, and concurrency-slot release.
- Strengthen the merged Definition of Done with recursive abort coverage through at least three levels of depth.
- Strengthen the merged Definition of Done with deterministic transcript and engine-event assertions for nested child runs.
- Keep a hard cut line: ship C1 first, optionally C3 if it remains small, and move A1/L9 out of the sprint if schedule tightens. That produces a coherent sprint with a clear compliance win instead of an overextended partial merge.
