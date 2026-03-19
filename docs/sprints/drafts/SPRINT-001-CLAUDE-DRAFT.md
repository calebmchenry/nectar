# Sprint 001: Working CLI That Runs DOT Files

## Overview

This sprint delivers the minimum viable Pollinator: a TypeScript CLI that can parse a DOT file, build an in-memory directed graph, execute nodes according to the attractor spec's deterministic edge-selection algorithm, checkpoint progress after every node, and resume interrupted runs. By the end, `pollinator run gardens/compliance-loop.dot` produces themed terminal output and actually executes shell commands defined in tool nodes.

The scope is deliberately narrow. We implement three of the nine handler types (start, exit, tool), stub the remaining six, and skip everything that requires LLM integration (codergen, manager loop, unified LLM client). No HTTP server, no web UI, no seedbed. The goal is a rock-solid execution foundation that every future sprint builds on top of.

**Why TypeScript?** The full Nectar system includes a web UI (React/Svelte SPA), an HTTP server with SSE streaming, and heavy JSON/YAML manipulation. TypeScript gives us one language across CLI, server, and shared types. The npm ecosystem provides battle-tested libraries for terminal UI (chalk, ora), CLI scaffolding (commander), and process management (execa). Cross-platform distribution is solved by compiling to a single binary via `pkg` or `bun build --compile` in a later sprint. Go would produce a nicer binary today but would force us to rewrite shared types and validation logic when the web UI arrives.

## Use Cases

1. **Run a pipeline end-to-end**: User runs `pollinator run gardens/compliance-loop.dot`. The CLI parses the DOT file, identifies the start node (`Mdiamond`), traverses the graph executing tool nodes (running their `script` attribute as shell commands), follows edges using the 5-step deterministic algorithm, and exits at the exit node (`Msquare`). Each node prints themed status output.

2. **Resume an interrupted run**: User hits Ctrl+C mid-pipeline (or laptop dies). A cocoon JSON file was written after the last completed node. User runs `pollinator resume <run-id>` and execution picks up from where it left off.

3. **Validate a DOT file**: User runs `pollinator validate gardens/compliance-loop.dot`. The CLI parses the file and checks structural correctness: exactly one start node, at least one exit node, all edges reference existing nodes, no orphan nodes, tool nodes have `script` attributes. Reports errors with line numbers.

4. **Inspect a run**: User runs `pollinator status <run-id>` to see the current state of a pipeline run — which nodes completed, which failed, what's next.

5. **Handle failures gracefully**: A tool node's shell command exits non-zero. The engine marks the node as failed, checks for retry configuration (`max_retries`), retries with exponential backoff if configured, and if retries are exhausted follows the failure edge (condition `outcome=fail`). If no failure edge exists, the pipeline halts with a clear error.

## Architecture

### Language Choice Rationale

**TypeScript on Node.js 20+** using ES modules throughout.

- Shared type system with the eventual web UI and HTTP server
- `execa` for subprocess execution with proper signal forwarding
- `commander` for CLI argument parsing (mature, well-typed)
- `chalk` + `ora` for themed terminal output
- Native `node:fs` and `node:path` for file-system-first architecture
- `node:test` + `node:assert` for zero-dependency testing
- No build step for development: `tsx` for direct TS execution, `tsup` for production bundling

### Module Layout

