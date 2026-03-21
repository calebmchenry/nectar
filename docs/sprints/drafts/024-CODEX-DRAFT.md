# Sprint 024: Attachment-Native Swarm Analysis and LLM Failure Policies

## Overview

**Goal:** Make Nectar's seedbed analysis trustworthy when a seed includes real attachments. After this sprint, `POST /seeds/:id/analyze` can pass document and audio inputs through the unified LLM layer when supported, skip them visibly when not, and terminate with explicit timeout/quota/stream failures instead of generic "analysis failed" output.

**Why this sprint, why now:**

1. **The biggest remaining product gap is not another graph feature.** `docs/INTENT.md` makes the seedbed and swarm analysis core to Nectar, and explicitly calls out screenshots, videos, files, and links as first-class inputs. Today `src/runtime/swarm-analysis-service.ts` only inlines text excerpts and images. PDFs and audio are effectively invisible to the swarm.

2. **The most impactful compliance gaps are all in the same slice.** `docs/compliance-report.md` shows three LLM gaps that directly affect attachment-rich analysis:
   - GAP-1: AUDIO and DOCUMENT content parts
   - GAP-3: `QuotaExceededError` and `StreamError`
   - GAP-8: structured `TimeoutConfig`

3. **Silent degradation is worse than explicit limitation.** Nectar can survive a provider not supporting a media type. It cannot be trusted if it silently ignores attachments or hangs forever on a stalled stream.

4. **This is one sprint, not a platform rewrite.** The sprint focuses on the existing first-party consumers that matter now: swarm analysis first, garden drafting second. It does not attempt OCR, speech-to-text, video understanding, or partial-object UI streaming.

**Gaps closed:**

| Gap | Source | Why it matters now |
|-----|--------|--------------------|
| GAP-1: AUDIO and DOCUMENT content types | unified-llm-spec §3.3-3.4 | Seedbed attachments are a core Nectar promise; PDF/audio inputs currently disappear before they reach the model |
| GAP-3: `QuotaExceededError`, `StreamError` | unified-llm-spec §6.1 | Users need to distinguish retryable transport issues from non-retryable billing exhaustion |
| GAP-8: structured `TimeoutConfig` | unified-llm-spec §4.7 | Drafting and swarm analysis need bounded latency instead of a single blunt timeout or indefinite wait |

**Deliberately deferred:**

- GAP-2: Gemini `read_many_files` / `list_dir`
- GAP-4: named retry preset policies
- GAP-5: fuzzy `edit_file` matching
- GAP-6: reasoning start/delta/end lifecycle
- GAP-7: incremental JSON parsing in `streamObject()`

Those are real gaps, but they do not unblock Nectar's attachment-heavy swarm workflow this sprint.

**Out of scope:**

- Video transcription, OCR, PDF text extraction, or speech-to-text
- New seed lifecycle states in `meta.yaml`
- New CLI commands
- New Hive views or layout work
- Changing the analysis body contract (`Summary`, `Implementation Approach`, `Risks`, `Open Questions`)

**Cut line:** If the sprint compresses, cut Hive warning polish before cutting content-part support, timeout enforcement, or machine-readable failure codes. The load-bearing deliverable is honest analysis behavior, not nicer badges.

---

## Use Cases

1. **Analyze a seed with a PRD PDF, a screenshot, and a voice memo.** The swarm passes every supported attachment type to each provider, records which files were included versus skipped, and writes that record into `analysis/{provider}.md`.

2. **Skip unsupported media visibly.** A seed contains `demo.mov` and `archive.zip`. Nectar keeps the files on disk, but the provider analysis records them as skipped with warning codes instead of pretending they were analyzed.

3. **Quota exhaustion stops immediately and clearly.** Codex/OpenAI hits a hard billing or usage quota. Nectar marks that provider result as `failed`, writes `failure_code: quota_exceeded`, does not retry, and still lets Claude and Gemini complete.

4. **Stalled streams fail fast.** A provider opens a stream and then stops sending events. Nectar raises `StreamError` after the configured idle timeout, closes the request, and persists a specific failure reason instead of hanging the Hive.

