# Sprint 018 Draft Critique

**Reviewer:** Codex  
**Date:** 2026-03-20

Reviewed against:

- `docs/sprints/drafts/018-CLAUDE-DRAFT.md`
- `docs/sprints/drafts/018-GEMINI-DRAFT.md`
- `docs/sprints/drafts/018-INTENT.md`
- `docs/INTENT.md`
- `package.json`
- `src/cli/index.ts`
- `src/cli/ui/theme.ts`
- `test/integration/run.test.ts`
- `test/integration/resume.test.ts`

The Claude draft is the stronger base overall. It is more implementation-ready, it matches the current CLI command structure better, and it does a better job spelling out user-visible behavior, error handling, and Definition of Done detail. The Gemini draft has two notable advantages: the CI/release workflow split is cleaner, and its instinct to use integration-style tests for upgrade behavior fits the current repo better.

Both drafts miss one repo-specific issue that is load-bearing here: `package.json` currently points `bin.nectar` at `dist/cli/index.js`, so `nectar upgrade` must not blindly treat `process.execPath` or `process.argv[0]` as the Nectar binary path. In source, test, or npm-linked JS-wrapper executions, that can target the Node executable instead of Nectar. Both drafts also underspec the README screenshot/recording requirement that is explicitly called out in `docs/INTENT.md` Section 6.

## Claude Draft

### Strengths

- This is the more executable sprint plan. The phases, file list, use cases, architecture, and DoD are detailed enough that implementation would not need to invent much mid-sprint.
- It fits the current repo structure well. The draft follows the existing `registerXCommand(program)` pattern in `src/cli/index.ts`, and it assumes the upgrade command lives beside the other CLI commands rather than becoming a one-off.
- The user-facing behavior is thought through better than Gemini's. `--check`, `--yes`, offline failure, checksum mismatch, and PATH hints are all called out explicitly.
- The security and operational concerns are treated seriously. Checksum verification is mandatory, temp-file cleanup is considered, and `shellcheck` / workflow validation / local Bun smoke checks are all included.
- The out-of-scope line is clear, which matters for a sprint that could easily sprawl into Homebrew, Windows, npm, or prerelease support.

### Weaknesses

- The version-source plan is internally inconsistent. `package.json` cannot consume `src/version.ts`, so the proposed "single source of truth" is not actually single-source. The later open question about package-version drift exposes the same problem.
- The CI/release shape is harder than it needs to be. Putting both push/PR validation and tag-release behavior into one workflow file with separate job groups is workable, but the draft leaves the trigger and `needs` behavior underspecified compared with a cleaner `ci.yml` + `release.yml` split.
- The binary replacement design is too risky as written. The plan explicitly unlinks the old binary before renaming the staged file into place, which creates a failure window where the user can be left with no working binary if the rename fails.
- `process.execPath` is treated as if it already solves symlink and wrapper-path issues. It does not. In this repo, that matters because the current executable path for local/npm-linked usage is not the final compiled binary path.
- The installer design is brittle. Parsing GitHub API JSON with `grep` + `sed` and using fixed `/tmp/nectar-download` file names makes the script more fragile and less safe under concurrent runs than it needs to be.
- The test plan is too unit-heavy for an operation that is mostly network, filesystem, and process-replacement behavior. There is no automated local fixture-server integration coverage for either `nectar upgrade` or `install.sh`.
- The README scope misses the screenshot or terminal recording that `docs/INTENT.md` explicitly requires.

### Gaps in Risk Analysis

- No explicit risk covers running `nectar upgrade` from source, from `node dist/cli/index.js`, or from an npm-linked JS wrapper and accidentally targeting the Node executable.
- No explicit risk covers symlinked installs and the policy decision of whether upgrade should replace the symlink path or the resolved target.
- No explicit risk covers the old-binary deletion window created by `unlink` before `rename`.
- No explicit risk covers first-release behavior, "no latest release yet", or a release that exists but is missing the expected asset or checksum file.
- No explicit risk covers temp-file collisions or unsafe reuse from the fixed `/tmp/nectar-*` naming strategy.
- No explicit risk covers drift between the release tag, `src/version.ts`, and `package.json`.

### Missing Edge Cases

- `nectar upgrade` invoked from source or from the current JS bin layout should refuse to run rather than trying to replace `node`.
- The latest release exists but is missing the current platform asset or `checksums.txt`.
- No stable release exists yet and the GitHub API returns 404 for `/releases/latest`.
- Nectar is installed via symlink and the resolved target lives somewhere different from the user-facing command path.
- Two installer processes run at the same time and collide on `/tmp/nectar-download` or `/tmp/nectar-checksums.txt`.
- Upgrade or install output is piped or run in a non-TTY environment and should stay plain-text and script-friendly, matching the existing `createTheme()` behavior.

### Definition of Done Completeness

