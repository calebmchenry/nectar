# Sprint 031 Merge Notes

## Structural Foundation: Claude Draft

The Claude draft was used as the structural foundation for Sprint 031. It was the most complete draft across every dimension: gap enumeration, file mapping, task decomposition, Definition of Done coverage (20/20 gaps vs Gemini's 7/20), and risk analysis. Both critiques (Gemini and Codex) independently recommended this.

## What Was Taken From Each Draft

### From Claude Draft (NEXT-CLAUDE-DRAFT.md)
- **SSE-first phasing.** Phase 1 addresses the 6 failing tests before any compliance work begins. This was the Claude draft's most important structural insight: you cannot validate compliance on a red suite. Adopted verbatim by both critiques.
- **Gap-to-file mapping table.** The detailed breakdown of all 15 gaps to specific files and interfaces was carried over directly.
- **Use cases.** "CI is green on a clean checkout" and "SSE streams close deterministically" are concrete, verifiable acceptance criteria. Preferred over Gemini's developer-centric framing.
- **Effort allocation** (phase percentages) and dependency ordering.
- **Risk table structure** with specific mitigations (e.g., `process.nextTick()` for SSE close timing, grep-and-replace for ModelInfo).
- **Complete Definition of Done** covering all 15 gaps plus SSE fixes.

### From Codex Draft (NEXT-CODEX-DRAFT.md)
- **Canonical answer normalization strategy.** The Codex draft's framing — "selected_label remains an input compatibility path, not the authoritative stored shape" — is architecturally superior to Claude's simpler "enrich alongside." Adopted for Gap 1.
- **Shared search helper extraction.** Codex proposed creating `src/agent-loop/search.ts` reused by both `LocalExecutionEnvironment` and the glob/grep tools. This avoids two drifting implementations. Claude's draft simply delegated to `fast-glob`/`execa` without sharing.
- **`AgentSession` as sole lifecycle emitter.** Codex correctly identified that `CodergenHandler` should bridge the real session event, not synthesize its own. Added explicit "remove synthetic emission" task and "exact-once assertion" to the final sprint.
- **One-sprint compatibility aliases for ModelInfo.** Codex recommended keeping nested `capabilities`/`cost` as derived aliases rather than a flag-day rename. Safer than Claude's single-commit approach. Adopted as a two-commit strategy per Codex critique's recommendation.
- **`max_tool_rounds` deprecation bridge.** Codex specified that the request field wins when both are set, and the options alias remains for one sprint. Clearer than Claude's open question.
- **Cocoon `logs` as run-relative paths.** Codex specified portability — not absolute machine-specific paths. Added to the final sprint.
- **`stream_end` error-state handling.** Codex proposed emitting `error` event instead of malformed `stream_end` on premature termination. Adopted.
- **5 commits in git snapshot (not 10).** Codex proposed 5. Adopted as a safer default to avoid context bloat.

### From Gemini Draft (NEXT-GEMINI-DRAFT.md)
- **Shell injection risk for glob/grep.** Gemini's risk table flagged this — neither Claude nor Codex mentioned it. Added to the merged risk table with mitigation (safe API wrappers, no raw shell patterns).
- **Context window budget (32KB) for auto-discovered instructions.** Gemini referenced the spec's 32KB budget. Added as a constraint on Gap 8.
- **`stream_end` behavior on premature termination.** Gemini raised the question of what happens when a stream ends due to error. Combined with Codex's resolution (emit `error` event instead).

### From Gemini Critique (NEXT-GEMINI-CRITIQUE.md)
- **SSE-first is mandatory.** Gemini's critique strongly endorsed Claude's Phase 1 approach and flagged the Codex draft's blind spot on failing tests.
- **Edge cases added to final sprint:** `Message.name` sanitization for provider regex constraints, graceful handling of empty git repos (0 commits), git commit message truncation, `max_tool_rounds` fallback prioritization.

### From Codex Critique (NEXT-CODEX-CRITIQUE.md)
- **Phase 1 split into 1a/1b.** The Codex critique correctly identified that Phase 1 bundled three separate bugs (SSE lifecycle, `run_error` emission, `current_node` endpoint). Splitting prevents the SSE fix from being blocked by unrelated issues.
- **`run_error` is a separate root cause.** The Claude draft's "single root cause" framing was slightly misleading. The Codex critique caught this and it's now explicitly noted.
- **Checkpoint deserialization handling.** Neither draft addressed what happens when `resume` loads an old checkpoint without `logs`. Added: default to `[]`.
- **Event-sequence integration test.** From Claude's risk mitigation section, promoted to a Phase 5 verification task.
- **SSE test isolation.** Port conflicts between parallel test runs flagged as a risk. Added with mitigation (ephemeral ports, proper cleanup).
- **Two-commit approach for ModelInfo.** Add aliases first, then migrate callers and remove old shape. Safer than a single mass rename.

## What Was Not Taken (and Why)

- **Gemini's sprint number "002."** Out of sequence. Ledger goes to 030; this is 031.
- **Gemini's 3-phase structure.** Too coarse. Claude's 4-phase + verification structure maps better to the actual work clusters.
- **Claude's 10 commits in git snapshot.** Reduced to 5 per Codex draft. 10 risks context bloat with large commit messages.
- **Claude's single-commit ModelInfo rename.** Replaced with two-commit approach per Codex critique. Safer rollback path.
- **Codex's extensive HTTP/server boundary changes for human gates.** The Codex draft proposed updating `question-store.ts`, `http-interviewer.ts`, `run-manager.ts`, and multiple server routes for the Answer model. This is out of scope — the compliance gaps are about the interviewer types and implementations, not the HTTP API surface. Server-side changes can follow in a later sprint if needed.
- **Codex's `openai-compatible.ts` adapter changes.** Not listed in the 15 compliance gaps. Unnecessary scope expansion.
- **Codex's Phase 5 "model catalog alignment" as a separate phase.** Gap 15 fits naturally in Phase 4 with the other LLM gaps. No need for a dedicated phase.
