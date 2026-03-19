# Nectar — Project Intent

## What This Document Is

This is the canonical intent document for **Nectar**. It describes — in precise, implementation-ready terms — what Nectar is, what it must do, and what "done" looks like. An AI agent reading this file with zero prior context should be able to understand the full problem space, identify what research is needed, and begin designing a complete system.

When this document refers to the attractor NLSpec documents, it means a **pinned upstream snapshot**, not a floating branch head. Before implementation begins, the exact upstream commit or tag being targeted must be recorded locally and treated as the compliance target. Nectar-specific requirements in this document apply on top of that pinned snapshot.

---

## 1. The Problem

Building software with AI coding agents (Claude Code, Codex, Gemini CLI, Cursor, etc.) is powerful but chaotic. There is no good way to:

1. **Orchestrate multi-step AI workflows** — "plan, implement, test, review, fix, deploy" as a repeatable, observable pipeline.
2. **Capture and triage a stream of ideas** — developers have bursts of ideas (text, screenshots, videos, links) that need to be captured fast, organized automatically, and triaged by priority.
3. **Visualize what's happening** — both the pipeline graphs themselves and the state of a backlog/kanban of work.
4. **Get multiple AI perspectives** — have Claude, Codex, and Gemini independently analyze an idea and attach their recommendations.

Nectar solves all of this.

---

## 2. What Nectar Is

Nectar is **three things packaged as one product**:

### 2A. A Pipeline Orchestration Engine (the "Attractor" implementation)

