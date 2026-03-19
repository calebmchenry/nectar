# Sprint 001: Working CLI That Runs DOT Files

## Overview

**Goal:** Deliver a working `pollinator` CLI that can parse, validate, execute, checkpoint, and resume DOT-defined pipelines. After this sprint, `pollinator run gardens/compliance-loop.dot` produces themed terminal output and actually executes shell commands end-to-end.

**Scope:** Three of nine handler types (start, exit, tool), the full 5-step deterministic edge selection algorithm, JSON checkpointing with resume, and four CLI commands (`run`, `resume`, `validate`, `status`). The engine is event-driven and reusable by the future HTTP server.

**Out of scope:**
- Web UI ("The Hive"), seedbed backlog, swarm analysis
- LLM integration (codergen, unified LLM client)
- `wait.human`, `parallel`, `fan-in`, `manager loop`, `conditional` handler execution (these shapes fail at validation)
- HTTP server API
- Goal gates
- Model stylesheets
- Self-update, single-binary packaging, Windows support

---

## Use Cases

1. **Run a pipeline end-to-end:** `pollinator run gardens/compliance-loop.dot` parses the DOT file, starts at the `Mdiamond` node, executes tool nodes (running `script` attributes as shell commands), follows edges using 5-step deterministic selection, retries failed nodes with exponential backoff, and exits at the `Msquare` node. Themed output shows each node's progress.

2. **Resume an interrupted run:** User hits Ctrl+C mid-pipeline. A cocoon JSON was written after the last completed node. `pollinator resume <run-id>` loads the checkpoint and continues from where it left off.

3. **Validate a DOT file:** `pollinator validate gardens/compliance-loop.dot` checks structural correctness — one start node, at least one exit, all edges reference existing nodes, tool nodes have scripts, no unsupported node shapes — and reports errors with file:line:col format.

4. **Inspect runs:** `pollinator status` lists all cocoons. `pollinator status <run-id>` shows detailed state of a specific run.

5. **Handle failures gracefully:** A tool node exits non-zero. Engine checks `max_retries`, retries with exponential backoff, and if exhausted follows the failure edge (`condition="outcome=fail"`). If no failure edge exists, pipeline halts with a clear error.

---

## Architecture

### Language: TypeScript on Node.js 22+

- Shared type system with the eventual web UI and HTTP server
- `@ts-graphviz/parser` for DOT parsing (no custom parser)
- `execa` for subprocess execution with signal forwarding
- `commander` for CLI scaffolding
- `chalk` + `ora` for themed terminal output
- ES modules throughout, strict TypeScript
- `vitest` for unit and integration testing

### Module Layout

```
nectar/
├── src/
│   ├── cli/
│   │   ├── index.ts              # Commander program setup
│   │   ├── commands/
│   │   │   ├── run.ts            # pollinator run <file>
│   │   │   ├── resume.ts         # pollinator resume <run-id>
│   │   │   ├── validate.ts       # pollinator validate <file>
│   │   │   └── status.ts         # pollinator status [run-id]
│   │   └── ui/
│   │       ├── theme.ts          # Colors, emoji, pollination terms
│   │       └── renderer.ts       # Engine event → terminal output
│   ├── garden/
│   │   ├── types.ts              # GardenGraph, GardenNode, GardenEdge
│   │   ├── parse.ts              # @ts-graphviz/parser facade
│   │   └── validate.ts           # Structural validation rules
│   ├── engine/
│   │   ├── types.ts              # RunState, NodeOutcome, EngineEvent
│   │   ├── engine.ts             # Core execution loop
│   │   ├── edge-selector.ts      # 5-step deterministic algorithm
│   │   ├── conditions.ts         # Condition expression parser/evaluator
│   │   ├── retry.ts              # Exponential backoff logic
│   │   ├── context.ts            # Key-value execution context store
│   │   └── events.ts             # Typed event definitions
│   ├── handlers/
│   │   ├── registry.ts           # Shape/type → handler mapping
│   │   ├── start.ts              # Mdiamond handler
│   │   ├── exit.ts               # Msquare handler
│   │   └── tool.ts               # Parallelogram handler (shell exec)
│   ├── checkpoint/
│   │   ├── types.ts              # Cocoon schema
│   │   └── cocoon.ts             # Read/write/list (atomic writes)
│   └── process/
│       └── run-script.ts         # Shell execution wrapper + POLLINATOR_* env
├── scripts/
│   └── compliance_loop.mjs       # Deterministic fixture for sample garden
├── test/
│   ├── garden/
│   │   ├── parse.test.ts
│   │   └── validate.test.ts
│   ├── engine/
│   │   ├── edge-selector.test.ts
│   │   ├── conditions.test.ts
│   │   └── engine.test.ts
│   ├── handlers/
│   │   └── tool.test.ts
│   ├── checkpoint/
│   │   └── cocoon.test.ts
│   ├── integration/
│   │   ├── run.test.ts
│   │   └── resume.test.ts
│   └── fixtures/
│       ├── smoke-success.dot
│       ├── conditional-branch.dot
│       └── retry-once.dot
├── gardens/
│   └── compliance-loop.dot       # Updated to use compliance_loop.mjs
├── package.json
├── tsconfig.json
└── .gitignore
```

