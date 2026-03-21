# Sprint NEXT: Nectar CLI Control Plane

## Overview

**Goal:** Turn `nectar` into the full operator console promised by `docs/INTENT.md`. After this sprint, a developer can control and inspect any live or paused run from the terminal: stream events, answer detached human gates, inspect checkpoint and context state, export the rendered run graph, and install shell completions.

**Why this sprint, why now:**

1. `docs/compliance-report.md` shows the engine, coding-agent loop, and unified LLM client are effectively at the spec floor. The remaining items are deliberate deferrals, not the best next use of a sprint.

2. `docs/INTENT.md` is explicit that the CLI must be feature-complete for the local runtime surface. The current CLI can launch runs, resume, validate, manage seeds, run swarm analysis, upgrade, and start the server, but it still cannot do several core promised operations:
   - watch a run started somewhere else
   - answer a pending human gate from another terminal
   - inspect checkpoint and context state for an existing run
   - render a run graph on demand
   - install shell completions

3. The backend work is already done. `src/server/routes/pipelines.ts` already exposes `/events`, `/questions`, `/answer`, `/checkpoint`, `/context`, and `/graph`. This sprint is mostly a CLI productization sprint, not a new runtime or engine sprint.

4. This is the highest-impact one-sprint gap because it fixes a basic operator workflow failure. Today, once a run leaves the terminal that started it, the CLI becomes a weak bystander. That is a more serious product gap than another round of narrow compliance cleanup or a new browser feature.

5. Shell completions belong here. They are a command-surface problem, and they should ship together with the expanded command surface rather than as a later polish-only sprint.

**Scope:**

- Add live-ops CLI commands: `watch`, `questions`, `answer`, `context`, `checkpoint`, `graph`, `completions`
- Add `status --watch` as a convenience alias over live event streaming
- Add a shared local-runtime HTTP client for CLI commands that require the running server
- Make live-output rendering TTY-aware and pipe-friendly
- Add integration tests for SSE watching, human-gate answering, inspectors, graph export, and completions

**Out of scope:**

- New engine or compliance work beyond additive CLI support
- Hive list view, timeline view, or watched-directory seed ingestion
- Diagram-side graph editing in the browser
- Background daemon management or auto-starting `nectar serve`
- Authentication, remote servers, or cloud multi-user workflows
- Inline terminal SVG rendering or automatic browser-open behavior

---

## Use Cases

1. **Watch a run launched elsewhere.** A run was started from the Hive or another shell. `nectar watch <run-id>` replays prior events, tails new ones over SSE, renders human-readable output, and exits automatically on the terminal event.

2. **Answer a detached human gate.** A pipeline is blocked in `wait.human`. One terminal shows the run, another runs:

   ```bash
   nectar questions <run-id>
   nectar answer <run-id> <question-id> --index 2
   ```

   The answer is applied through the local runtime and the blocked run continues.

3. **Inspect live state during a failure investigation.** A tool node failed and the user wants to know what the engine knows right now:

   ```bash
   nectar context <run-id> --prefix steps.
   nectar checkpoint <run-id>
   ```

   The CLI shows the same state the HTTP API would return, without making the user hand-roll `curl`.

4. **Export the rendered graph for a run.** A user wants the run-specific SVG with execution-state coloring:

   ```bash
   nectar graph <run-id> --output /tmp/run.svg
   ```

   The command writes a valid SVG file and reports where it went.

5. **Follow a run from `status`.** `nectar status <run-id> --watch` prints the current snapshot, then attaches to the live stream without making the user remember a separate command.

6. **Use the CLI in scripts and CI.** `nectar watch <run-id> --json`, `nectar checkpoint <run-id> --json`, and `nectar context <run-id> --json` emit machine-readable output with no spinners or ANSI noise when stdout is not a TTY.

7. **Install shell completions.** A user runs:

   ```bash
   nectar completions zsh > ~/.zsh/completions/_nectar
   ```

   The generated completion script includes the new live-ops commands and their flags.

8. **Fail clearly when the local server is missing.** If the user runs `nectar watch <run-id>` without `nectar serve` running, the CLI prints a direct error explaining that this command requires the local runtime and suggests the exact `nectar serve` command to run.

---

## Architecture

### Principle: Split Offline Commands from Live Commands

