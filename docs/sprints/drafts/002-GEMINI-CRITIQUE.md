# Sprint 002 Critique: NEXT

*Note: `NEXT-CODEX-DRAFT.md` was not found in the repository. This critique evaluates the available drafts: `NEXT-CLAUDE-DRAFT.md` and `NEXT-GEMINI-DRAFT.md`.*

## Claude Draft Evaluation

### Strengths
- **Strong Foundation:** Excellent focus on engine robustness by implementing structural features (validation, conditional routing, wait.human) before adding the complexity of external LLM API calls.
- **Comprehensive Validation:** Adds significant value with 8+ new validation rules and transform pipelines.
- **Incremental approach:** Deferring actual LLM calls via a simulation mode allows the team to verify the engine's routing and state management reliably.

### Weaknesses
- **Deferred Value:** By not implementing actual LLM calls, the "AI" part of the engine remains unproven for another sprint.
- **Simulation limits:** Simulation mode for `codergen` might hide real-world async/latency integration issues and complex failure modes inherent to network calls.

### Gaps in Risk Analysis
- **Completely Missing:** The Claude draft does not include a "Risks & Mitigations" section. 
- **Unaddressed Risks:** It fails to account for risks like infinite loops during goal gate retries or failure to write to the run directory (e.g., permissions or missing parent directories).

### Missing Edge Cases
- **Missing Variable:** What happens if the `$goal` variable is missing or malformed during expansion?
- **Invalid Targets:** Behavior is undefined if `retry_target` points to a non-existent node.
- **Human-in-the-loop loops:** What if `wait.human` auto-approve gets stuck in an infinite loop if the subsequent nodes immediately fail and route back?

### Definition of Done Completeness
- **Strengths:** Clear, verifiable checkpoints (e.g., "8+ new validation rules pass").
- **Weaknesses:** Lacks specifications on testing the limits of the engine (e.g., infinite loop prevention testing).

---

## Gemini Draft Evaluation

### Strengths
- **High Impact:** Directly tackles the Unified LLM Client, enabling real AI execution which is the core value proposition of the system.
- **Clear Architecture:** Provides a well-defined structure for the LLM providers (`src/llm/providers/*`).
- **Good Scope Definition:** Explicitly defines what is out of scope (Coding Agent Loop, wait.human, parallel handlers), keeping the boundary clear.

### Weaknesses
- **Overly Ambitious:** Attempting to build the engine enhancements (goal gates, new operators) AND a multi-provider LLM client in one sprint introduces significant risk of missing the sprint goal.
- **Missing Core Handlers:** Omits the `wait.human` and `conditional` handlers, which are fundamental to testing complex pipelines.

### Gaps in Risk Analysis
- **Network Resiliency:** Completely misses API rate limiting, timeouts, and provider-specific error handling (e.g., HTTP 429, 500) which are critical for LLM clients.
- **Partial Responses:** Does not address the risk of incomplete streamed responses or connection drops mid-generation.

### Missing Edge Cases
- **Prompt Size:** What if the `$goal` variable expansion results in an excessively large prompt that exceeds the provider's context window?
- **File System Failures:** What happens if writing `prompt.md` or `response.md` fails mid-execution (e.g., disk full)?
- **Missing Fallbacks:** What if a goal gate fails but the `retry_target` is not defined or is invalid?

### Definition of Done Completeness
- **Strengths:** Good coverage of both engine and LLM features.
- **Weaknesses:** Testing strategy for LLM providers is vague ("via mock or live integration tests"). It needs a strict requirement for mocked tests to avoid CI costs and flakiness.

---

## Recommendations for Final Merged Sprint

1. **Adopt Claude's Incremental Engine Approach, but include a single LLM Provider:**
   Merge the structural engine robustness from Claude (validation rules, conditional handler) but replace the "simulation mode" with Gemini's Unified LLM client, restricted initially to a single provider (e.g., OpenAI or Anthropic) to limit scope.
   
2. **Prioritize Infinite Loop Protection:**
   Both drafts touch on Goal Gate routing, which introduces severe risks for infinite loops. The final sprint must explicitly mandate testing and mitigation for infinite loops using the `max_retries` counter, ensuring failure routing eventually terminates.

3. **Enhance Error Handling for External APIs:**
   If the LLM Client is included, explicitly add tasks for handling API rate limits (429s), network timeouts, and context window overflow.

4. **Combine Directory Structure & Persistence:**
   Ensure the run directory structure (`.nectar/cocoons/<run-id>/<node-id>/`) from both drafts is strictly enforced, and add edge case handling for file system write errors.

5. **Defer Multi-Provider and Wait.Human:**
   To keep the sprint achievable, defer the `wait.human` handler (Claude) and the multi-provider implementation (Gemini) to Sprint 003. Focus strictly on making `codergen` work reliably with one LLM and ensuring the engine can route its successes and failures properly via `conditional` and goal gates.