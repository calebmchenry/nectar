# Claude Critique: NEXT Sprint Drafts

**Drafts reviewed:**
- **Codex Draft:** "Sprint 012: Subagent Delegation & Session Hardening"
- **Gemini Draft:** "Sprint NEXT: Subagents & Manager Loop"
- **Claude Draft:** "Sprint 012: Subagent Tools — Parallel Task Delegation for Codergen Nodes"

---

## Codex Draft Critique

### Strengths

1. **Session hardening first.** The strongest insight across all three drafts. Phase 1 explicitly finishes Sprint 011's unfinished wiring (profile-filtered tool exposure, live prompt composition, abort into shell, follow-up transcripts, `patch.txt` persistence) before touching subagents. This is the only draft that acknowledges the parent session has live bugs that would silently propagate into child sessions. The "finish the parent before multiplying children" principle is exactly right.

2. **Dynamic tool visibility per turn.** The table showing which tools are visible based on session type and state (e.g., `send_input`/`wait`/`close_agent` only when children exist) is a concrete, implementable design that prevents models from hallucinating tool calls they can't make. Neither other draft addresses this.

3. **Event lineage metadata.** Requiring `session_id`, `root_session_id`, `parent_session_id`, and `agent_depth` on every event is the right granularity for debugging nested execution. The explicit lifecycle events (`agent_subagent_spawned`, `agent_subagent_completed`, `agent_subagent_closed`) integrate naturally with the existing event model.

4. **Deterministic abort sequence.** The 7-step shutdown order (stream cancel -> tool abort -> child abort -> bounded cleanup -> flush -> emit -> CLOSED) is the most detailed cleanup spec across all drafts. The emphasis on "single-path" shutdown avoids the classic problem of multiple cleanup codepaths with different bugs.

5. **Cut-line is well-chosen.** Deferring only cosmetic parent-side summaries of child work while refusing to ship without clean abort, lineage metadata, and transcript persistence. This protects the invariants that matter.

### Weaknesses

1. **No concurrency limit on children.** The draft limits nesting depth to 1 but never limits how many concurrent children a parent can spawn. A model could spawn 20 children simultaneously. The Claude draft's `max_concurrent_children: 4` is a necessary guardrail.

2. **No per-child budget controls.** No `max_turns`, `max_tool_rounds`, or `timeout_ms` on child sessions. Children inherit parent limits, meaning a child could consume the parent's entire turn/tool budget. The Claude draft's differentiated child defaults (20 tool rounds, 5 turns, 5min timeout) are better.

3. **`max_subagent_depth=1` is too conservative.** The justification ("stop at one level") makes sense for a first sprint, but the architecture doesn't prepare for depth > 1. The Claude draft's depth-tracking design (each session carries a `depth` number) is more extensible even if the default is 1.

4. **Phase 1 scope risk.** Finishing Sprint 011's unfinished wiring is the right call, but at ~20% of the sprint, it's likely underestimated. Profile-filtered tool exposure, live prompt composition, and abort-into-shell are each non-trivial. If Phase 1 overruns, it compresses the actual subagent work.

5. **`send_input` state routing is underspecified.** The table says "route to `child.steer(message)` if PROCESSING, route to `child.followUp(message)` or `child.submit(message)` if IDLE/AWAITING_INPUT" — but doesn't resolve the ambiguity between `followUp()` and `submit()`. Which one? Under what conditions?

6. **No provider override on `spawn_agent`.** The use case section mentions spawning children "with different `model` overrides" but the tool schema isn't shown and there's no discussion of what happens when a child needs a different provider profile than the parent.

### Gaps in Risk Analysis

- **Cost explosion.** No mention of token cost risk from unbounded child sessions. Multiple children running full tool loops can multiply API costs rapidly.
- **Filesystem conflicts.** No discussion of what happens when parent and child edit the same file concurrently. The Claude draft at least acknowledges this.
- **Model confusion from dynamic tool changes.** The risk table mentions "dynamic tool visibility changes confuse the model" but the mitigation ("rebuild prompt + tool definitions every turn") is a restatement of the feature, not a mitigation. The real risk is that the model caches tool expectations from prior turns and hallucinates calls to tools that were visible before but aren't now.

### Missing Edge Cases

- Child completes with an error while parent is mid-tool-call (not waiting)
- `wait` called on a child that was already `close_agent`'d
- Parent's context window fills up from accumulating child results across many `wait` calls
- Child's `steer()` arrives between the child's last tool call and its response — does it get injected or dropped?

### Definition of Done Completeness

Strong and specific — 23 items covering build, tool behavior, event metadata, artifact persistence, and integration tests. The most thorough DoD across all three drafts. Minor gap: no DoD item for verifying that Phase 1's session-hardening fixes actually work independently of subagents.

---

