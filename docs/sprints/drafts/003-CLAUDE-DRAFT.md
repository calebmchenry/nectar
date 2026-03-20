# Sprint 003: Human-in-the-Loop & Engine Hardening

## Overview

**Goal:** Deliver the complete human-in-the-loop system (Interviewer interface + wait.human handler) and harden the engine/parser by closing every CRITICAL, HIGH, and small-to-medium gap that doesn't require parallel execution. After this sprint, `pollinator run` can pause at hexagon nodes, present choices to the user in the terminal, and route based on their selection — while also correctly handling `partial_success` in goal gates, built-in context keys, graph-level defaults, and a handful of parser gaps.

**Scope:**
- GAP-08: Fix `partial_success` not accepted by goal gates (bug — CRITICAL)
- GAP-05: Full Interviewer interface with 5 implementations (HIGH)
- GAP-01: `wait.human` handler for `hexagon` shape (CRITICAL)
- GAP-11: Built-in context keys (`outcome`, `preferred_label`, `graph.goal`, `current_node`, `internal.retry_count.<id>`) (MEDIUM)
- GAP-09: `allow_partial` attribute on retry exhaustion (MEDIUM)
- GAP-10: `default_max_retries` graph attribute inheritance (MEDIUM)
- GAP-13: Node/edge default blocks in parser (MEDIUM)
- GAP-15: Preferred label normalization (lowercase, trim, strip accelerator prefixes) (LOW)
- GAP-16: `preferred_label` as a condition variable (LOW)
- GAP-17: Block comment stripping in parser (LOW)
- GAP-20: Duration `h` and `d` unit support (LOW)
- GAP-26: Retry policy — FAIL status should NOT trigger retries (only RETRY and exceptions) (LOW)

**Out of scope (deferred to Sprint 004+):**
- Parallel / Fan-in / Manager Loop handlers (GAP-02, GAP-03, GAP-04) — fundamentally different execution model, own sprint
- Model Stylesheet (GAP-06) + Stylesheet Transform (GAP-24) — coupled feature, own sprint
- Context Fidelity modes (GAP-07) + Preamble Transform (GAP-25) — coupled feature
- Subgraph support (GAP-14) — lower value without model stylesheet targeting
- Custom Handler Registration (GAP-12) — deferred until handler set stabilizes
- Artifact Store (GAP-18), loop_restart (GAP-19), Tool Call Hooks (GAP-21), HTTP Server (GAP-22), Custom Transforms (GAP-23)
- Coding Agent Loop (GAP-30), Unified LLM Client expansion (GAP-40)
- Web UI, Seedbed, Swarm Analysis

---

## Use Cases

1. **Human approval gate:** A pipeline reaches a `hexagon` node. The engine pauses, the terminal displays the outgoing edge labels as numbered choices (e.g., `[1] Approve  [2] Reject  [3] Revise`), and waits for user input. The user types `1` or `approve` and the pipeline continues along the matching edge.

2. **Accelerator key selection:** Edge labels contain accelerator hints (`[Y] Yes`, `N) No`). The wait.human handler parses these, and typing just `Y` or `N` selects the corresponding edge — no need to type the full label.

3. **Timeout with default choice:** A hexagon node has `human.default_choice="approve"` and `timeout="30s"`. If the user doesn't respond within 30 seconds, the `approve` edge is selected automatically. The terminal shows a countdown.

4. **Auto-approve mode for CI:** `pollinator run --auto-approve gardens/pipeline.dot` uses `AutoApproveInterviewer` instead of `ConsoleInterviewer`, selecting the first choice at every human gate. This enables CI pipelines with human gates to run unattended.

5. **Goal gate accepts partial success:** A pipeline with `goal_gate=true` nodes that return `partial_success` now correctly exits instead of routing to `retry_target`. This fixes the GAP-08 bug.

6. **Retry only on RETRY status:** A node returns `failure` — the engine does NOT retry it (retries are only for `retry` status and exceptions). A node returning `retry` gets retried with backoff. This matches the spec.

7. **Graph-level retry defaults:** A graph has `default_max_retries=3`. Nodes without explicit `max_retries` inherit this value, reducing boilerplate in large pipelines.

8. **Condition routing on preferred_label:** An edge condition like `preferred_label=approve` routes based on the last wait.human selection, not just outcome status.

9. **Node/edge default blocks:** `node [shape=box, timeout="300s"]` sets defaults for all subsequent nodes. This reduces repetition in DOT files with many nodes of the same type.

---

## Architecture