```
nectar/
├── src/
│   ├── cli/                    # CLI entry point and commands
│   │   ├── index.ts            # Main entry, commander setup
│   │   ├── commands/
│   │   │   ├── run.ts          # `pollinator run <file>`
│   │   │   ├── resume.ts       # `pollinator resume <run-id>`
│   │   │   ├── validate.ts     # `pollinator validate <file>`
│   │   │   └── status.ts       # `pollinator status [run-id]`
│   │   └── ui/
│   │       ├── theme.ts        # Colors, emoji, pollination terms
│   │       └── renderer.ts     # Node status rendering, spinners
│   ├── parser/                 # DOT file parser
│   │   ├── lexer.ts            # Tokenizer
│   │   ├── parser.ts           # Recursive-descent parser → AST
│   │   ├── ast.ts              # AST node types
│   │   └── errors.ts           # Parse errors with line/col info
│   ├── graph/                  # Graph data structures
│   │   ├── graph.ts            # DirectedGraph class
│   │   ├── types.ts            # Node, Edge, Attribute types
│   │   └── builder.ts          # AST → DirectedGraph construction
│   ├── engine/                 # Pipeline execution engine
│   │   ├── engine.ts           # Core run loop
│   │   ├── edge-selector.ts    # 5-step deterministic edge selection
│   │   ├── retry.ts            # Exponential backoff + retry policies
│   │   ├── context.ts          # Execution context store
│   │   └── types.ts            # RunState, NodeOutcome, etc.
│   ├── handlers/               # Node handler registry + implementations
│   │   ├── registry.ts         # Handler lookup by shape/type
│   │   ├── start.ts            # Mdiamond handler
│   │   ├── exit.ts             # Msquare handler
│   │   ├── tool.ts             # parallelogram handler (shell exec)
│   │   └── stub.ts             # Stub handler for unimplemented types
│   ├── checkpoint/             # Cocoon persistence
│   │   ├── cocoon.ts           # Read/write checkpoint JSON
│   │   └── types.ts            # Checkpoint schema types
│   └── validator/              # DOT file validation
│       ├── rules.ts            # Individual lint rules
│       └── validate.ts         # Run all rules, collect diagnostics
├── test/
│   ├── parser/                 # Parser unit tests
│   │   └── parser.test.ts
│   ├── engine/                 # Engine unit tests
│   │   ├── edge-selector.test.ts
│   │   └── engine.test.ts
│   ├── handlers/
│   │   └── tool.test.ts
│   ├── checkpoint/
│   │   └── cocoon.test.ts
│   └── integration/
│       ├── run.test.ts         # End-to-end pipeline execution
│       └── resume.test.ts      # Interrupt + resume
├── gardens/                    # Pipeline definitions (already exists)
│   └── compliance-loop.dot
├── test/fixtures/              # Test DOT files
│   ├── simple-linear.dot       # A → B → C, no branching
│   ├── conditional-branch.dot  # Diamond node with success/fail edges
│   └── retry-node.dot          # Tool node with max_retries
├── package.json
├── tsconfig.json
└── .gitignore
```

### Key Abstractions

**`DirectedGraph`** — Immutable graph built from parsed DOT. Nodes and edges stored as adjacency lists. Each node carries its attributes (shape, label, script, max_retries, etc.). Each edge carries its attributes (label, condition, weight). Lookup by node ID is O(1).

**`PipelineEngine`** — Stateful execution loop. Holds a `RunState` (current node, completed nodes, context store, retry counts). On each tick: resolve handler for current node → execute handler → collect outcome → select next edge → checkpoint → advance. Emits events for the CLI renderer.

**`NodeHandler` interface** — `execute(node: GraphNode, context: ExecutionContext): Promise<NodeOutcome>`. Each handler type implements this. `NodeOutcome` is `{ status: 'success' | 'failure', output?: string, context_updates?: Record<string, string> }`.

**`EdgeSelector`** — Pure function implementing the 5-step deterministic algorithm. Input: list of outgoing edges + current node outcome + context store. Output: selected edge (or null if no valid edge).

**`Cocoon`** — JSON checkpoint file. Contains: run ID, DOT file path, graph hash, completed nodes with outcomes, current node, context store snapshot, retry state, interruption reason (if any), timestamps.

### Data Flow

```
DOT file on disk
    │
    ▼
┌──────────┐     ┌───────────┐     ┌───────────────┐
│  Lexer   │────▶│  Parser   │────▶│ DirectedGraph  │
│ (tokens) │     │  (AST)    │     │  (validated)   │
└──────────┘     └───────────┘     └───────┬───────┘
                                           │
                                           ▼
                                   ┌───────────────┐
                                   │ PipelineEngine │◀── Cocoon (if resuming)
                                   └───────┬───────┘
                                           │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                        ┌──────────┐ ┌──────────┐ ┌──────────┐
                        │ Handler  │ │  Edge    │ │ Cocoon   │
                        │ Registry │ │ Selector │ │ Writer   │
                        └──────────┘ └──────────┘ └──────────┘
                              │
                              ▼
                     ┌────────────────┐
                     │  CLI Renderer  │
                     │  (themed UI)   │
                     └────────────────┘
```

## Implementation

### Phase 1: Project Scaffolding & DOT Parser (~30% of effort)

