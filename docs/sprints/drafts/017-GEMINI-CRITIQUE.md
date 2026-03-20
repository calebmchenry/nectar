# Sprint 017 Draft Critique

## Claude Draft Evaluation

### Strengths
- **Architectural Depth**: Provides exceptionally detailed class designs, event interfaces, and file-based payload schemas (e.g., `manager-steer.json`).
- **Clear Boundaries**: Explicitly justifies excluding `GAP-A4` and defines exact context carryover rules for restarts.
- **Actionable Task Breakdown**: Highly granular implementation phases with specific file-level mapping and detailed tasks.
- **Strong Use Cases**: Outlines a diverse and realistic set of scenarios, including attaching to existing runs and handling continuous monitoring loops.

### Weaknesses
- **Overly Prescriptive**: Might over-constrain the developer with exact TypeScript interfaces and class structures (e.g., forcing a specific `ChildRunController` shape) before implementation begins.
- **Heavy Event Surface**: Proposes several new event types that might overcomplicate the CLI renderer and event bus without clear immediate product value.

### Gaps in Risk Analysis
- Does not address what happens if the child engine hangs indefinitely or fails to respect `abortOwnedChild()`.
- Lacks discussion on shared resource contention (e.g., if parent and child share the same `child_workdir` or attempt to write to overlapping artifact paths).

### Missing Edge Cases
- What if a `loop_restart` target node is invalid or removed from the DOT file between restarts?
- How are tool hooks executed when the host OS has different shell semantics (e.g., Windows vs. Unix execution contexts)?

### Definition of Done Completeness
- Very strong and exhaustive. Covers all core features, backward compatibility, regression requirements, and specific test cases.

---

## Codex Draft Evaluation

### Strengths
- **Concise & Principle-Driven**: Excellent articulation of "Why this sprint, why now" and focuses heavily on high-level design principles.
- **Opinionated Constraints**: Defines a clear "Cut line" and explicit behavioral rules (e.g., "deterministic supervision, not a second hidden LLM loop").
- **Focused Scope**: Keeps the implementation focused on the highest-leverage gaps without getting bogged down in boilerplate definitions.

### Weaknesses
- **Lighter on Implementation Details**: The task lists and architectural specs are higher-level, leaving more ambiguity and potential for drift during implementation.
- **Steering Race Conditions**: Simplifies the steering control plane without fully detailing how read/write race conditions on `manager-steer.json` will be prevented natively.

### Gaps in Risk Analysis
- Misses the risk of child output interleaving or polluting the parent's CLI renderer if summary events aren't strictly isolated.
- Doesn't fully address the lifecycle edge cases of attached runs (e.g., what happens if the attached child run dies unexpectedly or is manually paused).

### Missing Edge Cases
- Handling manual pause/resume of a child pipeline independently from the manager.
- Behavior when the `manager.stop_condition` references a `stack.child.*` key that the child has not yet emitted or populated.

### Definition of Done Completeness
- Adequate but high-level. Covers the main functional requirements but lacks the specific unit/integration test rigor and backward compatibility checks seen in the Claude draft.

---

## Recommendations for Final Merged Sprint

1. **Blend Rigor with Principles**: Use Codex's high-level framing, design principles, and opinionated constraints, but adopt Claude's detailed payload schemas, task mappings, and explicit context filtering rules.
2. **Standardize the Steering Mechanism**: Mandate Claude's approach to atomic file operations (e.g., atomic temp-file renaming and deletion) for `manager-steer.json` to prevent read/write races, while maintaining Codex's rule that steering is strictly next-node only.
3. **Address Cross-Platform and Resource Risks**: Add explicit mitigations for cross-platform hook execution (ensuring `execa` behavior is robust) and isolation of child workdirs to prevent artifact collision.
4. **Refine Missing Edge Cases**: Include validation or runtime checks for invalid `loop_restart` targets and gracefully handle missing `stack.child.*` keys during `stop_condition` evaluation.
5. **Merge Definitions of Done**: Combine Codex's user-centric DoD statements with Claude's exhaustive testing, CLI verification, and regression checklist to form a bulletproof standard for the sprint.