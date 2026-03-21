# Sprint NEXT: SDK Completeness and Extensibility

## Overview

**Goal:** Close the highest-priority remaining compliance gaps identified in the Nectar Compliance Report. This sprint focuses on achieving 100% compliance across the mandatory specs by addressing the missing OpenAI-Compatible adapter, custom transform registration API, the standalone LLM tool loop, and Interviewer API completeness.

**Scope:** 
- **GAP-L1:** Implement `OpenAICompatibleAdapter` for third-party LLM endpoints (vLLM, Ollama, Together AI, Groq) using the standard `/v1/chat/completions` API.
- **GAP-L2:** Enhance the standalone `generate()` function in the Unified LLM Client to include a built-in tool execution loop (`max_tool_rounds`).
- **GAP-A1:** Add a public API for registering custom DOT graph transforms.
- **GAP-A3:** Implement `ask_multiple()` and `inform()` methods on the Interviewer interface and its 5 implementations.

**Out of scope:**
- **GAP-A2:** HTTP Server Mode (optional per spec and warrants its own dedicated sprint).
- Web UI ("The Hive") features or backlog features not related to these core engine/SDK gaps.

---

## Use Cases

1. **Third-Party Local LLMs:** A user wants to run the Nectar pipeline locally using Ollama or vLLM. They configure `OPENAI_API_BASE` and use the `OpenAICompatibleAdapter` to route chat completion requests to their local model, successfully using tools and structured outputs.
2. **Custom Graph Transforms:** A developer embedding Nectar's engine registers a custom transform via `runner.registerTransform(MyCustomTransform())` that automatically injects a specific `max_retries` value into all `tool` nodes before the pipeline validation occurs.
3. **Standalone Agentic Loop:** A developer using only Nectar's `unified-llm` SDK calls `client.generate()` with tools and `max_tool_rounds: 5`. The SDK automatically executes the tool calls and feeds the results back to the LLM until natural completion, without needing the full `AgentSession` state machine.
4. **Batch Human Input:** A pipeline pauses at a `wait.human` node and uses the new `ask_multiple()` Interviewer method to prompt the user for three distinct configuration values at once, rather than prompting sequentially.

---

## Architecture

### OpenAI-Compatible Adapter (GAP-L1)
- Create `src/llm/adapters/openai-compatible.ts` implementing `ProviderAdapter`.
- Maps unified roles/content to the standard Chat Completions API format instead of the OpenAI Responses API.
- Implements streaming support, parsing `data: [...]` and handling the `[DONE]` token natively.
- Registered in `src/llm/client.ts` and prioritized when specific base URLs or third-party providers are detected in the configuration.

### Custom Transform Registration (GAP-A1)
- Expose a `registerTransform(transform: Transform)` API on the pipeline engine.
- Ensure the pipeline execution (`src/garden/pipeline.ts`) iterates over both built-in transforms (goal expansion, stylesheets) and dynamically registered custom transforms before invoking the validator.

### `generate()` Tool Loop (GAP-L2)
- Update `src/llm/client.ts`'s `generate()` function to accept a `max_tool_rounds` option (defaulting to 0 for backwards compatibility).
- Introduce `GenerateResult` and `StepResult` interfaces to track the multi-turn execution.
- If tools are provided and `max_tool_rounds > 0`, loop the underlying `generateUnified()` call, execute tools via `executeToolsBatch()`, and append results to the message history until the model returns a pure text response or the round limit is reached.

### Interviewer API Completeness (GAP-A3)
- Expand the `Interviewer` interface in `src/interviewer/types.ts` with `ask_multiple(questions: Question[]): Promise<Answer[]>` and `inform(message: string, stage: string): void`.
- Update all 5 implementations (`ConsoleInterviewer`, `AutoApproveInterviewer`, `CallbackInterviewer`, `QueueInterviewer`, `RecordingInterviewer`) to support these methods. The console implementation will iterate through the array of questions sequentially.

---

## Implementation phases

### Phase 1: OpenAI-Compatible Adapter (GAP-L1)
- [ ] Create `OpenAICompatibleAdapter` class implementing the `ProviderAdapter` interface.
- [ ] Implement `complete()` mapping unified requests to the `/v1/chat/completions` REST payload.
- [ ] Implement `stream()` with SSE parsing for the Chat Completions format.
- [ ] Add unit tests using simulated vLLM/Ollama responses.
- [ ] Register the adapter in the global catalog and client factory.

