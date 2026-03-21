# Sprint 034: Green Suite, Deterministic AI Defaults, and Compliance Closure

## Overview

**Goal:** Ship a green CI suite, make AI-backed product surfaces deterministic via workspace config, and close all achievable compliance gaps in one focused sprint. After this sprint: `npm test` passes with zero failures, garden drafting defaults to `simulation` instead of ambient provider probing, workspace config controls provider/model selection, and the compliance report reflects the actual shipped state.

**Why this sprint, why now:**

1. **The test suite is still red.** 3 tests are currently failing: `http-server` (current_node undefined during active runs), `gardens-draft` (draft_complete never emitted), and `pipeline-events` (pipeline_failed missing from event stream). All have known root causes. The INTENT.md §5.1 hard gate requires a green suite.

2. **The Hive has ambient behavior instead of declared behavior.** Drafting and prompted fan-in currently depend on whichever providers happen to be visible through environment variables. That is wrong for a local product. Credentials should come from the environment; behavior should come from the workspace.

3. **The remaining compliance gaps are mechanical.** 15 of the open gaps are one-line field additions, method stubs, or parameter aliases. The remaining gaps are small features (catalog refresh, provider capability fields, adapter lifecycle). No gap requires new architecture.

4. **INTENT.md is explicit about filesystem-first state.** `.nectar/config.yaml` is part of the workspace contract. The draft editor's default provider must be configurable. Neither exists today.

**Scope:** Fix 3 failing tests. Introduce `.nectar/config.yaml` for deterministic AI defaults. Close compliance gaps: A2, A4, A6, C4, C5, C9, C10, C11, U1, U2, U3, U4, U5, U6, U7, U8, U9, U10, U11, U12.

**Out of scope:**
- Full `.nectar/models.css` pipeline integration (deferred to a follow-up sprint)
- Full system prompt mirroring (C12) — high effort, low urgency
- Gemini web tools (C3) — optional per spec, needs search backend decision
- New Hive views, settings editor, or CLI commands
- Shell completions, release packaging, or distribution changes
- Event name renames — aliases only, no breaking changes

---

## Use Cases

1. **CI is green on a clean checkout.** `npm install && npm run build && npm test` passes with zero failures, zero timeouts. No test timeout values inflated.

2. **Clean workspace drafting works without API keys.** User runs `nectar serve`, opens the Hive, types a draft prompt, and receives `draft_start`, streamed `content_delta`, and `draft_complete` from the simulation provider. No hanging request, no accidental network dependency.

3. **Configured draft defaults.** Workspace contains `.nectar/config.yaml` with `draft.provider: openai` and `draft.model: gpt-5.2`. Hive draft requests without explicit provider/model use that provider. Changing the file changes behavior; changing unrelated shell env vars does not.

4. **Live run truth.** A browser starts a long-running pipeline, calls `GET /pipelines/:id`, and sees the correct active node while the run is in progress — never `current_node: undefined` while a node is executing.

5. **Failure terminal contract.** A pipeline fails. The event stream includes `run_error`, then exactly one `pipeline_failed`. The Hive and CLI can render terminal failure state without guessing.

6. **Provider adapters have lifecycle and capability introspection.** Adapters expose `initialize()`, `close()`, and `supports_tool_choice(mode)`. The model catalog includes current-generation models. Provider profiles report `context_window_size`, `supports_reasoning`, and `supports_streaming`.

7. **Message and streaming types match the spec surface.** `Message` has `tool_call_id` and `text` accessor. `ToolCallData` has `type`. `ToolResultData` supports `image_data`. `Usage` has `raw`. Stream events include `text_id` and `PROVIDER_EVENT` for unrecognized provider events.

---

## Architecture

### Principle: Credentials From Env, Behavior From Workspace

This sprint makes one opinionated change: **environment variables authorize providers; they do not silently choose behavior.**

- API keys and base URLs stay in env.
- Provider/model defaults move into `.nectar/config.yaml`.
- If the workspace does not explicitly choose a draft provider, drafting falls back to `simulation`, not "whichever real provider happened to come first."

### Workspace Config

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

Secrets are explicitly out of scope for YAML. If a user puts API keys in `config.yaml`, Nectar warns and ignores those fields.

### Resolution Order

**Garden draft requests:**
```
request body provider/model → .nectar/config.yaml draft.* → simulation
```

