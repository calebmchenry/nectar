# Sprint 003: Human-in-the-Loop & Engine Hardening

## Overview

**Goal:** Deliver the complete human-in-the-loop system (Interviewer interface + `wait.human` handler) and harden the engine by closing critical bugs and related gaps. After this sprint, `pollinator run` can pause at hexagon nodes, present choices to the user in the terminal, and route based on their selection — while also correctly handling `partial_success` in goal gates, graph-level retry defaults, label normalization, and spec-compliant retry policy.

**Scope:**
- GAP-08: Fix `partial_success` not accepted by goal gates (CRITICAL bug)
- GAP-26: Retry policy — only `retry` status and exceptions trigger retries, not `failure` (CRITICAL correctness)
- GAP-01: `wait.human` handler for `hexagon` shape (CRITICAL feature)
- GAP-05: Full Interviewer interface with 5 implementations (HIGH)
- GAP-10: `default_max_retries` graph attribute inheritance (MEDIUM)
- GAP-15: Preferred label normalization — lowercase, trim, strip accelerator prefixes (MEDIUM)
- GAP-11: Built-in context keys (`outcome`, `preferred_label`, `graph.goal`, `current_node`, `internal.retry_count.<id>`) (MEDIUM)
- GAP-16: `preferred_label` as a condition variable (MEDIUM)
- GAP-09: `allow_partial` attribute on retry exhaustion (MEDIUM)

**Priority tiers** (cut from bottom if behind schedule):
- **Tier 1 — must ship:** GAP-08, GAP-26, GAP-01, GAP-05, GAP-10, GAP-15
- **Tier 2 — should ship:** GAP-11, GAP-16, GAP-09
- **Tier 3 — deferred to Sprint 004:** GAP-13 (node/edge default blocks), GAP-17 (block comment stripping), GAP-20 (h/d duration units)

**Out of scope:**
- Parallel / Fan-in / Manager Loop handlers (GAP-02, GAP-03, GAP-04)
- Model Stylesheet (GAP-06) + Stylesheet Transform (GAP-24)
- Context Fidelity modes (GAP-07) + Preamble Transform (GAP-25)
- Subgraph support (GAP-14), Custom Handler Registration (GAP-12)
- Artifact Store (GAP-18), loop_restart (GAP-19), Tool Call Hooks (GAP-21), HTTP Server (GAP-22), Custom Transforms (GAP-23)
- Coding Agent Loop (GAP-30), Unified LLM Client expansion (GAP-40)
- `FREEFORM` and `CONFIRMATION` QuestionType handling (types defined but not implemented)
- Web UI, Seedbed, Swarm Analysis

---

## Use Cases

1. **Human approval gate:** A pipeline reaches a `hexagon` node. The engine pauses, the terminal displays the outgoing edge labels as numbered choices (e.g., `[1] Approve  [2] Reject  [3] Revise`), and waits for user input. The user types `1` or `approve` and the pipeline continues along the matching edge.

2. **Accelerator key selection:** Edge labels contain accelerator hints (`[Y] Yes`, `N) No`). The `wait.human` handler parses these, and typing just `Y` or `N` selects the corresponding edge — no need to type the full label.

3. **Timeout with default choice:** A hexagon node has `human.default_choice="approve"` and `timeout="30s"`. If the user doesn't respond within 30 seconds, the `approve` edge is selected automatically. The terminal shows a countdown.

4. **Auto-approve mode for CI:** `pollinator run --auto-approve gardens/pipeline.dot` uses `AutoApproveInterviewer` instead of `ConsoleInterviewer`, selecting the first choice at every human gate. This enables CI pipelines with human gates to run unattended. The `resume` command also accepts `--auto-approve`.

5. **Non-TTY fallback:** When running in a headless environment (Docker, CI without `--auto-approve`, piped input), the `ConsoleInterviewer` detects `!process.stdin.isTTY` and: selects `human.default_choice` if defined (with `source: 'auto'`), or returns `failure` with error "human input required but no TTY available". This prevents indefinite hangs.

