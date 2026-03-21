# Sprint 025: Zero Gaps & Seed-to-Execution Bridge — Green Suite, Spec Compliance, and Linked Work

## Overview

**Goal:** Achieve a green test suite, close all remaining compliance gaps, and bridge the Seedbed to execution so that seeds can link to gardens, launch runs, and track their lifecycle on disk. After this sprint, `npm test` passes with zero failures, the compliance report shows zero unimplemented features, and a seed can tell an agent or human exactly what work it spawned.

**Why this sprint, why now:**

1. **The red suite is the project's biggest liability.** Four test failures have survived Sprints 022, 023, and 024. Each sprint declared test fixes as non-negotiable, then shipped feature work on top of a failing suite anyway. This sprint inverts the approach: the test failures are not a prerequisite — they are a primary deliverable. No feature phase begins until `npm test` reports zero failures. The diagnosis-first methodology — instrument, reproduce, root-cause, fix — replaces the bump-timeout approach that has failed three times.

2. **The failures are real bugs, not flaky tests.** `pipeline-events` fails because the engine does not emit `PipelineFailedEvent` — a missing code path, not timing. The three timeouts (`gardens-draft`, `hive-run-flow`, `fan-in-llm`) share a pattern: async flows that never resolve, pointing to promise lifecycle or resource cleanup bugs in the server layer.

3. **Only 4 compliance gaps remain, and all are completable.** GAP-1 (AUDIO/DOCUMENT content types), GAP-2 (Gemini extended tools), GAP-3 (edit_file fuzzy matching), and GAP-4 (incremental JSON in streamObject). Closing these means the compliance report — the project's primary success metric per INTENT.md §5.1 — shows zero unimplemented features for the first time.

4. **The Seedbed contract is half-true.** `SeedMeta` already defines `linked_gardens` and `linked_runs`, but nothing writes them. A seed cannot reliably tell an agent or a human what work it actually spawned. The three pillars (Gardens, Seeds, Runs) are still too disconnected: a user cannot move naturally from "this idea matters" to "run the linked garden now."

5. **Zero gaps + seed linkage unlocks the product-facing roadmap.** With spec compliance achieved and seeds connected to execution, future sprints can focus on product polish: Hive triage views, `nectar upgrade`, shell completions, dark mode, and real-world pipeline testing.

**Gaps closed:**

| Gap | Source | Effort | Impact |
|-----|--------|--------|--------|
| 4 persistent test failures (Sprints 022–024) | validation-report.md | High | Green suite — prerequisite for trustworthy CI |
| `pipeline_failed` emission bug | attractor-spec §9.6 | Medium | Correct failure observability for CLI, Hive, and SSE consumers |
| GAP-1: AUDIO/DOCUMENT content types | unified-llm-spec §3.3–3.4 | Small | Complete content type model for future multimodal pipelines |
| GAP-2: Gemini extended tools (read_many_files, list_dir) | coding-agent-loop-spec §3.6 | Small | Full Gemini provider profile |
| GAP-3: edit_file fuzzy matching | coding-agent-loop-spec §3.3 | Medium | Fewer agent retry loops on whitespace mismatches |
| GAP-4: Incremental JSON parsing in streamObject() | unified-llm-spec §4.6 | Medium | Progressive structured output rendering in Hive |
| Seed-to-garden linkage and run provenance | INTENT.md §4 | Medium | Seeds become truthful sources of work history |

**Cut line:** If the sprint compresses, cut in this order:
1. GAP-4 (incremental JSON) — UX optimization, not blocking
2. GAP-1 (AUDIO/DOCUMENT) — no provider fully uses these today
3. Phase 7 CLI parity (`nectar swarm`, `nectar seed link`) — backend still works without CLI sugar

Do **not** cut the test fixes, GAP-2, GAP-3, or the seed linkage backbone. The test fixes are the reason this sprint exists. GAP-2 and GAP-3 directly improve agent quality-of-life. Seed linkage is the product-facing deliverable.

**Out of scope:**

