# Critique of `NEXT-CODEX-DRAFT.md` and `NEXT-GEMINI-DRAFT.md`

This critique evaluates both drafts against the current `docs/INTENT.md`, the 2026-03-21 compliance report, likely implementation risk, and sprint realism.

## Overall Assessment

`NEXT-CODEX-DRAFT.md` is the stronger base for the next sprint. It is more aligned with the product direction in `docs/INTENT.md`: filesystem-first workspace behavior, configurable draft/provider defaults, `.nectar/config.yaml`, `.nectar/models.css`, and user-visible runtime determinism.

`NEXT-GEMINI-DRAFT.md` is valuable as a compliance backlog document, but it is too broad and too breaking to be the next sprint as written. It tries to close every remaining spec gap at once, including several low-severity or optional gaps, and it underestimates the migration cost of event/tool-contract changes.

## `NEXT-CODEX-DRAFT.md`

### Strengths

- Strong alignment with `docs/INTENT.md`, especially the filesystem-first contract and the explicit `.nectar/config.yaml` / `.nectar/models.css` workspace model.
- Focuses on user-visible reliability problems instead of chasing every remaining compliance delta.
- The principle "credentials from env, behavior from workspace" is clean, testable, and easy to explain.
- Resolution order is explicit for draft requests, swarm analysis, and pipeline LLM nodes. That is the right level of specificity for this area.
- Addresses two concrete run-truth problems that still affect the Hive: unreliable `current_node` and missing/duplicated failed-terminal signaling.
- The Definition of Done is mostly outcome-based and includes concrete regression tests rather than vague completion language.
- It pulls in only the compliance items that directly support this sprint's value: catalog refresh and provider capability metadata.

### Weaknesses

- It is still a large sprint. Workspace config, stylesheet layering, shared service construction, Hive surfacing, run-state fixes, and catalog refresh is a lot of cross-cutting work for one iteration.
- The runtime contract is clear at a high level, but some operational details are still underspecified: when config is snapshotted, how reload interacts with active runs, and how invalid config affects already-running services.
- `GET /workspace/config` is directionally correct, but the exact response contract is still loose. "Resolved defaults, provider availability, and diagnostics" needs a tighter schema to avoid UI churn.
- The swarm section mixes conceptual providers (`claude`, `codex`, `gemini`) and backing providers (`anthropic`, `openai`, `gemini`) correctly in spirit, but the draft needs sharper terminology to prevent implementation confusion.
- Phase 5 may be more than this sprint needs. Catalog refresh and capability metadata help config validation, but they are easier to cut than the workspace/run-truth work if scope gets tight.

### Gaps in Risk Analysis

- No explicit risk for config reload races or partial writes while `nectar serve` is reading `.nectar/config.yaml` or `.nectar/models.css`.
- No explicit risk for mid-run config drift. A run should almost certainly resolve config once and stay stable for its lifetime.
- No explicit risk for mixed fallback behavior if config is invalid: some surfaces may fail closed while others quietly fall back to `simulation`.
- No explicit risk for workspace path/symlink boundary issues if config files are discovered from a workspace root.
- No explicit risk for Hive bootstrapping or embedded asset regeneration if the new read-only config surface changes frontend startup assumptions.
- No explicit risk for backward compatibility with users who currently rely on ambient env-provider selection, beyond noting that behavior changes.

### Missing Edge Cases

- `.nectar/config.yaml` exists but only some sections are present, empty, or malformed.
- Config selects a provider that is valid syntactically but unavailable because credentials are missing.
- Request-level provider/model conflicts with workspace defaults or references a model that belongs to a different provider.
- `.nectar/models.css` is valid overall but contains a subset of invalid rules or ties that depend on selector order/specificity.
- Composed/imported gardens plus workspace stylesheet plus graph stylesheet produce layered precedence conflicts.
- Config changes while a draft stream or pipeline run is already in progress.
- Extremely fast pipelines or start-to-exit graphs still need correct `current_node` behavior.
- Failure ordering should be covered not only for straight failures, but also cancel, interrupt, retry, resume, and failure-routing-through-exit paths.
- Swarm providers need distinct handling for `disabled`, `unavailable`, `misconfigured`, and `unsupported-model`, not just a generic `skipped`.

### Definition of Done Completeness

The DoD is good, but not fully complete.

- It should explicitly require hot-reload behavior to be tested if mtime-based reload remains in scope.
- It should require invalid-config diagnostics and secret-field rejection to be exercised end-to-end, not just in unit tests.
- It should require active runs to be immune to config edits after start.
- It should include CLI parity checks where config affects behavior, especially `nectar swarm` and `nectar serve`.
- It should include a docs update for the workspace config schema and precedence contract, not just a compliance report update.
- If Hive display changes ship, it should require rebuilt embedded assets and at least one integration test that exercises the frontend against the new endpoint.

### Verdict

This is the best candidate for the next sprint, but it should be tightened slightly. If schedule pressure appears, cut or defer Phase 5 before cutting the deterministic workspace/runtime work.

## `NEXT-GEMINI-DRAFT.md`

### Strengths

- It maps directly to the compliance report and makes the remaining gaps explicit.
- It has a clean "close the audit" framing, which is useful for planning a future compliance-hardening sprint.
- It correctly identifies some worthwhile gaps: stale model catalog, missing provider capability fields, and tool-contract divergences.
- The Definition of Done is measurable in compliance terms and would be easy to audit if the sprint were otherwise realistic.

