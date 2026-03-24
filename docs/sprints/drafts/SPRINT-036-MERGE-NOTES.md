# Sprint 036 — Merge Notes

## Base Draft Selection

**Codex draft** selected as the architectural base. It has correct file paths throughout, the strongest codebase understanding (identifies that tools ARE already registered, correctly locates `executeNodeSequence()` for BUG-3, proposes shared `exec-command.ts` for BUG-5), and the most defensible design decisions (reject diamond+prompt, filesystem-only PATH validation).

## Draft Strengths Adopted

### From Codex Draft (base)
- Shared `exec-command.ts` for process-group kill unification (BUG-5)
- Diamond+prompt as validation error, not LLM evaluation (BUG-7)
- Three-layer failure text flow: NodeOutcome → buildFailureMessage() → EventRenderer (BUG-2)
- `assert_exists` scoped to tool nodes initially, parsed at garden level (BUG-4)
- Filesystem-only PATH validation — no shell-out during validation (DOC-5)
- `docs/garden-authoring.md` as a focused guide (DOC-2, DOC-3)
- `buildSimulationDot` updated to emit `tool_command=` not `script=` (DOC-3)
- Phase 3 regression suite + branch-failure parity

### From Claude Draft
- Detailed validation diagnostic strings (DOC-1, DOC-5, DOC-6) — exact warning text
- Comprehensive Definition of Done covering all 13 items individually
- Drop line ordering for scope management
- Security analysis: command injection in PATH validation, workspace-scoped assert_exists paths, truncated failure text
- `model` alias resolution order: `llm_model` > `llm.model` > `model`

### From Gemini Draft
- Clearer use-case descriptions (adopted for Use Cases section)
- `assert_exists` attribute name (matches user's original suggestion)
- Windows process-group risk acknowledgment

## Valid Critiques Accepted

| Critique | Source | Action |
|----------|--------|--------|
| `tools="none"`/`tools="all"` is scope creep | Codex critique | Removed. Diagnose root cause first. |
| `continue_on_failure` is scope creep | Codex critique | Removed. Failure-edge mechanism is sufficient. |
| `assert_files` rename is unnecessary friction | Codex + Gemini critiques | Use `assert_exists` per user feedback |
| Diamond+prompt LLM eval violates spec | Claude + Codex critiques | Reject as validation error |
| Zero-tool-call exits on success path | Codex critique | Change to failure when prompt expects work |
| Renderer doesn't display `notes` on failure | Codex + Claude critiques | Add renderer fix to BUG-2 scope |
| `assert_exists` doesn't check file freshness | Gemini critique | Noted but deferred — mtime checking adds complexity; simple existence is the MVP |
| Gemini draft's wrong file paths (validator.ts, etc.) | Claude critique | Corrected in final document |
| BUG-1 needs diagnosis, not assumptions | All three critiques | Changed to diagnostic-first approach |
| `script=` deprecation warning missing | Claude critique | Added to validation scope |

## Valid Critiques Rejected (with reasoning)

| Critique | Source | Reasoning |
|----------|--------|-----------|
| `assert_exists` should check mtime vs node start time | Gemini critique | Adds significant complexity for an edge case. If a file existed before, the user's workflow is already wrong. Simple existence check is the MVP. |
| Integration test with SimulationProvider won't prove BUG-1/BUG-2 | Codex critique | Partially valid, but the integration test still validates the plumbing. Targeted unit tests complement it, not replace it. |
| BUG-7 should support `preferred_label` and multi-way routing | Codex critique | Moot — BUG-7 is now a validation rejection, not an LLM evaluation. |

## Interview Refinements Applied

1. **BUG-7**: Reject diamond+prompt as validation error (unanimous recommendation, user confirmed)
2. **BUG-1**: Diagnose-first approach, no new `tools` attribute
3. **BUG-4**: Use `assert_exists` attribute name
4. **BUG-5**: Shared `exec-command.ts` helper
5. **BUG-2**: Zero-tool-call agent sessions become failure (not success)
6. **Scope**: One sprint with drop line
