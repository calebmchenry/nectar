# Sprint 001 Codex Draft — Working Pollinator CLI

## Overview

**Goal**

Deliver a working local `pollinator` CLI that can validate, run, checkpoint, and resume DOT-defined gardens, with `gardens/compliance-loop.dot` executable out of the box from this repo. This sprint is not the full attractor implementation. It is the smallest honest slice that proves the execution model, file-system-first state, and CLI ergonomics Nectar will need later.

**Scope boundary**

- Build a TypeScript/Node CLI with three commands: `run`, `resume`, and `validate`.
- Support the DOT subset needed by the current repo and immediate smoke fixtures:
  - `digraph`
  - graph-level attributes (`goal`, `label`)
  - node attributes
  - edge attributes
  - chained edges normalized to flat edges
- Implement executable support for exactly three node kinds in this sprint:
  - `Mdiamond` -> `start`
  - `Msquare` -> `exit`
  - `parallelogram` -> `tool`
- Implement deterministic edge selection for the sprint condition subset:
  - `outcome`
  - `exit_code`
  - `attempt`
- Persist a cocoon JSON file after every completed node and make `resume` continue from that cocoon.
- Ship a deterministic fixture script so `gardens/compliance-loop.dot` actually runs and exercises success, failure, retry, and loop-back behavior.

**Out-of-scope**

- Full attractor feature parity
- HTTP server API
- Web UI / The Hive
- Seedbed backlog and swarm analysis
- Codergen, wait.human, parallel, fan-in, manager loop, or goal-gate execution semantics
- Graph rendering
- Self-update, installers, or single-binary packaging
- Windows support; sprint target is macOS and Linux only

## Use Cases

1. **Validate before running**
   A developer runs `pollinator validate gardens/compliance-loop.dot` and gets a clear pass/fail result. Validation rejects malformed graphs, unsupported node shapes, missing `script` attributes on tool nodes, dangling edges, and unsupported condition syntax before execution starts.

2. **Run the shipped compliance loop**
   A developer runs `pollinator run gardens/compliance-loop.dot` from the repo root. The CLI loads the garden, prints themed status output, executes each tool node in order, retries `implement` when it fails on the first attempt, loops through `validate -> compliance_check`, and exits through the `100% Compliant` node.

3. **Resume after interruption**
   A developer hits `Ctrl+C` or the terminal dies mid-run. A cocoon already exists in `cocoons/<run-id>.json`. Running `pollinator resume <run-id>` reloads the last durable state and continues from the next unfinished node without rerunning completed nodes.

4. **Author a simple garden and trust the engine**
   A developer creates a minimal DOT file with a start node, one tool node, and an exit node. If it matches the supported subset, the same `validate` and `run` commands work without extra config.

## Architecture

### Language choice rationale

Use **TypeScript on Node 22** for Sprint 001.

This is the right trade for a greenfield repo that needs a working CLI quickly:

- Node already gives strong process control, filesystem APIs, JSON handling, and cross-platform shell invocation for macOS/Linux.
- TypeScript lets the graph model, run state, and handler registry be explicit instead of stringly typed.
- The npm ecosystem already has a competent DOT parser and stable CLI/process libraries, which is faster than writing parsing infrastructure in Go or Rust right now.
- A standalone binary is attractive eventually, but that is packaging work, not core execution work. Sprint 001 should spend time on semantics, not distribution.

### Module layout

```text
src/
  cli.ts
  commands/
    run.ts
    resume.ts
    validate.ts
  ui/
    theme.ts
  garden/
    types.ts
    parse.ts
    validate.ts
  engine/
    types.ts
    conditions.ts
    edge-selection.ts
    checkpoint-store.ts
    events.ts
    runner.ts
  handlers/
    index.ts
    start.ts
    exit.ts
    tool.ts
  fs/
    workspace.ts
  process/
    run-script.ts
scripts/
  compliance_loop.mjs
test/
  fixtures/
    gardens/
```

The separation matters:

- `garden/` and `engine/` stay reusable by a future HTTP server and web UI.
- `commands/` and `ui/` are thin adapters over the core engine.
- `process/` and `fs/` isolate side effects so retry, resume, and validation logic stays testable.

### Key abstractions

- `GardenGraph`
  Immutable in-memory representation of the parsed DOT file: graph attrs, nodes, edges, and source order.

- `GardenNode`
  Discriminated union with `kind: 'start' | 'exit' | 'tool'`. Unsupported shapes are rejected during validation, not carried into runtime.

- `NodeHandler`
  Interface with a single `execute(context)` method returning a `NodeExecutionResult`. The handler registry maps node kind to implementation.

- `NodeExecutionResult`
  Durable per-node result with `outcome`, `exitCode`, `attempt`, timestamps, and artifact paths for stdout/stderr logs.

- `CocoonState`
  JSON-serializable run state containing run id, garden path, current node, completed node results, interruption metadata, and overall status.

- `RunEvent`
  Typed event union emitted by the runner (`run_started`, `node_started`, `node_retrying`, `node_completed`, `run_completed`, `run_interrupted`). The CLI subscribes to these events for output; the engine never prints directly.

### Data flow

1. `pollinator run <garden.dot>` resolves the workspace root as `process.cwd()` and the garden path relative to it.
2. `garden/parse.ts` parses DOT into `GardenGraph` and normalizes chained edges.
3. `garden/validate.ts` enforces the Sprint 001 subset and returns structured diagnostics.
4. `engine/runner.ts` creates a new run id, initializes a cocoon, and dispatches the current node through `handlers/index.ts`.
5. `handlers/tool.ts` invokes `process/run-script.ts`, which runs the node's `script` in the workspace root and injects `POLLINATOR_*` environment variables.
6. The runner writes stdout/stderr logs under `cocoons/<run-id>/`, updates `cocoons/<run-id>.json` via atomic write, and calls `edge-selection.ts` to choose the next edge.
7. On `resume`, the CLI loads the cocoon, validates the original garden again, and restarts the runner from the next unfinished node.

## Implementation

### Phase 0 — Pin the upstream target and scaffold the CLI

Create the repo skeleton first and lock the compliance target before code spreads.

- Create `docs/upstream/ATTRACTOR-PIN.md`.
  - Record the exact upstream attractor commit/tag that Nectar will eventually target.
  - Call out that Sprint 001 implements only the CLI execution slice, not the full snapshot.
- Create `package.json`, `package-lock.json`, `tsconfig.json`, and `.gitignore`.
  - Use ESM TypeScript with `strict: true`.
  - Add scripts: `build`, `dev`, `test`.
  - Ignore `dist/`, `node_modules/`, and runtime cocoon artifacts.
- Create `README.md` with one fast path:
  - `npm install`
  - `npm run build`
  - `node dist/cli.js validate gardens/compliance-loop.dot`
  - `node dist/cli.js run gardens/compliance-loop.dot`

Code pattern: keep the initial scaffold intentionally boring. No framework, no DI container, no classes unless the code materially benefits. Plain modules and explicit interfaces are enough.

### Phase 1 — Parse and validate a narrow DOT subset

Implement the parser and validator around the current repo needs, not the full Graphviz language.

- Create `src/garden/types.ts`.
  - Define `GraphAttrs`, `GardenNode`, `GardenEdge`, and `GardenGraph`.
  - Preserve raw attribute maps so later sprints can add features without reparsing.
- Create `src/garden/parse.ts`.
  - Use `@ts-graphviz/parser` to parse DOT into AST.
  - Normalize chained edges into one edge per source/target pair.
  - Coerce known numeric attrs such as `max_retries`.
- Create `src/garden/validate.ts`.
  - Validate exactly one start node and at least one exit node.
  - Ensure node ids are unique and all edges reference known nodes.
  - Reject unsupported shapes immediately.
  - Require `script` on `tool` nodes.
  - Require `max_retries` to be an integer `>= 0`.
  - Parse `condition` without `eval`; allow only a tiny grammar:
    - `outcome=<success|fail>`
    - `exit_code<op><integer>`
    - `attempt<op><integer>`

