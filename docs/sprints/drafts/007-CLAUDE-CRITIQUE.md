# Sprint 007 Draft Critiques — Claude

## Drafts Under Review

- **Codex Draft:** `NEXT-CODEX-DRAFT.md`
- **Gemini Draft:** `NEXT-GEMINI-DRAFT.md`
- **Claude Draft:** `NEXT-CLAUDE-DRAFT.md` (self-review included where relevant)

All three drafts converge on the same goal: turn codergen nodes into bounded local coding agents (GAP-40 foundation). The agreement on scope, out-of-scope items, and core abstractions is remarkably strong. The critique below focuses on where the drafts diverge and where each has gaps.

---

## Codex Draft

### Strengths

1. **Exceptionally detailed tool contracts.** The tool behavior section (lines 116–123) is the most precise of the three drafts. Explicit about `write_file` overwrite guard (`overwrite=false` default), `edit_file` exact-match semantics, `shell` environment filtering with named variables. This level of specificity reduces implementation ambiguity.

2. **Artifact layout is concrete and well-thought-out.** The `tool-calls/<NNN>-<tool>/` structure with separate `request.json`, `result.json`, `stdout.log`, `stderr.log` is the most complete artifact specification across all drafts.

3. **Risk table is the most thorough.** Seven risks with specific mitigations. The "scope expands into full Claude Code/Codex CLI parity" risk is correctly identified as High/High — this is the biggest practical threat to the sprint.

4. **Clear distinction between max_turns and max_tool_rounds_per_input.** The Codex draft is the only one that explicitly defines both limits with sensible defaults (12 and 8 respectively) and explains their semantics.

5. **Runaway loop detection is well-specified.** Fingerprint-based, 3 consecutive repeats, requires "no successful file mutation" qualifier to avoid false positives on legitimate edit→test→edit→test cycles.

6. **Module layout is the most granular.** Each concern gets its own file (`loop-detection.ts`, `truncation.ts`, `project-instructions.ts`, `transcript.ts`), which aligns with the project's existing small-module style.

### Weaknesses

1. **`write_file` overwrite guard is questionable.** The `overwrite=false` default means the model must explicitly opt into overwriting existing files. In practice, coding agents overwrite files constantly — that's the core workflow. This default will cause friction and unnecessary tool errors on every normal file update. The Claude draft's simpler `write_file(path, content)` (always writes, creates parent dirs) is more practical. If the goal is safety, `edit_file` already handles the careful-replacement case.

2. **No binary file detection.** The Codex draft doesn't mention handling binary files in `read_file`. A model asking to read `image.png` will get garbage text back. The Claude draft explicitly detects binary files via null-byte check in the first 8KB.

3. **`grep` schema has `max_results=200` but no `path` parameter.** The Codex draft's `grep(pattern, include_glob?, max_results=200)` doesn't let the model scope the search to a subdirectory — a common need. The Claude draft includes an optional `path` parameter.

4. **Phase allocation may be optimistic.** Phase 2 (Tool Registry & Local Execution Environment) is weighted at ~30% but includes 6 tool implementations, the entire execution environment with path sandboxing, and the tool registry with JSON Schema validation. This is likely the densest phase and could bottleneck the sprint.

5. **No Gemini adapter dependency check.** The draft lists Sprint 005-006 as delivering the LLM client, but Sprint 006's scope explicitly deferred the Gemini adapter as Tier 2. If Gemini wasn't shipped in Sprint 006, the provider profile for Gemini will need a stub or the Gemini profile should be listed as conditional. None of the drafts address this clearly enough.

6. **No `.gitignore` respect in grep/glob.** The Codex draft says grep and glob are "in-process" but doesn't mention respecting `.gitignore`. Without this, the tools will search `node_modules/`, `dist/`, and other generated directories — drowning the model in irrelevant results.

### Gaps in Risk Analysis

