# Sprint 015: Runtime Fidelity, Thread Reuse & Canonical Run Directories

## Overview

**Goal:** Make `fidelity` and `thread_id` actually do something at runtime, and give every pipeline run a self-describing directory structure. After this sprint, a codergen node with `fidelity="compact"` receives a terse structured summary instead of unbounded context; two nodes sharing `thread_id="planning"` continue the same LLM conversation; and every run writes `manifest.json`, canonical checkpoints, and a formal artifact store to `.nectar/cocoons/<run-id>/`.

**Why this sprint, why now:**

- **A4 and A5 are the last medium-severity attractor engine gaps.** Closing them makes the engine the first spec to reach zero medium+ issues (aside from A1 manager loop). Every other engine gap is Low.
- **Fidelity is a correctness and cost problem today.** Every codergen node currently gets the entire execution context as an undifferentiated dump. For a 10-node pipeline, later nodes get bloated context that wastes tokens, confuses the model, and inflates cost. Pipeline authors already write `fidelity="compact"` in their DOT files — but the attribute is silently ignored.
- **Thread reuse enables the highest-value pipeline pattern in the spec.** `plan → implement → review` with `thread_id="feature"` should share a single LLM conversation. Without thread resolution, every codergen node starts blank, destroying the continuity that makes multi-stage reasoning valuable.
- **Sprint 014 explicitly unblocked this.** `ThinkingData.signature` (L2) was a prerequisite — `full` fidelity thread reuse with Anthropic thinking would silently corrupt without signature round-tripping. That's resolved.
- **The run directory gaps (A3, A8, A10) are natural companions.** Fidelity preambles and thread stores need to be persisted, inspected, and resumed. Without a canonical run directory, those artifacts float in ad hoc locations. Bundling them here means fidelity, threads, and artifacts ship as one coherent system — not three features bolted together later.
- **`docs/INTENT.md` is explicit that Nectar must be file-system first, resumable by default, and observable and debuggable.** A3, A8, and A10 are the storage and telemetry substrate needed to make that statement true in practice.
- **A11 and C3 are trivial add-ons that close two more Low gaps for free.** `auto_status` is a ~10-line engine change. `reasoning_effort` mid-session override is required for `full` fidelity to work when two nodes on the same thread want different reasoning levels.

**Gaps closed:**

| Gap | Severity | Description |
|-----|----------|-------------|
| A4  | **Medium** | Context fidelity runtime enforcement — `full`, `truncate`, `compact`, `summary:*` modes |
| A5  | **Medium** | Thread resolution and LLM session reuse for `full` fidelity |
| A3  | Low | Formal `ArtifactStore` API with `store()`, `retrieve()`, `has()`, `list()`, `remove()`, `clear()` |
| A8  | Low | `CheckpointSaved` event emitted after checkpoint writes |
| A10 | Low | `manifest.json` written to run directory with pipeline metadata |
| A11 | Low | `auto_status` runtime behavior — auto-SUCCESS when handler writes no status |
| C3  | Low | `reasoning_effort` changeable mid-session without discarding conversation |

**Total: 2 Medium + 5 Low = 7 gaps closed.**

**In scope:**

- Canonical run directory: `.nectar/cocoons/<run-id>/manifest.json`, `checkpoint.json`, `artifacts/`
- Fidelity resolution: edge → node → graph `default_fidelity` → fallback `compact`
- Deterministic preamble generation per fidelity mode with character budgets
- Thread ID resolution: node → edge → graph default → subgraph class → previous node
- Run-scoped `SessionRegistry` for live `AgentSession` reuse keyed by thread
- Per-thread FIFO locking for parallel branch safety
- One-hop degraded resume: after interrupted `full` fidelity, next codergen gets `summary:high`
- `ArtifactStore` with inline (≤100KB) and file-backed (>100KB) storage
- `CheckpointSaved` event
- `manifest.json` with run metadata
- `auto_status` engine fallback
- `reasoning_effort` override on reused sessions
- `prompt.md` captures the actual rendered prompt sent to the model (not just the raw node `prompt` attribute)

**Out of scope:**

- A1 (Manager loop handler) — fundamentally different handler type requiring sub-graph identification, child outcome observation, steering logic, and exit semantics. Deserves its own focused sprint once fidelity and session reuse are stable.
- A2 (HTTP server mode) — product surface, not engine internals. Premature until the local runtime has a canonical run directory the server can expose.
- C1 (Context window awareness) — useful but requires `context_window_size` on provider profiles (L19), mixing attractor-engine work with LLM-client work. Defer cleanly.
- L7/L8/L9 (LLM SDK conveniences) — medium severity but not blocking any product feature
- Seedbed, Web UI, Swarm Intelligence — product features
- LLM-powered summarization for `summary:*` modes — this sprint uses deterministic templates; LLM summaries are a follow-up enhancement
- Rich CLI artifact browsing — beyond basic `status`/`resume` compatibility

