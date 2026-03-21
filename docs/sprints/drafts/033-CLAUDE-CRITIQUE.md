# Sprint NEXT Critique — Claude

**Reviewer:** Claude
**Date:** 2026-03-21
**Drafts reviewed:** `NEXT-CODEX-DRAFT.md` ("Codex"), `NEXT-GEMINI-DRAFT.md` ("Gemini")

---

## Preamble

This critique evaluates the two draft sprint plans against the current `docs/compliance-report.md` and the repo layout under `src/` and `test/`. The Codex draft is the stronger foundation overall. It has the clearer product story, the better subsystem boundaries, and the more executable Definition of Done. The Gemini draft is useful as a compliance checklist, but it reads more like "close everything still open in the report" than "ship the next safest, highest-value sprint."

The most important difference is that Codex is organized around the Hive-facing runtime contract, while Gemini is organized around spec section and gap ID. For the next sprint, the runtime-contract framing is the better spine. The compliance-checklist framing is still valuable, but as a secondary filter, not the primary plan.

Both drafts would improve with a short Phase 0 audit before implementation begins. The branch is active, and neither draft should assume the compliance report alone is a perfect description of what is still open or what is already partially in flight.

---

## Codex Draft

### Strengths

1. **Best product cut.** The draft is centered on a coherent user-facing outcome: make the localhost runtime truthful enough for Hive consumers to trust. That is a much better sprint thesis than "close everything still open."

2. **Strong alignment with the current ownership boundaries.** The proposed work lands in the files that actually own these behaviors today: `src/server/run-manager.ts`, `src/server/question-store.ts`, `src/server/http-interviewer.ts`, `src/server/routes/seeds.ts`, `src/runtime/garden-draft-service.ts`, `src/garden/validate.ts`, and `src/llm/adapters/gemini.ts`. This is especially strong in two places:
   - `src/server/question-store.ts` currently collapses pending questions to `timed_out` on `close()`, so the draft is targeting a real interruption-state bug, not an invented abstraction.
   - `src/server/routes/seeds.ts` still owns route-local run subscription state, so the proposed `SeedRunBridge` is a believable extraction rather than architecture tourism.

3. **Behavior-first use cases.** The use cases are phrased in terms of real HTTP flows and observable disk state: `POST /pipelines`, `GET /pipelines/:id`, `POST /seeds/:id/run`, `activity.jsonl`, `meta.yaml`, and `POST /gardens/draft`. That makes the sprint testable and keeps it anchored in contract behavior rather than spec prose.

4. **The most implementation-ready phase plan.** Each phase names the intended file set, the main behavioral outcome, and the test surfaces that should prove it. The phases also follow a sensible dependency order: live state, then human-gate semantics, then seed linkage, then validation/drafting, then the small Gemini adapter cleanup.

5. **The strongest Definition of Done.** The DoD is mostly falsifiable behavior, not just report bookkeeping. It includes build/test gates, anti-cheating language ("No test timeout values were increased"), and specific route/file assertions.

### Weaknesses

1. **It is still a large sprint despite having good focus.** There are effectively five substantial workstreams here: live run truth, question lifecycle, seed lifecycle, validation/authoring, and Gemini normalization. The theme is coherent, but the execution surface is still broad.

2. **The sprint does not clearly declare its drop line if schedule slips.** The first four phases all feel important once the thesis is "runtime truth." The merged sprint should say explicitly what gets cut first if the sprint starts running long. Right now that answer is implied, not stated.

3. **Backward compatibility is only partially specified.** The draft mentions backward-compatible question deserialization, which is good, but it is lighter on the compatibility story for:
   - existing multi-exit gardens already saved on disk
   - older `activity.jsonl` / `meta.yaml` histories
   - restart/resume behavior when question or seed files were written before the new semantics

4. **`U19` is overrepresented relative to its size.** The Gemini `RECITATION` mapping is worth fixing, but as written it gets an entire phase and part of the sprint narrative even though it is much smaller than the runtime and filesystem work. It should stay in scope, but as a close-out item, not as one of the pillars of the sprint.

5. **The HTTP contract definition is slightly narrower than it should be.** The draft is excellent on polling routes and filesystem truth, but it says less about whether `/events` and SSE delivery are part of the same "runtime truth" promise. If the Hive depends on event streams as well as GET endpoints, the merged sprint should say so explicitly.

### Gaps in Risk Analysis

1. **No branch/report drift risk.** The draft assumes the current report is the right source of truth for scope selection. A short revalidation step should be treated as a risk mitigation, not as optional hygiene.

2. **No explicit restart/recovery risk.** The draft covers cancel/resume well, but not the harder case where the server exits between those transitions and the next process must reconstruct truthful question and seed state from disk.

3. **No race-condition risk across cancel, answer, resume, and polling.** The draft discusses state semantics, but not the possibility of cross-route races: stale answer submissions, resume happening while a cancellation write is still in flight, or a GET endpoint reading between live overlay and persistence updates.

