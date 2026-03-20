# Sprint 015: Runtime Fidelity & Canonical Run Artifacts

## Overview

**Goal:** Turn Nectar's parsed `fidelity` and `thread_id` metadata into a real execution contract and make `.nectar/cocoons/<run-id>/` the canonical, inspectable run surface. After this sprint, codergen nodes will either reuse a live `AgentSession` under `full` fidelity or start fresh with a deterministic carryover preamble, resumed runs will degrade exactly one LLM hop after a lost `full` session, and every run will write a formal `manifest.json`, `checkpoint.json`, and `artifacts/` directory.

**Why this sprint, why now:**

- `A4` and `A5` are the highest-impact remaining Attractor gaps. They affect every serious multi-stage codergen workflow, not one niche handler.
- `docs/INTENT.md` is explicit that Nectar must be **file-system first**, **resumable by default**, and **observable and debuggable**. `A3`, `A8`, and `A10` are the storage and telemetry substrate needed to make that statement true in practice.
- The manager loop is not the next layer. A supervisor over child pipelines is lower leverage than fixing how ordinary codergen stages carry context, persist state, and resume after interruption.
- HTTP server work is premature until the local runtime has a canonical run directory the server can expose without reverse-engineering handler-specific files.
- `C3` should close in the same sprint because reused `full` threads are not viable if `reasoning_effort` is frozen at session creation.

**Gaps closed:**

| Gap | Severity | Description |
|-----|----------|-------------|
| A4 | Medium | Runtime enforcement of `full`, `truncate`, `compact`, and `summary:*` fidelity |
| A5 | Medium | `thread_id` resolution and session reuse for `full` fidelity |
| A3 | Low | Formal `ArtifactStore` API with durable storage and file-backing threshold |
| A8 | Low | `CheckpointSaved` event after successful checkpoint writes |
| A10 | Low | `manifest.json` in the canonical run directory |
| C3 | Low | Mid-session `reasoning_effort` override on reused sessions |

**In scope:**

- Canonical run directories under `.nectar/cocoons/<run-id>/`
- `manifest.json`, `checkpoint.json`, and a formal `artifacts/` store
- Exact runtime fidelity resolution from the selected incoming edge plus node/graph settings
- Exact thread reuse behavior for `full` fidelity
- Run-scoped `SessionRegistry` with per-thread serialization
- Deterministic carryover preambles for all non-`full` modes
- One-hop degraded resume after lost `full` session state
- `CheckpointSaved` event and CLI compatibility with the new layout
- Large tool/codergen payloads stored as artifacts instead of bloating checkpoint context
- Next-turn `reasoning_effort` override without recreating a reused session

**Out of scope:**

- A1 manager loop handler (`house` / `stack.manager_loop`)
- A2 HTTP server mode and the broader INTENT local-runtime API contract for the Hive
- A6 `loop_restart`
- A7 tool hooks around LLM tool calls
- A9 `InterviewTimeout`
- A11 `auto_status`
- L7 middleware, L8 model catalog, L9 high-level SDK `generate()`
- Seedbed/swarm-analysis feature work
- Rich terminal UX for browsing artifacts beyond minimal `status` / `resume` compatibility

**Cut line:** if the sprint runs long, cut artifact-inspection CLI sugar and any non-essential validator warnings. Do **not** cut `RunStore`, `ArtifactStore`, fidelity planning, session reuse, or degraded resume. Those are the sprint.

---

## Use Cases

1. **Stateful plan -> implement -> review thread.** Three `box` nodes resolve to `fidelity="full"` and the same thread key. `plan` creates the live session, `implement` follows up in that same conversation, and `review` follows up again. Nectar preserves the real model conversation instead of pasting a synthetic summary back into a new session.

2. **Intentional reset after a noisy step.** A large implementation node is followed by `cleanup [fidelity="compact"]` and `release_notes [fidelity="summary:medium"]`. Both start fresh sessions, but each receives a deterministic carryover preamble built from run state, notable failures, retries, human answers, and selected context keys.

