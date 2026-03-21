# Sprint: Runtime Contract Closure — Outcome Truth, Session Accounting, and Error Recovery

## Overview

**Goal:** Close the highest-impact remaining compliance gaps that still affect engine decisions, run artifacts, and AI session reliability. After this sprint, condition expressions follow the spec's context-lookup behavior, per-node `status.json` files tell the whole truth, agent sessions enforce lifetime turn limits, tool completion events carry full payloads, context-window failures degrade cleanly, and provider retry/content-filter semantics are correct.

**Why this sprint, why now:**

1. `npm test` and `npm run build` are already green. The repo does not need another stabilization sprint before it can absorb contract work.
2. The remaining gaps are not equal. A3, C1, C5, C6, L1, L2, and L6 change actual runtime behavior or postmortem quality. A4, C2, C3, L5, L7, and L8 do not.
3. `INTENT.md` explicitly prioritizes "Resumable by Default" and "Observable and Debuggable." This sprint is about those promises, not new product surface area.
4. The open work clusters cleanly into one bounded sprint: engine outcome contract, agent session accounting, and provider error semantics.

**Scope:** Close gaps `A1`, `A2`, `A3`, `A5`, `C1`, `C5`, `C6`, `L1`, `L2`, and `L6`. Start with a short audit to confirm each targeted gap is still open in code and trim any stale items from the worklist before implementation. If a scoped gap is already closed, spend the time on tests and report correction first; do not pull in unrelated feature work.

**Out of scope:**

- `A4` checkpoint-path migration from `.nectar/cocoons` to `{logs_root}/checkpoint.json`
- `C2` native prompt mirroring, `C3` Gemini web tools, `C7` Anthropic beta/header expansion
- `L3` stream event renames beyond additive aliases, `L4` API-surface expansion, `L5` image detail, `L7` request metadata, `L8` circuit breaker middleware
- New CLI commands, Hive UI work, Seedbed/Swarm features, or packaging/distribution changes

---

## Use Cases

1. **Unqualified context routing works.** A garden author writes `condition="tests_passed=true"` or `condition="qa.tests_passed=true"` and the engine resolves it against the context store instead of treating it as a string literal.

2. **Node status artifacts are actually useful.** After any node completes, `status.json` contains the fields the spec promises: outcome, preferred label, suggested next IDs, context updates, and a human-readable note. Debugging a failed run no longer requires reading multiple files or reverse-engineering handler behavior.

3. **Confirmation gates behave like confirmation gates.** A `wait.human` confirmation prompt is resolved consistently by `AutoApprove`, console, and queued interviewers. The affirmative/default path is deterministic instead of being treated as a generic multiple-choice prompt.

4. **Long-lived sessions honor lifetime limits.** A `codergen` session with one `submit()` call and several `followUp()` calls hits `max_turns` exactly once across the lifetime of the session. The counter does not silently reset per work item.

5. **Tool-call audits are trustworthy.** Every `agent_tool_call_completed` event includes the full tool output that the agent session actually saw, not just a preview. Event consumers, transcripts, and test fixtures all agree on the same payload.

6. **Context overflow is recoverable.** When a provider raises `ContextLengthError`, the active work item fails with warning events, but the session remains in a recoverable state so the caller can retry with a shorter prompt or a new summarization strategy.

7. **Provider retry/error semantics are correct.** A dropped stream retries if no content has been yielded yet. An Anthropic safety/content block surfaces as `ContentFilterError`. Any retryable provider error can carry `retry_after_ms` directly.

---

## Architecture

### Principle: Fix contracts that affect truth, not cosmetics

This sprint deliberately ignores low-value spec-shape work and focuses on contracts that change one of three things:

- which edge the engine takes
- what artifacts and events say happened
- whether an agent session can recover from provider failures

### Design decisions

**1. `status.json` becomes the canonical per-node outcome artifact.**

Right now the engine and `codergen` can write simplified or conflicting status files. That is the wrong shape. The engine should own one spec-shaped `status.json` writer, and handlers should return a richer `NodeOutcome` instead of hand-rolling their own node-status payloads. Handler-specific extras can live in separate artifacts, but `status.json` must be consistent across node types.