**Swarm analysis:**
```
CLI/server explicit selection → .nectar/config.yaml swarm.providers.* → built-in mapping → skipped when unavailable
```

### Run-State Truth Contract

- A running pipeline never reports `status: running` with a blank `current_node` once the start node is known.
- `pipeline_failed` is emitted exactly once for every failed terminal run.
- The event journal, `GET /pipelines/:id`, and `GET /pipelines/:id/context` all derive from the same live state model.

### Compliance Strategy: Aliases, Not Renames

All tool parameter and event name changes use **additive aliases**, not destructive renames:
- A4 (PascalCase events): Add PascalCase aliases alongside existing snake_case names. Do not remove snake_case.
- C9/C10/C11 (tool params): Accept both old and new parameter names. Old name stays as alias.
- A2 (ContextLock): `NoOpContextLock` implementation — JS single-threaded model + context clones already provides the spec's safety guarantee. The interface exists for future environments.

---

## Implementation

### Phase 1: Fix Failing Tests and Run-State Truth (~25%)

**Hard rule:** Phase 2 does not begin until `npm test` is green.

**Files:** `src/server/run-manager.ts`, `src/runtime/garden-draft-service.ts`, `src/engine/engine.ts`, `test/integration/http-server.test.ts`, `test/server/pipeline-events.test.ts`

**Tasks:**
- [ ] **`http-server` fix:** Make `RunManager.getStatus()` derive `current_node` from the last `node_started` event emitted to the run's event log, not from a snapshot poll. Seed from engine state as soon as the engine attaches so a run can enter `running` without temporarily returning an empty active node.
- [ ] **`gardens-draft` fix:** Trace `GardenDraftService.streamDraft()` to find where the async generator stalls. Establish a deterministic default: if no provider is configured and no API keys are present, fall back to `simulation`. Ensure `draft_error` is emitted on validation failure instead of silently hanging.
- [ ] **`pipeline-events` fix:** Trace the terminal event path in `engine.ts`. Centralize failed-terminal handling so `pipeline_failed` is emitted exactly once after `run_error`, including failure paths that route through an exit node. No duplicate emission on retried or routed failure paths.
- [ ] **Verify `fan-in-llm` is still passing.** Do not modify unless it regresses.
- [ ] **Run `npm test`.** All tests must pass. No regressions.

### Phase 2: Workspace Config Foundation (~20%)

**Files:** `src/config/workspace.ts` (create), `src/config/types.ts` (create), `src/server/server.ts`, `src/server/routes/gardens.ts`, `src/server/routes/workspace.ts` (create), `src/runtime/garden-draft-service.ts`, `src/cli/commands/serve.ts`, `test/config/workspace-config.test.ts` (create)

**Tasks:**
- [ ] Create a typed workspace config module that loads optional `.nectar/config.yaml` from the workspace root. Parse YAML with a strict schema. Surface diagnostics for unknown providers, unknown models, and secret-looking keys.
- [ ] Define safe defaults: drafting defaults to `simulation`, runtime fallback defaults to `simulation`, swarm providers use their declared mapping and become `skipped` when unavailable.
- [ ] Change `GardenDraftService` resolution: request params win, `config.yaml` is second, `simulation` is the only implicit default. Do not pick the first env-backed provider implicitly.
- [ ] Add `GET /workspace/config` that returns resolved non-secret config, provider availability, and diagnostics. No API keys, tokens, or base URLs in the response.
- [ ] Thread shared `WorkspaceConfigLoader` through server startup.
- [ ] Rewrite draft integration tests so they control behavior through a temp workspace config instead of ambient environment variables.
- [ ] Add unit coverage for: missing config file (uses defaults), invalid YAML, unknown model IDs, and secret-field rejection.

### Phase 3: Trivial Type and Interface Additions (~15%)

**Files:** `src/llm/types.ts`, `src/llm/streaming.ts`, `src/engine/events.ts`, `src/engine/engine.ts`, `src/engine/context.ts`