**Cut-line:** If the sprint runs long, defer Phase 5 (ArtifactStore and `auto_status`). Ship fidelity, threads, session reuse, canonical checkpoints, and `manifest.json`. Do **not** cut thread resolution — it's the load-bearing feature that makes `full` fidelity useful. Do **not** cut `SessionRegistry` — message replay without session reuse is a pale imitation of `full` fidelity.

---

## Use Cases

1. **Stateful plan → implement → review chain.** Three `box` nodes share `thread_id="feature"` with `fidelity="full"`. `plan` creates a live `AgentSession`, `implement` follows up in that same conversation via `session.followUp()`, and `review` follows up again. The LLM remembers everything discussed — no re-prompting, no synthetic summaries, no token waste on redundant context.

2. **Intentional reset after a noisy step.** A large implementation node is followed by `cleanup [fidelity="compact"]` and `release_notes [fidelity="summary:medium"]`. Both start fresh sessions, but each receives a deterministic carryover preamble built from run state — notable failures, retries, human answers, and selected context keys.

3. **Default fidelity for the whole graph.** A pipeline sets `default_fidelity="compact"` at graph level. Every codergen node without an explicit `fidelity` attribute gets compact context. One critical node overrides with `fidelity="full"` for deep analysis. No need to annotate every node.

4. **Thread inheritance through edges.** An edge carries `thread_id="review-thread"`, so the target inherits that thread regardless of its own attributes. Pipeline authors control thread grouping at the graph topology level:
   ```dot
   draft -> review [thread_id="review-thread"]
   review [shape=box fidelity="full"]
   ```

5. **Safe resume after interruption.** A run is interrupted after a `full`-fidelity codergen node. On `nectar resume <run-id>`, the engine restores checkpoint state, detects the lost in-memory session, and forces the next codergen node to `summary:high`. After that one degraded hop, subsequent `full`-fidelity nodes can create new sessions normally.

6. **Per-turn reasoning changes on one thread.** `plan` runs with `reasoning_effort="medium"` and `review` runs with `reasoning_effort="high"` on the same `full` thread. The engine changes the reasoning setting on the next LLM call without discarding the session.

7. **Large outputs stop bloating checkpoints.** A tool node emits 250KB of stdout. The engine stores it in `artifacts/` via `ArtifactStore` and keeps only a bounded preview in checkpoint context.

8. **Inspectable run state.** After any run, `.nectar/cocoons/<run-id>/manifest.json` tells you what ran, `checkpoint.json` tells you where it stopped, and `artifacts/index.json` shows what was produced. Future HTTP/UI work gets a stable filesystem contract without scraping handler-specific logs.

---

## Architecture

### Design Principles

1. **Fidelity is runtime behavior, not a lint hint.** The engine resolves fidelity immediately before executing a node, using the selected incoming edge plus checkpoint state.
2. **`full` means a real live thread.** If fidelity resolves to `full`, Nectar must reuse a real `AgentSession`. Every other mode starts fresh and receives a generated preamble.
3. **Resume-first beats elegance.** The spec says artifacts below 100KB may stay in memory, but Nectar's INTENT says runs must be durable and self-describing. Small artifacts are persisted inline in an on-disk index; large artifacts spill to dedicated files.
4. **Deterministic summaries first.** This sprint does not add a second LLM call just to summarize prior context. Preambles are built deterministically from run state so they are cheap, inspectable, and testable.
5. **Shared thread keys serialize, they do not parallelize.** If two branches resolve to the same `full` thread key, Nectar queues follow-up turns behind a per-thread lock. Interleaving two concurrent turns into one live model conversation is undefined behavior.
6. **Migration without a flag day.** For one sprint, Nectar reads and writes both the canonical run directory and the legacy flat cocoon JSON so `run`, `resume`, and `status` do not break mid-migration.

### Canonical Run Layout

```text
.nectar/cocoons/
├── <run-id>.json              # Legacy flat cocoon (dual-write for one sprint)
└── <run-id>/
    ├── manifest.json           # Pipeline metadata: run_id, dot_file, graph_hash, goal, started_at
    ├── checkpoint.json         # Canonical checkpoint (replaces flat cocoon)
    ├── artifacts/
    │   ├── index.json          # Artifact metadata + inline payloads ≤100KB
    │   └── <artifact-id>.json  # File-backed payloads >100KB
    └── <node-id>/
        ├── status.json
        ├── prompt.md
        └── response.md
```

`manifest.json` contains: `run_id`, `dot_file`, `graph_hash`, `graph_label`, `goal`, `started_at`, `workspace_root`.

### RunStore

Owns `.nectar/cocoons/<run-id>/` and exposes:

- `initialize()` — creates run directory and writes `manifest.json`
- `writeCheckpoint()` — writes canonical `checkpoint.json`
- `writeLegacyMirror()` — keeps `<run-id>.json` alive for one sprint
- `readCheckpoint()` — reads canonical first, falls back to legacy
- `readManifest()` / `listRuns()` — run discovery
- `artifactStore()` — returns run-scoped `ArtifactStore`
- `nextArtifactId(nodeId, purpose)` — allocates run-local monotonic artifact IDs

### Fidelity Resolution

Resolved per-node with this precedence (highest first):

1. Incoming edge `fidelity` attribute (from `pending_transition`)
2. Target node `fidelity` attribute
3. Graph `default_fidelity`
4. Fallback: `compact`

The fallback is `compact`, not `full`. This is an opinionated behavioral change: unbounded context is the wrong default for production pipelines. Pipelines that want `full` should declare it explicitly. **This must be documented in release notes** — existing pipelines without any fidelity attributes will get compact summaries instead of unbounded context.

**Important:** `src/garden/parse.ts` already folds DOT `node [...]` default blocks into `node.fidelity` and `node.threadId`. The runtime treats those fields as the resolved node-level value and layers edge overrides on top — no second metadata channel needed.

### Thread ID Resolution

Resolved per-node with this chain (first non-null wins):

1. Target node `thread_id` attribute
2. Incoming edge `thread_id` attribute
3. Graph-level `thread_id` default
4. First class in `node.classes` (subgraph class derivation)
5. Previous completed node's thread ID (continuity default)

If nothing resolves, the node gets a fresh ephemeral session.

**Note:** The 5-step chain includes the graph-level default (step 3) which the spec §5.4 requires. This ensures a graph-level `thread_id` default with no node or edge override is respected before falling back to subgraph class derivation.

### Fidelity Mode Behaviors

| Mode | Session | Preamble | Budget |
|------|---------|----------|--------|
| `full` | Reuse live `AgentSession` via `SessionRegistry` | Graph goal only ("You are continuing an existing conversation.") | No cap (model context window is the limit) |
| `truncate` | Fresh | Graph goal + run ID | 400 chars |
| `compact` | Fresh | Structured Markdown table: recent nodes, outcomes, retries, human answers, key context | 3200 chars |
| `summary:low` | Fresh | One-line-per-node summary | 2400 chars |
| `summary:medium` | Fresh | Multi-sentence per node with key decisions and failures | 6000 chars |
| `summary:high` | Fresh | Detailed narrative with outcomes, context updates, artifact references | 12000 chars |

All non-`full` modes use deterministic templates (no LLM call). Character budgets are hard caps enforced by truncation.

Truncation priority (always retained first → dropped first):
1. Header (goal, run_id) — always kept
2. Most recent failure or retry — always kept if present
3. Most recent human answer — always kept if present
4. Recent successful nodes — kept if budget allows
5. Oldest successful node summaries — dropped first

Context filtering: exclude `internal.*`, raw stdout/stderr blobs, full response payloads. Never inline raw artifact payloads in preambles — include artifact IDs and short previews only.

### PendingTransition

The checkpoint must record the exact edge chosen, not just the target node:

```typescript
interface PendingTransition {
  source_node_id: string;
  target_node_id: string;
  edge: {
    label?: string;
    condition?: string;
    weight: number;
    fidelity?: string;
    thread_id?: string;
  };
}
```

This is mandatory because edge-level `fidelity` and `thread_id` are highest-precedence inputs and cannot be reconstructed from `current_node` alone on resume.

### SessionRegistry

Run-scoped registry keyed by resolved `thread_key`:

```typescript
class SessionRegistry {
  acquire(threadKey: string, provider: string, model: string): AgentSession;
  has(threadKey: string): boolean;
  closeAll(): Promise<void>;
}
```

- First `acquire()` for a key creates the session and calls `submit()`
- Subsequent `acquire()` calls return the same live session for `followUp()`
- Provider/model signature frozen at creation — mismatched reuse fails fast with clear error
- `reasoning_effort` can vary per-turn (applied on next LLM call without session replacement)
- Per-thread FIFO lock: parallel branches sharing a thread key serialize, never interleave. Lock includes a configurable timeout (default 5 minutes) so a stalled LLM call does not permanently freeze concurrent branches.
- On run completion/failure/interruption: `closeAll()` disposes all sessions

### ArtifactStore

```typescript
interface ArtifactStore {
  store(id: string, name: string, data: Buffer | string): void;
  retrieve(id: string): Buffer | string | null;
  has(id: string): boolean;
  list(): ArtifactInfo[];
  remove(id: string): void;
  clear(): void;
}
```