**2. Unqualified condition identifiers resolve to context keys.**

The parser/evaluator should treat unknown identifier roots as direct context lookups, not string literals. `foo.bar=true` should mean `context["foo.bar"] == "true"` unless the root is one of the reserved namespaces (`outcome`, `preferred_label`, `context`, `steps`, `artifacts`). This is the smallest change that restores spec-compatible gardens without breaking existing qualified expressions.

**3. Session limits are lifetime limits.**

`max_turns` must live on the `AgentSession` instance, not inside a single `processWorkItem()` invocation. The current work item can fail with `turn_limit_exceeded`, but the accounting must survive follow-ups. Once the lifetime cap is reached, the session should become terminal for new work instead of silently resetting.

**4. Recovery beats forced shutdown on context overflow.**

A `ContextLengthError` is not an authentication failure. It should emit warning events, fail the active work item, and return the session to a recoverable state (`AWAITING_INPUT`) so a caller can retry with a shorter prompt, compacted context, or a new session. Do not auto-close.

**5. Error semantics converge through additive change.**

Do not rename working events or rip out existing fields. Add the missing fields (`notes`, `retry_after_ms`, full tool output) and reuse existing event/error types where possible. This sprint is about truthful data, not churn.

**6. Audit the report before writing code.**

`docs/compliance-report.md` appears to have at least some drift from the live code. The first implementation task is to verify each scoped gap against source and tests, then keep the sprint bounded to the gaps that are still real. No opportunistic scope growth.

---

## Implementation phases

### Phase 1: Audit and Engine Outcome Contract (~30%)

**Files:** `src/engine/types.ts`, `src/engine/engine.ts`, `src/engine/condition-parser.ts`, `src/engine/conditions.ts`, `src/handlers/codergen.ts`, `src/interviewer/types.ts`, `src/interviewer/auto-approve.ts`, `src/interviewer/console.ts`, `src/interviewer/queue.ts`, `test/engine/conditions.test.ts`, `test/handlers/codergen.test.ts`, `test/handlers/wait-human.test.ts`, `test/interviewer/interviewer.test.ts`

**Tasks:**

- [ ] Reconcile `A1`, `A2`, `A3`, and `A5` against the current code before editing. If any are already closed, mark them as report drift and replace the implementation task with missing tests plus report correction.
- [ ] Add `notes?: string` to `NodeOutcome` and make the engine persist it. Do not force every handler to generate prose on day one; allow the engine to synthesize a fallback note when a handler omits one.
- [ ] Replace the current minimal `writeNodeStatus()` payload with the spec-shaped artifact: `{ outcome, preferred_label, suggested_next_ids, context_updates, notes, started_at, completed_at, duration_ms, node_id }`.
- [ ] Stop `codergen` from writing a second incompatible `status.json`. Keep agent/transcript-specific metadata in its existing artifacts, but let the engine own the canonical node status file.
- [ ] Change condition parsing and evaluation so unqualified identifiers and dotted paths fall through to direct context lookup instead of being treated as literals.
- [ ] Make `CONFIRMATION` a first-class question type in interviewer implementations. At minimum: `AutoApprove` chooses the affirmative/default path deterministically, console rendering uses confirmation semantics, and queue normalization preserves `YES`/`NO` meaning instead of generic choice handling.
- [ ] Add regression coverage for unqualified keys, dotted unqualified keys, reserved-root precedence, and confirmation-gate normalization.

### Phase 2: Agent Session Accounting and Tool-Output Truth (~30%)

**Files:** `src/agent-loop/session.ts`, `src/agent-loop/types.ts`, `src/agent-loop/events.ts`, `test/agent-loop/session.test.ts`, `test/agent-loop/session-control.test.ts`, `test/agent-loop/context-window.test.ts`, `test/agent-loop/events.test.ts`

**Tasks:**