- **No risk for TOCTOU in `edit_file`.** Between reading a file and writing the edit, another process (or even a parallel tool call in a future sprint) could modify the file. Not critical for sequential-only execution but worth noting for when parallel tool execution is added.
- **No risk for `realpath()` race conditions.** The sandboxing relies on `realpath()` to resolve symlinks, but a malicious symlink could be created between the resolve and the read. Low likelihood in the local-agent context, but worth documenting as a known limitation.
- **No risk for instruction file conflicts.** What happens if `AGENTS.md` contradicts `CLAUDE.md`? The instruction stack order is defined, but there's no mention of how conflicting instructions are handled or surfaced to the user.

### Missing Edge Cases

- What if `edit_file`'s `old_string` contains regex-special characters? The draft says "exact replacement" but doesn't specify whether this is a literal string match or regex.
- What if `shell` produces interleaved stdout/stderr that the model needs to understand in order? The separate `stdout.log`/`stderr.log` artifacts lose ordering information. Consider a merged `output.log` with stream markers.
- What if the workspace root itself is a symlink? The `realpath()` on the root should be resolved at session creation, not per-tool-call.

---

## Gemini Draft

### Strengths

1. **Concise and focused.** At roughly 40% the length of the other drafts, it cuts to the essential decisions without over-specifying. For a team that executes well, this can be more effective than exhaustive detail.

2. **Provider-specific edit formats acknowledged.** Use Case 3 mentions `apply_patch` v4a for OpenAI — the Gemini draft is the only one that even considers provider-specific tool shapes. While all drafts correctly defer this to "out of scope," the Gemini draft demonstrates awareness that this will be a real issue.

3. **Separate file for `edit.ts`.** The Gemini draft separates `edit_file` into its own module (`src/agent/tools/edit.ts`), which is smart — edit logic will be the most complex tool and benefits from isolation.

4. **`max_tool_rounds_per_input` default of 15.** Higher than the Codex/Claude default of 8. For real coding tasks, 8 rounds can be tight (read → edit → test → read error → fix → test again → commit). This is worth debating but the Gemini draft at least pushes toward a more practical limit.

### Weaknesses

1. **Significantly underspecified compared to the other drafts.** Critical details are missing:
   - No artifact layout specification at all — where do transcripts, tool call artifacts, and status files go?
   - No truncation limits per tool (just "character-based head/tail split strategy" with no numbers)
   - No event system specification — no `AgentEvent` union, no event types, no CLI rendering plan
   - No data flow diagram
   - Loop detection is described in one sentence: "track last 3 tool calls; if identical and failing, abort loop" — this is too vague to implement correctly

2. **`model_stylesheet` reference in DoD is premature.** DoD item: "codergen nodes correctly utilize the new loop, using the `model_stylesheet` (or default mapping) to pick the correct `ProviderProfile`." Model stylesheet (GAP-06) is unimplemented and out of scope for this sprint. This DoD criterion can't be met.

3. **Missing `grep` tool entirely.** The Files Summary lists `fs.ts` for `read_file`, `write_file`, `glob` and a separate `shell.ts` for shell — but `grep` is not mentioned anywhere as a distinct tool. It might be bundled into `fs.ts` but that's not stated. The Codex and Claude drafts both include `grep` as a first-class tool, which is important for agent effectiveness.

4. **No project instruction budget or discovery specification.** Phase 2 mentions "load `AGENTS.md` / `CLAUDE.md` if present" but there's no 32KB budget, no discovery ordering, no truncation priority. The other two drafts are much more precise here.

5. **No abort/cleanup specification.** There's mention of "graceful shutdown on AbortSignal" in Phase 3, but no SIGTERM→SIGKILL escalation, no timeout on process kill, no partial artifact preservation semantics. The Codex and Claude drafts both specify 5s grace periods and escalation.

6. **Definition of Done is too thin.** 9 items vs. the Codex draft's 19 and the Claude draft's 28. Critical behaviors are not covered:
   - No DoD for path escape prevention
   - No DoD for artifact file structure
   - No DoD for abort behavior
   - No DoD for provider profile selection
   - No DoD for environment variable filtering in shell
   - No DoD for build/test passing (the other drafts start with `npm install && npm run build`)

