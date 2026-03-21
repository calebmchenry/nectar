# Sprint 023: Workflow Rules & Hive Run Control

## Overview

**Goal:** Make Nectar's execution surface credible for real workflows, not just happy-path demos. After this sprint, gardens can branch on prior step outputs, artifact values, presence checks, and grouped/negated rules, and the Hive can start, cancel, resume, and replay runs without the current HTTP race conditions.

**Why this sprint, why now:**

1. `docs/INTENT.md` says Nectar's first job is orchestrating multi-step AI workflows. The current condition language is too weak for review gates, score thresholds, and approval loops, which makes the pipeline engine shallower than the product intent.

2. `docs/INTENT.md` also promises that users can run pipelines from the editor and watch them execute in real time. That promise is not met while draft SSE, cancel/resume, and terminal failure replay still have open validation failures.

3. The remaining compliance tail is mostly lower-leverage SDK completeness and agent ergonomics. Those matter, but they are not the load-bearing gaps blocking real Nectar usage today.

4. This is one coherent sprint. The work clusters around a single boundary: edge routing, persisted run state, and HTTP lifecycle control.

**Gaps closed:**

| Gap | Source | Why it matters |
|-----|--------|----------------|
| GAP-1: Condition expression language | `docs/compliance-report.md` | Real pipelines need routing based on step output, numeric scores, and existence checks |
| Hive runtime stability blockers | `docs/sprints/validation-report.md` | Browser run control is not trustworthy until draft/run/cancel/resume/replay are deterministic |

**In scope:**

- Rich condition parsing and evaluation: `&&`, `||`, `NOT`, `=`, `!=`, `<`, `>`, `<=`, `>=`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `EXISTS`, and parentheses for grouping
- Variable resolution for `outcome`, `preferred_label`, `context.*`, `steps.<node_id>.status`, `steps.<node_id>.output`, and `artifacts.<key>`
- A persisted step-result index and artifact alias map so conditions survive resume and do not scrape arbitrary files at routing time
- Syntax validation plus targeted semantic warnings for invalid step references and invalid comparison literals
- HTTP lifecycle hardening for cancel-before-engine-ready, resume-after-cancel, terminal event journaling/replay, and finite draft SSE streams
- Regression coverage for the currently failing HTTP tests plus new condition-routing tests

**Out of scope:**

- New Hive UI surfaces or interaction patterns
- AUDIO / DOCUMENT content parts in the unified LLM client
- The high-level `generate()` automatic tool loop
- Gemini extended native tools
- `edit_file.replace_all`, glob mtime sorting, quota/stream error subtypes, and SessionConfig tail fields

**Cut line:** If the sprint compresses, cut any new inspection or polish endpoints first. Do not cut the condition engine, persisted step state, or the HTTP lifecycle fixes. Those are the load-bearing deliverables.

---

## Use Cases

1. **Review-driven branching:** A garden routes `review -> merge [condition="steps.review.output CONTAINS \"approved\""]` and `review -> fix [condition="NOT (steps.review.output CONTAINS \"approved\")"]`. This is a core Nectar workflow, not an edge case.

2. **Numeric release gating:** A scoring step writes a score artifact and the garden routes `qa -> ship [condition="artifacts.qa.score >= 0.85"]` and `qa -> improve [condition="artifacts.qa.score < 0.85"]`.

3. **Presence-based control flow:** A manager node can branch on `EXISTS context.stack.child.run_id` or `EXISTS artifacts.plan.response` instead of abusing empty-string comparisons.

4. **Immediate cancel from the Hive:** User clicks Run and then Cancel before the engine has fully attached. The request does not 409. The run becomes interrupted and can be resumed cleanly.

5. **Resume after API cancel:** A run interrupted by `POST /pipelines/:id/cancel` can be resumed through `POST /pipelines/:id/resume` without racing the run manager's internal state.

