# Sprint 007: The Coding Agent Loop (Foundation)

## Overview

**Goal:** Transform the `codergen` handler from a simple prompt-response mechanism into a fully-fledged, tool-capable agentic loop (GAP-40). After this sprint, `codergen` nodes will be able to autonomously read files, execute shell commands, edit code, and reason through multi-step tasks before completing.

**Scope:** Implement the foundational layers of `coding-agent-loop-spec.md`. This includes the `ExecutionEnvironment` abstraction (specifically `LocalExecutionEnvironment`), the `ToolRegistry` with core file/shell tools, the `ProviderProfile` abstraction for model-specific prompting/tool handling, and the core `process_input()` agent loop with character-based tool output truncation.

**Out of scope:**
- Subagent spawning and management (`spawn_agent`, `send_input`, etc.)
- Advanced steering mid-task (`steer()`, `follow_up()`)
- Dynamic reasoning effort changes mid-session
- Docker/K8s/WASM Execution Environments
- The Web UI or Idea Backlog features

---

## Use Cases

1. **Autonomous File Editing:** A pipeline runs a `codergen` node with the prompt "Update the README to document the new `pollinator resume` feature." The LLM uses `read_file` to inspect `README.md`, uses `edit_file` to make the change, and then concludes the task.
2. **Safe Tool Output Truncation:** The LLM runs `shell` with `cat large_file.log`. The output is 500KB. The `ToolRegistry` safely truncates the output using the character-based head/tail split strategy to prevent context window overflow, returning a marked-up truncated string to the LLM.
3. **Provider-Specific Quirks:** The user configures a node to use Claude 3.7. The `ProviderProfile` ensures Claude gets the Claude-specific system prompt and formatting for `edit_file`. Another node uses GPT-4o, and the OpenAI profile automatically uses the `apply_patch` v4a format.
4. **Agentic Loop Termination:** The LLM successfully completes its task and calls no further tools, emitting a natural end turn. The `process_input()` loop returns control to the Nectar engine, and the `codergen` node is marked as success.
5. **Loop Detection and Recovery:** The LLM gets stuck calling the same failing tool with the exact same arguments 3 times. The agent loop detects this, aborts the cycle, and marks the node as failed so the standard pipeline retry logic can take over.

---

## Architecture

### Language: TypeScript on Node.js 22+

- Build upon the existing `engine` and `llm` directories.
- Introduce an `agent` directory for the loop components.

### Module Layout

```text
nectar/
├── src/
│   ├── agent/
│   │   ├── session.ts             # Core process_input() loop
│   │   ├── environment.ts         # ExecutionEnvironment & LocalExecutionEnvironment
│   │   ├── tools/
│   │   │   ├── registry.ts        # ToolRegistry & execution logic
│   │   │   ├── truncation.ts      # Head/tail character truncation
│   │   │   ├── fs.ts              # read_file, write_file, edit_file, glob, grep
│   │   │   └── shell.ts           # shell tool
│   │   └── profiles/
│   │       ├── types.ts           # ProviderProfile interface
│   │       ├── anthropic.ts       # Claude-specific prompt & tool adapters
│   │       ├── openai.ts          # Codex/OpenAI patch adapters
│   │       └── gemini.ts          # Gemini-specific prompt & tool adapters
│   ├── handlers/
│   │   └── codergen.ts            # (Modified) delegates to agent/session.ts
...
```

### Key Abstractions

**`ExecutionEnvironment`**: Interface for where tools run. Contains `cwd`, `env` (with secrets filtered), and methods to execute commands or read/write files. `LocalExecutionEnvironment` implements this using the local filesystem and `execa`.

**`ToolRegistry`**: Manages available tools. Validates tool schemas, dispatches calls to implementations, enforces timeouts, and applies `ToolOutputTruncation` before returning results to the LLM.

**`ProviderProfile`**: Handles model-specific behavioral tuning. Provides the base system prompt, maps standard core tools into provider-preferred shapes (e.g., `edit_file` vs `apply_patch`), and formats tool errors so the model can recover.

**`Session`**: The stateful agent loop. Wraps the `UnifiedClient`. Executes `process_input()`, driving the generate → execute tools → generate cycle until a stop reason is reached. Handles round limits and loop detection.

---

## Implementation

### Phase 1: Execution Environment & Tool Registry (~25%)

**Tasks:**
- [ ] Create `ExecutionEnvironment` interface.
- [ ] Implement `LocalExecutionEnvironment` with timeout handling and environment variable filtering (strip `*_API_KEY`, etc.).
- [ ] Implement `ToolOutputTruncation`: character-based head/tail split with per-tool default limits (e.g., shell: 30k chars).
- [ ] Implement `ToolRegistry` with dispatch logic, wrapping tool execution in `try/catch` and returning formatted error strings.
- [ ] Implement core filesystem tools (`read_file`, `write_file`, `glob`).
- [ ] Implement core shell tool (`shell`) via `execa`.

### Phase 2: Provider Profiles & System Prompts (~25%)

