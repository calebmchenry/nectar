# Sprint NEXT: Fidelity Runtime & Run Artifacts

## Overview

**Goal:** Turn Nectar's parsed context-fidelity model into a real execution contract and give every run a formal, inspectable directory with manifest, checkpoint, and artifacts. After this sprint, codergen nodes will either reuse an LLM thread or start from a deterministic carryover preamble based on resolved fidelity, resumed runs will degrade exactly one hop after `full` fidelity, and future HTTP/UI work will have a stable file-backed run surface to build on.

**Why this sprint, why now:**

- `A4` and `A5` are the highest-leverage remaining Attractor gaps because they affect every serious multi-stage codergen workflow, not one specialty handler.
- `A3`, `A8`, and `A10` are the storage and observability substrate that fidelity needs. Without them, carryover, resume, and debugging stay ad hoc.
- This sprint is deliberately **not** the manager-loop sprint. A supervisor over child pipelines is the wrong next layer if the parent runtime still cannot faithfully preserve and reconstruct stage context.
- The unified LLM client already has enough core capability for this work. Structured output, middleware, model catalog, and provider-specific niceties are lower leverage than fixing the execution contract.

**Gaps closed:**

| Gap | Severity | Description |
|-----|----------|-------------|
| A4 | Medium | Runtime enforcement of `full`, `truncate`, `compact`, and `summary:*` fidelity |
| A5 | Medium | `thread_id` resolution and session reuse for `full` fidelity |
| A3 | Low | Formal `ArtifactStore` API with file-backed threshold |
| A8 | Low | `CheckpointSaved` event |
| A10 | Low | `manifest.json` in the run directory |
| C3 | Low | Mid-session `reasoning_effort` changes on reused sessions |

**Total:** 2 MEDIUM + 4 LOW gaps closed in one sprint.

**In scope:**

- Exact runtime fidelity resolution: edge -> node -> graph default -> `compact`
- Exact `thread_id` resolution for `full` fidelity
- One-hop resume degradation from `full` to `summary:high`
- Run-scoped `SessionRegistry` for thread reuse
- Deterministic preamble synthesis for non-`full` modes
- Formal `ArtifactStore` with `store()`, `retrieve()`, `has()`, `list()`, `remove()`, `clear()`
- Canonical `manifest.json` and `checkpoint.json` in the run directory
- `CheckpointSaved` event emission after successful checkpoint writes
- CLI compatibility for `status` and `resume` with the new run directory layout

**Out of scope:**

- A1 manager loop handler (`house` / `stack.manager_loop`)
- A2 HTTP server mode and SSE endpoints
- A6 `loop_restart`
- A7 tool hooks around LLM tool calls
- A9 `InterviewTimeout`
- A11 `auto_status`
- L4, L7, L8, L9, L10, L11, L20 in the unified LLM client
- Web UI and seedbed-facing work

**Opinionated cut line:** if the sprint runs long, defer extra CLI polish around artifact inspection. Do **not** cut the canonical run directory, fidelity runtime, or session reuse pieces. Those are the actual sprint.

---

## Use Cases

1. **Stateful plan -> implement -> review thread.** A graph uses three `box` nodes with `fidelity="full"` and `thread_id="feature-x"`. `plan` creates the session, `implement` reuses it, and `review` reuses it again. The runtime preserves real conversation state instead of faking continuity with a giant pasted summary.

2. **Intentional context reset after a noisy step.** A large implementation node is followed by a cleanup node with `fidelity="compact"` and a release-note node with `fidelity="summary:medium"`. Both start fresh sessions, but each receives deterministic carryover text built from the run log, completed-node outcomes, and selected context values.

3. **Safe resume after interruption.** A run is interrupted after a `full`-fidelity codergen node. On `nectar resume <run-id>`, the runtime restores checkpoint state, sees that the prior hop used a live in-memory thread, and forces the first resumed codergen hop to `summary:high`. After that single degraded hop, later `full` nodes may create or reuse threads again.

4. **Large outputs stop bloating context.** A tool node produces 300KB of stdout and a codergen node returns a long response. The runtime stores both in the formal artifact store, keeps only a short preview plus artifact ID in context, and writes human-readable mirrors in the node directory. Resume and inspection do not depend on giant context blobs.

5. **Runs become inspectable by file layout alone.** A user or future HTTP layer can open `.nectar/cocoons/<run-id>/manifest.json`, `.nectar/cocoons/<run-id>/checkpoint.json`, and `artifacts/` to understand what ran, what is pending, and where the large outputs live without reverse-engineering handler-specific files.

