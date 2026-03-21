# Critique of Draft Sprints

## 1. NEXT-CLAUDE-DRAFT.md (Full Condition Language, Agent Configurability & Spec Compliance Sweep)

### Strengths
- **Comprehensive Compliance Coverage:** Addresses six different gaps (GAP-1, 3, 5, 6, 7, 8), significantly advancing the spec compliance in one sweep.
- **Detailed Architecture:** The design for the Condition Expression Language AST, operator precedence, and parser is well-thought-out and concrete.
- **Backward Compatibility:** Explicitly guarantees and tests that existing `=`/`!=` conditions will continue to parse and evaluate identically.

### Weaknesses
- **Lack of Focus:** Combines core engine parsing updates with LLM client features, tool loop changes, and HTTP error handling. This risks a fragmented sprint where the team context-switches too much.
- **Naïve State Resolution:** Proposes assembling the `ConditionScope` (including all step histories and artifact content) on the fly during edge evaluation. This could be computationally expensive or lead to memory bloat for large pipelines.

### Gaps in Risk Analysis
- **Context/Memory Exhaustion:** Passing full artifact contents and node outputs into memory during every condition evaluation on large runs could cause memory issues.
- **LLM Loop Context:** The `generate()` loop mitigation relies on a hard iteration cap, but ignores the risk of context window exhaustion if tool outputs are large across 10 iterations.

### Missing Edge Cases
- **Missing Variables:** What is the behavior when `steps.<id>.output` is referenced, but the node failed or was skipped, so it has no output?
- **Syntax Inconsistencies:** The document examples use `artifacts.report EXISTS` (postfix) but the architecture defines `EXISTS` as a unary prefix operator. This ambiguity will cause implementation friction.

### Definition of Done Completeness
- Very complete for the features proposed. Includes specific unit, integration, and backward-compatibility tests.

---

## 2. NEXT-CODEX-DRAFT.md (Workflow Rules & Hive Run Control)

### Strengths
- **Strong Product Focus:** Prioritizes features and fixes that block real-world usage today (robust HTTP lifecycle, SSE fixes, and workflow conditions).
- **Robust State Persistence:** The proposal to add a bounded `step_results` index and `artifact_aliases` directly into the `Cocoon` checkpoint is a much safer, more deterministic approach than reading from the filesystem or memory on the fly.
- **Opinionated Constraints:** Setting clear rules like "last execution wins per node ID" removes ambiguity from the implementation.

### Weaknesses
- **Leaves Spec Gaps Open:** By focusing so heavily on the runtime, it leaves easy-to-close gaps (like glob sorting and replace_all) on the table.
- **Condition Grammar Detail:** The AST definition is less exhaustive than Claude's draft, lacking details on exact operator precedence and how types like strings/numbers are coerced.

### Gaps in Risk Analysis
- **Preview Truncation:** Relying on `output_preview` for condition matching introduces a risk. If the preview is bounded to 500 characters, but the LLM outputs "approved" at character 600, `CONTAINS "approved"` will fail incorrectly.
- **Checkpoint Migration:** It mentions that `step_results` will be optional for backward compatibility, but does not detail how the condition evaluator should handle legacy runs that lack this index when resuming.

### Missing Edge Cases
- **Cancel/Resume Races:** If a run is in the `cancelling` state (waiting for the engine to apply the abort), and a `resume` request arrives, how does the state machine resolve the conflict?
- **Alias Collisions:** What happens if a fan-in node and a codergen node attempt to register the same artifact alias?

### Definition of Done Completeness
- Excellent focus on fixing the failing test suite and verifying HTTP behaviors (SSE termination, replayability). 

---

## Recommendations for the Final Merged Sprint

1. **Adopt Codex's Strategic Focus:** The final sprint should prioritize the Condition Expression Language and the Hive HTTP Run Control fixes. The auto-tool loop (GAP-3) and other minor sweeps (GAP-5, 6, 7, 8) should be deferred to a subsequent "Agent Loop Polish" sprint. Stability and core routing are more important.
2. **Use Claude's Condition Grammar with Codex's State Model:** Implement the detailed recursive-descent parser and precedence rules from the Claude draft, but back it with the persisted `step_results` and `artifact_aliases` architecture from the Codex draft. This gives you a rigorous parser operating on safe, deterministic state.
3. **Address the Truncation Risk:** Explicitly define the bounding strategy for `output_preview`. If it must be truncated for checkpoint size, consider whether specific "signals" (like structured outputs or tool calls) should be preserved over raw text to ensure conditions remain reliable.
4. **Clarify Syntax:** Lock down whether `EXISTS` is a prefix (`EXISTS artifacts.report`) or postfix/property (`artifacts.report EXISTS`) operator before implementation begins. Prefix is easier to parse, postfix often feels more natural to users. Just pick one and document it.