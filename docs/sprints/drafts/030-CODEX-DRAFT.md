# Sprint 030: Runtime Truthfulness — SSE Closure, Human Gates & Event Fidelity

## Overview

**Goal:** Make Nectar's runtime surfaces tell the truth end-to-end. After this sprint, the engine, cocoon, and HTTP/SSE APIs all expose the same state: live runs report `current_node`, terminal SSE streams close deterministically, human gates round-trip spec-shaped answers, codergen and wait.human write the context keys the spec actually names, parallel/fan-in share a canonical `parallel.results` contract, and checkpoints/events carry the missing runtime metadata.

**Why this sprint, why now:**

1. **INTENT says Nectar is resumable, observable, and real-time everywhere.** That promise is not credible while `/gardens/draft` and `/pipelines/:id/events` can hang, `/pipelines/:id/context` can miss `current_node`, and the runtime uses non-spec context keys.

2. **The highest-value remaining Attractor gaps are concentrated in one layer.** `docs/compliance-report.md` lists 6 Attractor gaps. They all sit in the runtime contract the Hive and CLI depend on: context keys, answer shape, checkpoint schema, and event payload fidelity. This is one coherent sprint, not scattered cleanup.

3. **Another agent-loop or LLM polish sprint would be the wrong order.** Provider-native prompts and adapter taxonomy matter, but they are lower leverage than a runtime that closes its streams, preserves failure events, and writes truthful checkpoints.

4. **The current red server/runtime tests are the same problem expressed as symptoms.** SSE closure, `current_node` visibility, and failure replay are not separate "test issues." They are runtime contract bugs. Fix them as product behavior, not as test whack-a-mole.

**Scope:** Close Attractor gaps 1-6 from `docs/compliance-report.md` and fix the adjacent runtime regressions on the same surfaces: SSE closure, live `current_node`, and failure event replay/order.

**Out of scope:**
- Coding-agent-loop provider prompt fidelity and `provider_options()`
- Unified LLM adapter cleanup (`Message.name`, `Usage.total_tokens`, `stop_sequences`, etc.)
- New HTTP endpoints, CLI commands, or Hive UI features
- Visual redesign, dark mode, or kanban polish
- Packaging/distribution work (`bun build --compile`, shell completions, install flow)

This sprint is deliberately opinionated: **finish the Attractor runtime contract before touching lower-level AI polish.**

---

## Use Cases

1. **The Hive can trust a run stream.** A browser opens `GET /pipelines/:id/events`, receives replay plus live events, sees exactly one terminal event (`run_completed`, `pipeline_failed`, `run_interrupted`, or `run_error`), and the stream closes immediately after that terminal event.

2. **Live context is actually live.** During a long-running tool or codergen node, `GET /pipelines/:id/context` returns a context object that includes `current_node` without waiting for the run to finish or the next checkpoint to land.

3. **Cancel and resume remain first-class.** A user cancels an active run, gets an interrupted cocoon with `interruption_reason=api_cancel`, then resumes it without losing truthful event history or context.

4. **Human gates round-trip a real answer model.** Console, queue, auto-approve, callback, and HTTP-backed interviewers all return a normalized answer with `value`, `selected_option`, and `text` where appropriate. Freeform answers no longer have to masquerade as labels.

5. **Wait.human writes the keys downstream logic expects.** After a human gate, conditions and later nodes can read `context["human.gate.selected"]` and `context["human.gate.label"]` instead of node-specific ad hoc keys.

6. **Codergen nodes expose the last useful output.** Conditions and fan-in prompts can rely on `context.last_stage` and `context.last_response` after a codergen step.

7. **Parallel/fan-in use a canonical contract.** Parallel execution writes `parallel.results` as the canonical key. Fan-in reads that key first, so later consumers stop depending on a node-specific quirk.

8. **Checkpoints and events are rich enough for debugging.** Cocoon files include a `logs` manifest, `node_started` includes a traversal `index`, and `run_completed` includes `artifact_count`.

---

## Architecture

