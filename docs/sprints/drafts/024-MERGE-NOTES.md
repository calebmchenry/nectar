# Sprint 024 Merge Notes

**Merged from:** NEXT-CLAUDE-DRAFT.md, NEXT-CODEX-DRAFT.md, NEXT-GEMINI-DRAFT.md
**Critiques considered:** None available this round

---

## Scope Decision

The final sprint adopts the **Claude draft's scope and structure** as the backbone — test fixes + GAP-3 + GAP-6 + GAP-8 + GAP-4 — while incorporating the Codex draft's emphasis on production resilience (attachment-aware failure reporting, honest degradation) and the Gemini draft's LLM hardening focus. The attachment/multimodal work from Codex was deferred as it requires a dedicated sprint.

**Included:** 3 test failures (Phase 0), GAP-3 (error taxonomy), GAP-6 (reasoning lifecycle), GAP-8 (structured timeouts), GAP-4 (named retry presets)

**Deferred to a future sprint:**
- GAP-1 (AUDIO/DOCUMENT content types) — Codex draft's centerpiece. Deferred because multimodal attachment support is a significant body of work (capability matrix, attachment planning, analysis document metadata, Hive surfacing) that deserves focused attention rather than being crammed alongside 4 other gaps.
- GAP-2 (Gemini extended tools) — from Gemini draft. Optional per spec, and adding new agent tools is orthogonal to LLM client hardening.
- GAP-7 (incremental JSON parsing) — from Gemini draft. UX optimization for streamObject(), not blocking any pipeline execution.

---

## What Was Taken from Each Draft

### From NEXT-CLAUDE-DRAFT.md (Claude)
- **Overall sprint structure and phasing.** The Phase 0 → Phase 1 → ... progression with a green-test gate before feature work. This "fix first, build second" principle was the strongest organizational idea across all three drafts.
- **Test failure root cause analysis.** Detailed diagnosis of all 3 failures (gardens-draft assertion mismatch, hive-run-flow timing, pipeline-events missing event) with specific fix strategies. Neither other draft addressed test failures.
- **GAP-4 retry preset design.** The `RetryPreset` interface, 5 named presets with exact numeric values, resolution order (node → graph → default), and the `max_retries` override rule. This was the most complete and implementable retry design.
- **GAP-6 reasoning lifecycle design.** `thinking_start`/`thinking_end` naming convention, per-adapter mapping strategy (Anthropic direct map, Gemini state synthesis, OpenAI conditional).
- **GAP-3 error taxonomy.** `QuotaExceededError` and `StreamError` class design with retryability flags and adapter detection rules.
- **GAP-8 TimeoutConfig design.** The `connect_ms`/`request_ms`/`stream_read_ms` interface and backward-compatible `number | TimeoutConfig` union.
- **Cut line strategy.** Cut GAP-4 first, then GAP-8 — keeping error taxonomy and reasoning lifecycle as load-bearing. Modified slightly from Claude's original (which cut GAP-8 first, then GAP-3).
- **Zero new dependencies.** All three drafts agreed; Claude stated it most explicitly.

### From NEXT-CODEX-DRAFT.md (Codex)
- **StreamError phase classification.** The Codex draft's `phase: 'transport' | 'sse_parse' | 'idle_timeout'` field on StreamError was adopted — it provides actionable diagnostic information that a bare error message doesn't. The Claude draft had `partial_content` but no phase.
- **Timeout helper as a dedicated module.** The Codex draft proposed `src/llm/timeouts.ts` as a centralized timeout helper. Adopted because timeout composition is complex enough to warrant isolation rather than being spread across adapter files.
- **First-party consumer timeout defaults.** Specific defaults for `GardenDraftService` and `SwarmAnalysisService` — the Codex draft's emphasis on bounded latency for interactive vs. batch use cases informed these values.
- **Production resilience framing.** The Codex draft's principle that "silent degradation is worse than explicit limitation" influenced the error taxonomy design — particularly the emphasis on honest failure reporting over silent retry exhaustion.
- **Attachment planning model (deferred).** While the full attachment/multimodal work was deferred, the `AttachmentPlan` concept (included/skipped/warnings per provider) and `failure_code` in analysis documents are noted for the future multimodal sprint.