6. **Goal gate accepts partial success:** A pipeline with `goal_gate=true` nodes that return `partial_success` now correctly exits instead of routing to `retry_target`. This fixes the GAP-08 bug.

7. **Retry only on RETRY status:** A node returns `failure` — the engine does NOT retry it (retries are only for `retry` status and exceptions). A node returning `retry` gets retried with backoff. This matches the spec and prevents surprising retry behavior on `wait.human` timeout failures.

8. **Graph-level retry defaults:** A graph has `default_max_retries=3`. Nodes without explicit `max_retries` inherit this value, reducing boilerplate in large pipelines. The legacy alias `default_max_retry` is also accepted.

9. **Condition routing on preferred_label:** An edge condition like `preferred_label=approve` routes based on the last `wait.human` selection, not just outcome status.

---

## Architecture

### Interviewer Interface

```
src/interviewer/
├── types.ts            # Interviewer interface, Question, Answer, QuestionType
├── console.ts          # ConsoleInterviewer — TTY stdin with EventRenderer output
├── auto-approve.ts     # AutoApproveInterviewer — selects first/default choice
├── callback.ts         # CallbackInterviewer — async callback function
├── queue.ts            # QueueInterviewer — pre-loaded answer queue (for testing)
└── recording.ts        # RecordingInterviewer — wraps another, records Q&A pairs
```

**`Interviewer` interface:**
```typescript
interface Interviewer {
  ask(question: Question): Promise<Answer>;
}

interface Question {
  type: QuestionType;           // YES_NO | MULTIPLE_CHOICE | FREEFORM | CONFIRMATION
  text: string;                 // Display text
  choices?: Choice[];           // For MULTIPLE_CHOICE / YES_NO
  default_choice?: string;      // Label of default choice
  timeout_ms?: number;          // Timeout before selecting default
  node_id: string;              // Source node
  run_id: string;               // Current run
}

interface Choice {
  label: string;                // Full label text
  accelerator?: string;         // Parsed accelerator key (e.g., "Y")
  edge_target: string;          // Target node ID
}

interface Answer {
  selected_label: string;       // The chosen label
  source: 'user' | 'timeout' | 'auto' | 'queue';
}

type QuestionType = 'YES_NO' | 'MULTIPLE_CHOICE' | 'FREEFORM' | 'CONFIRMATION';
```

The Interviewer is injected into the engine at construction time. The CLI creates a `ConsoleInterviewer` by default, or `AutoApproveInterviewer` with `--auto-approve`. The engine passes the Interviewer to the `wait.human` handler via `HandlerExecutionInput`.

### Architectural Decisions

1. **EventRenderer owns all terminal output.** `ConsoleInterviewer` reads stdin only. Human gate prompts and countdown displays are rendered via `human_question` and `human_answer` events consumed by `EventRenderer`. This maintains the engine's "never print directly" principle.

2. **Non-TTY guard is mandatory.** `ConsoleInterviewer` checks `process.stdin.isTTY` before blocking on input. In non-TTY environments: select `human.default_choice` if defined, otherwise return failure immediately.

3. **Handler boundary exposes outgoing edges.** `HandlerExecutionInput` (or the execution context passed to handlers) must include the current node's outgoing edges so `WaitHumanHandler` can derive choices. This is a structural change to the handler contract.

4. **`resume` has parity with `run`.** Both commands accept `--auto-approve` and construct the same Interviewer chain. A pipeline interrupted at a human gate can be resumed.

5. **Invalid human-gate topology fails clearly.** Zero outgoing edges, duplicate normalized labels, duplicate accelerators, or `human.default_choice` matching no edge produce immediate, descriptive failures — not silent misbehavior.

