# Sprint NEXT Draft Critique

**Reviewer:** Codex
**Date:** 2026-03-19

Reviewed against:

- `docs/sprints/drafts/NEXT-CLAUDE-DRAFT.md`
- `docs/sprints/drafts/NEXT-GEMINI-DRAFT.md`
- `src/garden/parse.ts`
- `src/garden/types.ts`
- `src/garden/validate.ts`
- `src/garden/pipeline.ts`
- `src/handlers/codergen.ts`
- `src/agent-loop/session.ts`
- `src/agent-loop/events.ts`
- `src/agent-loop/provider-profiles.ts`
- `src/agent-loop/transcript.ts`
- `src/llm/client.ts`
- `src/llm/types.ts`
- `src/llm/tools.ts`
- `src/llm/adapters/anthropic.ts`

The Claude draft is the stronger implementation backbone. The Gemini draft is the more coherent performance narrative. The mistake would be merging both full scopes. The final sprint should keep Claude's authoring plan, keep a narrower and safer version of the shared parallel-tool work, and defer Gemini's prompt-caching and context-window additions.

## Claude Draft

### Strengths

- This is the more implementation-ready draft. The phase order, file plan, module boundaries, and Definition of Done are detailed enough to build from directly.
- The authoring cluster is grouped well. Default blocks, subgraphs, new attributes, stylesheet parsing, stylesheet application, and validation all belong in the same parser/transform pass and the draft sequences them sensibly.
- The draft picks work that is close to runtime value in the current repo. `src/handlers/codergen.ts` already reads `llm_provider` and `llm_model`, and the adapter layer already accepts `reasoning_effort`, so the remaining gap is integration rather than invention.
- The parallel-tool section is more careful than the Gemini draft. It at least names a safety model, bounded concurrency, failure isolation, and result-order preservation.
- The out-of-scope list is useful. It creates a real cut line instead of pretending every remaining gap in Attractor and the agent loop belongs in one sprint.

### Weaknesses

- The sprint is still too broad. It is really two separate sprints: a parser/authoring sprint and a concurrency/performance sprint. They may be file-independent, but they still expand review scope, test scope, and failure modes at the same time.
- The parser effort is understated relative to the current implementation. `collectStatements()` in `src/garden/parse.ts` is line-oriented and only tracks `[` / `]` depth today. Subgraphs, scoped defaults, and same-line statement bodies require a deeper rewrite than the phase percentages imply.
- The block-comment plan does not account for the current validation order. `parseGardenSource()` calls `validateDotSyntax(source)` before `collectStatements()` and before `stripComments()`, so changing `stripComments()` alone is not enough if raw `/* ... */` input trips the parser.
- The new-attributes phase mixes high-value runtime fields with lower-value parse-only fields. `llm_model`, `llm_provider`, and `reasoning_effort` matter immediately; `auto_status`, `fidelity`, `thread_id`, and `default_fidelity` currently do not drive much runtime behavior and inflate the sprint.
- Some of the claimed runtime payoff is still blocked by current plumbing. `CodergenHandler` reads `llm_provider`, but `AgentSession.processInput()` does not pass a provider or `reasoning_effort` into `UnifiedClient.stream()` today. The draft should either include that integration explicitly or stop implying those fields already change execution behavior.
- The LLM SDK part is not grounded in the current architecture. `src/llm/client.ts` does not execute tools, and `src/llm/tools.ts` currently only defines types. Moving execution batching there would invent a new layer boundary rather than tighten an existing one.
- The proposed batch strategy can reorder semantics. Partitioning a response into "all read-only calls in parallel, then all mutating calls sequentially" breaks cases like `read_file -> write_file -> read_file`, where the second read is supposed to observe the write.
- The plan says profile-specific parallel behavior will live in `src/agent-loop/types.ts`, but the current profile abstraction lives in `src/agent-loop/provider-profiles.ts`. That integration point is missing from the file plan.

### Gaps in Risk Analysis

