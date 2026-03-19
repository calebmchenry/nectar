# Sprint 001 Critique: Claude vs. Codex

This document provides a critique of the two Sprint 001 drafts (`SPRINT-001-CLAUDE-DRAFT.md` and `SPRINT-001-CODEX-DRAFT.md`) against the Nectar project intent defined in `INTENT.md`.

---

## SPRINT-001-CLAUDE-DRAFT.md

### Strengths
- **Execution Engine Depth:** Provides a highly detailed and accurate breakdown of the 5-step deterministic edge selection algorithm as required by the attractor spec.
- **UI/Theme Focus:** Strongly aligns with the "pollinator" theme mandated by `INTENT.md`, detailing specific emoji, colors, and log messages.
- **Dependency Minimalism:** Recommends using Node.js built-in testing (`node:test`) to keep dependencies light.

### Weaknesses
- **Reinventing the Parser:** Proposes writing a custom lexer and recursive-descent parser from scratch for DOT files. This is a massive scope creep for Sprint 001 and highly error-prone when community libraries exist.
- **Broken Demo Acceptance:** The Definition of Done accepts that the main demo (`compliance-loop.dot`) will fail because the python script doesn't exist. This violates the goal of delivering a working, impressive MVP.

### Gaps in Risk Analysis
- Fails to identify the significant risk of writing and maintaining a custom DOT parser.
- Minimal discussion on the risks of race conditions or corruption during the cocoon serialization process, though it mentions atomic writes in the tasks.

### Missing Edge Cases
- Doesn't clearly define the recovery state if the CLI is killed *exactly* between writing a checkpoint and starting the next node (i.e., whether the engine safely resumes at the exact next step without re-executing).
- Overlooks context variable scope leakage between retries.

### Definition of Done Completeness
- Incomplete. Accepting a failing demo as "Done" is not sufficient for an MVP sprint designed to prove the core loop.

---

## SPRINT-001-CODEX-DRAFT.md

### Strengths
- **Pragmatic Parsing:** Recommends using `@ts-graphviz/parser` instead of writing a custom parser, which drastically reduces sprint risk and effort.
- **Working Fixtures:** Explicitly solves the broken demo problem by shipping a local `scripts/compliance_loop.mjs` fixture so the garden can execute end-to-end.
- **Upstream Pinning:** Includes a specific task to create `ATTRACTOR-PIN.md` to lock the upstream compliance target, directly satisfying a mandate from `INTENT.md`.

### Weaknesses
- **Edge Selection Vagueness:** The details around the 5-step edge selection algorithm are less fleshed out compared to the Claude draft.
- **Lighter UI Focus:** Doesn't provide as much detail on the terminal UI, spinners, and theming which are key to the "genuinely fun to use" requirement.

### Gaps in Risk Analysis
- Mentions the risk of the AST parser semantics, which is good, but misses the risk of implementing a custom condition expression evaluator (even a "tiny" one).
- Doesn't mention the risk of stdout/stderr logs growing too large for the cocoon or disk.

### Missing Edge Cases
- Doesn't address how to handle chained edges (e.g., `A -> B -> C`) thoroughly during the execution phase, only during parsing.
- Doesn't explicitly handle the fallback edge scenario in the event all conditional edges fail.

### Definition of Done Completeness
- Strong. Requires `compliance-loop.dot` to execute completely and successfully, proving the engine works.

---

## Recommendation for the Final Sprint

The final Sprint 001 plan should be a synthesis of the best ideas from both drafts:

1. **Use an AST Library (from Codex):** Do not write a custom lexer/parser. Use `@ts-graphviz/parser` to save time and reduce bugs.
2. **Ship a Working Fixture (from Codex):** Include the `scripts/compliance_loop.mjs` stub so `gardens/compliance-loop.dot` runs end-to-end successfully.
3. **Pin the Upstream Target (from Codex):** Create `docs/upstream/ATTRACTOR-PIN.md` as the first step.
4. **Implement Strict Edge Selection (from Claude):** Use Claude's detailed 5-step deterministic edge selection breakdown to ensure strict adherence to the attractor spec.
5. **Rich Themed UI (from Claude):** Adopt Claude's detailed UI/theme implementation (colors, spinners, bee puns) to satisfy the "fun to use" CLI requirement.
6. **Minimal Dependencies (from Claude):** Use `node:test` and `tsx` to avoid complex build steps in the first sprint.