6. **GAP-09 / GAP-26 interaction:** `allow_partial` only applies when `status === 'retry'` and the retry count is exhausted. If a node returns `failure`, it is a hard failure regardless of `allow_partial` — because GAP-26 means `failure` never enters the retry path.

### Wait.Human Data Flow

```
Engine reaches hexagon node
        │
        ▼
WaitHumanHandler.execute()
        │
        ├── Derive choices from outgoing edge labels
        ├── Parse accelerator keys from labels
        ├── Validate: ≥1 choice, no duplicate normalized labels/accelerators
        ├── Build Question object
        │
        ▼
Interviewer.ask(question)  ◀── ConsoleInterviewer (terminal)
        │                      AutoApproveInterviewer (CI)
        │                      QueueInterviewer (test)
        ▼
Answer { selected_label, source }
        │
        ▼
Engine emits human_answer event
        │
        ▼
NodeOutcome { status: 'success', preferred_label: selected_label }
        │
        ▼
EdgeSelector step 2: preferred_label match → selected edge
```

### Built-in Context Keys (GAP-11)

| Key | Set When | Value |
|-----|----------|-------|
| `outcome` | After each node completes | Node's outcome status string |
| `preferred_label` | After each node completes | Handler's `preferred_label` or empty string |
| `graph.goal` | At engine initialization | Graph-level `goal` attribute value |
| `current_node` | Before each node executes | Current node ID |
| `internal.retry_count.<id>` | On each retry | Retry count as string |

### Module Layout Changes

```
nectar/
├── src/
│   ├── interviewer/                # NEW — Human-in-the-loop interface
│   │   ├── types.ts
│   │   ├── console.ts
│   │   ├── auto-approve.ts
│   │   ├── callback.ts
│   │   ├── queue.ts
│   │   └── recording.ts
│   ├── handlers/
│   │   └── wait-human.ts          # NEW — hexagon shape handler
│   ├── engine/
│   │   ├── engine.ts              # MODIFY — context keys, partial_success, retry policy, interviewer injection
│   │   ├── conditions.ts          # MODIFY — preferred_label variable
│   │   ├── edge-selector.ts       # MODIFY — label normalization
│   │   ├── retry.ts               # MODIFY — only retry on RETRY status
│   │   ├── types.ts               # MODIFY — HandlerExecutionInput gets outgoing edges
│   │   └── events.ts              # MODIFY — human_question, human_answer event types
│   ├── garden/
│   │   ├── parse.ts               # MODIFY — hexagon shape, new attributes
│   │   ├── types.ts               # MODIFY — allow_partial, default_max_retries, human.default_choice
│   │   └── validate.ts            # MODIFY — allow hexagon shape
│   ├── cli/
│   │   ├── commands/run.ts        # MODIFY — --auto-approve flag, interviewer creation
│   │   ├── commands/resume.ts     # MODIFY — --auto-approve flag, interviewer creation
│   │   └── ui/renderer.ts         # MODIFY — human gate themed output
│   ...
```

---

## Implementation

### Phase 1: Bug Fixes & Engine Hardening (25%)

**Files:** `src/engine/engine.ts`, `src/engine/types.ts`, `src/engine/conditions.ts`, `src/engine/edge-selector.ts`, `src/engine/retry.ts`, `src/garden/parse.ts`, `src/garden/types.ts`, `src/garden/validate.ts`

