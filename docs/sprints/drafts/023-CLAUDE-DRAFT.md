# Sprint 023: Full Condition Language, Agent Configurability & Spec Compliance Sweep

## Overview

**Goal:** Close six of the eight remaining compliance gaps in a single sweep. The headline feature is a complete condition expression language with comparison operators, string matching, existence checks, and full variable references — unlocking real-world conditional routing. The sprint also ships the `generate()` auto-tool loop, `edit_file` replace_all, glob mtime sorting, missing error subtypes, and runtime-configurable SessionConfig fields.

**Why this sprint, why now:**

1. **GAP-1 is the last major engine gap.** Every other engine feature — parallel execution, fan-in, checkpointing, manager loops, composition — is implemented. But conditional routing is crippled: you can't write `steps.review.output CONTAINS "approved"` or `artifacts.score > 0.8` or even check whether a variable exists. Real pipelines need these. This is the single highest-impact remaining gap.

2. **The remaining gaps are small enough to bundle.** GAP-3 (auto tool loop) is ~80 lines. GAP-5 (replace_all) is a one-parameter addition. GAP-6 (glob mtime sorting) is a stat call and sort change. GAP-7 (error subtypes) is two new classes. GAP-8 (SessionConfig fields) is wiring existing constants to config. None of these justify a standalone sprint, but together they meaningfully close the compliance distance.

3. **After this sprint, only GAP-2 and GAP-4 remain.** GAP-2 (AUDIO/DOCUMENT content types) supports future modalities no provider fully offers today. GAP-4 (Gemini extended tools) is explicitly optional in the spec. Both are low-urgency and can be addressed opportunistically.

4. **Sprint 022 completed the extension story.** Custom transforms, sub-pipeline composition, and OpenAI-Compatible adapter are all in place. The condition language upgrade builds directly on the existing parser in `src/engine/conditions.ts` — there's no architectural prerequisite missing.

**Gaps closed:**

| Gap | Spec | Effort | Impact |
|-----|------|--------|--------|
| GAP-1: Condition Expression Language | attractor-spec §10 | Large | Full conditional routing with comparisons, string matching, EXISTS, steps/artifacts refs |
| GAP-3: generate() Automatic Tool Loop | unified-llm-spec §4.3 | Small | Batteries-included high-level LLM API |
| GAP-5: edit_file replace_all | coding-agent-loop-spec §3.3 | Tiny | Bulk in-file replacements |
| GAP-6: glob mtime Sorting | coding-agent-loop-spec §3.3 | Tiny | Recently-modified files surfaced first |
| GAP-7: QuotaExceeded, StreamError | unified-llm-spec §6.1 | Small | Distinct error types for quota vs rate-limit, stream-specific failures |
| GAP-8: SessionConfig Fields | coding-agent-loop-spec §2.2 | Medium | Runtime-configurable loop detection, tool limits, max command timeout |

**Deliberately deferred:**

- GAP-2: AUDIO/DOCUMENT content types — no provider fully uses these today
- GAP-4: Gemini extended tools (read_many_files, list_dir) — optional per spec

**Out of scope:**

- New CLI commands or Hive UI features
- New handler types
- Changes to parallel/fan-in behavior
- LLM adapter changes beyond the generate() tool loop

---

## Use Cases

1. **Rich conditional routing:** A pipeline has a `review` codergen node followed by a `diamond` conditional. The condition `steps.review.output CONTAINS "LGTM"` routes to `deploy`; `steps.review.output CONTAINS "changes requested"` routes to `revise`. This is impossible today — after this sprint it works.

2. **Numeric threshold gates:** A `score` tool node writes a numeric value to context. The condition `context.coverage > 80` routes to `release`; otherwise to `add_tests`. Comparison operators make this expressible.

3. **Artifact existence checks:** A conditional checks `artifacts.report EXISTS` to decide whether to skip report generation. The EXISTS operator eliminates the need for sentinel values.

