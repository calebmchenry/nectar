# Sprint 023: Condition Expression Language, HTTP Lifecycle Hardening & Agent Loop Polish

## Overview

**Goal:** Ship a complete condition expression language with comparison operators, string matching, existence checks, and full variable references — unlocking real-world conditional routing. Fix the 4 test failures from Sprint 022 by hardening HTTP run lifecycle control. Bundle the trivial GAP-5 (edit_file replace_all) and GAP-6 (glob mtime sorting) fixes that don't justify standalone sprints.

**Why this sprint, why now:**

1. **GAP-1 is the last major engine gap.** Every other engine feature — parallel execution, fan-in, checkpointing, manager loops, composition — is implemented. But conditional routing is crippled: you can't write `steps.review.output CONTAINS "approved"` or `artifacts.score > 0.8` or even check whether a variable exists. Real pipelines need these. This is the single highest-impact remaining gap.

2. **The test suite is red.** The Sprint 022 validation report shows 4 failures: gardens-draft timeout, hive-run-flow timeout, http-resume 409, and pipeline-events missing event. Shipping new features on a failing test suite is unacceptable — new failures become indistinguishable from pre-existing ones. The HTTP lifecycle fixes are load-bearing.

3. **GAP-5 and GAP-6 are trivial to bundle.** `replace_all` is a one-parameter addition. Glob mtime sorting is a stat call and sort. Neither justifies a standalone sprint, but together they meaningfully improve agent ergonomics.

4. **After this sprint, the remaining gaps are low-urgency.** GAP-2 (AUDIO/DOCUMENT content types) supports future modalities no provider fully offers today. GAP-3 (generate() auto tool loop), GAP-7 (error subtypes), and GAP-8 (SessionConfig fields) are SDK polish. GAP-4 (Gemini extended tools) is explicitly optional in the spec.

**Gaps closed:**

| Gap | Source | Effort | Impact |
|-----|--------|--------|--------|
| GAP-1: Condition Expression Language | attractor-spec §10 | Large | Full conditional routing with comparisons, string matching, EXISTS, steps/artifacts refs |
| Sprint 022 test failures (4) | validation-report.md | Medium | Green test suite, trustworthy HTTP run control |
| GAP-5: edit_file replace_all | coding-agent-loop-spec §3.3 | Tiny | Bulk in-file replacements |
| GAP-6: glob mtime sorting | coding-agent-loop-spec §3.3 | Tiny | Recently-modified files surfaced first |

**Deliberately deferred:**

- GAP-2: AUDIO/DOCUMENT content types — no provider fully uses these today
- GAP-3: generate() automatic tool loop — SDK polish, no pipeline blocked
- GAP-4: Gemini extended tools (read_many_files, list_dir) — optional per spec
- GAP-7: QuotaExceeded, StreamError subtypes — SDK polish
- GAP-8: SessionConfig expansion — SDK polish

**Cut line:** If the sprint compresses, cut GAP-5 and GAP-6 first. Do not cut the condition engine, persisted step state, or the HTTP lifecycle fixes. Those are the load-bearing deliverables.

**Out of scope:**

- New CLI commands or Hive UI features
- New handler types
- Changes to parallel/fan-in behavior
- LLM adapter changes

---

## Use Cases

1. **Review-driven branching:** A garden routes `review -> merge [condition="steps.review.output CONTAINS \"approved\""]` and `review -> fix [condition="NOT (steps.review.output CONTAINS \"approved\")"]`. This is a core Nectar workflow, not an edge case.

2. **Numeric release gating:** A scoring step writes a coverage number to context. The condition `context.coverage > 80` routes to `release`; otherwise to `add_tests`. Comparison operators make this expressible.

3. **Artifact existence checks:** A conditional checks `EXISTS artifacts.report` to decide whether to skip report generation. The EXISTS operator eliminates the need for sentinel values.

4. **Presence-based control flow:** A manager node can branch on `EXISTS context.stack.child.run_id` instead of abusing empty-string comparisons.

5. **Immediate cancel from the Hive:** User clicks Run and then Cancel before the engine has fully attached. The request does not 409. The run becomes interrupted and can be resumed cleanly.

6. **Failure replay after refresh:** A browser reconnecting to `GET /pipelines/:id/events` after a failure still receives `stage_failed`, `pipeline_failed`, and `run_error` in order from the journal.

7. **Bulk rename via edit_file:** An agent renames a variable across a file with a single `edit_file` call using `replace_all: true` instead of N individual calls.

8. **Recent files first in glob:** An agent runs `glob("src/**/*.ts")` and gets results sorted newest-first, immediately seeing recently modified files relevant to current work.