### Interviewer Interface

```
src/interviewer/
├── types.ts            # Interviewer interface, Question, Answer, QuestionType
├── console.ts          # ConsoleInterviewer — TTY stdin/stdout
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
  choices?: Choice[];           // For MULTIPLE_CHOICE
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
```

The Interviewer is injected into the engine at construction time. The CLI creates a `ConsoleInterviewer` by default, or `AutoApproveInterviewer` with `--auto-approve`. The engine passes the Interviewer to the `wait.human` handler.

### Wait.Human Handler

The handler:
1. Collects outgoing edges from the current node
2. Derives `Choice[]` from edge labels, parsing accelerator prefixes
3. Constructs a `Question` with type `MULTIPLE_CHOICE` (or `YES_NO` if exactly 2 edges labeled yes/no variants)
4. Calls `interviewer.ask(question)`
5. Returns `{ status: 'success', preferred_label: answer.selected_label, suggested_next_ids: [matching_edge_target] }`

The engine's edge selector already handles `preferred_label` in step 2 — this integration requires no changes to edge selection logic.

### Built-in Context Keys

The engine will automatically manage these keys in the execution context:

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
│   │   └── edge-selector.ts       # MODIFY — label normalization
│   ├── garden/
│   │   ├── parse.ts               # MODIFY — default blocks, block comments, h/d durations, hexagon shape
│   │   └── validate.ts            # MODIFY — allow hexagon shape
│   ...
```

### Data Flow for Wait.Human

```
Engine reaches hexagon node
        │
        ▼
WaitHumanHandler.execute()
        │
        ├── Derive choices from outgoing edge labels
        ├── Parse accelerator keys from labels
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
NodeOutcome { status: 'success', preferred_label: selected_label }
        │
        ▼