### Key Abstractions

**`GardenGraph`** — Immutable graph from parsed DOT. Nodes with attributes (shape, label, script, max_retries). Edges with attributes (label, condition, weight). O(1) node lookup. Built by a thin facade over `@ts-graphviz/parser`.

**`PipelineEngine`** — Stateful execution loop. Holds `RunState` (current node, completed nodes, context store, retry counts). Each tick: resolve handler → execute → collect outcome → select next edge → emit event → checkpoint → advance. Never prints directly — emits typed events only.

**`NodeHandler` interface** — `execute(node, context): Promise<NodeOutcome>`. Three implementations: `StartHandler` (no-op success), `ExitHandler` (terminates pipeline), `ToolHandler` (shell execution via `execa`).

**`EdgeSelector`** — Pure function implementing the 5-step deterministic algorithm. Input: outgoing edges + node outcome + context. Output: selected edge or null.

**`Cocoon`** — JSON checkpoint in `.nectar/cocoons/<run-id>.json`. Contains: run ID, DOT file path, graph hash (SHA-256), completed nodes with outcomes/timings/retries, current node, context snapshot, retry state, interruption reason, timestamps.

**`RunEvent`** — Typed union: `run_started`, `node_started`, `node_completed`, `node_retrying`, `edge_selected`, `run_completed`, `run_interrupted`, `run_error`. CLI renderer subscribes to these.

### Data Flow

```
DOT file → @ts-graphviz/parser → GardenGraph (validated)
                                       │
                                       ▼
                               PipelineEngine ◀── Cocoon (if resuming)
                                       │
                          ┌────────────┼────────────┐
                          ▼            ▼            ▼
                    Handler       EdgeSelector   Cocoon
                    Registry      (5-step)       Writer
                          │
                          ▼
                    RunEvent stream → CLI Renderer (themed output)
```

---

## Implementation

### Phase 1: Project Scaffolding & DOT Parsing (~25%)

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `src/garden/types.ts`, `src/garden/parse.ts`, `src/garden/validate.ts`, `test/garden/parse.test.ts`, `test/garden/validate.test.ts`

**Tasks:**
- [ ] Initialize npm project: `type: "module"`, ESM TypeScript, strict mode
- [ ] Add dependencies: `@ts-graphviz/parser`, `commander`, `chalk`, `ora`, `execa`
- [ ] Add dev dependencies: `typescript`, `tsx`, `vitest`, `@types/node`
- [ ] Create `src/garden/types.ts`: `GardenGraph`, `GardenNode`, `GardenEdge` types. Preserve raw attribute maps for forward compatibility.
- [ ] Create `src/garden/parse.ts`: Facade over `@ts-graphviz/parser`. Normalize chained edges (`A -> B -> C` → two edges). Coerce known numeric attrs (`max_retries`). Map shape strings to handler types. Support `type` attribute override (per spec: `type` takes precedence over shape).
- [ ] Create `src/garden/validate.ts`: Pure functions returning `Diagnostic[]` with severity, message, source location.
  - Exactly one `Mdiamond` start node
  - At least one `Msquare` exit node
  - All edge targets reference existing nodes
  - No duplicate node IDs
  - No unreachable nodes (BFS from start)
  - Tool nodes (`parallelogram`) must have non-empty `script` attribute
  - **Unsupported shapes are rejected** (only `Mdiamond`, `Msquare`, `parallelogram` allowed this sprint)
  - `max_retries` must be a non-negative integer when present
  - Condition expressions use valid syntax
  - Every cycle has at least one edge that can reach an exit node