## Gemini Draft Critique

### Strengths

1. **Broader scope targets multiple compliance gaps.** Closing C1, C3, L9, and A1 in a single sprint is ambitious but would move the compliance needle significantly. If achievable, this is the highest gap-count closure.

2. **`generate()` loop (L9) is a useful standalone feature.** Moving the tool execution loop into the LLM client layer is architecturally sound — it decouples the "call LLM, run tools, repeat" loop from the agent session, making it reusable for non-agent use cases. The `StepResult` tracking is a clean abstraction.

3. **Untruncated `TOOL_CALL_END` event (C3) is a quick win.** Small, well-scoped, and addresses a real compliance gap. Good candidate for inclusion regardless of which draft is chosen.

### Weaknesses

1. **Scope is too wide for a single sprint.** Four distinct features (subagent tools, `generate()` loop, manager loop handler, untruncated events) with different complexity profiles. The subagent tools alone are a full sprint (as the other two drafts recognize). Adding a manager loop handler and a high-level SDK method makes this a 2-3 sprint plan compressed into one.

2. **Subagent design is severely underspecified.** Compared to the other two drafts:
   - No depth-limiting design (just "must be enforced")
   - No concurrency limiting
   - No budget controls (max_turns, max_tool_rounds, timeout)
   - No event model for subagent lifecycle
   - No transcript/artifact layout for child sessions
   - No abort/cleanup semantics
   - No `working_dir` or workspace scoping
   - No dynamic tool visibility discussion
   - The `SubagentManager` is described in one paragraph

3. **Manager loop handler (A1) depends on subagents being solid.** The draft treats A1 as a parallel workstream, but the manager loop fundamentally depends on reliable subagent spawning, observation, and steering. Implementing both in the same sprint means A1 is built on unstable ground — any subagent design changes ripple into the manager handler.

4. **Default `max_depth: 3` without justification.** Allows parent -> child -> grandchild -> great-grandchild. Three levels of delegation is aggressive for a first implementation. No discussion of the debugging complexity or cost implications of deep nesting.

5. **`send_input` maps directly to `session.submit()`.** This conflates steering (injecting context mid-processing) with input submission (starting a new processing cycle). The Codex and Claude drafts correctly distinguish between `steer()` during PROCESSING and `followUp()`/`submit()` during AWAITING_INPUT.

6. **No session hardening.** The draft assumes Sprint 011's wiring is complete and correct. The Codex draft identified specific gaps (profile-filtered tools not used at runtime, environment context not injected, abort doesn't stop shell commands). If those issues exist, building subagents on top amplifies them.

7. **The `generate()` loop duplicates existing agent-loop functionality.** The agent session already implements the LLM-call -> tool-execution -> repeat loop. Adding another loop at the SDK level creates two competing orchestration layers. The draft doesn't discuss how they interact or when to use which.

### Gaps in Risk Analysis

- **No cost/budget risk.** No mention of token cost for child sessions, no per-child limits.
- **No filesystem conflict risk.** Manager loop runs a child pipeline — what if parent and child pipelines write to the same files?
- **No orphan process risk.** What happens if the parent crashes mid-execution? No cleanup strategy.
- **No model confusion risk.** Four new tools added to every session regardless of context — models may attempt subagent delegation for trivially simple tasks.
- **"Context bleed" mitigation is vague.** "Ensure clones are fully isolated" is a restatement of the requirement, not a mitigation. What specific isolation boundaries are enforced?

### Missing Edge Cases

- Manager loop handler: child pipeline has a `wait.human` node — who answers?
- Manager loop handler: child pipeline fails mid-run — does the manager retry, abort, or surface the failure?
- `generate()` loop: what happens when a tool call returns `is_error: true`? Does the loop continue or stop?
- `generate()` with subagent tools: the `wait` tool blocks — does `max_tool_rounds` count the waiting time or just the tool execution rounds?
- Subagent completes while parent is in a `generate()` tool round — event ordering?

### Definition of Done Completeness

Weak — only 7 items, mostly at the feature level ("subagent tools execute successfully"). Missing:
- No build/regression check (`npm run build` not mentioned)
- No specific behavioral assertions (depth limiting behavior, abort propagation, event metadata)
- No transcript/artifact verification
- No test count or coverage target
- "Can be updated to mark as IMPLEMENTED" is a documentation check, not a functional one

---

## Cross-Draft Comparison