### Runtime State Must Have One Canonical Shape

The runtime currently leaks implementation-specific keys at exactly the places INTENT says must be agent-readable and browser-readable. This sprint standardizes the canonical surface:

- `last_stage`
- `last_response`
- `human.gate.selected`
- `human.gate.label`
- `parallel.results`
- `current_node`

Routes, renderers, and tests may keep compatibility shims for one sprint, but the engine and handlers must write the canonical names.

### Human Answers Should Be Normalized Once

The current flat answer model is too weak for HTTP-backed gates and freeform input. The canonical shape should be:

```ts
type AnswerValue = 'YES' | 'NO' | 'SKIPPED' | 'TIMEOUT';

interface Answer {
  value?: string | AnswerValue;
  selected_option?: {
    key: string;
    label: string;
    accelerator?: string;
    edge_target?: string;
  };
  text?: string;
  source: 'user' | 'timeout' | 'auto' | 'queue' | 'queue_exhausted';
}
```

Opinionated rule: **the API may accept legacy `selected_label` input for compatibility, but it must not remain the persisted source of truth.** Normalize at the boundary, then store the real shape in `QuestionStore` and emit that shape through the rest of the system.

### Finite SSE Streams Must Close Themselves

Do not scatter `res.end()` branches across route handlers. `createFiniteSseStream()` already exists and should own the terminal-state behavior:

- If a live terminal event is sent, close the stream.
- If replay emits a terminal event, close the stream.
- If the client disconnects, abort work and detach listeners exactly once.
- If a run is already terminal before subscription, replay and close immediately.

The draft stream and pipeline event stream are both finite streams. Treat them that way.

### Checkpoints Should Point At Logs, Not Duplicate Them

Add `logs: string[]` to the cocoon as a manifest of relative paths under the run directory. This keeps checkpoints self-describing without bloating them with inline stdout, prompt, or response content. The list should be generated from files Nectar already writes:

- `checkpoint.json`
- `manifest.json`
- per-node `prompt.md`, `response.md`, `status.json`
- tool attempt logs
- question JSON files
- artifact files when present

### Compatibility Strategy

This sprint changes hot-path runtime schemas. Do not require migration scripts.

- Old cocoons without `logs` must still load.
- Old pending question files with `{ selected_label, source }` must still load.
- `parallel.results.<node_id>` can remain as a temporary read-only fallback while `parallel.results` becomes canonical.

---

## Implementation phases

### Phase 1: Runtime Closure & Green Server Suite (~35%)

**Files:** `src/server/sse.ts`, `src/server/routes/gardens.ts`, `src/server/routes/pipelines.ts`, `src/server/run-manager.ts`, `src/server/event-journal.ts`, `test/server/gardens-draft.test.ts`, `test/server/pipeline-events.test.ts`, `test/integration/http-server.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/http-resume.test.ts`, `test/integration/seed-run-linkage.test.ts`

**Tasks:**
- [ ] Reproduce the current runtime failures first. No schema work begins until the SSE and `current_node` regressions are understood on the existing code.
- [ ] Make `createFiniteSseStream()` close deterministically for both live terminal events and replayed terminal events.
- [ ] Ensure `/gardens/draft` emits exactly one terminal event and never leaves the response open after `draft_complete` or `draft_error`.
- [ ] Ensure `/pipelines/:id/events` closes immediately after replaying or sending a terminal pipeline event.
- [ ] Make `RunManager.getContext()` prefer the live engine snapshot, then active-entry `current_node`, then checkpoint state. Do not return a running context without `current_node`.
- [ ] Preserve `stage_failed -> pipeline_failed -> run_error` ordering in both live streams and replayed journals.
- [ ] Add regression coverage for already-terminal runs opening `/pipelines/:id/events`.
- [ ] Gate: `npx vitest test/server/gardens-draft.test.ts test/server/pipeline-events.test.ts test/integration/http-server.test.ts test/integration/hive-run-flow.test.ts test/integration/http-resume.test.ts test/integration/seed-run-linkage.test.ts`
- [ ] Gate: `npm test` must be green before Phase 2 lands. This sprint does not stack new runtime work on a knowingly red suite.

