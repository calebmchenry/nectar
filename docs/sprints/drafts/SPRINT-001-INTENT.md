# Sprint 001 Intent — Working CLI That Runs DOT Files

## Seed Prompt

> Build a working CLI tool that can run/execute a dot file, so the user can continue the dev process with it after this sprint.

## Orientation Summary

- **Project state**: Greenfield Nectar repo with `SEED.md`, `docs/INTENT.md`, one sample DOT file (`gardens/compliance-loop.dot`), zero source code, no git history.
- **Vision**: Nectar = full attractor spec implementation + Pollinator CLI + The Hive web UI + Seedbed backlog. This sprint targets the **minimum viable slice**: parse a DOT file and execute it as a pipeline.
- **Recent work**: Project bootstrapped with intent doc and a sample compliance-loop DOT file that exercises multiple node types (tool/parallelogram nodes, conditionals, start/exit).
- **Key modules likely involved**: DOT parser, graph engine, node handler registry, CLI entry point, checkpoint system.
- **Constraints**: File-system first architecture, pollination theme, must follow attractor spec semantics for node types and edge selection.

## Relevant Codebase Areas

| Area | Status | Notes |
|------|--------|-------|
| DOT parser | Not started | Must support digraph, node attributes (shape, label, script, etc.), edge attributes (label, condition, weight), edge chaining |
| Graph engine | Not started | Topological traversal, deterministic edge selection (5-step), retry logic |
| Node handlers | Not started | At minimum for this sprint: `start`, `exit`, `tool` (parallelogram / shell command). Stubs for remaining 6 types. |
| Checkpoint system | Not started | JSON checkpoint after each node completion |
| CLI shell | Not started | Entry point, `run` command, rich terminal output |
| Unified LLM client | Not started | Not needed this sprint (no codergen nodes executed) |
| Web UI | Not started | Not in scope this sprint |

## Constraints & Patterns to Respect

1. **Attractor spec compliance** — Node shapes map to handler types per the spec. Edge selection follows the 5-step deterministic algorithm. Retry uses exponential backoff.
2. **File-system first** — Checkpoints (cocoons) are JSON files on disk. Pipeline definitions are `.dot` files in `gardens/`.
3. **Pollination theme** — CLI output uses bee/flower/honey metaphors, emoji, dark-theme-friendly colors.
4. **Resumable by default** — Checkpoints written after every node. `pollinator resume` must work.
5. **Language choice** — Not yet decided. The attractor spec is language-agnostic. TypeScript/Node or Go are likely candidates given CLI and cross-platform requirements.

## Success Criteria

After this sprint, a user must be able to:

1. **Run** `pollinator run gardens/compliance-loop.dot` and see the pipeline execute node-by-node with themed terminal output.
2. **See** each node's status (blooming, success, failure) with emoji and color.
3. **Execute tool nodes** — `parallelogram` shape nodes run their `script` attribute as a shell command.
4. **Follow conditional edges** — After a node completes, the engine picks the correct outgoing edge using the 5-step deterministic algorithm based on outcome and conditions.
5. **Handle start/exit nodes** — Pipeline begins at `Mdiamond`, ends at `Msquare`.
6. **Checkpoint progress** — A `.json` cocoon file is written after each node completes.
7. **Resume interrupted runs** — `pollinator resume <run-id>` picks up from the last checkpoint.
8. **Validate DOT files** — `pollinator validate <file>` checks structural correctness.
9. **Graceful failures** — If a tool node's script fails, the node is marked as failed, retry logic kicks in (if configured), and the correct failure edge is followed.

## Verification Strategy

- **Unit tests** for DOT parser (parse the sample `compliance-loop.dot` and assert correct graph structure).
- **Unit tests** for edge selection algorithm (all 5 steps).
- **Integration test**: Run a simple test DOT file end-to-end and verify node execution order and final state.
- **Resume test**: Interrupt a run mid-pipeline, verify checkpoint exists, resume and verify completion.
- **CLI output test**: Verify themed output contains expected emoji and status strings.

## Uncertainty Assessment

| Factor | Level | Rationale |
|--------|-------|-----------|
| **Correctness** | Medium | DOT parsing and attractor edge selection are well-specified but non-trivial to implement correctly |
| **Scope** | Low | Focused slice — just the engine + CLI `run` command, no LLM integration, no web UI |
| **Architecture** | Medium | Greenfield project — language choice, module layout, and key abstractions need to be decided |

## Open Questions

1. **Language choice** — TypeScript (fast iteration, npm ecosystem) vs Go (single binary, cross-platform) vs Rust? User preference?
2. **Which node types must actually execute this sprint?** Intent says `start`, `exit`, `tool` (shell commands). Should `conditional` (diamond) evaluate condition expressions, or just follow default edges?
3. **How far should the DOT parser go?** Full Graphviz spec or just the subset the attractor spec uses?
4. **Should `codergen` nodes be stubbed or skipped entirely?** They need the unified LLM client which is out of scope.
5. **Checkpoint format** — Follow the attractor spec's checkpoint schema exactly, or a simplified version for now?