- Hive List and Timeline views (follow-up sprint — backend ships now, UI later)
- CLI distribution features (`nectar upgrade`, shell completions, install script)
- Hive UI polish (kanban drag-and-drop, dark mode)
- New handler types or engine features
- Automatic `honey` archiving on successful run completion
- `web_search` and `web_fetch` tools (not in compliance gaps; significant SSRF/scope concerns)
- Homebrew tap, Windows support

---

## Use Cases

1. **Green CI gate:** A contributor opens a PR. `npm test` passes with zero failures. The contributor can trust that any new failure is caused by the PR, not by pre-existing regressions.

2. **Pipeline failure observability:** A garden node fails and no failure edge exists. The engine emits `stage_failed` → `pipeline_failed` → `run_error` in order. The Hive shows a red banner. The CLI prints the failure reason. The SSE journal records all three events for replay.

3. **Draft SSE lifecycle:** A user clicks "Generate Garden" in the Hive. The server streams `draft_start`, `content_delta*`, `draft_complete`. The loading spinner stops on `draft_complete`. Currently the SSE stream hangs.

4. **Link a seed to a garden:** A user opens Seed #42 in the Hive and links it to `gardens/rate-limiting.dot`. `meta.yaml` records the relationship, and an agent reading the filesystem can see it without querying the server.

5. **Launch work from the Seedbed:** The user clicks "Run Linked Garden" from the seed detail panel. Nectar starts the pipeline, appends the new run ID to `linked_runs`, records a `run_started` entry in `activity.jsonl`, and promotes the seed from `sprouting` to `blooming`.

6. **Resume work without losing provenance:** A linked run is interrupted. From the same seed detail panel, the user resumes it. The activity log shows both the interruption and the resume, and the run remains attached to the seed.

7. **Understand what happened later:** An agent opens `seedbed/042-rate-limiting/meta.yaml` and `activity.jsonl` and can answer: which garden is linked, which runs were launched, and whether the latest run succeeded or failed.

8. **Edit file whitespace recovery:** An agent tries `edit_file` but `old_string` has spaces where the file has tabs. Instead of immediately erroring and entering a retry loop, `edit_file` normalizes whitespace, finds exactly one match, and performs the replacement. The response includes `fuzzy_matched: true`.

9. **Gemini batch file reading:** A Gemini codergen node calls `read_many_files` to read 5 source files in one tool call instead of 5 sequential `read_file` calls. `list_dir` provides directory structure without shelling out.

10. **PDF analysis pipeline:** A future pipeline sends a PDF document to Claude for analysis. The unified client correctly serializes the `DOCUMENT` content part. The Anthropic adapter converts it to Claude's `document` content block format.

---

## Architecture

### Diagnosis-First Approach for Test Failures

Previous sprints treated test failures as checklist items. This sprint treats them as a debugging investigation with a strict protocol:

**Step 1 — Instrument.** Add diagnostic logging to the server/SSE layer:
- Log SSE response stream open/close lifecycle
- Log `draft_complete` event dispatch vs. arrival at SSE writer
- Log HTTP request handler return vs. response end
- Log fan-in LLM call initiation, schema validation, and completion

**Step 2 — Reproduce deterministically.** Run each failing test in isolation with `--reporter=verbose`. Capture the exact stall point.

**Step 3 — Root-cause analysis.** The hypothesized root causes:

- **`pipeline-events`:** The engine does not emit `PipelineFailedEvent` when the pipeline reaches a terminal failure state via a failure edge. It only emits it when edge selection fails. Fix: emit `pipeline_failed` in the finalization path when the pipeline's terminal status indicates failure. Guard against double-emission.

- **`gardens-draft`:** The `GardenDraftService` streams LLM output to SSE. The mock LLM likely doesn't emit `stream_end`, or the service doesn't close the SSE response after stream completion. Fix the stream lifecycle, not the timeout.

- **`hive-run-flow`:** The most likely stall point is the resume-after-cancel path: if the engine's abort doesn't resolve its promise before the test attempts to resume, the resume hangs waiting for the engine lock.