3. **Safe resume after interruption.** A run is interrupted after a `full`-fidelity codergen node. On `nectar resume <run-id>`, Nectar restores checkpoint state, sees that the last usable LLM context lived only in memory, and forces the next codergen node to run with `summary:high`. After that one degraded hop, later nodes may reuse or create `full` threads normally again.

4. **Per-turn reasoning changes on one thread.** `plan` runs with `reasoning_effort="medium"` and `review` runs with `reasoning_effort="high"` on the same `full` thread. Nectar keeps the conversation but changes the reasoning setting on the next LLM call instead of discarding the session and losing continuity.

5. **Large outputs stop polluting routing context.** A tool node emits 250KB of stdout and a codergen node produces a long response. Nectar stores the full payloads in `artifacts/`, writes human-readable mirrors under the node directory, and keeps only a bounded preview plus artifact ID in checkpoint context.

6. **Future HTTP/UI work gets a stable filesystem contract.** A server or UI can read `.nectar/cocoons/<run-id>/manifest.json`, `checkpoint.json`, and `artifacts/index.json` and understand what ran, what is pending, and where large outputs live without scraping handler-specific logs.

---

## Architecture

### Design Principles

1. **Fidelity is runtime behavior, not a lint hint.** The engine resolves fidelity immediately before executing a node, using the selected incoming edge plus checkpoint state.

2. **`full` means a real live thread.** If fidelity resolves to `full`, Nectar must reuse a real `AgentSession`. Every other mode starts fresh and receives a generated preamble.

3. **Resume-first beats elegance.** The spec says artifacts below 100KB may stay in memory, but Nectar's INTENT says runs must be durable and self-describing. Small artifacts will therefore be persisted inline in an on-disk index; large artifacts will spill to dedicated files.

4. **Deterministic summaries first.** This sprint will not add a second LLM call just to summarize prior context. Preambles will be built deterministically from run state so they are cheap, inspectable, and testable.

5. **Shared thread keys serialize, they do not parallelize.** If two branches resolve to the same `full` thread key, Nectar will queue follow-up turns behind a per-thread lock. Interleaving two concurrent turns into one live model conversation is undefined behavior and should not be attempted.

6. **Migration without a flag day.** For one sprint, Nectar will read and write both the canonical run directory and the legacy flat cocoon JSON so `run`, `resume`, and `status` do not break mid-migration.

### Canonical Run Layout

```text
.nectar/cocoons/
├── <run-id>.json                  # Legacy compatibility mirror for one sprint
└── <run-id>/
    ├── manifest.json              # Run metadata: graph, goal, timestamps, workspace root
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
│   │   ├── types.ts
│   │   └── store.ts
│   ├── checkpoint/
│   │   ├── run-store.ts
│   │   ├── cocoon.ts
│   │   └── types.ts
│   ├── engine/
│   │   ├── fidelity.ts
│   │   ├── preamble.ts
│   │   ├── session-registry.ts
│   │   ├── engine.ts
│   │   ├── events.ts
│   │   └── types.ts
│   ├── handlers/
│   │   ├── codergen.ts
│   │   └── tool.ts
│   ├── agent-loop/
│   │   ├── session.ts
│   │   └── types.ts
│   └── cli/
│       ├── commands/
│       │   ├── status.ts
│       │   └── resume.ts
│       └── ui/renderer.ts
├── test/
│   ├── artifacts/store.test.ts
│   ├── engine/fidelity.test.ts
│   ├── engine/preamble.test.ts
│   ├── integration/fidelity-runtime.test.ts
│   ├── integration/run-store.test.ts
│   └── fixtures/
│       ├── fidelity-full-thread.dot
│       ├── fidelity-compact.dot
│       └── fidelity-resume.dot
```

### Key Abstractions

**`RunStore`**

Owns `.nectar/cocoons/<run-id>/` and exposes:

- `initialize()` to create the run directory and write `manifest.json`
- `writeCheckpoint()` to write canonical `checkpoint.json`
- `writeLegacyMirror()` to keep `<run-id>.json` alive for one sprint
- `readCheckpoint()` / `readManifest()` / `listRuns()`
- `artifactStore()` to get the run-scoped `ArtifactStore`
- `nextArtifactId(nodeId, purpose)` to allocate run-local monotonic artifact IDs and avoid collisions

**`ArtifactStore`**

Formal API matching the spec:

- `store(artifact_id, name, data)`
- `retrieve(artifact_id)`
- `has(artifact_id)`
- `list()`
- `remove(artifact_id)`
- `clear()`

Opinionated implementation detail: all artifacts persist to disk so resume stays durable. Payloads at or below 100KB are stored inline in `artifacts/index.json`; payloads above 100KB are written to `artifacts/<artifact-id>.json`.

**`PendingTransition`**

The current checkpoint must remember not only the next node, but the exact edge chosen to get there:

```ts
interface PendingTransition {
  source_node_id: string;
  target_node_id: string;
  edge: {
    label?: string;
    condition?: string;
    weight: number;
    fidelity?: string;
    threadId?: string;
  };
}
```

This is mandatory because edge-level `fidelity` and `thread_id` are the highest-precedence runtime inputs, and they cannot be reconstructed reliably from `current_node` alone on resume.

**`ResolvedFidelityPlan`**

Computed immediately before a node executes:

```ts
interface ResolvedFidelityPlan {
  mode: 'full' | 'truncate' | 'compact' | 'summary:low' | 'summary:medium' | 'summary:high';
  thread_key?: string;
  downgraded_from_resume: boolean;
  approximate_char_budget?: number;
}
```

Resolution rules:

1. Incoming edge `fidelity` from `pending_transition`
2. Target node `fidelity`
3. Graph `default_fidelity`
4. Fallback default: `compact`

Thread resolution rules for `full`:

1. Target node `threadId`
2. Incoming edge `threadId`
3. First class in `node.classes`
4. Previous completed node ID

Important implementation detail: `src/garden/parse.ts` already folds DOT `node [...]` default blocks into `node.fidelity` and `node.threadId`. The runtime should therefore treat those fields as the resolved node-level value and layer edge overrides on top; it does **not** need a second metadata channel for inherited node defaults.

**`PreambleBuilder`**

Deterministic carryover generator for non-`full` modes. It consumes completed-node history, notable events, and filtered context, then emits a bounded string:

| Mode | Session | Content | Implementation Budget |
|------|---------|---------|-----------------------|
| `truncate` | Fresh | Graph goal and run ID only | 400 chars max |
| `compact` | Fresh | Structured bullets: recent completed nodes, outcomes, retries, human answers, whitelisted context keys | 3200 chars max |
| `summary:low` | Fresh | Brief narrative summary | 2400 chars max (~600 tokens) |
| `summary:medium` | Fresh | Moderate detail with recent failures and active context | 6000 chars max (~1500 tokens) |
| `summary:high` | Fresh | Detailed summary with recent tool/codergen outcomes and artifact references | 12000 chars max (~3000 tokens) |

Truncation behavior is opinionated and deterministic:

- Always keep the header (`goal`, `run_id`)
- Always keep the most recent failure or retry if one exists
- Always keep the most recent human answer if one exists
- Drop oldest successful node summaries first
- Never inline raw artifact payloads; include artifact IDs and short previews only

**`SessionRegistry`**

Run-scoped registry keyed by resolved `thread_key`:

- Stores the live `AgentSession`
- Freezes the provider/model signature at thread creation
- Allows `reasoning_effort` to vary on the next turn
- Enforces a per-thread FIFO lock so parallel branches cannot interleave follow-up turns

### Runtime Flow

```text
selected edge
   │
   ▼
persist pending_transition in checkpoint
   │
   ▼
resolve fidelity + thread key + resume downgrade
   │
   ├── full
   │     └── SessionRegistry.acquire(thread_key)
   │            ├── first use -> session.submit(prompt)
   │            └── reuse -> session.followUp(prompt, { reasoningEffort })
   │
   └── truncate / compact / summary:*
         └── build deterministic preamble
                ├── store preamble artifact
                └── create fresh session.submit(preamble + prompt)
   │
   ▼
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
   └── checkpoint_saved event
```