6. **Failure replay after refresh:** A browser reconnecting to `GET /pipelines/:id/events` after a failure still receives `stage_failed`, `pipeline_failed`, and `run_error` in order from the journal.

7. **Finite draft stream:** `POST /gardens/draft` emits `draft_start`, one or more `content_delta` events, and exactly one terminal event (`draft_complete` or `draft_error`), then closes the response.

8. **Tab-local draft replacement:** Starting a second draft from the same Hive tab aborts the first one cleanly instead of leaving a hanging SSE response.

---

## Architecture

### Design Principles

1. **Treat the compliance report as the local acceptance contract.** There is a mismatch between the richer condition gap described in `docs/compliance-report.md` and the narrower checked-in attractor condition grammar. This sprint explicitly ratifies the richer local contract in code and tests instead of leaving the ambiguity unresolved.

2. **Parse once, evaluate many.** Richer conditions should not be reparsed ad hoc during edge selection. Validation and execution must share one parser and one evaluator.

3. **Step outputs are indexed, not scraped.** Routing should not read arbitrary `response.md` or log files off disk on every transition. The engine should persist bounded step summaries as first-class run state.

4. **Artifact routing uses stable aliases, not filenames.** Conditions like `artifacts.qa.score` should resolve through a logical alias map, not through brittle path conventions.

5. **Run control needs an internal lifecycle state.** Public API status can stay `running` / `interrupted` / `failed` / `completed`, but the server needs finer internal states to handle booting and cancellation races correctly.

6. **Terminal events must be replayable before the server declares a run done.** If the journal does not contain the terminal envelope yet, the run is not actually done from the browser's perspective.

### Condition Engine

Replace the current string-splitting parser with a small recursive-descent parser and a typed AST. The language stays deliberately small, but it becomes real:

```ts
type ConditionExpr =
  | { type: 'or'; left: ConditionExpr; right: ConditionExpr }
  | { type: 'and'; left: ConditionExpr; right: ConditionExpr }
  | { type: 'not'; expr: ConditionExpr }
  | { type: 'exists'; key: ConditionKey }
  | { type: 'predicate'; key: ConditionKey; op: Operator; value: Literal };
```

Opinionated semantics:

- `NOT` has higher precedence than `&&`, and `&&` has higher precedence than `||`
- Parentheses are included in this sprint even though they are not explicitly called out in the compliance gap; adding `NOT` without grouping is a trap
- `=` / `!=` / string match operators are case-sensitive
- `<`, `>`, `<=`, `>=` are numeric-only. If either side cannot be parsed as a number, the predicate evaluates false
- `EXISTS` operates on a key reference, not on arbitrary subexpressions
- Missing keys resolve to empty string; `EXISTS` on a missing key is false

### Persisted Step State

Introduce a compact step-result index in the checkpoint:

```ts
interface StepResultState {
  node_id: string;
  status: NodeStatus;
  output_preview?: string;
  output_artifact_id?: string;
  updated_at: string;
}

interface Cocoon {
  // existing fields...
  step_results?: Record<string, StepResultState>;
  artifact_aliases?: Record<string, string>;
}
```

Opinionated rule: **last execution wins per node ID.** Routing cares about the latest known state for a step, not about reconstructing a full audit trail from the condition engine. The full audit trail already exists in node directories, artifacts, and event journals.

Handler normalization:

- `codergen` records the response preview as the step output and registers `<node_id>.response`
- `tool` records a stdout preview first, then stderr fallback, and registers `<node_id>.stdout` / `<node_id>.stderr`
- `wait.human` records the selected label as the step output
- `fan-in` registers its rationale output under a deterministic alias

Routing uses `output_preview`, not the full artifact payload. This is intentional. The condition engine must stay cheap, deterministic, and resume-safe.

### Artifact Alias Resolution

Add an artifact alias map alongside the existing artifact store. Conditions resolve `artifacts.<key>` by:

1. Looking up `<key>` in `artifact_aliases`
2. Loading the artifact payload through `RunStore`
3. Returning a bounded text value to the evaluator

No raw file paths in condition expressions. That would couple routing logic to implementation details of run directories and break the "filesystem is the API" discipline by encouraging undocumented path conventions.

### Run Lifecycle Hardening

`RunManager` gains a private lifecycle state per active run:

```ts
type ActiveLifecycle = 'booting' | 'running' | 'cancelling' | 'terminal';
```

Key behaviors:

- `POST /pipelines/:id/cancel` during `booting` stores `pending_abort_reason="api_cancel"` instead of returning 409
- `on_engine` immediately applies any pending abort once the engine is available
- `resume` rejects only while lifecycle is truly active (`booting`, `running`, `cancelling`)
- terminal state is entered only after the terminal event has been appended and flushed to the journal

### SSE and Journal Barrier

The HTTP server should treat terminal events as a two-step commit:

1. Append and flush the terminal envelope to `events.ndjson`
2. Update in-memory entry state and allow SSE handlers to close

This removes the current class of bugs where `GET /pipelines/:id` says a run is terminal but `GET /pipelines/:id/events` still cannot replay the terminal event set.

### Module Layout

```text
src/
├── engine/
│   ├── condition-parser.ts        # NEW: tokenizer + AST parser
│   ├── conditions.ts              # MODIFY: validation/evaluation facade
│   ├── edge-selector.ts           # MODIFY: richer condition scope
│   ├── step-state.ts              # NEW: StepResultState helpers
│   ├── engine.ts                  # MODIFY: persist step results and aliases
│   └── types.ts                   # MODIFY: run-state extensions
├── checkpoint/
│   ├── types.ts                   # MODIFY: step_results and artifact_aliases
│   └── run-store.ts               # MODIFY: read/write migrated checkpoint state
├── handlers/
│   ├── codergen.ts                # MODIFY: response alias registration
│   ├── tool.ts                    # MODIFY: stdout/stderr alias registration
│   ├── wait-human.ts              # MODIFY: selected label as output
│   └── fan-in.ts                  # MODIFY: rationale alias registration
├── garden/
│   └── validate.ts                # MODIFY: extended condition diagnostics
├── server/
│   ├── event-journal.ts           # MODIFY: terminal flush helpers
│   ├── run-manager.ts             # MODIFY: lifecycle state and pending cancel
│   └── routes/
│       ├── pipelines.ts           # MODIFY: replay/close semantics
│       └── gardens.ts             # MODIFY: draft SSE cleanup
└── runtime/
    └── garden-draft-service.ts    # MODIFY: abort-safe terminal behavior

test/
├── engine/conditions.test.ts
├── integration/conditional-routing.test.ts
├── integration/http-resume.test.ts
├── integration/hive-run-flow.test.ts
├── server/gardens-draft.test.ts
└── server/pipeline-events.test.ts
```

---

## Implementation phases

### Phase 1: Freeze the Condition Contract & Parser (~25%)

**Files:** `src/engine/condition-parser.ts`, `src/engine/conditions.ts`, `src/garden/validate.ts`, `test/engine/conditions.test.ts`, `test/garden/validate.test.ts`

**Tasks:**

- [ ] Replace the current string-splitting logic with a tokenizer plus recursive-descent parser
- [ ] Support `NOT`, parentheses, comparison operators, string operators, and `EXISTS`
- [ ] Keep one shared parser for both validation and runtime evaluation
- [ ] Add validation diagnostics for malformed expressions and warnings for `steps.<node_id>.*` references to nonexistent nodes
- [ ] Add tests for precedence, grouping, escaping, numeric coercion, and missing-key semantics

### Phase 2: Persist Step Results & Artifact Aliases (~25%)