**Tasks:**
- [ ] **GAP-08 fix:** In `checkGoalGates()`, change `lastCompletion.status !== 'success'` to `!['success', 'partial_success'].includes(lastCompletion.status)`. Add test case.
- [ ] **GAP-26 fix:** In engine retry logic, only retry on `retry` status and handler exceptions. `failure` status does NOT trigger retry — it proceeds to edge selection immediately. Update retry tests.
- [ ] **GAP-09:** Implement `allow_partial` attribute. When retries exhausted (status was `retry` but count exceeded) and `allow_partial=true` on the node, set outcome to `partial_success` instead of `failure`. Parse `allow_partial` as boolean in `parse.ts`. Note: `allow_partial` is irrelevant when status is `failure` (per GAP-26, `failure` never retries).
- [ ] **GAP-10:** Implement `default_max_retries` graph attribute. When `node.maxRetries` is undefined, fall back to `graph.defaultMaxRetries ?? 0`. Parse `default_max_retries` (and legacy alias `default_max_retry`) in `parse.ts`.
- [ ] **GAP-11:** Set built-in context keys in engine:
  - Set `graph.goal` from graph `goal` attribute at engine initialization
  - Set `current_node` before each node execution
  - Set `outcome` after each node completes
  - Set `preferred_label` after each node completes (empty string if none)
  - Set `internal.retry_count.<node_id>` on each retry
- [ ] **GAP-16:** Add `preferred_label` as a recognized variable in `conditions.ts` `parseTerm()`, resolving from context.
- [ ] **GAP-15:** Implement label normalization in `edge-selector.ts`: lowercase, trim whitespace, strip accelerator prefixes (`[X] `, `X) `, `X - ` patterns). Apply normalization to both `preferred_label` from handler and edge labels during comparison.
- [ ] **Shape support:** Add `hexagon` to `SUPPORTED_SHAPES` in `garden/types.ts`. Map to `wait.human` kind in `normalizeNodeKind()`. Update `validate.ts` to allow hexagon.
- [ ] **Parse attributes:** Parse `human.default_choice`, `allow_partial` on nodes. Parse `default_max_retries` / `default_max_retry` on graph.
- [ ] **Tests:** Unit tests for each fix. Regression tests for existing behavior.

### Phase 2: Interviewer Interface (25%)

**Files:** `src/interviewer/types.ts`, `src/interviewer/console.ts`, `src/interviewer/auto-approve.ts`, `src/interviewer/callback.ts`, `src/interviewer/queue.ts`, `src/interviewer/recording.ts`

**Tasks:**
- [ ] Define `Interviewer`, `Question`, `Answer`, `Choice`, `QuestionType` types in `types.ts`
- [ ] **ConsoleInterviewer:** Reads from `process.stdin` via Node.js `readline`. **Must check `process.stdin.isTTY`** — in non-TTY: select `default_choice` if defined, else return failure. Renders numbered choice list via `human_question` event (not direct stdout/stderr). Accepts: choice number, full label (case-insensitive), or accelerator key. Implements timeout with countdown using `setTimeout` + `AbortController`. On timeout, selects `default_choice` if defined, otherwise returns error. Properly cleans up readline interface on timeout/abort.
- [ ] **AutoApproveInterviewer:** Selects `default_choice` if defined, otherwise first choice. No delay. Returns `source: 'auto'`.
- [ ] **CallbackInterviewer:** Wraps an `async (question: Question) => Answer` callback. Enables programmatic control. Wrap callback in `Promise.race` with `Question.timeout_ms` to prevent indefinite hangs.
- [ ] **QueueInterviewer:** Pre-loaded with `Answer[]`. Pops answers in FIFO order. Throws if queue exhausted. Returns `source: 'queue'`. Essential for deterministic testing.
- [ ] **RecordingInterviewer:** Wraps another Interviewer, records `[Question, Answer][]` pairs. Exposes `.recordings` for assertion. Delegates all calls to wrapped interviewer. Captures errors from the wrapped interviewer (records the error, then re-throws).
- [ ] **Accelerator parsing:** Utility function `parseAccelerator(label: string): { accelerator: string | null; cleanLabel: string }`. Patterns: `[X] Rest`, `X) Rest`, `X - Rest` where X is a single alphanumeric character. Parse from start of label only.
- [ ] **Tests:** QueueInterviewer with exact answer sequence, AutoApproveInterviewer with/without default, RecordingInterviewer captures (including error case), accelerator parsing edge cases (multi-char like `[OK]` → no accelerator, empty label, no prefix).