5. **Garden drafting gets bounded latency.** `POST /gardens/draft` uses a short timeout policy suited to interactive editing. The request either completes quickly or fails with a draft error the browser can surface immediately.

6. **Empty-body attachment-only seeds are handled honestly.** If a seed has no body text and every attachment is unsupported for a provider, Nectar writes a `skipped` analysis document explaining why rather than generating a fake summary from nothing.

---

## Architecture

### Design Principles

1. **Attachments are first-class model input, not markdown decoration.** If a file is used for analysis, it must exist as a typed `ContentPart`, not only as a filename mentioned in prompt text.

2. **Provider capability differences are resolved before dispatch.** Swarm analysis should know whether a provider can accept `image`, `document`, or `audio` parts before calling the adapter. Expected incompatibilities become warnings, not surprise runtime failures.

3. **No silent drops.** Every attachment ends up in exactly one bucket per provider: included, skipped, or unsupported. The result must be machine-readable.

4. **Timeouts are layered.** The LLM layer needs separate control for total operation time, per-call time, connection establishment, and stream idle time.

5. **Failure reasons are durable.** The file system is Nectar's API. If a provider times out or exhausts quota, that reason belongs in `analysis/{provider}.md`, not only in console output or transient logs.

6. **Backward compatibility matters.** Existing analysis documents, existing `timeout_ms` callers, and existing image/text behavior must keep working.

### Unified LLM Contract

Extend `src/llm/types.ts` so the request model can express the attachment kinds Nectar actually needs:

```ts
type AudioSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

type DocumentSource =
  | { type: 'base64'; media_type: string; data: string; file_name?: string }
  | { type: 'url'; url: string; file_name?: string };

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'audio'; source: AudioSource }
  | { type: 'document'; source: DocumentSource }
  | ...
```

Add structured timeouts to `GenerateRequest`:

```ts
interface TimeoutConfig {
  total?: number;      // milliseconds for the whole high-level operation
  per_step?: number;   // milliseconds per individual provider call
}
```

Keep `timeout_ms` as a deprecated alias for one sprint so existing internal callers do not break. Public Nectar code should migrate to `timeout`.

### Adapter Timeout Policy

Add one shared timeout helper module in `src/llm/timeouts.ts`. It should be the only place that composes abort signals and adapter-level timeouts.

Default adapter limits:

- `connect = 10_000`
- `request = 120_000`
- `stream_read = 30_000`

Opinionated first-party defaults:

- `GardenDraftService`: `timeout = { total: 30_000, per_step: 20_000 }`
- `SwarmAnalysisService`: `timeout = { total: 180_000, per_step: 90_000 }`

The retry middleware must respect the total timeout budget. If the total budget is spent, the high-level call fails immediately instead of starting another retry.

### Error Taxonomy

Extend `src/llm/errors.ts` with:

- `QuotaExceededError`
  - non-retryable
  - used when the provider indicates billing/usage quota exhaustion rather than transient rate limiting
- `StreamError`
  - retryable only when no response content has been yielded yet
  - carries the stream phase (`transport`, `sse_parse`, `idle_timeout`) and a bounded partial text preview when available

Do not invent new seed-level states for this sprint. `analysis_status` stays `pending | running | complete | failed | skipped`. Richer failure detail lives in the analysis document metadata.

### Attachment Capability Matrix

Move attachment classification into `src/seedbed/attachments.ts` so the runtime and the HTTP layer stop maintaining separate MIME/type logic.

Introduce:

```ts
type AttachmentKind = 'text' | 'image' | 'document' | 'audio' | 'video' | 'binary';

interface AttachmentDescriptor {
  filename: string;
  absolute_path: string;
  size: number;
  content_type: string;
  kind: AttachmentKind;
}

interface AttachmentCapabilities {
  image: boolean;
  document: boolean;
  audio: boolean;
}
```

Rules:

- `text`: keep the current excerpt-based path
- `image`: keep the current inline-image path
- `document`: native `document` content part when supported; otherwise skip with warning
- `audio`: native `audio` content part when supported; otherwise skip with warning
- `video`: always skip this sprint with a warning
- `binary`: always skip this sprint with a warning