**Files:** `src/engine/step-state.ts`, `src/engine/edge-selector.ts`, `src/engine/engine.ts`, `src/engine/types.ts`, `src/checkpoint/types.ts`, `src/checkpoint/run-store.ts`, `src/handlers/codergen.ts`, `src/handlers/tool.ts`, `src/handlers/wait-human.ts`, `src/handlers/fan-in.ts`, `test/integration/conditional-routing.test.ts`

**Tasks:**

- [ ] Add `step_results` and `artifact_aliases` to the canonical checkpoint format with backward-compatible optional fields
- [ ] Record a bounded `output_preview` after every node completion
- [ ] Register deterministic artifact aliases from first-party handlers
- [ ] Extend edge selection to evaluate conditions against `context`, `step_results`, and artifact aliases
- [ ] Add integration coverage for routing based on `steps.<id>.status`, `steps.<id>.output`, and `artifacts.<key>`

### Phase 3: Harden HTTP Run Control (~35%)

**Files:** `src/server/run-manager.ts`, `src/server/event-journal.ts`, `src/server/routes/pipelines.ts`, `src/server/routes/gardens.ts`, `src/runtime/garden-draft-service.ts`, `test/server/gardens-draft.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/server/pipeline-events.test.ts`

**Tasks:**

- [ ] Add internal lifecycle tracking for `booting`, `running`, `cancelling`, and `terminal`
- [ ] Replace "not ready for cancellation yet" 409s with queued abort intent during boot
- [ ] Ensure terminal events are appended and flushed before status transitions are considered final
- [ ] Fix SSE replay so terminal events are always replayable and terminal streams close immediately after replay
- [ ] Make draft SSE responses always finish with exactly one terminal event and a closed response
- [ ] Turn the four currently failing HTTP/runtime tests green without relaxing assertions

### Phase 4: Validate the Whole Surface (~15%)

**Files:** `src/cli/commands/validate.ts`, `test/integration/*.test.ts`, `docs/sprints/validation-report.md`

**Tasks:**

- [ ] Ensure `nectar validate` surfaces the richer condition diagnostics without degrading existing output
- [ ] Add at least one fixture garden that demonstrates review-output routing and numeric threshold routing
- [ ] Run `npm test`, `npm run build`, and `bun build --compile`
- [ ] Update the sprint validation report with before/after evidence for the HTTP blockers

---

## Files Summary

| File | Change | Purpose |
|------|--------|---------|
| `src/engine/condition-parser.ts` | Create | Tokenizer and AST parser for the richer condition language |
| `src/engine/conditions.ts` | Modify | Shared validation/evaluation facade over parsed expressions |
| `src/engine/edge-selector.ts` | Modify | Evaluate conditions against richer runtime scope |
| `src/engine/step-state.ts` | Create | Helpers for step result snapshots and alias registration |
| `src/engine/engine.ts` | Modify | Persist step results, artifact aliases, and resume-safe routing state |
| `src/engine/types.ts` | Modify | Extend run-state and condition-scope contracts |
| `src/checkpoint/types.ts` | Modify | Add optional `step_results` and `artifact_aliases` |
| `src/checkpoint/run-store.ts` | Modify | Read/write the migrated checkpoint format and artifact alias state |
| `src/handlers/codergen.ts` | Modify | Normalize response output into step-result and alias state |
| `src/handlers/tool.ts` | Modify | Normalize stdout/stderr into step-result and alias state |
| `src/handlers/wait-human.ts` | Modify | Treat selected label as a first-class step output |
| `src/handlers/fan-in.ts` | Modify | Register deterministic rationale output for downstream routing |
| `src/garden/validate.ts` | Modify | Extended syntax diagnostics and semantic warnings |
| `src/server/run-manager.ts` | Modify | Internal lifecycle state machine and pending-cancel handling |
| `src/server/event-journal.ts` | Modify | Terminal flush/replay barrier helpers |
| `src/server/routes/pipelines.ts` | Modify | Correct terminal replay and SSE close behavior |
| `src/server/routes/gardens.ts` | Modify | Deterministic draft SSE completion and tab-local abort cleanup |
| `src/runtime/garden-draft-service.ts` | Modify | Abort-safe streaming and terminal-event guarantees |
| `test/engine/conditions.test.ts` | Modify | Parser/evaluator regression coverage |
| `test/integration/conditional-routing.test.ts` | Create | End-to-end routing coverage for step and artifact conditions |
| `test/server/gardens-draft.test.ts` | Modify | Lock draft SSE completion behavior |
| `test/integration/http-resume.test.ts` | Modify | Lock cancel/resume semantics |
| `test/integration/hive-run-flow.test.ts` | Modify | Lock full browser run-control flow |
| `test/server/pipeline-events.test.ts` | Modify | Lock `stage_failed` / `pipeline_failed` / `run_error` replay behavior |

