# Sprint NEXT: Human-in-the-Loop & Core Engine Polish

## Overview

**Goal:** Implement the "Human-in-the-Loop" interaction model by introducing the `wait.human` handler (hexagon shape) and the `Interviewer` interface, while simultaneously squashing critical engine bugs (GAP-08, GAP-10). By the end of this sprint, Pollinator will be able to pause pipeline execution, prompt the user for input via the terminal, handle timeouts gracefully, and route execution based on human choices.

**Scope:**
- `Interviewer` interface definition and `ConsoleInterviewer` implementation.
- `WaitHumanHandler` implementation, mapped to the `hexagon` shape.
- Fix GAP-08: Ensure `partial_success` satisfies goal gates.
- Fix GAP-10: Implement graph-level `default_max_retries` inheritance.
- Fix GAP-15: Implement preferred label normalization (lowercase, trim, strip prefixes).

**Out of scope:**
- Web UI ("The Hive") implementation.
- Other interviewer implementations (Queue, Recording) beyond Console and AutoApprove.
- Parallel execution and fan-in handlers.
- Unified LLM Client multi-provider expansions.

---

## Use Cases

1. **Interactive Approval Gate:** A pipeline reaches a `hexagon` node. Execution pauses. The CLI prompts the user with the outgoing edge labels (e.g., "[Y] Yes", "[N] No"). The user makes a selection. Execution resumes down the chosen path.
2. **Timeout Fallback:** If the user does not respond to the `wait.human` prompt within the `timeout` specified on the node, the engine automatically selects the edge matching the `human.default_choice` attribute and continues execution without hanging indefinitely.
3. **Goal Gate Partial Success:** A node marked as `goal_gate=true` yields `partial_success`. The pipeline successfully exits without triggering the retry fallback chain.
4. **Graph-Level Retries:** Nodes missing a `max_retries` attribute automatically inherit the graph's `default_max_retries` value, reducing DOT file verbosity and ensuring consistent retry policies.

---

## Architecture

### Language & Tooling
- Continue using TypeScript + Node.js (ESM).
- Native Node.js `readline` (or a lightweight prompt package like `@inquirer/prompts` if needed for better UX) for the `ConsoleInterviewer` prompt to keep dependencies lean.

### Module Layout Additions

```
nectar/
├── src/
│   ├── engine/
│   │   └── interviewer.ts        # Interviewer interface, Question/Answer types
│   ├── handlers/
│   │   └── wait-human.ts         # Hexagon shape handler logic
│   └── cli/
│       └── ui/
│           └── console-interviewer.ts  # CLI implementation of Interviewer
```

### Key Abstractions

**`Interviewer` interface:** The abstraction over human interaction. Exposes an `ask(question: Question): Promise<Answer>` method. This allows the engine to remain decoupled from the CLI renderer.

**`WaitHumanHandler`:** Extracts labels from outgoing edges via the context/graph, formats a `MULTIPLE_CHOICE` question, delegates to the `Interviewer`, and translates the answer into a `preferred_label` for the edge selector.

**Label Normalization:** Enhancing `EdgeSelector` to intelligently match labels like "[Y] Yes" with user input "yes" or "y".

---

## Implementation Phases

### Phase 1: Core Engine Bug Fixes & Polish (~20%)

**Files:** `src/engine/engine.ts`, `src/engine/edge-selector.ts`, `test/engine/engine.test.ts`, `test/engine/edge-selector.test.ts`

**Tasks:**
- [ ] **Fix GAP-08:** Modify `checkGoalGates()` in `engine.ts` to treat both `success` and `partial_success` as valid completion states.
- [ ] **Fix GAP-10:** Update engine initialization to parse the graph-level `default_max_retries` attribute. Modify retry logic to fall back to this value when a node lacks an explicit `max_retries`.
- [ ] **Fix GAP-15:** Update `applyPreferredLabelStep` in `edge-selector.ts` to normalize strings before comparison. Normalization should: lowercase, trim whitespace, and strip accelerator prefixes (e.g., `[Y] `, `Y) `, `Y - `).

### Phase 2: Interviewer Abstraction (GAP-05) (~30%)

**Files:** `src/engine/interviewer.ts`, `src/cli/ui/console-interviewer.ts`, `src/engine/types.ts`