**Tasks:**
- [ ] **A4 (event aliases):** Add PascalCase type aliases for all engine events alongside existing snake_case names. Export a mapping so consumers can use either convention. Do not remove existing events.
- [ ] **A6 (auto_status notes):** Change auto_status note text to `"auto-status: handler completed without writing status"` to match the spec.
- [ ] **A2 (ContextLock):** Add a `ContextLock` interface with `acquireRead()`, `acquireWrite()`, and `release()` methods. Provide a `NoOpContextLock` implementation. Wire into `ExecutionContext` so the interface exists for future use.
- [ ] **U4 (Message.tool_call_id):** Add optional `tool_call_id?: string` field to `Message`.
- [ ] **U5 (Message.text):** Add a `text` getter that concatenates all text-type content parts, skipping non-text parts (tool calls, images). Empty string if no text parts.
- [ ] **U6 (ToolCallData.type):** Add `type: 'function' | 'custom'` field, defaulting to `'function'`.
- [ ] **U7 (ToolResultData.image_data):** Add optional `image_data?: string` and `image_media_type?: string` fields.
- [ ] **U8 (Usage.raw):** Add optional `raw?: unknown` for raw provider usage data. Populate from each adapter's raw response.
- [ ] **U9 (StreamEvent.text_id):** Add optional `text_id?: string` to text-related stream events.
- [ ] **U10 (PROVIDER_EVENT):** Add a `provider_event` stream event type for unrecognized provider events. Emit from each adapter's stream parser instead of silently dropping. Define a minimal payload shape: `{ provider: string, type: string, data: unknown }`.
- [ ] Add unit tests for `Message.text` concatenation, `PROVIDER_EVENT` emission, and `NoOpContextLock`.

### Phase 4: Tool Parameters, Profile Fields, and Catalog (~20%)

