# Critique of NEXT Drafts

This critique evaluates `docs/sprints/drafts/NEXT-CLAUDE-DRAFT.md` (Unified LLM Client) and the alternate `docs/sprints/drafts/NEXT-GEMINI-DRAFT.md` (Pipeline Styling, Scoping, and Context Management). *Note: The prompt requested `NEXT-CODEX-DRAFT.md`, but as it did not exist in the repository, the available `NEXT-GEMINI-DRAFT.md` draft was reviewed instead.*

## Draft 1: Claude (Unified LLM Client)

### Strengths
- **Strategic Alignment:** Correctly identifies the Unified LLM Client as the foundational blocker for almost all advanced features (Coding Agent Loop, Context Fidelity, Manager Loop).
- **Technical Architecture:** The no-dependency approach (using native Node.js 22 `fetch`) is excellent and aligns with modern standards. The middleware approach for retries is clean and composable.
- **Clear Phasing:** The breakdown into phases and priority tiers provides a realistic fallback plan if the sprint falls behind schedule.

### Weaknesses
- **Extreme Scope:** Implementing three full provider adapters (Anthropic, OpenAI, Gemini) plus retry middleware, SSE parsing, and core types from scratch in a single sprint is a massive undertaking. The testing surface area is exceptionally large.

### Gaps in Risk Analysis
- **Token Limits:** Does not account for token limits varying significantly between models within the same provider (e.g., Claude 3.5 Haiku vs. Sonnet context windows) and how the client surfaces these limits to the engine.
- **Rate Limiting in CI:** Doesn't adequately address the risk of rate limiting or transient errors if mocked fetch is bypassed for integration testing.

### Missing Edge Cases
- **Max Tokens Exceeded:** What happens when a stream hits the maximum output tokens limit? How is the `stop_reason` normalized across providers when this occurs?
- **Tool Refusal/Failure:** For `tool_choice: 'required'`, what happens if the model refuses or hallucinates a non-existent tool? 
- **Multimodal Inputs:** The scope mentions image support, but the implementation phases barely touch how to fetch, validate, and encode images.

### Definition of Done Completeness
- Very thorough overall, covering core requirements and provider specifics.
- **Missing:** A DoD item for handling and normalizing `stop_reason` (especially `max_tokens` vs. `stop_sequence` vs. `end_turn`).

---

## Draft 2: Gemini (Pipeline Styling, Scoping, and Context Management)

### Strengths
- **Engine Completion:** Targets the remaining structural and semantic features of the Attractor engine (GAP-06, 07, 13, 14).
- **Pragmatic Workarounds:** Provides a realistic workaround for the "Context Fidelity" summarization dependency by deferring actual LLM summarization calls until the client is built.

### Weaknesses
- **Disjointed Scope:** Stylesheets (GAP-06) and Context Fidelity (GAP-07) are conceptually unrelated to Subgraphs and Defaults (GAP-14). Grouping them creates a scattered sprint focus.
- **Premature Features:** Implementing Context Fidelity without the underlying LLM client reduces it to basic text truncation, offering limited immediate value.

### Gaps in Risk Analysis
- **CSS Parser Complexity:** The risk analysis underestimates the complexity of cascading defaults mixed with stylesheet specificity. Building a custom CSS-like AST parser is a classic scope-creep trap.

### Missing Edge Cases
- **Precedence Conflicts:** How do scoped `node`/`edge` defaults interact with the `model_stylesheet`? If a subgraph defines a default, and a stylesheet targets `.class`, which wins? The precedence hierarchy is not fully defined.
- **Truncation Limits:** For context fidelity, how does `truncate` behave if the mandatory preamble itself exceeds the token limit before any graph context is even added?

### Definition of Done Completeness
- A bit sparse compared to the Claude draft.
- **Missing:** Concrete criteria for verifying the precedence between subgraph defaults and stylesheet rules.

---

## Recommendations for the Final Merged Sprint

1. **Select the Claude Draft (Unified LLM Client) as the foundation for Sprint 005.** The Gemini draft explicitly acknowledges that `summary:*` context fidelity is blocked by the LLM client, proving the LLM client is the true critical path for the project.
2. **Reduce the Scope of Sprint 005.** The Claude draft is too large. Scope Sprint 005 down to **Tier 1 only**: Core Types, Retry Middleware, and the Anthropic Adapter. Defer the OpenAI and Gemini adapters to a subsequent sprint (Sprint 005b or 006) to ensure high quality and prevent burnout.
3. **Incorporate Context Fidelity Prep:** While building the LLM client, ensure it exposes robust token counting utilities. The deferred Context Fidelity features (from the Gemini draft) will heavily rely on these utilities for `truncate` and `compact` modes.
4. **Defer Engine Features:** Push the Gemini draft's features (Stylesheets, Subgraphs, Context Fidelity) to Sprint 006 or Sprint 007. They will benefit immensely from having a stable, unified LLM client already in place.