- [ ] Move turn accounting from local work-item scope to session scope so `max_turns` counts across `submit()` and `followUp()` for the lifetime of the session.
- [ ] Make the turn-limit path explicit: emit `agent_turn_limit_reached`, fail the current work item with `turn_limit_exceeded`, and reject or close subsequent work consistently. Pick one policy and test it; do not leave mixed behavior.
- [ ] Change `agent_tool_call_completed` emission so `full_content` is always populated with the complete tool output returned to the session, not only when preview truncation occurred. `content_preview` stays as a convenience field.
- [ ] Ensure the same full-output contract applies to subagent tool completions, not just normal tool calls.
- [ ] Catch `ContextLengthError` in the session loop, emit `agent_warning` plus `context_window_warning`, and return the session to a recoverable state instead of hard-closing it like auth failure.
- [ ] Add regression tests for lifetime turn counting across follow-ups, full tool output on both truncated and non-truncated calls, and recoverable context-length failure behavior.

### Phase 3: Provider Retry and Content-Filter Semantics (~25%)

**Files:** `src/llm/errors.ts`, `src/llm/retry.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `test/llm/errors.test.ts`, `test/llm/retry.test.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/gemini.test.ts`

**Tasks:**

- [ ] Make `StreamError` retryable again. Keep the existing "no retry after partial output" guard in retry middleware; only pre-output stream failures should retry.
- [ ] Add `retry_after_ms?: number` to the base `LLMError` contract and populate it from `Retry-After` on any retryable provider error, not just `RateLimitError`.
- [ ] Update retry middleware to consult the generic base error field instead of special-casing only `RateLimitError`.
- [ ] Teach the Anthropic adapter to raise `ContentFilterError` when the provider response indicates safety/content blocking. Do not flatten those cases into `InvalidRequestError`.
- [ ] Add regression coverage for retry-after on non-429 retryable errors, pre-output stream retries, no retry after yielded content, and Anthropic content-filter classification in generate and stream paths where applicable.

### Phase 4: Verification and Report Refresh (~15%)

**Files:** `docs/compliance-report.md`, affected test files

**Tasks:**

- [ ] Run `npm run build` and `npm test`; both must stay green.
- [ ] Update the compliance report to move the actually closed gaps from `GAPS` to `IMPLEMENTED`.
- [ ] If the audit found stale report items, correct the report explicitly instead of silently leaving false gaps in place.
- [ ] Do one end-to-end smoke pass through a garden with conditional routing, a `wait.human` confirmation, and a `codergen` session long enough to exercise the new turn accounting.
- [ ] Do not pull a backup feature unless all scoped gaps are closed, the report is refreshed, and the suite is green. If there is slack after that, the single backup item is additive stream-event aliases for `L3`, not new product surface area.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/types.ts` | Modify | Add `notes` to `NodeOutcome` and clarify outcome artifact shape |
| `src/engine/engine.ts` | Modify | Centralize canonical `status.json` writing and persist full outcome fields |
| `src/engine/condition-parser.ts` | Modify | Parse unqualified identifiers as context-addressable variables |
| `src/engine/conditions.ts` | Modify | Resolve unqualified/dotted keys against context with reserved-root precedence |
| `src/handlers/codergen.ts` | Modify | Stop writing incompatible node `status.json`; return richer outcome metadata |
| `src/interviewer/types.ts` | Modify | Tighten `CONFIRMATION` normalization semantics |
| `src/interviewer/auto-approve.ts` | Modify | Deterministic affirmative/default resolution for confirmation prompts |
| `src/interviewer/console.ts` | Modify | Render confirmation prompts distinctly from generic multiple choice |
| `src/interviewer/queue.ts` | Modify | Preserve yes/no semantics for queued confirmation answers |
| `src/agent-loop/session.ts` | Modify | Enforce lifetime turn counting, recover from `ContextLengthError`, emit full tool output |
| `src/agent-loop/types.ts` | Modify | Document and enforce session-lifetime `max_turns` semantics |
| `src/agent-loop/events.ts` | Modify | Keep tool-completion event contract aligned with full output payloads |
| `src/llm/errors.ts` | Modify | Make `StreamError` retryable and add base `retry_after_ms` support |
| `src/llm/retry.ts` | Modify | Use generic retry-after handling for any retryable provider error |
| `src/llm/adapters/anthropic.ts` | Modify | Raise `ContentFilterError` for safety/content blocks |
| `src/llm/adapters/openai.ts` | Modify | Populate base retry-after metadata for retryable errors |
| `src/llm/adapters/gemini.ts` | Modify | Populate base retry-after metadata for retryable errors |
| `src/llm/adapters/openai-compatible.ts` | Modify | Populate base retry-after metadata for retryable errors |
| `docs/compliance-report.md` | Modify | Refresh the live gap list after implementation |
| `test/engine/conditions.test.ts` | Modify | Cover unqualified context lookups and reserved-root behavior |
| `test/interviewer/interviewer.test.ts` | Modify | Cover `CONFIRMATION` semantics across interviewer implementations |
| `test/agent-loop/session.test.ts` | Modify | Cover lifetime turn counting across follow-ups |
| `test/agent-loop/context-window.test.ts` | Modify | Cover recoverable `ContextLengthError` behavior |
| `test/agent-loop/events.test.ts` | Modify | Cover full tool output in completion events |
| `test/llm/retry.test.ts` | Modify | Cover pre-output retries and generic retry-after support |
| `test/llm/adapters/anthropic.test.ts` | Modify | Cover `ContentFilterError` classification |

