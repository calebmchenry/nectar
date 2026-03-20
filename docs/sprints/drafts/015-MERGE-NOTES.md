# Sprint 015 Merge Notes

**Date:** 2026-03-20
**Inputs:** NEXT-CLAUDE-DRAFT.md, NEXT-CODEX-DRAFT.md, NEXT-GEMINI-DRAFT.md, NEXT-CLAUDE-CRITIQUE.md, NEXT-CODEX-CRITIQUE.md, NEXT-GEMINI-CRITIQUE.md

---

## Structural Base

**Claude draft** was used as the structural base. It was the most implementation-ready of the three drafts, with detailed architecture, concrete TypeScript interfaces, explicit character budgets, comprehensive DoD, and a gap closure summary. The Codex critique and Claude critique both independently recommended using the Claude draft as the foundation.

---

## What Was Taken From Each Draft

### From Claude Draft (primary structure)

- **Overall sprint structure:** Title, 5-phase breakdown, file summary, DoD, risks, dependencies, gap closure summary
- **Scope decision:** 7 gaps (A3, A4, A5, A8, A10, A11, C3) — the broadest coherent scope
- **Architecture:** `RunStore`, `SessionRegistry`, `PreambleBuilder`, `PendingTransition`, `ResolvedFidelityPlan` abstractions with TypeScript interfaces
- **Fidelity mode behaviors table** with character budgets (400/3200/2400/6000/12000)
- **Truncation priority rules:** header > recent failure > human answer > recent successes > drop oldest
- **Degraded resume logic:** one-hop `summary:high` downgrade after interrupted `full` fidelity, with `thread_registry_keys` in checkpoint for reliable detection
- **Cut-line:** Phase 5 (ArtifactStore + auto_status) is cuttable; fidelity, threads, SessionRegistry are not
- **A11 inclusion:** `auto_status` as a trivial add-on closing a Low gap for free
- **Test target:** at least 55 new test cases
- **Gap closure summary table** with before/after counts per spec
- **Risk: Anthropic thinking signature expiry** in long thread sessions
- **Risk: default fidelity behavioral change** — existing pipelines silently get `compact`
- **Runtime flow diagram**

### From Codex Draft

- **INTENT.md alignment:** Explicit tie-back to `docs/INTENT.md` principles (file-system first, resumable by default, observable and debuggable) added to the "Why now" section. The Claude draft motivated well from gap severity; the Codex draft motivated from product vision.
- **`prompt.md` rendered prompt feature:** Writing the actual prompt sent to the model (not the raw node `prompt` attribute) into `<node-id>/prompt.md`. High debuggability value, low cost. Neither the Claude nor Gemini drafts included this.
- **`parse.ts` insight:** Noting that `src/garden/parse.ts` already folds `node [...]` default blocks into `node.fidelity` / `node.threadId`, so the runtime doesn't need a second metadata channel. This avoids implementation confusion.
- **Design principles section:** "Resume-first beats elegance", "Migration without a flag day", "Deterministic summaries first" — the Codex draft articulated these principles more cleanly than the Claude draft.
- **`RunStore.nextArtifactId(nodeId, purpose)`:** Explicit artifact ID allocation through `RunStore` to avoid collisions, rather than ad hoc handler filenames.
- **`writeLegacyMirror()` as separate method:** Cleaner API separation than the Claude draft's implicit dual-write.
- **Risk: `src/checkpoint/` module creation** adds migration surface — not in other risk tables.

### From Gemini Draft

- **A11 (`auto_status`) inclusion confirmed:** Gemini included it; Claude included it; Codex excluded it. Two-to-one plus all three critiques discussing it confirmed it belongs.
- **Thread resolution graph-default step:** Gemini's thread resolution chain correctly included the graph-level default, which both the Claude and Codex drafts omitted. The Codex critique specifically flagged this omission. The merged sprint uses a 5-step chain: node → edge → **graph default** → subgraph class → previous node.
- **Use case framing:** Gemini's use cases were the most readable at a glance. The merged sprint's use case language borrows some of Gemini's directness (e.g., "Supervisor Loops" use case informed the "Recommended next sprint" section).

### From Gemini Draft — Explicitly Rejected