EdgeSelector step 2: preferred_label match → selected edge
```

---

## Implementation

### Phase 1: Bug Fixes & Engine Hardening (20%)

**Files:** `src/engine/engine.ts`, `src/engine/types.ts`, `src/engine/conditions.ts`, `src/engine/edge-selector.ts`, `src/engine/retry.ts`, `src/garden/parse.ts`, `test/engine/engine.test.ts`, `test/engine/conditions.test.ts`, `test/garden/parse.test.ts`

**Tasks:**
- [ ] **GAP-08 fix:** In `checkGoalGates()`, change `lastCompletion.status !== 'success'` to `!['success', 'partial_success'].includes(lastCompletion.status)`. Add test case.
- [ ] **GAP-26 fix:** In engine retry logic, only retry on `retry` status and handler exceptions. `failure` status does NOT trigger retry — it proceeds to edge selection immediately. Update retry tests.
- [ ] **GAP-09:** Implement `allow_partial` attribute. When retries exhausted and `allow_partial=true` on the node, set outcome to `partial_success` instead of `failure`. Parse `allow_partial` as boolean in `parse.ts`.
- [ ] **GAP-10:** Implement `default_max_retries` graph attribute. In engine, when `node.maxRetries` is undefined, fall back to `graph.defaultMaxRetries ?? 0`. Parse `default_max_retries` (and legacy alias `default_max_retry`) in `parse.ts`.
- [ ] **GAP-11:** Set built-in context keys in engine:
  - Set `graph.goal` from graph `goal` attribute at engine initialization
  - Set `current_node` before each node execution
  - Set `outcome` after each node completes
  - Set `preferred_label` after each node completes (empty string if none)
  - Set `internal.retry_count.<node_id>` on each retry
- [ ] **GAP-16:** Add `preferred_label` as a recognized variable in `conditions.ts` `parseTerm()`, resolving from context (already set by GAP-11).
- [ ] **GAP-15:** Implement label normalization in `edge-selector.ts`: lowercase, trim whitespace, strip accelerator prefixes (`[X] `, `X) `, `X - ` patterns). Apply normalization to both `preferred_label` from handler and edge labels during comparison.
- [ ] **Tests:** Unit tests for each fix. Regression tests for existing behavior.

### Phase 2: Parser Improvements (15%)

**Files:** `src/garden/parse.ts`, `src/garden/validate.ts`, `test/garden/parse.test.ts`, `test/garden/validate.test.ts`

**Tasks:**
- [ ] **GAP-13:** Implement node/edge default blocks. When the custom statement collector encounters `node [attrs]` or `edge [attrs]`, store as defaults. Apply stored defaults to subsequent node/edge declarations (node defaults merge with each subsequent node's explicit attributes; edge defaults merge with each subsequent edge). Defaults reset at subgraph boundaries (forward-compatible for GAP-14).
- [ ] **GAP-17:** Implement block comment stripping (`/* ... */`) in `stripComments`. Handle multi-line block comments. Ensure block comments inside attribute values (quoted strings) are preserved.
- [ ] **GAP-20:** Add `h` (hours → 3,600,000ms) and `d` (days → 86,400,000ms) units to `parseTimeoutMs`.
- [ ] **Shape support:** Add `hexagon` to `SUPPORTED_SHAPES`. Map to `wait.human` kind.
- [ ] **Parse attributes:** Parse `human.default_choice`, `allow_partial` on nodes. Parse `default_max_retries` / `default_max_retry` on graph.
- [ ] **Tests:** Default block merging, block comment edge cases, new duration units, hexagon parsing.

### Phase 3: Interviewer Interface (25%)

**Files:** `src/interviewer/types.ts`, `src/interviewer/console.ts`, `src/interviewer/auto-approve.ts`, `src/interviewer/callback.ts`, `src/interviewer/queue.ts`, `src/interviewer/recording.ts`, `test/interviewer/queue.test.ts`, `test/interviewer/recording.test.ts`, `test/interviewer/auto-approve.test.ts`

**Tasks:**
- [ ] Define `Interviewer`, `Question`, `Answer`, `Choice`, `QuestionType` types in `types.ts`
- [ ] **ConsoleInterviewer:** Reads from `process.stdin`, writes to `process.stderr` (so stdout remains pipe-friendly). Renders numbered choice list. Accepts: choice number, full label (case-insensitive), or accelerator key. Implements timeout with countdown display using `setTimeout` + `AbortController`. On timeout, selects `default_choice` if defined, otherwise returns error.
- [ ] **AutoApproveInterviewer:** Selects `default_choice` if defined, otherwise first choice. No delay. Returns `source: 'auto'`.
- [ ] **CallbackInterviewer:** Wraps an `async (question: Question) => Answer` callback. Enables programmatic control from HTTP server or tests.
- [ ] **QueueInterviewer:** Pre-loaded with `Answer[]`. Pops answers in FIFO order. Throws if queue exhausted. Returns `source: 'queue'`. Essential for deterministic testing.
- [ ] **RecordingInterviewer:** Wraps another Interviewer, records `[Question, Answer][]` pairs. Exposes `.recordings` for assertion. Delegates all calls to wrapped interviewer.
- [ ] **Accelerator parsing:** Utility function `parseAccelerator(label: string): { accelerator: string | null; cleanLabel: string }`. Patterns: `[X] Rest`, `X) Rest`, `X - Rest` where X is a single alphanumeric character.
- [ ] **Tests:** QueueInterviewer with exact answer sequence, AutoApproveInterviewer with/without default, RecordingInterviewer captures, accelerator parsing edge cases. ConsoleInterviewer is tested via integration tests (stdin/stdout are hard to unit test).

### Phase 4: Wait.Human Handler (25%)

**Files:** `src/handlers/wait-human.ts`, `src/handlers/registry.ts`, `test/handlers/wait-human.test.ts`, `test/fixtures/human-gate.dot`, `test/fixtures/human-timeout.dot`, `test/integration/human-gate.test.ts`

**Tasks:**
- [ ] Implement `WaitHumanHandler`:
  - Constructor receives `Interviewer` instance
  - `execute(input)`:
    1. Get outgoing edges for current node from graph
    2. Build `Choice[]` from edge labels + targets, parse accelerators
    3. Determine `QuestionType`: if exactly 2 choices and labels normalize to yes/no variants → `YES_NO`; else `MULTIPLE_CHOICE`
    4. Read `human.default_choice` from node attributes
    5. Read `timeout` from node attributes (already parsed to ms)
    6. Build `Question` and call `interviewer.ask()`
    7. Return `{ status: 'success', preferred_label: answer.selected_label, suggested_next_ids: [target] }`
  - On error (timeout with no default, queue exhausted): return `{ status: 'failure', error: message }`
- [ ] Register `wait.human` → `WaitHumanHandler` in registry. The registry must accept the `Interviewer` dependency — modify registry constructor or use a factory pattern.
- [ ] Inject `Interviewer` into engine → registry → handler chain:
  - Engine constructor accepts optional `Interviewer`
  - Engine passes it to `HandlerRegistry`
  - Registry passes it to `WaitHumanHandler`
  - Default: `ConsoleInterviewer` (created in CLI command)
- [ ] Update `run` command: create `ConsoleInterviewer` (or `AutoApproveInterviewer` with `--auto-approve` flag) and pass to engine
- [ ] **Test fixtures:**
  - `human-gate.dot`: `start → hexagon(approve?) → [approve]tool(deploy) → exit` / `[reject]exit`
  - `human-timeout.dot`: hexagon with `timeout="2s"` and `human.default_choice="skip"`
- [ ] **Tests:**
  - Unit test with `QueueInterviewer`: pre-load answers, verify handler returns correct `preferred_label`
  - Unit test: accelerator key selection (`[Y] Yes` → type `Y` → selects `Yes`)
  - Unit test: timeout triggers default choice
  - Unit test: 2-choice yes/no detection
  - Integration test: full pipeline with hexagon node using `QueueInterviewer`
  - Integration test: `--auto-approve` flag

### Phase 5: Polish & Verification (15%)

**Files:** `src/cli/ui/renderer.ts`, `src/cli/commands/run.ts`, `docs/compliance-report.md`, `test/integration/run.test.ts`

**Tasks:**
- [ ] Add themed output for human gate events:
  - `🤔 Petal [node_id] needs your input...`
  - Choice list with accelerator keys highlighted
  - `⏳ Waiting... (timeout in Xs)` with countdown
  - `👤 Human chose: [label]` (user) / `⏰ Timed out, defaulting to: [label]` (timeout) / `🤖 Auto-approved: [label]` (auto)
- [ ] Add `--auto-approve` flag to `run` command
- [ ] Add `human_question` and `human_answer` event types to the event system
- [ ] Update compliance report: mark GAP-01, GAP-05, GAP-08, GAP-09, GAP-10, GAP-11, GAP-13, GAP-15, GAP-16, GAP-17, GAP-20, GAP-26 as closed
- [ ] Run full test suite — all existing + new tests pass
- [ ] Manual smoke test: run a pipeline with a hexagon node interactively in the terminal

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/interviewer/types.ts` | Create | Interviewer, Question, Answer, Choice, QuestionType types |
| `src/interviewer/console.ts` | Create | ConsoleInterviewer — TTY stdin/stdout with timeout |
| `src/interviewer/auto-approve.ts` | Create | AutoApproveInterviewer — selects first/default |
| `src/interviewer/callback.ts` | Create | CallbackInterviewer — async callback wrapper |
| `src/interviewer/queue.ts` | Create | QueueInterviewer — FIFO answer queue for testing |
| `src/interviewer/recording.ts` | Create | RecordingInterviewer — wraps + records Q&A |
| `src/handlers/wait-human.ts` | Create | Wait.human handler for hexagon nodes |
| `src/engine/engine.ts` | Modify | GAP-08 fix, GAP-09, GAP-10, GAP-11, GAP-26, interviewer injection |
| `src/engine/conditions.ts` | Modify | GAP-16: preferred_label variable support |
| `src/engine/edge-selector.ts` | Modify | GAP-15: label normalization |
| `src/engine/retry.ts` | Modify | GAP-26: only retry on RETRY status |
| `src/garden/parse.ts` | Modify | GAP-13, GAP-17, GAP-20, hexagon shape, new attributes |
| `src/garden/types.ts` | Modify | Add new parsed attributes (allow_partial, default_max_retries, human.default_choice) |
| `src/garden/validate.ts` | Modify | Allow hexagon shape |
| `src/handlers/registry.ts` | Modify | Register wait.human, accept interviewer dependency |
| `src/cli/commands/run.ts` | Modify | --auto-approve flag, interviewer creation |
| `src/cli/ui/renderer.ts` | Modify | Human gate themed output |
| `src/engine/events.ts` | Modify | Add human_question, human_answer event types |
| `test/interviewer/queue.test.ts` | Create | QueueInterviewer tests |
| `test/interviewer/recording.test.ts` | Create | RecordingInterviewer tests |
| `test/interviewer/auto-approve.test.ts` | Create | AutoApproveInterviewer tests |
| `test/handlers/wait-human.test.ts` | Create | Wait.human handler tests |
| `test/fixtures/human-gate.dot` | Create | Human gate fixture |
| `test/fixtures/human-timeout.dot` | Create | Human timeout fixture |
| `test/integration/human-gate.test.ts` | Create | End-to-end human gate tests |
| `test/engine/engine.test.ts` | Modify | Tests for GAP-08, GAP-09, GAP-10, GAP-11, GAP-26 |
| `test/engine/conditions.test.ts` | Modify | Tests for preferred_label variable |
| `test/garden/parse.test.ts` | Modify | Tests for default blocks, block comments, h/d units |
| `test/garden/validate.test.ts` | Modify | Tests for hexagon shape acceptance |
| `docs/compliance-report.md` | Modify | Mark closed gaps |