---

## Definition of Done

- [ ] Gaps `A1`, `A2`, `A3`, `A5`, `C1`, `C5`, `C6`, `L1`, `L2`, and `L6` are either implemented or explicitly removed from the report as stale findings after code verification
- [ ] `condition="foo=true"` and `condition="foo.bar=true"` resolve against context keys without requiring the `context.` prefix
- [ ] Per-node `status.json` files contain the spec-shaped outcome fields for at least `tool`, `codergen`, `wait.human`, and `exit` nodes
- [ ] `codergen` no longer overwrites the engine's canonical `status.json` with a conflicting shape
- [ ] `CONFIRMATION` prompts behave distinctly from generic multiple-choice prompts in auto-approve, console, and queue-backed flows
- [ ] `max_turns` is enforced across `submit()` plus all `followUp()` calls for a single session lifetime
- [ ] `agent_tool_call_completed` always includes `full_content` for both normal tool calls and subagent tool completions
- [ ] `ContextLengthError` emits warning events and leaves the session recoverable instead of closing it
- [ ] `StreamError` retries only when no content has been emitted yet
- [ ] Anthropic safety/content blocks surface as `ContentFilterError`
- [ ] Retryable provider errors can carry `retry_after_ms` through the base error contract
- [ ] `npm run build` passes with zero TypeScript errors
- [ ] `npm test` passes with zero failures

---

## Risks

- **Report drift wastes time.** Some gaps in `docs/compliance-report.md` may already be partially fixed. Mitigation: start with an audit and treat report correction as real sprint work, not cleanup.
- **Canonicalizing `status.json` may break existing assumptions.** Some code or tests may implicitly rely on the current simplified shapes. Mitigation: make the new artifact an additive superset and keep handler-specific metadata in separate files.
- **Lifetime turn limits will change session behavior.** Existing callers may implicitly rely on per-input resets. Mitigation: choose one explicit terminal policy for limit exhaustion and codify it in tests before touching follow-up flows.
- **Full tool output on events can increase memory pressure.** Mitigation: define `full_content` as the full post-tool-execution content seen by the session after tool-level truncation, not unbounded raw process output.
- **Anthropic content-filter detection can over-match on generic 400s.** Mitigation: prefer structured provider signals and narrowly scoped message patterns, backed by explicit adapter tests.

---

## Dependencies

- No new external packages are required.
- The sprint depends on the current green baseline staying green at the start: `npm run build` and `npm test`.
- The pinned spec snapshot already exists; this sprint does not require new upstream prompt research because `C2`, `C3`, and `C7` are explicitly deferred.
- Deterministic adapter fixtures are required for Anthropic content-filter and retry-after coverage. Add those fixtures before changing classification logic.
