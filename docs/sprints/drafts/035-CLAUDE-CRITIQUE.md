# Critique of `NEXT-CODEX-DRAFT.md` and `NEXT-GEMINI-DRAFT.md`

This critique evaluates both drafts against `docs/compliance-report.md`, `docs/INTENT.md`, and the current code surface. The main planning reality is that report drift already appears to exist. For example, `agent_session_completed` is currently emitted in `src/agent-loop/session.ts`, so the next sprint needs an audit-first step before it treats every listed gap as still open.

## Overall Assessment

`NEXT-CODEX-DRAFT.md` is the stronger base for the next sprint. It is more disciplined about scope, more aligned with the project intent around resumability and observability, and more realistic about the difference between high-impact runtime contract fixes and low-value spec-shape closure.

`NEXT-GEMINI-DRAFT.md` is still useful, but mostly as a compliance backlog document. As written, it is too broad, it assumes the report is fully current, and it mixes high-value fixes with migration-heavy or low-priority work that should not share the same sprint.

## `NEXT-CODEX-DRAFT.md`

### Strengths

- It focuses on the highest-value runtime truth problems: condition routing, canonical node status artifacts, session turn accounting, recoverable context overflow, and provider retry/content-filter semantics.
- It is well aligned with `docs/INTENT.md`, especially the "Resumable by Default" and "Observable and Debuggable" principles.
- It explicitly distinguishes between must-fix behavior gaps and lower-value compliance items, which is the right posture for sprint planning.
- The audit-first step is a major strength. The repo already shows signs of report drift, so this draft is less likely to waste sprint time on already-closed items.
- The additive-change bias is sound. For this area, preserving existing working contracts and filling in missing truth is safer than renaming or replatforming everything.
- The implementation phases are concrete and test-oriented, and the draft treats compliance-report refresh as real work rather than documentation afterthought.

### Weaknesses

- It is still a fairly large sprint. Engine artifacts, interviewer semantics, session lifecycle, provider adapters, and retry behavior all move in one pass.
- The `status.json` consolidation story is not quite broad enough. The conflict is not only engine vs `codergen`; `src/agent-loop/transcript.ts` also writes a node-level `status.json`, so there are more competing writers than the draft calls out.
- The draft says to pick one turn-limit policy, but it does not define the desired session state machine tightly enough yet. "Reject or close subsequent work consistently" is directionally right, but the merged sprint should commit to one exact behavior.
- The `notes` fallback is sensible, but the draft does not specify when synthesized notes are acceptable, whether empty notes are allowed, or how handler-authored notes should take precedence.
- `ContextLengthError` recovery is correctly prioritized, but the draft is still vague about queued follow-ups, partial streamed output, and subagent behavior after recovery.
- Phase 1 may be overloaded. Condition semantics, status artifact ownership, and `CONFIRMATION` behavior each touch different parts of the engine surface and could create more review churn than the percentage estimate suggests.

### Gaps in Risk Analysis

- It does not explicitly call out the transition risk from multiple current `status.json` writers, especially `src/engine/engine.ts`, `src/handlers/codergen.ts`, and `src/agent-loop/transcript.ts`.
- It does not explicitly call out compatibility risk for existing consumers of node `status.json`, including tests, CLI status readers, and any postmortem tooling.
- It does not explicitly call out semantic risk from changing how bare identifiers are parsed. Some existing gardens may have relied on the current "unknown root becomes literal string" behavior.
- It does not explicitly call out session-consistency risk when `ContextLengthError` happens with queued follow-ups, active subagents, or partially emitted assistant output.
- It does not explicitly call out storage or event-size growth from always attaching full tool output, especially if the same payload is persisted in events, transcripts, and subagent artifacts.

### Missing Edge Cases

- Bare dotted keys whose first segment collides with a reserved namespace, such as a literal context key named `steps.foo`.
- `EXISTS`, `NOT`, empty-string, numeric, and boolean coercion behavior on newly supported unqualified context lookups.
- `CONFIRMATION` prompts with default `NO`, missing explicit yes/no labels, timeout fallback, lowercase or typed responses, and auto-approve behavior.
- Turn-limit exhaustion when `followUp()` work is already queued before the session hits the lifetime cap.
- Post-limit behavior for later `submit()`, `followUp()`, `abort()`, and `close()` calls.
- `ContextLengthError` after some assistant text or tool-planning output has already been emitted, not just before generation starts.
- Tool outputs that are binary, already truncated at the tool layer, or produced by subagents rather than top-level tool calls.

### Definition of Done Completeness

The DoD is stronger than the Gemini draft, but it still needs a few additions.

- It should explicitly require convergence on one canonical node `status.json` owner and shape across engine, codergen, and transcript-backed flows.
- It should explicitly require one exact session policy after `max_turns` is exhausted.
- It should include compatibility checks for any code path that reads node status artifacts or tool-completion events.
- It should include at least one resume-related smoke test, because status truth and recoverable context failures both affect the resumability promise directly.

### Verdict

This is the right foundation for the next sprint. It needs tighter acceptance criteria around artifact ownership and post-error session behavior, but it is aiming at the correct problems.

## `NEXT-GEMINI-DRAFT.md`

### Strengths