**Files:** `src/agent-loop/tools/read-file.ts`, `src/agent-loop/tools/glob.ts`, `src/agent-loop/tools/grep.ts`, `src/agent-loop/provider-profiles.ts`, `src/llm/catalog.ts`, `src/llm/adapters/types.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `src/llm/client.ts`, `test/agent-loop/tool-registry.test.ts`, `test/llm/catalog.test.ts`

**Tasks:**
- [ ] **C9 (read_file param):** Accept both `file_path` (primary) and `path` (alias). No breaking change.
- [ ] **C10 (glob path):** Add a `path` parameter to the glob tool for specifying the base directory. Default to cwd when omitted.
- [ ] **C11 (grep param):** Accept both `glob_filter` (primary) and `include` (alias). No breaking change.
- [ ] **C4 (ProviderProfile.context_window_size):** Add field, populate from catalog data.
- [ ] **C5 (ProviderProfile capability flags):** Add `supports_reasoning` and `supports_streaming` booleans, populate from catalog data.
- [ ] **U3 (Model catalog):** Refresh with current-generation models: GPT-5.2 family, Claude Opus 4.6 / Sonnet 4.6 / Haiku 4.5, Gemini 3.x. Include context windows, cost estimates, and capability flags. Preserve backward-compatible aliases.
- [ ] **U1 (Adapter lifecycle):** Add optional `initialize?(): Promise<void>` and `close?(): Promise<void>` to `ProviderAdapter`. Add no-op defaults. Call `initialize()` on first use and `close()` on `UnifiedClient.close()`.
- [ ] **U2 (supports_tool_choice):** Add `supports_tool_choice(mode: ToolChoiceMode): boolean` to `ProviderAdapter`. Implement per adapter: OpenAI supports all modes, Anthropic supports auto/none/required/named, Gemini supports auto/none/required, OpenAI-Compatible defaults to auto/none (configurable for specific providers).
- [ ] **U11 (TimeoutConfig.per_step):** Add optional `per_step_ms?: number` for per-LLM-call timeout in multi-step operations. Thread through the tool execution loop.
- [ ] **U12 (generate() max_retries):** Add optional `max_retries?: number` to `GenerateRequest`. When present, override the global retry config for that call. Define clear precedence: per-call > global.
- [ ] Add tests for glob with explicit path, grep with `glob_filter`, `supports_tool_choice()` per adapter, `close()` lifecycle, catalog model families, and per-call `max_retries`.

### Phase 5: Compliance Report Refresh and Validation (~10%)

**Files:** `docs/compliance-report.md`, all test files

**Tasks:**
- [ ] Run `npm test` — all tests must pass, zero failures, zero timeouts.
- [ ] Run `npm run build` — zero TypeScript errors.
- [ ] For each closed gap, verify the implementation matches the spec requirement. Move from GAPS to IMPLEMENTED with source code evidence.
- [ ] Update the Summary section to reflect remaining gap count (document any deliberate deviations with justification).
- [ ] Do a final read of the three spec documents against the compliance report to catch gaps missed in previous audits.
- [ ] Update the compliance report generation date.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/run-manager.ts` | Modify | Derive `current_node` from event log; seed from engine attach |
| `src/runtime/garden-draft-service.ts` | Modify | Fix draft streaming; apply deterministic default resolution |
| `src/engine/engine.ts` | Modify | Centralize `pipeline_failed` emission; update auto_status text |
| `src/engine/events.ts` | Modify | Add PascalCase event aliases |
| `src/engine/context.ts` | Modify | Add `ContextLock` interface and `NoOpContextLock` |
| `src/config/workspace.ts` | Create | Load, validate, and cache `.nectar/config.yaml` |
| `src/config/types.ts` | Create | Typed schema for workspace AI config |
| `src/server/server.ts` | Modify | Construct shared config loader |
| `src/server/routes/gardens.ts` | Modify | Use config-aware draft service |
| `src/server/routes/workspace.ts` | Create | `GET /workspace/config` endpoint |
| `src/cli/commands/serve.ts` | Modify | Boot server with workspace config |
| `src/llm/types.ts` | Modify | Add `tool_call_id`, `text`, `raw`, `image_data`, `type`, `text_id` fields |
| `src/llm/streaming.ts` | Modify | Add `PROVIDER_EVENT` stream event type |
| `src/llm/catalog.ts` | Modify | Add GPT-5.2, Claude 4.6, Gemini 3.x models |
| `src/llm/adapters/types.ts` | Modify | Add `initialize()`, `close()`, `supports_tool_choice()` |
| `src/llm/adapters/anthropic.ts` | Modify | Implement adapter lifecycle and tool-choice support |
| `src/llm/adapters/openai.ts` | Modify | Implement adapter lifecycle and tool-choice support |
| `src/llm/adapters/gemini.ts` | Modify | Implement adapter lifecycle and tool-choice support |
| `src/llm/adapters/openai-compatible.ts` | Modify | Implement adapter lifecycle and tool-choice support |
| `src/llm/client.ts` | Modify | Call adapter lifecycle; support per-call `max_retries` |
| `src/llm/timeouts.ts` | Modify | Add `per_step_ms` to `TimeoutConfig` |
| `src/agent-loop/tools/read-file.ts` | Modify | Accept `file_path` as primary param name |
| `src/agent-loop/tools/glob.ts` | Modify | Add `path` parameter for base directory |
| `src/agent-loop/tools/grep.ts` | Modify | Accept `glob_filter` as primary param name |
| `src/agent-loop/provider-profiles.ts` | Modify | Add capability fields from catalog |
| `docs/compliance-report.md` | Modify | Update gap statuses and generation date |
| `test/config/workspace-config.test.ts` | Create | Config loading, defaults, validation |
| `test/llm/catalog.test.ts` | Modify | Assert refreshed model families |
| `test/llm/adapters/*.test.ts` | Modify | Add lifecycle and tool-choice tests |
| `test/llm/client.test.ts` | Modify | Add per-call `max_retries` test |
| `test/agent-loop/tool-registry.test.ts` | Modify | Add glob path and grep glob_filter tests |
| `test/agent-loop/provider-profiles.test.ts` | Create | Assert capability fields |
| `test/integration/http-server.test.ts` | Modify | Verify `current_node` fix |
| `test/server/pipeline-events.test.ts` | Modify | Verify `pipeline_failed` fix |

---

## Definition of Done

