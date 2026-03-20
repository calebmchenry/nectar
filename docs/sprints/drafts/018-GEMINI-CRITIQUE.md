# Critique of Sprint 018 Drafts

This document provides a critique of the two sprint drafts (`018-CLAUDE-DRAFT.md` and `018-CODEX-DRAFT.md`) for the Nectar GitHub Release sprint. It evaluates strengths, weaknesses, gaps in risk analysis, missing edge cases, and the completeness of the Definition of Done (DoD) for each draft.

## 1. Claude Draft (`018-CLAUDE-DRAFT.md`)

### Strengths
- **UX and Product Focus:** Excellent attention to the user experience. The draft defines specific, themed terminal outputs (e.g., using `chalk` and emojis) for various states of the upgrade process.
- **Granular Task Breakdown:** The implementation phases are highly detailed, breaking down the work into very specific, actionable tasks with estimated percentages.
- **Clear Use Cases:** The use cases are narrative and easy to follow, covering first-time installs, CI validation, and various upgrade scenarios (offline, skipped confirmation).

### Weaknesses
- **Brittle Versioning Strategy:** Relies on using `sed` in the GitHub Actions workflow to inject the version string into `src/version.ts`. This is brittle and decouples the local development environment from the release mechanism.
- **Fragile `install.sh` Implementation:** The install script uses `curl`, `grep`, and `sed` to parse the GitHub API JSON response to find the latest tag. This is highly prone to breakage if the API response format changes slightly.
- **Non-Standard Checksum Naming:** Uses `checksums.txt` instead of the more standard `SHA256SUMS`.
- **Testing Strategy:** Relies heavily on mocked tests for the upgrade command and manual testing / `shellcheck` for the install script. It lacks a robust integration testing plan.

### Gaps in Risk Analysis
- **GitHub API Rate Limits for `install.sh`:** While it mentions API rate limits, it fails to recognize that parsing the API in `install.sh` makes every automated installation (e.g., in user CI pipelines) susceptible to unauthenticated rate limits (60 requests/hour).
- **Cross-Device Moves:** The install script downloads to `/tmp` and moves the file to the target installation directory. If `/tmp` and the target directory are on different filesystems, `mv` will perform a copy-and-delete, which is not atomic and could leave a corrupted binary if interrupted.

### Missing Edge Cases
- **Interrupt Handling:** Does not explicitly handle the scenario where a user presses `Ctrl+C` during the binary download in the `nectar upgrade` command (though it mentions `finally` block cleanup, it doesn't explicitly mention signal trapping).
- **Symlink Resolution:** Mentions resolving `process.execPath` but doesn't clearly define whether it should replace the symlink itself or the underlying target file.

### Definition of Done Completeness
- **Completeness:** Very comprehensive and granular.
- **Gaps:** Missing automated integration tests for `install.sh` and the upgrade command. Relies on manual verification for the final install behavior.

---

## 2. Codex Draft (`018-CODEX-DRAFT.md`)

### Strengths
- **Robust Versioning Strategy:** Proposes a `scripts/release/write-version.mjs` script that runs on `prebuild` to generate `src/generated/version.ts`. This is much safer than `sed` and ensures local builds always have a valid version file.
- **Elegant `install.sh` Design:** Completely avoids GitHub API parsing by using the `/releases/latest/download/...` redirect URLs. This bypasses API rate limits and eliminates brittle JSON parsing in bash.
- **Strong Architectural Boundaries:** Separates the upgrade logic into dedicated modules (`platform.ts`, `github.ts`, `checksum.ts`, `install.ts`) rather than embedding it all in the commander action.
- **Excellent Testing Strategy:** Mandates end-to-end integration tests using a local fake release server for both the upgrade command and the shell installer.

### Weaknesses
- **Light on UX Details:** Lacks the specific theming and user-centric output examples present in the Claude draft.
- **Less Granular Task List:** The implementation phases are described in prose rather than as a strict checklist, which might be harder to track during execution.

### Gaps in Risk Analysis
- **Symlink Overwrites:** Mentions symlinks as an "Open Question" rather than proactively addressing the risk of overwriting a symlink managed by another tool (e.g., if a user somehow installed via Homebrew in the future, or linked it manually).
- **Missing Release Tags:** Does not analyze the risk of the `nectar upgrade` command failing gracefully if invoked before the very first GitHub Release is cut.

### Missing Edge Cases
- **Partial Downloads:** Doesn't explicitly detail how to handle incomplete downloads if the connection drops halfway through fetching the binary in `nectar upgrade`, other than relying on the checksum mismatch to catch it.
- **Permissions on Overwrite:** While it mentions preserving executable mode, it doesn't explicitly address handling `EACCES` errors if the existing binary is owned by `root` but the user runs `nectar upgrade` without `sudo`.

### Definition of Done Completeness
- **Completeness:** Strong technical requirements, especially around testing.
- **Gaps:** Lacks explicit DoD items for the CLI UX (e.g., specific error messages, progress indicators) and doesn't explicitly require verification of permission-denial handling.

---

## 3. Conclusion & Recommendations

The **Codex Draft** provides a significantly stronger technical foundation and architectural design. Its approach to version generation, bypassing the GitHub API in `install.sh`, and requiring robust integration tests makes it the safer and more maintainable plan.

The **Claude Draft** excels in product thinking, UX, and providing a clear, granular checklist.

**Recommendation:** Adopt the architecture, versioning strategy, and testing plan from the **Codex Draft**, but integrate the detailed UX theming, granular task breakdown, and comprehensive DoD from the **Claude Draft**. Specifically:
1. Use Codex's `write-version.mjs` instead of Claude's `sed`.
2. Use Codex's `/releases/latest/download` URL strategy for `install.sh` to avoid `grep`/`sed` on JSON.
3. Use Codex's integration testing strategy (fake server).
4. Adopt Claude's terminal UX guidelines and theming.
5. Combine both DoDs to ensure both technical correctness and a polished user experience are verified.