**Tasks:**
- [ ] Define the `Interviewer` interface, `Question` (type: MULTIPLE_CHOICE, choices, timeout), and `Answer` interfaces.
- [ ] Implement `AutoApproveInterviewer` for use in automated tests (always selects a designated default or first option).
- [ ] Implement `ConsoleInterviewer` in the CLI layer. It should render choices clearly in the terminal, capture user keystrokes/input, and respect timeout signals.
- [ ] Plumb the `Interviewer` instance into the `ExecutionContext` or `HandlerExecutionInput` so handlers can access it.

### Phase 3: Wait.Human Handler (GAP-01) (~30%)

**Files:** `src/handlers/wait-human.ts`, `src/handlers/registry.ts`, `src/garden/validate.ts`

**Tasks:**
- [ ] Update validation in `src/garden/validate.ts` to officially permit the `hexagon` shape.
- [ ] Create `WaitHumanHandler`.
- [ ] Logic: Identify outgoing edges for the current node. Extract their labels as choices. Call `interviewer.ask()`.
- [ ] Implement timeout logic using the `timeout` node attribute and fall back to `human.default_choice` if provided.
- [ ] Map the answer to `preferred_label` in the returned `NodeOutcome`.
- [ ] Register the handler for the `hexagon` shape in `registry.ts`.

### Phase 4: Integration & Validation (~20%)

**Files:** `test/handlers/wait-human.test.ts`, `gardens/interactive-approval.dot`, `test/integration/run.test.ts`

**Tasks:**
- [ ] Create unit tests for `WaitHumanHandler` using `AutoApproveInterviewer`.
- [ ] Add an interactive fixture `gardens/interactive-approval.dot` demonstrating a start -> wait.human -> [approve/reject tools] -> exit flow.
- [ ] Add an integration test that runs the interactive fixture with an injected mocked interviewer to verify end-to-end edge selection based on human input.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/engine.ts` | Modify | Fix GAP-08 (goal gates) and GAP-10 (default retries) |
| `src/engine/edge-selector.ts` | Modify | Fix GAP-15 (label normalization) |
| `src/engine/interviewer.ts` | Create | Define Interviewer, Question, and Answer interfaces |
| `src/cli/ui/console-interviewer.ts` | Create | Terminal implementation of Interviewer |
| `src/engine/types.ts` | Modify | Add Interviewer to execution input/context |
| `src/garden/validate.ts` | Modify | Whitelist `hexagon` shape |
| `src/handlers/wait-human.ts` | Create | Implementation of `wait.human` handler |
| `src/handlers/registry.ts` | Modify | Register `hexagon` to `WaitHumanHandler` |
| `gardens/interactive-approval.dot` | Create | Manual test fixture for human-in-the-loop |
| `test/...` | Create/Modify| Tests for engine fixes and new handler |

---

## Definition of Done

- [ ] `checkGoalGates` correctly passes on `partial_success` without triggering retries.
- [ ] Graph-level `default_max_retries` applies successfully to nodes without an explicit retry count.
- [ ] Edge selection correctly normalizes labels (`[Y] Yes` matches `yes`).
- [ ] Validation allows `hexagon` shapes without warnings.
- [ ] Running a pipeline with a `hexagon` node pauses execution and displays a prompt via the CLI.
- [ ] Providing valid input to the prompt resumes execution down the correct edge.
- [ ] If the prompt times out, execution automatically routes down the edge specified by `human.default_choice`.
- [ ] `npm test` passes all new and existing tests.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Event Loop Blocked by Prompt | Medium | High | Use asynchronous IO (`readline` or async prompt library) to ensure the engine event loop isn't starved. |
| Timeout Handling Race Conditions | Medium | Medium | Use `AbortController` passed to the Interviewer to explicitly cancel pending prompts when the timeout expires. |
| Headless Environment Hanging | Low | High | If `process.stdout.isTTY` is false, `ConsoleInterviewer` should immediately fail or fall back to `human.default_choice` rather than waiting forever. |

---

## Dependencies

- Native `readline` module.
- Optional: A lightweight prompt package if `readline` is too cumbersome for clean UX, but prefer standard library where possible to minimize bloat.