- This is the stronger DoD of the two, but it still needs a few additions.
- Add automated integration acceptance for `nectar upgrade` and `install.sh` against a local fake release server. Unit tests alone are not enough here.
- Add explicit acceptance that upgrade refuses source or JS-wrapper executions and only replaces a compiled Nectar binary.
- Add explicit acceptance for symlink handling policy and for missing-asset / no-release-yet failure paths.
- Add explicit acceptance that `README.md` includes the screenshot or terminal recording required by the intent, not just text sections.
- Add acceptance for version-contract correctness: the baked binary version, release tag, and whatever policy is chosen for `package.json` must be consistent and documented.
- Add host-platform Bun compile smoke coverage to the merge gate or, at minimum, make the first-release rehearsal part of DoD rather than an optional verification note.

## Gemini Draft

### Strengths

- The workflow split is better. Separate `ci.yml` and `release.yml` files are easier to reason about, easier to permission correctly, and easier to rehearse before the first public tag.
- The plan is concise and readable. For someone scanning quickly, the phases and scope are easier to parse than the Claude draft.
- The instinct to add integration tests around the upgrade flow is strong and fits the current repo, which already has a real `test/integration/` layer.
- The draft catches a few important first-order risks, especially Bun compile uncertainty, permission failures during in-place upgrades, and GitHub API rate limiting.
- It stays aligned with the main intent items and does not try to expand the sprint into extra distribution channels.

### Weaknesses

- The draft is materially less implementation-ready. It leaves too many contracts implicit: exact asset names, checksum filename, release-output directory, workflow permissions, install-dir policy, and installer test hooks.
- The binary replacement plan is too loose. "`process.argv[0]` or similar" is not a safe enough contract for this repo, because the current `bin.nectar` path goes through `dist/cli/index.js` under Node.
- The versioning story is under-specified and potentially confusing. A local default of `0.1.0-dev` is reasonable in isolation, but the draft never reconciles it with `package.json` still being `0.1.0`, release tags being `v*`, and user-facing `nectar --version` expectations.
- The installer plan is missing operational detail. It does not say how users choose an install directory, how temp files are cleaned up, how existing installs are replaced safely, or how the script is tested.
- The README plan includes the right public artifacts, but the DoD does not hold the draft to that same completeness.
- The draft does not explicitly anchor the upgrade command to existing CLI concerns like `createTheme()` and pipe-friendly behavior, even though those patterns already exist in the repo.

### Gaps in Risk Analysis

- No explicit risk covers source-run or JS-wrapper upgrade behavior accidentally replacing the Node executable.
- No explicit risk covers asset-name drift between the release workflow, `install.sh`, and `nectar upgrade`.
- No explicit risk covers version drift between `package.json`, the local development version, and the tagged release version.
- No explicit risk covers symlinked installations or path-resolution policy during replacement.
- No explicit risk covers malformed, missing, or duplicated checksum entries.
- No explicit risk covers first-public-release behavior when `/releases/latest` has no stable release yet.
- No explicit risk covers workflow permissions or rehearsal of the release workflow before the first real tag.

### Missing Edge Cases

- `nectar upgrade` run from `tsx src/cli/index.ts`, `node dist/cli/index.js`, or an npm-linked wrapper install.
- The latest release exists but is missing the expected platform asset or the checksum file.
- No release exists yet.
- Checksum manifest parsing fails because the expected line is missing or malformed.
- Upgrade target is on a read-only filesystem or behind a symlink.
- `install.sh` overwrites an existing install and should warn, replace cleanly, and preserve executability.
- `--check` output is used in a piped or non-TTY context and should remain plain and script-friendly.
- Installer needs to place the binary somewhere sensible when `~/.local/bin` is absent from `PATH` or when the user wants an override.

### Definition of Done Completeness

- The DoD is too thin for the operational complexity of this sprint.
- Add acceptance for exact release asset naming and checksum-manifest naming so the workflow, installer, and upgrader cannot silently drift.
- Add automated validation for `install.sh`, not just upgrade-command tests.
- Add explicit acceptance that upgrade refuses source or JS-wrapper execution modes and handles symlinks according to a documented policy.
- Add explicit acceptance for temp-file cleanup and zero replacement on checksum mismatch, network failure, or rename failure.
- Add explicit acceptance that `README.md` includes the screenshot or terminal recording required by the intent.
- Add explicit acceptance for the chosen version contract across local dev, release tags, and CLI output.
- Add explicit acceptance for workflow permissions and a dry-run or rehearsal path before the first public release.
- Add acceptance for install-location flexibility if the sprint is supposed to satisfy the intent's "`~/.local/bin`, `/usr/local/bin`, or user's choice" requirement.

## Recommendations For The Final Merged Sprint

- Use the Claude draft as the structural base. It is more complete and closer to implementation.
- Keep Gemini's workflow split and PR-time Bun smoke compile. Those are cleaner than Claude's single-workflow approach.
- Replace the loose versioning story in both drafts with one explicit contract. Either generate a version file from a script, or define exactly how `package.json`, the CLI, and the release tag are kept in sync.
- Add one hard guard in the upgrade design: if Nectar is not running as a compiled standalone binary, `nectar upgrade` must refuse to replace anything.
- Add local fake-release integration tests for both `nectar upgrade` and `install.sh`, including no-release-yet, missing-asset, bad-checksum, and symlink-path cases.
- Add the README screenshot or recording to the DoD. The intent treats it as part of the public release surface, not as a nice-to-have.