4. **Failure-path idempotency is underweighted.** The risks mention `run_started`, `run_resumed`, `run_interrupted`, and `run_completed`, but the same exact-once scrutiny should be applied to `run_failed` and `run_error`, especially if the sprint is touching terminal state sequencing.

5. **No migration risk for existing user gardens.** Enforcing single-exit is correct, but there is no explicit risk entry for already-authored multi-exit gardens and examples suddenly becoming invalid in preview/save/run flows.

### Missing Edge Cases

1. A user answers a pending question at nearly the same time another client cancels the run. The merged plan should define which transition wins and what the loser sees.

2. The server restarts after a run is interrupted at `wait.human` but before resume. The next process should not reinterpret that question as timed out or pending forever.

3. A seed-linked run fails instead of completing. The draft's DoD is strong on the start/interrupted/resumed/completed path, but it should also prove exact-once `run_failed` behavior and stable `meta.yaml.linked_runs` on failure.

4. A drafted or composed garden has one imported exit plus two root exits, or zero root exits but several imported exits. The draft mentions composition, but this specific root-vs-imported exit counting edge should be called out.

5. Existing saved gardens with multiple exits are opened through preview/run after the rule change. The system should fail honestly and diagnostically, not silently rewrite or partially accept them.

6. The model returns invalid DOT for draft generation in multiple ways: parse failure, zero exits, two exits, or one exit with outgoing edges. These should not all collapse into the same vague `draft_error`.

### Definition of Done Completeness

The Codex DoD is the stronger one by a wide margin. It is behavioral, testable, and mapped to the user-visible contract. That said, it should still be tightened in a few places:

1. Add an explicit restart/recovery assertion for interrupted questions and linked runs loaded from disk.

2. Add a failure-path exact-once assertion for `run_failed` / `run_error`, not just the successful completion path.

3. If SSE is part of the Hive contract, add an assertion that `/events` stays consistent with the same live-state truth promised by `GET /pipelines/:id`, `/context`, and `/graph`.

4. Strengthen the Gemini item so it explicitly requires both non-streaming and streaming `RECITATION -> content_filter` coverage. The phase text says this; the DoD should say it too.

5. Add a compatibility assertion that older question records and older seed activity histories still load safely after the schema/semantic changes.

---

## Gemini Draft

### Strengths

1. **Best direct alignment with the compliance report.** If the literal goal were "make the report say zero gaps," this is the only draft that is honestly scoped to that outcome.

2. **Severity-first framing is easy to scan.** The document is concise and communicates quickly which items are high, medium, and low severity. That is useful for stakeholders who are reading the sprint plan as a scorecard.

3. **It surfaces gaps the Codex draft intentionally defers.** `A2`, `C3`-`C5`, `C9`-`C12`, and `U1`-`U12` are real report gaps, and Gemini usefully prevents them from being forgotten just because they are less user-visible.

4. **The phases are simple to understand.** The high-level shape is clear: high-severity fixes first, then engine/agent-loop alignment, then Unified LLM interface completion.

### Weaknesses

1. **The scope is too broad and not internally coherent.** This is not one sprint. It is a compliance sweep spanning engine concurrency, event taxonomy, tool schema renames, provider prompts, model catalog churn, and Unified LLM interface expansion. Those are not one class of work and do not share one risk profile.

2. **It optimizes for report closure more than product risk.** `A1` is an obvious must-do. But elevating `A2`, `A4`, `C9`-`C12`, `U3`, and the entire `U1`-`U12` family into the same sprint means low-value shape parity work competes directly with runtime correctness work.

3. **Several proposed changes have high blast radius and low immediate payoff.** Renaming engine events to PascalCase, renaming tool parameters to spec spellings, and shifting to provider-specific prompts will touch many consumers and tests. The draft does not justify why those changes belong in the next sprint instead of a dedicated compatibility sprint.

4. **The file plan is too coarse to be implementation-ready.** `src/llm/adapters/*.ts`, `src/agent-loop/tools/*.ts`, and `test/**/*.test.ts` style scoping would force rediscovery during implementation. The Codex draft already shows the better standard here: name the exact files and expected tests.

5. **The dependencies section is not credible.** A sprint that changes engine events, execution context, tool schemas, provider profiles, adapters, stream events, and model catalog absolutely has dependencies across server, CLI, tests, docs, and downstream callers. Writing "None" hides real integration cost.

6. **The plan has no compatibility strategy.** If event names, tool argument names, and type surfaces are going to change, the draft should state whether old names remain accepted temporarily, whether adapters remain source-compatible, and how snapshots/fixtures are migrated.

7. **The Definition of Done is too shallow for the scope it claims.** "All 25 gaps addressed" is not a substitute for proving the behaviors and compatibility consequences of each gap family.

### Gaps in Risk Analysis

1. **No branch/report drift risk.** A draft this report-driven should explicitly acknowledge the risk that the report or the branch has moved since the audit.