- **`fan-in-llm`:** The fan-in handler calls `generateObject<FanInSelection>()`. If the mock doesn't return JSON matching the schema, the structured output retry loop hangs. Fix: ensure the mock returns valid `FanInSelection` JSON, or fix the retry loop to have a finite iteration count.

**Step 4 — Verify.** Full suite, zero failures.

### AUDIO/DOCUMENT Content Types (GAP-1)

Extend `ContentKind` in `src/llm/types.ts` with `AUDIO` and `DOCUMENT`. Define `AudioData` and `DocumentData` interfaces. Update adapter serialization:

- **Anthropic:** Serialize `DOCUMENT` as native document blocks. Warn-and-skip `AUDIO` (unsupported by Anthropic).
- **Gemini:** Serialize `AUDIO` and `DOCUMENT` as `inlineData` parts.
- **OpenAI/OpenAI-Compatible:** Warn-and-skip unsupported content types.

### Gemini Extended Tools (GAP-2)

Two new tools, registered only in the Gemini provider profile:

- **`read_many_files`:** Input `{ paths: string[] }`, cap at 20 files, reuse `read_file` logic, concatenate with `=== path/to/file ===` headers. Respects workspace root boundary. Symlinks that escape the workspace are rejected.
- **`list_dir`:** Input `{ path: string, depth?: number }`, default depth 1, tree-formatted output. Respects `.gitignore` if present (falls back to unfiltered listing if not in a git repo). Respects workspace root boundary.

### Edit File Fuzzy Matching (GAP-3)

When exact `indexOf` fails in `edit-file.ts`, fall back to whitespace-normalized matching:

1. Build a normalization function: collapse `\t` to space, collapse consecutive spaces to one, trim trailing whitespace per line.
2. Normalize both `old_string` and the full file content.
3. Find the match in normalized content.
4. If exactly one match: use a parallel character-offset index (built during normalization) to map the normalized range back to the original content. Perform the replacement on the original.
5. If zero or 2+ matches: return the existing error. No behavior change for ambiguous cases.
6. On fuzzy success: include `fuzzy_matched: true` in the response so the agent knows.

Note: `new_string` is inserted as-is. The fuzzy match only applies to locating `old_string`. The fallback is attempted only after exact matching fails — zero performance impact on the happy path.

### Incremental JSON Parsing (GAP-4)

Scoped to flat/shallow objects only — the common case for `streamObject()` schemas. Deep nesting falls back to text accumulation.

- `IncrementalJsonParser`: feed chunks, track brace/bracket depth and string state, yield partial objects as top-level key-value pairs complete.
- `streamObject()` yields `{ type: 'partial', object: Partial<T> }` as keys complete and `{ type: 'complete', object: T }` after final AJV validation.
- Falls back to current text-accumulation behavior on parser error. No external dependencies.

### Seed Activity and Linkage

Each seed directory gains an append-only `activity.jsonl`:

```json
{"timestamp":"2026-03-21T15:00:00Z","type":"seed_created","actor":"user"}
{"timestamp":"2026-03-21T15:03:12Z","type":"garden_linked","actor":"user","garden":"gardens/rate-limiting.dot"}
{"timestamp":"2026-03-21T15:04:01Z","type":"run_started","actor":"system","run_id":"...","garden":"gardens/rate-limiting.dot"}
```

Current state stays in `meta.yaml`. History goes in `activity.jsonl`. No database.

**Seed lifecycle rules:**
- Starting or resuming a linked run auto-promotes `seedling`/`sprouting` seeds to `blooming`.
- `honey` and `wilted` are never auto-overridden.
- Successful run completion does **not** auto-set `honey` — it produces a `status_suggestion` only.
- `linked_gardens` is unique, stored as workspace-relative paths.
- `linked_runs` is newest-first, capped at 25 entries.

**Seed-aware run launch:** `POST /seeds/:id/run` validates the seed and garden, starts the pipeline through `RunManager`, persists seed-run and seed-garden links, appends `run_started` to `activity.jsonl`, applies the `blooming` auto-promotion rule, and returns the run ID.

