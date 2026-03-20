# Sprint 008: Seedbed Foundation - Filesystem Capture and Swarm Analysis

## Overview

**Goal:** Deliver the first end-to-end slice of Nectar's Seedbed: capture ideas from the CLI into the filesystem, track canonical state in `meta.yaml`, and generate per-provider swarm analysis files. After this sprint, `pollinator seed "Add rate limiting to the API gateway"` and `pollinator swarm 1` produce a stable on-disk seed that both humans and agents can understand without any database or hidden state.

**Why this sprint, why now:**

The compliance report shows that the core engine is no longer the biggest product bottleneck. Attractor is roughly 75% complete, the coding agent loop is roughly 55% complete, and the unified LLM client is roughly 45% complete. Those gaps still matter, but the INTENT doc makes a more important point: Nectar is not just an attractor implementation. It is also a filesystem-backed idea backlog and a multi-AI analysis tool.

Right now that second pillar does not exist at all. Another sprint on stylesheets, subagents, or SDK plumbing would improve internals, but Nectar would still be unable to capture a single idea. That is the wrong tradeoff. The next sprint should ship the thinnest vertical slice that makes Nectar feel like Nectar.

**Scope - what ships:**

- Filesystem-backed seed creation under `seedbed/NNN-slug/`
- Canonical `meta.yaml` and `seed.md` contracts aligned with `docs/INTENT.md`
- CLI commands for capture, listing, inspection, and status/priority updates
- Attachment import into `attachments/`
- Per-provider swarm analysis writing `analysis/claude.md`, `analysis/codex.md`, and `analysis/gemini.md`
- `analysis_status` tracking with `pending`, `running`, `complete`, `failed`, and `skipped`
- Consistency checks for `meta.yaml.status` vs directory placement (`seedbed/` vs `honey/`)

**Scope - what does not ship:**

- Web UI ("The Hive"), kanban board, timeline view, or synthesis view
- Local HTTP server and browser-facing seed APIs
- Automatic watched-folder ingestion
- Automatic pipeline-driven status transitions from `linked_runs`
- DOT editor work, model stylesheet work, context fidelity work, manager loop, steering, or subagents