Code pattern: validators should be flat pure functions returning `Diagnostic[]`, not exceptions for normal user mistakes. `validate` command prints diagnostics and exits non-zero.

### Phase 2 — Build the execution engine, retries, and cocoon persistence

This is the real product slice. Everything else exists to support this phase.

- Create `src/engine/types.ts`.
  - Define `RunStatus`, `NodeStatus`, `NodeExecutionResult`, and `CocoonState`.
- Create `src/engine/conditions.ts`.
  - Parse the sprint condition grammar into a tiny AST.
  - Evaluate conditions against `NodeExecutionResult`.
- Create `src/engine/edge-selection.ts`.
  - Centralize edge choice in one pure function.
  - Preserve source order from DOT so fallback behavior is deterministic.
  - For Sprint 001: first matching conditional edge wins; if none match, use the first outgoing edge with no condition; if still none exist, fail the run with a structural error.
- Create `src/engine/checkpoint-store.ts`.
  - Write cocoon files with temp-file + rename semantics to avoid partial JSON corruption.
  - Store logs under `cocoons/<run-id>/node-id/attempt-N.{stdout,stderr}.log`.
- Create `src/engine/events.ts`.
  - Define the event contract the CLI will subscribe to.
- Create `src/engine/runner.ts`.
  - Use an iterative loop, not recursive traversal.
  - Persist the cocoon after every completed node.
  - Mark interrupted runs with `status: interrupted` and reason metadata on `SIGINT`.
  - On resume, rerun the last incomplete node from scratch; never rerun a node already marked completed.
- Create `src/handlers/index.ts`, `src/handlers/start.ts`, `src/handlers/exit.ts`, and `src/handlers/tool.ts`.
  - `start` immediately succeeds.
  - `exit` marks the run successful.
  - `tool` executes the shell script, captures exit code, and applies exponential backoff retries using the node's `max_retries`.
- Create `src/process/run-script.ts`.
  - Run the `script` string with `execa` using `shell: true` and `cwd = workspaceRoot`.
  - Inject:
    - `POLLINATOR_RUN_ID`
    - `POLLINATOR_NODE_ID`
    - `POLLINATOR_ATTEMPT`
    - `POLLINATOR_RUN_DIR`
    - `POLLINATOR_GARDEN_PATH`

Code pattern: the engine owns control flow; handlers do not decide the next node. That keeps retries, checkpointing, and resume semantics in one place.

### Phase 3 — Ship a real CLI, not just library code

- Create `src/cli.ts`.
  - Register `run`, `resume`, and `validate` via `commander`.
  - Set process exit codes explicitly.
- Create `src/commands/run.ts`, `src/commands/resume.ts`, and `src/commands/validate.ts`.
  - Each command should be a thin adapter that wires CLI args to the core modules.
- Create `src/ui/theme.ts`.
  - Centralize emojis, colors, and status words.
  - Respect `NO_COLOR` and non-TTY terminals.

Output rules:

- `run` shows node start, retry, success, and failure transitions.
- `resume` announces the cocoon id and restart point.
- `validate` prints actionable diagnostics, not stack traces.
- The engine never emits themed copy. Theme lives in the CLI only.

Code pattern: keep output stateful but simple. A few event-driven status lines are enough; do not build a complex terminal dashboard in Sprint 001.

### Phase 4 — Make `gardens/compliance-loop.dot` executable and prove it with tests

The current sample garden points at a nonexistent Python script. That is a direct blocker to the user's stated outcome. Fix it inside this sprint.

- Create `scripts/compliance_loop.mjs`.
  - Replace external-service behavior with deterministic local fixture behavior.
  - `audit` fails until `validate` marks the run compliant.
  - `implement` fails on attempt 1 and succeeds on attempt 2 so retry behavior is exercised.
  - `draft`, `critique`, `merge`, and `fetch-weather` succeed and write trace messages.
  - Persist fixture state under `POLLINATOR_RUN_DIR` so runs stay isolated.
