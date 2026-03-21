# Sprint 034 Draft Critique — Codex Review

**Reviewed drafts:** NEXT-CLAUDE-DRAFT.md, NEXT-GEMINI-DRAFT.md
**Reviewer perspective:** NEXT-CODEX-DRAFT.md (workspace config + run-state truth)
**Date:** 2026-03-21
**Current test state:** 3 failures (http-server, gardens-draft, pipeline-events). fan-in-llm is passing.

---

## NEXT-CLAUDE-DRAFT.md — "Compliance Zero"

### Strengths

1. **Precise diagnosis of remaining test failures.** Each of the (now 3) failing tests has a concrete root-cause hypothesis with file references. This is the right level of specificity for a sprint that claims "no more root-cause discovery."
2. **Well-calibrated effort estimates by category.** The 4-tier gap classification (trivial/small/medium/largest) with per-tier time estimates gives an honest picture of the work. The 12–16 hour total is plausible.
3. **Drop line is explicit and correctly ordered.** Phase 5 (C12 + C3) and Phase 4 (adapter lifecycle) are the right things to cut first. The hard gate (green suite) and trivial type additions are the right things to keep.
4. **Phase gating is correct.** The "Phase 2 does not begin until `npm test` is green" rule prevents the classic trap of mixing gap closure with active test debugging.
5. **Risk table is thorough and actionable.** Each risk has a concrete mitigation, not just "we'll deal with it." The `PROVIDER_EVENT` noise risk and the parameter-rename backward-compat risks are particularly well-anticipated.
6. **Definition of Done is item-by-item.** Every gap ID maps to a verifiable checkbox. This is the right granularity for a compliance sprint.

### Weaknesses

1. **Stale failure count.** The draft claims 4 failing tests, but the suite currently shows 3. `fan-in-llm` is passing. Starting a sprint with an inaccurate baseline erodes trust in the diagnosis. The sprint should verify the current state before committing to fix lists.
2. **No workspace config or determinism story.** The draft treats compliance gaps as the only blocker, but the `gardens-draft` failure is entangled with ambient provider selection. Closing the gap mechanically (emit `draft_complete`) without addressing *why* the streaming path hangs (no configured provider, no simulation fallback) risks a fragile fix that breaks in CI or on a clean checkout.
3. **C12 (system prompt parity) is underspecified.** "Keep prompts under 4KB" and "focus on behavioral instructions" are good constraints, but there's no acceptance criterion for *which* behavioral instructions must be present. Without a checklist, this becomes a subjective judgment call that's hard to verify in the Definition of Done.
4. **No Hive or CLI consumer impact analysis for type additions.** Adding `tool_call_id`, `text`, `PROVIDER_EVENT`, etc. to interfaces is straightforward, but the draft doesn't trace which consumers (Hive SSE renderer, CLI pipeline renderer, draft panel) need updating to handle the new fields. If consumers silently ignore them, the additions are dead code that passes compliance but provides no value.
5. **A2 (ContextLock) as a NoOp is acknowledged but not defended against the Gemini draft's position.** The Gemini draft wants a real `ReadWriteLock` with `async-mutex`. The Claude draft dismisses this as "JS single-threaded." Both positions have merit, but the sprint should pick one and justify it against the spec's actual wording rather than leaving it as a philosophical disagreement.
6. **No test-count regression gate.** The DoD says "no existing tests regressed" but doesn't assert a minimum test count or require that test coverage doesn't decrease. Deleting a flaky test would satisfy the DoD.

### Gaps in Risk Analysis

- **No risk entry for "compliance gaps are misidentified."** The gap list comes from a point-in-time compliance report. If any gap was already closed (or a new gap was missed), the sprint wastes time or ships incomplete. The mitigation is Phase 6's re-audit, but it should be called out as a risk.
- **No risk entry for "new test failures introduced by type additions."** Adding fields to `Message`, `ToolCallData`, `Usage`, etc. could break existing test assertions that snapshot or structurally compare these objects. This is medium-likelihood and should be in the table.

### Missing Edge Cases

