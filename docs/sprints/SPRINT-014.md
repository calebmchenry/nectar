# Sprint 014: LLM Client SDK Hardening — Structured Output, Prompt Caching & Provider Correctness

## Overview

**Goal:** Close five medium-severity gaps in the Unified LLM Client spec (L2, L4, L10, L11, L20) by shipping structured output with `generate_object()`, Anthropic prompt caching, beta header passthrough, thinking block round-tripping, and a `provider_options` escape hatch. After this sprint, the LLM client is production-grade: callers can request JSON-schema-constrained output from any provider via a single method, Anthropic sessions benefit from automatic prompt caching, and provider-specific features are accessible without forking the unified request type.

**Why this sprint, why now:**

- The Unified LLM Client has **20 gaps — the widest gap surface of any spec** — and 6 of those are medium-severity. The attractor engine and coding agent loop each have ≤1 medium gap remaining. The LLM client is the weakest link in the compliance stack.
- **L4 (Structured Output) is the hard gate for Swarm Intelligence.** INTENT §2C-iii requires multi-AI analysis producing structured `analysis/{provider}.md` files with YAML frontmatter and normalized fields (`feasibility`, `estimated_complexity`, `recommended_priority`). Without `ResponseFormat` and a validated `generate_object<T>()`, swarm analysis degrades to prompt-and-pray Markdown parsing. This blocks the seedbed's core differentiator.
- **L10 (Anthropic Prompt Caching) is a direct cost multiplier.** Every codergen node in every pipeline makes Anthropic API calls with identical system prompts (~2K tokens) and tool definitions (~4K tokens). Without `cache_control` breakpoints, those tokens are re-ingested every call at full price. Anthropic caching gives 90% input cost reduction on cache hits. For a 7-node pipeline with 10+ tool rounds each, that's hundreds of thousands of wasted input tokens eliminated.
- **L2 (ThinkingData.signature) is a silent correctness bug.** Anthropic's extended thinking API requires `signature` fields on thinking blocks for multi-turn conversations. Without it, thinking-enabled sessions silently break after the first turn — the API rejects subsequent messages that reference unsigned thinking blocks. Every codergen node using `reasoning_effort` is affected.
- **L11 and L20 are foundational plumbing.** `provider_options` (L20) is the spec-required escape hatch for any provider-specific parameter. `anthropic-beta` headers (L11) are required for extended thinking, higher token limits, and prompt caching. L10 and L2 literally cannot be implemented correctly without L11 and L20.

These five gaps form a tight dependency cluster: L20 enables L11, L11 enables L10 and L2, and L4 enables swarm analysis. Shipping them as a unit avoids half-features.

The alternative sprint candidate (A4/A5 context fidelity) improves execution quality in long pipelines — a subtler win. This sprint unblocks an entire product surface (Swarm Intelligence) and delivers measurable cost savings on day one. Additionally, the fidelity sprint's `full` thread reuse (A5) depends on L2 being done to work correctly with Anthropic thinking — doing A5 without L2 creates a hidden landmine. Fidelity should follow as Sprint 015.

**Gaps closed:**

| Gap | Severity | Description |
|-----|----------|-------------|
| L2  | **Medium** | `ThinkingData.signature` field for Anthropic thinking round-trips |
| L4  | **Medium** | `ResponseFormat` type: `json_schema`, `json`, `text` modes; `generate_object()` and `stream_object()` methods |
| L10 | **Medium** | Anthropic prompt caching with automatic `cache_control` breakpoint injection |
| L11 | **Medium** | Anthropic `anthropic-beta` header passthrough |
| L20 | **Medium** | `provider_options` escape hatch on `GenerateRequest` |

**Total: 5 Medium = 5 gaps closed.**

**In scope:**

- `provider_options` field on `GenerateRequest` — typed per-provider option interfaces
- `anthropic-beta` header injection from `provider_options.anthropic.betas`
- `ThinkingData.signature` on thinking content parts, round-tripped through Anthropic adapter
- Automatic `cache_control` injection on system prompt, tool definitions, and conversation prefix for Anthropic
- `ResponseFormat` type with `text`, `json`, and `json_schema` modes
- Per-adapter structured output: Anthropic (synthetic tool extraction), OpenAI (`text.format`), Gemini (`responseMimeType` + `responseSchema`)
- `generate_object<T>()` on `UnifiedClient`: non-streaming structured output with JSON Schema validation and retry
- `stream_object<T>()` on `UnifiedClient`: streaming structured output with partial accumulation
- `StructuredOutputError` for parse/validation failures with diagnostic context