- [ ] Tests: parse `compliance-loop.dot` → assert correct node count, shapes, edges, attributes. Test validation rejects malformed graphs with proper diagnostics.

### Phase 2: Engine Core & Edge Selection (~30%)

**Files:** `src/engine/types.ts`, `src/engine/engine.ts`, `src/engine/edge-selector.ts`, `src/engine/conditions.ts`, `src/engine/retry.ts`, `src/engine/context.ts`, `src/engine/events.ts`, `src/handlers/registry.ts`, `src/handlers/start.ts`, `src/handlers/exit.ts`, `src/handlers/tool.ts`, `src/process/run-script.ts`, `test/engine/edge-selector.test.ts`, `test/engine/conditions.test.ts`, `test/handlers/tool.test.ts`

**Tasks:**
- [ ] Implement 5-step deterministic edge selection:
  1. **Condition match**: Evaluate edge `condition` against outcome + context. Edges whose conditions match are candidates. `Fallback`-labeled edges are candidates only when no condition-matched edge was found.
  2. **Preferred label**: If handler returns a `preferred_label`, prefer edges with that label.
  3. **Suggested IDs**: If handler returns `suggested_next` node IDs, prefer edges leading to those nodes.
  4. **Weight**: Among remaining candidates, highest `weight` wins (default 0).
  5. **Lexical order**: Tiebreaker — sort by target node ID, pick first.
  - At each step, if exactly one candidate remains, select immediately. If zero after all steps, return null.
- [ ] Implement condition parser (allowlist grammar, no `eval`):
  - `outcome=success`, `outcome=fail`
  - `context.<key>=<value>`
  - Compound: `&&`, `||`
  - No parenthetical grouping this sprint (add when needed)
- [ ] Implement `ExecutionContext`: `Map<string, string>` with `get`/`set`/`snapshot`/`restore`.
- [ ] Implement retry: exponential backoff with `max_retries` node attribute. Default `max_retries=0` (no retries). Base delay 1s, multiplier 2x. Node-level `max_retries` is the only configuration this sprint.
- [ ] Implement `NodeHandler` interface + handlers:
  - `StartHandler`: returns `{ status: 'success' }` immediately
  - `ExitHandler`: returns `{ status: 'success' }`, engine terminates pipeline
  - `ToolHandler`: spawns `script` via `execa` with `shell: true`, `cwd = process.cwd()`. Captures stdout/stderr. Exit code 0 → success, non-zero → failure. Default timeout 5 minutes, overridable via `timeout` node attribute. Injects env vars: `POLLINATOR_RUN_ID`, `POLLINATOR_NODE_ID`, `POLLINATOR_ATTEMPT`, `POLLINATOR_RUN_DIR`, `POLLINATOR_GARDEN_PATH`.
- [ ] Implement handler registry: map shape → handler. `type` attribute overrides shape.
- [ ] Implement `PipelineEngine`:
  - Constructor: `DirectedGraph` + optional `Cocoon`
  - `async run(): Promise<RunResult>` — iterative loop (not recursive)
  - Emits typed `RunEvent`s, never prints directly
  - On SIGINT/SIGTERM: checkpoint current state with `status: interrupted` and reason, exit cleanly
- [ ] Tests: exhaustive edge selection (each step in isolation + combined), condition parsing, tool handler with success/failure/timeout, retry with backoff.

### Phase 3: Checkpoint System (~15%)

**Files:** `src/checkpoint/types.ts`, `src/checkpoint/cocoon.ts`, `test/checkpoint/cocoon.test.ts`

**Tasks:**
- [ ] Define cocoon JSON schema:
  ```typescript
  interface Cocoon {
    version: 1
    run_id: string                // crypto.randomUUID()
    dot_file: string              // Relative path to source DOT
    graph_hash: string            // SHA-256 of DOT file content
    started_at: string            // ISO 8601
    updated_at: string            // ISO 8601
    status: 'running' | 'completed' | 'failed' | 'interrupted'
    interruption_reason?: string
    completed_nodes: {
      node_id: string
      status: 'success' | 'failure'
      started_at: string
      completed_at: string
      retries: number
    }[]
    current_node?: string
    context: Record<string, string>
    retry_state: Record<string, number>
  }
  ```
