# Sprint 018: Swarm Intelligence — Multi-AI Seed Analysis

## Overview

**Goal:** Deliver the first AI-powered user feature in Nectar: `nectar swarm <id>` sends a seed to Claude, Codex (OpenAI), and Gemini independently, produces structured analysis files, and surfaces a synthesis view. After this sprint, seeds captured via `nectar seed` are no longer inert text — they become analyzed, prioritized, and AI-augmented artifacts.

**Why this sprint, why now:**

- **The compliance floor is built. Nothing ships to users.** Sprints 001–017 built a fully spec-compliant engine, LLM client, agent loop, and seedbed foundation. But the product has zero AI-powered features that users actually touch. The engine runs pipelines. The seedbed stores ideas. Neither connects to the LLM infrastructure that was the whole point of building them.
- **Swarm Intelligence is the single highest-impact user-facing feature remaining.** It exercises the full multi-provider LLM stack (Anthropic, OpenAI, Gemini) end-to-end. It turns the seedbed from a fancy file organizer into an intelligent idea triage system. It delivers on INTENT.md §2C-iii — the "killer feature" that differentiates Nectar from a bare Graphviz runner.
- **The substrate is ready.** The seedbed (`src/seedbed/`) handles creation, metadata, attachments, and consistency. The LLM client (`src/llm/`) has adapters for all three providers with middleware, retry, structured output, and streaming. The model catalog resolves logical selectors. All that's missing is the glue: a prompt, a structured output schema, and a CLI command.
- **It's achievable in one sprint.** The scope is narrow: one new module (`src/swarm/`), one new CLI command, and analysis file I/O. No engine changes. No parser changes. No new dependencies. The hard infrastructure work is done.

**Why NOT HTTP server mode (GAP-A2)?** The HTTP server is a prerequisite for the Web UI, but the Web UI is a multi-sprint effort. Shipping the server without the UI delivers no user value. Swarm Intelligence delivers user value immediately from the CLI.

**Why NOT OpenAI-compatible adapter (GAP-L1)?** GAP-L1 is additive — it enables third-party endpoints (Ollama, vLLM, etc.) but doesn't unblock any core product feature. Swarm works with the three major providers already implemented.

**Why NOT custom transform registration (GAP-A1)?** Extensibility API for external consumers. No user asked for it. Designing it well requires knowing what real transforms look like — ship more features first, then generalize.

**In scope:**