---

## Implementation Phases

### Phase 1: Canonical RunStore & ArtifactStore (~20%)

**Files:** `src/artifacts/types.ts`, `src/artifacts/store.ts`, `src/checkpoint/run-store.ts`, `src/checkpoint/types.ts`, `src/checkpoint/cocoon.ts`, `test/artifacts/store.test.ts`, `test/checkpoint/cocoon.test.ts`

**Tasks:**

- [ ] Create `RunStore` rooted at `.nectar/cocoons/<run-id>/`.
- [ ] Write `manifest.json` before the first node executes.
- [ ] Make `.nectar/cocoons/<run-id>/checkpoint.json` the canonical checkpoint location.
- [ ] Keep dual-write compatibility to `.nectar/cocoons/<run-id>.json` for one sprint.
- [ ] Implement `ArtifactStore` with `store()`, `retrieve()`, `has()`, `list()`, `remove()`, and `clear()`.
- [ ] Persist payloads `<= 100KB` inline in `artifacts/index.json`.
- [ ] Spill payloads `> 100KB` to `artifacts/<artifact-id>.json`.
- [ ] Allocate artifact IDs through `RunStore`, not ad hoc handler filenames.
- [ ] Add round-trip tests for inline artifacts, file-backed artifacts, removal, clear, and canonical-vs-legacy checkpoint reads.

### Phase 2: Checkpoint Schema, Transition Metadata & Resume Inputs (~20%)

**Files:** `src/checkpoint/types.ts`, `src/checkpoint/cocoon.ts`, `src/engine/types.ts`, `src/engine/events.ts`, `src/engine/engine.ts`, `test/engine/fidelity.test.ts`, `test/integration/resume.test.ts`

**Tasks:**

- [ ] Extend checkpoint state with `pending_transition`.
- [ ] Extend run state with `resume_requires_degraded_fidelity` so the next codergen node can detect a lost `full` thread on resume.
- [ ] Persist the selected edge snapshot before advancing `current_node`.
- [ ] Record the last codergen fidelity mode used by the run for debugging and resume decisions.
- [ ] Emit `checkpoint_saved` immediately after each successful canonical checkpoint write.
- [ ] Ensure interrupted and failed terminal writes also go through the canonical checkpoint path.
- [ ] Add resume tests that verify edge-level fidelity survives interruption and resume.

### Phase 3: Deterministic Preamble Builder (~20%)

**Files:** `src/engine/preamble.ts`, `src/engine/fidelity.ts`, `test/engine/preamble.test.ts`, `test/engine/fidelity.test.ts`, `test/fixtures/fidelity-compact.dot`, `test/fixtures/fidelity-resume.dot`

**Tasks:**

- [ ] Implement fidelity resolution: edge -> node -> graph default -> `compact`.
- [ ] Implement thread resolution for `full`: node -> edge -> first class -> previous node ID.
- [ ] Implement deterministic preamble builders for `truncate`, `compact`, `summary:low`, `summary:medium`, and `summary:high`.
- [ ] Enforce the hard character budgets defined in the Architecture section.
- [ ] Filter context aggressively: exclude `internal.*`, raw `stdout` / `stderr`, full `*.response` blobs, and artifact payloads.
- [ ] Prefer recent failures, retries, partial successes, human answers, and explicit context updates from recent nodes.
- [ ] Persist generated preambles as artifacts for inspection and debugging.
- [ ] Write the actual rendered prompt sent to the model into each node's `prompt.md`, not just the raw node `prompt` attribute.

### Phase 4: Session Reuse, Reasoning Overrides & Handler Integration (~30%)

**Files:** `src/engine/session-registry.ts`, `src/agent-loop/types.ts`, `src/agent-loop/session.ts`, `src/handlers/codergen.ts`, `src/handlers/tool.ts`, `src/engine/engine.ts`, `test/agent-loop/session-control.test.ts`, `test/handlers/codergen.test.ts`, `test/handlers/tool.test.ts`, `test/integration/fidelity-runtime.test.ts`, `test/fixtures/fidelity-full-thread.dot`