### Phase 2: Human Gate Answer Contract (~25%)

**Files:** `src/interviewer/types.ts`, `src/interviewer/auto-approve.ts`, `src/interviewer/callback.ts`, `src/interviewer/console.ts`, `src/interviewer/queue.ts`, `src/interviewer/recording.ts`, `src/server/http-interviewer.ts`, `src/server/question-store.ts`, `src/server/types.ts`, `src/server/routes/pipelines.ts`, `src/handlers/wait-human.ts`, `test/interviewer/interviewer.test.ts`, `test/interviewer/ask-multiple.test.ts`, `test/server/http-interviewer.test.ts`, `test/integration/http-human-gate.test.ts`, `test/handlers/wait-human.test.ts`

**Tasks:**
- [ ] Introduce `AnswerValue` and expand `Answer` to include `selected_option` and `text`.
- [ ] Add real FREEFORM handling in interviewer implementations instead of forcing every answer through `selected_label`.
- [ ] Keep API backward compatibility by accepting legacy `{ selected_label }` on `POST /pipelines/:id/questions/:qid/answer`, but normalize immediately to the canonical answer shape.
- [ ] Update `QuestionStore` persistence so stored question answers are canonical and older flat answers still parse.
- [ ] Update `HttpInterviewer` and `QuestionStore` timeout paths so timeout answers become `value='TIMEOUT'`, not ad hoc label-only results.
- [ ] Update `WaitHumanHandler` to derive `preferred_label` and `suggested_next` from the normalized answer object and set both `human.gate.selected` and `human.gate.label`.
- [ ] Ensure `human_answer` events preserve the real answer source (`user`, `timeout`, `auto`, `queue`) instead of hardcoding `user`.
- [ ] Add regression tests for queue exhaustion, timeout with default choice, freeform answer capture, and HTTP answer submission with both legacy and canonical payloads.

### Phase 3: Engine Context Contract (~20%)

**Files:** `src/handlers/codergen.ts`, `src/handlers/parallel.ts`, `src/handlers/fan-in.ts`, `src/engine/parallel-results.ts`, `src/engine/engine.ts`, `test/handlers/codergen.test.ts`, `test/handlers/parallel.test.ts`, `test/handlers/fan-in.test.ts`, `test/integration/parallel.test.ts`, `test/integration/conditions.test.ts`

**Tasks:**
- [ ] Make `CodergenHandler` set `last_stage=input.node.id`.
- [ ] Make `CodergenHandler` set `last_response` to a truncated excerpt of the final text per the spec contract.
- [ ] Keep `${node.id}.response` only as a compatibility alias if an existing consumer still depends on it; do not treat it as canonical.
- [ ] Make `ParallelHandler` write canonical `parallel.results`.
- [ ] Update `FanInHandler` to read `parallel.results` first and fall back to `parallel.results.<node_id>` only for backward compatibility.
- [ ] Update any engine resume/cleanup paths that explicitly strip or restore `last_stage`, `last_response`, or parallel results so they honor the canonical keys.
- [ ] Add routing coverage for conditions that inspect `context.last_stage` and `context.last_response`.
- [ ] Add regression coverage that fan-in succeeds from canonical `parallel.results` without relying on a node-specific suffix.

### Phase 4: Checkpoint & Event Fidelity (~15%)

**Files:** `src/checkpoint/types.ts`, `src/checkpoint/cocoon.ts`, `src/checkpoint/run-store.ts`, `src/engine/events.ts`, `src/engine/engine.ts`, `src/server/types.ts`, `test/checkpoint/cocoon.test.ts`, `test/server/pipeline-events.test.ts`, `test/integration/http-server.test.ts`