---

## Architecture

### Design Principles

1. **Fidelity is an execution-time contract, not a lint hint.** The engine resolves fidelity from the selected incoming edge plus checkpoint state before the handler runs.

2. **`full` means actual session reuse.** If fidelity resolves to `full`, the runtime reuses an `AgentSession`. Every other mode starts a fresh session and receives a generated preamble.

3. **The run directory is the source of truth.** `manifest.json`, `checkpoint.json`, and `artifacts/` become canonical. Existing flat cocoon JSON stays as a compatibility mirror for one sprint so `status` and `resume` do not break mid-migration.

4. **Context stays small and routable.** Large stage outputs belong in artifacts. Context should contain scalar routing values, bounded previews, and artifact IDs, not whole transcripts.

5. **Thread compatibility must be explicit.** A reused thread may change `reasoning_effort` between turns. It may **not** silently switch provider or model. If a thread key is reused with a different provider/model signature, Nectar fails fast with a clear runtime error.

### Canonical Run Layout

```text
.nectar/cocoons/
├── <run-id>.json                  # Compatibility mirror for existing CLI readers
└── <run-id>/
    ├── manifest.json              # Run metadata
    ├── checkpoint.json            # Canonical serialized checkpoint
    ├── artifacts/
    │   ├── index.json             # Artifact metadata + inline small payloads
    │   └── <artifact-id>.json     # File-backed artifacts (>100KB)
    ├── <node-id>/
    │   ├── status.json
    │   ├── prompt.md
    │   ├── response.md
    │   └── tool-calls/
    └── ...
```

`manifest.json` should contain at least:

- `run_id`
- `dot_file`
- `graph_hash`
- `graph_label`
- `goal`
- `started_at`
- `workspace_root`

### Module Layout

```text
nectar/
├── src/
│   ├── artifacts/
│   │   ├── types.ts               # ArtifactInfo, ArtifactRecord
│   │   └── store.ts               # Formal ArtifactStore API
│   ├── checkpoint/
│   │   ├── run-store.ts           # Run directory + manifest + checkpoint writer
│   │   ├── cocoon.ts              # Legacy compatibility wrappers
│   │   └── types.ts               # Cocoon schema + RunManifest
│   ├── engine/
│   │   ├── fidelity.ts            # Fidelity/thread resolution + resume downgrade
│   │   ├── preamble.ts            # Deterministic carryover builders
│   │   ├── session-registry.ts    # run_id + thread_key -> AgentSession
│   │   ├── engine.ts              # Pass resolved plan + ArtifactStore into handlers
│   │   ├── events.ts              # CheckpointSaved event
│   │   └── types.ts               # Pending transition + fidelity metadata
│   ├── handlers/
│   │   ├── codergen.ts            # Thread reuse vs fresh session behavior
│   │   └── tool.ts                # Artifact registration for large stdout/stderr
│   ├── agent-loop/
│   │   └── session.ts             # Next-turn reasoning_effort overrides
│   ├── garden/
│   │   └── validate.ts            # Thread compatibility checks where statically obvious
│   └── cli/
│       ├── commands/
│       │   ├── status.ts
│       │   └── resume.ts
│       └── ui/renderer.ts
├── test/
│   ├── artifacts/store.test.ts
│   ├── engine/fidelity.test.ts
│   ├── integration/fidelity-runtime.test.ts
│   ├── integration/run-store.test.ts
│   └── fixtures/
│       ├── fidelity-full-thread.dot
│       ├── fidelity-summary.dot
│       └── fidelity-resume.dot
```

### Key Abstractions

**`RunStore`**  
Run-scoped file manager responsible for:

- initializing `.nectar/cocoons/<run-id>/`
- writing `manifest.json`
- writing canonical `checkpoint.json`
- dual-writing the legacy `<run-id>.json` mirror during migration
- exposing the run's `ArtifactStore`

**`ArtifactStore`**  
Formal API that matches the spec:

- `store(artifact_id, name, data)`
- `retrieve(artifact_id)`
- `has(artifact_id)`
- `list()`
- `remove(artifact_id)`
- `clear()`

Opinionated implementation detail: small artifacts are persisted inline in `artifacts/index.json`; artifacts larger than 100KB are written to `artifacts/<artifact-id>.json`. This keeps resume durable while still honoring the spec's file-backing threshold.

**`ResolvedFidelityPlan`**  
Computed once per node execution:

- `mode`: `full` | `truncate` | `compact` | `summary:low` | `summary:medium` | `summary:high`
- `thread_key?`: only for `full`
- `resume_degraded`: `true` only for the first resumed hop after a `full` node
- `provider_signature`: `${provider}:${model}`
- `preamble_text?`: generated only for non-`full` modes

**`SessionRegistry`**  
Run-scoped registry keyed by `thread_key`:

- stores active reusable `AgentSession` instances
- stores immutable provider/model signature for each thread
- allows `reasoning_effort` to vary on the next turn without replacing the session
- rejects conflicting provider/model reuse

### Data Flow

```text
selected incoming edge
        │
        ▼
resolve fidelity + thread key + resume downgrade
        │
        ├── full
        │     └── SessionRegistry.get(thread_key)
        │            ├── first use -> session.submit(prompt)
        │            └── reuse -> session.followUp(prompt)
        │
        └── truncate / compact / summary:*
              └── build deterministic preamble -> fresh session.submit(preamble + prompt)

handler outcome + large payloads
        │
        ▼
ArtifactStore.store(...)
        │
        ▼
RunStore.writeCheckpoint(...)
        │
        ├── checkpoint.json
        ├── legacy <run-id>.json mirror
        └── CheckpointSaved event
```

---

## Implementation Phases

### Phase 1: Canonical RunStore & ArtifactStore (~25%)

**Files:** `src/artifacts/types.ts`, `src/artifacts/store.ts`, `src/checkpoint/run-store.ts`, `src/checkpoint/cocoon.ts`, `src/checkpoint/types.ts`, `test/artifacts/store.test.ts`, `test/checkpoint/cocoon.test.ts`

**Tasks:**

- [ ] Create a `RunStore` rooted at `.nectar/cocoons/<run-id>/`.
- [ ] Write `manifest.json` when a run starts with: `run_id`, `dot_file`, `graph_hash`, `graph_label`, `goal`, `started_at`, `workspace_root`.
- [ ] Make `.nectar/cocoons/<run-id>/checkpoint.json` the canonical checkpoint location.
- [ ] Keep dual-write compatibility to `.nectar/cocoons/<run-id>.json` for one sprint so current CLI readers keep working.
- [ ] Implement `ArtifactStore` with `store()`, `retrieve()`, `has()`, `list()`, `remove()`, `clear()`.
- [ ] Persist small artifacts inline in `artifacts/index.json`; spill artifacts larger than 100KB to `artifacts/<artifact-id>.json`.
- [ ] Add round-trip tests for inline artifacts, file-backed artifacts, removal, clear, and canonical-vs-legacy checkpoint reads.

### Phase 2: Fidelity Resolution & Resume Semantics (~25%)

**Files:** `src/engine/fidelity.ts`, `src/engine/types.ts`, `src/engine/engine.ts`, `src/checkpoint/types.ts`, `test/engine/fidelity.test.ts`, `test/integration/resume.test.ts`, `test/fixtures/fidelity-resume.dot`

**Tasks:**

- [ ] Persist the selected incoming edge in checkpoint state as `pending_transition` so edge-level `fidelity` and `thread_id` survive resume.
- [ ] Implement exact fidelity precedence from the upstream spec:
  1. incoming edge `fidelity`
  2. target node `fidelity`
  3. graph `default_fidelity`
  4. fallback default: `compact`
- [ ] Implement exact thread resolution for `full` fidelity:
  1. target node `thread_id`
  2. incoming edge `thread_id`
  3. graph-level default thread
  4. first subgraph-derived class
  5. previous node ID
- [ ] Track the last completed node's fidelity mode in checkpoint state so resume can detect whether the prior hop used `full`.
- [ ] Implement the one-hop resume rule: if the previous node used `full`, force the first resumed codergen node to `summary:high`, then clear the downgrade marker.
- [ ] Emit `checkpoint_saved` immediately after each successful checkpoint write, including interrupted and failed terminal writes.

### Phase 3: Codergen Thread Reuse & Deterministic Preambles (~35%)

**Files:** `src/engine/session-registry.ts`, `src/engine/preamble.ts`, `src/handlers/codergen.ts`, `src/handlers/tool.ts`, `src/agent-loop/session.ts`, `src/garden/validate.ts`, `test/handlers/codergen.test.ts`, `test/handlers/tool.test.ts`, `test/integration/fidelity-runtime.test.ts`, `test/fixtures/fidelity-full-thread.dot`, `test/fixtures/fidelity-summary.dot`

**Tasks:**