### Phase 3: Wait.Human Handler (30%)

**Files:** `src/handlers/wait-human.ts`, `src/handlers/registry.ts`, `src/engine/types.ts`, `src/engine/events.ts`, `src/cli/ui/renderer.ts`

**Tasks:**
- [ ] **Extend handler boundary:** Add outgoing edges to `HandlerExecutionInput` so `WaitHumanHandler` can derive choices without reaching into the graph directly.
- [ ] **Implement `WaitHumanHandler`:**
  - Constructor receives `Interviewer` instance
  - `execute(input)`:
    1. Get outgoing edges for current node from `input`
    2. **Validate:** ≥1 outgoing edge with a label. Fail immediately with descriptive error if 0 choices, if duplicate normalized labels exist, if duplicate accelerator keys exist, or if `human.default_choice` matches no edge.
    3. Build `Choice[]` from edge labels + targets, parse accelerators
    4. Determine `QuestionType`: exactly 2 choices with labels normalizing to yes/no variants → `YES_NO`; else `MULTIPLE_CHOICE`
    5. Read `human.default_choice` and `timeout` from node attributes
    6. Build `Question` and call `interviewer.ask()`
    7. Emit `human_answer` event
    8. Return `{ status: 'success', preferred_label: answer.selected_label, suggested_next_ids: [target] }`
  - On error (timeout with no default, queue exhausted, non-TTY with no default): return `{ status: 'failure', error: message }`
- [ ] **Register handler:** Register `wait.human` → `WaitHumanHandler` in registry. Accept `Interviewer` dependency via factory or constructor parameter.
- [ ] **Inject Interviewer:** Engine constructor accepts optional `Interviewer`. Engine passes it through to handler registry/factory chain.
- [ ] **Add events:** Add `human_question` and `human_answer` event types to `src/engine/events.ts`.
- [ ] **Renderer integration:** Add themed output in `EventRenderer` for human gate events:
  - Question: display node ID, choice list with accelerator keys highlighted, timeout countdown
  - Answer: display selection with source indicator (user/timeout/auto)
- [ ] **Test fixtures:**
  - `test/fixtures/human-gate.dot`: `start → hexagon(approve?) → [approve]tool(deploy) → exit` / `[reject]exit`
  - `test/fixtures/human-timeout.dot`: hexagon with `timeout="2s"` and `human.default_choice="skip"`
- [ ] **Tests:**
  - Unit: QueueInterviewer pre-loaded answers → correct `preferred_label`
  - Unit: accelerator key selection (`[Y] Yes` → type `Y` → selects `Yes`)
  - Unit: timeout triggers default choice
  - Unit: 2-choice yes/no detection
  - Unit: validation failures (0 edges, duplicate labels, invalid default_choice)
  - Integration: full pipeline with hexagon node using `QueueInterviewer`, selecting a non-first edge
  - Integration: `--auto-approve` flag end-to-end

### Phase 4: CLI Integration & Polish (20%)

**Files:** `src/cli/commands/run.ts`, `src/cli/commands/resume.ts`, `gardens/interactive-approval.dot`