4. **Standalone LLM tool loop:** A script uses the Nectar LLM client directly (not the full agent loop) to call `generate()` with tools defined. The model calls tools, `generate()` automatically executes them and re-calls the model until natural completion or 10 iterations — no manual loop required.

5. **Bulk rename via edit_file:** An agent renames a variable across a file with a single `edit_file` call using `replace_all: true` instead of N individual calls.

6. **Recent files first in glob:** An agent runs `glob("src/**/*.ts")` and gets results sorted newest-first, immediately seeing recently modified files relevant to current work.

7. **Quota vs rate-limit distinction:** A pipeline hitting a billing quota limit gets a `QuotaExceededError` (non-retryable) instead of a `RateLimitError` (retryable), preventing futile retry loops that waste time.

8. **Configurable agent loop:** A host application creates a session with `enable_loop_detection: false` for a known-repetitive task, or sets `tool_output_limits: { shell: 50000 }` for a task that needs large command output.

---

## Architecture

### Condition Expression Language (GAP-1)

The existing condition parser in `src/engine/conditions.ts` uses a flat Term/AndNode/OrNode AST with only `=` and `!=` operators on `outcome` and `context.*` variables. This sprint replaces the parser with a proper recursive-descent parser supporting:

**New operators:**
- Comparison: `<`, `>`, `<=`, `>=` (numeric when both sides parse as numbers, lexicographic otherwise)
- String matching: `CONTAINS`, `STARTS_WITH`, `ENDS_WITH` (case-sensitive)
- Existence: `EXISTS` (unary, checks variable is defined and non-empty)
- Negation: `NOT` (unary prefix)
- Grouping: `(` `)` (parentheses)

**New variable references:**
- `steps.<nodeId>.status` — resolves to the StageStatus of a completed node
- `steps.<nodeId>.output` — resolves to the last_response context of a completed node
- `artifacts.<key>` — resolves to "true" if artifact exists, the artifact value (stringified) for comparisons

**Operator precedence** (lowest to highest):
1. `||`
2. `&&`
3. `NOT`
4. Comparison (`=`, `!=`, `<`, `>`, `<=`, `>=`)
5. String matching (`CONTAINS`, `STARTS_WITH`, `ENDS_WITH`)
6. `EXISTS`

**AST design:** Replace the flat Term union with a proper expression tree:

```typescript
type Expression =
  | { type: 'literal'; value: string }
  | { type: 'variable'; path: string[] }     // ["steps", "review", "status"]
  | { type: 'binary'; op: BinaryOp; left: Expression; right: Expression }
  | { type: 'unary'; op: 'NOT' | 'EXISTS'; operand: Expression }
  | { type: 'logical'; op: '&&' | '||'; children: Expression[] };

type BinaryOp = '=' | '!=' | '<' | '>' | '<=' | '>='
  | 'CONTAINS' | 'STARTS_WITH' | 'ENDS_WITH';
```

**ConditionScope** expands to include step history and artifact access:

```typescript
export interface ConditionScope {
  outcome: OutcomeStatus;
  preferred_label?: string;
  context: Record<string, string>;
  steps: Record<string, { status: string; output?: string }>;
  artifacts: { has(key: string): boolean; get(key: string): string | undefined };
}
```

The engine already tracks completed nodes and their outcomes — the scope just needs to be assembled from existing state at evaluation time. The artifact store is already available on the engine.

**Backward compatibility:** All existing conditions (`outcome=success`, `context.key=value`, `&&`, `||`) parse identically under the new grammar. The existing `validateConditionExpression()` in validate.ts updates to use the new parser.

### generate() Auto Tool Loop (GAP-3)

The module-level `generate()` in `src/llm/client.ts` currently calls `generateUnified()` once. This sprint wraps it in a tool execution loop:

```typescript
export async function generate(
  request: GenerateRequest,
  options?: {
    tools?: Map<string, (args: unknown) => Promise<unknown>>;
    maxIterations?: number; // default 10
  }
): Promise<GenerateResponse> {
  let response = await generateUnified(request);
  let iterations = 0;
  while (hasToolCalls(response) && iterations < (options?.maxIterations ?? 10)) {
    const toolResults = await executeToolCalls(response, options.tools);
    request = appendToolResults(request, response, toolResults);
    response = await generateUnified(request);
    iterations++;
  }
  return response;
}
```

The existing `generate()` signature is preserved for callers without tools — if no `tools` map is provided, behavior is unchanged (single call, return immediately).

### edit_file replace_all (GAP-5)

Add `replace_all` (optional boolean, default false) to the edit_file tool schema in `src/agent-loop/tools/edit-file.ts`. When true, use `String.prototype.replaceAll()` instead of the single-match logic. Return a count of replacements in the result message.

### glob mtime Sorting (GAP-6)

In `src/agent-loop/tools/glob.ts`, after collecting results, `stat()` each file path concurrently via `Promise.allSettled`. Sort by `mtimeMs` descending (newest first). Files that fail to stat sort to the end.

### Error Subtypes (GAP-7)

Add to `src/llm/errors.ts`:
- `QuotaExceededError extends LLMError` — `retryable: false`, distinguished from `RateLimitError` by HTTP status body patterns (e.g., OpenAI `insufficient_quota`, Anthropic `billing_*`)
- `StreamError extends LLMError` — `retryable: true`, used for mid-stream connection drops, malformed SSE, unexpected stream termination

Update provider adapters to throw `QuotaExceededError` when the error response indicates quota/billing exhaustion rather than transient rate limiting. Update SSE parsing in `src/llm/streaming.ts` to throw `StreamError` on parse failures.

### SessionConfig Fields (GAP-8)

Expand `SessionConfig` in `src/agent-loop/types.ts`:

```typescript
interface SessionConfig {
  max_turns: number;                    // existing, default 12
  max_tool_rounds_per_input: number;    // existing, default 10
  default_command_timeout_ms: number;   // existing, default 10000
  workspace_root: string;               // existing
  max_command_timeout_ms: number;       // NEW, default 600000
  reasoning_effort?: 'low' | 'medium' | 'high';  // NEW
  tool_output_limits: Record<string, number>;     // NEW, overrides defaults
  tool_line_limits: Record<string, number>;        // NEW, overrides defaults
  enable_loop_detection: boolean;       // NEW, default true
  loop_detection_window: number;        // NEW, default 10
}
```

Wire these into the existing code paths:
- `max_command_timeout_ms`: cap in shell tool execution
- `reasoning_effort`: initial session override
- `tool_output_limits`/`tool_line_limits`: merge with defaults in truncation logic
- `enable_loop_detection`/`loop_detection_window`: pass to LoopDetector constructor

---

## Implementation

### Phase 1: Condition Expression Language (~50%)

**Files:** `src/engine/conditions.ts`, `src/engine/engine.ts`, `src/garden/validate.ts`, `test/engine/conditions.test.ts`, `test/garden/validate.test.ts`