- `Message.text` concatenation: What happens when content parts include non-text types (tool calls, images)? The draft says "concatenates all text-type content parts" but doesn't specify separator or ordering.
- `PROVIDER_EVENT`: What's the payload shape? If consumers need to handle it, the event type needs a defined structure, not just "emit it."
- `supports_tool_choice` for OpenAI-Compatible: The draft says "supports auto/none" but OpenAI-Compatible is a catch-all for many providers with wildly different capabilities. This should be configurable, not hardcoded.

### Definition of Done Completeness

Strong. Every gap has a checkbox. Two additions needed:
- A checkbox asserting the current test count is ≥ the pre-sprint count.
- A checkbox for the compliance re-audit in Phase 6 (currently described in tasks but not in the DoD checklist).

---

## NEXT-GEMINI-DRAFT.md — "Spec Compliance & Gap Closure"

### Strengths

1. **Concise scope.** The draft is focused and doesn't try to do too much beyond the 22 gaps. The three-phase structure (Attractor, Coding Agent, Unified LLM) maps cleanly to the spec documents.
2. **Use cases are consumer-oriented.** "A downstream system monitoring the SSE event stream successfully parses `PascalCase`" is a good testable scenario.
3. **Acknowledges the event-renaming blast radius.** The Architecture section correctly flags that PascalCase renaming requires updating emitters *and* consumers (CLI, SSE routes). This is the highest-risk item in any compliance sprint and deserves the attention.

### Weaknesses

1. **No test fix phase at all.** The draft ignores the 3 currently-failing tests entirely. A compliance sprint that ships with a red suite doesn't meet INTENT.md §5.1 regardless of how many gaps it closes. This is a critical omission.
2. **Event renaming (A4) is treated as a destructive rename, not an alias.** The Claude draft correctly proposes adding PascalCase *aliases* alongside existing snake_case names. The Gemini draft says "Rename events to PascalCase" and "Update all emitters and listeners." This is a breaking change that will cascade through every test, every SSE consumer, and the Hive. The spec says PascalCase should be *available*, not that snake_case must be removed.
3. **Real ReadWriteLock is over-engineering.** The draft proposes a true `ReadWriteLock` with `async-mutex` or a custom Promise-queue implementation, including deadlock timeouts. In a single-threaded Node.js runtime with context clones for parallel branches, this adds complexity with no safety benefit. The spec requires the *interface* to exist; a no-op implementation is the correct choice for the current runtime model.
4. **Tool parameter changes are breaking renames, not aliases.** "Rename `path` to `file_path`" and "Rename `include` to `glob_filter`" will break any existing LLM transcript or saved tool call that uses the old names. The Claude draft correctly proposes accepting both names. The Gemini draft treats this as a simple rename.
5. **No drop line.** If the sprint runs long, there's no guidance on what to cut. All 22 gaps are treated as equally important.
6. **Effort allocation is unbalanced.** Phase 2 (Coding Agent) is 40% and Phase 3 (Unified LLM) is 40%, but Phase 3 includes 12 distinct items (U1–U12) ranging from trivial field additions to non-trivial lifecycle methods. No sub-prioritization within phases.
7. **No file-level task breakdown.** Tasks are listed as bullet points but without the file-level specificity of the Claude draft. "Add `close()` and `initialize()` methods to the `ProviderAdapter` interface and implement stubs/cleanup logic in the adapters" spans 5 files and multiple test files — that's a task group, not a task.
8. **Dependencies section suggests adding `async-mutex`.** Introducing a new runtime dependency for a no-op-equivalent feature is unnecessary risk.

### Gaps in Risk Analysis

- **Only 3 risks listed.** For a sprint touching events, locking, tool schemas, type interfaces, model catalogs, and 4 adapters, this is too few. Missing risks include:
  - Model catalog entries being wrong or outdated (acknowledged by Claude draft).
  - `PROVIDER_EVENT` and `text_id` additions causing consumer confusion.
  - System prompt expansion (C12) changing LLM behavior.
  - Sprint scope overrun (22 gaps with no drop line).
- **"Tool parameter renaming breaks existing LLM agent prompts" is rated Low impact.** This is wrong. If an agent's tool-call cache or transcript replay uses `path` and the tool now requires `file_path`, the call fails. Impact should be Medium. And the mitigation ("self-correct on the next turn") assumes a retry loop that may not exist in all execution contexts.
- **No risk for test suite breakage from event renames.** The draft proposes renaming all events from snake_case to PascalCase, which will break every test that asserts on event names. This is High likelihood, Medium impact, and completely unaddressed.