- [ ] Create a run-scoped `SessionRegistry` keyed by resolved `thread_key`.
- [ ] Add a next-turn override API to `AgentSession` so `reasoning_effort` can change on the next LLM call without discarding the session. Provider and model remain fixed after thread creation.
- [ ] Fail fast if a thread key is reused with a different provider/model signature. Do not silently reopen or replace the session.
- [ ] `full` fidelity behavior:
  - first use of a thread -> create session and `submit()`
  - later use of the same thread -> reuse session and `followUp()`
  - no synthetic preamble
- [ ] Non-`full` fidelity behavior:
  - always create a fresh session
  - prepend deterministic carryover text
  - close the session after the node completes
- [ ] Implement deterministic preamble builders with hard budgets:
  - `truncate`: graph goal, run ID, and minimal state only
  - `compact`: structured bullets for completed nodes, outcomes, retries, and selected context
  - `summary:low`: brief textual summary, target ~600 tokens
  - `summary:medium`: moderate detail, target ~1500 tokens
  - `summary:high`: detailed summary, target ~3000 tokens
- [ ] Prefer recent failures, human answers, retries, and semantic context keys; exclude noisy internal blobs and large raw outputs.
- [ ] Store generated preambles as artifacts so users can inspect exactly what context was carried into each fresh session.
- [ ] Register large tool stdout/stderr and large codergen responses with `ArtifactStore`; keep only bounded previews plus artifact IDs in context.

### Phase 4: CLI Compatibility & Regression Sweep (~15%)

**Files:** `src/engine/events.ts`, `src/cli/commands/status.ts`, `src/cli/commands/resume.ts`, `src/cli/ui/renderer.ts`, `test/integration/run-store.test.ts`, `test/integration/run.test.ts`

**Tasks:**

