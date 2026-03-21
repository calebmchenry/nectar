# Sprint 029: Zero Red, Zero Gaps — Green Suite, Spec Closure & Shell Completions

## Overview

**Goal:** Fix all 10 failing tests without increasing timeouts, close the single remaining attractor spec gap (`patient` retry preset multiplier), and add shell completions for bash/zsh/fish. After this sprint: CI is green, the compliance report has zero gaps, and the CLI has tab completion for every command.

**Why this sprint, why now:**

1. **The test suite is red and credibility is eroding.** 10 tests fail across 7 files. Sprints 025–028 all declared "green suite" as a goal and did not deliver it. A red suite means nobody trusts the tests, which means nobody trusts the code. This sprint has one non-negotiable gate: `npm test` passes with zero failures before any other work ships.

2. **The failures are well-understood and clustered.** Root-cause analysis reveals exactly 3 independent issues: (a) 4 OpenAI-Compatible adapter tests assert legacy Anthropic-native stop reasons (`end_turn`, `tool_use`) instead of the unified `FinishReasonValue` naming (`stop`, `tool_calls`). (b) 1 OpenAI-Compatible error test expects `OverloadedError` for HTTP 500, but 500 → `ServerError` per the unified-llm-spec; `OverloadedError` is 503. (c) 5 SSE lifecycle bugs — streams never close on run completion/cancellation, causing timeouts in `gardens-draft`, `hive-run-flow`, `http-resume`, `http-server`, and `seed-run-linkage`.

3. **Exactly one spec compliance gap remains.** The `patient` retry preset uses `multiplier: 2.0`; the spec requires `backoff_factor: 3.0`. One line of source, one line of test. Closing it brings the compliance report to zero gaps — the hard requirement in INTENT.md §5.1.

4. **Shell completions are a high-value, low-risk deliverable.** The INTENT.md §4 CLI requirements list shell completions (bash, zsh, fish) as a requirement. Commander has built-in support. This is ~50 lines of code for a meaningful UX improvement that users encounter on day one.

5. **Nothing else should ship while the foundation is cracked.** New features on top of a red suite compound the problem. This sprint is deliberately narrow: fix what's broken, close the last gap, add one small-but-visible feature.