- There is no explicit risk entry for the raw-source validation pass running before custom comment stripping.
- There is no explicit risk entry for parser regression from brace nesting, same-line statements, and scope-sensitive ordering.
- There is no explicit risk entry for mixed tool batches whose correctness depends on execution order, not just result ordering.
- There is no explicit risk entry for transcript and tool-artifact serialization once tool completions can arrive out of order.
- There is no explicit risk entry for stylesheet failure semantics: whether syntax errors fail closed, apply only valid rules, or produce partially transformed graphs.
- There is no explicit risk entry for subgraph-derived class normalization and collisions when labels contain spaces, punctuation, or duplicate names.

### Missing Edge Cases

- `/* ... */` comments that must be stripped before validation, not only before statement parsing.
- Multiple statements on one line, such as `node [shape=box]; a; b;` or `subgraph cluster_x { node [timeout=\"30s\"]; a; }`.
- Nested subgraphs with outer defaults, inner overrides, and nodes declared before and after each default block.
- Subgraph labels that normalize to the same class, contain spaces, or collide with explicit node `class` values.
- A node with both explicit `class=\"foo,bar\"` and derived subgraph classes, including dedupe and precedence rules.
- Mixed tool batches such as `glob -> edit_file -> read_file` or `read_file -> write_file -> read_file`.
- Malformed JSON arguments or unknown tool names inside a multi-call batch.
- End-to-end behavior where `model_stylesheet` resolves `llm_provider` / `llm_model` and `CodergenHandler` must actually run with those resolved values.
- Quoted node IDs named `node`, `edge`, or `subgraph`, which should not be broken by keyword detection.

### Definition of Done Completeness

- This is the stronger Definition of Done of the two drafts. It is mostly concrete, testable, and attached to named gap closures.
- It should explicitly require one end-to-end runtime proof that stylesheet/default-block output affects actual codergen model/provider selection, not only parsed node fields.
- It should explicitly require semantic correctness for mixed tool batches, not only "results returned in original order."
- It should require parser regression coverage for same-line statements, nested subgraphs, and the validation-before-stripping path.
- It should require deterministic transcript/tool-artifact behavior under concurrent tool completion.
- It should specify what happens when stylesheet parsing returns both syntax errors and some valid rules.

## Gemini Draft

### Strengths

- This is the more cohesive sprint story. "Make the agent loop faster and cheaper" is easy to explain, easy to demo, and clearly user-facing.
- The draft targets real operator pain. Parallel tool execution, Anthropic prompt caching, and context-window visibility all map to latency, cost, and runaway-session concerns that users will notice immediately.
- The risk table is stronger than Claude's on provider strictness and operational behavior. Ordering requirements for tool results and cache-breakpoint limits are real issues.
- Prompt caching is not completely speculative in the current repo. `src/llm/types.ts` already has `cache_control?`, `cache_read_tokens`, and `cache_write_tokens`, so there is some existing type runway.

### Weaknesses

- The draft understates the amount of type churn required for prompt caching. The current `GenerateRequest.system` is just a string, `Message` / `ContentPart` do not carry per-part cache metadata, and `ToolDefinition` does not model Anthropic cache annotations. The file plan is too small for the change it describes.
- The concurrency plan is internally inconsistent. The architecture section says `Promise.allSettled()`, but the implementation phase says `Promise.all()`. Those have different failure semantics.
- The safety model for parallel tools is too optimistic. Suggesting `write_file` and `edit_file` are "technically safe" when they touch different files ignores shared workspace state, shell side effects, and model assumptions about call ordering.
- The context-window plan is built on the wrong heuristic. A running sum of usage across turns is not the same thing as current prompt occupancy; it will over-warn because each turn's input token count already includes repeated conversation history.
- The file plan misses current integration points. A new warning event belongs in `src/agent-loop/events.ts`, and provider-specific parallel behavior belongs in `src/agent-loop/provider-profiles.ts`, but neither file is in scope.
- The draft has no real cut line. It tries to land three distinct optimizations at once: concurrency, caching policy, and context telemetry.
- The cache-breakpoint strategy is too heuristic as written. "Mark the 3rd most recent user message" is not clearly tied to how `AgentSession` currently constructs conversation turns.

### Gaps in Risk Analysis