Do **not** rewrite the existing offline CLI around HTTP. `run`, `resume`, `validate`, `status`, `seed`, `seeds`, `swarm`, and `upgrade` already work directly against the workspace and runtime libraries. Keep that.

Instead, add a second path for commands that fundamentally need the live server because they depend on in-memory state or SSE:

- `watch`
- `questions`
- `answer`
- `context`
- `checkpoint`
- `graph`

That split is pragmatic and accurate. A detached human gate or live SSE stream is not a file-only concern.

### Command-to-Route Mapping

| CLI command | Runtime route | Why |
|-------------|---------------|-----|
| `nectar watch <run-id>` | `GET /pipelines/:id/events` | Replay + tail run events |
| `nectar status <run-id> --watch` | `GET /pipelines/:id`, then `GET /pipelines/:id/events` | Snapshot first, then tail |
| `nectar questions <run-id>` | `GET /pipelines/:id/questions` | List pending human gates |
| `nectar answer <run-id> <question-id>` | `POST /pipelines/:id/questions/:qid/answer` | Submit a gate answer |
| `nectar context <run-id>` | `GET /pipelines/:id/context` | Inspect the current context store |
| `nectar checkpoint <run-id>` | `GET /pipelines/:id/checkpoint` | Inspect the current cocoon |
| `nectar graph <run-id>` | `GET /pipelines/:id/graph` | Export rendered SVG |

Opinionated rule: **do not add new server routes unless absolutely necessary.** The whole point of this sprint is to close the CLI gap using the surface that already exists.

### Shared Runtime Client

Add a small typed client in `src/cli/runtime-client.ts`:

- Resolves the server URL from `--server` or `NECTAR_SERVER_URL`
- Uses `fetch()` for JSON and SVG endpoints
- Parses SSE streams for `watch`
- Normalizes HTTP errors into clear CLI errors
- Detects connection failures and prints actionable guidance

Default server URL:

```text
http://127.0.0.1:4140
```

Do **not** add daemon discovery, PID files, or auto-start behavior in this sprint. That is a different problem and will bloat the scope.

### Watch Rendering Model

`watch` should not try to be clever with terminal state. It should be reliable first.

- Reuse `EventRenderer` for textual event formatting
- Add an envelope-aware wrapper that deduplicates by `seq`
- Disable spinners in live-tail mode when output is piped or when replaying historical events
- Print a terse header from `GET /pipelines/:id` before attaching
- Exit when the SSE stream delivers a terminal event

Data flow:

```text
nectar watch <run-id>
  -> GET /pipelines/:id        # snapshot
  -> GET /pipelines/:id/events # replay + live
  -> seq-dedup envelope reader
  -> EventRenderer (TTY-aware)
```

### Human-Gate UX

`questions` and `answer` must optimize for correctness over magic.

`questions`:

- Lists pending questions only
- Shows `question_id`, `node_id`, text, choices, default, timeout
- Supports `--json`

`answer`:

- Requires `run-id` and `question-id`
- Accepts exactly one answer selector:
  - `--label <label>`
  - `--index <1-based choice>`
  - `--text <freeform>`
- Maps stale answers and conflicts cleanly:
  - 404: question or run does not exist
  - 409: question already answered, timed out, or no longer pending

Opinionated rule: **no fuzzy label matching.** Exact label or explicit choice index only. Human-gate commands must be boring and correct.

### Graph Export

`graph` is an export command, not a renderer framework.

- If `--output <path>` is provided, write the SVG there
- If stdout is not a TTY, allow writing raw SVG to stdout
- If stdout is a TTY and no output path is provided, refuse and tell the user to pass `--output` or pipe the result

Do not add `--open` or inline terminal image rendering in this sprint. Cross-platform viewer behavior is not the load-bearing gap.

### Completion Generation

Add `nectar completions <shell>` for:

- `bash`
- `zsh`
- `fish`

The completion output should be generated from the actual command tree, not copied into hand-maintained static files. The command surface is now large enough that drift will become a maintenance tax immediately.

### Failure Model

Every live-ops command should have the same failure behavior:

- Connection refused / no server: tell the user to run `nectar serve`
- 404 run not found: print the run ID plainly
- 409 answer conflict: print that the question is no longer pending
- Malformed JSON / SSE from server: fail fast with a protocol error
- No stack traces for routine operator mistakes