### Phase 2: Standalone `generate()` Tool Loop (GAP-L2)
- [ ] Define `GenerateResult` and `StepResult` types in `src/llm/types.ts`.
- [ ] Update `generate()` signature in `src/llm/client.ts` to accept `max_tool_rounds`.
- [ ] Implement the `while` loop inside `generate()`: call LLM, check for tool calls, execute tools, append to history, repeat.
- [ ] Add tests verifying that `generate()` successfully resolves a multi-step tool sequence without manual intervention.

### Phase 3: Custom Transform API (GAP-A1)
- [ ] Define a clear `Transform` interface if not already perfectly extracted.
- [ ] Add `registerTransform()` to the pipeline engine/runner setup.
- [ ] Modify `transformAndValidate` in `src/garden/pipeline.ts` to execute the custom transforms in the correct sequence.
- [ ] Create a unit test demonstrating a custom transform mutating the AST before validation.

### Phase 4: Interviewer Completeness (GAP-A3)
- [ ] Update `src/interviewer/types.ts` with `ask_multiple` and `inform`.
- [ ] Implement `ask_multiple` in `ConsoleInterviewer` (sequential prompting) and `inform` (themed output).
- [ ] Update `AutoApproveInterviewer`, `CallbackInterviewer`, `QueueInterviewer`, and `RecordingInterviewer` with the new methods.
- [ ] Ensure `RecordingInterviewer` properly captures `inform` messages and batch `ask_multiple` responses.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/adapters/openai-compatible.ts` | Create | Implements standard Chat Completions API adapter |
| `src/llm/client.ts` | Modify | Register new adapter, implement tool loop in `generate()` |
| `src/llm/types.ts` | Modify | Add `GenerateResult` and `StepResult` |
| `src/garden/pipeline.ts` | Modify | Support dynamic custom transforms |
| `src/garden/transforms.ts` | Modify | Expose transform registration API |
| `src/interviewer/types.ts` | Modify | Add `ask_multiple` and `inform` signatures |
| `src/interviewer/console.ts` | Modify | Implement new interviewer methods for CLI |
| `src/interviewer/auto-approve.ts` | Modify | Implement new interviewer methods (auto-accept) |
| `src/interviewer/callback.ts` | Modify | Implement new interviewer methods (delegate) |
| `src/interviewer/queue.ts` | Modify | Implement new interviewer methods (test queues) |
| `src/interviewer/recording.ts` | Modify | Implement new interviewer methods (audit logging) |
| `test/llm/adapters/openai-compatible.test.ts`| Create | Tests for the new adapter |
| `test/llm/generate-loop.test.ts` | Create | Tests for the standalone `generate()` loop |
| `test/garden/custom-transform.test.ts` | Create | Tests for registering and running custom transforms |
| `test/interviewer/interviewer.test.ts` | Modify | Update interviewer tests for new methods |

---

## Definition of Done

- [ ] `OpenAICompatibleAdapter` correctly routes and formats requests/responses for `/v1/chat/completions`.
- [ ] `generate()` with `max_tool_rounds > 0` successfully loops and executes tools automatically.
- [ ] A developer can call `registerTransform()` and the custom transform is applied before validation.
- [ ] All 5 `Interviewer` implementations correctly support `ask_multiple` and `inform` without throwing NotImplemented errors.
- [ ] All new code is covered by unit tests.
- [ ] `npm run test` passes completely.
- [ ] The remaining gaps count in `docs/compliance-report.md` (excluding HTTP Server Mode) drops to 0.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Third-party LLM providers have subtle dialect differences in `/v1/chat/completions` | High | Medium | Keep the adapter strictly aligned to the baseline OpenAI spec. Provide a `provider_options` escape hatch for specific quirks. |
| Tool loop in `generate()` conflicts with `AgentSession` logic | Low | High | Ensure `AgentSession` bypasses the `generate()` wrapper and continues to use the low-level `complete()` and `stream()` methods natively. |
| Custom transforms break structural validation | Medium | High | Clearly document that transforms run *before* validation, so any AST mutations must produce valid structures. The existing `validate` step will safely catch bad mutations. |

---

## Dependencies

- No new external npm packages required. 
- Relies on existing `src/llm/tools.ts` for execution batching.
- Relies on existing `@ts-graphviz/parser` AST structures for the transform API.