**Tasks:**
- [ ] Add `--auto-approve` flag to `run` command. Create `ConsoleInterviewer` by default or `AutoApproveInterviewer` with flag. Pass to engine.
- [ ] Add `--auto-approve` flag to `resume` command with same behavior.
- [ ] Create `gardens/interactive-approval.dot` — a user-facing sample pipeline demonstrating: start → hexagon (approve/reject/revise) → tool nodes → exit.
- [ ] Integration test: `pollinator run --auto-approve` on a human-gated pipeline runs to completion without interaction.
- [ ] Integration test: `QueueInterviewer` selects non-default branch, verifying explicit choice routing.
- [ ] Integration test: non-TTY with `human.default_choice` auto-selects.
- [ ] Integration test: non-TTY without `human.default_choice` fails gracefully.
- [ ] Update compliance report: mark closed gaps.
- [ ] Run full test suite — all existing + new tests pass.
- [ ] Manual smoke test: run `gardens/interactive-approval.dot` interactively in the terminal.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/interviewer/types.ts` | Create | Interviewer, Question, Answer, Choice, QuestionType types |
| `src/interviewer/console.ts` | Create | ConsoleInterviewer — TTY stdin with event-driven output |
| `src/interviewer/auto-approve.ts` | Create | AutoApproveInterviewer — selects first/default |
| `src/interviewer/callback.ts` | Create | CallbackInterviewer — async callback wrapper |
| `src/interviewer/queue.ts` | Create | QueueInterviewer — FIFO answer queue for testing |
| `src/interviewer/recording.ts` | Create | RecordingInterviewer — wraps + records Q&A |
| `src/handlers/wait-human.ts` | Create | Wait.human handler for hexagon nodes |
| `test/fixtures/human-gate.dot` | Create | Human gate test fixture |
| `test/fixtures/human-timeout.dot` | Create | Human timeout test fixture |
| `gardens/interactive-approval.dot` | Create | User-facing sample pipeline |
| `src/engine/engine.ts` | Modify | GAP-08, GAP-09, GAP-10, GAP-11, GAP-26, interviewer injection |
| `src/engine/types.ts` | Modify | HandlerExecutionInput gets outgoing edges + Interviewer |
| `src/engine/conditions.ts` | Modify | GAP-16: preferred_label variable |
| `src/engine/edge-selector.ts` | Modify | GAP-15: label normalization |
| `src/engine/retry.ts` | Modify | GAP-26: only retry on RETRY status |
| `src/engine/events.ts` | Modify | human_question, human_answer event types |
| `src/garden/parse.ts` | Modify | Hexagon shape, new attributes |
| `src/garden/types.ts` | Modify | allow_partial, default_max_retries, human.default_choice |
| `src/garden/validate.ts` | Modify | Allow hexagon shape |
| `src/handlers/registry.ts` | Modify | Register wait.human, accept interviewer dependency |
| `src/cli/commands/run.ts` | Modify | --auto-approve flag, interviewer creation |
| `src/cli/commands/resume.ts` | Modify | --auto-approve flag, interviewer creation |
| `src/cli/ui/renderer.ts` | Modify | Human gate themed output |
| `docs/compliance-report.md` | Modify | Mark closed gaps |
| `test/` (various) | Create/Modify | Tests for all new and modified code |

---

## Definition of Done

- [ ] `npm run build && npm test` passes with zero errors
- [ ] **GAP-08 fixed:** Goal gates accept both `success` and `partial_success` (unit tested)
- [ ] **GAP-26 fixed:** `failure` status does not trigger retry; only `retry` status and exceptions do (unit tested)
- [ ] **GAP-10:** Nodes inherit `default_max_retries` (and `default_max_retry` alias) from graph when `max_retries` is not set (unit tested)
- [ ] **GAP-15:** Preferred label comparison is normalized: lowercase, trimmed, accelerator-stripped (unit tested)
- [ ] **GAP-05:** All 5 Interviewer implementations exist. `ConsoleInterviewer`, `AutoApproveInterviewer`, and `QueueInterviewer` are tested. `CallbackInterviewer` and `RecordingInterviewer` are implemented (trivial wrappers) and tested.
- [ ] **GAP-01:** Hexagon nodes pause execution and present choices via `wait.human` handler
- [ ] **Accelerator keys:** `[Y] Yes` labels allow typing `Y` to select (unit tested)
- [ ] **Timeout:** Hexagon with `timeout` and `default_choice` auto-selects on expiry (unit tested)
- [ ] **Non-TTY:** `ConsoleInterviewer` in non-TTY environment selects default or fails gracefully (tested)
- [ ] **Auto-approve:** `pollinator run --auto-approve` and `pollinator resume --auto-approve` run without human interaction (integration tested)
- [ ] **Validation:** Invalid human-gate topology (0 edges, duplicate labels, bad default_choice) fails with descriptive error (unit tested)
- [ ] **Events:** `human_question` and `human_answer` events emitted and rendered by `EventRenderer`
- [ ] **Integration:** Full pipeline with hexagon node runs end-to-end using `QueueInterviewer`, selecting a non-first edge to verify explicit choice routing
- [ ] **Sample garden:** `gardens/interactive-approval.dot` exists and runs with both `QueueInterviewer` and `--auto-approve`
- [ ] **Manual smoke test:** Run `gardens/interactive-approval.dot` interactively in the terminal — prompt appears, user selects, pipeline continues
- [ ] *If Tier 2 ships:* GAP-11 built-in context keys set automatically (unit tested via condition expressions); GAP-16 `preferred_label=approve` works in edge conditions; GAP-09 `allow_partial=true` returns `partial_success` on retry exhaustion
- [ ] Compliance report updated with gap closures
- [ ] All existing tests continue to pass (regression gate)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Non-TTY hang** — ConsoleInterviewer blocks indefinitely in Docker/CI/piped contexts | High | High | Mandatory `process.stdin.isTTY` guard. Select `default_choice` or fail immediately in non-TTY. |
| **ConsoleInterviewer stdin handling** — raw mode, line buffering, signal conflicts | High | Medium | Use Node.js `readline` with `createInterface()`. Test manually on macOS + Linux. Fall back to line-based input if raw mode fails. |
| **GAP-26 behavioral change** — existing pipelines may rely on `failure` triggering retry | Medium | High | This is a spec-compliance fix. Document the change. Update fixtures that depend on `failure` retry to use `retry` status. |
| **Timeout/AbortController cleanup** — readline interface leaks if not cleaned up on timeout | Medium | Medium | Explicitly close readline interface in `finally` block. Use `AbortController` to cancel pending prompts. |
| **Handler boundary change** — exposing outgoing edges in `HandlerExecutionInput` is structural | Medium | Medium | Keep the change minimal: add an `outgoingEdges` field. Only `WaitHumanHandler` uses it initially. |
| **Spinner/prompt state conflict** — ora spinner conflicts with human gate display | Medium | Low | Pause spinner before emitting `human_question` event, resume after `human_answer`. Human gates are explicit synchronous pauses. |
| **Injecting Interviewer through engine → registry → handler** adds coupling | Medium | Medium | Keep the interface narrow. Interviewer is passed as a single field, not deeply threaded. |
| **`resume` through a human gate** — interrupt during prompt creates stateful edge case | Medium | Medium | Ensure cocoon captures pre-prompt state. On resume, re-present the prompt. Test this path explicitly. |
| **Ambiguous choices** — duplicate normalized labels, duplicate accelerators, unlabeled edges | Low | Medium | WaitHumanHandler validates choice set before prompting. Fail immediately with descriptive error on ambiguity. |
| **CallbackInterviewer hang** — callback never resolves | Low | Medium | Wrap callback in `Promise.race` with `Question.timeout_ms`. |
| **Scope (9 gaps)** — ambitious for one sprint | Medium | Medium | Tiered priority. Tier 2 items (GAP-11, GAP-16, GAP-09) are cut first if behind. All are small, well-defined changes. |

---

## Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| Sprint 001 + 002 | Internal | Engine, parser, handlers, edge selector, condition evaluator must be working |
| Node.js `readline` | Built-in | For ConsoleInterviewer stdin handling |
| No new npm packages | — | All implementations use Node.js built-ins + existing dependencies |
| Attractor spec Section 4.6, 6 | Upstream | Wait.human handler and Interviewer interface specification |

No new external dependencies.
