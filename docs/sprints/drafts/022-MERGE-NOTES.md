# Sprint 022 Merge Notes

## Drafts Considered

- **NEXT-CLAUDE-DRAFT.md** — GAP-2 (error subtypes) + GAP-3 (OpenAI-compatible adapter) + GAP-5 (custom transforms)
- **NEXT-CODEX-DRAFT.md** — GAP-5 (custom transforms) + GAP-6 (sub-pipeline composition)
- **NEXT-GEMINI-DRAFT.md** — GAP-3 (OpenAI-compatible adapter) + GAP-5 (custom transforms) + GAP-6 (sub-pipeline composition)

No critique files were submitted for this round.

## Gap Selection

**Included: GAP-5, GAP-6, GAP-3.** All three drafts agreed on GAP-5. Two of three included GAP-6 (Codex, Gemini) and two of three included GAP-3 (Claude, Gemini). The final sprint includes all three because:

- GAP-5 and GAP-6 are coupled — Codex made the strongest argument that a transform API without a real first-party transform (composition) is "architecture theater." The sprint proves the API immediately.
- GAP-3 is independent of the transform/composition work and can be developed in parallel. It's the highest-impact LLM gap by user reach.

**Deferred: GAP-2 (error subtypes).** Only Claude included it. It's mechanical, low-risk, and doesn't block user workflows. It can be a quick Phase 1 in a future sprint or standalone PR.

## What Was Taken from Each Draft

### From Codex (primary source for transforms + composition)

- **Instance-scoped `PipelinePreparer` over global registry.** Codex's strongest architectural insight. Claude proposed a `static` `TransformRegistry` (process-global); Codex argued this doesn't work for tests, embedders, or multi-workspace servers. The final sprint uses Codex's instance-scoped design.
- **`compose.dotfile` attribute convention.** Codex proposed `"compose.dotfile"` on placeholder nodes; Gemini proposed `type="subpipeline" src="..."`. Codex's approach is more natural in DOT (custom attributes vs. overloading `type`) and includes `"compose.prefix"` for namespace control.
- **Prepared DOT serialization and hashing.** Entirely from Codex. Neither Claude nor Gemini addressed resume safety for composed graphs. This is critical — without it, any child file edit would silently corrupt resume integrity.
- **`PreparedGardenResult` contract.** The structured return type with `graph`, `diagnostics`, `prepared_dot`, `graph_hash`, and `source_files` is from Codex.
- **Child graph boundary rules.** Codex's explicit safe-subset materialization and rejection of ambiguous graph-global controls. This avoids inventing merge semantics under time pressure.
- **Provenance metadata on imported nodes.** Only Codex addressed how validation errors should point at child files, not the parent placeholder.
- **`source-manifest.json` persistence.** Codex's idea for debugging and auditing which source files contributed to a run.
- **Phase structure for transforms + composition.** Phases 1–3 follow Codex's sequencing.
- **Design principles section.** Taken nearly verbatim — these are crisp and correct.
- **Async preparation pipeline.** Codex argued `transformAndValidate()` must become async because child file loading is inherently async. Correct.
- **Module layout for transforms/.** The `src/transforms/` directory structure with separate files for types, registry, built-in transforms, and compose-imports is from Codex.

### From Claude (primary source for adapter)

- **Full adapter architecture.** Claude's adapter section was by far the most detailed: request/response translation, streaming format, tool calling conventions, structured output with fallback, error mapping, provider options passthrough. This became Phase 4 nearly wholesale.
- **Separate adapter, not a mode flag.** Claude explicitly argued against branching inside the existing OpenAI adapter. This is the right call — the Responses API and Chat Completions API have fundamentally different shapes.
- **Environment variable convention.** `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL` from Claude.
- **Mock Chat Completions test server.** Claude's `test/helpers/mock-chat-completions.ts` approach with configurable responses and automatic port allocation.
- **Model catalog entries.** Claude's idea to add well-known provider entries (Ollama, Together, Groq) with capability flags, though this is marked as cuttable if time compresses.
- **Use cases 6–8.** The Ollama, vLLM, and mixed-provider use cases are adapted from Claude.
- **Structured output probe-and-cache.** Claude's approach of trying `json_schema` once, falling back to prompt-based extraction, and caching the decision.
- **Rate limit header parsing.** Claude noted the need to handle both `x-ratelimit-*` and `ratelimit-*` prefixes.

### From Gemini (structural influence)

- **Scope validation.** Gemini's attempt to include all three gaps (3, 5, 6) confirmed the scope is achievable — it's ambitious but each gap is independent enough to parallelize.
- **Phase ordering insight.** Gemini placed the transform API first, composition second, and adapter third — the same ordering the final sprint uses. This dependency chain is correct: composition depends on transforms, adapter is independent.
- **Use case for circular dependency detection.** Gemini explicitly called out cycle detection as a high-likelihood risk. This reinforced the priority of import-stack tracking in the composition transform.
- **Brevity as a signal.** Gemini's lighter treatment of each area helped identify which details from Claude and Codex were truly load-bearing vs. over-specified.

## What Was Dropped and Why

| Dropped | Source | Reason |
|---------|--------|--------|
| GAP-2 error subtypes (full phase) | Claude | Only one draft included it; mechanical work that doesn't block users. Deferred. |
| CLI `--transform` flag | Claude | Adds scope without proving the core API. Programmatic registration is sufficient for v1; CLI flag is a clean follow-up. |
| `openai_compatible` provider profile | Claude | Provider profiles are agent-loop specific. The adapter works through the unified client without needing a dedicated profile in v1. |
| `nectar validate --transform` flag | Claude | Same reasoning as CLI `--transform` — deferred with it. |
| Dynamic JS plugin loading from config/HTTP | Codex (out-of-scope) | Correctly excluded by Codex. Noted here to preserve the explicit boundary. |
| `type="subpipeline" src="..."` convention | Gemini | Codex's `"compose.dotfile"` is more idiomatic DOT and includes prefix control. |
| Web UI changes for composition | All | All three either excluded or minimized frontend work. Correct — this is an engine sprint. |
