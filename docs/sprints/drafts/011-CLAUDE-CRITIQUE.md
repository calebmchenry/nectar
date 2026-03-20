# Sprint 011 — Claude Critique

**Drafts reviewed:** NEXT-CODEX-DRAFT.md (Codergen Control Plane & OpenAI Patch Parity), NEXT-GEMINI-DRAFT.md (Advanced Agent Capabilities)

---

## Codex Draft: Codergen Control Plane & OpenAI Patch Parity

### Strengths

1. **Exceptionally well-reasoned scoping.** The argument for deferring C5 (subagents) is airtight: you cannot safely manage child sessions if the parent session lacks lifecycle state, steering, or clean follow-up semantics. The draft explicitly sequences "state before delegation" and justifies it with concrete dependency reasoning, not just complexity avoidance.

2. **Provider-specific tool exposure is treated as a first-class design decision.** The opinionated constraint — OpenAI gets `apply_patch`, Anthropic/Gemini keep `edit_file`, no forced unification — is stated as a principle, not an afterthought. The draft explains *why* this is correct (each provider's model is trained on different editing primitives) rather than treating it as a temporary hack.

3. **The session state machine is rigorously specified.** States, transitions, legal/illegal actions per state, and the injection point for steering messages are all defined precisely. The deterministic turn-boundary delivery for `steer()` eliminates an entire class of race conditions by design rather than mitigation.

4. **Full artifact model is production-grade.** The `tool-calls/NNN-apply_patch/` directory structure with `request.json`, `patch.txt`, `result.json`, and `full-result.txt` gives debuggability that most agent frameworks lack. The dual-track model (bounded preview for the model, full output in artifacts) is the correct tradeoff between context efficiency and observability.

5. **The gap sweep is high-leverage.** Closing 12 gaps (2 HIGH + 5 MEDIUM + 3 LOW) in one sprint by recognizing that C6, C7, C8, C10, C11, C13, C14, and L1 fall naturally out of the same work is excellent prioritization. Each of these individually would be too small for a sprint but too easy to forget.

6. **Patch application pipeline is transactional.** Stage all mutations in memory, validate every hunk, then commit — or fail atomically. This is the only correct approach for a tool that modifies multiple files. The explicit non-goals (no fuzzy patching, no partial success, no binary support) prevent scope creep in the parser.

7. **Risk table is honest and actionable.** Eight risks with concrete mitigations, not vague acknowledgments. The "persistent session state regresses today's one-shot behavior" risk correctly identifies the compatibility wrapper as the mitigation and calls for regression coverage.

### Weaknesses

1. **No cut-line.** The draft lists 5 phases but doesn't identify what can be dropped if the sprint runs long. Which is more important — truncation/events (Phase 4) or the patch tool (Phase 3)? If you can only ship 3 of 5 phases, which 3? The Claude draft (NEXT-CLAUDE-DRAFT.md) explicitly states "defer Phase 4 truncation/events work" as the cut-line — this draft should too.

2. **`abort()` semantics are underspecified.** The API surface includes `abort(): void` but the state machine only mentions `abort/fatal error --> CLOSED` in a one-line transition. What happens to an in-flight tool call when `abort()` is called? Does it send SIGTERM to a running shell? Does it wait for the current stream response? Does it resolve the pending `SessionResult` promise with an error or reject it? These questions matter for the subagent sprint that builds on this.

3. **`developer` role folding for Anthropic is described but not fully designed.** "Fold into the system block in-order" — but what does "in-order" mean when there are multiple steering messages interleaved with tool results? Anthropic's system prompt is a single array sent once at the top of the request. If steering messages need to be position-sensitive relative to conversation turns, folding them into the system block may lose that positioning. The draft should address whether this is acceptable or propose an alternative (e.g., appending as the last system block entry on each request).

4. **No consideration of conversation history growth.** Persistent conversation state is the core of follow-up semantics, but the draft never addresses what happens when the conversation grows too large for the model's context window. After 5 follow-ups with heavy tool usage, the message array could exceed context limits. Is there a truncation strategy? A sliding window? This is deferred implicitly but should be called out explicitly as a known limitation.

5. **`steer()` is only valid during `PROCESSING`.** This means you cannot pre-queue a steering message before the session starts processing. If a caller wants to set constraints before the first model call (e.g., "only modify files in src/"), they must wait for the session to enter `PROCESSING` state. This is a minor UX gap but could matter for programmatic callers.

6. **Phase allocation percentages don't sum to 100%.** Phase 1 (25%) + Phase 2 (20%) + Phase 3 (30%) + Phase 4 (15%) + Phase 5 (10%) = 100%. This is fine — but the effort distribution gives 30% to `apply_patch` which may be optimistic. A v4a parser with transactional application, path traversal prevention, and golden tests for every operation is substantial. If this is truly 30% of a sprint, the total sprint is large.

### Gaps in Risk Analysis

- **No risk for model behavioral changes with `developer` role.** Injecting `developer`-role messages changes model behavior in provider-specific ways. OpenAI's `developer` role has specific compliance implications (models may treat it as authoritative). What if a steering message inadvertently overrides safety guardrails or changes the model's tool-calling behavior?
- **No risk for patch parser divergence from the actual v4a spec.** If OpenAI updates their patch grammar (they've iterated on it), a Nectar-side parser built on today's grammar may silently produce wrong results on future model output. Who owns the source of truth for the grammar, and how does Nectar stay in sync?
- **No risk for `followUp()` creating unbounded work chains.** If a caller programmatically queues follow-ups in response to results, you get an infinite loop. There should be a configurable depth or count limit.

### Missing Edge Cases

- What happens if `steer()` is called multiple times between model turns? Are all messages injected in order, or only the latest?
- What if a `followUp()` is queued while the session is transitioning from `PROCESSING` to `AWAITING_INPUT`? Is there a race between the state transition and the queue check?
- What if the v4a patch contains Windows-style line endings (`\r\n`) but the target file uses Unix endings? Or vice versa?
- What if `apply_patch` tries to add a file that already exists? The draft says "Add File" but doesn't specify behavior on conflict.
- What if the git snapshot commands hang (e.g., git over SSH with a broken key agent)? The 2s timeout mitigates but the draft doesn't specify whether all git commands share one 2s budget or each gets 2s independently.

### Definition of Done Completeness

Strong — 20 items covering every major feature. Missing:

- No DoD item for `abort()` behavior (in-flight tool cleanup, promise resolution)
- No DoD item for `followUp()` count/depth limits
- No DoD item for conversation history bounds or context window behavior after many follow-ups
- No DoD item for `steer()` ordering when multiple steers are queued

---

## Gemini Draft: Advanced Agent Capabilities

### Strengths

1. **Boldness.** Including C5 (subagents) in the same sprint as the session state machine and `apply_patch` is ambitious. If it could be pulled off, it would close all three HIGH-severity gaps in one sprint and dramatically accelerate the project.

2. **Use cases are user-centered.** The mid-task steering and follow-up queuing use cases are concise and grounded in real workflows. The subagent delegation use case (implement a feature + write tests in parallel) is compelling and illustrates why subagents matter.

3. **Honest about patch brittleness.** The risk table rates patch application flakiness as High/High — more honest than most drafts. The suggestion of fuzzy fallback shows awareness of real-world model behavior.

### Weaknesses

1. **Critically underscoped for the ambition.** Three major subsystems (session state machine, apply_patch, subagent orchestration) in one sprint is almost certainly too much. The draft is ~120 lines total. Compare to the Codex draft at ~570 lines which covers only two of these three and still needs 5 phases. The Gemini draft allocates a single phase with 6 bullet points to the entire subagent system — a feature that realistically deserves its own sprint.

2. **Subagent design is a sketch, not a specification.** "A new `SubagentManager` (or extensions to `ExecutionEnvironment`)" — the "or" is a red flag. The draft hasn't decided on the architecture. Key questions are unanswered:
   - How does a child session inherit (or not) the parent's conversation context?
   - How are tool permissions scoped for subagents?
   - What happens when a subagent calls `spawn_agent` itself? (The depth limit is mentioned but the recursion semantics are not.)
   - How are subagent failures surfaced to the parent?
   - What is the budget/token accounting model?
   - How does `wait_agent` interact with the parent session's own `PROCESSING` state? Does the parent block?

3. **Steering messages are injected "as user interruptions."** This is wrong. Steering messages should be `developer`-role messages, not user text. Injecting them as user messages confuses the model about who is speaking and can cause the model to treat steering as task input rather than control directives. The Codex draft correctly identifies `developer` role as necessary plumbing for steering. The Gemini draft doesn't mention `developer` role at all.

4. **No `developer` role support.** The draft adds steering but provides no mechanism to distinguish steering messages from user prompts at the provider level. This is a significant architectural gap that will produce incorrect model behavior.

5. **Follow-up triggers on transition to `IDLE`.** The Codex/Claude drafts use `AWAITING_INPUT` as the state where follow-ups are consumed. The Gemini draft uses `IDLE`, which is semantically the pre-first-submission state. This suggests the state machine hasn't been thought through — `IDLE` should mean "never started," not "finished and waiting."

6. **`apply_patch` description is thin.** "Locate the exact text block, verify the context, and apply the replacement" describes single-hunk, single-file behavior. No mention of multi-file patches, Add/Delete/Move operations, transactional atomicity, path traversal prevention, or artifact persistence. The v4a format supports all of these and the tool must handle them.

7. **Fuzzy matching fallback is dangerous.** The risk mitigation suggests "fallback to slightly fuzzier context matching if an exact match fails." This is the wrong approach. Fuzzy matching hides bugs and produces wrong edits. If the model provides wrong context lines, the correct response is a descriptive error so the model can self-correct. Both other drafts explicitly reject fuzzy matching for this reason.

8. **No truncation, events, prompt context, or timeout work.** The draft ignores C6, C7, C8, C10, C11, C13, C14, and L1 — all of which the other drafts identify as cheap wins that fall naturally out of the session state machine and prompt composition work. This is 8 gaps left on the table unnecessarily.

9. **Files summary lists 12 files but several are speculative.** Four separate tool files for subagent operations (`spawn-agent.ts`, `send-input.ts`, `wait-agent.ts`, `close-agent.ts`) — this one-file-per-tool pattern inflates the file count without clarifying the architecture. A single `subagent-tools.ts` with four exported handlers would be more appropriate for tools that share a `SubagentManager` dependency.

10. **No existing test regression gate.** The DoD says ">90% test coverage" for new components but has no item for `npm test` passing, `npm run build` succeeding, or existing tests remaining green.

### Gaps in Risk Analysis

- **No risk for subagent token/cost explosion.** A parent spawning 3 subagents, each running 10 tool turns, could easily consume 10x the tokens of a single agent session. No budget controls, cost tracking, or hard limits are specified.
- **No risk for subagent deadlock.** If a parent calls `wait_agent` on a child that is itself calling `wait_agent` on the parent (or a sibling that depends on the parent), you get deadlock. Depth limits don't prevent this.
- **No risk for conversation state growth.** Persistent follow-up queues accumulate unbounded conversation history.
- **No risk for `apply_patch` grammar drift.** If OpenAI updates the v4a format, Nectar's parser may break silently.
- **Steering race conditions are acknowledged but the mitigation ("atomic queueing and clear sequence points") is vague.** The Codex draft's "deterministic turn boundary" approach is much more concrete.

### Missing Edge Cases

- What if a subagent outlives its parent session? (Parent closes while child is still `PROCESSING`.)
- What if `send_input` is called on a subagent that is already `CLOSED`?
- What if `wait_agent` times out? Is there a timeout parameter?
- What happens to subagent artifacts? Are they nested under the parent's run directory?
- What if the user's API key has rate limits that are exhausted by concurrent subagent + parent sessions?
- What if `steer()` is called while no work is active? The draft says "during the PROCESSING state" but doesn't specify what happens otherwise (silent drop? error?).

### Definition of Done Completeness

Significantly incomplete:

- No build/regression gates (`npm run build`, `npm test`)
- No DoD item for `developer` role (because it's not mentioned at all)
- No DoD item for prompt context (environment, git snapshot)
- No DoD item for truncation
- No DoD item for event metadata
- No DoD item for timeout/kill delay alignment
- No DoD item for conversation persistence across follow-ups
- No DoD item for `apply_patch` atomicity or path traversal prevention
- No DoD item for subagent artifact handling
- No DoD item for subagent budget/token limits
- ">90% test coverage" is aspirational, not verifiable as a binary DoD gate

---

## Comparison and Synthesis

### The Core Strategic Question: Include Subagents or Not?

| | Codex (Control Plane Only) | Gemini (Control Plane + Subagents) |
|---|---|---|
| HIGH gaps closed | 2 of 3 (C1, C4) | 3 of 3 (C1, C4, C5) |
| Total gaps closed | 12 | 3 |
| Specification depth | Deep — implementable without ambiguity | Shallow — subagents need a full design sprint |
| Risk profile | Medium — well-understood work on existing surfaces | High — subagents are a complex orchestration feature with underspecified semantics |
| Realistic sprint fit | Yes — 5 phases with clear deliverables | No — subagents alone are a sprint-sized feature |
| Foundation for next sprint | Excellent — Sprint 012 builds subagents on stable state machine | Fragile — subagents built on a state machine that was designed in the same sprint |

The Codex draft is correct that subagents without a stable session control plane are "opaque background workers that are harder to debug and harder to control." The Gemini draft's ambition is admirable but the specification depth doesn't support the complexity of what's being proposed.

### What the Gemini Draft Gets Right

- The *vision* of closing all three HIGH gaps in one sprint is strategically appealing.
- The subagent use case (parallel implementation + testing) is well-motivated and should inform Sprint 012's design.
- Acknowledging patch flakiness as HIGH/HIGH risk is honest.

### What the Codex Draft Gets Right That Gemini Doesn't

- Scope discipline. Doing two things deeply is better than three things shallowly.
- The 8-gap sweep (C6, C7, C8, C10, C11, C13, C14, L1) is free incremental value.
- `developer` role as a prerequisite for correct steering semantics.
- Transactional patch application with explicit non-goals.
- Artifact model and event expansion for observability.
- Risk analysis with concrete mitigations.

---

## Recommendations for the Final Merged Sprint

### 1. **Use the Codex draft as the primary structure. Defer subagents to Sprint 012.**

The Codex draft's scope (session state machine + apply_patch + gap sweep) is the right amount of work. Subagents depend on the control plane being stable. Building both simultaneously means the control plane is tested under subagent load before it's been tested in isolation — this is how subtle bugs ship.

### 2. **Add an explicit cut-line.**

If the sprint runs long, Phase 4 (truncation/events/runtime hardening) can be deferred. The control plane (Phase 1) and apply_patch (Phase 3) are the must-ship deliverables. Phase 2 (developer role + prompt context) is tightly coupled to Phase 1 and should ship together.

### 3. **Specify `abort()` fully.**

The final sprint must define: what happens to in-flight tool calls, how promises resolve/reject, and whether abort is synchronous or returns a promise. This is load-bearing for Sprint 012's subagent lifecycle management.

### 4. **Address conversation history growth as a known limitation.**

Add a section noting that conversation history can grow unbounded across follow-ups. Either add a configurable message count limit, or explicitly defer context management to Sprint 012 with a note in the risks table.

### 5. **Reject fuzzy patch matching explicitly.**

The Gemini draft's suggestion of fuzzy fallback should be explicitly rejected in the final sprint. Strict parsing with descriptive errors is the correct approach. Add this as a design principle.

### 6. **Clarify `developer` role folding for Anthropic.**

Anthropic's system prompt is sent once per request. If multiple steering messages arrive during a processing cycle, define whether they are appended to the system array on the next request or accumulated differently. The adapter tests should assert exact payload shape for multi-steer scenarios.

### 7. **Add follow-up count limit.**

A configurable `max_follow_ups` (default 10 or similar) prevents unbounded work chains from programmatic callers. This is cheap to implement and prevents a real failure mode.

### 8. **Steal the Gemini draft's subagent use cases for Sprint 012 planning.**

The parallel implementation + testing use case and the `SubagentManager` concept are good starting points. Require Sprint 012's design to address: budget controls, deadlock prevention, artifact nesting, and failure surfacing — all gaps identified in the Gemini draft's design.

### 9. **Add build/regression gates to the DoD.**

Both drafts should include (and the Codex draft does):
- `npm run build` succeeds with zero errors
- `npm test` passes all existing tests — zero regressions
- Existing `processInput()` callers work unchanged

### 10. **Specify line-ending handling for `apply_patch`.**

The parser must handle `\r\n` vs `\n` explicitly. Either normalize to `\n` before parsing and restore the target file's line endings after, or reject mixed line endings with a clear error. This is a real-world edge case that will surface immediately on Windows workspaces or repos with mixed line endings.