Payloads ≤100KB inline in `artifacts/index.json`. Payloads >100KB spill to `artifacts/<id>.json`. IDs allocated by `RunStore` to avoid collisions.

### Degraded Resume

When a run resumes after interruption and the last completed codergen node used `full` fidelity, the live session is gone. The engine sets `resume_requires_degraded_fidelity = true`, forcing the next codergen node to `summary:high` regardless of its declared fidelity. The flag clears after one codergen hop. Non-codergen nodes don't consume the flag.

The checkpoint also persists `thread_registry_keys: string[]` — records which threads were active. This enables reliable degraded-resume detection without guessing from `completed_nodes`.

### Runtime Flow

```text
edge selected
   │
   ▼
persist pending_transition in checkpoint
   │
   ▼
resolve fidelity (edge → node → graph → compact)
resolve thread_key (node → edge → graph default → class → previous)
check degraded-resume flag
   │
   ├── full (and session exists)
   │     └── SessionRegistry.acquire(key) → session.followUp(prompt, { reasoningEffort })
   │
   ├── full (first use of thread)
   │     └── SessionRegistry.acquire(key) → session.submit(prompt)
   │
   └── truncate / compact / summary:*
         └── build deterministic preamble
             ├── store preamble as artifact for inspection
             └── create fresh session.submit(preamble + prompt)
   │
   ▼
handler outcome
   │
   ▼
store large payloads in ArtifactStore (preview + artifact ID in context)
write rendered prompt to <node-id>/prompt.md
write response to <node-id>/response.md
   │
   ▼
RunStore.writeCheckpoint() → emit checkpoint_saved
RunStore.writeLegacyMirror()
```

---

## Implementation Phases

### Phase 1: RunStore, Manifest & Canonical Checkpoints (~20%)

**Files:** `src/checkpoint/run-store.ts` (create), `src/checkpoint/types.ts` (modify), `src/checkpoint/cocoon.ts` (modify), `src/engine/engine.ts` (modify), `src/engine/events.ts` (modify), `test/checkpoint/run-store.test.ts` (create)

**Tasks:**

- [ ] Create `RunStore` class rooted at `.nectar/cocoons/<run-id>/`
- [ ] `initialize()` creates run directory and writes `manifest.json` (run_id, dot_file, graph_hash, goal, graph_label, started_at, workspace_root)
- [ ] `writeCheckpoint()` writes `checkpoint.json` as canonical location
- [ ] Dual-write legacy `<run-id>.json` for one sprint (backward compat)
- [ ] `readCheckpoint()` reads canonical first, falls back to legacy
- [ ] `listRuns()` scans both canonical directories and legacy flat files
- [ ] Extend checkpoint schema with `pending_transition` field
- [ ] Persist selected edge snapshot before advancing `current_node`
- [ ] Add `checkpoint_saved` event type to `src/engine/events.ts`
- [ ] Emit `checkpoint_saved` immediately after each successful checkpoint write
- [ ] Update `status` command to read canonical runs first, legacy fallback
- [ ] Update `resume` command to prefer canonical checkpoints
- [ ] Tests:
  - manifest.json written before first node
  - checkpoint.json round-trip (write + read)
  - Legacy flat cocoon still written and readable
  - listRuns finds both canonical and legacy runs
  - pending_transition survives checkpoint serialization
  - Old cocoons without new fields resume cleanly (backward compat)

### Phase 2: Fidelity Resolution & Preamble Generation (~20%)

**Files:** `src/engine/fidelity.ts` (create), `src/engine/preamble.ts` (create), `src/engine/types.ts` (modify), `test/engine/fidelity.test.ts` (create), `test/engine/preamble.test.ts` (create), `test/fixtures/fidelity-compact.dot` (create)

**Tasks:**

- [ ] Define `FidelityMode` type: `'full' | 'truncate' | 'compact' | 'summary:low' | 'summary:medium' | 'summary:high'`
- [ ] Implement `resolveFidelity(node, incomingEdge, graph): FidelityMode` — 4-level precedence (edge → node → graph → `compact`)
- [ ] Implement `ResolvedFidelityPlan` type with `mode`, `thread_key`, `downgraded_from_resume`, `char_budget`
- [ ] Implement `PreambleBuilder` with deterministic generators per mode:
  - `full`: graph goal only ("You are continuing an existing conversation.")
  - `truncate`: graph goal + run ID
  - `compact`: Markdown table of recent nodes with outcomes, durations, key context, retries, human answers
  - `summary:low/medium/high`: increasing-detail narrative summaries
