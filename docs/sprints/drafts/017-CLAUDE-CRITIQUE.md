# Sprint 017 Draft Critique

**Reviewer:** Claude
**Date:** 2026-03-20
**Drafts Reviewed:** NEXT-CODEX-DRAFT.md, NEXT-GEMINI-DRAFT.md
**Reference:** NEXT-CLAUDE-DRAFT.md (own draft, for comparison)

---

## Codex Draft Critique

### Strengths

1. **Best-in-class architecture detail.** The Codex draft is the most architecturally complete of all three drafts. The typed graph surface additions (`GardenGraph`, `GardenNode`, `GardenEdge` extensions), the `ChildRunController` API, the steering file format, the manifest lineage fields, and the tool hook artifact layout are all specified at implementation-ready precision. A developer could begin coding Phase 2 from this document alone.

2. **Correct restart target semantics.** Codex gets a critical detail right: the successor run starts at the **edge target node**, not the graph start node. This matches spec §3.2 Step 7 and is the correct behavior for use cases like `review -> implement [loop_restart=true]`. The Gemini draft gets this wrong (see below).

3. **Thoughtful cut line.** The "ship A1+A2 first, cut Phase 4 before diluting manager-loop and restart correctness" cut line is the right priority ordering. Tool hooks are mechanically independent and can follow without blocking real pipeline functionality.

4. **Explicit validation rule inventory.** The validation section enumerates every new rule, its trigger condition, and its severity (error vs. warning). The `tool_hooks.*` on non-codergen nodes as warnings (not errors) and the `steer` requires `prompt` check are both correct and thoughtful.

5. **Strong risk table.** Five concrete risks with specific, testable mitigations. The "context bleed between parent, child, and successor runs" risk and its namespace-based mitigation is particularly well-identified — this is the kind of subtle bug that would otherwise surface late.

6. **Filesystem-first steering design.** The `control/manager-steer.json` single-file, at-most-once, file-based control plane is exactly right for a local tool. It survives crashes, is inspectable with `cat`, and cannot duplicate messages. The `(current_node, retry_count)` tuple key for deduplication is a clean design.

### Weaknesses

