# Sprint 018: Release Nectar on GitHub

## Overview

Sprint 018 turns Nectar from a local TypeScript CLI into a public, installable product. `docs/INTENT.md` Section 6 is explicit about the release model: standalone binaries built with `bun build --compile`, shipped through GitHub Releases only, installed with `install.sh`, and updated in place with `nectar upgrade`.

The repo is close to being releasable from an engine perspective, but it is missing the public-distribution layer. Today there is no `README.md`, no `LICENSE`, no GitHub Actions workflow, and no upgrade path. The CLI entry point at `src/cli/index.ts` still hardcodes `.version('0.1.0')`, which is incompatible with tag-driven release builds. This sprint fills that gap without changing the development model: local development stays on Node 22 + npm + `tsx`; Bun is used only for compiled release artifacts and CI smoke coverage.

This sprint should also establish one release contract and use it everywhere:

- Release assets live in GitHub Releases, not npm.
- Asset names are stable and versionless: `nectar-darwin-arm64`, `nectar-darwin-x64`, `nectar-linux-x64`, `nectar-linux-arm64`, plus `SHA256SUMS`.
- Local TypeScript build output stays in `dist/`.
- Compiled release output goes to `build/release/` so it does not collide with `dist/`.
- `nectar upgrade` and `install.sh` both verify `SHA256SUMS` before replacing or installing a binary.
- Windows, Homebrew, and pre-release channels are out of scope for Sprint 018.

## Use Cases

1. A first-time macOS user runs `curl -fsSL https://raw.githubusercontent.com/calebmchenry/nectar/main/install.sh | sh`, gets the correct `nectar-darwin-arm64` or `nectar-darwin-x64` binary, and ends with an executable in a writable bin directory after checksum verification.

2. A Linux user already running a compiled `nectar` binary runs `nectar upgrade --check` and sees whether a newer GitHub Release exists without modifying anything.

3. The same user runs `nectar upgrade --yes`, Nectar downloads the correct release asset for the current `process.platform` and `process.arch`, verifies the SHA256, stages the new file beside the existing binary, and atomically renames it into place.

4. A maintainer opens a pull request to `main`, and GitHub Actions runs `npm run build`, `npm test`, and a host-platform `bun build --compile` smoke build so compile regressions are caught before a release tag exists.

5. A maintainer pushes `v0.2.0`, and GitHub Actions cross-compiles four binaries, generates `SHA256SUMS`, and publishes a GitHub Release with generated notes and all five assets attached.

6. A corrupted or tampered download is detected by both `install.sh` and `nectar upgrade`, and the install or upgrade aborts before the downloaded file can replace the current binary.

## Architecture

### 1. CLI wiring follows the existing command pattern

The CLI already uses one file per command with `registerXCommand(program)` functions under `src/cli/commands/`. Sprint 018 should follow that pattern exactly:

- Add `src/cli/commands/upgrade.ts`.
- Update `src/cli/index.ts` to import `registerUpgradeCommand` and call it beside `registerRunCommand`, `registerResumeCommand`, and the other existing registrations.
- Keep `upgrade.ts` thin: parse flags, render themed output through `createTheme()`, and delegate release logic into dedicated helpers under a new `src/upgrade/` module tree.

This keeps the command surface consistent with the existing repo and prevents network, checksum, and filesystem replacement logic from becoming embedded in Commander callbacks.

### 2. Version data must be baked into the compiled binary

The current hardcoded `program.version('0.1.0')` in `src/cli/index.ts` is not acceptable for GitHub tag releases. The release build needs an explicit version file generated before TypeScript build and before Bun compile.

Recommended pattern:

- Add `scripts/release/write-version.mjs`.
- Have that script write `src/generated/version.ts` with a single exported constant:

```ts
export const NECTAR_VERSION = '0.2.0';
```