2. **No compatibility-break risk for rename-heavy items.** `A4`, `C9`, `C10`, and `C11` are the classic "looks easy on paper, breaks everything in practice" changes. The risk table does not treat them that way.

3. **No API migration risk for `U1`-`U12`.** Adding lifecycle methods, tool-choice capability APIs, new message fields, new stream-event shape, and new timeout/retry config will ripple through adapters, wrappers, tests, and possibly user code.

4. **The lock risk is underspecified.** It mentions deadlocks, but not writer starvation, re-entrancy hazards, exception-safe release, or the chance that the lock solves a spec mismatch without meaningfully improving current parallel behavior.

5. **No model-catalog staleness risk.** `U3` is inherently time-sensitive. Pulling it into a wide sprint means it can go stale again before the sprint is done.

6. **No provider-prompt regression risk.** `C12` is not a naming fix; it is a behavioral change with possible output-quality regression. The draft treats it like a straightforward parity item.

7. **No middleware/interaction risk for retry and streaming changes.** `U11`, `U12`, `U9`, and `U10` can interact badly with existing middleware and stream consumers if they are added in isolation.

### Missing Edge Cases

1. `ReadWriteLock` behavior under nested acquisition, write-after-read upgrade attempts, and writer starvation.

2. Transition behavior for renamed tool parameters: old name only, new name only, both provided, and conflicting values.

3. `Message.text` when a message contains mixed text/tool/thinking parts, no text parts, or non-text multimodal parts.

4. `supports_tool_choice(mode)` when the caller asks for a mode a provider does not support. The draft should define whether that is `false`, ignored, or an error.

5. `PROVIDER_EVENT` passthrough for unknown provider chunks that arrive mid-stream without breaking existing stream consumers.

6. `generate(max_retries)` interacting with globally registered retry middleware so the per-call override is predictable rather than additive in a surprising way.

7. Event rename compatibility for existing CLI renderers, HTTP/SSE consumers, snapshots, and any persisted artifacts keyed by event names.

8. Model catalog changes when a referenced model is intentionally unavailable from a configured provider region or API version.

### Definition of Done Completeness

The Gemini DoD is materially weaker than the Codex DoD.

What it has:
- a broad report-closure target
- a test gate
- one validation assertion
- one event-renaming assertion

What it is missing:

1. No `npm run build` gate.

2. No compatibility criteria for renamed events, renamed tool parameters, or expanded adapter/type surfaces.

3. No per-provider verification for `supports_tool_choice()`, lifecycle methods, or stream-event passthrough.

4. No migration assertions for old callers or old fixtures.

5. No anti-cheating guard such as "no test timeout inflation."

6. No specific assertions for `U1`-`U12` despite those items making up the largest phase in the plan.

7. No requirement that `docs/compliance-report.md` be revalidated against the current branch before it is updated to "0 gaps."

If Gemini's scope were kept, the DoD would need to be rebuilt almost from scratch.

---

## Recommendations for the Final Merged Sprint

1. **Use the Codex draft as the structural base.** It has the better product thesis, the better file ownership model, and the stronger Definition of Done.

2. **Add an explicit Phase 0 audit.** Re-run the compliance check, review the current branch state, and confirm the actual target gaps before locking scope. Treat the report as an input, not as the only source of truth.

3. **Keep the must-have scope centered on runtime truth.** The merged sprint should preserve Codex's core: live run-state truth, clean `wait.human` interruption/resume semantics, seed-linked run persistence, and exact-one-exit enforcement at authoring and execution boundaries.

4. **Keep `U19`, but demote it to a close-out item.** It is a worthwhile fix and belongs in the sprint, but it should not shape the sprint narrative the way the runtime contract work does.

5. **Do not pull Gemini's rename-heavy items into the core sprint.** Defer `A4`, `C9`, `C10`, `C11`, and likely `C12` unless the team explicitly wants a compatibility-focused cleanup sprint. Their blast radius is too high relative to their immediate value.

6. **If extra capacity appears, prefer additive parity items over rename churn.** `U1`, `U2`, `U4`, `U5`, `U8`, `U11`, and `U12` are better stretch candidates than event and parameter renames because they are easier to land compatibly.

7. **Strengthen the merged DoD with the missing negative-path and recovery checks.** Add:
   - restart/recovery coverage for interrupted questions and linked runs
   - exact-once failure-path assertions (`run_failed`, `run_error`)
   - explicit streaming and non-streaming coverage for Gemini `RECITATION`
   - compatibility loading for older on-disk question/seed records
   - SSE consistency checks if event streams are part of the Hive contract

8. **Carry over Gemini's scorecard instinct, but not its whole scope.** The merged sprint should end with an accurate `docs/compliance-report.md` update, but only for the gaps actually revalidated and actually closed by the shipped behavior.

9. **Write down the drop line up front.** If the merged sprint slips, cut stretch compliance parity work first, then the Gemini adapter cleanup, but do not cut the runtime-truth phases that justify the sprint in the first place.
