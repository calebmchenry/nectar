# Sprint 007 Merge Notes

## Structural Base: Claude Draft

The Claude draft was used as the structural backbone of the final sprint. It had the most complete architecture section (design principles, data flow diagram, key abstractions), the most detailed Definition of Done (28 items grouped by subsystem), and the clearest phase breakdown with explicit file lists per phase.

## What Was Taken From Each Draft

### From the Claude Draft (primary source)
- Overall document structure: Overview, Use Cases, Architecture, Implementation phases, Files Summary, DoD, Risks, Dependencies
- Design principles section (one tool contract, tools return errors, truncation invisible to tools, sequential execution)
- Module layout under `src/agent-loop/` with one file per tool
- Data flow diagram
- All 7 use cases
- Phase structure (5 phases with percentage weights)
- Comprehensive Definition of Done (28+ items across 7 subsections)
- Artifact layout specification
- `write_file` semantics: always writes, creates parent dirs (no overwrite guard) — more practical for coding agents
- Binary file detection in `read_file` via null-byte check in first 8KB
- `.gitignore` respect in `grep` and `glob`
- `grep` with optional `path` parameter to scope searches to subdirectories
- Explicit literal string match semantics for `edit_file` (not regex)
- Risk: TOCTOU in edit_file, mid-node resume limitation

### From the Codex Draft
- Detailed tool contract specifications (most precise of the three drafts) — merged into the Tool Contracts section
- Artifact layout with `tool-calls/<NNN>-<name>/` structure and separate stdout.log/stderr.log
- `max_turns` vs `max_tool_rounds_per_input` distinction with explicit semantics
- Runaway loop detection specification: fingerprint-based, 3 consecutive repeats, "no successful file mutation" qualifier
- Risk table entries: scope creep as High/High, shell output overwhelming context, ajv dependency consideration
- Environment variable filtering specifics: keep PATH, HOME, USER, TMPDIR, LANG, LC_*, CI, NODE_ENV, POLLINATOR_*; drop *_API_KEY, *_SECRET, *_TOKEN, *_PASSWORD, *_CREDENTIAL*
- `TranscriptWriter` abstraction with specific method signatures
- `ScriptedAdapter` test helper concept for deterministic testing with zero LLM calls
- `SessionConfig` and `SessionResult` type definitions with specific fields

### From the Gemini Draft
- Awareness of provider-specific edit formats (apply_patch v4a) — incorporated into the "out of scope" section to make the decision explicit
- Higher `max_tool_rounds_per_input` default — final sprint uses 10 (compromise between Codex/Claude's 8 and Gemini's 15)
- Conciseness as a forcing function — the Gemini draft's brevity highlighted which details from the other drafts were truly essential vs. over-specified

### From the Claude Critique
- Priority tier system (Tier 1/2/3) — adopted from the critique's recommendation #10, modeled on Sprint 006's precedent. This is the single most important structural addition: it turns an all-or-nothing sprint into a deliverable one.
- `max_tool_rounds_per_input` = 10 (compromise recommendation)
- Gemini adapter dependency resolution: explicit note that the Gemini profile is forward-compatible preparation
- Workspace root configurability: added `--workspace` CLI flag and `POLLINATOR_WORKSPACE` env var as canonical sources beyond `process.cwd()`
- `ignore` npm package for .gitignore parsing (recommendation #3)
- Dropped `model_stylesheet` from DoD (recommendation #9) — references unimplemented GAP-06
- Merged risk table from all drafts (recommendation #8)

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Directory name | `src/agent-loop/` | Avoids collision with future top-level "agent" concept; 2 of 3 drafts agreed |
| `write_file` semantics | Always writes (no overwrite guard) | Coding agents overwrite files constantly; overwrite guard causes unnecessary tool errors. `edit_file` handles careful changes. |
| `max_tool_rounds_per_input` | 10 | 8 (Codex/Claude) is tight for real multi-step tasks; 15 (Gemini) masks runaway behavior. 10 is the practical middle ground, configurable via node attribute. |
| Loop detection qualifier | "no file mutation" | Codex/Claude's "no file mutation" is cleaner than Gemini's "failing" qualifier — a successful `grep` isn't "failing" but also isn't productive progress. |
| `model_stylesheet` in DoD | Dropped | References GAP-06 which is unimplemented; would block sprint completion. |
| `grep` tool | Separate first-class tool with `path` param | Gemini bundled it into `fs.ts` and omitted the `path` parameter; scoped search is essential for agent effectiveness. |
| Provider-specific edit DSLs | Explicitly out of scope | All drafts agreed. One `edit_file` contract keeps the sprint finishable. |

## What Was Excluded and Why

- **Codex's `write_file` overwrite guard (`overwrite=false` default):** Would cause friction on every normal file update. Coding agents overwrite files as their core workflow.
- **Gemini's `model_stylesheet` DoD criterion:** References unimplemented feature (GAP-06). Can't be met.
- **Gemini's `src/agent/` directory name:** Less specific, potential collision with future concepts.
- **Gemini's bundled `fs.ts` for multiple tools:** One-file-per-tool is more consistent with the project's existing module style.
- **Gemini's provider-specific tool shapes (apply_patch v4a for OpenAI):** Correctly deferred by all drafts but the decision is now explicitly documented in the "out of scope" section.
- **Codex's interleaved stdout/stderr `combined.log`:** Nice-to-have but adds complexity; separate `.log` files are sufficient for this sprint.
- **Gemini's `max_tool_rounds_per_input = 15`:** Too generous, could mask runaway behavior. Compromised at 10.