**Tasks:**

- [ ] Create a run-scoped `SessionRegistry` keyed by resolved `thread_key`.
- [ ] Add per-thread FIFO locking so concurrent branches cannot interleave follow-up turns on the same live session.
- [ ] Add per-work-item or per-turn overrides in `AgentSession` so `reasoning_effort` can change on the next LLM call without replacing the session.
- [ ] Freeze provider/model signature at thread creation.
- [ ] Fail fast if a reused thread key attempts to switch provider or model.
- [ ] `full` fidelity behavior:
  - [ ] First use of a thread creates a session and calls `submit()`
  - [ ] Reuse of that thread calls `followUp()` on the same session
  - [ ] No synthetic preamble is generated
- [ ] Non-`full` fidelity behavior:
  - [ ] Always create a fresh session
  - [ ] Always prepend the generated preamble
  - [ ] Always close the session after the node completes
- [ ] Register large tool stdout/stderr and long codergen responses with `ArtifactStore`; keep only previews plus artifact IDs in context.

### Phase 5: CLI Compatibility & Regression Sweep (~10%)

**Files:** `src/cli/commands/status.ts`, `src/cli/commands/resume.ts`, `src/cli/ui/renderer.ts`, `test/integration/run-store.test.ts`, `test/integration/run.test.ts`, `test/integration/resume.test.ts`

**Tasks:**

- [ ] Update `status` to read canonical run directories first, then fall back to legacy flat cocoons.
- [ ] Update `resume` to prefer canonical `checkpoint.json` and preserve the current graph-hash mismatch behavior.
- [ ] If `resume --force` is used and the stored `pending_transition` no longer points to a valid target in the edited graph, fail fast with a clear error instead of guessing.
- [ ] Render `checkpoint_saved` tersely in the CLI so checkpoint activity is visible but not noisy.
- [ ] Add end-to-end coverage for canonical run layout, legacy migration, full-thread reuse, fresh-session modes, degraded resume, and artifact persistence.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/artifacts/types.ts` | Create | Define `ArtifactInfo`, persisted artifact records, and inline/file-backed metadata |
| `src/artifacts/store.ts` | Create | Implement formal `ArtifactStore` API and 100KB spill behavior |
| `src/checkpoint/run-store.ts` | Create | Own canonical run directory initialization, manifest writes, checkpoint writes, and artifact ID allocation |
| `src/checkpoint/types.ts` | Modify | Extend checkpoint schema with `RunManifest`, `PendingTransition`, and degraded-resume metadata |
| `src/checkpoint/cocoon.ts` | Modify | Delegate canonical reads/writes to `RunStore` while keeping legacy flat cocoon compatibility |
| `src/engine/fidelity.ts` | Create | Resolve fidelity mode, thread key, and degraded-resume rules |
| `src/engine/preamble.ts` | Create | Build deterministic carryover preambles within fixed budgets |
| `src/engine/session-registry.ts` | Create | Track reusable `AgentSession` instances by thread key and serialize access |
| `src/engine/types.ts` | Modify | Add `pending_transition`, fidelity metadata, and run-store/artifact access in handler inputs |
| `src/engine/events.ts` | Modify | Add `checkpoint_saved` event type |
| `src/engine/engine.ts` | Modify | Initialize `RunStore`, persist transition metadata, resolve fidelity plans, and write canonical checkpoints |
| `src/agent-loop/types.ts` | Modify | Add per-turn override types for reused sessions |
| `src/agent-loop/session.ts` | Modify | Apply next-turn `reasoning_effort` overrides without discarding the live conversation |
| `src/handlers/codergen.ts` | Modify | Reuse sessions for `full`, create fresh sessions for other modes, render actual prompt, and register large outputs as artifacts |
| `src/handlers/tool.ts` | Modify | Register large stdout/stderr payloads with `ArtifactStore` and keep context previews bounded |
| `src/cli/commands/status.ts` | Modify | Read canonical runs first with legacy fallback |
| `src/cli/commands/resume.ts` | Modify | Resume from canonical checkpoints first and error cleanly on stale forced resumes |
| `src/cli/ui/renderer.ts` | Modify | Surface `checkpoint_saved` without clutter |
| `test/artifacts/store.test.ts` | Create | Unit tests for artifact API, threshold behavior, and persistence |
| `test/checkpoint/cocoon.test.ts` | Modify | Verify canonical and legacy cocoon compatibility |
| `test/engine/fidelity.test.ts` | Create | Unit tests for fidelity precedence, thread resolution, and degraded-resume rules |
| `test/engine/preamble.test.ts` | Create | Unit tests for budget enforcement, context filtering, and prioritization |
| `test/agent-loop/session-control.test.ts` | Modify | Verify next-turn `reasoning_effort` overrides on live sessions |
| `test/handlers/codergen.test.ts` | Modify | Verify session reuse, fresh-session modes, and provider/model mismatch handling |
| `test/handlers/tool.test.ts` | Modify | Verify large tool output is registered as an artifact |
| `test/integration/fidelity-runtime.test.ts` | Create | End-to-end coverage for `full`, `compact`, and `summary:*` behavior |
| `test/integration/run.test.ts` | Modify | Verify a normal `nectar run` writes the canonical run layout without changing existing success/failure behavior |
| `test/integration/run-store.test.ts` | Create | End-to-end assertions for manifest, checkpoint, artifact layout, and migration |
| `test/integration/resume.test.ts` | Modify | Verify one-hop degraded resume after `full` fidelity |
| `test/fixtures/fidelity-full-thread.dot` | Create | Fixture for `full` thread reuse and reasoning override |
| `test/fixtures/fidelity-compact.dot` | Create | Fixture for fresh-session compact/summary behavior |
| `test/fixtures/fidelity-resume.dot` | Create | Fixture for interruption and degraded resume |

---

## Definition of Done

### Build & Regression

- [ ] `npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all existing and new tests
- [ ] Existing pipelines with no codergen nodes behave unchanged
- [ ] Existing `nectar run`, `nectar resume`, and `nectar status` flows continue to work for pre-sprint flat cocoons

