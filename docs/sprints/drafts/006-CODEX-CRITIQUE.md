# Sprint 005 Draft Critique

**Reviewer:** Codex
**Date:** 2026-03-19

Reviewed against:

- `docs/sprints/drafts/NEXT-CLAUDE-DRAFT.md`
- `docs/sprints/drafts/NEXT-GEMINI-DRAFT.md`
- `docs/compliance-report.md`
- `docs/upstream/unified-llm-spec.md`
- `docs/upstream/attractor-spec.md`
- `src/llm/client.ts`
- `src/llm/types.ts`
- `src/llm/simulation.ts`
- `src/handlers/codergen.ts`
- `src/garden/parse.ts`
- `src/garden/validate.ts`
- `src/garden/pipeline.ts`
- `src/engine/context.ts`
- `src/engine/types.ts`
- `src/checkpoint/types.ts`

The merge question is mostly about dependency sequencing. The current repo still has a generate-only Anthropic client in `src/llm/client.ts`, and `src/handlers/codergen.ts` hardcodes a Claude model and ignores `llm_provider`, `llm_model`, and `reasoning_effort`. That makes the Claude draft directionally right about a real blocker. But the Gemini draft is also right that the Attractor layer still has several unresolved medium gaps. The mistake would be trying to land both full drafts in one sprint.

## Claude Draft

### Strengths

- This is the more implementation-ready draft. The phases, file plan, adapter boundaries, and test plan are detailed enough to code from directly.
- It is grounded in the repo's actual bottleneck. The current LLM layer is still a minimal Anthropic-only wrapper, so a serious GAP-50 sprint would immediately unlock more than parser cleanup would.
- The provider-adapter pattern is the right architecture here. Keeping translation inside provider modules and retry in a wrapper is cleaner than growing one monolithic client.
- The draft correctly upgrades the runtime, not just the types. Routing by provider, streaming, and codergen integration all address the fact that `CodergenHandler` currently hardcodes one model and one call path.
- The priority tiers are useful. They create a real cut line instead of pretending all three providers plus every advanced feature are equally must-ship.
- The risk section is materially better than Gemini's. API volatility, mocked-test blind spots, cancellation, and tool semantic differences are all real issues.

### Weaknesses

- The scope is still too large for one sprint. Three providers, streaming, tool normalization, retry middleware, new content model, codergen rewrite, and cross-provider tests is a major subsystem rewrite.
- It blurs "GAP-50 foundation" with "nearly complete unified SDK." The upstream spec still expects 5 roles, provider-options pass-through, timeouts, `generate_object()`, a larger error hierarchy, and more complete content-part coverage than this draft plans to ship.
- The single-turn tool loop is premature. As soon as the sprint executes model-requested tools locally, it starts absorbing concerns from the Coding Agent Loop spec: tool validation, error-return semantics, round limits, and security.
- It overstates a few dependencies. Model stylesheet parsing/application is still Attractor-layer work. GAP-50 is required for those values to matter at runtime, but not for the parser/transform itself to exist.
- The content model is still narrower than the upstream spec. The draft omits the `DEVELOPER` role and omits audio/document content parts, which means the sprint would remain explicitly partial even if the implementation succeeds.
- The silent simulation fallback is good for CI, but risky as a default runtime behavior when a user explicitly asked for a real provider or specific model.

### Gaps in Risk Analysis

- There is no explicit risk entry for local tool execution safety. Running model-requested tools like `shell` or `read_file` is qualitatively different from adding provider adapters.
- There is no explicit risk entry for migration churn in the rest of the runtime. Moving from `string` responses to structured content parts affects codergen behavior, status persistence, streaming writes, and future checkpoint semantics.
- There is no explicit risk entry for spec drift if the sprint intentionally ships a partial GAP-50. The draft should acknowledge that some upstream DoD items remain open even after a successful sprint.
- There is no explicit risk entry for explicit-provider failure modes: request says `provider="openai"` but only Anthropic is configured, or model/provider combinations do not match.
- There is no explicit risk entry for usage/accounting inconsistencies across providers. Token accounting, reasoning tokens, and cache metrics are exactly the kind of thing that looks done in mocked tests but differs in production.