**Tasks:**
- [ ] Design the new AST types (Expression, BinaryOp, etc.) in `conditions.ts`
- [ ] Implement a tokenizer: identifiers, quoted strings, numbers, operators (`=`, `!=`, `<`, `>`, `<=`, `>=`), keywords (`AND`/`&&`, `OR`/`||`, `NOT`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `EXISTS`), parentheses
- [ ] Implement recursive-descent parser with correct precedence: `parseOr` → `parseAnd` → `parseNot` → `parseComparison` → `parseStringMatch` → `parseExists` → `parsePrimary`
- [ ] Implement `parsePrimary`: variable references (`outcome`, `preferred_label`, `context.<key>`, `steps.<nodeId>.status`, `steps.<nodeId>.output`, `artifacts.<key>`), string literals (quoted), numeric literals, parenthesized sub-expressions
- [ ] Implement expression evaluator with the expanded `ConditionScope`
- [ ] Numeric comparison: if both sides parse as finite numbers via `Number()`, compare numerically; otherwise compare as strings lexicographically
- [ ] String matching operators: `CONTAINS` → `String.includes()`, `STARTS_WITH` → `String.startsWith()`, `ENDS_WITH` → `String.endsWith()`
- [ ] `EXISTS` operator: variable is defined and non-empty string
- [ ] `NOT` operator: boolean negation of sub-expression
- [ ] Parentheses: grouping for precedence override
- [ ] Update `ConditionScope` to include `steps` and `artifacts` access
- [ ] Update engine.ts to assemble the expanded scope from completed node history and artifact store before each edge evaluation
- [ ] Update `validateConditionExpression()` in validate.ts to use the new parser (parse-only mode, no evaluation) and report syntax errors
- [ ] Preserve backward compatibility: all existing `=`/`!=`/`&&`/`||` expressions must parse and evaluate identically
- [ ] Unit tests: every new operator in isolation, precedence edge cases, variable resolution for steps/artifacts, backward compatibility with all existing condition patterns, error messages for malformed expressions
- [ ] Integration test: a pipeline with numeric comparison and string-matching conditions routing correctly

### Phase 2: generate() Auto Tool Loop (~15%)

**Files:** `src/llm/client.ts`, `src/llm/types.ts`, `test/llm/client.test.ts`

**Tasks:**
- [ ] Add `GenerateOptions` type with optional `tools` map and `maxIterations`
- [ ] Implement tool execution loop in `generate()`: detect tool_call content parts in response, look up handler in tools map, execute, build tool_result messages, append to conversation, re-call `generateUnified()`
- [ ] Loop terminates on: no tool calls (natural completion), maxIterations reached, or error
- [ ] When no `tools` map is provided, behavior is unchanged (single call, return)
- [ ] Unit tests: mock client returning tool calls → verify loop executes tools and re-calls → verify natural completion stops loop → verify maxIterations cap → verify no-tools passthrough

### Phase 3: Agent Loop Quick Fixes — GAP-5, GAP-6, GAP-8 (~20%)

**Files:** `src/agent-loop/tools/edit-file.ts`, `src/agent-loop/tools/glob.ts`, `src/agent-loop/types.ts`, `src/agent-loop/session.ts`, `src/agent-loop/loop-detection.ts`, `src/agent-loop/truncation.ts`, `src/agent-loop/tools/shell.ts`, `test/agent-loop/loop-detection.test.ts`

**Tasks:**

**GAP-5: edit_file replace_all**
- [ ] Add `replace_all` (boolean, optional, default false) to edit_file input schema
- [ ] When `replace_all` is true, count occurrences of `old_string`, replace all, report count in result
- [ ] When `replace_all` is false, preserve existing behavior (error on multiple matches)
- [ ] Unit test: replace_all with 3 occurrences → all replaced, count reported

**GAP-6: glob mtime sorting**
- [ ] After glob results collected, `stat()` each file path concurrently via `Promise.allSettled()`
- [ ] Sort by `mtimeMs` descending (newest first); files failing stat sort to end
- [ ] Unit test: create files with known timestamps → verify sort order

**GAP-8: SessionConfig expansion**
- [ ] Add `max_command_timeout_ms`, `reasoning_effort`, `tool_output_limits`, `tool_line_limits`, `enable_loop_detection`, `loop_detection_window` to SessionConfig with defaults
- [ ] Wire `max_command_timeout_ms` as upper cap in shell tool — `Math.min(requested, config.max_command_timeout_ms)`
- [ ] Wire `reasoning_effort` as initial value in session overrides
- [ ] Wire `tool_output_limits`/`tool_line_limits` to merge with hardcoded defaults in truncation.ts — config values take precedence
- [ ] Wire `enable_loop_detection` to conditionally construct LoopDetector (or a no-op stub)
- [ ] Wire `loop_detection_window` to LoopDetector constructor
- [ ] Unit tests: session created with custom config → verify each field takes effect

