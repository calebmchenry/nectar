# Sprint 001 Draft — Pollinator CLI & Pipeline Engine

## Overview

**Goal:** Build the minimum viable slice of Nectar. We will deliver a working Pollinator CLI that can parse a strict subset of the Graphviz DOT language, traverse the graph according to the attractor specification, execute shell commands (tool nodes), evaluate outcomes, and checkpoint progress.

**Scope Boundary:** 
- A custom, focused DOT parser handling only the constructs used in `gardens/compliance-loop.dot`.
- A graph traversal engine implementing the 5-step deterministic edge selection.
- Node handlers for `start` (Mdiamond), `exit` (Msquare), and `tool` (parallelogram).
- Local file-system checkpointing (`cocoons/`).
- Two CLI commands: `run` and `resume`.

**Out-of-Scope:**
- Web UI ("The Hive") and LLM integrations.
- `codergen`, `wait.human`, `manager loop`, and other complex node types.
- A full-featured expression evaluator for edge conditions (we will only support basic `outcome=success` and `outcome=fail` for now).
- Edge chaining parsing (e.g., `A -> B -> C` on a single line).

---

## Use Cases

1. **Run a Pipeline:** User executes `pollinator run gardens/compliance-loop.dot`. The CLI reads the file, parses the DAG, displays a themed buzzing startup message, and begins execution at the `start` node.
2. **Execute Shell Scripts:** When the engine reaches a `tool` (parallelogram) node, it executes the string in the `script` attribute via a spawned shell process, streaming the output (or hiding it behind a spinner) and capturing the exit code.
3. **Deterministic Routing:** After a node completes, the engine evaluates the exit status (0 = success, non-zero = fail), checks the outgoing edges' `condition` attributes, and selects the next node.
4. **Resilience & Resumption:** After every node completion, the engine writes a JSON "cocoon" to `.nectar/cocoons/<run-id>.json`. If the user hits `Ctrl+C`, they can later type `pollinator resume <run-id>` to pick up exactly where they left off.

---

## Architecture

**Language Choice: TypeScript (Node.js)**
*Rationale:* TypeScript provides the fastest iteration speed for abstract syntax trees and JSON manipulation, which is 90% of what an orchestrator does. It has a massive CLI ecosystem, and critically, types can later be shared natively with the React/Svelte Web UI ("The Hive"). Node's asynchronous event loop is perfect for managing parallel executions and streams.

**Module Layout:**
- `src/cli/` - Commander.js setup and command definitions.
- `src/parser/` - Regex/State-machine based DOT parser tailored for Nectar.
- `src/engine/` - Graph traversal, deterministic edge selection algorithm, and context management.
- `src/handlers/` - Node execution implementations (`start`, `exit`, `tool`).
- `src/store/` - Checkpoint (cocoon) reading and writing.
- `src/theme/` - Centralized UI constants (colors, emojis, bee puns).

**Key Abstractions:**
- `PipelineDAG`: The parsed, immutable graph structure (Nodes and Edges with their attributes).
- `ExecutionContext`: The mutable state of a run, including the current node, variables (like `outcome`), and history.
- `NodeHandler`: An interface with an `execute(node, context)` method.

**Data Flow:**
1. **Parse:** DOT string -> `parseDot()` -> `PipelineDAG`.
2. **Init:** `PipelineDAG` + (optional) `RunID` -> `Engine` initializes or loads `ExecutionContext` from disk.
3. **Loop:** `Engine` finds the active node -> calls `NodeRegistry.get(node.shape).execute()` -> updates `ExecutionContext` -> saves Cocoon -> selects next edge -> repeats until `exit` node.

---

## Implementation Phases

### Phase 1: CLI Scaffolding & Theme
- Initialize a Node.js project with TypeScript, `commander`, `chalk`, and `ora` (for spinners).
- Create the `pollinator` binary entry point.
- Implement the theme utilities to ensure all output uses the required pollination metaphors (🐝, 🌸, 🍯, "blooming", "wilted").

### Phase 2: DOT Parser
- Implement a custom parser (ignoring full Graphviz compliance) that extracts:
  - Global graph attributes (e.g., `goal`).
  - Nodes with attributes (`shape`, `label`, `script`, `max_retries`).
  - Directed edges with attributes (`label`, `condition`).
- Write unit tests against the `gardens/compliance-loop.dot` file.

### Phase 3: Engine & Checkpointing
- Define the JSON schema for a Cocoon (Run ID, DAG hash/path, current node, execution history, context variables).
- Implement the `store` module to save/load Cocoons from `.nectar/cocoons/`.
- Implement the core traversal loop and the 5-step edge selection algorithm.