**Services:** `SeedActivityStore` (append, list per-seed, list workspace-wide) and `SeedLifecycleService` (linkGarden, unlinkGarden, attachRun, recordRunTransition, computeStatusSuggestion) keep lifecycle logic out of route handlers.

**Graceful degradation:** Broken garden links (deleted `.dot` files) render as `unknown` rather than crashing. Malformed `activity.jsonl` lines are skipped during reads. Missing linked run directories degrade gracefully.

---

## Implementation

### Phase 1: Diagnose and Fix All Test Failures (~40%)

**Files:** `src/engine/engine.ts`, `src/runtime/garden-draft-service.ts`, `src/server/run-manager.ts`, `src/handlers/fan-in.ts`, `test/server/pipeline-events.test.ts`, `test/server/gardens-draft.test.ts`, `test/integration/hive-run-flow.test.ts`, `test/integration/fan-in-llm.test.ts`

**Tasks:**

**`pipeline-events` — missing `pipeline_failed` emission:**
- [ ] Trace the engine finalization path: identify where `RunCompletedEvent` is emitted on failure-terminal pipelines
- [ ] Add `PipelineFailedEvent` emission in the finalization path when terminal outcome is failure, BEFORE `RunCompletedEvent`
- [ ] Include failing node ID, error message, and final status in the event payload
- [ ] Guard against double-emission when both edge-selection failure and finalization trigger
- [ ] Run `test/server/pipeline-events.test.ts` in isolation — must pass

**`gardens-draft` — SSE stream never completes:**
- [ ] Add tracing to `GardenDraftService.draft()` to locate the stall point
- [ ] Verify the test's mock LLM emits `stream_end`; fix if missing
- [ ] Verify the draft service calls `res.end()` after stream completion
- [ ] If the SSE writer keeps the connection open waiting for more events, add explicit close-on-complete
- [ ] Run `test/server/gardens-draft.test.ts` in isolation — must pass

**`hive-run-flow` — integration timeout:**
- [ ] Add timing markers at each step boundary (preview, save, run, question, cancel, resume, replay)
- [ ] Identify the specific stalling operation
- [ ] If cancel/resume race: ensure engine abort resolves synchronously when no LLM call is in progress
- [ ] If SSE connection leak: ensure EventSource is closed between test steps
- [ ] Run `test/integration/hive-run-flow.test.ts` in isolation — must pass

**`fan-in-llm` — timeout:**
- [ ] Verify the test mock returns valid JSON matching `FanInSelection` schema
- [ ] If `generateObject()` retry loop is unbounded on schema validation failure, add iteration cap
- [ ] Verify abort signal cleanup in the fan-in handler's LLM path
- [ ] Run `test/integration/fan-in-llm.test.ts` in isolation — must pass

**Gate:** `npm test` must report zero failures before Phase 2 begins. This is a hard gate.

### Phase 2: Seed Activity and Linkage Backbone (~20%)

**Files:** `src/seedbed/types.ts`, `src/seedbed/store.ts`, `src/seedbed/activity.ts` (new), `src/seedbed/lifecycle.ts` (new), `src/checkpoint/run-store.ts`, `src/server/types.ts`, `src/server/routes/seeds.ts`, `src/server/run-manager.ts`, `hive/src/components/SeedDetail.ts`, `hive/src/lib/api.ts`, `test/seedbed/activity.test.ts` (new), `test/seedbed/lifecycle.test.ts` (new), `test/server/seeds-run.test.ts` (new), `test/integration/seed-run-linkage.test.ts` (new)