---

## Implementation phases

### Phase 1: Runtime Client and Command Plumbing (~20%)

**Files:** `src/cli/runtime-client.ts`, `src/cli/index.ts`, `src/cli/commands/shared.ts`

**Tasks:**

- [ ] Create `RuntimeClient` with typed methods for `status`, `watchEvents`, `questions`, `answerQuestion`, `getContext`, `getCheckpoint`, and `getGraph`
- [ ] Add shared `resolveServerUrl()` logic from `--server` or `NECTAR_SERVER_URL`
- [ ] Add consistent connection-error handling for local-runtime commands
- [ ] Keep offline commands (`run`, `resume`, `validate`, seed commands, `swarm`, `upgrade`) untouched
- [ ] Register the new live-ops commands in `src/cli/index.ts`

### Phase 2: Watch, Context, Checkpoint, and Graph (~30%)

**Files:** `src/cli/commands/watch.ts`, `src/cli/commands/context.ts`, `src/cli/commands/checkpoint.ts`, `src/cli/commands/graph.ts`, `src/cli/ui/renderer.ts`, `src/cli/commands/status.ts`

**Tasks:**

- [ ] Implement `nectar watch <run-id>` using the SSE endpoint with replay-safe `seq` deduplication
- [ ] Add `--json` mode to `watch` for raw event-envelope output
- [ ] Extend the renderer so replayed or piped output never uses spinners
- [ ] Add `nectar status <run-id> --watch` as snapshot-then-follow behavior
- [ ] Implement `nectar context <run-id>` with:
  - [ ] pretty key/value output
  - [ ] `--json`
  - [ ] `--prefix <key-prefix>`
- [ ] Implement `nectar checkpoint <run-id>` with:
  - [ ] human-readable summary by default
  - [ ] `--json` for raw cocoon output
- [ ] Implement `nectar graph <run-id>` with:
  - [ ] `--output <file>`
  - [ ] raw stdout when piped
  - [ ] refusal to dump raw SVG into an interactive terminal without explicit intent

### Phase 3: Human Gate Operations (~30%)

**Files:** `src/cli/commands/questions.ts`, `src/cli/commands/answer.ts`, `src/cli/index.ts`, `src/cli/ui/theme.ts`

**Tasks:**

- [ ] Implement `nectar questions <run-id>` with table-like TTY output and `--json`
- [ ] Show `question_id`, `node_id`, stage, text, choices, default, and timeout
- [ ] Implement `nectar answer <run-id> <question-id>` with exactly one selector:
  - [ ] `--label <label>`
  - [ ] `--index <choice-number>`
  - [ ] `--text <freeform>`
- [ ] Reject ambiguous or missing answer selectors with a direct validation error
- [ ] Surface 404 and 409 responses as clean operator messages
- [ ] When `watch` receives a `human_question` event, print the exact follow-up command shape the user can run

### Phase 4: Shell Completions and Verification (~20%)

**Files:** `src/cli/commands/completions.ts`, `src/cli/completions.ts`, `package.json`, `test/integration/cli-watch.test.ts`, `test/integration/cli-human-gates.test.ts`, `test/integration/cli-inspect.test.ts`, `test/integration/cli-completions.test.ts`

**Tasks:**

- [ ] Implement `nectar completions bash|zsh|fish`
- [ ] Generate completion output from the actual Commander command graph
- [ ] Add integration tests covering:
  - [ ] SSE watch replay + live tail + terminal exit
  - [ ] listing and answering pending questions
  - [ ] context/checkpoint inspection
  - [ ] SVG graph export
  - [ ] completion script generation