---

## Architecture

### Design Principles

1. **Parse once, evaluate many.** Conditions are parsed into a typed AST at validation time and evaluated at runtime. Validation and execution share one parser and one evaluator.

2. **Step outputs are indexed, not scraped.** Routing does not read arbitrary files off disk on every transition. The engine persists bounded step summaries as first-class run state.

3. **Artifact routing uses stable aliases, not filenames.** Conditions like `artifacts.report` resolve through a logical alias map, not through brittle path conventions.

4. **The condition language is deliberately capped.** No regex operators, no arithmetic expressions, no function calls, no implicit type coercion beyond the numeric comparison rule. The operator set is frozen after this sprint.

5. **Run control needs an internal lifecycle state.** The server needs finer internal states (`booting`, `running`, `cancelling`, `terminal`) to handle cancellation races correctly.

6. **Terminal events must be replayable before the server declares a run done.** If the journal does not contain the terminal envelope yet, the run is not actually done from the browser's perspective.

### Condition Expression Language (GAP-1)

Replace the current string-splitting parser in `src/engine/conditions.ts` with a proper recursive-descent parser and typed AST.

**New operators:**
- Comparison: `<`, `>`, `<=`, `>=` (numeric when both sides parse as finite numbers via `Number()`, lexicographic otherwise; `NaN` and `Infinity` are not valid numeric values)
- String matching: `CONTAINS`, `STARTS_WITH`, `ENDS_WITH` (case-sensitive)
- Existence: `EXISTS` (unary prefix, checks variable is defined and non-empty)
- Negation: `NOT` (unary prefix)
- Grouping: `(` `)` (parentheses)

**New variable references:**
- `steps.<nodeId>.status` — resolves to the StageStatus of a completed node
- `steps.<nodeId>.output` — resolves to a bounded output preview (max 1KB) from the persisted step-result index
- `artifacts.<key>` — resolves through the artifact alias map; EXISTS checks presence, comparisons use bounded text value

