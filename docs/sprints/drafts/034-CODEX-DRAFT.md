# Sprint 034: Workspace Config, Deterministic AI Defaults, and Run-State Truth

## Overview

**Goal:** Make Nectar's AI-backed product surfaces predictable enough to trust by introducing filesystem-backed workspace config, applying workspace-level model defaults, and fixing the two remaining run-truth regressions that still break the Hive: unreliable `current_node` visibility and missing `pipeline_failed` emission. After this sprint: a clean workspace can draft gardens without hanging, a configured workspace can pick its preferred draft/swarm/runtime providers without touching code, codergen and fan-in nodes can inherit `.nectar/models.css` defaults, and the Hive sees one coherent answer about what run is active and why a run failed.

**Why this sprint, why now:**

1. **The compliance report is no longer pointing at missing engine breadth.** The remaining open items are medium/low gaps: model catalog currency, provider-profile metadata, prompt fidelity, and a few contract shape divergences. The next leverage is not more primitives. It is making the already-built runtime deterministic and operable.

2. **`INTENT.md` is explicit about configuration and file-system-first state.** `.nectar/config.yaml` and `.nectar/models.css` are part of the workspace contract, and the draft editor's default provider must be configurable. Neither exists today.

3. **The Hive still has ambient behavior instead of declared behavior.** Drafting and prompted fan-in currently depend on whichever providers happen to be visible through environment variables. That is wrong for a local product. Credentials should come from the environment; behavior should come from the workspace.

4. **The priority note in `INTENT.md` about parallel execution is stale.** The compliance report shows parallel and fan-in are already implemented. The real gap now is making those AI-backed paths deterministic, configurable, and observable.

**Scope:** Workspace config loading, workspace-level model stylesheet defaults, explicit provider/model resolution for garden drafting, swarm analysis, and pipeline LLM nodes, live run-state truth fixes, model catalog refresh, provider-profile capability metadata, and the regression tests that make these contracts stable.

**Out of scope:**

- Full provider reference-prompt mirroring (`C12`)
- Tool parameter renames/divergences (`C9`, `C10`, `C11`)
- Event naming renames (`A4`) or context locking (`A2`)
- New Hive list view, timeline view, or settings editor
- Shell completions, release packaging, or install-flow work

---

## Use Cases

1. **Clean workspace, no API keys, no config:** User runs `nectar serve`, opens the Hive, types a draft prompt, and receives `draft_start`, streamed `content_delta`, and `draft_complete` from the simulation provider. No hanging request, no accidental network dependency, no dependence on whatever keys happen to be in the shell.

2. **Configured draft defaults:** Workspace contains `.nectar/config.yaml` with `draft.provider: openai` and `draft.model: gpt-5.2`. Hive draft requests without explicit provider/model use Codex by default. Changing the file changes behavior; changing unrelated shell env vars does not.

3. **Workspace-wide pipeline model policy:** Workspace contains `.nectar/models.css` with rules such as `box { llm_provider: openai; llm_model: gpt-5.2; }` and `tripleoctagon { llm_provider: anthropic; reasoning_effort: high; }`. Codergen and prompted fan-in nodes inherit those defaults unless the node or graph explicitly overrides them.

4. **Live run truth while a node is still executing:** A browser starts a long-running pipeline, calls `GET /pipelines/:id`, `GET /pipelines/:id/context`, and `GET /pipelines/:id/graph`, and gets the same active node from all three surfaces while the run is still in progress.

5. **Failure terminal contract:** A pipeline stage fails. The event stream includes `stage_failed`, then `run_error`, then exactly one `pipeline_failed`. The Hive and CLI can render terminal failure state without guessing from partial events.

6. **Prompted fan-in without ambient provider drift:** A `tripleoctagon` node with a `prompt` but no explicit provider/model still completes deterministically using workspace defaults. It writes `parallel.fan_in.best_id`, `parallel.fan_in.rationale`, and the request/response artifacts every time.