**Out of scope:**
- New LLM response contract features (GenerateResult, StepResult, StreamAccumulator)
- ExecutionEnvironment interface extensions
- Hive UI features, seedbed enhancements
- New HTTP endpoints or server routes
- Refactoring or architecture changes

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` succeeds with zero errors, zero failures, and no test timeout bumps. 132 test files pass. ~1100 tests pass. The suite completes in under 30 seconds.

2. **The compliance report has zero gaps.** Every requirement in the pinned attractor-spec.md, coding-agent-loop-spec.md, and unified-llm-spec.md is implemented, including the `patient` retry preset with `backoff_factor: 3.0`.

3. **Tab completion works out of the box.** A user runs `eval "$(nectar completions bash)"` (or adds it to `.bashrc`), types `nectar r<TAB>`, and gets `run` and `resume`. All subcommands, options, and arguments complete correctly.

4. **SSE streams close when runs terminate.** A caller subscribes to pipeline events via `GET /pipelines/:id/events`. When the run completes, cancels, or fails, the stream emits the terminal event and closes the connection. No dangling connections, no client-side timeouts.

5. **OpenAI-Compatible providers return consistent finish reasons.** A local LLM behind an OpenAI-compatible API (Ollama, LM Studio, vLLM) returns `finish_reason: "stop"`. Nectar's response reports `stop_reason === "stop"`, consistent with how every other adapter normalizes its native stop reasons.

---

## Architecture

### No new architecture — targeted fixes plus one small feature

This sprint introduces no new abstractions or modules. The work is:

- **Test assertion fixes** for the OpenAI-Compatible adapter to match the unified `FinishReasonValue` naming that `GenerateResponse.stop_reason` already returns.
- **Error class mapping fix** so HTTP 500 → `ServerError` and HTTP 503 → `OverloadedError` in both adapter and test.
- **SSE lifecycle fixes** to ensure `res.end()` is called on every terminal path (completion, error, cancellation, client disconnect) in every SSE endpoint.
- **One constant change** in the engine retry module.
- **Shell completions** wired through Commander's command/option metadata.

### Root cause analysis for the 10 failures

**Cluster A — OpenAI-Compatible stop_reason assertions (4 tests)**

`GenerateResponse.stop_reason` is a getter returning `this.finish_reason.reason` — the unified `FinishReasonValue`. The adapter populates `finish_reason` with unified values (`{ reason: 'stop', raw: 'stop' }`). But 4 tests were written before the unified naming convention and assert Anthropic-native values:

| Test | Line | Asserts | Should Assert |
|------|------|---------|---------------|
| translates request/response for text generation | 80 | `'end_turn'` | `'stop'` |
| translates tool calls in non-streaming | 134 | `'tool_use'` | `'tool_calls'` |
| falls back when json_schema unsupported | 288 | `'end_turn'` | `'stop'` |
| streaming tool call end event | 223 | `'tool_use'` | `'tool_calls'` |

Fix: update the 4 test assertions. Zero source code changes needed.

**Cluster B — OpenAI-Compatible error mapping (1 test)**

The test sends HTTP 500 and expects `OverloadedError`. Per the unified-llm-spec error taxonomy: 500/502/504 → `ServerError`, 503 → `OverloadedError`. The adapter correctly maps 500 → `ServerError`. The test expectation is wrong.

Fix: change the 500 assertion to expect `ServerError`; add a 503 case expecting `OverloadedError`.

**Cluster C — SSE lifecycle timeouts (5 tests)**

`gardens-draft`, `hive-run-flow`, `http-resume`, `http-server` (cancel), and `seed-run-linkage` all time out waiting for SSE streams to close. The root cause: SSE route handlers don't call `res.end()` when the underlying run/draft reaches a terminal state.

Fix: in each SSE endpoint, listen for the terminal event (`run_completed`, `pipeline_failed`, `run_interrupted`, `draft_complete`) and call `res.end()` after writing it. Also handle `req.on('close')` to clean up listeners if the client disconnects.

---

## Implementation

### Phase 1: Green Suite — OpenAI-Compatible Adapter (20% of effort)

**Files:** `test/llm/openai-compatible.test.ts`, `src/llm/adapters/openai-compatible.ts`

**Tasks:**
- [ ] Update `test/llm/openai-compatible.test.ts:80` — `stop_reason` assertion from `'end_turn'` to `'stop'`
- [ ] Update `test/llm/openai-compatible.test.ts:134` — `stop_reason` assertion from `'tool_use'` to `'tool_calls'`
- [ ] Update `test/llm/openai-compatible.test.ts:223` — streaming end `stop_reason` assertion from `'tool_use'` to `'tool_calls'` (verify this assertion exists and uses the legacy value)
- [ ] Update `test/llm/openai-compatible.test.ts:288` — `stop_reason` assertion from `'end_turn'` to `'stop'`
- [ ] Fix error mapping test at line 316: change HTTP 500 assertion from `OverloadedError` to `ServerError`
- [ ] Add HTTP 503 test case asserting `OverloadedError`
- [ ] Verify adapter's error handler maps 503 → `OverloadedError`; add the mapping if missing
- [ ] Gate: `npx vitest test/llm/openai-compatible.test.ts` — 0 failures

### Phase 2: Green Suite — Gardens Draft SSE (15% of effort)

**Files:** `src/server/routes/gardens.ts`, `src/runtime/garden-draft-service.ts`, `test/server/gardens-draft.test.ts`

**Tasks:**
- [ ] Trace the draft SSE endpoint: find where events are written to `res`
- [ ] After writing the `draft_complete` event, call `res.end()` to close the stream
- [ ] On error (LLM failure, abort), write an error event and call `res.end()`
- [ ] On client disconnect (`req.on('close')`), clean up event listeners and abort any in-flight LLM call
- [ ] Gate: `npx vitest test/server/gardens-draft.test.ts` — passes without timeout

### Phase 3: Green Suite — Integration SSE Lifecycle (30% of effort)

**Files:** `src/server/routes/pipelines.ts`, `src/server/run-manager.ts`, `src/server/routes/events.ts`, `src/server/workspace-event-bus.ts`

This is the highest-risk phase. The 4 integration tests (`hive-run-flow`, `http-resume`, `http-server`, `seed-run-linkage`) share a root cause but touch different code paths.

**Tasks:**
- [ ] Audit `GET /pipelines/:id/events` SSE handler: identify where `run_completed`, `pipeline_failed`, and `run_interrupted` events are written
- [ ] After writing any terminal event, call `res.end()` to close the SSE connection
- [ ] Audit `POST /pipelines/:id/cancel`: ensure it triggers abort signal → checkpoint save → `run_interrupted` event → `res.end()` on the events stream
- [ ] Handle `req.on('close')` on all SSE endpoints to remove event listeners and prevent memory leaks
- [ ] Audit workspace event SSE (`/events`): ensure it handles terminal run states
- [ ] Gate: run each failing integration test individually, then full suite
  - `npx vitest test/integration/hive-run-flow.test.ts`
  - `npx vitest test/integration/http-resume.test.ts`
  - `npx vitest test/integration/http-server.test.ts`
  - `npx vitest test/integration/seed-run-linkage.test.ts`
- [ ] **Full suite gate:** `npm test` — 0 failures before proceeding to Phase 4

### Phase 4: Last Spec Gap — Patient Retry Preset (5% of effort)

**Files:** `src/engine/retry.ts`, `test/engine/retry.test.ts`

**Tasks:**
- [ ] Change `PATIENT_PRESET.multiplier` from `2.0` to `3.0` at `src/engine/retry.ts:59`
- [ ] Update corresponding test assertion for patient preset multiplier
- [ ] Grep for any other test that computes expected delays using the patient preset multiplier — update if found
- [ ] Gate: `npx vitest test/engine/retry.test.ts` — passes

### Phase 5: Shell Completions (20% of effort)

**Files:** `src/cli/index.ts`, `src/cli/completions.ts` (new), `test/cli/completions.test.ts` (new)

**Tasks:**
- [ ] Add `nectar completions <shell>` subcommand that outputs the completion script to stdout
- [ ] Implement bash completion generator: iterate `program.commands` to emit `complete -F` script with subcommand and option completions
- [ ] Implement zsh completion generator: emit `compdef` function using `_arguments` for each subcommand and its options
- [ ] Implement fish completion generator: emit `complete -c nectar` calls for each subcommand and option
- [ ] Add install instructions to `--help` output: `eval "$(nectar completions bash)"` / `nectar completions zsh > ~/.zfunc/_nectar` / `nectar completions fish > ~/.config/fish/completions/nectar.fish`
- [ ] Test: verify each generated script is syntactically valid (source bash script in `bash -n`, parse zsh with `zsh -n`, parse fish with `fish -n`)
- [ ] Test: verify all subcommands appear in the generated completion scripts

### Phase 6: Final Verification (10% of effort)

**Tasks:**
- [ ] `npm run build` — zero TypeScript errors
- [ ] `npm test` — 0 failures across all test files
- [ ] Verify no test timeout values were increased to achieve green
- [ ] Verify compliance report GAPS section is empty
- [ ] Verify `nectar completions bash` outputs valid bash script
- [ ] Verify `nectar completions zsh` outputs valid zsh script
- [ ] Verify `nectar completions fish` outputs valid fish script

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `test/llm/openai-compatible.test.ts` | Modify | Fix 4 stop_reason assertions + 1 error class assertion |
| `src/llm/adapters/openai-compatible.ts` | Modify | Verify/fix 503 → OverloadedError mapping |
| `src/server/routes/gardens.ts` | Modify | Close SSE stream on draft completion/error/disconnect |
| `src/runtime/garden-draft-service.ts` | Modify | Ensure completion signal propagates to route handler |
| `src/server/routes/pipelines.ts` | Modify | Close SSE streams on run terminal states |
| `src/server/run-manager.ts` | Modify | Cancel flow: abort → checkpoint → terminal event → stream close |
| `src/server/routes/events.ts` | Modify | Handle terminal run states in workspace event SSE |
| `src/server/workspace-event-bus.ts` | Modify | Clean up listeners on stream close |
| `src/engine/retry.ts` | Modify | Patient preset multiplier: 2.0 → 3.0 |
| `test/engine/retry.test.ts` | Modify | Update patient preset test expectation |
| `src/cli/index.ts` | Modify | Register `completions` subcommand |
| `src/cli/completions.ts` | Create | Shell completion script generators for bash/zsh/fish |
| `test/cli/completions.test.ts` | Create | Completion script syntax validation tests |
| `test/server/gardens-draft.test.ts` | Modify | May need assertion alignment if draft output changed |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `npm test` passes with 0 failures across all test files
- [ ] No test timeout values were increased to achieve green
- [ ] `test/llm/openai-compatible.test.ts` — all 4 previously-failing tests pass with unified `FinishReasonValue` assertions
- [ ] HTTP 500 maps to `ServerError`; HTTP 503 maps to `OverloadedError` in the OpenAI-Compatible adapter
- [ ] `test/server/gardens-draft.test.ts` passes without timeout
- [ ] `test/integration/hive-run-flow.test.ts` passes without timeout
- [ ] `test/integration/http-resume.test.ts` passes without timeout
- [ ] `test/integration/http-server.test.ts` — cancel test passes without timeout
- [ ] `test/integration/seed-run-linkage.test.ts` passes without timeout
- [ ] SSE event streams close on pipeline terminal states (completed, failed, interrupted)
- [ ] SSE endpoints clean up on client disconnect (no orphaned listeners)
- [ ] Patient retry preset uses `multiplier: 3.0` matching attractor spec `backoff_factor: 3.0`
- [ ] Compliance report GAPS section is empty — zero remaining gaps
- [ ] `nectar completions bash` outputs a syntactically valid bash completion script
- [ ] `nectar completions zsh` outputs a syntactically valid zsh completion script
- [ ] `nectar completions fish` outputs a syntactically valid fish completion script
- [ ] Completions cover all subcommands and their flags

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE lifecycle fixes are deeper than `res.end()` — event bus wiring or run-manager state machine issues | Medium | High | Instrument with targeted logging before fixing. If architectural, fix the minimum to unblock each test and document deeper debt. Phase 3 gets 30% of effort budget for this reason. |
| The 5 SSE timeout tests have 5 independent root causes, not 1 shared pattern | Medium | High | Start with `gardens-draft` (simplest, isolated). If pipeline SSE issues are independent, prioritize `http-server` cancel and `http-resume` — these test core engine behavior. |
| OpenAI-Compatible streaming `stop_reason` on line 223 also uses legacy naming | Low | Low | Check the streaming path separately. The streaming end event may use a different translation path. |
| Commander's completion support is limited; custom scripts needed | Medium | Medium | Commander exposes `.commands` and `.options()` metadata. Use that to generate scripts directly — no dependency on Commander's built-in completion feature. |
| Shell completion for dynamic args (run IDs, .dot files) is hard to get right | Medium | Low | Ship static completions first (subcommands + flags). Dynamic completions are a follow-up polish item. |
| Patient preset multiplier change alters retry timing for existing pipelines | Low | Low | The `patient` preset is rarely used. Spec compliance is authoritative. |

---

## Cut Line

If the sprint runs long, cut in this order (last cut first):

1. **Phase 5: Shell completions** — Real value but independent of the core health goal. Can be its own micro-sprint.
2. **Phase 4: Patient retry preset** — One-line fix, can ride any future commit.

**Never cut:** Phases 1–3 (green suite). The entire point of this sprint is to make CI green. If green doesn't ship, the sprint failed.

---

## Dependencies

No new runtime dependencies. All changes use existing infrastructure:

| Existing Dependency | Used For |
|---|---|
| `vitest` | Test framework |
| `commander` | CLI framework — command/option metadata for completion generation |
| `src/llm/errors.ts` | Error class hierarchy (ServerError, OverloadedError) |
| `src/llm/types.ts` | GenerateResponse, FinishReason, FinishReasonValue |
| `src/server/*` | SSE endpoint lifecycle |
| `src/engine/retry.ts` | Retry preset constants |
| `docs/upstream/attractor-spec.md` | Source of truth for patient preset parameters |
| `docs/upstream/unified-llm-spec.md` | Source of truth for error taxonomy |