1. **No effort estimates or phase weighting.** Unlike the other drafts, Codex provides no indication of relative phase size. This makes it harder to assess whether the sprint is right-sized or to identify the cut point under time pressure. Even rough percentages (like the Gemini draft's ~20%/~25%/~35%/~20%) help with planning.

2. **Missing backward compatibility consideration.** The draft modifies `ManifestData`, `Cocoon`, and checkpoint structures but never discusses what happens when `nectar resume` encounters a cocoon written by the current (pre-sprint) codebase that lacks `restart_of`, `restarted_to`, or `parent_run_id` fields. All new fields should be optional with sensible defaults, and this should be explicitly called out and tested.

3. **`steer`-without-prompt is unspecified severity.** The validation section says "If `steer` is enabled, the manager node must have a non-empty `prompt`" but doesn't specify ERROR vs WARNING. Given that steer without a prompt is semantically meaningless (what would the steering note contain?), this should be an ERROR, not a warning.

4. **No discussion of child engine event isolation.** The draft says "emit summary supervisor events without forwarding the full child event tree" but doesn't specify how the child engine's event listeners are isolated from the parent's. If both engines share the same process, there's a real risk of event cross-talk. The architecture section should specify that the child `PipelineEngine` gets its own event emitter and only summary events are forwarded.

5. **Restart depth cap is not configurable.** The hard cap of 25 is reasonable as a default, but some legitimate pipelines (long-running data processing loops) might need more. Making it configurable via a graph attribute (`max_restart_depth`) would be cheap and avoids boxing users in.

### Gaps in Risk Analysis

- **No risk for steering note race conditions.** Parent writes `manager-steer.json` while child reads and deletes it. The draft specifies atomic consumption but doesn't mention atomic writes. Without temp-file-then-rename on both sides, there's a window for partial reads.
- **No risk for child DOT file not found or invalid.** If `stack.child_dotfile` points to a file that doesn't exist or fails validation, the error path isn't discussed. Should the manager node fail immediately? Should it set a context key?
- **No risk for SIGINT propagation.** Parent receives SIGINT — what happens to the in-process child engine? The `abortOwnedChild` method exists but the draft doesn't discuss signal handling mechanics.

### Missing Edge Cases

- What happens if `stack.child_autostart=false` and `context["stack.child.run_id"]` doesn't exist or points to a non-existent run?
- What happens if the child DOT file itself contains a `house` node? (Nested manager loops.) Is there a depth guard?
- What happens if a restart edge is the only outgoing edge from a node with no condition? (Unconditional restart — should validation warn?)
- What happens if `loop_restart=true` and `condition` are both set on the same edge but the condition doesn't match? (Should be fine — edge selection handles this — but worth a test.)

### Definition of Done Completeness

The DoD is strong with 13 items covering all three GAPs. Missing items:
- No backward compatibility criterion (old cocoons without new fields)
- No build/regression gate (`npm run build` succeeds, existing tests pass)
- No test count or coverage target

---

## Gemini Draft Critique

### Strengths

1. **Tight scope.** The Gemini draft makes a defensible decision to scope down to GAP-A1 and GAP-A2 only, deferring GAP-A3 (tool hooks) to a separate sprint. This reduces risk and increases the likelihood of shipping the two most important features cleanly. If the team is risk-averse, this is the safer scope.

2. **Phase weighting.** The ~20%/~25%/~35%/~20% breakdown gives clear signal about relative effort. Phase 3 (Manager Loop Handler at 35%) correctly identifies it as the heaviest lift.

3. **Clean module layout.** The architecture section is concise and correctly identifies the key integration points: `types.ts`, `parse.ts`, `engine.ts`, `manager-loop.ts`, `registry.ts`.

4. **Acknowledges infinite restart risk.** The risk table flags `loop_restart` infinite loops as high likelihood, which is accurate — this is the most likely production footgun in the sprint.

### Weaknesses

1. **Critical: Restart target is wrong.** The draft says `loop_restart` "jumps back to the start node" and "set the current node back to the start node." This directly contradicts spec §3.2 Step 7, which says the successor begins at the **edge target node**. A restart edge `review -> implement [loop_restart=true]` should start at `implement`, not at the graph's `Mdiamond` start node. This is a fundamental correctness issue that would cause wrong behavior for the primary restart use case.

2. **Underspecified restart semantics.** The draft says "resets the context (or explicitly carries over specific state if the spec dictates)" — this vagueness is dangerous. Context carryover on restart is one of the most error-prone parts of the feature. The Codex and Claude drafts both specify exactly which keys are stripped and which are preserved. The Gemini draft leaves this as an exercise for the implementor, which risks either carrying too much (stale state poisons the successor) or too little (user business context is lost).

3. **No lineage tracking.** The draft mentions "generates a new execution ID and cocoon directory" but has no specification for manifest lineage fields (`restart_of`, `restarted_to`, `restart_depth`). Without lineage, restart chains are opaque: `nectar status` can't show the chain, `nectar resume` can't find the latest successor, and debugging a failed restart chain requires manually correlating timestamps across cocoons.

4. **No CLI follow-through.** There's no mention of `nectar run` following restart chains, `nectar resume` finding the latest in a chain, or `nectar status` showing lineage. This means restarts would be engine-level only, with no user-visible support. The CLI just stops when the first run is marked interrupted.

5. **Shallow manager loop architecture.** The description of `ManagerLoopHandler` is high-level to the point of being ambiguous:
   - No specification of context key namespace (`stack.child.*`) for child telemetry
   - No steering mechanism described at all — just "intervene" and "steer" mentioned in passing
   - No `ChildRunController` abstraction or equivalent — the handler "instantiates a child `PipelineEngine`" directly
   - No discussion of how the child run's state is observed (polling checkpoint files? shared memory? event bus?)
   - No specification of manager node actions (`observe`, `steer`, `wait`) or how they compose

6. **No steering implementation.** The Gemini draft mentions `manager.actions` but provides no mechanism for how steering actually works. There's no control file, no steering note format, no consumption protocol. This is a significant omission — steering is one of the most novel and useful features of the manager loop, and it's the difference between a passive observer and an active supervisor.

7. **Missing validation rules.** Only one validation rule is specified (`house` nodes must have `stack.child_dotfile`). Missing: `manager.actions` values validation, `manager.max_cycles` must be positive, `manager.stop_condition` must parse, `steer` requires `prompt`, `tool_hooks.*` placement warnings.

8. **No event types specified.** The draft mentions a `run_restarting` event but doesn't specify any event types for manager loop supervision (child started, snapshot observed, steer note written). Without events, the CLI renderer can't display supervision progress.

### Gaps in Risk Analysis

- **No risk for context carryover on restart.** This is the highest-impact design decision in the restart feature and it's not mentioned.
- **No risk for backward compatibility.** Modifying manifest/cocoon structure without migration is a real concern.
- **No risk for steering note delivery.** (Steering isn't implemented, so this follows.)
- **No risk for child engine event isolation.** In-process child engines sharing listeners is flagged as "Low likelihood" — it should be Medium at minimum.
- **"Nested execution contexts clashing" risk** is identified but the mitigation ("scoping cocoons accurately") is too vague to be actionable.

### Missing Edge Cases

- Everything the Codex draft is missing (see above), plus:
- What happens when `manager.stop_condition` references keys that don't exist yet (child hasn't started)?
- What happens when `manager.poll_interval` is set to 0 or a very small value (tight spin loop)?
- What is the default `poll_interval` if not specified?
- What happens if the child pipeline itself has a `loop_restart` edge? (Restart chains inside child runs.)
- What happens if `loop_restart=true` fires but the restart depth cap is exceeded? (No cap specified at all.)

### Definition of Done Completeness

The DoD is the weakest of the three drafts:
- Only 6 items, all at a high level of abstraction
- No specification of what "correctly terminates" or "correctly spins up" means in testable terms
- No mention of child steering, context carryover, lineage tracking, CLI support, or events
- No backward compatibility criterion
- No test coverage targets or specific test scenarios
- `nectar validate` is mentioned but the validation rules it should catch are underspecified

---

## Comparative Summary

| Dimension | Codex | Gemini | Claude |
|-----------|-------|--------|--------|
| **Scope** | A1+A2+A3 | A1+A2 only | A1+A2+A3 |
| **Architecture depth** | Excellent | Shallow | Strong |
| **Restart correctness** | Correct (edge target) | Wrong (start node) | Correct (edge target) |
| **Context carryover** | Fully specified | Unspecified | Fully specified |
| **Lineage tracking** | Complete | Missing | Complete |
| **Steering mechanism** | File-based, at-most-once | Not designed | File-based, at-most-once |
| **CLI follow-through** | Full | Missing | Full |
| **Validation rules** | Comprehensive | Minimal | Comprehensive |
| **Event types** | Listed, not typed | One mentioned | Fully typed |
| **Risk analysis** | Strong (5 risks) | Moderate (4 risks) | Strong (8 risks) |
| **DoD** | 13 items, detailed | 6 items, high-level | 30+ items, categorized |
| **Cut line** | Explicit (A3 cuttable) | Implicit (A3 already cut) | Explicit (A3 cuttable) |
| **Backward compat** | Not discussed | Not discussed | Covered |
| **Phase weighting** | Missing | Present | Present |

---

## Recommendations for Final Merged Sprint

### 1. Use the Claude draft as the structural backbone.
The Claude draft has the most complete DoD (categorized by feature area with ~30 testable items), fully typed event definitions, the most thorough risk table (8 entries), and an explicit gap closure summary. Use it as the starting framework.

### 2. Pull Codex's architecture detail into the Claude draft's architecture section.
The Codex draft's `ChildRunController` API (with explicit `start()`, `attach()`, `readSnapshot()`, `writeSteerNote()`, `abortOwnedChild()` signatures), the steering file JSON format, the hook artifact layout, and the manifest lineage `ManifestData` interface are all more precisely specified than the Claude draft. Merge them in.

### 3. Adopt the three-GAP scope (A1+A2+A3).
The Gemini draft's conservative A1+A2-only scope is defensible but unnecessary. Tool hooks (A3) are mechanically independent (~20% of effort), self-contained in `AgentSession`, and already well-designed in both the Codex and Claude drafts. The cut line already exists: if time compresses, drop Phase 4. Don't pre-cut it.

### 4. Fix the restart target semantics.
This is non-negotiable. The successor starts at the **edge target node**, per spec §3.2 Step 7. Any language about "jumping back to the start node" must be corrected.

### 5. Add the Codex draft's missing items to the DoD.
- Backward compatibility: old cocoons without lineage fields resume cleanly
- Build gate: `npm run build` succeeds with zero errors
- Regression gate: `npm test` passes all existing tests
- Test count target (the Claude draft's "at least 45 new test cases" is reasonable)

### 6. Make restart depth configurable.
Default 25, overridable via graph attribute `max_restart_depth`. This is cheap and avoids boxing users into an arbitrary limit for legitimate long-running loops.

### 7. Specify atomic write mechanics for steering.
Both the write (parent) and the consume-and-delete (child) should use temp-file-then-rename to avoid partial-read races. Call this out explicitly in the architecture section.

### 8. Add missing edge cases to the test plan.
- `stack.child_autostart=false` with missing or invalid `stack.child.run_id` in context
- Nested manager loops (child DOT contains a `house` node) — either guard with a depth limit or document as unsupported in this sprint
- Unconditional restart edge (no condition) — validation should warn
- `manager.poll_interval` of 0 or very small values — enforce a minimum (e.g., 1s)
- `manager.stop_condition` referencing keys that don't exist yet — should evaluate as false, not throw

### 9. Include phase weighting from the Gemini draft.
The ~15%/~20%/~35%/~20%/~10% breakdown from the Claude draft is already present; ensure it's preserved in the merge. This helps with progress tracking and cut-point decisions.

### 10. Drop the Gemini draft's "restart to start node" language entirely.
This is a correctness error that must not propagate into the final sprint. The spec is clear: restart goes to the edge target.