---

## Definition of Done

- [ ] `npm run build && npm test` passes with zero errors
- [ ] **GAP-08 fixed:** Goal gates accept both `success` and `partial_success` (unit tested)
- [ ] **GAP-26 fixed:** `failure` status does not trigger retry; only `retry` status and exceptions do (unit tested)
- [ ] **GAP-09:** `allow_partial=true` nodes return `partial_success` when retries exhausted (unit tested)
- [ ] **GAP-10:** Nodes inherit `default_max_retries` from graph when `max_retries` is not set (unit tested)
- [ ] **GAP-11:** Built-in context keys (`outcome`, `preferred_label`, `graph.goal`, `current_node`, `internal.retry_count.<id>`) are set automatically (unit tested via condition expressions)
- [ ] **GAP-13:** `node [shape=box]` and `edge [weight=0]` default blocks apply to subsequent declarations (unit tested)
- [ ] **GAP-15:** Preferred label comparison is normalized: lowercase, trimmed, accelerator-stripped (unit tested)
- [ ] **GAP-16:** `preferred_label=approve` works in edge conditions (unit tested)
- [ ] **GAP-17:** Block comments `/* ... */` are stripped, including multi-line (unit tested)
- [ ] **GAP-20:** `timeout="2h"` and `timeout="1d"` parse correctly (unit tested)
- [ ] **Interviewer:** All 5 implementations exist and are tested
- [ ] **Wait.human:** Hexagon nodes pause execution and present choices
- [ ] **Accelerator keys:** `[Y] Yes` labels allow typing `Y` to select (unit tested)
- [ ] **Timeout:** Hexagon with `timeout` and `default_choice` auto-selects on expiry (unit tested)
- [ ] **Auto-approve:** `pollinator run --auto-approve` runs without human interaction
- [ ] **Integration:** Full pipeline with hexagon node runs end-to-end using QueueInterviewer
- [ ] **Events:** `human_question` and `human_answer` events emitted and rendered
- [ ] Compliance report updated with 12 gap closures
- [ ] All existing tests continue to pass (regression gate)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| ConsoleInterviewer stdin handling is tricky (raw mode, line buffering, signal conflicts) | High | Medium | Use Node.js `readline` interface with `createInterface()`. Test manually on macOS + Linux. Fall back to line-based input if raw mode fails. |
| Timeout countdown conflicts with ora spinners | Medium | Low | Pause spinner before presenting human gate, resume after answer. Human gates are explicitly synchronous pauses. |
| Injecting Interviewer through engine → registry → handler adds coupling | Medium | Medium | Use a lightweight factory pattern: registry constructor accepts an `InterviewerFactory` (or just the instance). Keep the interface narrow. |
| GAP-26 retry policy change breaks existing pipelines that rely on `failure` triggering retry | Medium | High | This is a spec-compliance fix. Document the behavioral change. Existing fixtures that depend on `failure` retry must be updated to use `retry` status or explicit `max_retries` > 0. Migration is straightforward. |
| Node/edge default blocks interact poorly with the custom parser's line-by-line approach | Medium | Medium | Default blocks are syntactically distinct (`node [...]` / `edge [...]` without `->` or assignment). Pattern-match these before normal node parsing. Test with complex DOT files. |
| Accelerator prefix parsing is ambiguous (e.g., `[A] Ambiguous [B] label`) | Low | Low | Only parse accelerator from the START of a label. First match wins. Document the supported patterns. |
| Scope creep — 12 gaps is ambitious for one sprint | Medium | Medium | Phase 1-2 are small fixes (each gap is <50 LOC). Phase 3-4 are the real work. If behind schedule, defer GAP-13 (default blocks) and GAP-17 (block comments) — they're parser niceties, not blocking features. |

---

## Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| Sprint 001 + 002 | Internal | Engine, parser, handlers, edge selector, condition evaluator must be working |
| Node.js `readline` | Built-in | For ConsoleInterviewer stdin handling |
| No new npm packages | — | All implementations use Node.js built-ins + existing dependencies |
| Attractor spec Section 4.6, 6 | Upstream | Wait.human handler and Interviewer interface specification |

No new external dependencies. The Interviewer system is pure TypeScript using Node.js built-in `readline` for console I/O.
