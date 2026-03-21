# Sprint 020 Merge Notes

## Synthesis Strategy

All three drafts agreed the Hive web UI is either the top priority (Claude, Codex) or should follow soon after compliance work (Gemini). The merge takes the **Garden-only Hive scope** from Codex as the backbone, layers in the **best tactical ideas** from Claude's broader design, and pulls in the **two highest-value compliance gaps** that both Codex and Gemini identified.

---

## What Was Taken From Each Draft

### From NEXT-CODEX-DRAFT (primary backbone)

**Scope & philosophy:** The narrower "Garden Workbench" framing was adopted over Claude's full Hive MVP. Codex argued convincingly that the Garden workbench is a complete vertical slice (authoring → validation → execution → observation → approval) and that Seedbed Kanban should build on a reusable shell rather than be invented in the first frontend sprint. This is the right call — shipping a polished editor+execution experience beats shipping a broader but shallower UI.

**Server-authoritative rendering:** Codex's `POST /gardens/preview` approach (server parses, validates, and renders unsaved DOT) was chosen over Claude's client-side `@viz-js/viz` WASM rendering. Rationale: the server already has the parser, validator, transform pipeline, and `@viz-js/viz` installed. Having the browser implement its own rendering path creates drift risk — the preview could show "valid" DOT that the server rejects at runtime. Server-authoritative rendering keeps one source of truth.

**Natural-language drafting:** `POST /gardens/draft` with streaming SSE deltas was adopted. Claude's draft explicitly excluded NL→DOT generation ("needs prompt engineering work"). Codex scoped it as a streaming endpoint with a simulation adapter fallback, making it testable and demoable even without API keys. This is a compelling feature that differentiates the browser experience from the CLI.

**Asset embedding strategy:** The two-step `vite build` → `embed-assets.mjs` → `src/generated/hive-assets.ts` approach preserves the single-binary release model. Claude's draft assumed serving from `web/dist/` on disk, which breaks the compiled binary distribution. Codex's approach is more compatible with the existing `bun build --compile` pipeline.

**Directory naming:** `hive/` was adopted over Claude's `web/`. The frontend is specifically "The Hive" — naming the directory after the product concept rather than the generic "web" is clearer.

**Fan-in LLM evaluation (GAP-1):** Codex's strict "fail the node, no heuristic fallback" policy was adopted. This matches the spec intent and avoids silently masking why a pipeline behaved differently than authored.

**Failure events (GAP-5):** `stage_failed` and `pipeline_failed` alongside existing events for backward compatibility.

**Request contracts:** The `POST /gardens/preview` and `POST /gardens/draft` API contracts were taken directly from Codex.

### From NEXT-CLAUDE-DRAFT (tactical additions)

**Watercolor-botanical palette:** The color token table (nectar-sage, nectar-lavender, nectar-coral, nectar-honey, nectar-wilted) and semantic mappings were adopted. Claude put significant thought into how INTENT §3's "Modern and Opinionated" visual direction translates to concrete CSS custom properties. The merge incorporates these as the design token foundation.

**Use cases:** Several of Claude's use cases were merged in, particularly the cancel/resume flow and the SSE reconnection/replay behavior, which were more detailed than Codex's equivalents.

**Risk analysis:** Claude's risk entries for CodeMirror DOT grammar (no off-the-shelf solution, ~50-line StreamLanguage mode) and SVG node matching (`<title>` element strategy) were added. These are practical implementation risks that Codex didn't call out.

**Cut line clarity:** Claude's explicit "core trio" language was adapted — the merge defines editor + preview + run monitoring as the non-negotiable minimum, with NL drafting as the first thing to cut.

**What was NOT taken from Claude:** The Seedbed Kanban board, seed detail panel, Dashboard page, RunHistory page, dark mode toggle, `@dnd-kit` drag-and-drop, `react-markdown` seed rendering, `react-router-dom` multi-page routing, `lucide-react` icons, and Tailwind CSS. These are all good ideas for Sprint 021, but including them here would make the sprint too ambitious and dilute focus on the core Garden workbench.

### From NEXT-GEMINI-DRAFT (compliance items)

**GAP-1 (fan-in LLM) and GAP-5 (failure events):** Both were incorporated, as Codex also identified them. The merge follows Codex's integration approach (building them into the browser experience) rather than Gemini's standalone compliance framing.

**What was NOT taken from Gemini:** GAP-2 (Gemini extended tools: `read_many_files`, `list_dir`, `web_search`, `web_fetch`), GAP-3 (custom transform registry), and GAP-4 (sub-pipeline composition). These are valuable compliance work but: (a) they don't improve the Hive browser experience, (b) they're independently shippable in a future sprint, and (c) including them would split focus between frontend and backend work. GAP-2/3/4 should be Sprint 021 or a dedicated compliance sprint.

**Fan-in heuristic fallback:** Gemini's draft had the fan-in handler "fall back to heuristic ranking if LLM evaluation fails." Both Codex and the merge reject this — silent fallback violates the spec intent and hides failures. The node should fail explicitly.

---

## Key Decisions

1. **Scope = Garden workbench only.** Seedbed, Kanban, and Swarm UI are deferred. This is the single most important scoping decision.

2. **Server-side rendering, not client-side WASM.** One source of truth for DOT parsing and rendering. The browser is a thin display layer.

3. **Asset embedding for binary compat.** Frontend assets compile into a TS module, not served from disk.

4. **Two compliance gaps, not five.** GAP-1 and GAP-5 improve the browser experience. GAP-2/3/4 are deferred.

5. **No heuristic fallback for prompted fan-in.** Fail loudly, not silently.
