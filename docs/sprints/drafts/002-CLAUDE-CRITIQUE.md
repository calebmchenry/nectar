# Sprint 002 Critique — Claude

> **Note:** The Codex draft (`NEXT-CODEX-DRAFT.md`) does not exist. This critique covers the two available drafts: **Gemini** and **Claude**.

---

## Gemini Draft: "The Swarm Awakens — Codergen & Goal Gates"

### Strengths

1. **Well-structured architecture section.** The module layout, key abstractions (`UnifiedLLMClient`, `CodergenHandler`, `GoalGate`), and file summary table give a clear implementation roadmap. Any engineer could pick this up and start coding.
2. **Full LLM client with all three providers.** Gemini's draft ambitiously covers OpenAI, Anthropic, and Gemini adapters in a single sprint. If delivered, this unlocks maximum flexibility for downstream pipelines.
3. **Concrete use cases.** Four explicit use cases ground the sprint in real user scenarios rather than abstract gap IDs.
4. **Risk table with mitigations.** The infinite-loop risk for goal gates and the API schema unification challenge are correctly identified. The `max_retries` mitigation for infinite loops is pragmatic.
5. **Direct `fetch` over vendor SDKs.** Keeping the LLM client lightweight by avoiding heavy SDK dependencies aligns with the project's file-system-first philosophy.
6. **Files summary table.** Explicit file-by-file action plan (create/modify) reduces ambiguity during execution.

### Weaknesses

1. **Overscoped LLM client.** Implementing three full provider adapters (OpenAI, Anthropic, Gemini) plus tool calling in one sprint is aggressive. The unified-llm-spec is 25KB+ and covers streaming, structured output, tool execution, retry logic, and provider-specific quirks. Even "MVP" across three providers is a multi-day effort that risks becoming the critical path bottleneck.
2. **No simulation/offline mode for codergen.** The draft assumes real API calls or mocked HTTP tests but doesn't define a simulation mode. This means you can't run the full pipeline without API keys, which hurts local development and CI.
3. **Ignores existing bugs.** Sprint 001 left known issues (parse test node count mismatch, engine test timeout). Gemini's draft doesn't address these, which means they'll compound.
4. **No mention of conditional or wait.human handlers.** GAP-02 and GAP-03 are high-priority gaps that would complete the core handler set. Omitting them means even simple branching DOT files won't work end-to-end.
5. **Validation rules entirely absent.** GAP-17 defines 8+ lint rules (start_no_incoming, exit_no_outgoing, reachability, etc.). None are mentioned. Validation is currently minimal and this is a cheap win.
6. **No transform pipeline.** Variable expansion (`$goal`) is mentioned inside codergen, but the spec calls for a proper AST transform pipeline (parse → transform → validate). Hardcoding `$goal` expansion inside the handler rather than as a transform creates tech debt.
7. **Phase ordering puts engine enhancements first.** GAP-22/23 changes are small and correct to do early, but goal gate enforcement (GAP-07) before the LLM client means you can't integration-test goal gates with real codergen nodes until Phase 3. Consider interleaving.

### Gaps in Risk Analysis

- **No risk for API key management.** Three providers = three environment variables. No discussion of what happens when keys are missing, invalid, or rate-limited mid-pipeline.
- **No risk for test infrastructure.** Mocked HTTP tests for three providers is a substantial test surface. No mention of how mocks will be structured or maintained.
- **No risk for CI costs.** If live integration tests are used, API calls in CI could be expensive and flaky. Not addressed.
- **No risk for checkpoint compatibility.** Adding new statuses (PARTIAL_SUCCESS, RETRY, SKIPPED) could break existing checkpoint deserialization. Not mentioned.

### Missing Edge Cases

- What happens if a `box` node has no `prompt` attribute?
- What if `$goal` is referenced but the graph has no `goal` attribute?
- What if `retry_target` points to a node that doesn't exist?
- What if multiple goal gates fail — which `retry_target` wins?
- What if the LLM returns an empty response?
- What if a provider's API changes its response shape (no versioned schema pinning discussed)?

### Definition of Done Completeness

The DoD has 8 items covering the major deliverables. However:
- No criterion for existing tests remaining green (regression).
- No criterion for validation rules or edge-case handling.
- "Full coverage of newly added modules" is vague — what's the coverage threshold?
- No criterion for documentation or compliance report update.
- No criterion for a working end-to-end demo pipeline.

---

## Claude Draft: "Complete Attractor Core Engine"

### Strengths

1. **Breadth of coverage.** Tackles codergen, conditional, wait.human, goal gates, validation rules, AST transforms, and run directory structure in one sprint. This would close a large number of gaps simultaneously.
2. **Simulation mode for codergen.** Explicitly defines "no backend = returns simulated response," which means pipelines can run end-to-end without API keys. This is excellent for testing, CI, and demos.
3. **Fixes existing bugs first.** Phase 1 starts with the parse test node count fix and engine test timeout — cleaning up Sprint 001 debt before adding new features.
4. **Proper transform pipeline.** Phase 4 defines "parse → transform → validate" with `$goal` expansion as an AST transform, not a handler-level hack. This is architecturally correct per the spec.
5. **Comprehensive validation rules.** 8+ rules including reachability (BFS from start), structural rules, and warning-level rules. This hardens the engine significantly.
6. **Interviewer interface design.** AutoApproveInterviewer and QueueInterviewer provide both a fast-path for CI and a testable abstraction for future human-in-the-loop features.
7. **Phase percentages.** Rough effort allocation (15/30/20/20/15) helps with progress tracking and expectation setting.