### Phase 4: Error Subtypes — GAP-7 (~15%)

**Files:** `src/llm/errors.ts`, `src/llm/streaming.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `test/llm/client.test.ts`

**Tasks:**
- [ ] Define `QuotaExceededError` extending `LLMError` with `retryable: false`
- [ ] Define `StreamError` extending `LLMError` with `retryable: true`
- [ ] OpenAI adapter: detect `insufficient_quota` error code → throw `QuotaExceededError` instead of `RateLimitError`
- [ ] Anthropic adapter: detect billing/quota error patterns → throw `QuotaExceededError`
- [ ] Gemini adapter: detect `RESOURCE_EXHAUSTED` with quota indication → throw `QuotaExceededError`
- [ ] OpenAI-Compatible adapter: same quota detection as OpenAI adapter
- [ ] SSE parser (`streaming.ts`): catch malformed SSE frames, unexpected disconnects → throw `StreamError` with context about what failed
- [ ] Unit tests: verify each adapter maps quota errors correctly; verify SSE parser throws StreamError on malformed input
- [ ] Verify retry middleware does NOT retry `QuotaExceededError` but DOES retry `StreamError`

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/conditions.ts` | Rewrite | Full recursive-descent condition parser with new AST |
| `src/engine/engine.ts` | Modify | Assemble expanded ConditionScope with steps/artifacts |
| `src/garden/validate.ts` | Modify | Update condition validation to use new parser |
| `src/llm/client.ts` | Modify | Add auto tool loop to generate() |
| `src/llm/types.ts` | Modify | Add GenerateOptions type |
| `src/llm/errors.ts` | Modify | Add QuotaExceededError, StreamError |
| `src/llm/streaming.ts` | Modify | Throw StreamError on malformed SSE |
| `src/llm/adapters/openai.ts` | Modify | Quota error detection |
| `src/llm/adapters/anthropic.ts` | Modify | Quota error detection |
| `src/llm/adapters/gemini.ts` | Modify | Quota error detection |
| `src/llm/adapters/openai-compatible.ts` | Modify | Quota error detection |
| `src/agent-loop/tools/edit-file.ts` | Modify | Add replace_all parameter |
| `src/agent-loop/tools/glob.ts` | Modify | mtime-based sorting |
| `src/agent-loop/types.ts` | Modify | Expand SessionConfig |
| `src/agent-loop/session.ts` | Modify | Wire new SessionConfig fields |
| `src/agent-loop/loop-detection.ts` | Modify | Accept configurable window, support disable |
| `src/agent-loop/truncation.ts` | Modify | Accept configurable limits |
| `src/agent-loop/tools/shell.ts` | Modify | Respect max_command_timeout_ms cap |
| `test/engine/conditions.test.ts` | Rewrite | Comprehensive tests for new parser and evaluator |
| `test/garden/validate.test.ts` | Modify | Add tests for new condition validation |
| `test/llm/client.test.ts` | Modify | Add generate() tool loop tests |
| `test/llm/openai-compatible.test.ts` | Modify | Add quota error mapping test |
| `test/agent-loop/loop-detection.test.ts` | Modify | Test configurable window and disable |
| `test/integration/conditions.test.ts` | Create | End-to-end pipeline with rich conditions |

---

## Definition of Done

**GAP-1: Condition Expression Language**
- [ ] `outcome=success && context.key=value` still works identically (backward compat)
- [ ] `context.coverage > 80` evaluates numerically
- [ ] `steps.review.status = "success"` resolves from completed node history
- [ ] `steps.review.output CONTAINS "approved"` matches against node output
- [ ] `artifacts.report EXISTS` returns true when artifact is present
- [ ] `NOT outcome=failure` evaluates correctly
- [ ] `(context.a = "1" || context.b = "2") && outcome=success` respects parentheses
- [ ] `context.name STARTS_WITH "test"` and `ENDS_WITH ".ts"` work
- [ ] Malformed expressions produce clear parse errors with position info
- [ ] Validation catches syntax errors at parse time (before execution)
- [ ] Integration test: pipeline with `>` and `CONTAINS` conditions routes correctly