7. **Non-secret workspace introspection:** The Hive calls `GET /workspace/config` and shows the active draft provider/model plus any config diagnostics. API keys are never returned; only resolved non-secret behavior is visible.

---

## Architecture

### Principle: Credentials From Env, Behavior From Workspace

This sprint makes one opinionated change: **environment variables authorize providers; they do not silently choose behavior.**

- API keys and base URLs stay in env.
- Provider/model defaults move into `.nectar/config.yaml` and `.nectar/models.css`.
- If the workspace does not explicitly choose a draft provider, drafting falls back to `simulation`, not "whichever real provider happened to come first."

That rule is what makes the Hive deterministic and testable.

### Workspace Files

`.nectar/config.yaml` becomes the non-secret control plane for AI-backed product behavior:

```yaml
draft:
  provider: simulation
  model: simulation

swarm:
  providers:
    claude:
      enabled: true
      llm_provider: anthropic
      model: default
    codex:
      enabled: true
      llm_provider: openai
      model: default
    gemini:
      enabled: true
      llm_provider: gemini
      model: default

runtime:
  fallback_llm_provider: simulation
  fallback_model: default
```

`.nectar/models.css` becomes the workspace-wide default stylesheet for graph LLM behavior:

```css
box { llm_provider: openai; llm_model: gpt-5.2; }
tripleoctagon { llm_provider: anthropic; llm_model: claude-opus-4.6; reasoning_effort: high; }
```

Secrets are explicitly out of scope for YAML. If a user tries to put API keys in `config.yaml`, Nectar should warn and ignore those fields.

### Resolution Order

The resolution order must be explicit and uniform.

**Garden draft requests**

```text
request body provider/model
→ .nectar/config.yaml draft.*
→ simulation
```

**Swarm analysis**

```text
CLI/server explicit provider selection
→ .nectar/config.yaml swarm.providers.*
→ built-in claude/codex/gemini mapping
→ skipped when the selected backing provider is unavailable
```

**Pipeline LLM nodes (codergen, prompted fan-in)**

```text
node attributes
→ graph model_stylesheet
→ .nectar/models.css
→ .nectar/config.yaml runtime fallback
→ built-in system defaults
```

This order is the heart of the sprint. If it is not documented, tested, and exposed, the feature is not done.

### Shared Runtime Objects

The server should stop constructing AI services ad hoc.

- One `WorkspaceConfigLoader` per workspace
- One shared `UnifiedClient` per server process
- One shared config-aware `PipelineService`
- One read-only `GET /workspace/config` endpoint that exposes resolved defaults, provider availability, and diagnostics

That gives drafting, swarm analysis, and pipeline execution one source of truth instead of three separate heuristics.

### Run-State Truth Contract

`RunManager` and the engine need one consistent definition of "current node" and "terminal failure."

- A running pipeline should never report `status: running` with a blank `current_node` once the start node is known.
- `pipeline_failed` must be emitted exactly once for every failed terminal run, whether the failure stops in place or reaches an `Msquare` through failure routing.
- The event journal, `GET /pipelines/:id`, `GET /pipelines/:id/context`, and `GET /pipelines/:id/graph` must all derive from the same live state model.

---

## Implementation Phases

### Phase 1: Workspace Config and Models.css Foundation (~20%)

**Files:** `src/config/workspace.ts`, `src/config/types.ts`, `test/config/workspace-config.test.ts`

**Tasks:**

- [ ] Create a typed workspace config module that loads optional `.nectar/config.yaml` and `.nectar/models.css` from the workspace root.
- [ ] Parse YAML with a strict schema and surface diagnostics for unknown providers, unknown models, invalid selectors, and secret-looking keys.
- [ ] Parse `.nectar/models.css` through the existing stylesheet parser so workspace stylesheet syntax matches graph-level `model_stylesheet` exactly.
- [ ] Implement mtime-based reload or cheap read-through caching so long-running `nectar serve` processes pick up config edits without restart-only semantics.
- [ ] Define safe defaults:
  - Drafting defaults to `simulation`.
  - Runtime fallback defaults to `simulation`.
  - Swarm providers use their declared mapping and become `skipped` when unavailable, not silently remapped.