### Weaknesses

- It is too large for one sprint. It spans engine event contracts, context semantics, provider profiles, core tool schemas, Gemini web tools, prompt mirroring, adapter lifecycle methods, stream/event types, retry/timeouts, and a full compliance re-audit.
- It prioritizes strict spec closure over the product problems called out in `docs/INTENT.md` and over the current runtime pain points.
- It treats low-severity or optional gaps as if they belong in the same sprint as the few medium-value gaps.
- It underestimates the breakage risk of renaming event contracts and tool parameters. Those are not isolated edits; they affect CLI rendering, SSE consumers, Hive behavior, tests, and any saved expectations around current naming.
- The proposed `ReadWriteLock` is questionable as sprint material. The compliance report already notes that the current design uses JS single-threaded execution plus context clones for parallel branches. A lock may satisfy spec wording while adding complexity without solving the real semantics question.
- `web_search` / `web_fetch` and full prompt mirroring are expensive additions for comparatively weak immediate product value.
- The "0 gaps" success condition makes the sprint brittle. One disputed audit interpretation could cause the whole sprint to look incomplete.

### Gaps in Risk Analysis

- No migration strategy for changing event names from `snake_case` to `PascalCase`.
- No migration strategy for tool parameter renames such as `path` to `file_path` and `include` to `glob_filter`.
- No risk analysis for dual-support, deprecation windows, or release-note burden for breaking contract changes.
- No risk analysis for prompt mirroring: source pinning, maintenance burden, token budget impact, or drift from upstream reference agents.
- No risk analysis for Gemini web tools in offline, restricted, or privacy-sensitive environments.
- No risk analysis for expanding core LLM interfaces and the blast radius across adapters, middleware, tests, and downstream callers.
- No risk analysis for stored event journals, SSE replay, or generated frontend assets that currently assume existing event names.
- No risk analysis for lock starvation, cancellation, or semantic mismatch between locking and cloned branch context.

### Missing Edge Cases

- Old and new event names may need to coexist for a transition period.
- Old and new tool parameter names may need compatibility shims or targeted error messaging.
- Optional interface fields need tests for absent, undefined, null, and provider-specific partial implementations.
- `initialize()` / `close()` lifecycle methods need idempotency rules and ordering guarantees.
- `supports_tool_choice(mode)` needs behavior defined for unsupported modes and provider fallbacks.
- `text_id`, raw provider event passthrough, and unknown-provider-event handling need multi-part stream coverage.
- `max_retries` per call needs well-defined precedence versus global retry middleware.
- `per_step` timeout needs behavior defined across multi-step tool loops, streaming, and retries.
- `web_search` / `web_fetch` need explicit behavior when disabled, offline, rate-limited, or policy-blocked.
- Exact `auto_status` string matching is brittle unless the sprint intentionally wants to hard-freeze the wording.

### Definition of Done Completeness

The DoD is measurable, but incomplete as a shipping checklist.

- It does not require migration docs or release notes for breaking API/tool/event changes.
- It does not require backward-compatibility tests or a deliberate decision that compatibility is intentionally broken.
- It does not require updates to docs for changed tool schemas, event names, or adapter interfaces.
- It does not define how the compliance audit is rerun, pinned, or versioned so the "0 gaps" result is reproducible.
- It does not require validation that Hive, CLI, SSE replay, and persisted event consumers all still work after event renaming.
- It does not require negative-path tests for optional fields being absent on providers that do not populate them.

### Verdict

This should not be the next sprint as written. It is better treated as a follow-on compliance sprint, split into smaller tracks with an explicit compatibility strategy.

## Recommendations for the Final Merged Sprint

- Use `NEXT-CODEX-DRAFT.md` as the backbone.
- Keep the core goals: workspace config loading, workspace model defaults, deterministic provider/model resolution, shared runtime wiring, `GET /workspace/config`, live `current_node` truth, and exactly-once failed-terminal signaling.
- Keep the catalog refresh and `ProviderProfile` capability fields (`U3`, `C4`, `C5`) because they directly support config validation and UI introspection.
- Add stricter acceptance criteria around config reload semantics, invalid-config diagnostics, secret rejection, and run-time snapshotting of resolved config.
- Add explicit coverage for `disabled` vs `unavailable` vs `misconfigured` provider states in swarm/config responses.
- Add explicit cancel, interrupt, resume, routed-failure, and fast-node coverage to the run-truth acceptance criteria.
- Add a documentation deliverable for `.nectar/config.yaml`, `.nectar/models.css`, resolution order, and the `GET /workspace/config` response contract.
- If scope needs trimming, defer the catalog-refresh/documentation tail before deferring the deterministic workspace/runtime work.

## Recommendations for Deferred Follow-Up Sprints

- Defer `A2`, `A4`, `C3`, `C9`, `C10`, `C11`, `C12`, and `U1`-`U12` except for `U3`.
- Treat event renaming and tool parameter renaming as a compatibility/migration sprint, not a side effect of another effort.
- Treat prompt mirroring and Gemini web tools as a separate agent-loop capability sprint with explicit value justification and test strategy.
- Revisit context locking only if there is a demonstrated semantic bug that cloning does not address, not just because the spec wording mentions a lock.