- **A1 (Manager loop handler):** All three critiques agreed this is too large to include alongside A4/A5. The manager loop needs sub-graph identification, child outcome observation, steering logic, exit semantics, and its own resume story. It deserves Sprint 016.
- **C1 (Context window awareness):** The Claude critique noted this requires `context_window_size` on provider profiles (L19), mixing attractor-engine and LLM-client concerns. Deferred.
- **LLM-based `summary:*` summarization:** Gemini proposed a secondary LLM call for summaries. Both Claude and Codex drafts explicitly rejected this — it adds latency, cost, non-determinism, provider coupling, and failure modes. Deterministic templates are cheaper, faster, testable, and sufficient for v1.
- **`SessionStore` in `ExecutionContext`:** Gemini suggested storing sessions in `ExecutionContext`. Both other drafts correctly use a separate run-scoped registry — non-serializable live sessions should not pollute the serializable context store.

---

## What The Critiques Improved

### From Claude Critique

- **Thread resolution fix:** Flagged the missing graph-default step in A5 resolution. The merged sprint now uses a 5-step chain.
- **Gemini scope veto:** Provided detailed analysis of why A1 is too large (underspecified, no child-graph selection model, no iteration-state contract, no exit/failure semantics, no resume story).
- **Gemini fidelity veto:** Articulated why LLM-based summarization is wrong for this sprint (latency, cost, non-determinism, provider coupling, failure modes).
- **A11 inclusion rationale:** Noted Codex omits A11 "without justification" — both Claude and Gemini include it as trivial.
- **Recommended test target (55+) and gap closure checklist** — adopted in merged DoD.
- **Comparative assessment table** helped calibrate which draft contributed what.

### From Codex Critique

- **Graph-default thread resolution:** Independently flagged the same A5 omission as the Claude critique, confirming it's a real gap.
- **Run-directory contract consistency:** Flagged that the Claude draft promises per-node `status.json`/`prompt.md`/`response.md` in architecture but doesn't commit to them in phases or DoD. The merged sprint adds explicit Phase 4 tasks and DoD items for these files.
- **Dual-write atomicity risk:** Flagged that partial writes during dual-write migration need consideration. Added to risk table.
- **`full` fidelity with no thread ID:** Flagged as a missing edge case. Added explicit DoD item: "full fidelity with no resolved thread ID gets a fresh ephemeral session."
- **Backward compat DoD:** Recommended explicit acceptance for old cocoons without `pending_transition`. Added to Phase 1 tests and DoD.

### From Gemini Critique

- **A11 scope concern:** Gemini critique suggested excluding A11 to maintain focus. Overruled by Claude critique's analysis that it's ~10 lines and two other drafts include it, but the concern is noted — A11 is in the cuttable Phase 5.
- **FIFO lock timeout:** Gemini critique flagged deadlock risk from stalled LLM calls. Added configurable timeout to `SessionRegistry` FIFO lock and explicit risk table entry.
- **Artifact index bloat:** Flagged the risk of `artifacts/index.json` growing with many small artifacts. Added to risk table.

---

## Key Merge Decisions

| Decision | Rationale |
|----------|-----------|
| 7 gaps (A3,A4,A5,A8,A10,A11,C3) | Maximal coherent scope. A11 is trivial, C3 is required for full-fidelity thread reuse to work. |
| Exclude A1 | Unanimous across all critiques. Too large, underspecified, deserves own sprint. |
| Exclude C1 | Requires provider-profile data work (L19). Mixing engine and LLM-client concerns. |
| Deterministic preambles | Two drafts and all critiques agree. LLM-based summaries add cost, latency, non-determinism. |
| 5-step thread resolution | Two critiques independently caught the missing graph-default step. Spec §5.4 requires it. |
| `thread_registry_keys` in checkpoint | Enables reliable degraded-resume detection. Codex critique flagged guessing from `completed_nodes` as fragile. |
| `prompt.md` rendered prompt | Codex unique contribution. High debuggability, low implementation cost. |
| FIFO lock timeout | Gemini critique flagged deadlock risk. Configurable timeout prevents indefinite blocking. |
| Phase 5 as cut-line | ArtifactStore and auto_status are valuable but not load-bearing. Fidelity + threads + session reuse + canonical checkpoints are the sprint. |