- [ ] Write cocoons to `.nectar/cocoons/<run-id>.json` (create directory if needed)
- [ ] Store tool node stdout/stderr logs to `.nectar/cocoons/<run-id>/<node-id>/attempt-<n>.{stdout,stderr}.log` (not inline in cocoon JSON — prevents bloat)
- [ ] Atomic writes: write to temp file, then `rename()`. Prevents corruption on crash.
- [ ] `writeCocoon()`, `readCocoon()`, `listCocoons()` functions
- [ ] On resume: load cocoon, re-parse DOT file, verify `graph_hash` — **error and stop** if hash changed (user must pass `--force` to override). Restore context and retry state, continue from `current_node`.
- [ ] Tests: round-trip write/read, atomic write survives simulated crash, list cocoons, hash mismatch detection.

### Phase 4: CLI Shell & Themed Output (~20%)

**Files:** `src/cli/index.ts`, `src/cli/commands/run.ts`, `src/cli/commands/resume.ts`, `src/cli/commands/validate.ts`, `src/cli/commands/status.ts`, `src/cli/ui/theme.ts`, `src/cli/ui/renderer.ts`

**Tasks:**
- [ ] Set up commander: name `pollinator`, version `0.1.0`, themed description
- [ ] `run` command: parse → validate → create engine → subscribe to events → execute → print summary
- [ ] `resume` command: load cocoon (or list if no ID) → rebuild graph → verify hash → resume engine
  - `--force` flag to bypass graph hash mismatch
- [ ] `validate` command: parse → validate → print diagnostics with `file:line:col` format → exit 0 if valid, 1 if errors
- [ ] `status` command: no args lists all cocoons with summary; with run ID shows detailed state
- [ ] Theme system:
  ```
  🐝 Pollinator    🌸 Garden loaded    🌻 Petal blooming
  ✅ Sweet success  ❌ Wilted           🔄 Re-pollinating
  🍯 Honey         🥀 Pipeline wilted  💤 Hibernating
  ```
  Colors: green success, red failure, yellow warning, cyan info, dim muted
- [ ] Event renderer:
  - `node_started` → `🌻 Petal [node_id] blooming...` with spinner
  - `node_completed` (success) → `✅ sweet success (Xs)`
  - `node_completed` (failure) → `❌ wilted (exit code N)`
  - `node_retrying` → `🔄 Re-pollinating [node_id] (attempt N/M)...`
  - `run_completed` → `🍯 Garden pollinated! N petals, Xs total`
  - `run_error` → `🥀 Pipeline wilted: [reason]`
  - `run_interrupted` → `💤 Run [id] hibernating. Resume with: pollinator resume [id]`
- [ ] TTY detection: if stdout is not TTY (piped), disable colors/spinners, output plain text. Respect `NO_COLOR` env var.
- [ ] Signal handling: SIGINT/SIGTERM → print `Saving cocoon...`, checkpoint, print resume hint, exit 0

### Phase 5: Fixture Script & Integration Tests (~10%)

**Files:** `scripts/compliance_loop.mjs`, `gardens/compliance-loop.dot` (modify), `test/integration/run.test.ts`, `test/integration/resume.test.ts`, `test/fixtures/*.dot`

**Tasks:**
- [ ] Create `scripts/compliance_loop.mjs`:
  - Deterministic local behavior (no external dependencies)
  - `audit`: fails until validation passes (uses run-dir state file)
  - `implement`: fails on attempt 1, succeeds on attempt 2 (exercises retry)
  - `draft`, `critique`, `merge`, `fetch-weather`: succeed with trace messages
  - `validate`: marks run as compliant (writes state file)
  - Uses `POLLINATOR_RUN_DIR` for isolated per-run state
- [ ] Update `gardens/compliance-loop.dot`: replace `python3 scripts/compliance_loop.py` with `node scripts/compliance_loop.mjs`
- [ ] Create test fixtures:
  - `smoke-success.dot`: start → tool (echo hello) → exit
  - `conditional-branch.dot`: start → tool → diamond-like routing (success/fail edges) → exit
  - `retry-once.dot`: start → tool (fails first, succeeds second, max_retries=1) → exit