### Phase 4: Node Handlers
- **Start Handler:** No-op execution, marks the beginning.
- **Exit Handler:** Sets pipeline state to complete.
- **Tool Handler:** Uses `child_process.spawn` to run the `script` attribute. Maps exit code 0 to `outcome=success` and any other to `outcome=fail`. Implements `max_retries` with simple backoff if specified.

### Phase 5: Integration
- Wire the `run` command to initialize a new engine instance.
- Wire the `resume` command to load a Cocoon and resume the engine.
- Ensure graceful shutdown on `SIGINT` (save checkpoint and exit).

---

## Files Summary

Files to create/modify during this sprint:

- `package.json` / `tsconfig.json`
- `bin/pollinator` (Executable entry point)
- `src/index.ts` (CLI bootstrapping)
- `src/cli/commands/run.ts`
- `src/cli/commands/resume.ts`
- `src/parser/dot.ts` (The DOT parser)
- `src/engine/engine.ts` (Traversal and orchestration)
- `src/engine/edges.ts` (Edge selection logic)
- `src/store/cocoon.ts` (Checkpointing logic)
- `src/handlers/registry.ts`
- `src/handlers/tool.ts`
- `src/handlers/start.ts`
- `src/handlers/exit.ts`
- `src/theme/index.ts` (Colors, emojis, text formatting)
- `tests/parser.test.ts`
- `tests/engine.test.ts`

---

## Definition of Done

- [ ] `pollinator run gardens/compliance-loop.dot` parses the file without errors.
- [ ] Execution begins at `start` and successfully routes through the graph based on node outputs.
- [ ] `tool` nodes execute their shell scripts and correctly set `outcome` state.
- [ ] Conditional edges correctly route execution based on `outcome=success` or `outcome=fail`.
- [ ] Terminal output is themed appropriately (e.g., "🌸 Garden loaded", "🌻 Petal [compliance_check] blooming...").
- [ ] A valid JSON cocoon is saved to `.nectar/cocoons/<run-id>.json` after every node completes.
- [ ] Interrupting the process (`Ctrl+C`) and running `pollinator resume <run-id>` continues execution from the correct node.
- [ ] Automated tests for the parser and edge selection pass.

---

## Risks & Mitigations

- **Risk:** Parsing DOT files via regex/custom state machine becomes a bug farm.
  **Mitigation:** We will strictly target *only* the syntax used in `compliance-loop.dot` and the attractor spec examples. We will not support subgraphs, HTML labels, or edge chaining right now. If it gets too complex, we will pivot to using a lightweight library like `ts-graphviz/parser`.
- **Risk:** Shell scripts executed by `tool` nodes hang indefinitely.
  **Mitigation:** Implement a default timeout for `tool` node execution to prevent the pipeline from stalling.
- **Risk:** Edge selection conditions are complex to evaluate safely.
  **Mitigation:** For Sprint 1, we will only implement basic string matching for `outcome=success` and `outcome=fail`. We will not use `eval()` or a full expression parser yet.

---

## Security Considerations

- **Arbitrary Code Execution:** The `tool` node by definition executes arbitrary shell scripts found in the DOT file. For local development workflows, this is expected behavior (similar to `make` or `npm scripts`). However, we must ensure these scripts are executed in the context of the workspace and logged visibly to the user so it is clear what commands are being run.

---

## Dependencies

- `commander`: robust CLI argument parsing.
- `chalk`: terminal styling.
- `ora`: terminal spinners.
- `zod`: runtime type validation for parsed DOT attributes and Cocoon JSON files.
- `uuid`: for generating Run IDs.
- *Development:* `vitest` or `jest` for testing.

---

## Open Questions

1. **Logging output of tool nodes:** Should the stdout/stderr of shell scripts be piped directly to the user's terminal, or captured and stored in the cocoon, displaying only a success/fail spinner in the UI? *Assumption for S1: Hide behind a spinner, but save output to the cocoon to keep the CLI clean.*
2. **Global state vs Local state:** Does a run need a workspace-level lock file, or can multiple runs of the same pipeline happen concurrently in the same directory? *Assumption for S1: Concurrent runs are fine, they get different Run IDs.*
3. **Cocoon Cleanup:** Should cocoons be automatically deleted when a pipeline reaches the `exit` node, or moved to a history folder? *Assumption for S1: Leave them in `.nectar/cocoons/` and update status to completed.*