- Update `src/cli/index.ts` to import `NECTAR_VERSION` from `../generated/version.js` and use `.version(NECTAR_VERSION)`.
- Update `package.json` to run `node scripts/release/write-version.mjs` from `prebuild`, `pretest`, and `prestart` so local development always has a usable version file.
- In `release.yml`, set `NECTAR_VERSION=${GITHUB_REF_NAME#v}` before running the same script so the compiled binary always matches the pushed tag, even if `package.json` has not been manually edited first.

This is cleaner than editing source inline in the workflow and more reliable than reading runtime environment variables from the installed binary.

### 3. Separate release metadata, platform mapping, and replacement logic

Create a small `src/upgrade/` boundary with single-purpose modules:

- `src/upgrade/platform.ts`
  Maps `process.platform` and `process.arch` to the supported release asset names. Unsupported combinations should throw a typed error with a clear message.

- `src/upgrade/github.ts`
  Fetches GitHub release metadata from `/repos/calebmchenry/nectar/releases/latest`, normalizes `tag_name`, selects assets, and returns download URLs plus the release version.

- `src/upgrade/checksum.ts`
  Parses `SHA256SUMS`, computes SHA256 with `node:crypto`, and verifies the downloaded file matches the expected digest.

- `src/upgrade/install.ts`
  Resolves the currently running binary path, stages a downloaded file in the same directory as the target binary, preserves executable mode, and performs the final `rename()` into place only after checksum verification succeeds.

The command file should use a service shape like this:

```ts
interface UpgradePlan {
  currentVersion: string;
  latestVersion: string;
  assetName: string;
  binaryPath: string;
  downloadUrl: string;
  checksumsUrl: string;
}
```

That service boundary keeps the command testable without shelling out and makes it easy to reuse the same asset-selection logic in both `--check` and full install flows.

### 4. Use fetch + crypto in Node, not shell commands

The runtime already targets Node 22 in `package.json`, so the upgrade implementation can use built-in web APIs and Node filesystem primitives:

- Use `fetch()` for release metadata and binary downloads.
- Stream downloads to disk instead of buffering whole binaries in memory.
- Use `realpath()` to resolve the executable target path.
- Stage the replacement file in the same directory as the existing binary to avoid cross-device rename failures.
- Only replace the target after `SHA256SUMS` verification passes.

The upgrade command should not shell out to `curl`, `shasum`, or `mv`. Those shell dependencies are appropriate in `install.sh`, not inside the compiled CLI.

### 5. `install.sh` should avoid GitHub API parsing

The shell installer should not depend on `jq` or brittle JSON parsing. Because release asset names are stable, it can use GitHub's "latest download" redirect form:

- `https://github.com/calebmchenry/nectar/releases/latest/download/nectar-darwin-arm64`
- `https://github.com/calebmchenry/nectar/releases/latest/download/SHA256SUMS`

That leads to a simpler and more portable shell script:

- Detect OS and architecture with `uname -s` and `uname -m`.
- Map those values to the same asset names used by `src/upgrade/platform.ts`.
- Download the binary and `SHA256SUMS` into a temporary directory created with `mktemp -d`.
- Verify the checksum with `sha256sum` on Linux or `shasum -a 256` on macOS.
- Install into `${NECTAR_INSTALL_DIR:-$HOME/.local/bin}` by default.
- If a file already exists at the target path, print a clear replacement notice before overwriting it.
- Use `trap` to clean up the temporary directory on exit or interruption.

For testability, the script should also honor environment overrides such as `NECTAR_RELEASE_BASE_URL` and `NECTAR_INSTALL_DIR`.

### 6. CI and release automation should be separate workflows

Two workflows keep the behavior legible and the permissions minimal:

- `.github/workflows/ci.yml`
  Trigger on `push` to `main` and `pull_request` targeting `main`. Run `npm ci`, `npm run build`, `npm test`, and one host-platform `bun build --compile` smoke build.

- `.github/workflows/release.yml`
  Trigger on `push` tags matching `v*`. Generate the version file from the tag, compile all four release targets into `build/release/`, generate `SHA256SUMS`, and publish a GitHub Release with `gh release create "$GITHUB_REF_NAME" build/release/* --generate-notes`.