- [ ] Add unit coverage for: missing files, invalid YAML, invalid stylesheet, unknown model IDs, selector resolution, and secret-field rejection.

### Phase 2: Thread Config Through Drafting, Swarm, and the Hive (~25%)

**Files:** `src/server/server.ts`, `src/server/routes/gardens.ts`, `src/server/routes/workspace.ts`, `src/runtime/garden-draft-service.ts`, `src/runtime/swarm-analysis-service.ts`, `src/cli/commands/serve.ts`, `src/cli/commands/swarm.ts`, `hive/src/lib/api.ts`, `hive/src/components/DraftComposer.ts`, `hive/src/App.ts`

**Tasks:**

- [ ] Instantiate one shared `WorkspaceConfigLoader` and one shared `UnifiedClient` in server startup and thread them through draft/swarm/runtime services.
- [ ] Change `GardenDraftService` resolution so request params win, `config.yaml` is second, and `simulation` is the only default. Do not pick the first env-backed provider implicitly.
- [ ] Change `SwarmAnalysisService` so conceptual providers (`claude`, `codex`, `gemini`) resolve through `config.yaml` and emit `skipped` when disabled or unavailable.
- [ ] Add `GET /workspace/config` that returns resolved non-secret config, provider availability, chosen defaults, and diagnostics. No API keys, tokens, or base URLs in the response.
- [ ] Update the Hive draft panel to show which provider/model is active and whether the result came from explicit config or simulation fallback.
- [ ] Keep editing out of scope: the Hive may display config state this sprint, but it does not become a config editor.
- [ ] Rewrite draft/swarm integration tests so they control behavior through a temp workspace config instead of ambient environment variables.

### Phase 3: Workspace Model Defaults in Pipeline Preparation (~20%)

**Files:** `src/garden/preparer.ts`, `src/transforms/workspace-stylesheet.ts`, `src/runtime/pipeline-service.ts`, `test/transforms/workspace-stylesheet.test.ts`, `test/integration/stylesheet-runtime.test.ts`

**Tasks:**

- [ ] Introduce a workspace-stylesheet transform or equivalent preparer hook that injects `.nectar/models.css` as the lowest-precedence stylesheet layer before graph-level stylesheet application.
- [ ] Preserve the intended precedence:
  - Node attributes beat everything.
  - Graph `model_stylesheet` beats workspace defaults.
  - Workspace defaults beat built-in fallbacks.
- [ ] Ensure composed/imported gardens inherit workspace defaults consistently and that source provenance includes `.nectar/models.css` when it was applied.
- [ ] Pass shared LLM client and resolved runtime fallback into `PipelineService` so codergen and prompted fan-in no longer instantiate their own ambient defaults.
- [ ] Add regression coverage for:
  - Workspace stylesheet only
  - Graph stylesheet overriding workspace stylesheet
  - Explicit node attrs overriding both
  - Composed graph behavior

### Phase 4: Live Run Truth and Failure Contract (~20%)

**Files:** `src/server/run-manager.ts`, `src/engine/engine.ts`, `test/integration/http-server.test.ts`, `test/server/pipeline-events.test.ts`

**Tasks:**

- [ ] Seed `current_node` from engine state as soon as the engine attaches so a run can enter `running` without temporarily returning an empty active node.
- [ ] Make `getStatus()`, `getContext()`, and `getGraphExecutionState()` use one shared resolver and one precedence order for live state vs checkpoint state.
- [ ] Preserve `current_node` through long-running tool execution, cancel, and interrupt paths until a terminal state or the next node transition makes it obsolete.
- [ ] Centralize failed-terminal handling so `pipeline_failed` is emitted exactly once after `run_error`, including failure paths that still route through an exit node.
- [ ] Add explicit regression coverage for:
  - Running pipeline exposes current node in `/pipelines/:id`
  - `/context` and `/graph` match that node
  - Failed pipeline event ordering is `stage_failed` → `run_error` → `pipeline_failed`
  - No duplicate `pipeline_failed` on retried or routed failure paths

