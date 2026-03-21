# Sprint 026 Merge Notes

## Thesis Selection

**Claude's draft won the framing.** The core argument — that four consecutive sprints over-scoped and left tests red, so this sprint must cut scope brutally — was the strongest strategic insight across all three drafts. The "nothing is cuttable" stance and the explicit acceptance that Phase 1 alone justifies the sprint were adopted directly.

## What Was Taken From Each Draft

### Claude (Primary)
- **Sprint title and framing:** "Kill the Red Suite, Fix the Engine Contract" — direct, memorable, sets expectations.
- **Root cause analysis of test failures:** The 2-root-cause breakdown (missing `PipelineFailedEvent` + SSE streams never closing) was unique to Claude's draft and provides the diagnosis-first foundation for Phase 1.
- **Phase 1 hard gate at 40% budget:** No other draft allocated this much time to test fixes or made it a blocking gate. This directly addresses the pattern of shipping features on red suites.
- **Scope discipline:** Claude argued convincingly against GAP-U2 (StopReason rename), GAP-C8 (ExecutionEnvironment), GAP-U3 (model catalog), and other "real but not correctness" gaps. The final sprint adopts this narrow scope.
- **4-phase structure:** Green Suite → Engine Retry → Loop Detection → Provider Parity. Adopted as-is.
- **Use cases 1–6:** All adopted with minor edits.
- **Risk table:** Adopted nearly verbatim, with one addition from Codex.

### Codex (Architectural Depth)
- **Failure routing design rules:** "Retry happens before routing, but only until budget is exhausted" and "Run status is not inferred from the last node shape" — these two principles from Codex's architecture section were incorporated into the engine design. Claude's draft had the routing chain but not these explicit invariants.
- **Terminal status tracking:** Codex's insight that reaching `Msquare` through a failure path must not erase the failed state was added as a Phase 2 task and a Definition of Done item. Claude's draft didn't cover this edge case.
- **Queue-based recovery design:** Codex's recommendation that the loop-detection warning path and manual steering should use the same queue/delivery mechanism was added as a design note in the Loop Detection section.
- **`src/engine/retry.ts` and `src/engine/types.ts`:** Codex identified these as files that need modification alongside `engine.ts`. Added to Phase 2.

### Gemini (Baseline Validation)
- **Confirmed core gap priorities:** Gemini independently agreed on GAP-A1, GAP-A3, GAP-C1, GAP-U1, and GAP-U8 as the right targets, validating Claude's selection.
- **Use case structure:** Gemini's concise use case format influenced the final use case wording (shorter, more action-oriented).
- **No unique additions survived scope cuts.** Gemini proposed GAP-U3 (model catalog refresh) which all drafts except Claude included. Cut per Claude's argument that it's additive, not a correctness bug. Gemini proposed GAP-C8 (ExecutionEnvironment) which Codex also championed at length. Cut per the same logic — it's an abstraction refactor that can wait.

## What Was Cut and Why

| Gap/Feature | Proposed By | Why Cut |
|-------------|-------------|---------|
| GAP-U2 (StopReason rename) | Codex, Gemini | Consumers already branch on specific values; workaround exists. Not a correctness bug. |
| GAP-U3 (Model catalog) | Gemini | Additive — new models don't fix broken existing behavior. |
| GAP-A4 (Codergen label fallback) | Codex | Convenience improvement, not a silent-wrong-result bug. |
| GAP-C3 (steer() queuing) | Codex | Session state polish. Important, but doesn't produce wrong results today. |
| GAP-C4 (IDLE resting state) | Codex | Same reasoning as C3. |
| GAP-C8 (ExecutionEnvironment grep/glob) | Codex, Gemini | Abstraction refactor. No one swaps environments today. Can be a standalone sprint. |
| upstream/manifest.json | Codex | Useful bookkeeping but not a runtime fix. Deferred. |
| Phase 4: Compliance lock-in | Codex | Report refresh is post-implementation housekeeping, not sprint-scoped work. |

## Key Decisions

1. **5 gaps, not 10.** Claude's scope won over Codex's (10 gaps) and Gemini's (8 gaps). The historical pattern of over-scoping was the deciding factor.
2. **No new files beyond test fixtures.** Codex proposed `docs/upstream/manifest.json` and several new test files. The final sprint creates only `test/fixtures/retry-failure-routing.dot`.
3. **Image normalization layer adopted from Codex.** Claude proposed three independent adapter changes. Codex proposed a shared normalization step before adapter translation. The normalization approach is cleaner and was adopted, but kept lightweight — no new abstraction file, just a shared function in `client.ts`.
4. **Phase 1 is the sprint's identity.** If Phase 1 consumes everything, the sprint succeeded. This framing is Claude's and was non-negotiable.