### Missing Edge Cases

- What happens to in-flight SSE connections when events are renamed? Do existing Hive sessions need to reconnect?
- Context `ReadWriteLock`: What's the timeout value? What happens on timeout — throw, return stale data, or deadlock?
- `web_search` and `web_fetch`: What happens when invoked with no configured backend? The draft says they're "optional" but doesn't specify the failure mode.

### Definition of Done Completeness

Weak. Several issues:
- "All 22 gaps listed in the 2026-03-21 Compliance Report are implemented and verified" is a single checkbox for 22 items. The Claude draft breaks this into per-gap checkboxes, which is far more useful for tracking progress.
- "Parallel nodes mutating context correctly lock and release using the new Context ReadWriteLock" requires a real lock, but the spec can be satisfied with a no-op. This DoD item encodes the implementation choice rather than the requirement.
- No checkbox for `npm run build` passing (only `vitest` is mentioned).
- No checkbox for "no test regressions" or minimum test count.
- No mention of the 3 currently-failing tests — they'd still be failing after this sprint.

---

## Recommendations for the Final Merged Sprint

### 1. Fix the 3 failing tests first — non-negotiable gate

Both the Claude and Codex drafts agree: the suite must be green before compliance work begins. The Gemini draft's omission of test fixes is its biggest flaw. Phase 1 should fix http-server (`current_node` undefined), gardens-draft (streaming path stall), and pipeline-events (`pipeline_failed` not emitted). fan-in-llm is already passing and should be removed from the fix list.

### 2. Use aliases, not renames, for A4 and C9/C10/C11

The Claude draft is correct: add PascalCase event aliases alongside snake_case originals, and accept both old and new tool parameter names. The Gemini draft's destructive rename approach creates unnecessary breakage across the entire codebase and test suite.

### 3. Use NoOpContextLock for A2

The Codex and Claude drafts agree: a no-op implementation satisfies the spec for single-threaded JS with context clones. Adding `async-mutex` or a real ReadWriteLock is over-engineering. The interface should exist for future use; the implementation should be trivial.

### 4. Include a drop line

Adopt the Claude draft's drop-line ordering. If scope must be cut:
- **Keep:** Green suite, trivial type additions (Phase 2), tool param aliases (Phase 3)
- **Defer first:** C12 system prompt parity, C3 web tools
- **Defer second:** Adapter lifecycle (U1/U2), catalog refresh (U3), per-call config (U11/U12)

### 5. Incorporate workspace config for the draft fix

The Codex draft's insight is correct: the `gardens-draft` test failure is entangled with ambient provider selection. The fix should establish a deterministic default (simulation) so the test passes on a clean checkout without API keys. This doesn't require the full workspace config system from the Codex draft, but the draft service should have an explicit default rather than probing for whatever provider is available.

### 6. Scope the sprint to ~15 gaps, not 22

The Claude draft's own risk table acknowledges "sprint scope is too large." A realistic sprint should fix the 3 tests, close the 12 trivial gaps (Category A), close the 6 small gaps (Category B), and defer the medium/large gaps (C12, U1/U2/U3, web tools) unless time permits. That's 18 items plus 3 test fixes — still ambitious but achievable.

### 7. Per-gap DoD checkboxes

Adopt the Claude draft's approach: one checkbox per gap ID. The Gemini draft's single "all 22 gaps" checkbox provides no progress visibility.

### 8. Verify the gap list before starting

Both drafts assume the compliance report is accurate. Add a Phase 0 or pre-sprint task: re-run the compliance audit against the current codebase and confirm which gaps are actually open. The fan-in-llm test was listed as failing but is now passing — the gap list may have similar staleness.

### 9. Add consumer tracing for type additions

The Claude draft lists many new fields (tool_call_id, text, PROVIDER_EVENT, text_id, etc.) but neither draft traces which consumers actually use them. For each addition, the sprint should note whether it's consumed anywhere or is purely interface-shape compliance. Dead-code compliance is lower priority than consumed compliance.

### 10. Validate C12 with a concrete checklist

If C12 (system prompt parity) stays in scope, define exactly which behavioral instructions must be present per provider profile. "Key behavioral instructions" is too vague. List 3–5 specific rules per profile that can be asserted in tests.