- [ ] Run `npm run build`
- [ ] Run `npm test`

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/cli/runtime-client.ts` | Create | Typed local-runtime HTTP and SSE client for live CLI commands |
| `src/cli/index.ts` | Modify | Register the new command surface |
| `src/cli/commands/shared.ts` | Modify | Shared server URL resolution and CLI helpers |
| `src/cli/commands/watch.ts` | Create | Live event streaming command |
| `src/cli/commands/questions.ts` | Create | Pending human-gate inspection |
| `src/cli/commands/answer.ts` | Create | Human-gate answer submission |
| `src/cli/commands/context.ts` | Create | Context-store inspection |
| `src/cli/commands/checkpoint.ts` | Create | Cocoon inspection |
| `src/cli/commands/graph.ts` | Create | SVG export for a run graph |
| `src/cli/commands/completions.ts` | Create | Public completions command |
| `src/cli/completions.ts` | Create | Shell-completion generation logic |
| `src/cli/commands/status.ts` | Modify | Add `--watch` convenience behavior |
| `src/cli/ui/renderer.ts` | Modify | Envelope-aware, tail-safe, TTY-aware rendering |
| `src/cli/ui/theme.ts` | Modify | Small UX polish for new live-ops output |
| `package.json` | Modify | Wire any completion-generation helper and test coverage if needed |
| `test/integration/cli-watch.test.ts` | Create | Watch replay/live/terminal behavior |
| `test/integration/cli-human-gates.test.ts` | Create | Questions and answer flows |
| `test/integration/cli-inspect.test.ts` | Create | Context, checkpoint, and graph export |
| `test/integration/cli-completions.test.ts` | Create | Bash/zsh/fish completion generation |

---

## Definition of Done

- [ ] `nectar watch <run-id>` exists and can replay prior events and follow new ones from the local runtime
- [ ] `nectar watch <run-id>` exits automatically on `run_completed`, `pipeline_failed`, `run_interrupted`, or `run_error`
- [ ] `nectar status <run-id> --watch` shows the current snapshot, then follows the live event stream
- [ ] `nectar questions <run-id>` lists pending human gates with IDs, node IDs, choices, defaults, and timeouts
- [ ] `nectar answer <run-id> <question-id>` can answer by exact label or explicit 1-based choice index
- [ ] Stale or already-answered questions return a clean non-zero CLI error, not a stack trace
- [ ] `nectar context <run-id>` supports both readable text output and `--json`
- [ ] `nectar checkpoint <run-id>` supports both readable text output and `--json`
- [ ] `nectar graph <run-id> --output <file>` writes a valid SVG file
- [ ] `nectar graph <run-id>` can write raw SVG to stdout when piped
- [ ] Live-ops commands all support `--server` and `NECTAR_SERVER_URL`
- [ ] If the local server is unavailable, live-ops commands print a direct message telling the user to run `nectar serve`
- [ ] `nectar completions bash|zsh|fish` emits non-empty scripts that include the new commands
- [ ] Output remains pipe-friendly: no spinners or ANSI noise when stdout is not a TTY
- [ ] Existing commands (`run`, `resume`, `validate`, `status`, `seed`, `seeds`, `swarm`, `upgrade`, `serve`) still behave correctly
- [ ] `npm run build` passes
- [ ] `npm test` passes

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE replay and live events duplicate output | Medium | High | Deduplicate strictly on `EventEnvelope.seq`; keep the client stateless beyond the last seen sequence |
| Live watch output becomes unreadable in CI or pipes | Medium | Medium | Force plain output when stdout is not a TTY; disable spinners outside direct interactive runs |
| Human-answer UX is ambiguous when labels are similar | Medium | High | Require exact labels or explicit 1-based choice index; reject fuzzy matches |
| Users are confused that some commands need the server while others do not | High | Medium | Keep the split explicit in help text and print the exact `nectar serve` suggestion on connection failure |
| Completion scripts drift from the real command tree | Medium | Medium | Generate completions from the same Commander definitions the CLI already uses |
| Graph export surprises users by dumping raw SVG into the terminal | Low | Medium | Refuse interactive-terminal raw SVG output unless the user pipes stdout or passes an explicit output target |

---

## Dependencies

- Existing pipeline routes in `src/server/routes/pipelines.ts` stay stable:
  - `GET /pipelines/:id`
  - `GET /pipelines/:id/events`
  - `GET /pipelines/:id/questions`
  - `POST /pipelines/:id/questions/:qid/answer`
  - `GET /pipelines/:id/checkpoint`
  - `GET /pipelines/:id/context`
  - `GET /pipelines/:id/graph`
- `nectar serve` remains the supported way to run the local control plane
- Node 22 `fetch()` streaming is available for SSE parsing without adding a new transport dependency
- Existing `RunEvent` and `EventEnvelope` contracts remain additive and stable enough for CLI replay/tail behavior
- Commander remains the CLI definition source so completion generation can derive from the real command graph