| Dimension | Codex | Gemini | Claude |
|-----------|-------|--------|--------|
| **Focus** | Session hardening + subagents | Subagents + generate() + manager + events | Subagents only (deep) |
| **Scope risk** | Medium (Phase 1 underestimated) | High (4 features in 1 sprint) | Low (single feature, well-bounded) |
| **Subagent depth** | Excellent architecture, conservative limits | Underspecified | Thorough with good defaults |
| **Session hardening** | Explicit Phase 1 | Not addressed | Not addressed |
| **Budget controls** | Missing | Missing | Strong (per-child limits) |
| **Concurrency limits** | Missing | Missing | Present (max 4) |
| **Abort semantics** | Strongest (7-step sequence) | Mentioned but unspecified | Good (cascading, with cut-line) |
| **Event model** | Strong (lineage metadata) | Defined types but shallow | Strong (3 event types + bridging) |
| **Dynamic tool visibility** | Yes (per-turn rebuild) | No | No |
| **DoD quality** | 23 items, specific | 7 items, vague | 34 items, most thorough |
| **Risk analysis** | Good, missing cost/FS risks | Shallow, missing most risks | Most comprehensive |
| **Gaps closed** | C1 (HIGH) | C1, C3, L9, A1 | C1 (HIGH), A10 (LOW) |

---

## Recommendations for the Final Merged Sprint

### 1. Adopt the Codex Draft's "Harden First" Strategy

The Codex draft is the only one that identified live bugs in the Sprint 011 session wiring. These must be fixed before subagents ship. Incorporate Phase 1 from the Codex draft as the merged sprint's first phase. However, budget it at ~25-30% (not 20%) to account for its likely underestimation.

### 2. Use the Claude Draft's Subagent Design as the Foundation

The Claude draft has the most complete subagent design: depth tracking, concurrency limits, per-child budget controls, timeout enforcement, and the most detailed DoD. Use it as the baseline architecture.

### 3. Merge in the Codex Draft's Dynamic Tool Visibility

The per-turn tool rebuild (only showing `spawn_agent` when depth allows, only showing `send_input`/`wait`/`close_agent` when children exist) is a significant UX improvement that prevents wasted tool calls. This should be part of the merged sprint.

### 4. Include C3 (Untruncated Tool Output) from the Gemini Draft

This is a small, well-scoped compliance closure (a few hours of work) that can ride along without adding meaningful risk. Don't include L9 (`generate()`) or A1 (manager loop) — both are full sprints on their own and should not be packed in.

### 5. Set `max_subagent_depth` Default to 1, Not 3

The Codex draft's conservative depth=1 is right for a first implementation. The system should carry depth tracking (as in the Claude draft) so the default can be raised later, but shipping with depth=3 invites debugging nightmares in the first release.

### 6. Keep Concurrency at 4 and Add Budget Controls

From the Claude draft: `max_concurrent_children: 4`, `child_max_tool_rounds: 20`, `child_max_turns: 5`, `child_timeout_ms: 300000`. These prevent cost explosion and runaway children.

### 7. Add Missing Risk Items

The merged sprint should address:
- **Cost explosion:** Aggregate child token usage into parent usage reporting. Add a DoD item for this.
- **Filesystem conflicts:** Document (not enforce) that parents should scope children to non-overlapping directories via task instructions. No filesystem locking this sprint.
- **Context window pressure:** Child `wait` results should be bounded summaries, not full transcripts. Full output goes to artifacts only.

### 8. Cut-Line Should Be Abort Propagation Details, Not Abort Itself

Basic abort propagation (parent abort -> children abort) is non-negotiable. What can be deferred: cascading abort through grandchildren (irrelevant at depth=1 anyway), and per-child timeout enforcement (children can rely on their own `max_tool_rounds` for natural termination).

### 9. Exclude the Manager Loop Handler (A1)

A1 is a MEDIUM gap that depends on subagents being production-quality. Ship subagents first, validate them in real workflows, then build the manager loop in a subsequent sprint. The Gemini draft's inclusion of A1 is the biggest scope risk across all three drafts.

### 10. Exclude the `generate()` SDK Loop (L9)

L9 is useful but orthogonal to subagent tools. The agent session already provides a tool loop. Adding a second loop at the SDK layer in the same sprint as subagents creates two moving parts that interact in non-obvious ways. Defer to a dedicated SDK sprint.

---

## Final Verdict

**Best overall draft: Codex**, for its unique insight that the session must be hardened before subagents are layered on top. Its architecture (dynamic tool visibility, deterministic abort, event lineage) is the strongest foundation.

**Best subagent specification: Claude**, for its comprehensive budget controls, concurrency limits, and exhaustive DoD. The subagent manager design should be adopted wholesale.

**Gemini's contribution:** C3 (untruncated tool output) is a clean quick-win worth including. The `generate()` loop and manager handler are good features for future sprints but dangerous to pack into this one.

**The merged sprint should be: Codex Phase 1 (session hardening) + Claude Phases 1-4 (subagent implementation) + Codex's dynamic tool visibility + Gemini's C3 fix. Target gap closures: C1 (HIGH), C3 (MEDIUM), A10 (LOW).**
