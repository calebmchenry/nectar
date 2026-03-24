# Sprint 036 — Intent Document

## Seed Prompt

Address all issues from the pici project user feedback. A real user attempted to build a pipeline with nectar and documented 11 issues and suggestions. These have been categorized into 7 code bugs and 6 documentation/UX improvements. This sprint should fix all of them.

## Key Reference Files

- **Original user feedback:** `/Users/caleb.mchenry/code/ai-pici/.nectar/feedback.md` — raw feedback with 11 issues
- **Analyzed summary:** `/Users/caleb.mchenry/code/nectar/notes/pici-feedback-analysis.md` — categorized into BUG-1 through BUG-7 and DOC-1 through DOC-6

**ALL agents must read both files before drafting.**

## Orientation Summary

- **Nectar** is a local-first pipeline orchestration CLI (v0.1.3) that runs graph-shaped workflows from `.dot` files. Architecture: engine, handlers, agent-loop, LLM adapters, garden (DOT parser), server (SSE + HTTP).
- **Recent work** (Sprint 032–035): config system, tool repair, workspace routes, event aliases, LLM adapter hardening, and fixing 4 test regressions (fan-in status, SSE lifecycle, current_node tracking, pipeline_failed emission).
- **Test suite:** 142 test files via Vitest. Currently 4 failing tests targeted by Sprint 035. Convention: integration tests in `test/integration/`, unit tests mirror `src/` structure.
- **Key constraint:** Spec-first development (Attractor spec). Filesystem-first state (no DB). Pollination metaphor throughout.
- **Sprint 035 is the current active sprint** focused on green suite + compliance gaps. Sprint 036 should be planned as a follow-on.

## Relevant Codebase Areas

### For Code Bugs

| Bug | Key Files |
|-----|-----------|
| BUG-1: box+prompt agents have no tools | `src/handlers/codergen.ts`, `src/agent-loop/session.ts`, `src/agent-loop/tool-registry.ts` |
| BUG-2: Silent agent failures | `src/engine/engine.ts`, `src/handlers/codergen.ts`, `src/agent-loop/events.ts` |
| BUG-3: Fan-out after predecessor failure | `src/engine/engine.ts`, `src/engine/edge-selector.ts` |
| BUG-4: tool_command exit 0 with no artifacts | `src/handlers/tool.ts` |
| BUG-5: timeout not enforced on tool_command | `src/handlers/tool.ts`, `src/llm/timeouts.ts` |
| BUG-6: model attribute ignored | `src/handlers/codergen.ts`, `src/llm/catalog.ts`, `src/agent-loop/session.ts` |
| BUG-7: Diamond+prompt instant success | `src/handlers/conditional.ts`, `src/engine/engine.ts` |

### For Documentation / UX

| Item | Key Files |
|------|-----------|
| DOC-1: Misleading PROMPT_MISSING warning | Garden validation in `src/garden/` |
| DOC-2: Shell alias docs | `README.md`, docs |
| DOC-3: box vs parallelogram docs | `README.md`, docs, possibly shape auto-detection in garden parser |
| DOC-4: Resume --force discoverability | CLI resume command handler |
| DOC-5: Validate tool_command executables | `src/garden/` validation |
| DOC-6: Cross-platform tool_command linting | `src/garden/` validation |

## Constraints

1. **Spec alignment** — Changes must align with the Attractor spec. If the spec doesn't cover a behavior, propose an addendum.
2. **No breaking changes** — Existing valid `.dot` files must continue to work.
3. **Test coverage** — Every bug fix must have a corresponding test. Aim for green suite.
4. **Additive error evolution** — Don't rename or break existing error types/events.
5. **Process-group execution** — Tool command timeout enforcement must use SIGTERM → SIGKILL on the process group, not just the parent process.
6. **Sprint 035 dependency** — This sprint follows 035. Assume 035's 4 test fixes are merged.

## Success Criteria

1. All 7 code bugs are fixed with tests
2. All 6 doc/UX items are addressed (either via code improvements, better validation messages, or documentation)
3. Full test suite passes (142+ tests)
4. A user running the pici pipeline would not hit any of the 11 reported issues

## Verification Strategy

- Unit tests for each bug fix
- Integration test: a garden that exercises box+prompt, tool_command with timeout, diamond+prompt, fan-out after failure — verifying correct behavior for each
- Validation tests: ensure improved warnings for shape mismatches, missing executables
- Manual smoke test with a representative `.dot` file

## Uncertainty Assessment

| Factor | Level | Reasoning |
|--------|-------|-----------|
| Correctness | Medium | Most bugs have clear expected behavior, but BUG-1 (agent tools) and BUG-7 (diamond semantics) require design decisions about what the correct behavior should be |
| Scope | Medium | 13 items is substantial; some (like DOC-5 PATH validation, DOC-6 cross-platform linting) could expand in scope |
| Architecture | Low | Most fixes extend existing patterns — handler logic, validation rules, error surfacing. No new architectural patterns needed |

## Open Questions

1. **BUG-1 resolution approach:** Should box+prompt nodes get full file system tools, or should validation reject this configuration? The user worked around it with tool_command — is that the intended path?
2. **BUG-7 diamond semantics:** Should diamond nodes with `prompt` evaluate the prompt as a condition via LLM, or should they only support static condition expressions?
3. **BUG-4 post-conditions:** Should we implement a full `assert_exists` attribute, or just warn when a tool_command node produces no file system changes?
4. **DOC-3 shape auto-detection:** Should the garden parser auto-infer shape from attributes (has `tool_command` → parallelogram), or keep strict manual shape specification?
5. **Scope management:** Should we split this into two sprints (bugs first, docs second) or keep as one?