Both workflows should pin action versions, and the release workflow should use the narrowest permissions that still allow asset upload:

- CI: `contents: read`
- Release: `contents: write`

## Implementation (phased)

### Phase 1: Version source and asset contract

- Add `scripts/release/write-version.mjs` to materialize `src/generated/version.ts` from `NECTAR_VERSION` or `package.json.version`.
- Update `src/cli/index.ts` to use `NECTAR_VERSION` instead of a hardcoded string.
- Add `src/upgrade/platform.ts` with the canonical mapping:
  `darwin/arm64 -> nectar-darwin-arm64`
  `darwin/x64 -> nectar-darwin-x64`
  `linux/x64 -> nectar-linux-x64`
  `linux/arm64 -> nectar-linux-arm64`
- Update `package.json` with `prebuild`, `pretest`, `prestart`, and release helper scripts.
- Update `.gitignore` for `build/` and `src/generated/version.ts`.

Testing strategy:

- Add `test/upgrade/platform.test.ts` for platform and architecture mapping, unsupported platforms, and version normalization from `v0.2.0` to `0.2.0`.
- Add a small test around the version generator script or the generated file contract so `createProgram().version()` never regresses back to a hardcoded literal.

### Phase 2: `nectar upgrade`

- Add `src/cli/commands/upgrade.ts` with flags `--check` and `--yes`.
- Add `src/upgrade/github.ts`, `src/upgrade/checksum.ts`, and `src/upgrade/install.ts`.
- Register the new command in `src/cli/index.ts`.
- Use `fetch` for release metadata and asset downloads.
- Compare the running version from `NECTAR_VERSION` with the latest release tag after stripping a leading `v`.
- Resolve the current binary with `realpath(process.execPath)` and reject upgrade attempts when Nectar is being run through `node dist/cli/index.js` or `tsx src/cli/index.ts`.
- Download to a staged path in the same directory as the target binary, verify checksum, preserve mode bits, and rename into place.
- Print themed output through `createTheme()` but keep the default `--check` output pipe-friendly.

Testing strategy:

- Add `test/upgrade/checksum.test.ts` for parsing `SHA256SUMS`, mismatches, missing asset lines, and corrupted hashes.
- Add `test/integration/upgrade.test.ts` that starts a local HTTP server serving:
  - fake `/repos/calebmchenry/nectar/releases/latest` JSON
  - fake binary assets
  - a real `SHA256SUMS` file
- In that integration test, create a temporary executable file that stands in for the installed binary, point the upgrade code at it with a test-only override, run `createProgram().parseAsync(['upgrade', '--check'], { from: 'user' })` and `createProgram().parseAsync(['upgrade', '--yes'], { from: 'user' })`, then assert:
  - `--check` reports the available version and does not modify the file
  - `--yes` replaces the file contents
  - executable mode is preserved
  - checksum mismatch aborts before replacement
  - network failures surface a clean error message

### Phase 3: `install.sh` and release artifact generation

- Add `install.sh` at the repo root.
- Add `scripts/release/build-targets.mjs` to call Bun compile for all four targets and write outputs into `build/release/`.
- Add `scripts/release/write-checksums.mjs` to hash every file in `build/release/` except `SHA256SUMS` and then write the checksum manifest in standard `hash  filename` format.
- Keep release asset names exactly aligned with `src/upgrade/platform.ts`.
- Add `gardens/quick-start.dot` if the README needs a stable, documented garden that does not rely on test fixtures.

Testing strategy:

- Add `test/integration/install-script.test.ts`.
- Execute `sh install.sh` in a temp directory using `execaCommand()` with:
  - `HOME` pointed at a temp workspace
  - `NECTAR_INSTALL_DIR` set to a temp `bin/`
  - `NECTAR_RELEASE_BASE_URL` pointed at the local HTTP server
- Assert that the script:
  - selects the expected asset for the host platform
  - writes an executable `nectar`
  - refuses a bad checksum
  - overwrites an existing binary with a clear notice
  - removes temp files on failure

### Phase 4: GitHub Actions CI/CD