**Operator precedence** (lowest to highest):
1. `||`
2. `&&`
3. `NOT`
4. Comparison and string matching (`=`, `!=`, `<`, `>`, `<=`, `>=`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`) — same level
5. `EXISTS`
6. Primary (literals, variables, parenthesized sub-expressions)

**AST design:**

```typescript
type Expression =
  | { type: 'literal'; value: string }
  | { type: 'variable'; path: string[] }     // ["steps", "review", "status"]
  | { type: 'binary'; op: BinaryOp; left: Expression; right: Expression }
  | { type: 'unary'; op: 'NOT' | 'EXISTS'; operand: Expression }
  | { type: 'logical'; op: '&&' | '||'; children: Expression[] };

type BinaryOp = '=' | '!=' | '<' | '>' | '<=' | '>='
  | 'CONTAINS' | 'STARTS_WITH' | 'ENDS_WITH';
```

**ConditionScope** expands to include step history and artifact access:

```typescript
export interface ConditionScope {
  outcome: OutcomeStatus;
  preferred_label?: string;
  context: Record<string, string>;
  steps: Record<string, { status: string; output?: string }>;
  artifacts: { has(key: string): boolean; get(key: string): string | undefined };
}
```

**Semantics for edge cases:**
- Missing keys resolve to empty string; `EXISTS` on a missing key is false
- `steps.<id>.output` for nodes that failed, were skipped, or have no response resolves to empty string
- `<`, `>`, `<=`, `>=` with non-numeric operands: if either side cannot be parsed as a finite number, the predicate evaluates **false** (not lexicographic — this is safer and more predictable)
- `EXISTS` operates on variable references only, not on arbitrary sub-expressions

**Backward compatibility:** All existing conditions (`outcome=success`, `context.key=value`, `&&`, `||`) parse identically under the new grammar. The first test file committed must verify every existing condition pattern.

### Persisted Step State

Introduce a compact step-result index in the checkpoint:

```typescript
interface StepResultState {
  node_id: string;
  status: NodeStatus;
  output_preview?: string;   // bounded to 1KB
  output_artifact_id?: string;
  updated_at: string;
}

interface Cocoon {
  // existing fields...
  step_results?: Record<string, StepResultState>;
  artifact_aliases?: Record<string, string>;
}
```

**Last execution wins per node ID.** Routing cares about the latest known state for a step, not a full audit trail. The full audit trail already exists in node directories, artifacts, and event journals.

Handler normalization:
- `codergen` records a bounded response preview as the step output and registers `<node_id>.response`
- `tool` records a stdout preview first, then stderr fallback, and registers `<node_id>.stdout` / `<node_id>.stderr`
- `wait.human` records the selected label as the step output
- `fan-in` registers its rationale output under a deterministic alias

Fields are optional and defaultable for backward compatibility with existing cocoons. The condition evaluator treats missing `step_results` as an empty map.

### Run Lifecycle Hardening

`RunManager` gains a private lifecycle state per active run:

```typescript
type ActiveLifecycle = 'booting' | 'running' | 'cancelling' | 'terminal';
```

Key behaviors:
- `POST /pipelines/:id/cancel` during `booting` stores `pending_abort_reason="api_cancel"` instead of returning 409
- `on_engine` immediately applies any pending abort once the engine is available
- `resume` rejects only while lifecycle is truly active (`booting`, `running`, `cancelling`)
- Terminal state is entered only after the terminal event has been appended and flushed to the journal

SSE and journal barrier: terminal events are a two-step commit — append and flush to `events.ndjson`, then update in-memory state and allow SSE handlers to close. This removes the class of bugs where status says terminal but events can't replay the terminal set.

Draft SSE: `POST /gardens/draft` emits `draft_start`, one or more `content_delta` events, and exactly one terminal event (`draft_complete` or `draft_error`), then closes the response. Starting a second draft from the same tab aborts the first cleanly.

### edit_file replace_all (GAP-5)

Add `replace_all` (optional boolean, default false) to the edit_file tool schema. When true, use `String.prototype.replaceAll()` instead of the single-match logic. Return a count of replacements in the result message. When `old_string` is empty string, reject with an error.

### glob mtime Sorting (GAP-6)

After collecting glob results, `stat()` each file path concurrently via `Promise.allSettled()`. Sort by `mtimeMs` descending (newest first). Files that fail to stat sort to the end. Sort before truncation so the most relevant files survive the max-results cap.

---

## Implementation

### Phase 0: Fix Sprint 022 Test Failures (~20%)

**Files:** `src/server/run-manager.ts`, `src/server/event-journal.ts`, `src/server/routes/pipelines.ts`, `src/server/routes/gardens.ts`, `src/runtime/garden-draft-service.ts`, `test/server/gardens-draft.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/server/pipeline-events.test.ts`

**Tasks:**
- [ ] Add internal lifecycle tracking (`booting`, `running`, `cancelling`, `terminal`) to RunManager
- [ ] Replace "not ready for cancellation yet" 409s with queued abort intent during boot
- [ ] Ensure terminal events are appended and flushed before status transitions are considered final
- [ ] Fix SSE replay so terminal events are always replayable and terminal streams close immediately
- [ ] Make draft SSE responses always finish with exactly one terminal event and a closed response
- [ ] Turn the 4 failing tests green without relaxing assertions
- [ ] **Gate:** `npm test` must be fully green before proceeding to Phase 1

### Phase 1: Condition Expression Language (~40%)

**Files:** `src/engine/conditions.ts`, `src/engine/engine.ts`, `src/engine/types.ts`, `src/garden/validate.ts`, `src/checkpoint/types.ts`, `src/checkpoint/run-store.ts`, `src/handlers/codergen.ts`, `src/handlers/tool.ts`, `src/handlers/wait-human.ts`, `src/handlers/fan-in.ts`, `test/engine/conditions.test.ts`, `test/garden/validate.test.ts`, `test/integration/conditional-routing.test.ts`

**Tasks:**

**Parser & Evaluator:**
- [ ] Design the new AST types (Expression, BinaryOp, etc.) in `conditions.ts`
- [ ] Implement a tokenizer: identifiers, quoted strings, numbers, operators (`=`, `!=`, `<`, `>`, `<=`, `>=`), keywords (`AND`/`&&`, `OR`/`||`, `NOT`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `EXISTS`), parentheses
- [ ] Implement recursive-descent parser: `parseOr` → `parseAnd` → `parseNot` → `parseComparison` → `parseExists` → `parsePrimary`
- [ ] Implement expression evaluator with the expanded `ConditionScope`
- [ ] Numeric comparison: both sides must parse as finite numbers via `Number()` (excluding NaN/Infinity); otherwise predicate is false
- [ ] String matching: `CONTAINS` → `includes()`, `STARTS_WITH` → `startsWith()`, `ENDS_WITH` → `endsWith()`
- [ ] `EXISTS`: variable is defined and non-empty string
- [ ] `NOT`: boolean negation of sub-expression
- [ ] Parentheses: grouping for precedence override
- [ ] **Backward-compat gate:** verify every existing condition pattern in the test suite and garden fixtures parses and evaluates identically under the new parser before writing any new operator tests

**Persisted Step State:**
- [ ] Add `step_results` and `artifact_aliases` to the checkpoint format with backward-compatible optional fields
- [ ] Record a bounded `output_preview` (max 1KB) after every node completion
- [ ] Register deterministic artifact aliases from first-party handlers (codergen, tool, wait.human, fan-in)
- [ ] Update engine to assemble the expanded ConditionScope from `step_results` and artifact aliases before each edge evaluation

**Validation:**
- [ ] Update `validateConditionExpression()` in `validate.ts` to use the new parser (parse-only mode) and report syntax errors with position info
- [ ] Add semantic validation warnings for `steps.<nodeId>` references where `nodeId` is not in the graph (warning, not error — the node might be created by composition)

**Tests:**
- [ ] Unit tests: every new operator in isolation, precedence edge cases, variable resolution for steps/artifacts, backward compatibility, error messages for malformed expressions
- [ ] Integration test: a pipeline with numeric comparison and string-matching conditions routing correctly
- [ ] Resume test: verify `steps.*` conditions evaluate correctly after checkpoint resume

### Phase 2: Agent Loop Quick Fixes — GAP-5, GAP-6 (~10%)

**Files:** `src/agent-loop/tools/edit-file.ts`, `src/agent-loop/tools/glob.ts`

**Tasks:**

**GAP-5: edit_file replace_all**
- [ ] Add `replace_all` (boolean, optional, default false) to edit_file input schema
- [ ] When `replace_all` is true, count occurrences of `old_string`, replace all, report count in result
- [ ] Reject empty `old_string` with `replace_all: true`
- [ ] When `replace_all` is false, preserve existing behavior (error on multiple matches)
- [ ] Unit test: replace_all with 3 occurrences → all replaced, count reported

**GAP-6: glob mtime sorting**
- [ ] After glob results collected, `stat()` each file path concurrently via `Promise.allSettled()`
- [ ] Sort by `mtimeMs` descending (newest first); files failing stat sort to end
- [ ] Sort before applying max-results truncation
- [ ] Unit test: create files with known timestamps → verify sort order

### Phase 3: Validate the Whole Surface (~10%)

**Files:** `docs/sprints/validation-report.md`, all test files

**Tasks:**
- [ ] Run `npm test`, `npm run build`, and `bun build --compile` — all must pass
- [ ] Add at least one fixture garden demonstrating review-output routing and numeric threshold routing
- [ ] Update the sprint validation report with before/after evidence for the HTTP blockers
- [ ] Verify `nectar validate` surfaces the richer condition diagnostics

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/conditions.ts` | Rewrite | Full recursive-descent condition parser with new AST |
| `src/engine/engine.ts` | Modify | Assemble expanded ConditionScope, persist step results |
| `src/engine/types.ts` | Modify | Extend run-state and condition-scope contracts |
| `src/garden/validate.ts` | Modify | Extended condition syntax/semantic diagnostics |
| `src/checkpoint/types.ts` | Modify | Add optional `step_results` and `artifact_aliases` |
| `src/checkpoint/run-store.ts` | Modify | Read/write step results and artifact alias state |
| `src/handlers/codergen.ts` | Modify | Record response preview and artifact alias |
| `src/handlers/tool.ts` | Modify | Record stdout/stderr preview and aliases |
| `src/handlers/wait-human.ts` | Modify | Record selected label as step output |
| `src/handlers/fan-in.ts` | Modify | Register deterministic rationale alias |
| `src/server/run-manager.ts` | Modify | Internal lifecycle state machine and pending cancel |
| `src/server/event-journal.ts` | Modify | Terminal flush/replay barrier helpers |
| `src/server/routes/pipelines.ts` | Modify | Correct terminal replay and SSE close behavior |
| `src/server/routes/gardens.ts` | Modify | Deterministic draft SSE completion |
| `src/runtime/garden-draft-service.ts` | Modify | Abort-safe terminal-event guarantees |
| `src/agent-loop/tools/edit-file.ts` | Modify | Add replace_all parameter |
| `src/agent-loop/tools/glob.ts` | Modify | mtime-based sorting |
| `test/engine/conditions.test.ts` | Rewrite | Comprehensive tests for new parser and evaluator |
| `test/garden/validate.test.ts` | Modify | Add tests for new condition validation |
| `test/integration/conditional-routing.test.ts` | Create | End-to-end pipeline with rich conditions |
| `test/server/gardens-draft.test.ts` | Modify | Lock draft SSE completion behavior |
| `test/integration/http-resume.test.ts` | Modify | Lock cancel/resume semantics |
| `test/integration/hive-run-flow.test.ts` | Modify | Lock full browser run-control flow |
| `test/server/pipeline-events.test.ts` | Modify | Lock terminal event replay behavior |

---

## Definition of Done

**Phase 0: HTTP Lifecycle (Sprint 022 regressions)**
- [ ] `POST /pipelines/:id/cancel` no longer 409s for a freshly-created run that has not attached its engine yet
- [ ] `POST /pipelines/:id/resume` succeeds after API cancellation and the run reaches the expected terminal state
- [ ] Failure runs replay `stage_failed`, `pipeline_failed`, and `run_error` in order from `GET /pipelines/:id/events`
- [ ] `POST /gardens/draft` always terminates the SSE response with exactly one terminal event
- [ ] The 4 test failures from the Sprint 022 validation report are green without loosening assertions

**Phase 1: Condition Expression Language (GAP-1)**
- [ ] `outcome=success && context.key=value` still works identically (backward compat)
- [ ] `context.coverage > 80` evaluates numerically
- [ ] `steps.review.status = "success"` resolves from persisted step-result index
- [ ] `steps.review.output CONTAINS "approved"` matches against bounded output preview
- [ ] `EXISTS artifacts.report` returns true when artifact alias is present
- [ ] `NOT outcome=failure` evaluates correctly
- [ ] `(context.a = "1" || context.b = "2") && outcome=success` respects parentheses
- [ ] `context.name STARTS_WITH "test"` and `ENDS_WITH ".ts"` work
- [ ] Malformed expressions produce clear parse errors with position info
- [ ] Validation warns on `steps.<nodeId>` references to nonexistent graph nodes
- [ ] `steps.*` conditions evaluate correctly after checkpoint resume
- [ ] Step-result persistence is backward-compatible with existing cocoons (missing fields default gracefully)
- [ ] Integration test: pipeline with `>` and `CONTAINS` conditions routes correctly

**Phase 2: Agent Loop (GAP-5, GAP-6)**
- [ ] `edit_file` with `replace_all: true` replaces all occurrences and reports count
- [ ] `edit_file` without `replace_all` preserves existing error-on-multiple behavior
- [ ] `edit_file` with `replace_all: true` and empty `old_string` is rejected
- [ ] glob results are sorted by modification time, newest first
- [ ] Files that fail to stat are included at the end (not dropped)
- [ ] Sort is applied before max-results truncation

**Cross-cutting**
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing and new tests with zero failures
- [ ] `bun build --compile` succeeds
- [ ] No breaking changes to public API signatures (all additions are backward-compatible)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Condition parser rewrite breaks existing expressions | Medium | High | Backward-compat gate: every existing condition pattern must parse identically before any new operator tests are written. Full test suite before and after. |
| Numeric comparison ambiguity | Medium | Medium | Clear rule: both sides must parse as finite numbers via `Number()` (excluding NaN/Infinity); otherwise predicate is false. Documented and tested. |
| `output_preview` truncation causes incorrect routing | Medium | Medium | Bound to 1KB. If the model outputs the routing signal beyond 1KB, the condition will evaluate against empty/truncated text. Document this limit. Consider structured output for critical signals. |
| `steps.*` references not surviving resume | Low | High | Step results are persisted in the checkpoint. Integration test verifies conditions evaluate correctly after resume. Legacy cocoons without `step_results` treated as empty. |
| Cancel/resume race fixed in one path but not all paths | Medium | High | Internal lifecycle state machine (not ad hoc booleans). Cover both direct HTTP tests and the broader Hive integration flow. |
| Condition language feature creep in future sprints | Medium | Medium | Explicit cap in this document: no regex, no arithmetic, no function calls. Operator set is frozen. |
| glob mtime stat() calls slow on large result sets | Medium | Low | Stat calls concurrent via `Promise.allSettled()`. Glob already has max-results cap. Sort before truncation ensures most relevant files survive. |
| Artifact alias collisions between handlers | Low | Medium | Deterministic naming convention: `<node_id>.<artifact_type>`. Document that custom alias authoring is a follow-up. |

---

## Dependencies

| Dependency | Type | Status |
|-----------|------|--------|
| No new packages | Runtime | — |
| Provider API docs for artifact/output contracts | Documentation | Available |

This sprint adds zero new dependencies. The condition parser is hand-written (no parser generator). Step-result persistence extends the existing checkpoint format. HTTP lifecycle changes modify existing server code. All agent loop changes are localized.

The only prerequisite is that the existing codebase (Sprint 022) compiles and the 942 passing tests remain stable. The 4 failing tests are addressed in Phase 0.