### Weaknesses

1. **No real LLM client.** The biggest gap: codergen in simulation mode is useful for testing but doesn't deliver the sprint's implied promise of "AI-powered pipelines." After Sprint 002, users still can't make actual LLM calls. This defers the project's core value proposition to Sprint 003+.
2. **Overscoped for a single sprint.** Five phases spanning handlers, engine changes, validation, transforms, and run directory is a lot. Each phase has meaningful complexity. Risk of delivering everything at 80% rather than fewer things at 100%.
3. **No architecture section.** Unlike the Gemini draft, there's no module layout, key abstractions, or file summary. This makes it harder to estimate effort and identify integration risks.
4. **No risk analysis at all.** No risks, likelihoods, impacts, or mitigations. This is a significant omission for a sprint this broad.
5. **No use cases.** No concrete user scenarios describing what a user can do after this sprint ships. This makes it harder to validate that the scope is correct.
6. **Vague DoD items.** "8+ new validation rules pass" — which 8? "Conditional nodes route based on edge conditions" — what conditions specifically? The DoD is a checklist but not a testable specification.
7. **Accelerator key parsing mentioned but unexplained.** Phase 2 includes "Accelerator key parsing from edge labels" with no context on what this is or why it's in scope.

### Gaps in Risk Analysis

Since the Claude draft has no risk section at all, all risks are gaps:
- No risk assessment for the breadth of scope vs. available time.
- No risk for simulation mode diverging from real LLM behavior once the client is built.
- No risk for the transform pipeline introducing regressions in existing parsing.
- No risk for the interviewer interface being designed without knowing real UI requirements.
- No risk for the validation rules being too strict or too lenient for real-world DOT files.

### Missing Edge Cases

- What does simulation mode actually return? A fixed string? Random text? Something based on the prompt?
- How does AutoApproveInterviewer choose when there are 0 outgoing edges?
- What happens if a conditional (diamond) node has no edges whose conditions match?
- How does the transform pipeline handle malformed `$goal` references?
- What if reachability BFS finds unreachable nodes — error or warning?

### Definition of Done Completeness

The DoD has 9 items but several are incomplete:
- No mention of compliance report update.
- No mention of a demo/sample pipeline exercising the new features.
- No performance or regression criteria.
- "npm run build && npm test passes" is good but could be more specific about new test counts.
- No mention of documentation for new handlers or validation rules.

---

## Recommendations for the Final Merged Sprint

### 1. Scope: Pick the Claude breadth with one Gemini deep-dive

The Claude draft's breadth (handlers, validation, transforms) is the right foundation, but defer some items and add the Gemini draft's LLM client — scoped to **one provider** (Anthropic, since the project already uses Claude heavily). This gives us:
- Real LLM calls in pipelines (the project's core value)
- Simulation mode as a fallback (testing/CI)
- The handler/validation/transform infrastructure to support it

### 2. Scope cuts for feasibility

**Include:**
- Bug fixes from Sprint 001 (Claude Phase 1)
- Extended outcome statuses: PARTIAL_SUCCESS, RETRY, SKIPPED (both drafts agree)
- `!=` operator (both drafts agree)
- Codergen handler with simulation mode AND single-provider LLM backend (merge both approaches)
- Goal gate enforcement + retry_target routing (both drafts agree)
- Conditional handler (Claude only — cheap win, unlocks branching)
- Core validation rules (Claude Phase 4 — at least structural rules)
- `$goal` expansion as AST transform (Claude approach — architecturally correct)
- Run directory structure (Claude Phase 5 — needed for codergen artifacts)

**Defer to Sprint 003:**
- Wait.human handler + Interviewer interface (complex, not needed until human-in-the-loop pipelines)
- Second and third LLM providers (add after first provider is solid)
- Full tool calling in LLM client (text-in/text-out is sufficient for MVP)
- Model stylesheets
- Parallel/fan-in handlers

### 3. Require a risk section

The final sprint must include a risk table. Key risks to address:
- LLM provider API reliability and key management
- Sprint scope vs. time (explicit time-boxing per phase)
- Checkpoint backward compatibility with new statuses
- Simulation mode fidelity relative to real LLM responses

### 4. Strengthen the Definition of Done

The merged DoD should be specific and testable:
- All existing tests pass (regression gate)
- `pollinator run` executes a DOT file with a `box` node making a real LLM call (with `ANTHROPIC_API_KEY` set)
- `pollinator run` executes the same file in simulation mode without API keys
- Goal gate enforcement blocks exit and reroutes (test fixture)
- Conditional (diamond) nodes route correctly (test fixture)
- `!=` operator works in edge conditions (unit test)
- Per-node artifacts (prompt.md, response.md, status.json) written to run directory
- 6+ new validation rules implemented with tests
- `$goal` expansion works via transform pipeline
- Compliance report updated with new gap closures
- Sample pipeline `gardens/plan-and-execute.dot` (or similar) exercises codergen + goal gates end-to-end

### 5. Add architecture and file summary

Follow the Gemini draft's format: module layout, key abstractions, and a file summary table. This is invaluable during execution.

### 6. Add use cases

Follow the Gemini draft's format: 3-4 concrete user scenarios that describe what a user can do after this sprint ships.