- Add `.github/workflows/ci.yml`.
- Add `.github/workflows/release.yml`.
- `ci.yml` should:
  - run on `push` to `main`
  - run on `pull_request` targeting `main`
  - use `actions/checkout`, `actions/setup-node`, and `oven-sh/setup-bun`
  - run `npm ci`, `npm run build`, `npm test`
  - run one host-platform `bun build --compile src/cli/index.ts --outfile build/release/nectar-smoke`
- `release.yml` should:
  - trigger on `push` tags `v*`
  - call `node scripts/release/write-version.mjs`
  - call `node scripts/release/build-targets.mjs`
  - call `node scripts/release/write-checksums.mjs build/release`
  - upload `build/release/*` as release assets
  - create the release with generated notes

Testing strategy:

- CI itself proves `npm run build`, `npm test`, and Bun compile stay healthy on every PR.
- Before the first real public tag, run the release workflow on a fork or through `act` to verify asset names, checksums, and release creation commands.
- Add a job-level assertion that `build/release/` contains exactly five files before publishing.

### Phase 5: Public repository surface

- Add `README.md`.
- Add `LICENSE` with MIT text.
- Add `docs/assets/cli-demo.png` or `docs/assets/cli-demo.gif` for the screenshot requirement.
- Ensure `README.md` contains:
  - one-paragraph elevator pitch for Nectar
  - install script and manual download instructions
  - a quick-start example using `gardens/quick-start.dot` or another committed sample
  - a link to the attractor spec documents
  - a license badge

Testing strategy:

- Manually follow the README in a clean temp directory on macOS and Linux.
- Verify the documented install command matches the real `install.sh` behavior and release asset names.

## Files Summary

| Path | Change | Purpose |
|------|--------|---------|
| `.github/workflows/ci.yml` | New | Push/PR validation: `npm run build`, `npm test`, Bun smoke compile |
| `.github/workflows/release.yml` | New | Tag-driven cross-compile, checksums, and GitHub Release publishing |
| `.gitignore` | Modify | Ignore `build/` and generated version output |
| `package.json` | Modify | Add version-generation hooks and release helper scripts |
| `install.sh` | New | Portable install script for latest release binaries |
| `README.md` | New | Public project landing page and install docs |
| `LICENSE` | New | MIT license required before public release |
| `gardens/quick-start.dot` | New | Stable sample garden for README quick start |
| `docs/assets/cli-demo.png` | New | Screenshot or recording referenced by README |
| `src/cli/index.ts` | Modify | Register upgrade command and replace hardcoded version |
| `src/cli/commands/upgrade.ts` | New | Commander wiring and themed user-facing upgrade flow |
| `src/generated/version.ts` | Generated | Baked release version for build, test, and compile steps |
| `src/upgrade/platform.ts` | New | OS/arch mapping and asset-name selection |
| `src/upgrade/github.ts` | New | GitHub Releases API fetch and asset lookup |
| `src/upgrade/checksum.ts` | New | `SHA256SUMS` parsing and hash verification |
| `src/upgrade/install.ts` | New | Binary staging, permission preservation, and rename-in-place logic |
| `scripts/release/write-version.mjs` | New | Generates `src/generated/version.ts` |
| `scripts/release/build-targets.mjs` | New | Runs Bun compile for all supported targets |
| `scripts/release/write-checksums.mjs` | New | Produces `SHA256SUMS` for release assets |
| `test/upgrade/platform.test.ts` | New | Unit coverage for asset-name and platform mapping |
| `test/upgrade/checksum.test.ts` | New | Unit coverage for checksum manifest parsing and verification |
| `test/integration/upgrade.test.ts` | New | End-to-end upgrade flow against a local fake release server |
| `test/integration/install-script.test.ts` | New | End-to-end shell installer coverage |

## Definition of Done