**Out of scope:**

- L7 (Middleware/interceptor chain) — orthogonal architecture, not load-bearing for any product feature
- L8 (Model catalog / `ModelInfo`) — informational convenience, not blocking
- L9 (High-level `generate()` with tool loop) — the agent-loop already handles tool loops; adding a second loop at the SDK layer creates duplicate code paths and confusion about which loop to use
- L6 (Message.name, tool_call_id) — trivial additive, can ride along with any sprint
- L14 (addUsage) — trivial utility, can ride along with any sprint
- L17 (StreamAccumulator) — useful but not a compliance priority
- A4/A5 (Context fidelity runtime) — attractor engine work, recommended as Sprint 015 (now unblocked by L2)
- Swarm analysis implementation itself — this sprint provides the SDK foundation; seedbed sprint builds on it

**Cut-line:** If the sprint runs long, defer Phase 5 (`stream_object()` streaming structured output). Ship `generate_object()` for non-streaming structured output, which covers the swarm analysis use case completely. Do **not** defer L2 (signature) or L10 (caching) — these are correctness and cost issues that affect every Anthropic call today.

---

## Use Cases

1. **Structured seed analysis.** A swarm analysis pipeline calls `generate_object<SeedAnalysis>()` with a JSON Schema defining `{ feasibility, estimated_complexity, recommended_priority, summary, implementation_approach, risks, open_questions }`. Each provider returns a validated typed object. If the model returns malformed JSON, the method retries with a correction prompt (up to 2 attempts). The caller gets `T` or a descriptive `StructuredOutputError` — never a hope-and-parse situation.

   ```typescript
   const result = await client.generateObject<SeedAnalysis>({
     messages: [{ role: 'user', content: seedDescription }],
     response_format: {
       type: 'json_schema',
       json_schema: { name: 'SeedAnalysis', schema: seedAnalysisSchema }
     }
   });
   console.log(result.object.recommended_priority); // 'high'
   ```

2. **Cost-effective pipeline execution.** A 7-node pipeline runs against Anthropic. Each codergen node's system prompt (~2K tokens) and tool definitions (~4K tokens) are automatically marked with `cache_control: { type: "ephemeral" }`. After the first call in each node, subsequent tool rounds hit the cache: 6K tokens × ~70 total rounds × 90% savings = ~380K tokens of input cost eliminated per pipeline run. The caller changes nothing — caching is automatic.

3. **Multi-turn extended thinking.** A codergen node with `reasoning_effort="high"` runs a 3-turn conversation. Turn 1 returns thinking blocks with cryptographic signatures. Turn 2 sends those blocks back with signatures intact. Anthropic validates the reasoning chain and continues coherently. Without L2, signatures are dropped and Anthropic rejects the second turn with a 400 error.

4. **Extended thinking with beta headers.** A pipeline uses `reasoning_effort="high"` targeting `claude-sonnet-4-20250514`. The adapter automatically includes `anthropic-beta: interleaved-thinking-2025-05-14`. The caller can also pass explicit betas via `provider_options: { anthropic: { betas: ["max-tokens-3-5-sonnet-2025-04-14"] } }`.

5. **Provider-specific parameters.** A caller needs Gemini's `safetySettings` or OpenAI's `store: true` for evals. They pass `provider_options: { gemini: { safety_settings: [...] } }` or `provider_options: { openai: { store: true } }`. The adapter merges these into the native request body. No adapter fork, no one-off code path.

6. **JSON mode for simple cases.** A caller needs valid JSON output without a specific schema. They set `response_format: { type: 'json' }`. The adapter translates to the provider's native JSON mode. Simpler than `json_schema` when you just need parseable JSON.

---

## Architecture

### provider_options (L20)

A typed escape hatch on `GenerateRequest`. Each adapter reads only its own section; unrecognized sections are silently ignored for forward-compatibility.

```typescript
interface ProviderOptions {
  anthropic?: {
    betas?: string[];                        // anthropic-beta header values
    cache_control?: boolean;                 // override auto-caching (default: true when provider is anthropic)
    metadata?: { user_id?: string };
  };
  openai?: {
    store?: boolean;
    metadata?: Record<string, string>;
  };
  gemini?: {
    safety_settings?: Array<{ category: string; threshold: string }>;
    generation_config?: Record<string, unknown>;  // passthrough for future Gemini-specific fields
  };
}

// Added to GenerateRequest:
interface GenerateRequest {
  // ... existing fields ...
  provider_options?: ProviderOptions;
  response_format?: ResponseFormat;
}
```

