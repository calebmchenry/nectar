# Sprint 028 Merge Notes

## Source Drafts

- **NEXT-CLAUDE-DRAFT.md** — "Unified LLM Response Contract & Green Suite"
- **NEXT-CODEX-DRAFT.md** — "High-Level LLM Contract and Execution Environment Completion"
- **NEXT-GEMINI-DRAFT.md** — "Spec Compliance Finalization"

No critique files were present for this round.

## What Was Taken and Why

### From Claude

- **Phase 1 (Green Suite) as a hard gate.** Claude was the only draft to include fixing the remaining test failures as an explicit prerequisite phase with a "no timeout increases" anti-pattern rule. This is critical — CI must be trustworthy before adding more contract surface area. Adopted wholesale including the root-cause decomposition (SSE lifecycle, assertion mismatches, cancel flow).

- **Detailed LLM gap-by-gap phasing.** Claude's phase breakdown (Response Contract → Generate Enhancements → Streaming → Tool Contract → Error Classes) was the most granular and had the clearest dependency ordering. The final sprint follows this structure closely, though Phases 3 and 5 were reorganized to group tool contract work with generate enhancements (since active/passive tools are integral to the generate() tool loop).

- **Cut line ordering.** Claude's cut line — never cut green suite/response contract/generate, cut tool contract first, then streaming, then jitter — was the most practical prioritization. Adopted with the addition of ExecutionEnvironment as the first-to-cut phase (per its lower urgency).

- **Files summary table.** Claude had the most complete file listing with action and purpose columns. Used as the base and extended with Codex's execution environment files.

- **Risks table.** Claude's risk analysis was the most thorough (7 risks vs 2 for Gemini). Merged with Codex's additional risks around streaming deadlocks and env allowlist secrets.

### From Codex

- **ExecutionEnvironment inclusion.** This was Codex's distinguishing contribution. Claude explicitly deferred gaps 2–9 (ExecutionEnvironment interface) to a future sprint; Gemini included them but with less detail. Codex made the strongest argument: these two layers (LLM contract + agent loop environment) are tightly coupled, this is meant to be "the last large contract sprint," and deferring environment work means yet another architecture sprint. Adopted as Phase 5 with the understanding it's first on the cut line.

- **Architectural guidance on low-level vs high-level split.** Codex's "central opinion" — don't blur the adapter layer and the orchestration layer — was the clearest articulation of a principle all three drafts implicitly agreed on. Adopted verbatim as an architecture section. The data flow diagram showing `ProviderAdapter → UnifiedClient → normalizer → module-level generate()/stream()` was also taken from Codex.

- **Knowledge cutoff as catalog data.** Codex explicitly called out that knowledge cutoff should come from `ModelInfo` metadata, not string glue, and should render `unknown` when absent. This was more principled than Claude's omission and Gemini's brief mention. Adopted as a specific task in Phase 5.

- **Tool execution concurrency.** Codex specified that multiple active tool calls in one step should execute concurrently with preserved ordering. Neither Claude nor Gemini addressed this. Added to Phase 3 tasks and Definition of Done.

- **Error resilience in tool loops.** Codex specified that unknown-tool and invalid-arguments failures should be returned to the model as tool results rather than throwing fatal errors. This is better UX and more spec-aligned. Adopted in Phase 3.

- **Idempotent lifecycle.** Codex's requirement that `initialize()`/`cleanup()` be idempotent and `finally`-safe was a good operational detail. Adopted in Phase 5.

- **Stream accumulator equivalence invariant.** Codex required that `StreamAccumulator`'s final response be equivalent to the last-step non-streaming response. This is an important correctness property. Added to Phase 4 tasks.

### From Gemini

- **Broad scope validation.** Gemini's attempt to close all 26 gaps in one sprint validated that the scope is achievable. While Gemini's implementation detail was thinner than the other two, it confirmed the gap groupings are correct and the work decomposes cleanly into engine/agent-loop/LLM clusters.

- **Phase ordering of engine + agent loop context first.** Gemini placed engine retry and agent loop context gaps (1–4, 10) in Phase 1, before the LLM work. While the final sprint puts green suite first (from Claude) and engine jitter last (trivial), Gemini's instinct to include these "small but correct" fixes was right. The jitter fix (gap 10) is included.

- **Use case: timeout detection.** Gemini's use case around `timed_out` and `duration_ms` for distinguishing crashes from hangs was concise and valuable. Adopted as use case 12.

- **Environment variable allowlist specifics.** Gemini listed `GOPATH`, `CARGO_HOME`, `NVM_DIR`, `RUSTUP_HOME`, `GOROOT`. Codex had a similar but broader list. The final sprint uses Codex's expanded list (`VOLTA_HOME`, `PYENV_ROOT`, `VIRTUAL_ENV`, `PNPM_HOME`, `ASDF_DIR` in addition to Gemini's entries).

## What Was Not Taken and Why

- **Gap 1 (retry preset exact parameter values)** — Gemini included this; Claude and Codex both deferred. Needs a spec document comparison exercise that's orthogonal to the contract work. Deferred.

- **Gemini's minimal risk analysis** — Only 2 risks identified (streaming loop complexity, OS version consistency). The merged sprint uses Claude and Codex's more thorough risk tables.

- **Codex's `src/llm/response.ts` and `src/llm/tool-loop.ts` as new files** — Codex proposed factoring response normalization and the tool loop into dedicated modules. While architecturally clean, the final sprint follows Claude's approach of keeping these in `types.ts` and `client.ts` to minimize file count. If the implementation gets unwieldy, factoring out is a good follow-up.

- **Codex's `src/llm/stream-result.ts` as a separate file** — Same rationale. The StreamResult class can live in `types.ts` or alongside the accumulator.

- **Codex's legacy `opts.tools: Map<string, handler>` compatibility adapter** — Codex called for wrapping legacy map entries into active tools. The final sprint doesn't address this explicitly — if the legacy path exists, it should be migrated as encountered, not through a compatibility shim.

- **Gemini's "all 26 gaps" framing** — The title "Spec Compliance Finalization" implies 100% closure. The final sprint closes 24 of 26 gaps (deferring gap 1), which is more honest. The title reflects actual scope.

## Sprint Number

Sprint 028, determined from `docs/sprints/ledger.tsv` where the last entry is Sprint 027.
