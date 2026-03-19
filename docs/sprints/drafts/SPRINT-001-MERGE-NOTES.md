# Sprint 001 Merge Notes

## Claude Draft Strengths (Used)
- Detailed 5-step edge selection algorithm breakdown — adopted as the engine spec
- Typed engine events with subscriber pattern — adopted for engine/CLI boundary
- Comprehensive cocoon schema (graph_hash, retry state, interruption metadata, timestamps)
- Source-located parse errors and typed diagnostics
- `type` attribute override for shape-based handler resolution
- 4 CLI commands: `run`, `resume`, `validate`, `status`
- Atomic cocoon writes (temp-file + rename)
- TTY detection and pipe-friendly output
- Detailed theme system with specific emoji/color mapping
- `node:test` for zero-dependency testing

## Codex Draft Strengths (Used)
- `@ts-graphviz/parser` instead of custom parser — unanimously endorsed by all critiques
- Ships `scripts/compliance_loop.mjs` fixture — makes the demo actually work
- `POLLINATOR_*` environment variables for tool script context
- Engine never prints directly — events-only architecture
- Condition parser with allowlist grammar (no eval)
- Pure-function validators returning `Diagnostic[]`
- Comprehensive file manifest (35+ files with action/purpose)
- Explicit security section (eval avoidance, privilege, atomicity)
- `vitest` for testing (overriding Claude's `node:test` — better DX for integration tests)

## Gemini Draft Strengths (Used)
- Default timeout for tool nodes — prevents hung pipelines
- Concise phasing structure — kept sprint focused
- Open questions as first-class deliverables
- Concurrent runs are fine when isolated by run ID

## Valid Critiques Accepted
- **All three agents**: Custom DOT parser is wrong bet → use `@ts-graphviz/parser`
- **Claude critique**: Gemini missing fixture script, no validate command, no event system
- **Codex critique**: Claude draft too wide for one sprint — trim to essential commands
- **Codex critique**: Stub handlers that silently succeed are dangerous → fail at validation (user confirmed)
- **Gemini critique**: Claude's acceptance of a failing demo is insufficient for MVP
- **Claude critique**: `uuid` package unnecessary — use `crypto.randomUUID()`
- **All three**: Edge selection must implement all 5 steps, not simplified 2-step

## Critiques Rejected (with reasoning)
- **Codex**: "Source-located custom parsing" — we're using a library, but we still wrap it with good error reporting
- **Codex**: "Defer `status` command" — it's trivial (read + format JSON) and fills a real UX gap
- **Codex**: "`tsup` bundler not needed" — agreed, but we do need `tsc` for type checking
- **Claude critique**: "Named retry presets" — deferred to Sprint 2 per Claude's own recommendation

## Interview Refinements Applied
1. **Unsupported node types fail at validation** — strict mode, no stub pass-through
2. **Node 22 runtime** — no single-binary packaging this sprint
3. **Cocoons in `.nectar/cocoons/`** — hidden from project root per user preference
