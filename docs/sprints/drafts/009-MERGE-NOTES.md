# Sprint 009 Merge Notes

## Drafts / Critiques Considered

| Source | Author | Title | Role |
|--------|--------|-------|------|
| 008-CLAUDE-DRAFT.md | Claude | Model Stylesheet, Default Blocks & Parallel Tool Execution | Primary design source |
| 008-CODEX-DRAFT.md | Codex | Seedbed Foundation — Filesystem Capture and Swarm Analysis | Scoping reference |
| 008-GEMINI-DRAFT.md | Gemini | Agentic Parallelism & Performance | Performance cluster reference |
| NEXT-CLAUDE-CRITIQUE.md | Claude | Critique of all three drafts | Synthesis guide |
| NEXT-CODEX-CRITIQUE.md | Codex | Critique of Claude and Gemini drafts | Synthesis guide |

## Synthesis Strategy

Sprint 008 shipped the seedbed foundation and DOT parser improvements (GAP-13, GAP-14, GAP-17, GAP-20). The remaining work recommended by both critiques falls into two clusters: (1) model stylesheets with runtime attribute plumbing, and (2) parallel tool execution with a safety model. Both critiques converged on this split and agreed on a cut line: authoring ships first, parallel tools can slip.

The Codex critique's recommendations drove the key scoping decisions — particularly narrowing the attribute scope and requiring explicit runtime plumbing. The Claude critique's recommendations drove the phasing and strategic framing.

## What Was Taken From Each Source

### From 008-CLAUDE-DRAFT.md — Structural backbone

**Adopted for Phases 1-5:**
- Model stylesheet micro-language design: 4 selector types (`*`, shape, `.class`, `#id`), specificity system, CSS-like resolution
- `parseStylesheet()` / `resolveNodeStyle()` architecture
- Stylesheet application as AST transform in the pipeline
- Parallel tool execution with `ToolSafetyClassification` (read_only vs mutating)
- `Promise.allSettled()` instead of `Promise.all()` for failure isolation
- Bounded concurrency via semaphore (`max_parallel_tools`)
- Profile-driven `parallel_tool_execution` flag
- 6-phase structure with explicit cut line

**Modified based on Codex critique:**
- **Narrowed attribute scope**: Dropped `auto_status`, `fidelity`, `thread_id`, `default_fidelity`, and edge attributes. These are parse-only fields with no runtime behavior today — the Codex critique correctly flagged them as inflating the sprint. Kept only `class`, `llm_model`, `llm_provider`, `reasoning_effort` (must-ship) and `model_stylesheet` (required for stylesheet system).
- **Added explicit runtime plumbing phase**: The Claude draft implied these attributes would "just work" once parsed. The Codex critique correctly identified that `CodergenHandler` → `AgentSession` → `UnifiedClient` forwarding is real integration work that must be explicit. Added Phase 4 for this.
- **Fixed batch execution ordering**: The Claude draft partitioned all read-only calls ahead of all mutating calls. The Codex critique identified that this breaks interleaved sequences like `read → write → read` where the second read must observe the write. Replaced with order-preserving partitioned dispatch that only parallelizes contiguous same-safety runs.
- **Added stylesheet parse-error behavior**: The Codex critique flagged this as an unspecified risk. Added explicit behavior: valid rules apply even when other rules have syntax errors.
- **Added provider-profiles.ts to file plan**: The Codex critique noted this integration point was missing.

### From 008-GEMINI-DRAFT.md — Performance cluster reference

**Adopted:**
- Operational rigor for tool-result ordering: both OpenAI and Anthropic are strict about matching tool result order to tool call order. This became an explicit DoD item and test requirement.
- `Promise.allSettled()` over `Promise.all()` — the Gemini draft's architecture section said `allSettled` (contradicting its implementation section which said `all`). Both critiques caught this; the correct choice is `allSettled`.

**Deferred entirely:**
- Prompt caching auto-injection (GAP-53) — both critiques agreed this is Anthropic-only, requires broader type changes than acknowledged, and should be its own sprint.
- Context window awareness (GAP-44) — both critiques flagged the token-sum heuristic as unreliable (it over-counts because each turn's input tokens already include conversation history).

### From 008-CODEX-DRAFT.md — N/A for this sprint

The Codex draft's seedbed content was consumed by Sprint 008. The swarm analysis portion remains deferred — both critiques agreed LLM output normalization needs more design.

### From NEXT-CLAUDE-CRITIQUE — Strategic framing

Key recommendations adopted:
1. **Authoring cluster as primary scope** — the Claude critique argued this is the highest-leverage investment: 11 GAPs → narrowed to 6 (the must-ship subset)
2. **Defer prompt caching and context window** — saves a third of the sprint scope
3. **Claude draft's phasing with explicit cut line** — "if behind schedule, cut parallel tools"
4. **Build/regression gates in DoD** — `npm run build && npm test` as explicit checklist items

### From NEXT-CODEX-CRITIQUE — Implementation rigor

Key recommendations adopted:
1. **Narrow attribute scope to must-ship** — `llm_model`, `llm_provider`, `reasoning_effort`, `class` only. Lower-value fields deferred.
2. **Make runtime plumbing explicit** — forwarding attributes through CodergenHandler → AgentSession → UnifiedClient is a real phase, not an afterthought
3. **Rewrite concurrency plan around order preservation** — don't batch all reads ahead of all writes; preserve original sequence semantics
4. **Require end-to-end runtime proof** — DoD must include a test proving stylesheet output actually changes provider/model selection
5. **Specify stylesheet parse-error behavior** — what happens with mixed valid/invalid rules
6. **Include provider-profiles.ts in file plan** — missing from Claude draft's module layout

## What Was Not Taken and Why

| Idea | Source | Reason for exclusion |
|------|--------|---------------------|
| `auto_status`, `fidelity`, `thread_id` node attributes | Claude draft | No runtime behavior drives them yet; pure parse-only overhead |
| Edge attributes (`fidelity`, `thread_id`) | Claude draft | Same — no runtime consumer |
| `default_fidelity` graph attribute | Claude draft | Fidelity runtime (GAP-07) not in scope |
| Prompt caching (GAP-53) | Gemini draft | Anthropic-only; broader type changes than acknowledged |
| Context window awareness (GAP-44) | Gemini draft | Token-sum heuristic is unreliable; needs better design |
| Swarm analysis (`pollinator swarm`) | Codex draft | LLM normalization fragile; deferred from Sprint 008 for same reason |
| `executeToolsBatch` in `src/llm/client.ts` | Claude draft | Codex critique correctly noted `client.ts` doesn't execute tools; `tools.ts` is the right home |
| Seedbed as Sprint 009 scope | Claude critique | Already shipped in Sprint 008 |

## Cut Line

If schedule slips: **ship Phases 1-4 (authoring cluster + runtime plumbing) and defer Phase 5 (parallel tools) to Sprint 010.** The authoring cluster is independently valuable — pipeline authors get multi-model control via stylesheets. The parallel tools cluster is independently valuable but doesn't block anything. Either cluster can ship alone as a coherent sprint.