### Canonical RunStore & ArtifactStore

- [ ] Every new run creates `.nectar/cocoons/<run-id>/manifest.json` before the first node starts
- [ ] Every new run writes `.nectar/cocoons/<run-id>/checkpoint.json` after each completed node and on terminal interruption/failure
- [ ] The legacy flat cocoon file `.nectar/cocoons/<run-id>.json` is still written for one sprint
- [ ] `ArtifactStore` implements `store()`, `retrieve()`, `has()`, `list()`, `remove()`, and `clear()`
- [ ] Artifacts larger than 100KB are written to `artifacts/<artifact-id>.json`
- [ ] Artifacts at or below 100KB persist inline in `artifacts/index.json`
- [ ] Artifact IDs are unique within a run and allocated by `RunStore`
- [ ] `checkpoint_saved` is emitted only after a successful checkpoint write

### Fidelity Resolution & Resume

- [ ] Fidelity resolution follows the runtime order exactly: edge -> node -> graph default -> `compact`
- [ ] `full` fidelity never generates a synthetic preamble
- [ ] Non-`full` fidelity modes always create a fresh session
- [ ] `prompt.md` contains the actual rendered prompt sent to the model for fresh-session modes
- [ ] `pending_transition` is persisted and used on resume; Nectar does not guess the incoming edge from graph topology
- [ ] If the last completed codergen node used `full`, the next resumed codergen node runs as `summary:high`
- [ ] The degraded-resume flag clears after exactly one resumed codergen hop
- [ ] Non-codergen nodes do not consume the degraded-resume flag
- [ ] Generated preambles stay within the defined character budgets
- [ ] Generated preambles always retain the header and the most recent failure/retry and human answer when present

### Session Reuse & C3