### From NEXT-GEMINI-DRAFT.md (Gemini)
- **Reasoning state tracking approach.** The Gemini draft's description of maintaining an `is_reasoning` state variable for synthesizing lifecycle boundaries informed the Gemini adapter implementation approach (track state, emit start on first thinking delta, emit end on transition).
- **Timeout separation principle.** The Gemini draft articulated the core insight clearly: "A slow model inference doesn't trigger a global timeout" — separate connect, request, and stream-read timeouts prevent zombie connections while accommodating long reasoning. This principle shaped the TimeoutConfig design.
- **Error recoverability emphasis.** "Billing vs. Throttling Differentiation" as a named use case — the Gemini draft's framing of QuotaExceededError as preventing wasted retry budget was adopted directly.

---

## What Was Rejected and Why

### From NEXT-CLAUDE-DRAFT.md
- **GAP-8 TimeoutConfig with `total_ms` and `per_step_ms` at the LLM layer.** The Claude draft included `total_ms` and `per_step_ms` in `TimeoutConfig`. These are operation-level concerns, not LLM-call-level concerns. The final sprint keeps `TimeoutConfig` focused on the three adapter-relevant dimensions (connect, request, stream-read). Total/per-step budgets are enforced by the retry middleware, not the timeout interface.

### From NEXT-CODEX-DRAFT.md
- **GAP-1 (AUDIO/DOCUMENT content types) as the sprint centerpiece.** The Codex draft made attachment-native swarm analysis the primary goal. This is valuable work, but it requires a capability matrix, per-provider attachment planning, analysis document metadata extensions, and Hive UI changes — too much surface area to combine with 4 other compliance gaps. Deferred to a dedicated multimodal sprint.
- **`timeout_ms` deprecation.** The Codex draft proposed keeping `timeout_ms` as a "deprecated alias for one sprint." The final sprint does not deprecate — `timeout` as `number | TimeoutConfig` is the public API, and bare numbers continue to work indefinitely. No migration pressure.
- **GAP-4 (retry presets) exclusion.** The Codex draft deferred retry presets. The final sprint includes them because they're the last engine-level attractor-spec gap and the implementation (a lookup table + parse/validate additions) is small relative to the other gaps.

### From NEXT-GEMINI-DRAFT.md
- **GAP-7 (incremental JSON parsing).** The Gemini draft included a custom `IncrementalJSONParser` for `streamObject()`. This is complex (balancing brackets, closing strings, handling cut-off points), has risk of subtle bugs, and is a UX optimization rather than a correctness requirement. Deferred.
- **GAP-2 (Gemini extended tools).** `list_dir` and `read_many_files` are new agent-loop tools, not LLM client features. Adding them in a sprint focused on LLM hardening creates unnecessary blast radius. Deferred.
- **`REASONING_START`/`REASONING_END` naming.** The Gemini draft used SCREAMING_CASE event names. The final sprint uses `thinking_start`/`thinking_end` (lowercase, consistent with existing `thinking_delta` naming convention).
- **No test failure acknowledgment.** The Gemini draft did not address the 3 failing tests from Sprint 022/023. The final sprint requires fixing them as Phase 0.

---

## Key Design Decisions

1. **Phase 0 green-test gate is non-negotiable.** Adopted from the Claude draft. The Codex and Gemini drafts did not address the test failures at all.

2. **Error taxonomy before timeouts.** GAP-3 is Phase 1, GAP-8 is Phase 3. Error types need to exist before timeout helpers can raise `StreamError` with proper classification.

3. **StreamError carries both `partial_content` (Claude) and `phase` (Codex).** These are complementary — `partial_content` tells you what was received, `phase` tells you where it broke.

4. **TimeoutConfig is adapter-focused, not operation-focused.** Three fields: `connect_ms`, `request_ms`, `stream_read_ms`. Total/per-step budget enforcement stays in retry middleware.

5. **Retry presets included despite Codex deferral.** The implementation is small (data table + parse/validate), it closes the last engine-level spec gap, and the Claude draft's design is complete and implementable.

6. **Cut line: GAP-4 first, then GAP-8.** If the sprint compresses, retry presets go first (nice-to-have engine feature), then timeouts (valuable but existing `timeout_ms` works). Error taxonomy and reasoning lifecycle are the load-bearing deliverables that change correctness, not just convenience.