- Modify `gardens/compliance-loop.dot`.
  - Replace `python3 scripts/compliance_loop.py ...` with `node scripts/compliance_loop.mjs ...`.
  - Keep the existing node/edge structure so the garden remains a meaningful execution fixture.
- Create smoke fixtures:
  - `test/fixtures/gardens/smoke-success.dot`
  - `test/fixtures/gardens/retry-once.dot`
  - `test/fixtures/gardens/unsupported-shape.dot`
- Create tests:
  - `test/garden/parse.test.ts`
  - `test/garden/validate.test.ts`
  - `test/engine/edge-selection.test.ts`
  - `test/engine/runner.test.ts`
  - `test/cli/run-resume.test.ts`

Test expectations:

- Parser reads the sample garden and preserves node/edge identity.
- Validator rejects malformed graphs with stable diagnostics.
- Retry logic backs off and eventually succeeds on `retry-once.dot`.
- `run` writes a cocoon after each completed node.
- `resume` continues from an interrupted run.
- `gardens/compliance-loop.dot` completes successfully on a clean checkout.

## Files Summary

| Path | Action | Purpose |
| --- | --- | --- |
| `.gitignore` | Create | Ignore `dist/`, `node_modules/`, and cocoon artifacts. |
| `package.json` | Create | Define runtime, scripts, and CLI bin entry. |
| `package-lock.json` | Create | Lock the Node dependency graph for reproducible installs. |
| `tsconfig.json` | Create | Enable strict TypeScript compilation. |
| `README.md` | Create | Document the sprint-1 install/build/run path. |
| `docs/upstream/ATTRACTOR-PIN.md` | Create | Record the exact upstream attractor compliance target. |
| `src/cli.ts` | Create | Main CLI entrypoint and command registration. |
| `src/commands/run.ts` | Create | `pollinator run` adapter. |
| `src/commands/resume.ts` | Create | `pollinator resume` adapter. |
| `src/commands/validate.ts` | Create | `pollinator validate` adapter. |
| `src/ui/theme.ts` | Create | Centralized themed output and fallback behavior. |
| `src/garden/types.ts` | Create | Typed graph model for parsed DOT files. |
| `src/garden/parse.ts` | Create | DOT parsing and normalization. |
| `src/garden/validate.ts` | Create | Structural and semantic validation for the sprint subset. |
| `src/engine/types.ts` | Create | Shared run-state and result types. |
| `src/engine/conditions.ts` | Create | Tiny condition parser/evaluator with no `eval`. |
| `src/engine/edge-selection.ts` | Create | Deterministic next-edge selection. |
| `src/engine/checkpoint-store.ts` | Create | Cocoon persistence and atomic writes. |
| `src/engine/events.ts` | Create | Typed execution event contract. |
| `src/engine/runner.ts` | Create | Main execution loop, retries, and resume behavior. |
| `src/handlers/index.ts` | Create | Node handler registry. |
| `src/handlers/start.ts` | Create | Start-node behavior. |
| `src/handlers/exit.ts` | Create | Exit-node behavior. |
| `src/handlers/tool.ts` | Create | Tool-node behavior and retry orchestration. |
| `src/fs/workspace.ts` | Create | Workspace and path resolution helpers. |
| `src/process/run-script.ts` | Create | Shell execution wrapper. |
| `scripts/compliance_loop.mjs` | Create | Deterministic local fixture for the sample garden. |
| `gardens/compliance-loop.dot` | Modify | Point the sample garden at the shipped fixture script. |
| `test/fixtures/gardens/smoke-success.dot` | Create | Minimal success-path garden fixture. |
| `test/fixtures/gardens/retry-once.dot` | Create | Retry-path garden fixture. |
| `test/fixtures/gardens/unsupported-shape.dot` | Create | Validation failure fixture. |
| `test/garden/parse.test.ts` | Create | Parser coverage. |
| `test/garden/validate.test.ts` | Create | Validation coverage. |
| `test/engine/edge-selection.test.ts` | Create | Edge-selection coverage. |
| `test/engine/runner.test.ts` | Create | Engine, checkpoint, and retry coverage. |
| `test/cli/run-resume.test.ts` | Create | End-to-end CLI coverage for run and resume. |
| `cocoons/.gitkeep` | Create | Keep the cocoon directory present in a clean checkout. |