- [ ] Integration tests:
  - Run `smoke-success.dot` end-to-end, verify output and final cocoon status
  - Run `compliance-loop.dot`, verify it completes (exercises retry, loop-back, conditional routing)
  - Interrupt a run mid-pipeline, verify cocoon exists, resume and verify completion
  - Validate invalid DOT file, verify diagnostics with file:line:col
  - Run with piped stdout, verify no ANSI codes

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Create | Project manifest, dependencies, bin entry, scripts |
| `tsconfig.json` | Create | Strict TS, ES2022, ESM, NodeNext resolution |
| `.gitignore` | Create | Ignore node_modules, dist, .nectar/cocoons runtime data |
| `src/garden/types.ts` | Create | GardenGraph, GardenNode, GardenEdge types |
| `src/garden/parse.ts` | Create | `@ts-graphviz/parser` facade, edge normalization |
| `src/garden/validate.ts` | Create | Structural validation rules, Diagnostic[] output |
| `src/engine/types.ts` | Create | RunState, NodeOutcome, RunResult types |
| `src/engine/engine.ts` | Create | PipelineEngine core execution loop |
| `src/engine/edge-selector.ts` | Create | 5-step deterministic edge selection |
| `src/engine/conditions.ts` | Create | Condition expression parser (allowlist, no eval) |
| `src/engine/retry.ts` | Create | Exponential backoff logic |
| `src/engine/context.ts` | Create | Key-value execution context store |
| `src/engine/events.ts` | Create | Typed RunEvent definitions |
| `src/handlers/registry.ts` | Create | Shape/type → handler mapping |
| `src/handlers/start.ts` | Create | Start node handler (no-op success) |
| `src/handlers/exit.ts` | Create | Exit node handler (terminates pipeline) |
| `src/handlers/tool.ts` | Create | Tool node handler (shell exec via execa) |
| `src/checkpoint/types.ts` | Create | Cocoon JSON schema types |
| `src/checkpoint/cocoon.ts` | Create | Read/write/list cocoons, atomic writes |
| `src/process/run-script.ts` | Create | Shell exec wrapper, POLLINATOR_* env vars |
| `src/cli/index.ts` | Create | Commander program setup |
| `src/cli/commands/run.ts` | Create | `pollinator run` command |
| `src/cli/commands/resume.ts` | Create | `pollinator resume` command |
| `src/cli/commands/validate.ts` | Create | `pollinator validate` command |
| `src/cli/commands/status.ts` | Create | `pollinator status` command |
| `src/cli/ui/theme.ts` | Create | Colors, emoji, terminology constants |
| `src/cli/ui/renderer.ts` | Create | RunEvent → themed terminal output |
| `scripts/compliance_loop.mjs` | Create | Deterministic fixture for sample garden |
| `gardens/compliance-loop.dot` | Modify | Point scripts at compliance_loop.mjs |
| `test/garden/parse.test.ts` | Create | Parser unit tests |
| `test/garden/validate.test.ts` | Create | Validation rule tests |
| `test/engine/edge-selector.test.ts` | Create | Edge selection algorithm tests (all 5 steps) |
| `test/engine/conditions.test.ts` | Create | Condition parser tests |
| `test/engine/engine.test.ts` | Create | Engine execution tests |
| `test/handlers/tool.test.ts` | Create | Tool handler tests (success/fail/timeout) |
| `test/checkpoint/cocoon.test.ts` | Create | Checkpoint round-trip tests |
| `test/integration/run.test.ts` | Create | End-to-end pipeline execution |
| `test/integration/resume.test.ts` | Create | Interrupt + resume test |
| `test/fixtures/smoke-success.dot` | Create | Minimal linear pipeline fixture |
| `test/fixtures/conditional-branch.dot` | Create | Conditional routing fixture |
| `test/fixtures/retry-once.dot` | Create | Retry behavior fixture |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `pollinator validate gardens/compliance-loop.dot` exits 0 with no errors
- [ ] `pollinator validate` rejects invalid DOT files with `file:line:col` diagnostics
- [ ] `pollinator validate` rejects unsupported node shapes (box, hexagon, etc.)
- [ ] `pollinator run gardens/compliance-loop.dot` completes successfully end-to-end
- [ ] The compliance-loop run exercises at least one retry and one loop-back before exiting
- [ ] Tool nodes execute their `script` attributes and set outcome based on exit code
- [ ] Edge selection correctly implements all 5 deterministic steps (verified by unit tests)
- [ ] Condition expressions evaluate `outcome=success`, `outcome=fail`, `context.<key>=<value>`, and `&&`/`||`
- [ ] A cocoon JSON is written to `.nectar/cocoons/<run-id>.json` after every completed node
- [ ] Tool stdout/stderr logs are stored under `.nectar/cocoons/<run-id>/<node-id>/`
- [ ] Ctrl+C during a run checkpoints state and prints a resume hint
- [ ] `pollinator resume <run-id>` continues from the last completed node
- [ ] `pollinator resume` errors when graph hash has changed (unless `--force`)
- [ ] `pollinator status` lists all cocoons; `pollinator status <id>` shows details
- [ ] Terminal output uses the pollination theme (emoji, colors, bee puns)
- [ ] Piped output (`pollinator run ... | cat`) has no ANSI codes or spinners
- [ ] `npm test` passes all unit and integration tests
- [ ] Retry logic works: `max_retries=2` retries twice with exponential backoff before following failure edge
- [ ] Tool nodes timeout after 5 minutes by default (overridable via `timeout` attribute)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `@ts-graphviz/parser` doesn't preserve edge order or attributes needed for execution | Medium | High | Facade in `parse.ts` abstracts the library. Golden tests against `compliance-loop.dot` catch regressions. Parser can be swapped without touching engine. |
| Edge selection algorithm has subtle spec ambiguity | Medium | High | Exhaustive unit tests for each of the 5 steps individually and combined. Document interpretations. |
| Tool node scripts hang indefinitely | Medium | Medium | Default 5-minute timeout, overridable per node. Kill process on expiry. |
| Resume with non-idempotent tool scripts | Medium | Medium | Document that tool scripts must be idempotent for safe resume. Incomplete nodes are re-run from scratch. |
| Checkpoint corruption on crash during write | Low | High | Atomic writes via temp-file + rename. |
| DOT file changes between run and resume | Medium | Medium | Graph hash check on resume. Strict by default — error unless `--force`. |
| Cycle with no reachable exit node | Low | Medium | Validation checks every cycle has at least one edge toward an exit node. |
| Large stdout/stderr from tool nodes | Low | Medium | Logs stored in separate files, not inline in cocoon JSON. |
| Shell behavior differences macOS vs Linux | Low | Medium | `execa` abstracts most differences. CI on both platforms in future sprint. |