No provider adapter may silently ignore `audio` or `document` parts. It must either translate them natively or reject them explicitly with `InvalidRequestError`. Swarm analysis should avoid expected adapter rejections by consulting the provider capability matrix before dispatch.

### Swarm Attachment Planning

`src/runtime/swarm-analysis-service.ts` should build an explicit attachment plan per provider before calling `generateObject()`:

```ts
interface AttachmentPlan {
  parts: ContentPart[];
  included: string[];
  skipped: string[];
  warnings: Array<{ code?: string; message: string }>;
}
```

Behavior:

- If the seed body is non-empty, analysis can proceed even when some attachments are skipped.
- If the seed body is empty and `included.length === 0`, write a `skipped` analysis document instead of making a model call.
- If attachments exceed conservative size caps, skip them with warnings instead of trying to squeeze them into prompt text.
- Warning messages must mention the filename and the reason.

### Analysis Document Contract

Extend `src/seedbed/analysis-document.ts` with optional front matter fields:

```yaml
failure_code: quota_exceeded
warnings:
  - code: attachment_skipped
    message: "Skipped voice-note.m4a for claude: provider does not support audio input."
attachments_considered:
  included: [spec.pdf, mockup.png]
  skipped: [voice-note.m4a, demo.mov]
```

These fields are optional and must not break old analysis files. The parser should accept documents with or without them.

### Hive Surfacing

Keep the Hive changes small and factual:

- `SeedDetail` shows attachment kind badges (`image`, `document`, `audio`, `video`, `binary`)
- `SwarmCompare` shows:
  - machine-readable failure code
  - warnings
  - a short included/skipped attachment summary

No new panels, no redesign, no extra views.

---

## Implementation phases

### Phase 1: LLM Contract and Timeout Plumbing (~30%)

**Files:** `src/llm/types.ts`, `src/llm/errors.ts`, `src/llm/client.ts`, `src/llm/retry.ts`, `src/llm/streaming.ts`, `src/llm/timeouts.ts`, `test/llm/client.test.ts`, `test/llm/stream-object.test.ts`, `test/llm/timeouts.test.ts`

**Tasks:**

- [ ] Add `audio` and `document` variants to `ContentPart`
- [ ] Add public `TimeoutConfig` support on `GenerateRequest`
- [ ] Preserve `timeout_ms` as a temporary compatibility alias
- [ ] Create one shared timeout helper for total/per-step/connect/request/stream-read handling
- [ ] Enforce total timeout across `generateObject()` validation retries instead of resetting the clock each attempt
- [ ] Raise `StreamError` for idle stream reads and malformed SSE payloads
- [ ] Add `QuotaExceededError` and classify it as non-retryable
- [ ] Ensure retry middleware never retries `QuotaExceededError`
- [ ] Add unit tests for:
  - `timeout` object parsing
  - total timeout exhaustion across multiple attempts
  - idle stream timeout behavior
  - retryability classification for quota vs rate limit

### Phase 2: Provider Adapters and Media Translation (~30%)

**Files:** `src/llm/adapters/openai.ts`, `src/llm/adapters/anthropic.ts`, `src/llm/adapters/gemini.ts`, `src/llm/adapters/openai-compatible.ts`, `src/llm/simulation.ts`, `test/llm/adapters/openai.test.ts`, `test/llm/adapters/anthropic.test.ts`, `test/llm/adapters/gemini.test.ts`, `test/llm/openai-compatible.test.ts`

**Tasks:**

- [ ] Implement native translation for `audio` and `document` where the adapter supports it
- [ ] For unsupported adapters, reject `audio` / `document` explicitly instead of dropping them
- [ ] Detect quota exhaustion separately from transient 429 rate limiting
- [ ] Wrap abrupt transport failures and malformed streaming payloads as `StreamError`
- [ ] Keep image and tool-call behavior unchanged
- [ ] Update the simulation adapter so the new content kinds are accepted in tests and local fallback flows
- [ ] Add adapter tests for:
  - document request accepted or explicitly rejected
  - audio request accepted or explicitly rejected
  - quota error classification
  - stream parse failure classification

### Phase 3: Swarm Analysis Adoption and Analysis Metadata (~25%)