- It maps very directly to the compliance report, which makes it easy to audit and easy to use as a backlog reference.
- It does not miss the existence of important gaps such as unqualified condition lookup, lifetime turn counting, tool-output truth, context-length handling, and Anthropic content-filter classification.
- It gives a clean, easy-to-scan inventory of work across the engine, agent loop, and LLM layers.
- As a long-range compliance closure plan, it is coherent.

### Weaknesses

- It is over-scoped for one sprint. Closing all 20 gaps in one pass is too much cross-cutting change for a repo that still shows signs of report drift.
- It lacks an audit-first phase. That is a serious planning flaw. The current code appears to already emit `agent_session_completed`, which means the sprint could spend time "fixing" something that is already done.
- It treats high-impact runtime gaps and low-priority/spec-optional items as if they belong in the same sprint. `L8` is even marked low priority in the report, yet it is still bundled into the core goal.
- It pulls in several migration-heavy items that are not the best next sprint: `A4` checkpoint path migration, `C2` 1:1 prompt mirroring, `C3` Gemini web tools, `L3` stream-event renames, `L4` top-level `stream()`, `L5` image detail, and `L7` request metadata.
- Some of its technical prescriptions are too shallow for the actual code shape. `A3` likely needs parser changes as well as resolver changes, not only `src/engine/conditions.ts`. `A2` is broader than `src/handlers/codergen.ts`, because the engine already writes status artifacts and transcript-backed codergen flows also write `status.json`.
- The `L6` proposal changes the base retry contract to `retry_after` without reconciling the existing `retry_after_ms` usage spread across adapters, middleware, and runtime callers.
- The Definition of Done is thin for a sprint of this size. It does not require report refresh, build verification, migration validation, or documentation updates.

### Gaps in Risk Analysis

- It does not call out report drift as a risk, even though that is already the first thing likely to distort sprint scope.
- It does not call out compatibility risk for checkpoint-path migration with existing cocoons, resume flows, and filesystem assumptions.
- It does not call out compatibility risk for event renames, module API expansion, or retry-field contract changes.
- It does not call out offline, restricted-network, or privacy-sensitive environments for Gemini `web_search` / `web_fetch`.
- It does not call out maintenance cost, token budget, or source-pinning risk for native prompt mirroring.
- It does not call out blast radius across CLI rendering, SSE consumers, persisted transcripts, and test fixtures when event nomenclature changes.

### Missing Edge Cases

- Existing cocoon files during `A4` migration, including partial resumes and mixed old/new checkpoint layouts.
- Coexistence strategy for old and new stream-event names if a migration period is needed.
- `web_search` and `web_fetch` when disabled, blocked by policy, offline, rate-limited, or unavailable in the current environment.
- `ContextLengthError` during streaming after partial output has already been emitted.
- Anthropic content-filter detection in both non-streaming and streaming paths.
- `Retry-After` header forms beyond simple integer seconds, including date-based values and non-429 retryable errors.
- `GenerateRequest.metadata` and image `detail` when providers ignore them, partially support them, or return them untouched.
- Global turn-limit exhaustion when follow-up work is already queued.

### Definition of Done Completeness

The DoD is measurable as a compliance slogan, but it is not complete as a shipping checklist.

- It should require `npm run build` as well as test coverage.
- It should require compliance-report refresh so the post-sprint state is auditable.
- It should require documentation updates for any changed public contracts.
- It should require either backward-compatibility coverage or an explicit decision that compatibility is intentionally broken.
- It should require at least one smoke pass that exercises the most migration-sensitive paths instead of only unit-level closure.

### Verdict

This should not be the next sprint as written. It is a useful backlog map, but it is too broad and too migration-heavy to use as the primary sprint plan.

## Recommendations for the Final Merged Sprint

- Use `NEXT-CODEX-DRAFT.md` as the backbone.
- Keep the audit-first phase and treat report correction as a first-class deliverable. That is mandatory now that the repo already appears to have at least some stale findings.
- Keep the high-impact scope: `A1`, `A2`, `A3`, `A5`, `C1`, `C5`, `C6`, `L1`, `L2`, and `L6`.
- Add an explicit verification item for adjacent drift, especially `C4`, so the merged sprint does not preserve false gaps right next to the scoped work.
- Tighten the artifact plan so "canonical `status.json`" covers every current writer, not just engine and codergen error paths.
- Tighten the session plan so the merged sprint defines exact state transitions after `max_turns` exhaustion and after recoverable `ContextLengthError`.
- Add acceptance coverage for reserved-root collisions, literal-compatibility regressions, confirmation defaults/timeouts, queued follow-ups, partial streamed output, and subagent tool completions.
- Keep the Codex draft's additive compatibility posture. If any event or artifact contract must change, prefer additive fields or aliases over rename-only changes.
- Defer `A4` until checkpoint-path migration is reconciled with Nectar's cocoon/workspace contract and a real migration plan exists.
- Defer `C2`, `C3`, `C7`, `L3`, `L4`, `L5`, `L7`, and `L8` unless the audit unexpectedly shows they are higher-impact than currently believed.
- If the sprint ends with spare capacity, spend it on report refresh, documentation, and regression coverage before pulling new scope.