- [ ] `npm install && npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all tests — zero failures, zero timeouts
- [ ] No test timeout values were increased to achieve green
- [ ] No existing tests regressed; test count is ≥ pre-sprint count
- [ ] The 3 previously-failing tests all pass: http-server, gardens-draft, pipeline-events
- [ ] A workspace with no `.nectar/config.yaml` and no API keys can draft a garden using `simulation`
- [ ] A workspace with `.nectar/config.yaml` can set default draft provider/model without code changes or request params
- [ ] `GET /workspace/config` returns resolved non-secret defaults and never exposes API keys
- [ ] `GET /pipelines/:id` reports correct `current_node` while a run is active
- [ ] Failed terminal runs emit exactly one `pipeline_failed` after `run_error`
- [ ] No draft or swarm test depends on ambient provider ordering from the shell environment
- [ ] PascalCase event aliases exist alongside snake_case originals (A4)
- [ ] auto_status note text matches spec wording (A6)
- [ ] `ContextLock` interface exists with `NoOpContextLock` implementation (A2)
- [ ] `read_file` accepts both `file_path` and `path` (C9)
- [ ] `glob` tool accepts `path` parameter for base directory (C10)
- [ ] `grep` tool accepts both `glob_filter` and `include` (C11)
- [ ] `ProviderProfile` exposes `context_window_size`, `supports_reasoning`, `supports_streaming` (C4, C5)
- [ ] Adapters expose `initialize()`, `close()`, and `supports_tool_choice()` (U1, U2)
- [ ] Model catalog includes GPT-5.2, Claude 4.6, Gemini 3.x families (U3)
- [ ] `Message` has `tool_call_id` and `text` accessor (U4, U5)
- [ ] `ToolCallData` has `type` field (U6)
- [ ] `ToolResultData` supports `image_data` and `image_media_type` (U7)
- [ ] `Usage` has `raw` field populated by adapters (U8)
- [ ] Stream events include `text_id` field (U9)
- [ ] `PROVIDER_EVENT` stream event type exists for unrecognized events (U10)
- [ ] `TimeoutConfig.per_step_ms` exists and is threaded through multi-step operations (U11)
- [ ] `GenerateRequest.max_retries` overrides global retry config per call (U12)
- [ ] `docs/compliance-report.md` reflects actual shipped state with source evidence
- [ ] Compliance re-audit completed against all three pinned specs

---

## Drop Line

If this sprint runs long, cut in this order (last item cut first):

1. **Keep:** Phase 1 (green suite) — non-negotiable hard gate
2. **Keep:** Phase 2 (workspace config) — fixes root cause of draft flakiness and establishes product determinism
3. **Keep:** Phase 3 (trivial type additions) — 10 gaps closed in ~2 hours, all additive
4. **Keep:** Phase 5 (compliance report refresh) — validates the work
5. **Defer first:** U11/U12 from Phase 4 (per-step timeout, per-call retries) — niche, no current consumer
6. **Defer second:** U1/U2 from Phase 4 (adapter lifecycle) — interface-shape compliance, can ship independently
7. **Defer third:** Remaining Phase 4 items (catalog, tool params) — useful but not blocking

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Test fixes expose deeper bugs beyond the 3 known failures | Medium | High | Phase 1 is a strict gate — run full suite before proceeding. If new failures appear, diagnose and fix before moving on. |
| `gardens-draft` fix is entangled with ambient provider selection | High | Medium | Address both simultaneously: fix the streaming path AND establish deterministic simulation default. The workspace config in Phase 2 makes this permanent. |
| Workspace config introduces precedence ambiguity | Medium | High | Document resolution order in code and tests. Add dedicated precedence tests for request > config > simulation. |
| `GET /workspace/config` leaks secrets | Medium | High | Keep secrets env-only. Endpoint returns resolved behavior and availability booleans, never raw credentials. |
| Existing users with API keys see draft behavior change | High | Medium | Intentional contract correction. Log a clear warning if API keys are detected but no `config.yaml` is present, advising the user of simulation-by-default behavior. |
| Parameter aliases (C9, C10, C11) — old names must keep working | Medium | Medium | Accept both old and new names. Old name stays as alias. Test both paths. No breaking change. |
| Model catalog entries are wrong or outdated | Medium | Low | Use model IDs from the knowledge cutoff. Catalog is a soft reference — wrong IDs cause a warning, not a crash. |
| Sprint scope is too large (20 gaps + 3 test fixes + workspace config) | Medium | High | Drop line defined. U11/U12 and U1/U2 can be deferred without violating the spirit of the sprint. Workspace config is scoped to config.yaml only — models.css deferred. |
| Type additions break existing test assertions that snapshot objects | Medium | Medium | All new fields are optional. Run full suite after each Phase 3 change. Fix snapshot tests immediately. |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| Existing `yaml` dependency in `package.json` | Parse `.nectar/config.yaml` |
| Existing `UnifiedClient`, adapter, and tool infrastructure | All changes are additive to existing interfaces |
| Existing `ProviderProfile` and `ToolRegistry` | Profile fields and tool registration |
| `SimulationProvider` in the unified LLM client | Deterministic fallback for tests and no-key workspaces |
| Pinned spec snapshot via `docs/compliance-report.md` | Source of truth for gap definitions |
| `vitest` | Test runner |
| No new runtime packages | All changes use existing modules or create new files within existing patterns |