### Missing Edge Cases

- A node explicitly requests `llm_provider="openai"` or `llm_provider="gemini"` and that provider is not configured.
- A request specifies an OpenAI model string while routing to Anthropic, or vice versa.
- `GenerateRequest` contains both top-level `system` and `messages` entries with `system` or `developer` semantics.
- The model returns multiple tool calls in one response even though the codergen loop is described as "single-turn."
- Tool-call arguments are malformed JSON, or the model calls an unknown tool name.
- Streaming yields only thinking/tool deltas and no text deltas before completion.
- A stream is canceled after partial content is written to `response.md`; resume and status semantics are not defined.
- A provider returns usage metadata partially or not at all; the response still needs to normalize cleanly.

### Definition of Done Completeness

- This is the stronger DoD of the two drafts, but it is still a "partial GAP-50" DoD, not a full unified-LLM-spec DoD.
- The DoD should explicitly say whether Sprint 005 closes GAP-50 partially or completely. Right now the draft sounds larger than its own out-of-scope list.
- If the draft keeps tool execution in scope, the DoD needs explicit requirements for malformed JSON args, unknown tools, tool execution errors returned as tool results, and behavior when multiple tool calls are returned at once.
- The DoD should cover explicit-provider error behavior: unknown provider, configured provider missing, and model/provider mismatch.
- The DoD should include timeout behavior and abort behavior for both `generate()` and `stream()`, not only retry and cancellation.
- The DoD should either include all 5 roles plus `provider_options` pass-through, or explicitly mark those spec items as deferred.
- Manual smoke coverage against real providers should be a required acceptance step, not only a mitigation idea in the risk table.

## Gemini Draft

### Strengths

- This is the better scope-governor draft. It stays on the remaining medium Attractor gaps instead of opening a new cross-provider SDK front.
- The parser, stylesheet, and validation work all map cleanly to real items in `docs/compliance-report.md`.
- It correctly groups coupled features: subgraphs with scoped defaults, stylesheet parsing with stylesheet application, and fidelity validation with preamble behavior.
- The file plan is relatively contained. Most work stays in `src/garden/`, `src/transforms/`, and tests, which is much lower churn than the Claude draft.
- Fixing `fidelity_valid` is real value. The current validator is plainly wrong and the draft catches that.

### Weaknesses

- The runtime architecture for fidelity is wrong. The upstream Attractor spec makes the preamble transform execution-time, not parse-time, because it depends on runtime state and prior execution history.
- The draft does not connect its parser work to the current runtime. `CodergenHandler` still hardcodes a model and does not read styled `llm_model`, `llm_provider`, or `reasoning_effort`, so stylesheet work would not actually change execution behavior yet.
- It does not address `thread_id` or session reuse in any meaningful way. The current LLM client is stateless, so `full` fidelity cannot be implemented by parse/transform work alone.
- Subgraph support is incomplete as written. The spec uses subgraphs for both scoped defaults and derived stylesheet classes from subgraph labels. The draft only mentions explicit `class` extraction.
- The `summary:*` plan is not truly done. A placeholder text reduction may be a useful interim behavior, but it does not really close GAP-07 / GAP-25 if the sprint goal says those gaps are finished.
- It underestimates parser complexity. The current `collectStatements()` implementation is line-oriented and only tracks bracket depth, not nested subgraph brace structure or ordered scoped defaults.
- The file plan is missing some real integration points. Fidelity and styling that matter at runtime will eventually require engine or handler changes, not just parser and validation changes.

### Gaps in Risk Analysis

- There is no explicit risk entry for the parse-time versus runtime split. Treating preamble synthesis like an AST transform is an architectural mismatch with the upstream spec.
- There is no explicit risk entry for parser regression. Subgraphs and scoped defaults are not just additive; they pressure the current statement collector and ordering semantics.
- There is no explicit risk entry for subgraph-label-derived classes: normalization rules, collisions, unlabeled subgraphs, and merge semantics with explicit node classes.
- There is no explicit risk entry for the current string-only runtime surfaces. `ExecutionContext`, `RunState`, and `Cocoon` are still string-key/string-value oriented, while fidelity/session features want richer runtime semantics.
- There is no explicit risk entry for the fact that the current codergen/backend path cannot honor full fidelity or thread reuse yet.
- There is no explicit risk entry for resume behavior. The Attractor spec requires degrading the first resumed hop from `full` to `summary:high`, and the draft does not mention checkpoint/resume at all.