## Definition of Done

- [ ] `npm install && npm run build` succeeds on a clean checkout.
- [ ] `node dist/cli.js validate gardens/compliance-loop.dot` exits `0` and prints no structural errors.
- [ ] `node dist/cli.js run gardens/compliance-loop.dot` completes successfully from the repo root.
- [ ] The sample run exercises at least one retry and one loop-back before exiting successfully.
- [ ] A cocoon JSON file is written after every completed node under `cocoons/`.
- [ ] `node dist/cli.js resume <run-id>` continues an interrupted run without rerunning completed nodes.
- [ ] Unsupported node shapes fail during validation, not mid-execution.
- [ ] Condition evaluation uses a parsed allowlist grammar and does not rely on `eval`.
- [ ] Automated tests cover parse, validate, edge selection, retry, checkpointing, and resume.
- [ ] `README.md` contains the exact commands needed to use the sprint-1 CLI.

## Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| DOT parsing library does not preserve the semantics we need | Edge order and attribute handling are execution-critical | Hide the library behind `src/garden/parse.ts` and add golden tests against the sample garden so the parser can be swapped without touching the engine. |
| Resume semantics can rerun non-idempotent scripts | A partially executed tool node may have already changed the filesystem | Treat incomplete nodes as rerunnable from scratch in Sprint 001, document that tool scripts must be idempotent, and keep the shipped fixture script idempotent by design. |
| The sample garden is currently non-executable | Without a runnable fixture, the CLI cannot prove the user outcome | Ship `scripts/compliance_loop.mjs` in the same sprint and wire the garden to it. |
| Node runtime requirement feels less polished than a single binary | The CLI is usable but not yet distributable in the intended final form | Accept Node 22 as the sprint-1 runtime prerequisite and defer packaging until the engine semantics stabilize. |
| Shell execution varies by environment | Quoting and shell behavior can drift across systems | Target macOS/Linux only for Sprint 001, run commands from the workspace root, and keep the shipped fixture commands simple and deterministic. |

## Security considerations

- Treat DOT files and tool scripts as **trusted local automation** in Sprint 001. This CLI intentionally executes arbitrary local commands and is not a sandbox.
- Parse condition expressions with a tiny allowlist grammar. Do not use JavaScript `eval`, `Function`, or shell interpolation to evaluate conditions.
- Run tool nodes with the current user account and workspace-root `cwd`; never attempt privilege escalation.
- Inject only documented `POLLINATOR_*` environment variables. Do not dump the full process environment into CLI output.
- Keep cocoon files and logs local to the workspace and ignore them in git by default.
- Write cocoon files atomically so interruption cannot leave behind half-written JSON that resume later trusts blindly.

## Dependencies

**Runtime**

- `commander` for subcommand parsing and help text
- `@ts-graphviz/parser` for DOT parsing
- `execa` for reliable shell execution and exit-code handling
- `picocolors` for color output with graceful fallback
- `ora` for lightweight spinner support on TTYs
- `zod` for runtime validation of parsed config and cocoon state

**Dev**

- `typescript` for compilation
- `tsx` for local dev execution of TypeScript
- `vitest` for unit and integration tests
- `@types/node` for Node typings

## Open Questions

1. What exact upstream attractor commit or tag should be recorded in `docs/upstream/ATTRACTOR-PIN.md` before implementation starts?
2. Is Node 22 an acceptable sprint-1 runtime prerequisite, or does the user want standalone packaging started immediately despite the extra scope?
3. Should the installed binary name be `pollinator` only in Sprint 001, or should we also ship `nectar` as an alias from day one?
4. Is `gardens/compliance-loop.dot` intended to remain the canonical demo garden, or should it become a developer fixture while a separate user-facing demo garden is added later?