**Design choice: typed interfaces, not `Record<string, unknown>`.** Typed options catch misspellings at compile time. Only Gemini gets a `generation_config` catch-all for truly unknown future fields.

### Anthropic Beta Headers (L11)

The Anthropic adapter reads `provider_options.anthropic.betas` and auto-adds feature-required betas:

```typescript
// In AnthropicAdapter, before fetch():
const betas: string[] = [...(request.provider_options?.anthropic?.betas ?? [])];

// Auto-add required betas based on request features
if (request.reasoning_effort) {
  betas.push('interleaved-thinking-2025-05-14');
}
if (shouldCache) {
  betas.push('prompt-caching-2024-07-31');
}

// Deduplicate
const betaHeader = [...new Set(betas)].join(',');
if (betaHeader) headers['anthropic-beta'] = betaHeader;
```

Callers never need to know which beta flags their features require.

### ThinkingData.signature (L2)

Non-breaking addition to the thinking content part:

```typescript
// Updated ContentPart union member:
| { type: 'thinking'; thinking: string; signature?: string }
```

Changes:
- **Anthropic response translation:** Extract `signature` from thinking blocks in the API response
- **Anthropic request translation:** Include `signature` on thinking blocks sent back to the API
- **All other code:** The field is optional — destructuring `{ type, thinking }` still works, `signature` is just ignored

The Anthropic API returns thinking blocks as `{ "type": "thinking", "thinking": "...", "signature": "ErUB..." }`. Currently the adapter drops `signature`. After this sprint it's preserved through the full round-trip.

### Anthropic Prompt Caching (L10)

When caching is active, the adapter injects `cache_control: { type: "ephemeral" }` at up to 3 strategic breakpoints in the already-translated native request body:

1. **System prompt:** Last text block of the `system` array
2. **Tool definitions:** Last element of the `tools` array
3. **Conversation prefix:** Last content block of the second-to-last user message (for multi-turn reuse)

```typescript
function injectCacheBreakpoints(body: Record<string, unknown>): void {
  // 1. System — convert string to array if needed for cache_control attachment
  const system = body.system;
  if (typeof system === 'string') {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(system) && system.length > 0) {
    system[system.length - 1].cache_control = { type: 'ephemeral' };
  }

  // 2. Tools
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (tools && tools.length > 0) {
    tools[tools.length - 1].cache_control = { type: 'ephemeral' };
  }

  // 3. Conversation prefix — second-to-last user message
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (messages) {
    const userIndices = messages
      .map((m, i) => m.role === 'user' ? i : -1)
      .filter(i => i >= 0);
    if (userIndices.length >= 2) {
      const prefixIdx = userIndices[userIndices.length - 2]!;
      const content = messages[prefixIdx]!.content;
      if (Array.isArray(content) && content.length > 0) {
        (content[content.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
      }
    }
  }
}
```

**Activation:** Caching is enabled by default for the Anthropic adapter. Callers can disable it via `provider_options: { anthropic: { cache_control: false } }`. The `Usage` type already carries `cache_read_tokens` and `cache_write_tokens` — the adapter already reports them. This sprint adds the injection that makes caching actually happen.

### Structured Output / ResponseFormat (L4)

#### ResponseFormat Type

```typescript
type ResponseFormat =
  | { type: 'text' }
  | { type: 'json' }
  | { type: 'json_schema'; json_schema: JsonSchemaDefinition };

interface JsonSchemaDefinition {
  name: string;
  description?: string;
  schema: Record<string, unknown>;  // JSON Schema object
  strict?: boolean;                  // OpenAI strict mode (default true)
}
```

#### Provider Translation

| Provider | `json` mode | `json_schema` mode |
|----------|------------|-------------------|
| **OpenAI** | `text.format: { type: "json_object" }` | `text.format: { type: "json_schema", name, schema, strict }` |
| **Anthropic** | Synthetic tool with permissive `{ type: "object" }` schema | Synthetic tool with caller's schema (see below) |
| **Gemini** | `responseMimeType: "application/json"` | `responseMimeType: "application/json"` + `responseSchema` |

**Anthropic structured output via synthetic tool:**