---

## Definition of Done

- [ ] Condition expressions support `NOT`, parentheses, comparison operators, string operators, and `EXISTS`
- [ ] `steps.<node_id>.status`, `steps.<node_id>.output`, and `artifacts.<key>` resolve during both fresh execution and resume
- [ ] Unknown `steps.<node_id>` references produce validation warnings; malformed condition syntax produces validation errors
- [ ] Step-result persistence is backward-compatible with existing cocoons
- [ ] `POST /pipelines/:id/cancel` no longer 409s for a freshly-created run that has not attached its engine yet
- [ ] `POST /pipelines/:id/resume` succeeds after API cancellation and the run reaches the expected terminal state
- [ ] Failure runs replay `stage_failed`, `pipeline_failed`, and `run_error` in order from `GET /pipelines/:id/events`
- [ ] `POST /gardens/draft` always terminates the SSE response with exactly one terminal event
- [ ] The four HTTP/runtime failures in `docs/sprints/validation-report.md` are green without loosening the tests
- [ ] `npm test`, `npm run build`, and `bun build --compile` all pass

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Condition grammar grows into an underspecified mini-language | Medium | High | Keep the operator set fixed to this sprint's contract. No regex, no function calls, no implicit type inference beyond numeric comparison coercion. |
| `steps.<id>.output` bloats checkpoints | Medium | Medium | Persist only bounded previews plus artifact IDs. Full payloads remain in node files and the artifact store. |
| Old cocoons fail to resume after checkpoint-shape changes | Low | High | Keep `step_results` and `artifact_aliases` optional and defaultable. Add backward-compat tests for legacy cocoons. |
| Cancel/resume race is fixed in one path but not all paths | Medium | High | Add internal lifecycle state, not ad hoc booleans. Cover both direct HTTP tests and the broader Hive integration flow. |
| Artifact alias semantics are too vague for future custom handlers | Medium | Medium | Ship deterministic first-party aliases now and document that custom alias authoring is a follow-up, not a hidden contract. |
| Compliance target remains ambiguous because the checked-in attractor condition grammar is narrower than the report | High | Medium | Explicitly ratify the richer local condition contract in tests and validation output during Phase 1. |

---

## Dependencies

1. **Acceptance target:** The team must explicitly accept that `docs/compliance-report.md`, not the narrower checked-in attractor condition excerpt, is the sprint acceptance target for the condition language. This needs to be decided up front.

2. **Filesystem-first persistence:** The sprint depends on keeping run state in `checkpoint.json`, node directories, and the artifact store. No database or hidden server-only state is introduced.

3. **Backward compatibility discipline:** Existing run directories and cocoons must remain readable. New fields must be optional and additive.

4. **Loopback-capable HTTP tests:** The integration suite depends on being able to bind a local server. CI and local validation must preserve the current loopback assumptions.

5. **No new runtime dependency unless the parser becomes unmaintainable.** The default plan is an internal recursive-descent parser. Pull in a parsing library only if the implementation becomes materially clearer and smaller; do not reach for a dependency by reflex.