**Tasks:**
- [ ] Define `ProviderProfile` interface.
- [ ] Implement `AnthropicProfile` mirroring Claude Code system instructions and standard `edit_file` behavior.
- [ ] Implement `OpenAIProfile` mirroring Codex-rs instructions with `apply_patch` behavior.
- [ ] Implement `GeminiProfile` mirroring Gemini CLI instructions.
- [ ] Implement dynamic system prompt construction: base + environment info + project docs (load `AGENTS.md` / `CLAUDE.md` if present).

### Phase 3: The Agentic Loop (~30%)

**Tasks:**
- [ ] Implement `Session` class and `process_input()` loop.
- [ ] Integrate with `UnifiedClient` to generate responses.
- [ ] Handle tool execution: parse `ToolCall`s, dispatch via `ToolRegistry`, append `ToolResult`s, and loop.
- [ ] Implement safety limits: `max_tool_rounds_per_input` (default 15).
- [ ] Implement loop detection: track last 3 tool calls; if identical and failing, abort loop.
- [ ] Wire up graceful shutdown on AbortSignal from the parent pipeline engine.

### Phase 4: Codergen Integration & Artifacts (~20%)

**Tasks:**
- [ ] Update `handlers/codergen.ts` to instantiate a `Session` with the correct `ProviderProfile` and `LocalExecutionEnvironment` instead of calling `UnifiedClient` directly.
- [ ] Pass the expanded `$goal` as the first user input to the session.
- [ ] Update codergen to save the entire conversation history (including tool inputs/outputs) to `prompt.md` and `response.md` in the node's artifact directory.
- [ ] Ensure full, untruncated tool outputs are written to disk as separate artifact files, while only truncated versions go to the LLM context.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/agent/environment.ts` | Create | `ExecutionEnvironment` & `LocalExecutionEnvironment` |
| `src/agent/tools/registry.ts` | Create | `ToolRegistry` implementation |
| `src/agent/tools/truncation.ts` | Create | Truncation logic (head/tail split) |
| `src/agent/tools/fs.ts` | Create | File system tools (`read_file`, `write_file`, `glob`) |
| `src/agent/tools/shell.ts` | Create | Shell tool (`shell`) |
| `src/agent/tools/edit.ts` | Create | Code editing tool (`edit_file`/`apply_patch`) |
| `src/agent/profiles/types.ts` | Create | `ProviderProfile` interface |
| `src/agent/profiles/anthropic.ts` | Create | Claude-specific profile |
| `src/agent/profiles/openai.ts` | Create | OpenAI-specific profile |
| `src/agent/profiles/gemini.ts` | Create | Gemini-specific profile |
| `src/agent/session.ts` | Create | Core `process_input` agentic loop |
| `src/handlers/codergen.ts` | Modify | Switch from direct LLM call to Session loop |
| `test/agent/truncation.test.ts` | Create | Verify exact character split and boundary conditions |
| `test/agent/session.test.ts` | Create | Loop detection, round limits, and normal execution |
| `test/integration/codergen-agent.test.ts` | Create | End-to-end task requiring multiple tool steps |

---

## Definition of Done

- [ ] `ExecutionEnvironment` correctly filters sensitive environment variables from `shell` execution.
- [ ] `ToolRegistry` successfully executes `read_file`, `write_file`, `shell`, `glob`, and `edit_file`.
- [ ] Large tool outputs are correctly truncated using head/tail strategy before reaching the LLM, preserving context efficiency.
- [ ] Full tool outputs are saved as artifacts in the node's run directory.
- [ ] The `process_input()` loop successfully runs multiple tool calls automatically without human intervention until the LLM ends the turn.
- [ ] The loop correctly terminates and marks the node as failed if `max_tool_rounds_per_input` is exceeded.
- [ ] Loop detection correctly catches and aborts identical, repeating tool calls.
- [ ] `codergen` nodes correctly utilize the new loop, using the `model_stylesheet` (or default mapping) to pick the correct `ProviderProfile`.
- [ ] Unit tests pass for truncation, loop logic, and tool execution.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Context Window Overflow | High | High | Strict character-based truncation on all tool outputs. |
| Endless LLM Loops | High | Medium | Implement hard round limits (`max_tool_rounds_per_input`) and identical-call loop detection. |
| Destructive Shell Commands | Medium | High | `LocalExecutionEnvironment` runs as the user. Mitigated by explicit CLI user intent; same threat model as Makefile. Filter env vars to prevent accidental secret leakage. |
| Model Format Hallucination | Medium | Medium | Provider profiles tune system prompts heavily to match the model's preferred tool calling behavior (e.g., strict JSON schema for Claude, distinct function specs for OpenAI). |

---

## Dependencies

- Existing Nectar `engine` context and lifecycle events.
- Existing `UnifiedClient` implementations (completed in Sprint 006).
- `execa` for shell execution.
- `diff` or similar library (if required for robust `apply_patch` implementation, though custom parsing is preferred).