- [ ] Two codergen nodes that resolve to the same `full` thread key and the same provider/model reuse one live `AgentSession`
- [ ] Reusing a thread key with a different provider or model fails fast with a clear runtime error
- [ ] `reasoning_effort` can change between two turns on the same live session
- [ ] Two concurrent nodes resolving to the same thread key do not interleave turns; one waits behind the other
- [ ] Fresh sessions created for `truncate`, `compact`, and `summary:*` are closed after node completion
- [ ] Resumed runs never attempt to resurrect an in-memory session from a prior process

### Artifacts & Context Hygiene

- [ ] Large tool stdout/stderr and long codergen responses are stored as artifacts with preview + artifact ID in context
- [ ] Checkpoint context no longer contains raw multi-kilobyte tool or codergen payloads
- [ ] Node-local `status.json`, `prompt.md`, and `response.md` files still exist for human inspection
- [ ] Preambles themselves are inspectable via artifact references

### CLI & Integration Coverage

- [ ] `status` reads canonical run directories first and falls back to legacy flat cocoons
- [ ] `resume` reads canonical checkpoints first and preserves current graph-hash mismatch behavior
- [ ] `resume --force` fails clearly if the stored `pending_transition` no longer maps to a valid target in the edited graph
- [ ] Integration tests cover `full` thread reuse, `compact`/`summary:*` fresh-session behavior, degraded resume, artifact persistence, and legacy cocoon migration
- [ ] `docs/compliance-report.md` can be updated to mark A3, A4, A5, A8, A10, and C3 as implemented

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Canonical run-directory migration breaks `status` or `resume`** | Medium | High | Dual-write canonical and legacy checkpoints for one sprint. Read canonical first, legacy second. Add integration tests for both paths. |
| **Two parallel branches share one thread key and corrupt conversation order** | Medium | High | `SessionRegistry` must serialize access per thread key with a FIFO lock. Shared thread keys mean shared conversation, not shared concurrency. |
| **Deterministic preambles omit context the next node needs** | Medium | Medium | Bias toward recent failures, retries, human answers, and explicit context updates. Persist every generated preamble as an artifact so bad summaries are inspectable and tunable. |
| **Character budgets drift from real provider tokenization** | Medium | Medium | Use conservative 4 chars/token approximations and leave headroom. This sprint deliberately avoids a tokenizer dependency; exact context-window accounting can follow in a later L19/C1 sprint. |
| **`resume --force` is used after graph edits and the stored transition no longer matches reality** | Medium | Medium | Keep `pending_transition` in the checkpoint and fail fast if its target is no longer valid under the edited graph. Do not silently guess a replacement edge. |
| **Inline artifact index grows too large for long runs with many small payloads** | Low | Medium | Keep the spill threshold strict, allocate compact metadata records, and store only small payloads inline. The canonical payload source remains the artifact store, not checkpoint context. |
| **Live sessions leak on failure or interruption** | Medium | Medium | Scope the registry to a single run and dispose it on completion, failure, and interruption paths. Add lifecycle tests around interrupted runs and forced errors. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `src/garden/parse.ts` already parses `fidelity`, `thread_id`, `default_fidelity`, and `classes` | Runtime fidelity inputs already exist in the AST | Implemented |
| `PipelineEngine` checkpoint lifecycle | Base for canonical checkpoint migration and degraded resume | Implemented |
| `AgentSession.submit()` / `followUp()` conversation reuse | Foundation for `full` fidelity thread reuse | Implemented |
| `UnifiedClient.stream()` and existing provider adapters | Underlying multi-turn LLM session transport | Implemented |
| `TranscriptWriter` and per-node artifact writes | Existing human-readable run artifacts to preserve | Implemented |
| CLI `run` / `resume` / `status` commands | Existing user-facing surface to keep compatible during migration | Implemented |
| No new npm dependencies | Character-budget approach avoids tokenizer or storage-package additions | Required |

**No new npm dependencies should be introduced in this sprint.** The work extends existing engine, checkpoint, handler, and agent-loop abstractions rather than adding another subsystem.