**GAP-3: generate() Auto Tool Loop**
- [ ] `generate(request)` without tools behaves identically to before
- [ ] `generate(request, { tools })` executes tool calls and loops until natural completion
- [ ] Loop stops at `maxIterations` (default 10)
- [ ] Tool errors are returned as tool_result error messages, not thrown

**GAP-5: edit_file replace_all**
- [ ] `edit_file` with `replace_all: true` replaces all occurrences and reports count
- [ ] `edit_file` without `replace_all` preserves existing error-on-multiple behavior

**GAP-6: glob mtime Sorting**
- [ ] glob results are sorted by modification time, newest first
- [ ] Files that fail to stat are included at the end (not dropped)

**GAP-7: Error Subtypes**
- [ ] `QuotaExceededError` is thrown for billing/quota errors, `retryable: false`
- [ ] `StreamError` is thrown for malformed SSE / mid-stream disconnects, `retryable: true`
- [ ] Retry middleware does not retry `QuotaExceededError`
- [ ] Retry middleware retries `StreamError` normally

**GAP-8: SessionConfig Fields**
- [ ] `max_command_timeout_ms` caps shell tool execution time
- [ ] `reasoning_effort` is applied as initial session override
- [ ] `tool_output_limits` and `tool_line_limits` override defaults when provided
- [ ] `enable_loop_detection: false` disables loop detection
- [ ] `loop_detection_window` changes the detection window size
- [ ] All new fields have sensible defaults matching current hardcoded values

**Cross-cutting**
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes all existing and new tests
- [ ] No breaking changes to public API signatures (all additions are backward-compatible)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Condition parser rewrite breaks existing expressions | Medium | High | Exhaustive backward-compat test suite: every condition pattern used in existing gardens and tests must parse identically. Run full test suite before and after. |
| Numeric vs string comparison ambiguity | Medium | Medium | Clear rule: if both operands parse as finite numbers via `Number()`, compare numerically; otherwise lexicographic. Document this. Edge case: "08" vs "8" — both parse as numbers, so numeric comparison. |
| `steps.*` variable references need engine state not currently passed to edge selector | Low | Medium | The engine already tracks `completedNodes` with outcomes. Assembling the scope is plumbing, not new logic. |
| `artifacts.*` resolution requires artifact store access in condition evaluation | Low | Low | Artifact store is already on the engine instance. Pass a read-only accessor to the scope. |
| generate() tool loop infinite loops on misbehaving tools | Low | Medium | Hard cap at `maxIterations` (default 10). No tool execution without explicit `tools` map. |
| glob mtime stat() calls slow on large result sets | Medium | Low | Stat calls are concurrent via `Promise.allSettled`. Glob already has a max-results cap. For very large sets, the stat overhead is dominated by the glob itself. |
| Quota error pattern matching is fragile across providers | Medium | Medium | Use known error codes/messages from provider documentation. Fall through to `RateLimitError` if pattern doesn't match — worst case is retrying a quota error, same as today. |
| SessionConfig expansion breaks existing callers | Low | Low | All new fields have defaults matching current behavior. `Partial<SessionConfig>` already used in most call sites. |

---

## Dependencies

| Package | Purpose | Status |
|---------|---------|--------|
| No new dependencies | All work uses existing packages | — |

This sprint adds zero new dependencies. The condition parser is hand-written (no parser generator). Error subtypes extend the existing error hierarchy. The generate() tool loop uses existing LLM client infrastructure. All agent loop changes modify existing code paths.

The only external dependency is accurate documentation of provider-specific quota error codes for GAP-7, which is available in the OpenAI, Anthropic, and Gemini API docs.