**Files:** `src/seedbed/attachments.ts`, `src/runtime/swarm-analysis-service.ts`, `src/seedbed/analysis-document.ts`, `src/server/routes/seeds.ts`, `test/runtime/swarm-analysis-service.test.ts`, `test/server/seeds-analyze.test.ts`, `test/seedbed/analysis-document.test.ts`

**Tasks:**

- [ ] Consolidate attachment kind and MIME detection into `src/seedbed/attachments.ts`
- [ ] Extend the seed attachment API payload with `kind`; keep `is_image` for compatibility this sprint
- [ ] Build per-provider attachment plans with `included`, `skipped`, and `warnings`
- [ ] Continue inlining text excerpts and images exactly as today
- [ ] Add native document/audio parts to swarm requests when allowed by the provider capability matrix
- [ ] Skip video/binary attachments with explicit warnings
- [ ] Write `failure_code`, `warnings`, and `attachments_considered` into `analysis/{provider}.md`
- [ ] If no analyzable input remains for a provider, write a `skipped` analysis document instead of making a model call
- [ ] Preserve existing analysis section headings and existing `analysis_status` values
- [ ] Add runtime/server tests for:
  - PDF attachment included
  - audio attachment included or skipped deterministically
  - video attachment skipped with warning
  - empty-body / unsupported-attachments-only seed becomes `skipped`
  - failure code persisted for quota and timeout cases

### Phase 4: First-Party Consumer Adoption and Hive Surfacing (~15%)

**Files:** `src/runtime/garden-draft-service.ts`, `hive/src/lib/api.ts`, `hive/src/components/SeedDetail.ts`, `hive/src/components/SwarmCompare.ts`, `test/server/gardens-draft.test.ts`, `test/integration/hive-seedbed-flow.test.ts`

**Tasks:**