**Files:**
- `package.json` — Project manifest with dependencies
- `tsconfig.json` — Strict TS config, ES2022 target, ESM
- `.gitignore` — node_modules, dist, cocoons runtime data
- `src/parser/ast.ts` — AST types for DOT digraphs
- `src/parser/lexer.ts` — Tokenizer for DOT syntax
- `src/parser/parser.ts` — Recursive-descent parser
- `src/parser/errors.ts` — Error types with source locations
- `test/parser/parser.test.ts` — Parser tests against compliance-loop.dot
- `test/fixtures/simple-linear.dot` — Minimal test fixture

**Tasks:**
- [ ] Initialize npm project with `type: "module"`, add dev dependencies: `typescript`, `tsx`, `tsup`, `@types/node`
- [ ] Configure `tsconfig.json`: strict mode, ES2022, NodeNext module resolution, paths alias `@/` → `src/`
- [ ] Implement DOT lexer supporting: `digraph`, `{`, `}`, `[`, `]`, `=`, `,`, `;`, `->`, identifiers, quoted strings, comments (`//` and `/* */`), graph/node/edge attribute blocks
- [ ] Implement recursive-descent parser: parse `digraph ID { ... }`, node statements with attribute lists, edge statements with chaining (`A -> B -> C`), graph-level attribute blocks (`graph [...]`, `node [...]`, `edge [...]`)
- [ ] Parse all DOT attribute types: strings (quoted), identifiers (unquoted), integers, floats, booleans
- [ ] Generate AST with source location tracking (line, column) on every node for error reporting
- [ ] Test: parse `gardens/compliance-loop.dot` → assert 12 nodes, correct shapes, correct edge count, correct script attributes