A **complete, 100%-to-spec implementation** of a pinned snapshot of [strongdm/attractor](https://github.com/strongdm/attractor). This is non-negotiable — every feature in the three attractor NLSpec documents must be implemented:

- **`attractor-spec.md`** — The core orchestration engine: DOT-based pipeline definition, graph traversal, 9 handler types (start, exit, codergen, wait.human, conditional, parallel, fan-in, tool, manager loop), deterministic edge selection, retry with exponential backoff, goal gates, context fidelity modes, checkpointing/resume, model stylesheets, condition expressions, human-in-the-loop interviewer abstraction, 13 validation/lint rules, AST transforms, artifact store, parallel execution with join policies, tool call hooks, and the full HTTP server API.

- **`coding-agent-loop-spec.md`** — The agentic loop that runs inside codergen nodes: session management (submit/steer/follow_up/abort), provider profiles with tailored system prompts and tool sets, tool registry, execution environment support required by the upstream spec, loop detection, subagent depth limits, project instruction file discovery (AGENTS.md, CLAUDE.md, GEMINI.md, .codex/instructions.md).

- **`unified-llm-spec.md`** — The multi-provider LLM client SDK: adapters for OpenAI Responses API, Anthropic Messages API, and Gemini generateContent API, streaming support, tool calling, retry logic, structured output, and provider-specific quirk handling.

**The attractor spec is the floor, not the ceiling.** The implementation must pass every requirement in those specs for the pinned snapshot. Read them. Implement them. Test them against the spec language.

### 2B. A CLI ("Pollinator")

A command-line tool called `pollinator` (or `nectar` — the CLI is the pollinator, the system is the nectar). This CLI must be:

- **Genuinely fun to use.** Not "enterprise fun." Actually fun. Fire emojis, bee/flower/honey puns, colorful output, witty status messages, satisfying spinners and progress bars. The kind of CLI you show people because it makes them smile.
- **Feature-complete for the full attractor spec.** Every operation the HTTP API supports should be accessible from the CLI: run pipelines, watch status, stream events, answer human gates, inspect checkpoints, validate DOT files, render graphs.
- **A first-class idea capture tool.** Quick commands to dump ideas into the backlog (text, file attachments, screenshots, links), tag them, prioritize them, mark status.
- **Self-upgrading and distributable.** Built-in update mechanism. Easy installation (single binary or simple install script). Cross-platform (macOS, Linux at minimum).

#### CLI Personality & Theme

The naming convention follows the pollination metaphor:

| Concept | Nectar Term |
|---------|-------------|
| Pipeline | Garden / Bloom |
| Pipeline node | Petal |
| Running a pipeline | Pollinating |
| Backlog item / Idea | Seed |
| High-priority item | Queen's Order |
| Completed item | Honey |
| The CLI itself | Pollinator |
| AI analysis | Swarm Intelligence |
| Checkpoint | Cocoon |
| Error / Failure | Wilt |
| Retry | Re-pollinate |

Use these naturally in output, help text, and status messages. Don't force them where they'd be confusing — clarity beats cleverness. But lean into the theme hard. Examples:

```
$ pollinator run my-pipeline.dot
🐝 Pollinator buzzing...
🌸 Garden loaded: my-pipeline.dot (7 petals, 2 goal gates)
🌻 Petal [plan] blooming... ✅ sweet success (3.2s)
🌻 Petal [implement] blooming...
```

```
$ pollinator seed "Add rate limiting to the API gateway"
🌱 Seed planted! (#42)
💡 Tip: Run `pollinator swarm 42` to get AI analysis from the hive mind
```

```
$ pollinator status
🍯 Honey jar: 12 completed | 🌱 Seedbed: 8 ideas | 🔥 Queen's Orders: 2
```

Dark theme by default. Nerd Font / Unicode-aware. Graceful fallback for dumb terminals.

### 2C. A Web UI ("The Hive")

A polished, modern web application that provides:

#### 2C-i. DOT/Graphviz Pipeline Editor

- **Natural language input** — User types what they want ("a pipeline that plans, implements, tests, and loops back on failure") and it gets sent to a configured LLM provider to generate a DOT file in real-time. Claude, Codex, and Gemini should all be supported here; the default provider should be configurable.
- **Live dual-pane view** — One pane shows the rendered diagram (SVG/canvas graph visualization). The other shows the raw DOT source. Both update in real-time as the LLM streams its response.
- **Bidirectional editing** — User can edit the raw DOT text and the diagram updates. User can also interact with the diagram to edit graph structure and node/edge properties and the DOT source updates. Semantic round-tripping is required; byte-for-byte preservation of whitespace, comments, and attribute ordering is not.
- **File-system backed** — All DOT files are saved to an organized directory structure on disk. The file system is the source of truth, not a database. The web UI works against that filesystem-backed state through the local Nectar runtime.
- **Pipeline execution** — Run a pipeline directly from the editor and watch it execute in real-time (node highlighting, status updates, event stream).

#### 2C-ii. Idea Backlog ("The Seedbed")

A system for capturing and organizing ideas, tasks, and raw thoughts:

- **Stream of consciousness capture** — A quick-entry interface where the user can dump text, paste images, drag in videos/files, drop links. Friction should be near zero. Think "append to a running log" not "fill out a form." The internal implementation details of quick capture are intentionally flexible as long as retained ideas end up in the standard seed-on-disk structure below.
- **File-system organized** — Each idea/seed becomes a directory on disk, ideally named `NNN-short-slug/`, containing:
  - `seed.md` — The main content (text, embedded images, links, attachment references)
  - `attachments/` — Any associated files (screenshots, videos, documents)
  - `meta.yaml` — Canonical machine-readable metadata with required fields defined later in this document
  - `analysis/` — Subdirectory for AI-generated analysis files (one per provider)
- **Status tracking** — Both manual (user clicks/commands) and automatic (derived from documented filesystem and pipeline-state rules). `meta.yaml` is the canonical current-state record; UI and CLI actions, automation, and agent edits must converge on that file instead of inventing parallel state.
- **Priority system** — Standard priority levels plus the ability to async-flag something as urgent ("Queen's Order") from the CLI, web UI, or even by dropping a file into a watched directory.
- **Visualization** — Multiple views of the backlog:
  - **Kanban board** — Columns for status (Seedling, Sprouting, Blooming, Honey, Wilted). Drag-and-drop between columns.
  - **List view** — Sortable, filterable table.
  - **Timeline view** — When things were added, when they changed status.
- **Agent-readable structure** — The directory layout and file formats must be simple and well-documented enough that an AI agent scanning the file system can understand the full state of the backlog, identify what needs attention, and create new items on its own. This is critical. The file system IS the API for AI agents.

#### 2C-iii. Multi-AI Analysis ("Swarm Intelligence")

When a new idea is added to the backlog (or on demand):

1. The idea is sent to **Claude, Codex (OpenAI), and Gemini independently**.
2. Each AI analyzes the idea and produces a structured analysis covering:
   - Feasibility assessment
   - Suggested implementation approach
   - Estimated complexity
   - Risks and open questions
   - Recommended priority
3. Each analysis is saved as a separate file in the seed's `analysis/` directory (e.g., `analysis/claude.md`, `analysis/codex.md`, `analysis/gemini.md`).
4. The web UI shows these side-by-side for comparison.
5. A synthesis view highlights where the AIs agree and where they diverge.

This is similar in spirit to the multi-model analysis pattern but applied to product/feature ideation rather than code review.

---

## 3. Architecture Principles

### File System First
The file system is the primary data store and integration layer. No database. No proprietary formats. Plain text files (Markdown, YAML, DOT, JSON) in a well-organized directory tree. This means:
- Any tool can read/write the data (editors, scripts, AI agents, git)
- Everything is version-controllable
- Backup is just a file copy
- The web UI is a view layer, not the system of record

### Directory Structure
The project working directory should be organized something like:

```
nectar-workspace/
├── gardens/              # Pipeline definitions (.dot files)
│   ├── my-pipeline.dot
│   └── deploy-flow.dot
├── seedbed/              # Idea backlog
│   ├── 001-rate-limiting/
│   │   ├── seed.md
│   │   ├── meta.yaml
│   │   ├── attachments/
│   │   └── analysis/
│   │       ├── claude.md
│   │       ├── codex.md
│   │       └── gemini.md
│   └── 002-auth-rewrite/
│       └── ...
├── honey/                # Completed/archived items
├── cocoons/              # Pipeline checkpoints
└── .nectar/              # Configuration and state
    ├── config.yaml
    └── models.css        # Model stylesheet defaults
```

The exact names may vary slightly, but the structure must stay shallow, obvious, and stable. Agents should not need to reverse-engineer hidden conventions.

### Seed Schema and Lifecycle

Every retained seed must have a `meta.yaml` with at least these keys:

```yaml
id: 1
slug: rate-limiting
title: Add rate limiting to the API gateway
status: seedling
priority: high
tags: [api, infra]
created_at: 2026-03-19T16:00:00Z
updated_at: 2026-03-19T16:00:00Z
linked_gardens: []
linked_runs: []
analysis_status:
  claude: pending
  codex: pending
  gemini: pending
```

Required semantics:

- `id` is a stable numeric identifier unique within the workspace.
- `slug` is a stable filesystem-safe identifier.
- `status` is one of: `seedling`, `sprouting`, `blooming`, `honey`, `wilted`.
- `priority` is one of: `low`, `normal`, `high`, `queens_order`.
- `linked_gardens` contains paths relative to `gardens/`.
- `linked_runs` contains pipeline run IDs known to Nectar.
- `analysis_status.<provider>` is one of: `pending`, `running`, `complete`, `failed`, `skipped`.

Status meanings:

- `seedling` — captured, not yet actively being worked.
- `sprouting` — triaged or prepared for execution.
- `blooming` — actively in progress.
- `honey` — completed and optionally archived.
- `wilted` — rejected, cancelled, or intentionally abandoned.

State rules:

- `meta.yaml` is the canonical state record.
- A seed may live in `seedbed/` while active and may be moved to `honey/` when archived.
- If directory placement and `meta.yaml.status` disagree, Nectar should surface that as repairable inconsistency instead of silently choosing one.
- Automatic status changes must be based on explicit rules, not hidden heuristics. At minimum, an active linked pipeline run may move a seed to `blooming`, and a completed linked run may suggest or apply `honey` only through a documented rule.
- Manual changes made through the CLI, UI, or direct file edits are valid inputs; Nectar should reconcile them, not overwrite them with undocumented inference.

### Analysis File Contract

Each `analysis/{provider}.md` file must begin with YAML front matter so the UI and agents can parse it deterministically while still keeping the body human-readable.

Example:

```md
---
provider: codex
generated_at: 2026-03-19T16:05:00Z
status: complete
recommended_priority: high
estimated_complexity: medium
feasibility: high
---

# Summary

...
```

Required body sections:

- `Summary`
- `Implementation Approach`
- `Risks`
- `Open Questions`

The synthesis view in the web UI should be built from these normalized fields plus the Markdown body, not from ad hoc provider-specific parsing.

### Resumable by Default
Nectar must treat interruption as a normal event, not an edge case. Laptops die, users hit Ctrl+C, LLM providers go down, connections drop. The system should shrug these off gracefully:

- **Pipeline checkpointing is mandatory.** Every completed node writes a checkpoint before the next node begins. On resume, execution picks up from the last checkpoint — not from the beginning.
- **Resume is a first-class operation.** The CLI (`pollinator resume`), web UI, and HTTP API must all support resuming an interrupted pipeline run. The user should never need to manually reconstruct state or re-run completed work.
- **Partial progress is preserved.** If a codergen node was mid-stream when interrupted, the checkpoint should capture what was completed so the resumed run can decide whether to retry the node or accept partial output (configurable per node).
- **Cocoons are durable and self-describing.** Checkpoint files (cocoons) must contain enough context to resume without access to the original process memory: graph state, completed node outputs, pending edges, artifact references, and the active context store snapshot.
- **Interruption metadata is recorded.** When a run is interrupted (signal, crash, timeout, provider failure), the cocoon should record _why_ it stopped (if known) so the user or an agent can make informed decisions about whether and how to resume.
- **Graceful shutdown on signals.** On SIGINT/SIGTERM, Nectar should checkpoint the current state and exit cleanly rather than leaving orphaned state or corrupt files.

The attractor spec already requires checkpointing and crash recovery — this principle just makes the expectation explicit: **if it ran, it can resume.** No excuses, no "start over."

### Observable and Debuggable
Every pipeline execution emits a structured event stream. Checkpoints are human-readable JSON. Logs are comprehensive. When something goes wrong, the user should be able to understand what happened and why without attaching a debugger.

### Modern and Opinionated
- Dark theme, no light theme needed (but if easy, sure)
- Real-time updates everywhere (SSE/WebSocket)
- Fast — sub-second CLI responses, instant UI interactions
- Keyboard-navigable web UI
- Responsive but desktop-first

---

## 4. Technical Requirements

### Attractor Spec Compliance
The attractor implementation must cover:

- **DOT Parser** — Strict Graphviz subset: single `digraph` per file, directed edges only, typed attributes (String, Integer, Float, Boolean, Duration), node/edge/graph attributes, edge chaining (`A -> B -> C`), subgraph scoping. Node IDs: `[A-Za-z_][A-Za-z0-9_]*`.
- **9 Handler Types** — Mapped by node shape:
  - `Mdiamond` → start
  - `Msquare` → exit
  - `box` → codergen (LLM task)
  - `hexagon` → wait.human (approval gate)
  - `diamond` → conditional (routing)
  - `component` → parallel (fan-out)
  - `tripleoctagon` → fan-in
  - `parallelogram` → tool (shell command)
  - `house` → manager loop (supervisor)
  - `type` attribute overrides shape-based resolution
- **Edge Selection** — 5-step deterministic: condition match > preferred label > suggested IDs > weight > lexical order
- **Retry** — Exponential backoff, configurable per node (`max_retries`), preset policies (none, standard, aggressive, linear, patient)
- **Goal Gates** — Nodes with `goal_gate=true` must succeed before pipeline exits
- **Context Fidelity** — Modes: full, truncate, compact, summary:low/medium/high
- **Checkpointing** — JSON checkpoint after each node, crash recovery resume
- **Model Stylesheet** — CSS-like rules to assign LLM models/providers (specificity: `*` < shape < `.class` < `#id`)
- **Condition Expressions** — `outcome=success && context.tests_passed=true` with `=` and `!=`
- **Interviewer Abstraction** — 5 implementations: Console, AutoApprove, Callback, Queue, Recording
- **Validation** — 13 built-in lint rules (structural correctness, reachability, syntax)
- **AST Transforms** — Variable expansion, stylesheet application, custom transforms
- **Artifact Store** — Named typed storage, file-backed above 100KB
- **Parallel Execution** — Fan-out with `wait_all` or `first_success` join, bounded concurrency
- **Tool Call Hooks** — Pre/post hooks around LLM tool calls
- **HTTP API** — Full server mode:
  - `POST /pipelines` — Submit and start
  - `GET /pipelines/{id}` — Status
  - `GET /pipelines/{id}/events` — SSE event stream
  - `POST /pipelines/{id}/cancel` — Cancel
  - `GET /pipelines/{id}/graph` — SVG render
  - `GET /pipelines/{id}/questions` — Pending human gates
  - `POST /pipelines/{id}/questions/{qid}/answer` — Answer
  - `GET /pipelines/{id}/checkpoint` — Checkpoint
  - `GET /pipelines/{id}/context` — Context store

### Coding Agent Loop
- Session lifecycle: submit, steer, follow_up, abort
- Provider profiles with tailored system prompts and tool sets per provider
- Tool registry with pluggable tools
- Execution environment support required by the pinned upstream coding-agent-loop spec
- Loop detection and subagent depth limits
- Project instruction file discovery (AGENTS.md, CLAUDE.md, GEMINI.md, .codex/instructions.md) with 32KB budget
- `max_turns`, `max_tool_rounds_per_input`, `default_command_timeout_ms` configuration

### Unified LLM Client
- Provider adapters: OpenAI (Responses API), Anthropic (Messages API), Gemini (generateContent API)
- Streaming support for all providers
- Tool calling with JSON Schema validation
- Retry logic with backoff
- Structured output support
- Provider-specific quirk handling
- Environment variable configuration: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (plus optional `*_BASE_URL`)

### Local Runtime Contract
- The Hive runs against a local Nectar server on `localhost`; the browser does not read or write arbitrary files directly.
- The local server is responsible for all filesystem reads and writes, uploads, file watching, DOT rendering, pipeline execution, and event streaming.
- In addition to the attractor pipeline endpoints, Nectar must expose local APIs for:
  - Listing, reading, creating, and updating gardens
  - Listing, reading, creating, and updating seeds
  - Uploading seed attachments
  - Triggering or re-running swarm analysis
  - Streaming workspace change events
- Exact route names may be chosen by the implementer, but the contract surface above is required so the web UI has a stable local backend.

### CLI Requirements
- Single binary distribution (or minimal install)
- Cross-platform: macOS (ARM + Intel), Linux (x86_64) at minimum
- Self-update mechanism
- Shell completions (bash, zsh, fish)
- Config file support (YAML)
- Rich terminal output (colors, emoji, Unicode box drawing, spinners, progress bars)
- Graceful degradation on dumb terminals
- Pipe-friendly (detect TTY, output plain text when piped)

### Web UI Requirements
- Modern SPA (React, Svelte, or similar — choose whatever produces the best result)
- Dark theme, modern aesthetic
- Real-time updates via SSE or WebSocket
- Graphviz rendering (client-side or server-side SVG generation)
- Code editor component for DOT files (syntax highlighting, basic autocomplete)
- Kanban board with drag-and-drop
- File upload for attachments (images, videos, documents)
- Keyboard shortcuts for power users
- Mobile-responsive (but desktop-first)

---

## 5. What "Done" Looks Like

Nectar is done when:

1. **An agent can read the pinned three attractor NLSpec documents, compare them against the Nectar implementation, and find zero unimplemented features.** This is the hard requirement. Full spec compliance.

2. **A user can install Nectar with one command**, run `pollinator` in a terminal, and feel like they're using a polished, modern, delightful CLI tool.

3. **A user can launch the web UI**, create a pipeline by typing what they want in natural language, see it rendered as a graph in real-time, edit it, run it, and watch it execute — all from the browser.

4. **A user can dump ideas into the seedbed** from the CLI or web UI (text, images, files), have them automatically organized on the file system, get multi-AI analysis, and manage them through a kanban board.

5. **An AI agent can be pointed at the Nectar workspace directory** and understand the full state of pipelines, backlog items, and project status just by reading the file system. No API calls needed, no database queries — just files.

6. **It makes you smile.** The puns land. The emoji are well-chosen. The status messages are clever without being annoying. It feels like software made by people who enjoy making software.

---

## 6. What This Document Does NOT Cover

- **Specific language/framework choices** — The implementer should choose the best tools for the job. The attractor specs are language-agnostic.
- **Detailed UI mockups** — The web UI should be modern and polished. Specifics are left to the implementer's taste, guided by the requirements above.
- **Deployment infrastructure** — How Nectar itself is hosted/deployed is out of scope. It runs locally.
- **Authentication/authorization** — Nectar is a local development tool. No auth needed for v1.
- **Pricing/licensing** — Open source, license TBD.

---

## 7. Research Pointers

An implementing agent should start by reading:

1. The three NLSpec documents in [strongdm/attractor](https://github.com/strongdm/attractor), then pin the exact upstream commit or tag being targeted and record that snapshot locally:
   - `attractor-spec.md` — Core engine spec
   - `coding-agent-loop-spec.md` — Agent loop spec
   - `unified-llm-spec.md` — LLM client spec
2. The Graphviz DOT language specification for parser implementation
3. Current best practices for CLI tools (consider tools like `charm.sh/bubbletea`, `oclif`, `clap`, `cobra` depending on language choice)
4. Real-time web UI patterns (SSE event streams, optimistic updates, collaborative editing)
5. Kanban board implementations for UI reference

---

*This document was inflated from SEED.md — the original spark of an idea, expanded into something an agent can act on.*