Anthropic lacks native JSON schema mode. The established pattern (used by Anthropic's own Python SDK):

1. Inject a synthetic tool: `{ name: "__structured_output", description: "Respond with structured output matching the required schema", input_schema: callerSchema }`
2. Force tool use: `tool_choice: { type: "tool", name: "__structured_output" }`
3. On response: extract the tool call arguments as the structured JSON result
4. Rewrite the response: replace the `tool_use` content part with a `text` part containing the extracted JSON
5. Set `stop_reason` to `end_turn` (not `tool_use`) — callers see a normal text completion

When the caller also provides their own tools alongside `response_format`, the synthetic tool is additive. After extraction, the caller's tools remain available for subsequent turns.

**Gemini schema restrictions:** Gemini's `responseSchema` does not support `$ref`, complex `anyOf`, or `additionalProperties`. Schemas that work on OpenAI/Anthropic may produce unexpected results on Gemini. For complex schemas that exceed Gemini's subset, degrade gracefully to `json` mode with schema instructions in the prompt.

#### generate_object<T>() and stream_object<T>()

High-level methods on `UnifiedClient`:

```typescript
interface GenerateObjectRequest extends GenerateRequest {
  response_format: { type: 'json_schema'; json_schema: JsonSchemaDefinition };
  max_validation_retries?: number;  // retries on parse/validation failure (default 2)
}

interface GenerateObjectResponse<T> extends GenerateResponse {
  object: T;
  raw_text: string;
}

class UnifiedClient {
  // ... existing methods ...

  async generateObject<T>(request: GenerateObjectRequest): Promise<GenerateObjectResponse<T>>;
  streamObject<T>(request: GenerateObjectRequest): AsyncIterable<StreamObjectEvent<T>>;
}
```

**`generateObject()` flow:**

1. Call `generateUnified()` with `response_format` on the request
2. Extract text content from response
3. Parse JSON (`JSON.parse`)
4. Validate against `json_schema.schema` using `ajv` (already in the dependency tree via agent-loop's `ToolRegistry`)
5. On failure: if `max_validation_retries` remain, append the parse/validation error as a user message and re-call
6. On failure + no retries: throw `StructuredOutputError` with `rawText`, `parseError`, and `schema`
7. Return `GenerateObjectResponse<T>` with `object` and `raw_text`

**`stream_object()` flow (Phase 5, deferrable):**

1. Call `stream()` with `response_format`
2. Accumulate text deltas, yield `{ type: 'partial'; text_so_far: string }` events
3. On `stream_end`: parse JSON, validate schema
4. Yield `{ type: 'object'; object: T; raw_text: string; usage: Usage }` on success
5. Yield `{ type: 'error'; error: StructuredOutputError }` on failure (no automatic retry for streaming — caller re-calls)

**Schema validation uses `ajv`** — already in `package.json` via agent-loop's `ToolRegistry`. No new dependency.

---

## Implementation Phases

### Phase 1: provider_options, Beta Headers & Thinking Signature (~20%)

**Files:** `src/llm/types.ts` (modify), `src/llm/adapters/anthropic.ts` (modify), `src/llm/adapters/openai.ts` (modify), `src/llm/adapters/gemini.ts` (modify), `test/llm/provider-options.test.ts` (create), `test/llm/thinking-signature.test.ts` (create)

**Tasks:**

- [ ] Define `ProviderOptions`, `AnthropicOptions`, `OpenAIOptions`, `GeminiOptions` types in `src/llm/types.ts`
- [ ] Add `provider_options?: ProviderOptions` to `GenerateRequest`
- [ ] Add `response_format?: ResponseFormat` to `GenerateRequest` (type-only; adapter wiring in Phase 2)
- [ ] Define `ResponseFormat` and `JsonSchemaDefinition` types in `src/llm/types.ts`
- [ ] Add `signature?: string` to the `thinking` variant in the `ContentPart` union
- [ ] Anthropic adapter — read `provider_options.anthropic.betas`, deduplicate, comma-join into `anthropic-beta` header
- [ ] Anthropic adapter — auto-inject `interleaved-thinking-2025-05-14` beta when `reasoning_effort` is set
- [ ] Anthropic adapter — extract `signature` from API response thinking blocks in `translateResponse()`
- [ ] Anthropic adapter — include `signature` when serializing thinking blocks in `translateRequest()`
- [ ] OpenAI adapter — merge `provider_options.openai` fields (`store`, `metadata`) into request body
- [ ] Gemini adapter — merge `provider_options.gemini.safety_settings` into request body
- [ ] All adapters — silently ignore unrecognized `provider_options` sections (don't throw)
- [ ] Tests:
  - Beta header: single beta, multiple betas, deduplication, auto-injected betas
  - Beta header present in both `generate()` and `stream()` requests
  - Thinking signature extracted from Anthropic response
  - Thinking signature included in Anthropic request (round-trip)
  - Multi-turn thinking conversation with signatures preserved
  - Backward compatible: missing signature causes no errors anywhere
  - OpenAI store/metadata merged correctly
  - Gemini safety_settings merged correctly
  - Unknown provider_options keys silently ignored

### Phase 2: Structured Output Across All Providers (~30%)

**Files:** `src/llm/adapters/anthropic.ts` (modify), `src/llm/adapters/openai.ts` (modify), `src/llm/adapters/gemini.ts` (modify), `src/llm/errors.ts` (modify), `test/llm/structured-output.test.ts` (create)

**Tasks:**

- [ ] Add `StructuredOutputError` to `src/llm/errors.ts` extending `LLMError`: holds `rawText`, `parseError`, `validationErrors`, `schema`
- [ ] **Anthropic `json_schema` mode:**
  - Inject `__structured_output` synthetic tool from caller's schema
  - Set `tool_choice: { type: "tool", name: "__structured_output" }`
  - On response: detect `__structured_output` tool call, extract `arguments` as JSON text
  - Rewrite: replace tool_use content part with `{ type: 'text', text: extractedJson }`
  - Set `stop_reason` to `end_turn`
  - Preserve caller's real tools alongside the synthetic tool
- [ ] **Anthropic `json` mode:** Same synthetic tool approach with permissive `{ type: "object" }` schema
- [ ] **Anthropic streaming structured output:** Handle `tool_call_delta` events for synthetic tool, rewrite `stream_end` message
- [ ] **OpenAI `json_schema`:** Set `text: { format: { type: "json_schema", name, schema, strict } }` on request body
- [ ] **OpenAI `json`:** Set `text: { format: { type: "json_object" } }` on request body
- [ ] **Gemini `json_schema`:** Set `generationConfig.responseMimeType = "application/json"` and `generationConfig.responseSchema = schema`
- [ ] **Gemini `json`:** Set `generationConfig.responseMimeType = "application/json"` (no schema constraint)
- [ ] Validate: `json_schema` without `json_schema.schema` throws `InvalidRequestError`
- [ ] Tests (per provider, using request body inspection — no live API calls):
  - Anthropic: synthetic tool injected with correct schema
  - Anthropic: forced tool_choice set to `__structured_output`
  - Anthropic: response rewritten from tool_use to text, stop_reason is `end_turn`
  - Anthropic: caller's tools preserved alongside synthetic tool
  - Anthropic: streaming tool_call deltas for synthetic tool accumulated and rewritten
  - OpenAI: `text.format` field set correctly for json_schema and json modes
  - Gemini: `responseMimeType` and `responseSchema` set correctly
  - All providers: `text` mode produces no changes to request
  - Missing schema on `json_schema` type throws `InvalidRequestError`

### Phase 3: generate_object() with Validation & Retry (~25%)

**Files:** `src/llm/structured.ts` (create), `src/llm/client.ts` (modify), `src/llm/simulation.ts` (modify), `test/llm/generate-object.test.ts` (create)

**Tasks:**

- [ ] Create `src/llm/structured.ts`:
  - `extractJsonText(response: GenerateResponse): string` — extract text content, handle edge cases (leading/trailing whitespace, markdown code fences)
  - `validateAgainstSchema(data: unknown, schema: Record<string, unknown>): { valid: boolean; errors: string[] }` — thin wrapper around `ajv.validate()`, importing `ajv` from existing dependency
  - `buildValidationRetryMessages(originalMessages: Message[], rawText: string, errors: string[]): Message[]` — append user message: `"Your previous response was not valid JSON matching the schema. Errors:\n{errors}\n\nPlease try again, responding with ONLY valid JSON."`
- [ ] Implement `UnifiedClient.generateObject<T>()`:
  - Require `request.response_format.type === 'json_schema'` (throw `InvalidRequestError` otherwise)
  - Call `generateUnified()` with the request
  - Extract JSON via `extractJsonText()`
  - `JSON.parse()` — on `SyntaxError`, treat as validation failure
  - `validateAgainstSchema()` — on failure, build retry messages and re-call (up to `max_validation_retries`, default 2)
  - On success: return `{ ...response, object: parsed as T, raw_text: rawJson }`
  - On final failure: throw `StructuredOutputError` with raw text, errors, and schema
  - Accumulate `Usage` across retries (sum input_tokens, output_tokens, etc.)
- [ ] Update `SimulationProvider`:
  - When `response_format` is `json_schema`: generate a minimal valid JSON object matching the schema (string → `""`, number → `0`, boolean → `false`, array → `[]`, object → recurse, required fields filled, optional fields omitted)
  - When `response_format` is `json`: return `{ "result": "simulated" }`
  - Include `signature` on thinking blocks when `reasoning_effort` is set
- [ ] Tests:
  - `generateObject()` with valid response returns typed object
  - `generateObject()` with malformed JSON retries and succeeds on second attempt
  - `generateObject()` with persistent invalid JSON exhausts retries and throws `StructuredOutputError`
  - `StructuredOutputError` contains `rawText`, `validationErrors`, and `schema`
  - Usage accumulated across retry attempts
  - Schema validation catches: missing required fields, wrong types, invalid enum values
  - SimulationProvider returns schema-valid JSON for `json_schema` requests
  - `generateObject()` without `json_schema` response_format throws `InvalidRequestError`
  - `extractJsonText()` handles markdown code fences, leading/trailing whitespace

### Phase 4: Anthropic Prompt Caching (~15%)

**Files:** `src/llm/adapters/anthropic.ts` (modify), `test/llm/anthropic-caching.test.ts` (create)

**Tasks:**

- [ ] Implement `injectCacheBreakpoints(body: Record<string, unknown>)`:
  - Breakpoint on last system prompt block (convert string system to array if needed)
  - Breakpoint on last tool definition
  - Breakpoint on second-to-last user message's last content block
  - Skip conversation-prefix breakpoint if fewer than 2 user messages
  - Total breakpoints capped at 3 (within Anthropic's 4-breakpoint limit, leaving 1 for caller override)
- [ ] Wire into `AnthropicAdapter.generate()` and `stream()`:
  - Active when `provider_options.anthropic.cache_control !== false`
  - Active by default (cache_control defaults to true for Anthropic)
  - Auto-add `prompt-caching-2024-07-31` to betas when caching is active
- [ ] Interaction with structured output: when both `response_format` and caching are active, the `__structured_output` synthetic tool participates in tool-array breakpoint selection (gets the breakpoint if it's the last tool)
- [ ] Tests:
  - Breakpoint on system prompt last block
  - String system prompt converted to array format for breakpoint
  - Breakpoint on last tool definition
  - Breakpoint on conversation prefix (second-to-last user message)
  - No prefix breakpoint for single-turn conversations
  - No breakpoints when `cache_control: false`
  - Empty tools → no tool breakpoint, no crash
  - Empty system → no system breakpoint, no crash
  - Caching beta auto-added to `anthropic-beta` header
  - Interaction: caching + structured output synthetic tool both applied
  - `cache_read_tokens` and `cache_write_tokens` present in Usage (existing behavior confirmed)

### Phase 5: stream_object() — Deferrable (~10%)

**Files:** `src/llm/structured.ts` (modify), `src/llm/client.ts` (modify), `src/llm/types.ts` (modify), `test/llm/stream-object.test.ts` (create)

**Tasks:**

- [ ] Define `StreamObjectEvent<T>` types:
  - `{ type: 'partial'; text_so_far: string }` — emitted on each text delta
  - `{ type: 'object'; object: T; raw_text: string; usage: Usage }` — emitted on stream completion
  - `{ type: 'error'; error: StructuredOutputError }` — emitted on parse/validation failure
- [ ] Implement `UnifiedClient.streamObject<T>()`:
  - Call `stream()` with `response_format`
  - Accumulate text deltas in a buffer
  - Yield `partial` events on each content delta
  - On `stream_end`: extract JSON text, parse, validate against schema
  - On success: yield `object` event with validated object and usage
  - On failure: yield `error` event (no automatic retry for streaming — caller must re-invoke)
- [ ] Tests:
  - Stream accumulates text and yields partial events with cumulative text
  - Stream end with valid JSON yields object event with correct type
  - Stream end with invalid JSON yields error event with StructuredOutputError
  - Empty stream yields error event
  - Anthropic streaming: synthetic tool deltas accumulated and rewritten before validation

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/types.ts` | Modify | `ProviderOptions`, `ResponseFormat`, `JsonSchemaDefinition` types; `signature` on thinking ContentPart; `provider_options` and `response_format` on `GenerateRequest` |
| `src/llm/structured.ts` | Create | `extractJsonText()`, `validateAgainstSchema()`, `buildValidationRetryMessages()` — structured output utilities |
| `src/llm/client.ts` | Modify | `generateObject<T>()` and `streamObject<T>()` methods on `UnifiedClient` |
| `src/llm/errors.ts` | Modify | `StructuredOutputError` class with `rawText`, `validationErrors`, `schema` |
| `src/llm/simulation.ts` | Modify | Respect `response_format`, generate schema-valid simulation responses, thinking signatures |
| `src/llm/adapters/types.ts` | No change | `ProviderAdapter` interface unchanged — new fields pass through `GenerateRequest` |
| `src/llm/adapters/anthropic.ts` | Modify | Beta headers (L11), thinking signature (L2), synthetic tool structured output (L4), cache breakpoints (L10) |
| `src/llm/adapters/openai.ts` | Modify | `provider_options` merge (L20), `text.format` structured output (L4) |
| `src/llm/adapters/gemini.ts` | Modify | `provider_options` merge (L20), `responseMimeType`/`responseSchema` structured output (L4) |
| `test/llm/provider-options.test.ts` | Create | provider_options passthrough, beta header, and provider merge tests |
| `test/llm/thinking-signature.test.ts` | Create | Thinking block signature round-trip tests |
| `test/llm/structured-output.test.ts` | Create | Per-provider ResponseFormat translation (request body assertions) |
| `test/llm/generate-object.test.ts` | Create | generateObject lifecycle: success, retry, exhaustion, schema validation |
| `test/llm/anthropic-caching.test.ts` | Create | Cache breakpoint injection, disable, edge cases, interaction with structured output |
| `test/llm/stream-object.test.ts` | Create | streamObject accumulation, validation, error handling |

---

## Definition of Done

### Build & Regression
- [ ] `npm run build` succeeds with zero errors on a clean checkout
- [ ] `npm test` passes all existing tests — zero regressions
- [ ] Existing `generateUnified()` and `stream()` behavior unchanged when new fields are absent

### provider_options (L20)
- [ ] `provider_options` field accepted on `GenerateRequest`
- [ ] Each adapter reads only its own section
- [ ] Unknown provider sections silently ignored
- [ ] Options pass through `UnifiedClient` to the resolved adapter

### Anthropic Beta Headers (L11)
- [ ] `provider_options.anthropic.betas` injects `anthropic-beta` header
- [ ] Multiple betas comma-joined and deduplicated
- [ ] Feature-required betas auto-added (thinking, caching)
- [ ] Beta header present in both `generate()` and `stream()` requests
- [ ] Absent/empty betas produce no header

### ThinkingData.signature (L2)
- [ ] `signature?: string` on thinking ContentPart
- [ ] Anthropic adapter extracts `signature` from response thinking blocks
- [ ] Anthropic adapter sends `signature` back in request thinking blocks
- [ ] Multi-turn thinking conversations work (signature round-trip verified)
- [ ] Backward compatible: absent signature causes no errors

### Structured Output (L4)
- [ ] `ResponseFormat` type with `text`, `json`, `json_schema` modes
- [ ] **Anthropic:** synthetic `__structured_output` tool, response rewritten to text, `stop_reason` = `end_turn`
- [ ] **Anthropic streaming:** synthetic tool deltas accumulated and rewritten
- [ ] **OpenAI:** `text.format` mapped correctly for both modes
- [ ] **Gemini:** `responseMimeType` + `responseSchema` mapped correctly
- [ ] **Gemini:** graceful degradation for schemas exceeding Gemini's JSON Schema subset
- [ ] Caller's existing tools preserved when both `tools` and `response_format` specified
- [ ] `json_schema` without `schema` throws `InvalidRequestError`
- [ ] `generateObject<T>()` returns validated typed object
- [ ] `generateObject<T>()` retries on parse/validation failure (default 2 retries)
- [ ] `generateObject<T>()` throws `StructuredOutputError` when retries exhausted
- [ ] `StructuredOutputError` contains `rawText`, `validationErrors`, and `schema`
- [ ] `streamObject<T>()` accumulates and validates on stream completion (deferrable)
- [ ] `SimulationProvider` generates schema-valid responses for testing

### Anthropic Prompt Caching (L10)
- [ ] Cache breakpoints injected on system prompt, tool definitions, and conversation prefix
- [ ] Caching active by default for Anthropic
- [ ] `provider_options.anthropic.cache_control = false` disables injection
- [ ] Breakpoint count ≤ 3 (within Anthropic limit)
- [ ] String system prompts converted to array format when needed
- [ ] `cache_read_tokens` and `cache_write_tokens` reported in `Usage`
- [ ] Caching beta auto-added to `anthropic-beta` header

### Test Coverage
- [ ] At least 45 new test cases across all phases
- [ ] Each adapter tested for every `ResponseFormat` mode (request body assertions, no live API calls)
- [ ] Schema validation: valid data, missing fields, wrong types, nested objects, enum values
- [ ] Thinking signature round-trip through Anthropic adapter
- [ ] Caching + structured output interaction tested
- [ ] generateObject retry loop tested end-to-end against SimulationProvider

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Anthropic synthetic-tool pattern breaks with future API changes** | Low | High | This is Anthropic's own recommended pattern, used by their Python SDK. If they ship native `response_format`, swap adapter internals without changing the unified API. |
| **Structured output + existing tools interaction** | Medium | Medium | Clear rule: `__structured_output` is additive. Forced `tool_choice` ensures the model calls the structured output tool, not a caller tool. After extraction, caller tools remain. Document and test the interaction. |
| **Cache breakpoints on short content waste cache writes** | Medium | Low | Always inject on system/tools (almost always above Anthropic's min-token threshold). Skip conversation prefix for short conversations. Cache write cost is negligible ($3.75/MTok write vs $0.30/MTok read savings at 10× cheaper read rate). |
| **Gemini's `responseSchema` has JSON Schema subset restrictions** | Medium | Medium | Gemini doesn't support `$ref`, complex `anyOf`, or `additionalProperties`. Document per-provider schema restrictions. For complex schemas, degrade gracefully to `json` mode + prompt instruction. |
| **Thinking signature format changes upstream** | Low | Medium | Signature is treated as an opaque string — stored and returned without inspection. Format changes don't break the code; integration tests catch behavioral changes. |
| **`ajv` import increases LLM client bundle size** | Low | Low | `ajv` is already in the dependency tree. The LLM client imports it for schema validation in `generateObject()` only — not at module load. Tree-shaking eliminates it from non-structured-output paths. |
| **generateObject retry costs more tokens** | Medium | Medium | Default 2 retries maximum. Retry messages are short (error context only). The alternative — letting callers deal with invalid JSON — costs more in developer time and pipeline failures. |
| **OpenAI Responses API format differs from Chat Completions** | Low | High | Responses API uses `text.format` (not `response_format`). Test with request body snapshots. If format is wrong, it fails loudly on first test. |

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `UnifiedClient` + 3 adapters | Integration target for all changes | Implemented |
| `GenerateRequest` / `GenerateResponse` types | Extended with new fields | Implemented |
| `ContentPart` union type | Extended with signature field | Implemented |
| `Usage` type with cache metrics | Already reports cache_read/write_tokens | Implemented |
| `GenerateRequest.cache_control` field | Already defined on type (unused at adapter level until now) | Implemented |
| `StreamEvent` types + `parseSSEStream` | Used by streaming structured output | Implemented |
| `LLMError` hierarchy | Extended with StructuredOutputError | Implemented |
| `SimulationProvider` | Updated for structured output testing | Implemented |
| `ajv` | JSON Schema validation in generateObject | Already in dependency tree (via agent-loop/ToolRegistry) |
| `vitest` | Testing framework | Implemented |

**Zero new npm dependencies.** `ajv` is already in `package.json`. All work extends existing types and adapters.

---

## Gap Closure Summary

| Gap | Description | Severity | Status After Sprint |
|-----|-------------|----------|-------------------|
| L2  | ThinkingData.signature for Anthropic round-trips | **Medium** | **Closed** |
| L4  | ResponseFormat + generate_object() + stream_object() | **Medium** | **Closed** |
| L10 | Anthropic prompt caching with auto cache_control injection | **Medium** | **Closed** |
| L11 | Anthropic beta header passthrough | **Medium** | **Closed** |
| L20 | provider_options escape hatch on GenerateRequest | **Medium** | **Closed** |

**5 Medium = 5 gaps closed.**

**After this sprint:**
- LLM client: 20 gaps → 15 (25% reduction)
- Medium severity across all specs: 11 → 6
- Remaining LLM mediums: L7 (middleware), L8 (model catalog), L9 (high-level generate) — SDK conveniences, none blocking product features
- **Swarm Intelligence is unblocked** by structured output + generate_object() (L4)
- **Codergen cost drops ~90%** for repetitive prompt prefixes on Anthropic (L10)
- **Multi-turn thinking works correctly** for the first time (L2 + L11)

**Recommended next sprint (015):**
- A4/A5 (Context fidelity runtime + thread resolution) — highest-impact attractor engine gaps, now that L2 ensures correct `full` fidelity thread reuse with Anthropic thinking. The Codex draft's architecture for this work is excellent and should be used largely as-is.
- Alternatively: Seedbed foundation + Swarm Intelligence implementation (now unblocked by L4)