### Phase 5: Catalog Refresh and Provider Capability Contract (~15%)

**Files:** `src/llm/catalog.ts`, `src/agent-loop/provider-profiles.ts`, `test/llm/catalog.test.ts`, `test/agent-loop/provider-profiles.test.ts`, `docs/compliance-report.md`

**Tasks:**

- [ ] Refresh the static model catalog to the pinned spec families called out in `docs/compliance-report.md`: GPT-5.2 family, Claude Opus 4.6, and Gemini 3.x.
- [ ] Update selectors and aliases so profile defaults resolve through current catalog entries instead of stale hand-picked IDs.
- [ ] Add `context_window_size`, `supports_reasoning`, and `supports_streaming` to `ProviderProfile`, derived from catalog data rather than duplicated literals.
- [ ] Use catalog-backed capability metadata to validate workspace config choices and to populate `GET /workspace/config`.
- [ ] Update `docs/compliance-report.md` to close `U3`, `C4`, and `C5` if all acceptance criteria are met.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/config/workspace.ts` | Create | Load, validate, cache, and resolve `.nectar/config.yaml` and `.nectar/models.css` |
| `src/config/types.ts` | Create | Typed schema for workspace AI config and diagnostics |
| `src/server/server.ts` | Modify | Construct shared config loader and shared `UnifiedClient` |
| `src/server/routes/gardens.ts` | Modify | Make draft route use config-aware draft service |
| `src/server/routes/workspace.ts` | Create | Expose resolved non-secret workspace config to the Hive |
| `src/runtime/garden-draft-service.ts` | Modify | Remove ambient provider selection; apply deterministic default resolution |
| `src/runtime/swarm-analysis-service.ts` | Modify | Resolve swarm providers/models from workspace config and mark unavailable providers as skipped |
| `src/garden/preparer.ts` | Modify | Inject workspace stylesheet layer during preparation |
| `src/transforms/workspace-stylesheet.ts` | Create | Apply `.nectar/models.css` as workspace-wide defaults |
| `src/runtime/pipeline-service.ts` | Modify | Thread shared LLM client and runtime fallback through engine execution |
| `src/server/run-manager.ts` | Modify | Fix live `current_node` truth and shared resolver behavior |
| `src/engine/engine.ts` | Modify | Centralize terminal failure emission and preserve failed-run semantics |
| `src/llm/catalog.ts` | Modify | Refresh pinned model families, selectors, and aliases |
| `src/agent-loop/provider-profiles.ts` | Modify | Expose capability metadata from catalog-backed profiles |
| `src/cli/commands/serve.ts` | Modify | Boot server with workspace-config-aware runtime |
| `src/cli/commands/swarm.ts` | Modify | Make CLI swarm behavior match server/workspace config |
| `hive/src/lib/api.ts` | Modify | Fetch workspace config for display |
| `hive/src/components/DraftComposer.ts` | Modify | Display active draft provider/model and config diagnostics |
| `hive/src/App.ts` | Modify | Load workspace config into Hive app state |
| `test/config/workspace-config.test.ts` | Create | Unit tests for config/schema/default resolution |
| `test/transforms/workspace-stylesheet.test.ts` | Create | Unit tests for workspace stylesheet precedence |
| `test/server/gardens-draft.test.ts` | Modify | Assert deterministic `draft_complete` behavior under config control |
| `test/runtime/swarm-analysis-service.test.ts` | Modify | Assert config-driven provider mapping and skipped states |
| `test/integration/fan-in-llm.test.ts` | Modify | Assert prompted fan-in completes under config-controlled provider defaults |
| `test/integration/http-server.test.ts` | Modify | Assert live `current_node` truth while run is active |
| `test/server/pipeline-events.test.ts` | Modify | Assert exactly one `pipeline_failed` in correct order |
| `test/llm/catalog.test.ts` | Modify | Assert refreshed model families and selectors |
| `test/agent-loop/provider-profiles.test.ts` | Modify | Assert capability fields and catalog-backed defaults |
| `docs/compliance-report.md` | Modify | Record closure of `U3`, `C4`, and `C5` if delivered |

---

## Definition of Done

- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes with zero failures
- [ ] A workspace with no `.nectar/config.yaml`, no `.nectar/models.css`, and no API keys can still draft a garden through the Hive using `simulation`, and `test/server/gardens-draft.test.ts` passes
- [ ] A workspace with `.nectar/config.yaml` can choose the default draft provider/model without changing code or passing request params
- [ ] `GET /workspace/config` returns resolved non-secret defaults, provider availability, and diagnostics; it never exposes API keys or bearer tokens
- [ ] `.nectar/models.css` is applied during pipeline preparation and is lower precedence than graph `model_stylesheet` and explicit node attrs
- [ ] Prompted fan-in nodes can inherit workspace defaults and `test/integration/fan-in-llm.test.ts` passes deterministically
- [ ] `GET /pipelines/:id`, `GET /pipelines/:id/context`, and `GET /pipelines/:id/graph` agree on `current_node` while a run is active
- [ ] Failed terminal runs emit `stage_failed`, then `run_error`, then exactly one `pipeline_failed`
- [ ] No draft, swarm, or fan-in test depends on ambient provider ordering from the shell environment
- [ ] `src/llm/catalog.ts` includes the pinned spec model families called out by compliance gap `U3`
- [ ] `ProviderProfile` exposes `context_window_size`, `supports_reasoning`, and `supports_streaming`
- [ ] `docs/compliance-report.md` no longer lists `U3`, `C4`, or `C5` as open gaps

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Config precedence becomes ambiguous between node attrs, graph stylesheet, workspace stylesheet, and runtime fallback | High | High | Write the precedence order once in code and once in tests. Add dedicated precedence tests for every layer. |
| `GET /workspace/config` leaks secrets or sensitive base URLs | Medium | High | Keep secrets env-only. The endpoint returns resolved non-secret behavior and availability booleans, never raw credentials. |
| Existing users with API keys see draft behavior change because draft no longer auto-picks the first configured provider | High | Medium | Make the change explicit in the sprint notes. Use `simulation` by default and require config or request params for real-provider drafting. This is an intentional contract correction. |
| Invalid `.nectar/models.css` breaks all pipeline runs in a workspace | Medium | High | Surface precise diagnostics. Keep server startup alive, but fail pipeline preparation with a clear validation error until the file is fixed. |
| Catalog refresh breaks existing aliases or stale tests | Medium | Medium | Preserve backward-compatible aliases where possible and update selector tests in the same change. |
| `current_node` still races on very fast nodes | Medium | Medium | Seed active node from engine attach, not just event replay, and test both long-running and fast-node pipelines. |
| `pipeline_failed` is emitted twice on routed failure paths | Medium | High | Keep a single emission guard in engine finalization and cover both direct-fail and fail-to-exit cases. |
| Swarm provider disablement is interpreted as failure rather than intentional skip | Low | Medium | Represent disabled/unavailable providers as `skipped` in both API responses and on-disk status updates. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing `yaml` dependency in `package.json` | Parse workspace config without adding a new parser dependency |
| Existing stylesheet parser and transform pipeline | Reuse the current `model_stylesheet` grammar for `.nectar/models.css` |
| `SimulationProvider` in the unified LLM client | Deterministic fallback for tests and no-key workspaces |
| Pinned unified-llm spec snapshot referenced by `docs/compliance-report.md` | Source of truth for the `U3` catalog refresh |
| Current Hive build/embed pipeline (`hive/` + `scripts/hive/embed-assets.mjs`) | Rebuild the small read-only config display into embedded Hive assets |

