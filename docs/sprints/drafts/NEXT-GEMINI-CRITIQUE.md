# Gemini Critique: Sprint Drafts

This document provides a critique of the `NEXT-CLAUDE-DRAFT.md` (Green Suite & Parallel Compliance Loop) and `NEXT-CODEX-DRAFT.md` (Nectar CLI Control Plane) sprint drafts, concluding with recommendations for a merged final sprint.

## Critique: Claude Draft (Sprint 036: Green Suite & Parallel Compliance Loop)

### Strengths
- **Ruthless Prioritization:** The "Fix First, Prove Second" hard gate is excellent. Acknowledging a 10-sprint failure streak and drawing a line in the sand demonstrates maturity.
- **Clear Root Cause Analysis:** The 5 failing tests are already diagnosed with specific, surgical fixes proposed.
- **High Leverage:** Updating the compliance loop to use parallel execution provides a high-visibility proof point of the engine's capabilities using already-built components.

### Weaknesses
- **Narrow User Value:** Aside from the parallel compliance loop (which is arguably an internal benchmark/demo), there is no new end-user functionality.
- **Assumption of Underlying Stability:** Assumes that fixing the 5 known failures will result in a perfectly green suite. It's common in long-red suites for top-level failures to mask deeper, flaky tests.

### Gaps in Risk Analysis
- **Masked Flakiness:** No mitigation plan for the discovery of additional flaky tests once the 5 deterministic failures are resolved.
- **Resource Exhaustion:** Running 3 LLM/drafting processes in parallel during the compliance loop could trigger rate limits or memory spikes, which isn't addressed in the risks.

### Missing Edge Cases
- **Fan-in Conflicts:** If multiple parallel branches succeed and attempt to update the same keys in `context_updates`, how is the conflict resolved?
- **SSE Connection Drops:** The `closeAll()` fix assumes connections are fully established. What if a client disconnects during the initial handshake?

### Definition of Done Completeness
- Very thorough. The DoD correctly specifies zero failures, no skipped tests, and no inflated timeouts, ensuring the "green suite" claim is legitimate.

---

## Critique: Codex Draft (Sprint NEXT: Nectar CLI Control Plane)

### Strengths
- **Addresses a Critical Product Gap:** Fulfills a direct mandate from `INTENT.md`. An operator console is table stakes for a workflow engine.
- **Pragmatic Architecture:** Leverages existing REST/SSE endpoints rather than inventing new runtime mechanisms. The separation of offline vs. live commands is clean.
- **UX Focus:** TTY-aware rendering, `--json` support for piping, and explicit error messages for missing servers show strong product sense.

### Weaknesses
- **Large Surface Area:** Implementing 6+ new CLI commands, a new HTTP client, SSE parsing, and shell completions is a massive scope for a single sprint.
- **Potential for Scope Creep:** Shell completions (especially across bash, zsh, and fish) are notoriously finicky and could consume significant time.

### Gaps in Risk Analysis
- **Remote Server Confusion:** Users will inevitably try to use `NECTAR_SERVER_URL` to point the CLI at a production or remote server. The draft lacks a discussion on authentication, CORS, or warning users about remote vs. local execution.
- **API Drift:** No plan for how the CLI client will stay in sync if the server's internal API payloads change.

### Missing Edge Cases
- **Network Interruptions:** How does `watch` handle a dropped SSE connection? Does it auto-reconnect using the last seen `seq`, or just fail?
- **Race Conditions on Human Gates:** What happens if the user types `nectar answer` but the gate times out milliseconds before the request reaches the server?
- **Terminal Buffer Limits:** Exporting a massive contextual object or graph to a TTY without pagination.

### Definition of Done Completeness
- Good functional coverage, but lacks specificity on error state verification (e.g., asserting behavior on network disconnects or malformed server responses).

---

## Recommendations for the Final Merged Sprint

The final sprint should combine the **stability mandate** of the Claude draft with the **product value** of the Codex draft, while aggressively pruning scope to ensure delivery.

**Proposed Sprint Name:** Sprint 036: Core Stability & Control Plane

### Recommended Scope & Merge Strategy

1. **Phase 1: The Hard Gate (from Claude)**
   - Fix the 5 failing tests (Fan-in handler, `resolveCurrentNode`, pipeline failure masking).
   - *Rule:* No feature work begins until the test suite is 100% green without skips.

2. **Phase 2: Core CLI Live-Ops (from Codex)**
   - Implement the `RuntimeClient`.
   - Implement `watch`, `questions`, and `answer`. This solves the most critical detached-execution workflow problem.
   - Implement `status --watch`.

3. **Phase 3: State Inspection (from Codex)**
   - Implement `context`, `checkpoint`, and `graph`.

### Recommended Drop Line (Deferrals)

To balance the risk of combining these drafts, the following should be explicitly deferred to a future sprint:

1. **Defer: Parallel Compliance Loop (from Claude):** While a great demo, it is internal machinery. Fixing the CLI for end-users is more important once the suite is green.
2. **Defer: Shell Completions (from Codex):** Generating flawless completions across bash/zsh/fish is a time-sink that distracts from the core goal of runtime control.

### Consolidated Risk Mitigation
- **For the Green Suite:** Add a timebox to Phase 1. If the suite cannot be made reliably green in 2 days, the sprint must pivot to a pure tech-debt/investigation sprint.
- **For the CLI:** Implement explicit auto-reconnect logic in the SSE `watch` command using the `seq` cursor. Ensure 409 Conflict responses for `nectar answer` explicitly inform the user if a gate timed out.