- [ ] Update `status` to read canonical run directories first, then fall back to legacy flat cocoon JSON.
- [ ] Update `resume` to prefer canonical `checkpoint.json` and preserve current `--force` graph-hash behavior.
- [ ] Render `checkpoint_saved` tersely in the CLI so checkpoint traffic is visible but not noisy.
- [ ] Add integration coverage for:
  - `full` thread reuse across multiple codergen nodes
  - `compact` and `summary:*` fresh-session behavior
  - one-hop resume degradation after `full`
  - artifact persistence across resume
  - legacy cocoon compatibility during migration

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/artifacts/types.ts` | Create | Define `ArtifactInfo` and persisted artifact record shapes |
| `src/artifacts/store.ts` | Create | Implement formal `ArtifactStore` API and threshold behavior |
| `src/checkpoint/run-store.ts` | Create | Own run directory initialization, manifest, checkpoint, and artifact access |
| `src/checkpoint/types.ts` | Modify | Extend checkpoint schema with `RunManifest`, `pending_transition`, and fidelity metadata |
| `src/checkpoint/cocoon.ts` | Modify | Keep legacy flat cocoon compatibility while delegating to canonical run-store layout |
| `src/engine/fidelity.ts` | Create | Resolve fidelity mode, thread key, and resume downgrade |
| `src/engine/preamble.ts` | Create | Build deterministic carryover text for non-`full` sessions |
| `src/engine/session-registry.ts` | Create | Track reusable `AgentSession` instances by thread key |
| `src/engine/types.ts` | Modify | Add pending-transition and fidelity metadata to runtime state |
| `src/engine/events.ts` | Modify | Add `checkpoint_saved` event type |
| `src/engine/engine.ts` | Modify | Compute fidelity plans, pass run services into handlers, write canonical checkpoints |
| `src/handlers/codergen.ts` | Modify | Reuse sessions for `full`, create fresh sessions for other modes, store preambles as artifacts |
| `src/handlers/tool.ts` | Modify | Register large stdout/stderr payloads with `ArtifactStore` |
| `src/agent-loop/session.ts` | Modify | Allow next-turn `reasoning_effort` changes on a live session |
| `src/garden/validate.ts` | Modify | Warn or error where thread/provider conflicts are statically obvious |
| `src/cli/commands/status.ts` | Modify | Read canonical run directories first |
| `src/cli/commands/resume.ts` | Modify | Resume from canonical `checkpoint.json` with legacy fallback |
| `src/cli/ui/renderer.ts` | Modify | Surface `checkpoint_saved` without clutter |
| `test/artifacts/store.test.ts` | Create | Unit tests for artifact API and threshold behavior |
| `test/checkpoint/cocoon.test.ts` | Modify | Verify canonical and legacy checkpoint compatibility |
| `test/engine/fidelity.test.ts` | Create | Unit tests for fidelity precedence, thread resolution, and resume downgrade |
| `test/handlers/codergen.test.ts` | Modify | Verify session reuse, fresh-session modes, and reasoning-effort overrides |
| `test/handlers/tool.test.ts` | Modify | Verify large tool output is registered as an artifact |
| `test/integration/fidelity-runtime.test.ts` | Create | End-to-end fidelity behavior across multiple codergen nodes |
| `test/integration/run-store.test.ts` | Create | End-to-end run directory, manifest, checkpoint, and artifact layout assertions |
| `test/integration/resume.test.ts` | Modify | Verify one-hop `summary:high` degradation after `full` resume |
| `test/fixtures/fidelity-full-thread.dot` | Create | Fixture for `full` thread reuse |
| `test/fixtures/fidelity-summary.dot` | Create | Fixture for fresh-session summary modes |
| `test/fixtures/fidelity-resume.dot` | Create | Fixture for interruption and degraded resume |

---

## Definition of Done

- [ ] Every run writes `.nectar/cocoons/<run-id>/manifest.json` and `.nectar/cocoons/<run-id>/checkpoint.json`.
- [ ] Existing CLI flows still work during migration because the legacy flat cocoon JSON remains readable.
- [ ] `ArtifactStore` implements `store()`, `retrieve()`, `has()`, `list()`, `remove()`, and `clear()` with unit-test coverage.
- [ ] Artifacts larger than 100KB are file-backed under `artifacts/<artifact-id>.json`.
- [ ] Small artifacts survive process restart because they are persisted in `artifacts/index.json`.
- [ ] Fidelity resolution follows the upstream precedence exactly: edge -> node -> graph default -> `compact`.
- [ ] Thread resolution for `full` fidelity follows the upstream order exactly: node -> edge -> graph default -> subgraph class -> previous node ID.
- [ ] Two codergen nodes that resolve to the same compatible `full` thread key reuse one `AgentSession`.
- [ ] Non-`full` fidelity modes always create fresh sessions and prepend deterministic carryover text.
- [ ] The first resumed codergen hop after a `full` node uses `summary:high`, and only that hop is degraded.
- [ ] Changing `reasoning_effort` across two reused `full`-fidelity nodes takes effect on the next LLM call without discarding the session.
- [ ] Reusing a thread key with a different provider/model signature fails fast with a clear error.
- [ ] Generated preambles are stored as artifacts and stay within the intended budgets for each mode.
- [ ] Large tool or codergen outputs are stored as artifacts; context contains only bounded previews and artifact IDs.
- [ ] `checkpoint_saved` is emitted after every successful checkpoint write.
- [ ] `npm test` passes all existing and new tests.
- [ ] `docs/compliance-report.md` can be updated to mark A3, A4, A5, A8, A10, and C3 as implemented.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Canonical run-directory migration breaks `status` or `resume` on existing cocoons | Medium | High | Dual-write canonical and legacy checkpoint files for one sprint. Read canonical first, legacy second. Add integration tests for both paths. |
| `full` thread reuse across conflicting provider/model settings is ambiguous | Medium | High | Freeze provider/model signature at thread creation and fail fast on mismatch. Only `reasoning_effort` may vary per turn. |
| Deterministic summaries omit context the next node actually needs | Medium | Medium | Bias summaries toward recent failures, retries, human answers, and explicit context keys. Persist the generated preamble as an artifact so it is inspectable and tunable. |
| Artifact duplication bloats run directories | Low | Medium | Keep node-local human-readable mirrors small and treat `ArtifactStore` as the canonical machine-readable payload store. |
| Session registry leaks live sessions on failed or interrupted runs | Medium | Medium | Scope the registry to a single run and dispose it on completion, failure, and interruption paths. Add lifecycle tests. |
| Persisting small artifacts inline makes `artifacts/index.json` grow too large | Low | Medium | Keep the 100KB threshold strict and spill to file-backed artifacts aggressively. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing `AgentSession.submit()` / `followUp()` behavior | Required for `full` fidelity thread reuse |
| Existing unified LLM streaming adapters | Sufficient to support reused and fresh codergen sessions |
| Existing checkpoint and CLI resume plumbing | Base for the canonical run-directory migration |
| Existing transform pipeline (`goal-expansion`, stylesheet application, validation) | Ensures provider/model settings are already resolved before runtime fidelity is applied |
| Existing transcript and node artifact writes | Can be layered under the formal `ArtifactStore` rather than replaced wholesale |

No new npm dependencies should be introduced in this sprint.