- `src/cli/index.ts` no longer hardcodes the version string and instead uses generated build metadata.
- `nectar upgrade`, `nectar upgrade --check`, and `nectar upgrade --yes` are implemented and covered by automated tests.
- `nectar upgrade` refuses to replace the binary unless the downloaded asset matches `SHA256SUMS`.
- `install.sh` installs the correct binary for macOS and Linux, verifies checksums, and writes an executable `nectar` into a sensible bin directory.
- Pull requests to `main` run `npm run build`, `npm test`, and a Bun compile smoke job in GitHub Actions.
- Pushing a `v*` tag creates a GitHub Release containing exactly:
  - `nectar-darwin-arm64`
  - `nectar-darwin-x64`
  - `nectar-linux-x64`
  - `nectar-linux-arm64`
  - `SHA256SUMS`
- The release workflow generates release notes automatically.
- `README.md` includes install instructions, manual download instructions, a quick-start example, a screenshot or recording, and a link to the attractor spec.
- `LICENSE` exists at the repo root and is MIT.
- No part of the sprint publishes Nectar to npm or requires Node.js on end-user machines.

## Risks

- Bun compile may surface runtime incompatibilities that do not appear under `tsx` or `node dist/...`. Mitigation: add the PR smoke compile before the first tag release, not after.

- Binary replacement is sensitive to filesystem permissions and symlink layouts. Mitigation: stage beside the resolved executable path, preserve mode bits, and fail with a clear remediation message instead of trying to escalate privileges automatically.

- Release asset naming can drift between TypeScript code, shell installer logic, and GitHub workflow scripts. Mitigation: define the canonical names once in `src/upgrade/platform.ts`, mirror the same names explicitly in `install.sh`, and test both paths against the same local fixture server.

- GitHub API availability or rate limits can make `nectar upgrade --check` noisy. Mitigation: keep the request surface small by using `/releases/latest`, provide actionable error text, and avoid making `install.sh` depend on the API at all.

- The public README can become stale quickly if it references commands or asset names that change. Mitigation: treat README verification as part of the Definition of Done and validate it against a clean install path before tagging.

## Security

- Checksum verification is mandatory in both `install.sh` and `nectar upgrade`. Sprint 018 should not include a `--no-verify` or similar bypass flag.

- The existing binary must not be deleted or overwritten until the new file has been fully downloaded and its SHA256 has been verified against `SHA256SUMS`.

- `nectar upgrade` should use built-in Node APIs (`fetch`, `crypto`, `fs`) instead of shelling out to external commands, which reduces command-injection and PATH-manipulation risk.

- `install.sh` must avoid `eval`, avoid parsing JSON from untrusted sources, and clean up partial downloads with `trap` on failure or interruption.

- GitHub Actions permissions should be minimal. CI jobs only need `contents: read`; the release job should be limited to `contents: write`.

- Workflow actions should be pinned to known versions, and third-party actions should be minimized. Using `gh release create` is preferable to adding another asset-publishing action dependency.

## Dependencies

- GitHub repository: `calebmchenry/nectar`
- GitHub Actions runners with Node 22 and Bun available
- Bun compile for release artifacts only
- Node 22 built-ins: `fetch`, `crypto`, `fs/promises`, `path`, `stream`, `os`, `child_process`
- Existing runtime dependencies already in the repo: `commander`, `chalk`, `execa`, `vitest`
- POSIX shell tools for `install.sh`: `sh`, `uname`, `mktemp`, `chmod`, `mv`, `curl`, and either `sha256sum` or `shasum`

## Open Questions

1. Should `install.sh` always default to `~/.local/bin`, or should it prefer `/usr/local/bin` when that directory is writable and already on `PATH`?

2. When `nectar` is installed through a symlink, should `nectar upgrade` replace the resolved target binary or replace the symlink path itself? The first approach is simpler; the second is friendlier to symlink-based install layouts.

3. Do we want a `workflow_dispatch` entry on `release.yml` for dry runs, or should Sprint 018 keep publishing strictly tag-driven and rely on forks or `act` for rehearsal?

4. Should README quick-start use an existing sample garden in `gardens/`, or is it worth adding `gardens/quick-start.dot` so the docs are decoupled from more advanced examples?