- [ ] Enforce hard character budgets per mode (see Architecture table)
- [ ] Truncation priority: always keep header → recent failures → recent human answers → recent successes → drop oldest
- [ ] Filter context: exclude `internal.*`, raw stdout/stderr blobs, full response payloads; include artifact IDs and short previews only
- [ ] Add `resolvedFidelity`, `resolvedThreadId`, `preamble` fields to handler execution input
- [ ] Tests:
  - Edge fidelity overrides node fidelity
  - Node fidelity overrides graph default
  - System default is `compact` when nothing specified
  - Each fidelity mode produces expected format
  - Budget enforcement: output never exceeds char limit
  - Truncation priority: failures retained over old successes
  - Empty completed-nodes produces minimal preamble

### Phase 3: Thread Resolution & SessionRegistry (~25%)

**Files:** `src/engine/thread-resolver.ts` (create), `src/engine/session-registry.ts` (create), `src/agent-loop/session.ts` (modify), `src/agent-loop/types.ts` (modify), `test/engine/thread-resolver.test.ts` (create), `test/engine/session-registry.test.ts` (create), `test/fixtures/fidelity-full-thread.dot` (create)

**Tasks:**

- [ ] Implement `resolveThreadId(node, incomingEdge, graph, previousThreadId): string | null`
  - Resolution chain: node attr → edge attr → graph default → first subgraph class → previous node thread
  - Returns null for fresh ephemeral session
- [ ] Create `SessionRegistry` class:
  - `acquire(threadKey, provider, model)` — create or return existing session
  - Freeze provider/model at thread creation; fail fast on mismatch
  - Per-thread FIFO lock for concurrent access with configurable timeout
  - `has(threadKey)` — check existence
  - `closeAll()` — dispose all sessions
- [ ] Add per-turn `reasoning_effort` override to `AgentSession`:
  - `followUp(prompt, { reasoningEffort? })` applies override on next LLM call without discarding session
- [ ] Add `getConversation(): Message[]` to `AgentSession` (returns copy)
- [ ] Extend checkpoint with `resume_requires_degraded_fidelity: boolean` and `thread_registry_keys: string[]`
- [ ] Implement degraded resume logic:
  - Set flag when last codergen used `full` and run was interrupted
  - Next codergen node forced to `summary:high` regardless of declared fidelity
  - Flag clears after one codergen hop
  - Non-codergen nodes don't consume the flag
- [ ] Tests:
  - Thread resolver: node attr wins over edge attr
  - Thread resolver: edge attr wins over graph default
  - Thread resolver: graph default wins over subgraph class
  - Thread resolver: class wins over previous node
  - Thread resolver: previous node inherited when nothing else specified
  - Thread resolver: null when no thread anywhere
  - SessionRegistry: first acquire creates, second returns same session
  - SessionRegistry: provider/model mismatch fails fast
  - SessionRegistry: per-thread lock serializes concurrent acquires
  - SessionRegistry: lock timeout prevents deadlocks
  - SessionRegistry: closeAll disposes all
  - Degraded resume: flag set on interrupted full-fidelity, consumed by next codergen
  - reasoning_effort override applied on followUp

### Phase 4: Engine & Handler Integration (~25%)

**Files:** `src/engine/engine.ts` (modify), `src/handlers/codergen.ts` (modify), `src/checkpoint/types.ts` (modify), `src/checkpoint/cocoon.ts` (modify), `test/engine/engine-fidelity.test.ts` (create), `test/integration/fidelity-runtime.test.ts` (create), `test/fixtures/fidelity-resume.dot` (create)

**Tasks:**

- [ ] Add `SessionRegistry` instance to `PipelineEngine`, scoped to run lifecycle
- [ ] Before each codergen node execution:
  - Resolve fidelity via `resolveFidelity()`
  - Check degraded-resume flag
  - Resolve thread ID via `resolveThreadId()`
  - Build completed node records from engine state
  - Generate preamble via `PreambleBuilder`
  - Pass resolved plan to handler
- [ ] Codergen handler integration:
  - `full` fidelity: acquire session from `SessionRegistry`, call `followUp()` or `submit()` based on whether thread exists
  - Non-`full` fidelity: create fresh session, inject preamble into system prompt, call `submit()`
  - Fresh sessions closed after node completion
- [ ] After codergen node completes with `full` fidelity: session stays alive in registry
- [ ] Non-codergen nodes (tool, conditional, etc.) ignore fidelity — unaffected
- [ ] Extend `Cocoon` with `thread_registry_keys?: string[]` — records which threads existed for degraded-resume detection
- [ ] On resume: restore checkpoint, detect missing sessions, set degraded flag if needed
- [ ] Backward compatibility: old cocoons without new fields resume cleanly
- [ ] Wire `RunStore` into engine: initialize before first node, write canonical checkpoint after each
- [ ] Write rendered prompt to `<node-id>/prompt.md` (the actual prompt sent to the model, not the raw node attribute)
- [ ] Write response to `<node-id>/response.md`
- [ ] `checkpoint_saved` event emitted after each write
- [ ] Store large tool stdout/stderr and long codergen responses with `ArtifactStore`; keep only previews plus artifact IDs in context
- [ ] Tests:
  - Engine resolves fidelity and passes to handler
  - Two nodes with same thread_id reuse session (followUp called, not submit)
  - Nodes with different thread_ids get independent sessions
  - Nodes with no thread get fresh ephemeral sessions
  - `full` fidelity with no resolved thread gets a fresh ephemeral session
  - compact fidelity produces table preamble, not thread seeding
  - Checkpoint includes pending_transition and thread keys
  - Resume with old cocoon works (backward compat)
  - Degraded resume: interrupted full → next codergen gets summary:high
  - checkpoint_saved event emitted
  - manifest.json exists after first node
  - prompt.md contains rendered prompt, not raw attribute