- Analysis prompt engineering for structured seed evaluation
- Parallel multi-provider LLM calls (Claude, Codex, Gemini) with independent failure handling
- Structured analysis output with YAML front matter per INTENT.md §3 (Analysis File Contract)
- `analysis/{provider}.md` file persistence
- `meta.yaml` `analysis_status` lifecycle management
- CLI: `nectar swarm <id>` (analyze one seed), `nectar swarm --all` (analyze all pending)
- CLI: `nectar seed show <id>` enhanced with analysis summary
- Synthesis logic: agreement/divergence detection across provider analyses
- Streaming progress output during analysis
- Graceful degradation when providers are unavailable (skip, don't fail)

**Out of scope:**

- Web UI synthesis view (requires HTTP server)
- Automatic swarm trigger on seed creation (future enhancement — keep it explicit this sprint)
- Image/video attachment analysis (text-only analysis of seed.md content this sprint)
- Custom analysis prompts per seed
- GAP-A1, GAP-A2, GAP-A3, GAP-L1, GAP-L2

---

## Use Cases

1. **Analyze a seed from three perspectives.** User runs `nectar swarm 42`. Nectar reads `seedbed/042-rate-limiting/seed.md`, sends it to Claude, Codex, and Gemini in parallel. Each provider produces a structured analysis saved to `analysis/claude.md`, `analysis/codex.md`, `analysis/gemini.md`. The CLI streams progress as each provider responds.

2. **Re-run analysis for a single provider.** `nectar swarm 42 --provider claude` re-analyzes with only Claude. The existing `analysis/claude.md` is overwritten. Other provider analyses are untouched. Useful when a previous run failed or the seed content was updated.

3. **Batch analyze all pending seeds.** `nectar swarm --all` finds every seed where any `analysis_status` is `pending` and runs analysis for those providers. Seeds with all analyses `complete` are skipped. The CLI shows a progress summary.

4. **View synthesis after analysis.** `nectar seed show 42` now includes a synthesis section below the raw seed content: what the three AIs agree on (consensus priority, consensus complexity), where they diverge (different implementation approaches, conflicting risk assessments), and a suggested priority based on the majority recommendation.

5. **Handle provider failures gracefully.** User has `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` but no `OPENAI_API_KEY`. `nectar swarm 42` analyzes with Claude and Gemini, marks `codex` as `skipped` in `meta.yaml`, and prints a warning. The seed still gets two analyses. No crash, no partial state.

6. **Inspect analysis files directly.** An AI agent (or human) reads `seedbed/042-rate-limiting/analysis/claude.md` and finds YAML front matter with `provider`, `generated_at`, `status`, `recommended_priority`, `estimated_complexity`, `feasibility`, followed by Markdown sections: Summary, Implementation Approach, Risks, Open Questions. Fully machine-parseable and human-readable.

7. **Priority suggestion from the swarm.** After analysis completes, if 2+ providers agree on a priority higher than the seed's current priority, the CLI suggests: `🐝 The swarm recommends priority: high (2/3 agree). Run: nectar seed set-priority 42 high`. It does not auto-change — the user decides.

---

## Architecture

### Design Principles

1. **Parallel, independent, fault-tolerant.** Each provider call is independent. One failure does not block or cancel others. Results are saved as they arrive. `meta.yaml` is updated per-provider, not as a batch.
2. **Structured output, not free-form parsing.** Use the LLM client's `generateObject<T>()` with a JSON Schema to get structured fields (priority, complexity, feasibility). The Markdown body is returned as a string field within the structured response. No regex parsing of LLM output.
3. **The filesystem is the API.** Analysis files follow the contract in INTENT.md §3. YAML front matter + Markdown body. Any tool that can read Markdown can consume them.
4. **Synthesis is deterministic.** The synthesis view is computed from parsed front matter fields, not from re-reading Markdown bodies. Agreement = same value across providers. Divergence = different values. No LLM call for synthesis.
5. **Explicit over automatic.** Analysis runs when the user asks (`nectar swarm`), not as a side effect of seed creation. Users control when API credits are spent.

### Module Layout

```text
src/swarm/
  types.ts              CREATE — AnalysisResult, SynthesisResult, AnalysisPrompt types
  analyzer.ts           CREATE — Single-provider analysis via generateObject<T>()
  orchestrator.ts       CREATE — Multi-provider parallel dispatch, status tracking
  prompt.ts             CREATE — Analysis prompt template
  synthesis.ts          CREATE — Cross-provider agreement/divergence computation
  file-io.ts            CREATE — Read/write analysis/{provider}.md with YAML front matter

src/cli/commands/
  swarm.ts              CREATE — nectar swarm <id> [--provider] [--all]
  seed.ts               MODIFY — Enhance show subcommand with analysis summary
```

### Key Abstractions

**`AnalysisResult`** — Structured output from a single provider:

```typescript
interface AnalysisResult {
  provider: string;
  generated_at: string;
  status: 'complete' | 'failed';
  recommended_priority: SeedPriority;
  estimated_complexity: 'low' | 'medium' | 'high' | 'very_high';
  feasibility: 'low' | 'medium' | 'high';
  summary: string;
  implementation_approach: string;
  risks: string;
  open_questions: string;
  error?: string;
}
```

**`SeedAnalyzer`** — Calls a single provider via `UnifiedClient.generateObject<AnalysisResult>()`:
- Builds the analysis prompt from seed content + metadata
- Uses structured output (JSON Schema) for reliable extraction
- Falls back to `generate()` + manual parsing if structured output fails (Gemini edge case)
- Returns `AnalysisResult` on success, marks `failed` with error on failure

**`SwarmOrchestrator`** — Manages parallel analysis across providers:
- Resolves which providers are available (have API keys configured)
- Launches analyses concurrently via `Promise.allSettled()`
- Updates `meta.yaml` `analysis_status` per-provider as results arrive
- Writes `analysis/{provider}.md` files with YAML front matter + Markdown body
- Returns all results (including failures) for CLI rendering

**`SynthesisEngine`** — Computes agreement/divergence from completed analyses:
- Reads all `analysis/{provider}.md` front matter
- Computes consensus: majority value for priority, complexity, feasibility
- Identifies divergences: fields where providers disagree
- Returns `SynthesisResult` for rendering

### Analysis Prompt

The prompt is the most important design decision. It must produce consistent, comparable output across three different LLMs. The prompt:

1. Provides the seed title, body, priority, tags, and any attachment filenames as context
2. Asks for a structured assessment covering the four required sections
3. Constrains output to the `AnalysisResult` schema via structured output
4. Includes calibration guidance: "low complexity = a few hours, medium = a few days, high = a week+, very_high = multi-week"

```text
You are a senior software architect analyzing a feature idea for prioritization.

## Idea
Title: {title}
Priority (current): {priority}
Tags: {tags}
Content:
{seed_md_content}

## Task
Analyze this idea and provide a structured assessment. Be specific and actionable.

For each field:
- recommended_priority: Your independent assessment (low/normal/high/queens_order)
- estimated_complexity: Engineering effort (low=hours, medium=days, high=week+, very_high=multi-week)
- feasibility: How realistic is this? (low/medium/high)
- summary: 2-3 sentence executive summary
- implementation_approach: Concrete technical approach, key decisions, suggested architecture
- risks: What could go wrong? Dependencies, unknowns, technical debt
- open_questions: What needs clarification before starting?
```

### Analysis File Format

Per INTENT.md §3 (Analysis File Contract):

```markdown
---
provider: claude
generated_at: 2026-03-20T16:05:00Z
status: complete
recommended_priority: high
estimated_complexity: medium
feasibility: high
---

# Summary

Rate limiting is a critical infrastructure need...

# Implementation Approach

Use a token bucket algorithm at the API gateway layer...

# Risks

- Distributed rate limiting across multiple gateway instances requires shared state
- Cache invalidation during rolling deploys...

# Open Questions

- What are the current p99 request rates?
- Should rate limits be per-user, per-API-key, or per-IP?
```

### Data Flow

```text
nectar swarm 42
    │
    ├── SeedStore.get(42) → seed content + meta
    │
    ├── SwarmOrchestrator.analyze(seed)
    │     │
    │     ├── resolve available providers (check API keys)
    │     │
    │     ├── Promise.allSettled([
    │     │     SeedAnalyzer.analyze('anthropic', seed),
    │     │     SeedAnalyzer.analyze('openai', seed),
    │     │     SeedAnalyzer.analyze('gemini', seed),
    │     │   ])
    │     │     │
    │     │     ├── UnifiedClient.generateObject<AnalysisResult>()
    │     │     │     uses structured output JSON Schema
    │     │     │
    │     │     └── returns AnalysisResult per provider
    │     │
    │     ├── write analysis/{provider}.md (YAML front matter + Markdown)
    │     ├── update meta.yaml analysis_status per provider
    │     └── return all results
    │
    ├── SynthesisEngine.synthesize(results)
    │     └── compute consensus + divergences
    │
    └── CLI renders: per-provider summaries + synthesis + priority suggestion
```

### Provider Mapping

| Nectar Name | Provider | Model Selector | Fallback |
|-------------|----------|---------------|----------|
| `claude` | `anthropic` | `default` | Skip if no `ANTHROPIC_API_KEY` |
| `codex` | `openai` | `default` | Skip if no `OPENAI_API_KEY` |
| `gemini` | `gemini` | `default` | Skip if no `GEMINI_API_KEY` |

The model catalog resolves `default` to the latest model per provider. Users can override per-provider model via `--model` flag in a future sprint.

---

## Implementation Phases

### Phase 1: Types, Prompt, and Single-Provider Analyzer (~20%)

**Files:** `src/swarm/types.ts` (create), `src/swarm/prompt.ts` (create), `src/swarm/analyzer.ts` (create), `src/swarm/file-io.ts` (create), `test/swarm/analyzer.test.ts` (create)

**Tasks:**

- [ ] Define `AnalysisResult` interface with all structured fields
- [ ] Define `SynthesisResult` interface: `consensus` (majority values), `divergences` (field → provider → value map), `provider_count`
- [ ] Define JSON Schema for `AnalysisResult` structured output (used by `generateObject<T>()`)
- [ ] Build analysis prompt template in `src/swarm/prompt.ts`: accepts seed title, body, priority, tags; returns formatted prompt string
- [ ] Implement `SeedAnalyzer.analyze(provider, seed)`:
  - Create a `UnifiedClient` request targeting the specified provider
  - Use `generateObject<AnalysisResult>()` with the JSON Schema
  - On structured output failure: fall back to `generate()` + extract JSON from response text
  - Set `reasoning_effort: 'medium'` to balance quality and cost
  - Return `AnalysisResult` with `status: 'complete'` on success
  - Catch all errors → return `AnalysisResult` with `status: 'failed'` and error message
- [ ] Implement `writeAnalysisFile(dirPath, result)`: serialize YAML front matter + Markdown body sections
- [ ] Implement `readAnalysisFile(filePath)`: parse YAML front matter → `AnalysisResult`
- [ ] Implement `readAllAnalyses(dirPath)`: read all `analysis/*.md` files
- [ ] Tests:
  - Prompt template includes all seed fields
  - Analyzer handles successful structured output
  - Analyzer handles structured output validation failure (fallback path)
  - Analyzer catches provider errors gracefully
  - File I/O round-trips: write then read produces identical `AnalysisResult`
  - YAML front matter is valid and parseable
  - Markdown sections are present and correctly formatted

### Phase 2: Orchestrator and Meta Updates (~20%)

**Files:** `src/swarm/orchestrator.ts` (create), `src/seedbed/store.ts` (modify), `test/swarm/orchestrator.test.ts` (create)

**Tasks:**

- [ ] Implement `SwarmOrchestrator`:
  - Constructor accepts `UnifiedClient` and `SeedStore`
  - `analyzeOne(seedId, options?)`: analyze a single seed across all (or specified) providers
  - `analyzeAllPending()`: find seeds with `pending` analysis_status, analyze each
- [ ] Provider availability check: query `UnifiedClient` for which providers are configured
  - Missing providers → mark as `skipped` in `meta.yaml`, emit warning
  - Zero available providers → clear error: "No LLM providers configured"
- [ ] Parallel dispatch via `Promise.allSettled()`:
  - Each provider runs independently
  - As each completes: write analysis file, update `meta.yaml` `analysis_status`
  - Use per-provider status updates (not batch) so partial results survive crashes
- [ ] Add `updateAnalysisStatus(id, provider, status)` method to `SeedStore`
- [ ] Handle re-analysis: if `analysis/{provider}.md` already exists, overwrite it
- [ ] Emit progress callbacks for CLI rendering: `{ provider, phase: 'started' | 'complete' | 'failed' | 'skipped' }`
- [ ] Tests:
  - Three providers all succeed → three analysis files, all statuses `complete`
  - One provider fails → two files written, failed provider marked `failed`
  - No providers configured → clear error
  - Single provider mode (`--provider claude`) → only that provider runs
  - Re-analysis overwrites existing file and updates status
  - `analyzeAllPending()` skips seeds with all analyses complete
  - `analyzeAllPending()` only analyzes `pending` providers (not `complete` or `failed`)
  - Progress callbacks fire in correct order
  - Meta.yaml updated per-provider (not batch)

### Phase 3: Synthesis Engine (~15%)

**Files:** `src/swarm/synthesis.ts` (create), `test/swarm/synthesis.test.ts` (create)

**Tasks:**

- [ ] Implement `SynthesisEngine.synthesize(analyses: AnalysisResult[])`:
  - Filter to `status: 'complete'` analyses only
  - Compute consensus for each structured field: `recommended_priority`, `estimated_complexity`, `feasibility`
    - Consensus = value that appears most frequently (majority)
    - On tie: use the higher-severity value (e.g., `high` beats `medium`)
  - Identify divergences: fields where not all providers agree
    - For each divergent field: map of provider → value
  - Return `SynthesisResult` with `consensus`, `divergences`, `provider_count`, `agreement_ratio`
- [ ] Handle edge cases:
  - Only one provider completed → consensus = that provider's values, no divergences
  - Zero providers completed → return null (nothing to synthesize)
  - Two of three agree → consensus from majority, divergence shows the outlier
- [ ] Tests:
  - All three agree on everything → full consensus, no divergences
  - Two agree, one disagrees → consensus from majority, divergence shows disagreement
  - All three disagree → consensus uses severity tiebreaker, all fields are divergences
  - Single provider → consensus from that provider
  - Zero providers → null result
  - Mixed statuses: failed analyses excluded from synthesis

### Phase 4: CLI Command and Enhanced Seed Show (~25%)

**Files:** `src/cli/commands/swarm.ts` (create), `src/cli/commands/seed.ts` (modify), `src/cli/index.ts` (modify), `src/cli/ui/renderer.ts` (modify), `test/integration/swarm-cli.test.ts` (create)

**Tasks:**

- [ ] Register `swarm` command in `src/cli/index.ts`
- [ ] Implement `nectar swarm <id>`:
  - Validate seed exists
  - Show seed title and current priority
  - Start analysis with streaming progress:
    ```
    🐝 Summoning the swarm for seed #42: "Add rate limiting"
    🧠 Claude analyzing...  ✅ complete (4.2s)
    🧠 Codex analyzing...   ✅ complete (3.8s)
    🧠 Gemini analyzing...  ⚠️  skipped (no API key)

    📊 Swarm Consensus:
       Priority:   high (2/2 agree)
       Complexity: medium (2/2 agree)
       Feasibility: high (2/2 agree)

    📝 Analyses saved to seedbed/042-rate-limiting/analysis/
    💡 The swarm recommends priority: high. Run: nectar seed set-priority 42 high
    ```
  - `--provider <name>` flag: analyze with only the specified provider
  - `--all` flag: batch analyze all seeds with pending analyses
  - `--force` flag: re-analyze even if analysis already exists (resets status to `pending` first)
- [ ] Implement `nectar swarm --all`:
  - Find seeds with any `pending` analysis_status
  - Analyze each sequentially (to avoid rate limiting across seeds)
  - Show per-seed progress summary
  - Print total at end: "🍯 Analyzed N seeds. M skipped (already complete)."
- [ ] Enhance `nectar seed show <id>`:
  - After seed content, show analysis summary if analyses exist
  - Per-provider: one-line summary with recommended priority and complexity
  - Synthesis section if 2+ analyses complete
  - Show `pending`/`failed`/`skipped` status for incomplete analyses
- [ ] TTY-aware output: spinners for in-progress analysis, plain text when piped
- [ ] Themed output following established patterns (bee/flower/honey puns)
- [ ] Tests:
  - CLI validates seed exists before analyzing
  - Progress output shows each provider status
  - `--provider` flag limits to single provider
  - `--all` flag finds and processes pending seeds
  - `--force` flag re-analyzes existing analyses
  - Enhanced `seed show` includes analysis summary
  - Non-TTY output has no spinners or ANSI codes
  - Missing API keys produce warnings, not errors

### Phase 5: Integration Tests and Polish (~20%)

**Files:** `test/integration/swarm-cli.test.ts` (extend), `test/swarm/integration.test.ts` (create)

**Tasks:**

- [ ] End-to-end: create seed → swarm analyze → verify analysis files on disk
- [ ] End-to-end: create seed → swarm analyze → seed show displays synthesis
- [ ] End-to-end: `swarm --all` processes multiple seeds correctly
- [ ] Provider failure: simulate one provider returning error → others still complete
- [ ] Provider unavailable: no API key → provider skipped, meta.yaml correct
- [ ] Re-analysis: run swarm twice → second run overwrites first analysis
- [ ] File format verification: analysis files match INTENT.md §3 contract exactly
- [ ] Synthesis correctness: create known analysis files → verify synthesis computation
- [ ] Verify all existing tests pass — zero regressions
- [ ] Verify `npm run build` clean
- [ ] Run `nectar swarm` against a real seed with simulation provider to validate the full path

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/swarm/types.ts` | Create | AnalysisResult, SynthesisResult, JSON Schema, prompt types |
| `src/swarm/prompt.ts` | Create | Analysis prompt template builder |
| `src/swarm/analyzer.ts` | Create | Single-provider analysis via generateObject |
| `src/swarm/orchestrator.ts` | Create | Multi-provider parallel dispatch and status management |
| `src/swarm/synthesis.ts` | Create | Cross-provider consensus and divergence computation |
| `src/swarm/file-io.ts` | Create | Read/write analysis/{provider}.md with YAML front matter |
| `src/cli/commands/swarm.ts` | Create | `nectar swarm` CLI command |
| `src/cli/commands/seed.ts` | Modify | Enhance `seed show` with analysis summary and synthesis |
| `src/cli/index.ts` | Modify | Register `swarm` command |
| `src/cli/ui/renderer.ts` | Modify | Swarm progress rendering helpers |
| `src/seedbed/store.ts` | Modify | Add `updateAnalysisStatus()` method |
| `test/swarm/analyzer.test.ts` | Create | Single-provider analysis unit tests |
| `test/swarm/orchestrator.test.ts` | Create | Multi-provider orchestration tests |
| `test/swarm/synthesis.test.ts` | Create | Synthesis computation tests |
| `test/swarm/file-io.test.ts` | Create | Analysis file I/O round-trip tests |
| `test/integration/swarm-cli.test.ts` | Create | End-to-end CLI integration tests |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing seedbed commands work identically

### Analysis Core
- [ ] `SeedAnalyzer` produces structured `AnalysisResult` via `generateObject<T>()`
- [ ] Structured output fallback works when primary path fails
- [ ] Analysis prompt includes seed title, body, priority, and tags
- [ ] Provider errors are caught and returned as `status: 'failed'` (not thrown)
- [ ] `reasoning_effort: 'medium'` set on all analysis requests

### Multi-Provider Orchestration
- [ ] Three providers analyzed in parallel via `Promise.allSettled()`
- [ ] Missing API keys → provider `skipped`, not crashed
- [ ] `meta.yaml` `analysis_status` updated per-provider as results arrive
- [ ] Partial results survive: if process crashes after 2 of 3, those 2 analyses are on disk
- [ ] `--provider` flag limits analysis to single provider
- [ ] `--all` flag finds and processes all seeds with `pending` analyses
- [ ] `--force` flag re-analyzes even when analysis already exists

### Analysis File Contract
- [ ] Files written to `analysis/{provider}.md` matching INTENT.md §3 format
- [ ] YAML front matter contains: provider, generated_at, status, recommended_priority, estimated_complexity, feasibility
- [ ] Markdown body contains sections: Summary, Implementation Approach, Risks, Open Questions
- [ ] Files are independently readable by humans and machines
- [ ] Re-analysis overwrites existing files cleanly

### Synthesis
- [ ] `SynthesisEngine` computes consensus from 2+ completed analyses
- [ ] Divergences identified: fields where providers disagree
- [ ] Single-provider analysis → consensus from that provider
- [ ] Zero completed analyses → null synthesis (no crash)
- [ ] Severity tiebreaker on ties (higher severity wins)

### CLI
- [ ] `nectar swarm <id>` analyzes seed and shows results with themed output
- [ ] Progress shows per-provider status (analyzing/complete/failed/skipped)
- [ ] `nectar seed show <id>` displays analysis summary and synthesis when available
- [ ] Priority suggestion shown when swarm recommends higher priority than current
- [ ] Non-TTY output has no spinners or ANSI codes
- [ ] Provider warnings are clear: "⚠️ Codex skipped (OPENAI_API_KEY not set)"

### Test Coverage
- [ ] At least 35 new test cases across all phases
- [ ] Analyzer: success, structured output fallback, provider error, all fields populated
- [ ] Orchestrator: all succeed, partial failure, no providers, single provider, re-analysis, batch
- [ ] Synthesis: full consensus, partial divergence, full divergence, single provider, zero providers
- [ ] File I/O: write/read round-trip, YAML front matter correctness, Markdown structure
- [ ] Integration: end-to-end create→analyze→show, batch analysis, provider failure

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Structured output unreliable across providers** | Medium | High | Primary path uses `generateObject<T>()` with JSON Schema. Fallback path uses `generate()` + JSON extraction from response text. Both paths tested. Gemini is the most likely to need the fallback — test it specifically. |
| **Rate limiting during batch analysis** | Medium | Medium | `swarm --all` processes seeds sequentially, not in parallel across seeds. Within a seed, three providers run concurrently but target different APIs. Add a 1-second delay between seeds in batch mode. |
| **LLM output quality varies wildly** | High | Medium | The prompt is calibrated with explicit definitions for priority/complexity/feasibility values. Structured output constrains the schema. The synthesis view surfaces disagreement rather than hiding it. Users make final decisions. |
| **API cost surprises** | Medium | Medium | Analysis uses `reasoning_effort: 'medium'` to reduce token usage. The `--all` flag requires explicit invocation (no auto-trigger). Future sprint can add cost estimation before running. |
| **Provider-specific structured output quirks** | Medium | Medium | Anthropic uses synthetic tool_choice. OpenAI uses native json_schema. Gemini uses responseMimeType. All three paths are already implemented in `generateObject()`. Test each provider path. |
| **Analysis files become stale after seed edits** | Medium | Low | Analysis files include `generated_at`. The CLI could warn if `seed.md` was modified after the latest analysis. Defer to future sprint — don't over-engineer. |
| **Concurrent `nectar swarm` on same seed** | Low | Low | Each provider writes to a distinct file (`claude.md`, `codex.md`, `gemini.md`). Meta.yaml updates use atomic write. Worst case: one analysis overwrites another's in-progress status, but the file on disk is always valid. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `UnifiedClient` with `generateObject<T>()` | Structured analysis output | Implemented |
| `SeedStore` with CRUD and meta updates | Seed reading and analysis_status management | Implemented |
| Model catalog with logical selectors | Provider-agnostic model resolution | Implemented |
| Provider adapters (Anthropic, OpenAI, Gemini) | Multi-provider LLM calls | Implemented |
| Simulation provider | Test-time LLM stubbing | Implemented |
| `yaml` package | YAML front matter parsing | Already a dependency |
| CLI scaffolding (commander, chalk, ora) | Command registration and themed output | Implemented |
| Middleware + retry | Reliable LLM calls with backoff | Implemented |

**Zero new npm dependencies.** All work builds on existing LLM client, seedbed, and CLI infrastructure.

---

## Gap Closure Summary

This sprint does not close any spec compliance gaps. All remaining gaps (GAP-A1, GAP-A2, GAP-A3, GAP-L1, GAP-L2) are low-to-medium severity and do not block product functionality.

**What this sprint delivers instead:**

| Feature | INTENT.md Section | Status After Sprint |
|---------|-------------------|-------------------|
| Multi-AI Seed Analysis ("Swarm Intelligence") | §2C-iii | **Implemented** |
| Analysis File Contract | §3 (Analysis File Contract) | **Implemented** |
| `nectar swarm` CLI command | §2B (CLI requirements) | **Implemented** |
| Synthesis view (CLI) | §2C-iii.5 | **Implemented** |

**After this sprint:**
- Nectar transitions from "spec-compliant engine" to "product with AI features users touch"
- The seedbed becomes an intelligent idea triage tool, not just a file organizer
- The multi-provider LLM infrastructure built in Sprints 012–016 is exercised end-to-end for the first time in a user-facing feature
- Foundation laid for the Web UI synthesis view (Sprint 019+)

**Recommended next sprint (019):** HTTP Server Mode + Web UI foundation. With swarm intelligence proving the LLM stack works end-to-end, the natural next step is exposing it (and the full pipeline API) via HTTP for the browser-based Hive UI. Alternatively, GAP-L1 (OpenAI-compatible adapter) could be a quick win sprint if third-party LLM support is more urgent.