- [ ] Migrate `GardenDraftService` to explicit `TimeoutConfig`
- [ ] Surface draft timeout/stream failures as precise `draft_error` payloads
- [ ] Update Hive API types for attachment `kind`, analysis `failure_code`, `warnings`, and `attachments_considered`
- [ ] Show attachment kind badges in `SeedDetail`
- [ ] Show failure code and warnings in `SwarmCompare`
- [ ] Show a short "used X / skipped Y attachments" summary in each analysis card
- [ ] Add one end-to-end Hive test proving the UI surfaces skipped-attachment warnings instead of hiding them

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/types.ts` | Modify | Add `audio` / `document` content parts and public `TimeoutConfig` |
| `src/llm/errors.ts` | Modify | Add `QuotaExceededError` and `StreamError` |
| `src/llm/timeouts.ts` | Create | Centralize total/per-step/connect/request/stream-read timeout handling |
| `src/llm/client.ts` | Modify | Thread structured timeouts through `generateObject()`, `stream()`, and `streamObject()` |
| `src/llm/retry.ts` | Modify | Respect total timeout budget and new retryability rules |
| `src/llm/streaming.ts` | Modify | Convert malformed or stalled streams into explicit `StreamError`s |
| `src/llm/adapters/openai.ts` | Modify | Translate or reject document/audio parts and classify quota failures |
| `src/llm/adapters/anthropic.ts` | Modify | Translate or reject document/audio parts and classify stream failures |
| `src/llm/adapters/gemini.ts` | Modify | Translate or reject document/audio parts and classify quota/stream failures |
| `src/llm/adapters/openai-compatible.ts` | Modify | Reject unsupported document/audio parts explicitly and improve error mapping |
| `src/llm/simulation.ts` | Modify | Accept new content kinds in tests and fallback mode |
| `src/seedbed/attachments.ts` | Modify | Become the shared source of truth for attachment kind + content type detection |
| `src/runtime/swarm-analysis-service.ts` | Modify | Build provider-specific attachment plans and persist warnings/failure codes |
| `src/seedbed/analysis-document.ts` | Modify | Parse/render new optional front matter fields |
| `src/server/routes/seeds.ts` | Modify | Return attachment `kind` and consume shared attachment metadata |
| `src/runtime/garden-draft-service.ts` | Modify | Adopt explicit timeouts for interactive drafting |
| `hive/src/lib/api.ts` | Modify | Extend seed and analysis types with attachment/error metadata |
| `hive/src/components/SeedDetail.ts` | Modify | Show attachment kind badges |
| `hive/src/components/SwarmCompare.ts` | Modify | Show warnings, failure code, and attachment inclusion summary |
| `test/llm/timeouts.test.ts` | Create | Lock timeout behavior and retry-budget semantics |
| `test/llm/adapters/*.test.ts` | Modify | Lock document/audio support and failure taxonomy |
| `test/runtime/swarm-analysis-service.test.ts` | Modify | Verify attachment planning and persisted warnings |
| `test/server/seeds-analyze.test.ts` | Modify | Verify server contract for richer analysis metadata |
| `test/seedbed/analysis-document.test.ts` | Modify | Verify backward-compatible front matter parsing |
| `test/server/gardens-draft.test.ts` | Modify | Verify draft timeout/stream failure payloads |
| `test/integration/hive-seedbed-flow.test.ts` | Modify | Verify skipped-attachment warnings are visible in the Hive |

---

## Definition of Done

- [ ] `src/llm/types.ts` supports `audio` and `document` content parts without breaking existing text/image callers
- [ ] `GenerateRequest` accepts `timeout: number | TimeoutConfig`; existing `timeout_ms` callers still work for one sprint
- [ ] Every adapter either translates `audio` / `document` parts or rejects them explicitly; none silently omit them
- [ ] `QuotaExceededError` exists, is non-retryable, and is covered by tests
- [ ] `StreamError` exists, is raised for stalled or malformed streams, and includes bounded partial context when available
- [ ] Retry middleware does not retry `QuotaExceededError`
- [ ] High-level LLM calls respect total timeout across retries/validation attempts instead of resetting per attempt
- [ ] `SwarmAnalysisService` records `included`, `skipped`, and `warnings` per provider
- [ ] `analysis/{provider}.md` can include `failure_code`, `warnings`, and `attachments_considered` front matter
- [ ] Old analysis documents without the new fields still parse successfully
- [ ] `GET /seeds/:id` returns attachment `kind`; `is_image` remains present this sprint for compatibility
- [ ] A provider with no analyzable input for a seed returns `skipped`, not `complete`
- [ ] PDF/audio/image/text attachments are handled deterministically in swarm tests
- [ ] Video and binary attachments are surfaced as skipped warnings, not silently dropped
- [ ] `GardenDraftService` uses explicit timeout defaults suitable for interactive use
- [ ] Hive seed detail surfaces attachment kinds and analysis warnings/failure codes
- [ ] `npm run build` passes
- [ ] `npm test` passes

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Provider support for document/audio input is inconsistent | High | High | Centralize capability flags; require explicit include or explicit rejection; never silently drop |
| Timeout layers fight each other and produce confusing aborts | Medium | High | Put all timeout composition in one helper module and test total/per-step/stream-idle interactions directly |
| Large attachments exceed provider body limits | High | Medium | Use conservative size caps, skip with warnings, and record what was omitted |
| Backward-compatible parsing of old analysis docs regresses | Low | Medium | Keep all new front matter fields optional and add parser round-trip tests for legacy docs |
| Hive UI implies a provider analyzed a file when it was actually skipped | Medium | High | Render included/skipped data from `analysis/{provider}.md`, not from client-side heuristics |
| Empty-body seeds with unsupported attachments produce nonsense analyses | Medium | Medium | Short-circuit to `skipped` before model dispatch when no usable input remains |
| Stream idle timeout is too aggressive for slower providers | Medium | Medium | Keep adapter-level defaults centralized and overridable; reset idle timer on any SSE frame, not only text deltas |

---

## Dependencies

- Existing unified LLM stack in `src/llm/`
- Existing provider adapter tests in `test/llm/adapters/`
- Existing swarm pipeline in `src/runtime/swarm-analysis-service.ts`
- Existing analysis file parser in `src/seedbed/analysis-document.ts`
- Existing seed routes and Hive seed detail surfaces
- Existing `yaml` dependency already used for analysis front matter

No new third-party runtime dependency is required for this sprint. MIME/type classification should stay in-repo and deterministic.