**Tasks:**
- [ ] Add `SeedActivityEvent` types and JSONL serialization helpers
- [ ] Create `SeedActivityStore` with append, per-seed read, and workspace aggregate read
- [ ] Extend `SeedStore.patch()` to support link mutations without clobbering unrelated fields
- [ ] Enforce `linked_gardens` uniqueness and workspace-relative normalization
- [ ] Enforce `linked_runs` newest-first with a hard cap of 25
- [ ] Append activity events for seed creation, edits, status changes, garden link, and garden unlink
- [ ] Handle broken garden links and malformed activity lines gracefully
- [ ] Create `SeedLifecycleService` with linkGarden, unlinkGarden, attachRun, recordRunTransition, computeStatusSuggestion
- [ ] Extend run manifest schema with optional seed metadata (`seed_id`, `seed_dir`, `seed_garden`, `launch_origin`)
- [ ] Add `POST /seeds/:id/run` route
- [ ] Thread seed context through `RunManager.startPipeline()`
- [ ] On seed-aware run start, append run ID to `linked_runs` and record `run_started` activity
- [ ] Apply `seedling|sprouting → blooming` auto-promotion rule on start/resume only
- [ ] Compute and expose `status_suggestion` without mutating `meta.yaml`
- [ ] Extend Hive `SeedDetail` with linked-garden controls, "Run linked garden" action, and recent linked-run summaries
- [ ] Show `status_suggestion` banner with one-click "Move to Honey" action
- [ ] Integration test: link seed → start run → interrupt → resume → complete → filesystem reflects all transitions

### Phase 3: AUDIO/DOCUMENT Content Types — GAP-1 (~8%)

**Files:** `src/llm/types.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/openai-compatible.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/gemini.test.ts`

**Tasks:**
- [ ] Add `AUDIO` and `DOCUMENT` to `ContentKind` enum
- [ ] Define `AudioData` interface: `{ url?: string; data?: string; media_type: string }`
- [ ] Define `DocumentData` interface: `{ url?: string; data?: string; media_type: string; file_name?: string }`
- [ ] Add `AudioContentPart` and `DocumentContentPart` to the `ContentPart` union
- [ ] Anthropic adapter: serialize `DOCUMENT` as native document blocks; warn-and-skip `AUDIO`
- [ ] Gemini adapter: serialize `AUDIO` and `DOCUMENT` as `inlineData` parts
- [ ] OpenAI adapters: skip unsupported content types with `console.warn`
- [ ] Tests: round-trip each new content part through each adapter; verify skip behavior

### Phase 4: Gemini Extended Tools — GAP-2 (~8%)

**Files:** `src/agent-loop/tools/read-many-files.ts` (new), `src/agent-loop/tools/list-dir.ts` (new), `src/agent-loop/provider-profiles.ts`, `src/agent-loop/tool-registry.ts`, `test/agent-loop/tools/read-many-files.test.ts` (new), `test/agent-loop/tools/list-dir.test.ts` (new)

**Tasks:**
- [ ] Implement `read_many_files`: accept `{ paths: string[] }`, cap at 20 files, reuse `read_file` logic, concatenate with path headers
- [ ] Implement `list_dir`: accept `{ path: string, depth?: number }`, default depth 1, tree-formatted output
- [ ] Register both in Gemini provider profile's `visibleTools`
- [ ] Enforce workspace root boundary (no path traversal); reject symlinks escaping workspace
- [ ] Handle non-git workspaces gracefully in `list_dir` .gitignore filtering
- [ ] Apply standard tool output truncation limits
- [ ] Tests: read multiple files, missing file handling, depth control, path traversal blocking, symlink rejection, output truncation

### Phase 5: Edit File Fuzzy Matching — GAP-3 (~10%)

**Files:** `src/agent-loop/tools/edit-file.ts`, `test/agent-loop/tools/edit-file.test.ts`

**Tasks:**
- [ ] Add `normalizeWhitespace(text: string): string` — collapse tabs to spaces, collapse space runs, trim trailing whitespace per line
- [ ] Build parallel character-offset index during normalization for reverse mapping
- [ ] After exact `indexOf` fails, normalize both `old_string` and file content
- [ ] If exactly one normalized match: map back to original using offset index, replace in original content
- [ ] If zero or 2+ normalized matches: return existing error unchanged
- [ ] Include `fuzzy_matched: true` in success response when fuzzy path was used
- [ ] Tests: tab-vs-space recovery, trailing whitespace recovery, multi-space collapse, no-match still errors, ambiguous match still errors, exact match still preferred