### Missing Edge Cases

- Nested subgraphs with outer defaults, inner overrides, and nodes declared before and after each default block.
- Unlabeled subgraphs, duplicate subgraph labels, or labels that normalize to the same derived class name.
- A node with both explicit `class="foo,bar"` and one or more derived subgraph classes; merge and dedupe rules are unspecified.
- Two stylesheet rules with equal specificity where later declaration order should win.
- A node with explicit `llm_model` or `reasoning_effort` that must override any stylesheet rule.
- Edge-level `fidelity` overriding node-level `fidelity`, and the unset fallback to `compact`.
- `thread_id` resolution for `full` fidelity, including edge override, node value, graph default, derived subgraph class, and fallback behavior.
- Resume after a checkpoint when the previous node was `full` fidelity.
- Graphs without any stylesheet, subgraph, or fidelity usage should behave exactly as before.
- Non-LLM nodes should not be polluted by preamble synthesis or stylesheet-only attributes.

### Definition of Done Completeness

- The DoD is not complete enough to act as the authoritative checklist for this sprint.
- It should require `npm run build` in addition to tests.
- It should explicitly require subgraph-derived class generation, not just explicit `class` extraction.
- It should require the real precedence chain for model properties: explicit node attributes over stylesheet rules, then graph defaults, then handler defaults.
- It should require runtime integration: styled `llm_model` / `llm_provider` / `reasoning_effort` must actually affect codergen execution, not just exist on parsed nodes.
- It should require fidelity resolution for edge, node, graph, and unset-default=`compact`, plus `thread_id` resolution for `full`.
- It should require the resume rule for `full` fidelity degrading to `summary:high` on the first resumed hop.
- If `summary:*` modes remain placeholder implementations, the DoD should say those modes are partial or deferred rather than claiming the gap is closed.
- It should include no-regression acceptance for graphs that do not use subgraphs, defaults, stylesheets, or fidelity.

## Recommendations For The Final Merged Sprint

- Use the Claude draft as the architectural base. The current runtime still needs a real unified LLM layer more urgently than it needs more parser sophistication.
- Use the Gemini draft as the scope governor. Do not merge both full scopes into Sprint 005.
- Make Sprint 005 explicitly a **GAP-50 foundation sprint**, not "finish the entire unified LLM spec." Say that plainly in the Overview and DoD.
- Keep Tier 1 focused on: core request/response types, provider adapter interface, retry/error taxonomy, Anthropic adapter upgrade, OpenAI adapter, `UnifiedClient` routing, streaming, and codergen consuming `llm_provider` / `llm_model` / `reasoning_effort`.
- Make Gemini support Tier 2 or the first thing cut if schedule slips. Make tool execution loops, prompt-caching heuristics, and other agentic behavior Tier 3 or defer them outright.
- Pull a few low-cost foundational items into the Claude plan even if the rest of GAP-50 stays partial: all 5 roles, explicit provider-missing behavior, timeout/abort semantics, and a provider-options escape hatch.
- Do **not** merge Gemini's full fidelity work into the same sprint. `full` fidelity, `summary:*`, and resume degradation depend on runtime/session behavior that the current codebase does not yet have.
- If one Gemini item is pulled forward, keep it to the validator fix for `fidelity_valid` or similarly cheap correctness work. Do not add subgraph/default-block/parser rewrites to a sprint that is already replacing the LLM subsystem.
- Require the merged DoD to include: `npm run build && npm test`, mocked adapter coverage, manual real-provider smoke checks, explicit missing-provider/unknown-provider cases, stream cancellation behavior, and codergen integration tests showing node-level model/provider routing actually works.
- Plan the next sprint after this one around the Gemini draft's Attractor cleanup, but split it into two smaller themes: parser/styling first, fidelity/session behavior only after the codergen/backend path can actually honor it.