### Phase 5: ArtifactStore, auto_status & Cleanup (~10%)

**Files:** `src/artifacts/types.ts` (create), `src/artifacts/store.ts` (create), `src/engine/engine.ts` (modify), `src/handlers/tool.ts` (modify), `test/artifacts/store.test.ts` (create)

**Tasks:**

- [ ] Implement `ArtifactStore` with `store()`, `retrieve()`, `has()`, `list()`, `remove()`, `clear()`
- [ ] Inline payloads ≤100KB in `artifacts/index.json`; spill >100KB to files
- [ ] Wire into tool handler: large stdout/stderr stored as artifacts with preview in context
- [ ] Wire into codergen handler: long responses stored as artifacts
- [ ] Implement `auto_status` in engine Step 3 (Collect Outcome):
  - If handler returns no explicit status and `node.auto_status === true`, default to `{ status: 'success' }`
  - Emit warning event when auto_status is applied
- [ ] Persist generated preambles as artifacts for debugging inspection
- [ ] Tests:
  - ArtifactStore: inline round-trip (≤100KB)
  - ArtifactStore: file-backed round-trip (>100KB)
  - ArtifactStore: list, remove, clear
  - ArtifactStore: boundary test for exactly-100KB payloads
  - auto_status: handler with no status + auto_status=true → success
  - auto_status: handler with no status + auto_status=false → engine error (existing behavior)
  - Large tool output stored as artifact, preview in context

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/checkpoint/run-store.ts` | Create | Canonical run directory management: manifest, checkpoint, artifact allocation |
| `src/artifacts/types.ts` | Create | `ArtifactInfo`, `ArtifactStore` interface |
| `src/artifacts/store.ts` | Create | `ArtifactStore` implementation with inline/file-backed storage |
| `src/engine/fidelity.ts` | Create | `resolveFidelity()`, `ResolvedFidelityPlan` |
| `src/engine/preamble.ts` | Create | `PreambleBuilder` — deterministic preamble generation per fidelity mode |
| `src/engine/thread-resolver.ts` | Create | `resolveThreadId()` — 5-step resolution chain |
| `src/engine/session-registry.ts` | Create | `SessionRegistry` — live session reuse with per-thread FIFO locking |
| `src/engine/types.ts` | Modify | `FidelityMode`, `ResolvedFidelityPlan`, `PendingTransition`, extended handler inputs |
| `src/engine/events.ts` | Modify | `checkpoint_saved` event type |
| `src/engine/engine.ts` | Modify | RunStore lifecycle, fidelity/thread resolution, SessionRegistry, auto_status, checkpoint_saved |
| `src/checkpoint/types.ts` | Modify | `pending_transition`, `thread_registry_keys`, `resume_requires_degraded_fidelity` |
| `src/checkpoint/cocoon.ts` | Modify | Canonical + legacy dual-write, new fields serialization |
| `src/handlers/codergen.ts` | Modify | Session reuse for `full`, fresh session + preamble for others, reasoning_effort override |
| `src/handlers/tool.ts` | Modify | Large output → ArtifactStore with context preview |
| `src/agent-loop/session.ts` | Modify | `getConversation()`, per-turn `reasoning_effort` override on followUp |
| `src/agent-loop/types.ts` | Modify | Per-turn override types |
| `src/cli/commands/status.ts` | Modify | Read canonical run dirs first, legacy fallback |
| `src/cli/commands/resume.ts` | Modify | Prefer canonical checkpoints, fail fast on stale `pending_transition` |
| `src/cli/ui/renderer.ts` | Modify | Render `checkpoint_saved` tersely |
| `test/checkpoint/run-store.test.ts` | Create | RunStore + manifest + canonical checkpoint tests |
| `test/artifacts/store.test.ts` | Create | ArtifactStore inline/file-backed tests |
| `test/engine/fidelity.test.ts` | Create | Fidelity resolution precedence |
| `test/engine/preamble.test.ts` | Create | Preamble generation per mode, budget enforcement |
| `test/engine/thread-resolver.test.ts` | Create | Thread ID resolution chain (all 5 steps) |
| `test/engine/session-registry.test.ts` | Create | Session reuse, locking, mismatch, timeout, cleanup |
| `test/engine/engine-fidelity.test.ts` | Create | Engine integration: fidelity + threads flow to handler |
| `test/integration/fidelity-runtime.test.ts` | Create | End-to-end: full thread reuse, compact preamble, degraded resume |
| `test/fixtures/fidelity-full-thread.dot` | Create | Fixture for thread reuse across nodes |
| `test/fixtures/fidelity-compact.dot` | Create | Fixture for compact/summary modes |
| `test/fixtures/fidelity-resume.dot` | Create | Fixture for interrupted full → degraded resume |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing pipelines without fidelity/thread attributes get `compact` default (documented behavioral change)
- [ ] Old cocoons without new fields resume cleanly
- [ ] Existing `nectar run`, `nectar resume`, and `nectar status` flows continue to work for pre-sprint flat cocoons

### Canonical Run Directory (A3, A8, A10)
- [ ] Every run creates `.nectar/cocoons/<run-id>/manifest.json` before first node
- [ ] Every run writes `.nectar/cocoons/<run-id>/checkpoint.json` after each node and on terminal interruption/failure
- [ ] Legacy flat `<run-id>.json` still dual-written for one sprint
- [ ] `checkpoint_saved` emitted after each successful checkpoint write
- [ ] `ArtifactStore` implements `store()`, `retrieve()`, `has()`, `list()`, `remove()`, `clear()`
- [ ] Artifacts ≤100KB inline in `index.json`; >100KB spilled to files
- [ ] Artifact IDs unique within a run and allocated by `RunStore`
- [ ] `status` and `resume` commands read canonical dirs first, legacy fallback
- [ ] `resume --force` fails clearly if stored `pending_transition` no longer maps to valid target in edited graph

### Fidelity Resolution (A4)
- [ ] `resolveFidelity()` implements 4-level precedence: edge → node → graph → `compact`
- [ ] All 6 modes recognized: `full`, `truncate`, `compact`, `summary:low/medium/high`
- [ ] `full` fidelity never generates a synthetic preamble
- [ ] Non-`full` fidelity modes always create a fresh session
- [ ] `compact` produces structured Markdown table of completed nodes
- [ ] `truncate` produces graph goal + run ID only (minimal)
- [ ] `summary:*` produces deterministic text at appropriate detail levels
- [ ] Character budgets enforced per mode
- [ ] Non-codergen nodes unaffected by fidelity
- [ ] Generated preambles stored as artifacts for inspection
- [ ] `prompt.md` contains the actual rendered prompt sent to the model

### Thread Resolution & Session Reuse (A5)
- [ ] `resolveThreadId()` implements 5-step resolution chain: node → edge → graph default → class → previous
- [ ] Two codergen nodes with same `thread_id` and `fidelity="full"` reuse one live `AgentSession`
- [ ] First use of thread: `session.submit()`; reuse: `session.followUp()`
- [ ] `full` fidelity with no resolved thread ID gets a fresh ephemeral session
- [ ] Nodes with different thread_ids get independent sessions
- [ ] Provider/model mismatch on reused thread fails fast with clear error
- [ ] Per-thread FIFO lock prevents interleaved concurrent turns
- [ ] FIFO lock has configurable timeout to prevent deadlocks
- [ ] Fresh sessions for non-`full` modes closed after node completion
- [ ] Resumed runs never attempt to resurrect an in-memory session from a prior process
- [ ] `reasoning_effort` can change between turns on same session (C3)

### Degraded Resume
- [ ] If last codergen used `full`, next resumed codergen gets `summary:high`
- [ ] Flag clears after one codergen hop
- [ ] Non-codergen nodes don't consume the flag
- [ ] `pending_transition` persisted and used on resume
- [ ] `thread_registry_keys` persisted in checkpoint for reliable degraded-resume detection

### auto_status (A11)
- [ ] Handler with no explicit status + `auto_status=true` → SUCCESS outcome
- [ ] Warning event emitted when auto_status applied

### Test Coverage
- [ ] At least 55 new test cases across all phases
- [ ] Fidelity resolution: all precedence levels
- [ ] Thread resolution: all 5 chain steps + null fallback
- [ ] SessionRegistry: reuse, mismatch, locking, timeout, cleanup
- [ ] Preamble: all 6 modes, budget enforcement, truncation priority
- [ ] Engine integration: fidelity flows to handler, threads persist, degraded resume
- [ ] ArtifactStore: inline, file-backed, CRUD, boundary (exactly 100KB)
- [ ] Checkpoint: canonical + legacy round-trip, new fields, backward compat

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Default fidelity change (`compact` instead of implicit `full`) breaks existing pipelines** | Medium | Medium | Intentional — unbounded context is a bad default. Pipelines wanting `full` should declare it. Document in release notes. Integration tests verify existing pipelines still work (they just get terser context). |
| **Canonical run-directory migration breaks `status` or `resume`** | Medium | High | Dual-write canonical and legacy for one sprint. Read canonical first, legacy second. Integration tests for both paths. |
| **Two parallel branches share one thread key and corrupt conversation order** | Medium | High | `SessionRegistry` serializes access per thread key with FIFO lock. Shared thread = shared conversation, not shared concurrency. Test concurrent acquires. |
| **FIFO lock deadlocks from stalled LLM calls** | Low | High | Configurable timeout on per-thread lock (default 5 minutes). Stalled LLM calls abort and release the lock rather than blocking indefinitely. |
| **Deterministic preambles omit context the next node needs** | Medium | Medium | Bias toward recent failures, retries, human answers, and explicit context updates. Persist every generated preamble as an artifact so bad summaries are inspectable and tunable. |
| **Character budgets drift from real provider tokenization** | Medium | Low | Conservative 4 chars/token approximation with headroom. This sprint avoids a tokenizer dependency. Exact context-window accounting is a future L19/C1 sprint. |
| **`resume --force` after graph edits and stored transition no longer matches** | Medium | Medium | Keep `pending_transition` in checkpoint. Fail fast if target is gone under edited graph. Don't silently guess. |
| **Anthropic thinking signatures expire in long-running thread sessions** | Low | Medium | Thinking blocks are opaque — stored and returned without inspection. If API rejects, retry logic handles it. Document as known limitation for very long pipelines. |
| **Live sessions leak on failure or interruption** | Medium | Medium | SessionRegistry scoped to single run and disposed on completion, failure, and interruption. Lifecycle tests with forced errors. |
| **`src/checkpoint/` module creation adds migration surface** | Low | Low | Ensure cocoon.ts import paths are updated atomically. Test both canonical and legacy code paths. |
| **Inline artifact index grows too large for long runs** | Low | Medium | Keep metadata records compact. Canonical payload source is the artifact store, not checkpoint context. Monitor in integration tests. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `PipelineEngine` execution loop | Integration target | Implemented |
| `GardenNode.fidelity`, `GardenNode.threadId` | Parsed from DOT, validated | Implemented |
| `GardenEdge.fidelity`, `GardenEdge.threadId` | Parsed from DOT | Implemented |
| `GardenGraph.defaultFidelity` | Parsed from graph attrs | Implemented |
| `AgentSession` submit/steer/followUp/abort | Foundation for session reuse | Implemented |
| `ThinkingData.signature` (Sprint 014, L2) | Required for full-fidelity Anthropic thread reuse | Implemented |
| `Cocoon` checkpoint system | Extended with new fields | Implemented |
| Codergen handler | Integration target for fidelity-aware session creation | Implemented |
| CLI `run`/`resume`/`status` commands | User-facing surface kept compatible | Implemented |
| `src/garden/parse.ts` node default folding | Node-level fidelity/threadId already resolved in AST | Implemented |

**Zero new npm dependencies.** All work extends existing engine, checkpoint, handler, and session abstractions.

---

## Gap Closure Summary

| Gap | Description | Severity | Status After Sprint |
|-----|-------------|----------|-------------------|
| A3  | Formal ArtifactStore API | Low | **Closed** |
| A4  | Context fidelity runtime enforcement | **Medium** | **Closed** |
| A5  | Thread resolution and session reuse | **Medium** | **Closed** |
| A8  | CheckpointSaved event | Low | **Closed** |
| A10 | manifest.json in run directory | Low | **Closed** |
| A11 | auto_status runtime behavior | Low | **Closed** |
| C3  | reasoning_effort changeable mid-session | Low | **Closed** |

**2 Medium + 5 Low = 7 gaps closed.**

**After this sprint:**
- Attractor engine: 11 gaps → 4 (A1, A2, A6, A7, A9 remain — all Low except A1 Medium)
- **Attractor engine has exactly 1 Medium gap remaining** (A1 manager loop)
- Coding agent loop: 3 gaps → 2 (C1, C2 remain — both Low)
- Medium severity across all specs: 6 → 4
- Remaining mediums: A1 (manager loop), L7 (middleware), L8 (model catalog), L9 (generate loop)

**Recommended next sprint (016):**
- **A1 (Manager loop handler)** — the last medium gap in the attractor engine. With fidelity and session reuse in place, the supervisor pattern can leverage thread reuse to maintain coherent observation loops. This would bring the attractor engine to zero medium+ gaps.
- Alternatively: **Seedbed Foundation** — with structured output (L4) and the engine at near-full compliance, the product surface work for idea capture is fully unblocked.