### Phase 6: Incremental JSON Parsing — GAP-4 (~8%)

**Files:** `src/llm/incremental-json.ts` (new), `src/llm/client.ts`, `test/llm/incremental-json.test.ts` (new)

**Tasks:**
- [ ] Implement `IncrementalJsonParser`: feed chunks, track brace/bracket depth and string state, yield partial objects as top-level keys complete
- [ ] Scope to flat/shallow objects (top-level keys with primitive or single-level nested values); fall back on deep nesting
- [ ] Update `streamObject()`: replace text accumulation with parser, yield `{ type: 'partial', object }` events
- [ ] On `stream_end`: full AJV validation, yield `{ type: 'complete', object: T }`
- [ ] Fall back to text accumulation on parser error
- [ ] Tests: flat object, nested objects, arrays, escaped strings, malformed recovery, fallback behavior

### Phase 7: CLI Parity (~6%)

**Files:** `src/cli/index.ts`, `src/cli/commands/seed.ts`, `src/cli/commands/swarm.ts` (new), `test/integration/seed-cli.test.ts`, `test/integration/swarm-cli.test.ts` (new)

**Tasks:**
- [ ] Add `nectar swarm <seed-id>` command with provider selection and `--force`/`--no-attachments` flags
- [ ] Add `nectar seed link <seed-id> <garden-path>` and `nectar seed unlink`
- [ ] Extend `nectar seed show` to display linked gardens, recent linked runs, and status suggestion
- [ ] Keep command output themed but pipe-friendly
- [ ] Integration tests for linking and CLI-triggered swarm analysis

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/engine.ts` | Modify | Emit `PipelineFailedEvent` on failure-terminal pipelines |
| `src/runtime/garden-draft-service.ts` | Modify | Fix draft SSE stream completion lifecycle |
| `src/server/run-manager.ts` | Modify | Fix cancel/resume race, thread seed context |
| `src/handlers/fan-in.ts` | Modify | Fix LLM-prompted selection path |
| `src/seedbed/types.ts` | Modify | Add activity event types |
| `src/seedbed/store.ts` | Modify | Support link mutations |
| `src/seedbed/activity.ts` | Create | Seed activity JSONL store |
| `src/seedbed/lifecycle.ts` | Create | Seed lifecycle service |
| `src/checkpoint/run-store.ts` | Modify | Add seed metadata to run manifest |
| `src/server/types.ts` | Modify | Seed-aware run types |
| `src/server/routes/seeds.ts` | Modify | Add seed-run launch route, extend PATCH/GET |
| `src/llm/types.ts` | Modify | Add AUDIO, DOCUMENT content kinds and data types |
| `src/llm/adapters/anthropic.ts` | Modify | Serialize DOCUMENT, warn-skip AUDIO |
| `src/llm/adapters/gemini.ts` | Modify | Serialize AUDIO/DOCUMENT as inlineData |
| `src/llm/adapters/openai.ts` | Modify | Skip unsupported content types with warning |
| `src/llm/adapters/openai-compatible.ts` | Modify | Skip unsupported content types with warning |
| `src/agent-loop/tools/read-many-files.ts` | Create | Batch file reading for Gemini profile |
| `src/agent-loop/tools/list-dir.ts` | Create | Directory listing for Gemini profile |
| `src/agent-loop/provider-profiles.ts` | Modify | Register new tools in Gemini profile |
| `src/agent-loop/tool-registry.ts` | Modify | Register read_many_files and list_dir |
| `src/agent-loop/tools/edit-file.ts` | Modify | Whitespace-normalized fuzzy matching fallback |
| `src/llm/incremental-json.ts` | Create | Streaming JSON parser for partial object yields |
| `src/llm/client.ts` | Modify | Use incremental parser in streamObject() |
| `src/cli/index.ts` | Modify | Register swarm and seed link/unlink commands |
| `src/cli/commands/seed.ts` | Modify | Add link/unlink subcommands, enhance show |
| `src/cli/commands/swarm.ts` | Create | CLI swarm analysis command |
| `hive/src/components/SeedDetail.ts` | Modify | Linked gardens, run controls, status suggestion |
| `hive/src/lib/api.ts` | Modify | Seed-run launch and link API calls |

**Tests:**

| File | Action | Purpose |
|------|--------|---------|
| `test/server/pipeline-events.test.ts` | Modify | Verify pipeline_failed emission |
| `test/server/gardens-draft.test.ts` | Modify | Fix mock or verify lifecycle fix |
| `test/integration/hive-run-flow.test.ts` | Modify | Fix stall point |
| `test/integration/fan-in-llm.test.ts` | Modify | Fix mock schema or handler cleanup |
| `test/seedbed/activity.test.ts` | Create | Activity append/read, graceful degradation |
| `test/seedbed/lifecycle.test.ts` | Create | Lifecycle rules, status suggestions |
| `test/server/seeds-run.test.ts` | Create | Seed-aware run launch |
| `test/integration/seed-run-linkage.test.ts` | Create | Full link → run → complete lifecycle |
| `test/llm/adapters/anthropic.test.ts` | Modify | DOCUMENT content part tests |
| `test/llm/adapters/gemini.test.ts` | Modify | AUDIO/DOCUMENT content part tests |
| `test/agent-loop/tools/read-many-files.test.ts` | Create | Batch read tests |
| `test/agent-loop/tools/list-dir.test.ts` | Create | Directory listing tests |
| `test/agent-loop/tools/edit-file.test.ts` | Modify | Fuzzy matching tests |
| `test/llm/incremental-json.test.ts` | Create | Incremental JSON parser tests |
| `test/integration/seed-cli.test.ts` | Modify | Seed link/unlink CLI tests |
| `test/integration/swarm-cli.test.ts` | Create | CLI swarm analysis tests |

---

## Definition of Done

**Phase 1: Zero Test Failures**
- [ ] `npm test` passes ALL tests with ZERO failures — no exceptions, no "known failures," no skips
- [ ] The 4 previously failing tests (`pipeline-events`, `gardens-draft`, `hive-run-flow`, `fan-in-llm`) now pass
- [ ] `test/server/pipeline-events.test.ts`: event sequence includes `stage_failed` → `pipeline_failed` → `run_error` in order
- [ ] `test/server/gardens-draft.test.ts`: draft SSE completes within 5s
- [ ] `test/integration/hive-run-flow.test.ts`: full HTTP lifecycle completes within 10s
- [ ] `test/integration/fan-in-llm.test.ts`: LLM fan-in completes within 5s
- [ ] Each fix includes a comment in the code explaining the root cause

**Phase 2: Seed-to-Execution Bridge**
- [ ] `meta.yaml` for an active seed contains truthful `linked_gardens` and recent `linked_runs`
- [ ] Each seed directory has an append-only `activity.jsonl` recording lifecycle events
- [ ] Starting a run from the Seedbed promotes eligible seeds to `blooming`
- [ ] No automatic path silently archives work to `honey`
- [ ] Run manifests include seed linkage metadata when applicable
- [ ] `POST /seeds/:id/run` starts a pipeline and links it to the seed
- [ ] Hive seed detail shows linked gardens, run controls, and status suggestion
- [ ] Broken garden links and malformed activity lines degrade gracefully
- [ ] Integration test proves link → run → interrupt → resume → complete lifecycle

**Phase 3: AUDIO/DOCUMENT (GAP-1)**
- [ ] `AUDIO` and `DOCUMENT` in `ContentKind` enum with data interfaces
- [ ] Anthropic adapter serializes `DOCUMENT`, warns-and-skips `AUDIO`
- [ ] Gemini adapter serializes both to `inlineData`
- [ ] OpenAI adapters warn-and-skip unsupported types
- [ ] Unit tests for each adapter

**Phase 4: Gemini Tools (GAP-2)**
- [ ] `read_many_files` implemented, capped at 20 files, with path headers
- [ ] `list_dir` implemented with configurable depth
- [ ] Both registered in Gemini profile only
- [ ] Both enforce workspace root boundary; symlinks escaping workspace rejected
- [ ] Unit tests for happy path, error cases, and security boundaries

**Phase 5: Fuzzy Matching (GAP-3)**
- [ ] `edit_file` falls back to whitespace-normalized matching when exact fails
- [ ] Parallel offset index maps normalized positions back to original content
- [ ] Exactly-one-match requirement for fuzzy path
- [ ] `fuzzy_matched: true` in response when fuzzy matching was used
- [ ] Zero or 2+ normalized matches returns the original error
- [ ] Unit tests for tab/space, trailing whitespace, ambiguity

**Phase 6: Incremental JSON (GAP-4)**
- [ ] `streamObject()` yields partial objects as top-level keys complete
- [ ] Scoped to flat/shallow objects; deep nesting falls back to text accumulation
- [ ] Full AJV validation on `stream_end`
- [ ] Falls back to text accumulation on parser error
- [ ] Unit tests

**Phase 7: CLI Parity**
- [ ] `nectar swarm <seed-id>` works without the server running
- [ ] `nectar seed link|unlink` works without the server running
- [ ] `nectar seed show` displays linked gardens, runs, and status suggestion
- [ ] Integration tests

**Cross-cutting**
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing + new tests, zero failures
- [ ] No regressions: all previously passing tests continue to pass
- [ ] Compliance report regenerated showing zero open gaps
- [ ] No new npm dependencies

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Test failures have deeper root causes than hypothesized | Medium | High | Phase 1 gets 40% of sprint budget. If diagnosis reveals an architectural issue, invoke the cut line: ship test fixes + GAP-2 + GAP-3 + seed linkage only. |
| Phase 1 overruns budget | Medium | High | Cut line is explicit: drop GAP-4 first, then GAP-1, then CLI parity. Test fixes and seed linkage are non-negotiable. |
| Fixing `pipeline_failed` emission changes behavior other tests depend on | Medium | Medium | Run the full suite after each individual fix, not at the end. |
| Fuzzy matching introduces false positives in repetitive code | Medium | Medium | Require exactly one normalized match. Exact matching always tried first. `fuzzy_matched` flag lets agents verify. |
| Fuzzy matching performance on large files | Low | Low | Normalization only runs after exact match fails. Short-circuit if file exceeds 100K lines. |
| `new_string` inserted with different whitespace conventions than file | Medium | Low | Document that fuzzy matching locates `old_string` only; `new_string` is inserted as-is. Agent responsibility. |
| Race conditions between UI, CLI, and agent writing seed state | Medium | Medium | All writes flow through `SeedStore` patch queue, which serializes per seed. Activity appends use `fs.appendFile` atomicity. |
| `activity.jsonl` grows unbounded | Low | Low | Workspace timeline reads are paginated and bounded. Per-seed reads are bounded by practical seed lifetime. |
| Broken garden links or corrupted activity lines | Medium | Medium | Graceful degradation: broken links show as `unknown`, malformed JSONL lines are skipped. |
| Incremental JSON parser fails on edge cases | Medium | Low | Fall back to current text accumulation on parse error. Scoped to shallow objects only. |
| AUDIO/DOCUMENT types untested against real APIs | High | Low | Unit tests verify serialization format against provider docs. Real API testing happens when pipelines use multimodal content. |
| `read_many_files` with symlinks escaping workspace | Low | Medium | Resolve symlinks and verify they remain within workspace root before reading. |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| No new runtime dependencies | All features use Node.js built-ins and existing deps |
| No new dev dependencies | vitest (existing) for new tests |

Zero new npm dependencies. The incremental JSON parser is implemented in-house. The Gemini tools use `node:fs` and existing execution environment abstractions. Content type additions are pure type definitions with adapter serialization logic. Seed activity uses append-only JSONL with no external store.