7. **Risk table only has 4 entries and misses key risks.** No mention of scope creep (the highest-rated risk in both other drafts), no mention of loop detection sensitivity, no mention of abort/resume reliability.

8. **Module layout uses `src/agent/` not `src/agent-loop/`.** Minor, but the Claude and Codex drafts use `src/agent-loop/` which better disambiguates from any future top-level "agent" concept. Consistency across the final merged sprint matters.

### Gaps in Risk Analysis

- **No scope creep risk.** This is alarming given that GAP-40 is explicitly described as "massive" in the Claude draft's overview. Without a scope creep risk and mitigation, implementers may gradually absorb adjacent features.
- **"Destructive Shell Commands" risk mitigation is weak.** "Same threat model as Makefile" is an observation, not a mitigation. The Codex draft goes further with env-var filtering and workspace sandboxing as concrete mitigations.
- **No risk for test determinism.** The Gemini draft doesn't mention a scripted/deterministic provider adapter for tests. Without this, tests either make real LLM calls (slow, flaky, expensive) or the draft assumes something that should be explicit.

### Missing Edge Cases

- How does the Gemini draft handle `max_tokens` stop reason? If the model hits the token limit mid-tool-call, what happens? The other drafts at least enumerate all stop reasons.
- What if `edit_file`/`apply_patch` receives a patch that *almost* matches? The draft mentions "robust `apply_patch` implementation" as a possible dependency but doesn't resolve this — is it exact match or fuzzy?
- What happens when `process_input()` is called with an empty prompt?

---

## Cross-Draft Comparison

### Where All Three Agree (high confidence — merge directly)