- There is no explicit risk entry for the token heuristic drifting away from actual current context usage and producing noisy warnings.
- There is no explicit risk entry for Anthropic-specific cache metadata leaking into other adapters or generic message/tool types.
- There is no explicit risk entry for abort semantics during parallel tool execution, including orphaned child processes and partially written artifacts.
- There is no explicit risk entry for transcript ordering and per-tool artifact numbering once calls can complete out of order.
- There is no explicit risk entry for event-model changes required to surface warning events through the current agent-loop event bridge.
- There is no explicit risk entry for cache-breakpoint injection when the candidate system/tool/message block does not exist or is already marked.

### Missing Edge Cases

- Fewer than three prior user turns, so the proposed stable-prefix breakpoint does not exist.
- Requests where `system` is a plain string and must be transformed before any per-block cache annotation can be applied.
- Requests where the chosen breakpoint is already marked and the injector must avoid duplicates.
- Non-Anthropic providers receiving the same request shape and needing to ignore cache metadata cleanly.
- Multi-call tool batches with read/write interleaving or two writes targeting the same file.
- One tool timing out or failing while others are still running.
- A session abort arriving while a parallel batch is still executing.
- Malformed JSON arguments or unknown tool names inside a multi-call response.
- Missing or partial usage metadata from a provider, making the context warning heuristic impossible or noisy.
- Transcript and tool-call directory numbering when completion order differs from call order.

### Definition of Done Completeness

- This DoD is not strong enough to be the final sprint checklist.
- It should require `npm run build` in addition to tests.
- It should replace the generic `>90% unit test coverage` target with behavior-level acceptance criteria.
- It should require exact request-shape tests for Anthropic cache injection, not only a proof that cache token counters can be observed later.
- It should require explicit safety semantics for mixed tool batches, failure isolation, abort handling, and artifact ordering.
- It should require the warning-event integration path through the current event types and renderer bridge.
- It should clarify that context-window awareness is heuristic-only unless a more accurate accounting model is implemented.

## Recommendations For The Final Merged Sprint

- Use the Claude draft as the structural base. It is more implementation-ready and better aligned with the current parser, pipeline, and handler surfaces.
- Keep the authoring cluster. Default blocks, subgraphs, stylesheet parsing/application, and the runtime-relevant node attributes are the best-spec'd work across both drafts, and the remaining runtime plumbing for them is narrow enough to fit the same sprint if it is made explicit.
- Narrow the attribute scope. Treat `llm_model`, `llm_provider`, `reasoning_effort`, and `class` as must-ship. Defer lower-value parse-only attributes such as `auto_status`, `thread_id`, and `default_fidelity` unless they turn out to be trivial.
- Make the runtime plumbing explicit. If `llm_provider` and `reasoning_effort` are in scope, the merged sprint must forward them all the way through `CodergenHandler` and `AgentSession` into `UnifiedClient.stream()`, not just parse and validate them.
- Keep parallel tool execution, but only as a narrower agent-loop change. Do not invent an `src/llm/tools.ts` execution layer unless a real caller appears. Provider-side work should stay limited to formatting/parsing multiple tool calls and results correctly.
- Rewrite the concurrency plan around order preservation. Only parallelize tool calls when reordering is proven safe; do not batch all read-only calls ahead of mutating calls if the original sequence interleaves them.
- Pull in Gemini's operational rigor, not its whole scope. Specifically: stronger tool-result ordering tests, provider-formatting tests, and explicit abort/failure handling.
- Defer prompt-caching auto-injection and context-window warnings to the next sprint. Both require broader type and event-model work than the Gemini draft acknowledges, and the proposed heuristics are not mature enough to combine with parser work in the same sprint.
- Strengthen the merged Definition of Done with:
  - `npm run build && npm test`
  - One end-to-end DOT-to-codergen test proving stylesheet/default-block routing changes the selected provider/model, and that any in-scope `reasoning_effort` value is actually forwarded
  - Parser regression tests for raw block comments, same-line statements, nested subgraphs, and class normalization/collision handling
  - Parallel batch tests covering read/write interleaving, single-tool failure, abort during execution, and transcript/tool-artifact ordering
  - An explicit statement of stylesheet parse-error behavior
- Keep a hard cut line: if schedule slips, ship the authoring cluster first and move parallel tools to the next sprint. That produces a coherent, user-visible sprint on its own. The reverse is not true if the parser/authoring gaps remain untouched.