---

## Security Considerations

- **Shell command execution is by design.** DOT files are trusted local automation, same threat model as `make` or npm scripts. Users should not run untrusted DOT files.
- **No `eval`/`Function`/shell interpolation** for condition expressions. Allowlist grammar only.
- **No privilege escalation.** Tool nodes run as the current user.
- **POLLINATOR_* env vars only.** Process environment is not dumped to output.
- **Atomic cocoon writes** prevent partial JSON that could be misinterpreted on resume.
- **Cocoon files are gitignored** by default (contain runtime state, not source).

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@ts-graphviz/parser` | DOT file parsing |
| `commander` | CLI argument parsing and help text |
| `chalk` | Terminal colors (ESM-native) |
| `ora` | Terminal spinners |
| `execa` | Subprocess execution with signal forwarding |
| `typescript` | Language (dev) |
| `tsx` | Dev-time TS execution |
| `vitest` | Testing framework (dev) |
| `@types/node` | Node.js type definitions (dev) |

No runtime database. No bundler. No config library beyond commander. Intentionally minimal.

---

## Open Questions (Resolved)

| Question | Resolution | Source |
|----------|------------|--------|
| Language choice | TypeScript on Node 22 | All three drafts unanimous |
| Parser strategy | `@ts-graphviz/parser` behind facade | All three critiques unanimous |
| Unsupported node types | Fail at validation | User interview |
| Runtime packaging | Node 22, no single binary this sprint | User interview |
| Cocoon location | `.nectar/cocoons/` | User interview |
| CLI binary name | `pollinator` | Intent doc preference |
| Tool node cwd | `process.cwd()` (where pollinator was invoked) | Matches `make` semantics |
| `max_retries` default | 0 (no retries) when attribute absent | Claude critique recommendation |
| Test runner | `vitest` | Better integration test DX than `node:test` |
| Graph hash mismatch on resume | Error by default, `--force` to override | Codex critique recommendation |
