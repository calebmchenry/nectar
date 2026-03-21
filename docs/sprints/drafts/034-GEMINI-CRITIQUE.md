# Sprint 034 Draft Critique

## 1. NEXT-CLAUDE-DRAFT.md (Compliance Zero)

### Strengths
- **Laser Focus:** Directly targets the `INTENT.md` §5.1 hard gate (zero compliance gaps) and the red CI suite.
- **Actionable Test Fixes:** Provides precise, well-researched theories and fix strategies for all 4 currently failing tests.
- **Clear Categorization:** Effectively breaks down the 22 compliance gaps by effort (Trivial, Small, Medium, Large), making scope management easier.
- **Excellent Drop Line:** A clearly defined drop line ensures that the most critical work (CI green) is prioritized over "nice-to-have" compliance items like system prompt parity.

### Weaknesses
- **Scope Risk:** Attempting to fix 4 tests and close 22 compliance gaps in a single sprint is highly ambitious and prone to spillover.
- **Ignores Product Usability:** Defers fixing the ambient provider selection issue, leaving the Hive non-deterministic and relying on whichever environment variables happen to be present.
- **Rigid Goal vs. Reality:** The goal is "Compliance Zero", but the drop line admits that some gaps might be deferred. If deferred, the hard gate is not met, potentially violating the sprint's stated objective.

### Gaps in Risk Analysis
- Does not account for the risk that the test failures (e.g., `gardens-draft` stream stalling) might uncover deeper architectural flaws that cannot be fixed with a simple patch.
- Overlooks the potential impact of changing the event stream (`PROVIDER_EVENT` or PascalCase aliases) on downstream consumers (CLI, Hive UI) beyond just "noise".

### Missing Edge Cases
- What happens if the newly added `path` parameter for `glob` or `glob_filter` for `grep` conflicts with existing shell aliases or complex nested queries?
- If `GenerateRequest.max_retries` (U12) overrides global config, how does it interact with the unified client's overall timeout budget (U11 `per_step_ms`)?

### Definition of Done Completeness
- Very strong and specific. 
- Missing validation that no *new* compliance gaps or test regressions were introduced across different operating systems or environments.

---

## 2. NEXT-CODEX-DRAFT.md (Workspace Config & Determinism)

### Strengths
- **Solves Real Product Pain:** Directly addresses the non-deterministic nature of the Hive and the CLI by introducing explicit workspace configuration (`.nectar/config.yaml`, `.nectar/models.css`).
- **Strong Conceptual Model:** "Credentials from Env, Behavior from Workspace" is a solid architectural principle that will make the product predictable.
- **Targeted Run-State Fixes:** Addresses the `current_node` and `pipeline_failed` regressions effectively, ensuring the Hive reflects actual engine state.

### Weaknesses
- **Ignores the Hard Gate:** Explicitly leaves most compliance gaps out of scope, meaning the project remains non-compliant with the core specs (`INTENT.md` §5.1).
- **Incomplete Test Resolution:** Only addresses 2 of the 4 failing tests. Even if this sprint is completed flawlessly, `npm test` will likely still fail due to the unaddressed `gardens-draft` and `fan-in-llm` timeouts.

### Gaps in Risk Analysis
- The mitigation for existing users losing their ambient draft behavior is just "make the change explicit in sprint notes." This risks breaking existing local workflows without a smooth migration path or prominent CLI warning.
- If `.nectar/models.css` has a syntax error, failing pipeline preparation might degrade the Hive experience. The risk analysis doesn't cover how this failure is surfaced to the user in the UI.

### Missing Edge Cases
- If a draft request specifies a provider via the Hive UI that is *not* enabled in `config.yaml`, does it fall back to simulation, error out, or hang?
- How does the system behave if `.nectar/config.yaml` is a directory instead of a file, or if it lacks read permissions?

### Definition of Done Completeness
- Good coverage of the new config features and run-state fixes.
- **Critical Omission:** Does not explicitly mandate fixing the remaining 2 test failures, making the "npm test passes with zero failures" DoD item unlikely to be achieved without undocumented scope creep.

---

## 3. Recommendations for the Final Merged Sprint

The final Sprint 034 should synthesize the CI rigor of the Claude draft with the product determinism of the Codex draft. The compliance hard gate must be balanced with making the product usable.

**Recommended Goal:** Achieve a Green CI, establish deterministic AI defaults via workspace config, and close all high/medium-impact compliance gaps.

**Recommended Scope & Phases:**
1. **Phase 1: The Hard Gate (Non-Negotiable)**
   - Fix *all 4* failing tests (`http-server`, `gardens-draft`, `pipeline-events`, `fan-in-llm`) using the strategies outlined in the Claude draft. Combine the run-state truth fixes (from Codex) directly into this phase.
2. **Phase 2: Deterministic AI Defaults**
   - Implement `.nectar/config.yaml` and `.nectar/models.css` to eliminate ambient provider drift (from the Codex draft).
   - Expose `GET /workspace/config` to power the Hive.
3. **Phase 3: High-Value Compliance Gaps (Overlapping)**
   - Implement the model catalog refresh (U3) and capability flags (C4, C5) as they are required to properly validate workspace config choices.
   - Implement the adapter lifecycle methods (U1, U2).
4. **Phase 4: Trivial Compliance Gaps**
   - Batch close the Category A and small Category B gaps (A2, A4, A6, U4-U10, etc.) from the Claude draft.

**Drop Line:**
- If time runs short, explicitly **defer** C12 (System prompt parity) and C3 (Gemini web tools). These are large, isolated tasks that do not block product usability or structural compliance.

**Key Architectural Decision:** 
Adopt the "Credentials from Env, Behavior from Workspace" principle. However, to mitigate the risk of breaking existing user workflows, Nectar should log a clear warning to standard error if it detects API keys in the environment but no `config.yaml` is present, advising the user of the new simulation-by-default behavior.