**DOT parser scope**: We parse the subset of Graphviz DOT that the attractor spec uses. Not full Graphviz — no HTML labels, no record shapes, no rank constraints, no clusters as execution groups. Subgraphs are parsed but treated as purely cosmetic grouping (they don't affect execution semantics this sprint).

**Lexer token types:**
```typescript
type TokenType =
  | 'DIGRAPH' | 'GRAPH' | 'NODE' | 'EDGE'
  | 'SUBGRAPH'
  | 'LBRACE' | 'RBRACE' | 'LBRACKET' | 'RBRACKET'
  | 'EQUALS' | 'COMMA' | 'SEMICOLON' | 'ARROW'
  | 'IDENTIFIER' | 'STRING' | 'NUMBER'
  | 'EOF'
```

### Phase 2: Graph Construction & Validation (~15% of effort)

**Files:**
- `src/graph/types.ts` — Node, Edge, GraphAttributes types
- `src/graph/graph.ts` — DirectedGraph class
- `src/graph/builder.ts` — AST → DirectedGraph transformer
- `src/validator/rules.ts` — Validation rule implementations
- `src/validator/validate.ts` — Rule runner
- `test/fixtures/conditional-branch.dot` — Test fixture with diamond node

**Tasks:**
- [ ] Define `GraphNode` type: `{ id, shape, label, attributes: Record<string, string | number | boolean> }` — shape maps to handler type
- [ ] Define `GraphEdge` type: `{ from, to, label?, condition?, weight? }`
- [ ] Implement `DirectedGraph` class: add/get nodes, add/get edges, get outgoing/incoming edges for a node, find start node (`Mdiamond`), find exit nodes (`Msquare`)
- [ ] Implement builder: walk AST, resolve graph-level defaults, build nodes and edges, apply edge chaining (a single `A -> B -> C` statement produces two edges)
- [ ] Implement validation rules (subset for this sprint):
  - Exactly one `Mdiamond` start node
  - At least one `Msquare` exit node
  - All edge targets reference existing nodes
  - No unreachable nodes (every node reachable from start via BFS)
  - Tool nodes (`parallelogram`) must have a `script` attribute
  - No duplicate node IDs
  - Condition expressions use valid syntax (`outcome=success`, `outcome=fail`, compound with `&&`/`||`)
- [ ] Validation produces `Diagnostic[]` with severity (error/warning), message, and source location

### Phase 3: Engine Core & Edge Selection (~25% of effort)

**Files:**
- `src/engine/types.ts` — RunState, NodeOutcome, EngineEvent types
- `src/engine/edge-selector.ts` — 5-step deterministic algorithm
- `src/engine/retry.ts` — Retry policies and backoff
- `src/engine/context.ts` — Key-value execution context store
- `src/engine/engine.ts` — PipelineEngine run loop
- `src/handlers/registry.ts` — Shape → handler mapping
- `src/handlers/start.ts` — Start handler (no-op, always succeeds)
- `src/handlers/exit.ts` — Exit handler (terminates pipeline)
- `src/handlers/tool.ts` — Tool handler (shell execution via execa)
- `src/handlers/stub.ts` — Stub handler for unimplemented types (logs warning, succeeds)
- `test/engine/edge-selector.test.ts` — Edge selection unit tests
- `test/handlers/tool.test.ts` — Tool handler tests
- `test/fixtures/retry-node.dot` — Fixture with max_retries

**Tasks:**
- [ ] Implement 5-step edge selection (this is the heart of the attractor spec):
  1. **Condition match**: Evaluate edge `condition` attributes against current outcome and context. Edges whose conditions match are candidates. Syntax: `outcome=success`, `outcome=fail`, `context.key=value`, compound with `&&`/`||`.
  2. **Preferred label**: If the current node's outcome suggests a label (e.g., `"success"` → look for edge labeled `"Pass"`), prefer edges with matching labels. The mapping is: handler returns a `preferred_label` string, edges with that label get priority.
  3. **Suggested IDs**: If the handler returns `suggested_next` node IDs, prefer edges leading to those nodes.
  4. **Weight**: Among remaining candidates, pick the edge with the highest `weight` attribute (default weight = 0).
  5. **Lexical order**: Final tiebreaker — sort candidate edges by target node ID lexicographically, pick first.
  - At each step, if exactly one candidate remains, select it immediately. If zero candidates remain after all steps, return null (pipeline halts with error unless at exit node).
  - A `"Fallback"` labeled edge is selected only when no condition-matched edge was found (it acts as a default/else branch).
- [ ] Implement `ExecutionContext`: simple `Map<string, string>` with `get`/`set`/`snapshot`/`restore`. Handlers can write to context (e.g., `context.tests_passed=true`).
- [ ] Implement retry logic:
  - `RetryPolicy` enum: `none` (default), `standard` (3 retries, 1s/2s/4s), `aggressive` (5 retries, 500ms base), `linear` (3 retries, 2s fixed), `patient` (3 retries, 5s base)
  - Node-level `max_retries` attribute overrides policy retry count
  - `computeBackoff(attempt, policy): number` — returns delay in ms
  - Engine loop: on failure, if retries remain, wait backoff duration, re-execute node. On retry exhaustion, follow failure edge.
- [ ] Implement `NodeHandler` interface and handlers:
  - `StartHandler`: returns `{ status: 'success' }` immediately
  - `ExitHandler`: returns `{ status: 'success' }`, engine recognizes exit node and terminates
  - `ToolHandler`: spawns `script` attribute as shell command via `execa`. Captures stdout/stderr. Exit code 0 → success, non-zero → failure. Timeout from `timeout` attribute (default 30s). Stores stdout in context as `context.<node_id>.stdout`.
  - `StubHandler`: for `box`, `hexagon`, `diamond`, `component`, `tripleoctagon`, `house` — logs "handler not implemented for [shape]", returns success so pipeline can continue past them during testing
- [ ] Implement handler registry: map `shape` string → handler instance. Support `type` attribute override (per spec: `type` attribute takes precedence over shape-based resolution).
- [ ] Implement `PipelineEngine`:
  - Constructor takes `DirectedGraph` + optional `Cocoon` (for resume)
  - `async run(): Promise<RunResult>` — main loop
  - Loop: find current node → resolve handler → execute → handle retry on failure → select next edge → emit event → checkpoint → advance
  - On SIGINT/SIGTERM: checkpoint current state, record interruption reason, exit cleanly
  - Engine emits typed events: `node:start`, `node:success`, `node:failure`, `node:retry`, `edge:selected`, `pipeline:complete`, `pipeline:error`

### Phase 4: Checkpoint System (~10% of effort)

**Files:**
- `src/checkpoint/types.ts` — Cocoon schema types
- `src/checkpoint/cocoon.ts` — Read/write/list checkpoints
- `test/checkpoint/cocoon.test.ts` — Checkpoint round-trip tests

**Tasks:**
- [ ] Define cocoon JSON schema:
  ```typescript
  interface Cocoon {
    version: 1
    run_id: string              // UUID
    dot_file: string            // Relative path to source DOT
    graph_hash: string          // SHA-256 of DOT file content
    started_at: string          // ISO 8601
    updated_at: string          // ISO 8601
    status: 'running' | 'completed' | 'failed' | 'interrupted'
    interruption_reason?: string
    completed_nodes: {
      node_id: string
      status: 'success' | 'failure'
      started_at: string
      completed_at: string
      output?: string
      retries: number
    }[]
    current_node?: string       // Node ID engine was about to execute
    context: Record<string, string>
    retry_state: Record<string, number>  // node_id → attempts used
  }
  ```
- [ ] Write cocoons to `cocoons/<run-id>.json` (create `cocoons/` directory relative to working directory if not exists)
- [ ] Implement `writeCocoon(cocoon: Cocoon): void` — atomic write (write to temp file, rename)
- [ ] Implement `readCocoon(runId: string): Cocoon | null`
- [ ] Implement `listCocoons(): CocoonSummary[]` — list all cocoons with status
- [ ] Engine writes checkpoint after every node completion (before advancing to next node)
- [ ] On resume: load cocoon, rebuild graph from DOT file, verify `graph_hash` matches (warn if DOT file changed since checkpoint), restore context and retry state, set current node, continue execution

### Phase 5: CLI Shell & Themed Output (~20% of effort)

**Files:**
- `src/cli/index.ts` — Commander program setup, global options
- `src/cli/commands/run.ts` — `pollinator run <file>` command
- `src/cli/commands/resume.ts` — `pollinator resume <run-id>` command
- `src/cli/commands/validate.ts` — `pollinator validate <file>` command
- `src/cli/commands/status.ts` — `pollinator status [run-id]` command
- `src/cli/ui/theme.ts` — Color palette, emoji constants, term mapping
- `src/cli/ui/renderer.ts` — Event → terminal output rendering
- `test/integration/run.test.ts` — End-to-end run test
- `test/integration/resume.test.ts` — Interrupt + resume test

**Tasks:**
- [ ] Set up commander program with name `pollinator`, version `0.1.0`, themed description
- [ ] Implement `run` command:
  - Parse DOT file, validate, build graph
  - Generate run ID (UUID v4 via `crypto.randomUUID()`)
  - Create engine, subscribe to events, start renderer
  - Execute pipeline
  - Print summary on completion (nodes executed, time elapsed, final status)
- [ ] Implement `resume` command:
  - Load cocoon by run ID (or list available cocoons if no ID given)
  - Rebuild graph, restore state
  - Resume execution with same renderer
- [ ] Implement `validate` command:
  - Parse and validate DOT file
  - Print diagnostics with file:line:col format
  - Exit code 0 if valid, 1 if errors found
- [ ] Implement `status` command:
  - No args: list all cocoons with status summary
  - With run ID: show detailed status of that run
- [ ] Implement theme system:
  ```typescript
  const THEME = {
    emoji: {
      pollinator: '🐝',
      garden: '🌸',
      petal: '🌻',
      blooming: '🌺',
      success: '✅',
      failure: '❌',
      retry: '🔄',
      cocoon: '🫘',
      honey: '🍯',
      wilt: '🥀',
      seed: '🌱',
    },
    colors: {
      success: chalk.green,
      failure: chalk.red,
      warning: chalk.yellow,
      info: chalk.cyan,
      muted: chalk.dim,
      node_id: chalk.bold.white,
      timing: chalk.dim.yellow,
    }
  }
  ```
- [ ] Implement event renderer:
  - `node:start` → `🌻 Petal [node_id] blooming...` with ora spinner
  - `node:success` → `✅ sweet success (Xs)` — stop spinner, print timing
  - `node:failure` → `❌ wilted (exit code N)` — show truncated stderr
  - `node:retry` → `🔄 Re-pollinating [node_id] (attempt N/M)...`
  - `edge:selected` → (verbose mode only) `  → following edge to [target]`
  - `pipeline:complete` → `🍯 Garden pollinated! N petals, Xs total`
  - `pipeline:error` → `🥀 Pipeline wilted: [reason]`
- [ ] Detect TTY: if stdout is not a TTY (piped), disable colors and spinners, output plain structured text
- [ ] Signal handling: on SIGINT/SIGTERM, print `🫘 Saving cocoon...`, checkpoint, print `💤 Run [id] hibernating. Resume with: pollinator resume [id]`, exit 0

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Create | Project manifest, dependencies, scripts |
| `tsconfig.json` | Create | TypeScript strict config |
| `.gitignore` | Create | Ignore node_modules, dist, cocoons |
| `src/parser/ast.ts` | Create | DOT AST type definitions |
| `src/parser/lexer.ts` | Create | DOT tokenizer |
| `src/parser/parser.ts` | Create | Recursive-descent DOT parser |
| `src/parser/errors.ts` | Create | Parse error types with source locations |
| `src/graph/types.ts` | Create | Graph node/edge type definitions |
| `src/graph/graph.ts` | Create | DirectedGraph data structure |
| `src/graph/builder.ts` | Create | AST → DirectedGraph transformer |
| `src/engine/types.ts` | Create | Engine state and event types |
| `src/engine/edge-selector.ts` | Create | 5-step deterministic edge selection |
| `src/engine/retry.ts` | Create | Retry policies and exponential backoff |
| `src/engine/context.ts` | Create | Key-value execution context store |
| `src/engine/engine.ts` | Create | Pipeline execution engine (core run loop) |
| `src/handlers/registry.ts` | Create | Shape → handler mapping |
| `src/handlers/start.ts` | Create | Start node handler |
| `src/handlers/exit.ts` | Create | Exit node handler |
| `src/handlers/tool.ts` | Create | Tool node handler (shell execution) |
| `src/handlers/stub.ts` | Create | Stub handler for unimplemented node types |
| `src/checkpoint/types.ts` | Create | Cocoon checkpoint schema types |
| `src/checkpoint/cocoon.ts` | Create | Checkpoint read/write/list operations |
| `src/validator/rules.ts` | Create | DOT validation rule implementations |
| `src/validator/validate.ts` | Create | Validation runner |
| `src/cli/index.ts` | Create | CLI entry point with commander |
| `src/cli/commands/run.ts` | Create | `pollinator run` command |
| `src/cli/commands/resume.ts` | Create | `pollinator resume` command |
| `src/cli/commands/validate.ts` | Create | `pollinator validate` command |
| `src/cli/commands/status.ts` | Create | `pollinator status` command |
| `src/cli/ui/theme.ts` | Create | Themed colors, emoji, terminology |
| `src/cli/ui/renderer.ts` | Create | Engine event → terminal output |
| `test/parser/parser.test.ts` | Create | DOT parser unit tests |
| `test/engine/edge-selector.test.ts` | Create | Edge selection algorithm tests |
| `test/engine/engine.test.ts` | Create | Engine execution tests |
| `test/handlers/tool.test.ts` | Create | Tool handler tests |
| `test/checkpoint/cocoon.test.ts` | Create | Checkpoint round-trip tests |
| `test/integration/run.test.ts` | Create | End-to-end pipeline run test |
| `test/integration/resume.test.ts` | Create | Interrupt + resume test |
| `test/fixtures/simple-linear.dot` | Create | Minimal linear pipeline fixture |
| `test/fixtures/conditional-branch.dot` | Create | Conditional branching fixture |
| `test/fixtures/retry-node.dot` | Create | Retry behavior fixture |
| `gardens/compliance-loop.dot` | Exists | Sample pipeline (no changes) |

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors
- [ ] `npx tsx src/cli/index.ts run gardens/compliance-loop.dot` parses and executes the compliance loop (tool nodes will fail because `scripts/compliance_loop.py` doesn't exist — that's expected; the engine should follow failure edges correctly)
- [ ] `npx tsx src/cli/index.ts validate gardens/compliance-loop.dot` reports no structural errors
- [ ] `npx tsx src/cli/index.ts run test/fixtures/simple-linear.dot` runs a simple pipeline end-to-end with successful tool nodes and prints themed output
- [ ] Ctrl+C during a run produces a cocoon file in `cocoons/`
- [ ] `npx tsx src/cli/index.ts resume <run-id>` loads the cocoon and continues from the last completed node
- [ ] `npx tsx src/cli/index.ts status` lists all cocoons
- [ ] Edge selection correctly implements all 5 steps (verified by unit tests covering each step in isolation and combined)
- [ ] Retry logic works: a tool node with `max_retries=2` retries twice with backoff before following failure edge
- [ ] Terminal output uses the pollination theme: emoji, colors, bee puns
- [ ] Piped output (e.g., `pollinator run ... | cat`) is plain text without ANSI codes
- [ ] `npm test` passes all unit and integration tests
- [ ] No TypeScript `any` in public interfaces (internal implementation may use sparingly)

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| DOT parser doesn't cover enough of the Graphviz subset | Medium | High | Parse only what the attractor spec uses. Test against `compliance-loop.dot` plus crafted fixtures. Add features when real DOT files demand them. |
| Edge selection algorithm has subtle spec ambiguity | Medium | High | Write exhaustive unit tests for each of the 5 steps. When ambiguous, document the interpretation and move on — this can be corrected later. |
| Shell command execution (tool nodes) is platform-dependent | Low | Medium | Use `execa` which handles cross-platform concerns. Test on macOS. Linux compatibility is deferred but `execa` abstracts most differences. |
| Checkpoint resume with modified DOT files | Medium | Medium | Hash the DOT file content in the cocoon. On resume, warn if hash doesn't match but allow the user to proceed (they may have intentionally fixed the pipeline). |
| SIGINT handler doesn't get to write cocoon in time | Low | Low | Write cocoons synchronously (small JSON). Register handler early. Accept that hard kills (SIGKILL) can't be caught — that's fine. |

## Security Considerations

- **Shell command injection**: Tool nodes execute their `script` attribute as a shell command. This is by design — the DOT file IS the program. However, the user should be aware that running an untrusted DOT file is equivalent to running an untrusted script. No sandboxing in v1 (same threat model as `make` or shell scripts).
- **File system access**: Cocoons are written to a predictable directory. No path traversal risk because run IDs are UUIDs and the cocoon directory is always relative to cwd.
- **No network access**: This sprint involves no network calls. Tool nodes may make network calls via their scripts, but that's the user's responsibility.

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.4 | Language |
| `tsx` | ^4.0 | Dev-time TS execution (no build step needed) |
| `tsup` | ^8.0 | Production bundler |
| `commander` | ^12.0 | CLI argument parsing |
| `chalk` | ^5.3 | Terminal colors (ESM-native) |
| `ora` | ^8.0 | Terminal spinners (ESM-native) |
| `execa` | ^9.0 | Subprocess execution |
| `@types/node` | ^20.0 | Node.js type definitions |

No runtime database. No framework. No config library beyond what commander provides. Intentionally minimal.

## Open Questions

1. **`bin` name**: Should the CLI binary be `pollinator` or `nectar`? The intent doc says both are acceptable. Recommend `pollinator` since the CLI *is* the pollinator. `nectar` can be an alias added later.

2. **Condition expression parser**: The attractor spec supports `outcome=success && context.tests_passed=true`. How far do we go? Recommend: support `outcome=success`, `outcome=fail`, `context.<key>=<value>`, and `&&`/`||` combinators. No parenthetical grouping, no `!=` (add when needed). This covers `compliance-loop.dot`.

3. **Tool node working directory**: Should tool scripts run in the DOT file's directory, the cwd where `pollinator` was invoked, or a per-run temp directory? Recommend: cwd where `pollinator` was invoked (matches user expectation, same as `make`).

4. **Cocoon directory location**: `cocoons/` relative to cwd, or inside `.nectar/cocoons/`? The intent doc shows `cocoons/` at workspace root. Recommend that for now — it's visible and obvious. Move to `.nectar/` in a later sprint if it's too noisy.

5. **Should stub handlers warn or silently succeed?** If someone writes a DOT file with a `box` (codergen) node and runs it now, should we print a visible warning? Recommend: yes, print `⚠️ Petal [node_id] uses unimplemented type 'codergen' — passing through` so the user knows it was skipped, not executed.

6. **Test runner**: Node's built-in `node:test` keeps dependencies minimal and works well for this scope. Switch to vitest later if we need more features (mocking, coverage reporting). Recommend: start with `node:test`.