| Decision | Consensus |
|----------|-----------|
| Core loop: `processInput()` → stream → execute tools → loop | All three |
| 6 tools: read_file, write_file, edit_file, shell, grep, glob | Codex + Claude (Gemini missing grep as distinct tool) |
| Sequential tool execution only | All three |
| Workspace-root sandboxing with `realpath()` | All three |
| Provider profiles as system-prompt-only differences | All three |
| One shared tool contract for all providers | All three |
| Out of scope: steer/follow_up, subagents, remote envs, parallel tool exec | All three |
| `ajv` for tool argument validation | Codex + Claude (Gemini doesn't specify) |
| `execa` for shell execution | All three |
| `transcript.jsonl` for session recording | Codex + Claude (Gemini omits artifact spec) |

### Where Drafts Diverge (requires decision)

| Decision | Codex | Gemini | Claude | Recommendation |
|----------|-------|--------|--------|----------------|
| `write_file` overwrite semantics | `overwrite=false` default (refuse overwrite) | Not specified | Always writes, creates parent dirs | **Use Claude's approach.** Coding agents overwrite files constantly. A guard that fires on every `write_file` of an existing file will cause unnecessary errors and waste model turns. `edit_file` handles the careful-change case. |
| `max_tool_rounds_per_input` default | 8 | 15 | 8 | **Use 10.** 8 is tight for real multi-step tasks; 15 is generous enough to mask runaway behavior. 10 is a reasonable middle ground. Make it configurable via node attribute. |
| Loop detection rule | 3 identical fingerprints + no file mutation | 3 identical + failing | 3 identical fingerprints + no file mutation | **Use Codex/Claude's "no file mutation" qualifier.** Gemini's "failing" qualifier is ambiguous — does a successful grep count as "not failing"? The mutation check is cleaner. |
| Directory name | `src/agent-loop/` | `src/agent/` | `src/agent-loop/` | **Use `src/agent-loop/`.** More specific, avoids future collision with a top-level agent concept. |
| Binary file detection in `read_file` | Not mentioned | Not mentioned | Null-byte check in first 8KB | **Include it.** Without this, the model wastes turns on garbage output from binary files. |
| `.gitignore` respect in grep/glob | Not mentioned | Not mentioned | Mentioned (respect `.gitignore`) | **Include it.** Without this, `grep` over a TypeScript project returns thousands of `node_modules` hits. Essential for agent effectiveness. |
| Separate `edit_file` module | Combined in tools/ | Separate `edit.ts` | Combined in tools/ | **Keep in `tools/edit-file.ts`.** The Codex/Claude one-file-per-tool approach is more consistent. |

---

## Definition of Done Completeness

### Codex Draft: 19 items — **Good coverage, minor gaps**
- Missing: build/test must succeed with zero regressions (not just new tests)
- Missing: all tests use scripted adapter (no real LLM calls)
- Missing: binary file detection in read_file
- Missing: .gitignore respect in grep/glob

### Gemini Draft: 9 items — **Insufficient**
- Missing: build and test commands succeeding
- Missing: path escape prevention
- Missing: abort behavior and artifact preservation
- Missing: artifact file structure requirements
- Missing: provider profile selection
- Missing: environment variable filtering
- Missing: event system and CLI rendering
- Missing: `status.json` field requirements
- Contains one unmeetable criterion (`model_stylesheet`)

### Claude Draft: 28 items — **Most complete**
- Grouped by subsystem (Build, Session, Tools, Truncation, Profiles, Loop Detection, Artifacts, Integration)
- Includes both positive assertions ("X works") and negative assertions ("Y does NOT trigger false positive")
- Only gap: no DoD for `write_file` parent directory creation or `read_file` binary detection (both are in the implementation tasks but not the DoD)

---

## Recommendations for the Final Merged Sprint

1. **Use the Claude draft as the structural base.** It has the most complete architecture section, the most detailed DoD, and the clearest phase breakdown. The Codex draft's tool contracts and risk table should be merged in.

2. **Adopt the Codex draft's tool contract section verbatim.** It's the most precise specification of tool behavior. Modify `write_file` to remove the overwrite guard (use Claude's simpler semantics). Add the Claude draft's `grep` `path` parameter and binary file detection.

3. **Add `.gitignore` support to grep and glob.** None of the drafts adequately specify this, but it's critical for real-world use. At minimum, parse the workspace-root `.gitignore` and skip matching paths. Use a library like `ignore` rather than implementing glob-to-regex conversion from scratch.

4. **Set `max_tool_rounds_per_input` to 10.** Split the difference between Codex/Claude (8) and Gemini (15). Make it configurable via `agent.max_tool_rounds` node attribute.

5. **Resolve the Gemini adapter dependency.** Sprint 006 deferred the Gemini adapter. The merged sprint should explicitly state: "The Gemini provider profile is implemented, but if the Gemini adapter doesn't exist in `src/llm/adapters/`, the profile serves as forward-compatible preparation. The sprint does not include implementing the Gemini adapter itself."

6. **Resolve the workspace root source.** The Claude draft says `process.cwd()`. This should be made explicit and configurable — `process.cwd()` is a reasonable default, but a `--workspace` CLI flag or `POLLINATOR_WORKSPACE` env var should be the canonical source. This is a small addition but prevents future confusion.

7. **Include interleaved output preservation for shell.** Save stdout and stderr as separate `.log` files (as specified in Codex/Claude drafts) but also save a merged `combined.log` with stream markers. This helps the model and debuggers understand the execution order.

8. **Strengthen the risk table.** Merge risks from all three drafts. The Codex draft's 7 risks + the Claude draft's 8 risks cover the important space. Add: "Gemini adapter may not exist yet" and ".gitignore parsing complexity" as low-impact risks.

9. **Drop the Gemini draft's `model_stylesheet` DoD item.** It references an unimplemented feature and will block sprint completion.

10. **Add a priority tier system (from Sprint 006's precedent).** The Codex and Claude drafts present the sprint as all-or-nothing. Given the scope (17 new files, 6 modified files), a tiered approach reduces delivery risk:
    - **Tier 1 (must ship):** AgentSession core, ToolRegistry, 4 tools (read_file, write_file, edit_file, shell), LocalExecutionEnvironment, truncation, codergen integration
    - **Tier 2 (should ship):** grep, glob, provider profiles, project instructions, loop detection, events/CLI
    - **Tier 3 (stretch):** Full artifact system (transcript.jsonl, per-tool artifacts), abort integration test, binary file detection