**Tasks:**
- [ ] Add `logs: string[]` to `Cocoon` as an optional backward-compatible field.
- [ ] Populate the log manifest during checkpoint writes using relative paths under the run directory.
- [ ] Add 1-based traversal `index` to `node_started`.
- [ ] Add `artifact_count` to `run_completed`.
- [ ] Ensure `pipeline_failed` and `run_error` are both persisted and replayed without duplication.
- [ ] Ensure `current_node` is preserved consistently across active state, cocoon state, cancel, and resume.
- [ ] Add cocoon tests that verify old checkpoints without `logs` still load and new checkpoints include the manifest.

### Phase 5: Honest Verification & Report Update (~5%)

**Files:** `docs/compliance-report.md`, affected test files, generated assets if build output changes

**Tasks:**
- [ ] Run `npm run build` and `npm test` on a clean checkout.
- [ ] Verify old question files and old cocoons still load without migration.
- [ ] Update the Attractor section in `docs/compliance-report.md` only after code and tests land. Remove the closed Attractor gaps and leave remaining coding-agent-loop / unified-llm gaps explicitly intact.
- [ ] Do not claim zero-gap compliance if non-runtime gaps remain.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/sse.ts` | Modify | Make finite SSE streams close deterministically for live and replayed terminal events |
| `src/server/routes/gardens.ts` | Modify | Ensure draft SSE emits one terminal event and always closes |
| `src/server/routes/pipelines.ts` | Modify | Align event streaming and question-answer HTTP boundaries with canonical runtime contracts |
| `src/server/run-manager.ts` | Modify | Expose live `current_node`, preserve failure event ordering, and keep active/replayed state consistent |
| `src/server/event-journal.ts` | Modify | Keep replay behavior deterministic around terminal events |
| `src/interviewer/types.ts` | Modify | Introduce `AnswerValue` and richer `Answer` shape |
| `src/interviewer/console.ts` | Modify | Support canonical multiple-choice and freeform answers |
| `src/interviewer/auto-approve.ts` | Modify | Return normalized auto-approved answers |
| `src/interviewer/callback.ts` | Modify | Normalize callback-provided answers |
| `src/interviewer/queue.ts` | Modify | Return canonical queue / queue-exhausted answers |
| `src/interviewer/recording.ts` | Modify | Persist richer answers without lossy conversion |
| `src/server/http-interviewer.ts` | Modify | Bridge HTTP-backed human gates to the normalized answer model |
| `src/server/question-store.ts` | Modify | Persist canonical answers and keep backward-compatible reads |
| `src/server/types.ts` | Modify | Update stored question and pipeline API types |
| `src/handlers/wait-human.ts` | Modify | Set `human.gate.selected` / `human.gate.label` and map normalized answers into routing |
| `src/handlers/codergen.ts` | Modify | Set `last_stage` / `last_response` |
| `src/handlers/parallel.ts` | Modify | Emit canonical `parallel.results` |
| `src/handlers/fan-in.ts` | Modify | Consume canonical `parallel.results` with fallback compatibility |
| `src/checkpoint/types.ts` | Modify | Add cocoon `logs` manifest field |
| `src/checkpoint/cocoon.ts` | Modify | Read/write cocoon metadata with backward compatibility |
| `src/checkpoint/run-store.ts` | Modify | Materialize the log manifest from files already written during runs |
| `src/engine/events.ts` | Modify | Add `node_started.index` and `run_completed.artifact_count` |
| `src/engine/engine.ts` | Modify | Emit truthful runtime events and canonical context updates |
| `test/server/gardens-draft.test.ts` | Modify | Lock draft SSE terminal behavior |
| `test/server/pipeline-events.test.ts` | Modify | Lock failure event ordering and replay truth |
| `test/integration/http-server.test.ts` | Modify | Verify live `current_node`, cancel, checkpoint, and context behavior |
| `test/integration/hive-run-flow.test.ts` | Modify | Verify browser-facing pipeline SSE closure |
| `test/integration/http-resume.test.ts` | Modify | Verify cancel/resume with finite event streams |
| `test/integration/seed-run-linkage.test.ts` | Modify | Verify linked runs survive truthful interrupt/resume flows |
| `test/integration/http-human-gate.test.ts` | Modify | Verify HTTP human gates round-trip canonical answers |
| `test/handlers/wait-human.test.ts` | Modify | Verify human-gate context keys and answer mapping |
| `test/handlers/codergen.test.ts` | Modify | Verify `last_stage` / `last_response` context updates |
| `test/handlers/parallel.test.ts` | Modify | Verify canonical `parallel.results` emission |
| `test/handlers/fan-in.test.ts` | Modify | Verify fan-in reads canonical parallel results |
| `test/checkpoint/cocoon.test.ts` | Modify | Verify `logs` manifest and backward-compatible checkpoint reads |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `npm test` passes with zero failures
- [ ] `GET /gardens/draft` emits exactly one terminal event and closes immediately after it
- [ ] `GET /pipelines/:id/events` closes automatically after replaying or sending a terminal pipeline event
- [ ] Opening `/pipelines/:id/events` for an already-terminal run replays the journal and then closes without hanging
- [ ] `GET /pipelines/:id/context` during an active run always includes `current_node`
- [ ] Failure streams preserve `stage_failed -> pipeline_failed -> run_error` ordering in both live delivery and replay
- [ ] `WaitHumanHandler` writes `human.gate.selected` and `human.gate.label`
- [ ] Interviewer implementations and `QuestionStore` persist canonical answers with `value`, `selected_option`, and `text` where appropriate
- [ ] Legacy HTTP answer payloads using `selected_label` still work
- [ ] FREEFORM human answers round-trip through the HTTP interviewer without being forced into label-only shape
- [ ] `CodergenHandler` writes `last_stage` and `last_response`
- [ ] `ParallelHandler` writes canonical `parallel.results`
- [ ] `FanInHandler` succeeds when only canonical `parallel.results` is present
- [ ] New cocoons include `logs`
- [ ] Old cocoons without `logs` still load
- [ ] `node_started` includes a traversal `index`
- [ ] `run_completed` includes `artifact_count`
- [ ] Cancelled runs still checkpoint with `interruption_reason=api_cancel`
- [ ] `docs/compliance-report.md` is updated to remove the closed Attractor gaps only after the code/tests prove them closed

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Answer schema changes ripple into HTTP, CLI, stored question files, and tests | High | High | Normalize at the boundary, accept both legacy and canonical input for one sprint, and keep backward-compatible readers in `QuestionStore` |
| Canonical `parallel.results` breaks older fan-in tests or resumed runs | Medium | Medium | Read canonical first, keep `parallel.results.<node_id>` as a temporary fallback alias during the transition |
| SSE close logic accidentally terminates persistent streams or double-closes connections | Medium | High | Keep finite vs persistent behavior explicit in `src/server/sse.ts` and make close idempotent |
| `current_node` still races during bootstrap before the first `node_started` event | Medium | High | Prefer live engine snapshots, preserve active-entry state, and add a regression test that queries context immediately after run start |
| Adding `artifact_count` by scanning the filesystem is slow or flaky | Low | Medium | Derive counts from files Nectar already writes or from `RunStore`, not from a broad recursive walk at terminal time |
| Cocoon `logs` manifest drifts from actual files | Medium | Medium | Build the manifest from known write points and verify existence in checkpoint tests |
| Updating `docs/compliance-report.md` too early recreates the project's "zero gaps" credibility problem | Medium | High | Make report edits a final phase deliverable, never a planning assumption |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing `createFiniteSseStream()` and router layer | Deterministic finite SSE behavior without introducing a new streaming stack |
| `RunManager` + `EventJournal` | Active-state tracking and replay ordering for pipeline events |
| `QuestionStore` + interviewer implementations | Human-gate persistence and answer normalization |
| `RunStore` / cocoon persistence | Backward-compatible checkpoint evolution |
| Existing Vitest suites under `test/server`, `test/integration`, `test/handlers`, `test/interviewer`, and `test/checkpoint` | Acceptance harness for this sprint |
| New third-party packages | None |
