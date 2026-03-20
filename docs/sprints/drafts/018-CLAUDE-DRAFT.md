# Sprint 018: GitHub Release — Binaries, CI/CD, Install, Upgrade, README, LICENSE

## Overview

**Goal:** Make Nectar installable by anyone with a single command. Ship standalone cross-platform binaries via GitHub Releases, automated by CI/CD, with a self-update mechanism built into the CLI.

**Why this sprint, why now:**

- **Nectar has no distribution story.** 17 sprints built a working engine, agent loop, and CLI — but users can't install it. There's no README, no LICENSE, no CI, no binaries. The project is invisible.
- **INTENT.md Section 6 is prescriptive.** It specifies exact tooling (`bun build --compile`), exact targets (4 platforms), exact distribution channel (GitHub Releases, not npm), and exact install UX (`curl | sh`). This sprint implements that section end-to-end.
- **Everything else depends on this.** Public feedback, contributor onboarding, and downstream sprints (Web UI, Seedbed) all need a released, installable artifact. This is the gate.

**Deliverables:**

| # | Deliverable | Description |
|---|-------------|-------------|
| 1 | `bun build --compile` setup | Cross-platform standalone binaries for darwin-arm64, darwin-x64, linux-x64, linux-arm64 |
| 2 | GitHub Actions CI/CD | Push/PR: build + test. Tag push: cross-compile + checksums + GitHub Release |
| 3 | `install.sh` | Platform-detecting convenience script with checksum verification |
| 4 | `nectar upgrade` | Self-update command: check, download, verify, replace binary in-place |
| 5 | `README.md` | Elevator pitch, install instructions, quick-start example, license badge |
| 6 | `LICENSE` | MIT license file |

**Out of scope:**

- Homebrew tap
- Windows binaries
- npm publishing (explicitly forbidden by INTENT.md)
- Shell completions generation in CI (follow-up)
- Pre-release/`--pre` flag on upgrade (follow-up)

---

## Use Cases

1. **First-time install on macOS Apple Silicon.** User runs `curl -fsSL https://raw.githubusercontent.com/calebmchenry/nectar/main/install.sh | sh`. The script detects `darwin` + `arm64`, downloads `nectar-darwin-arm64` from the latest GitHub Release, verifies its SHA256 checksum against the published `checksums.txt`, places the binary in `~/.local/bin/nectar`, and prints a themed success message. The user runs `nectar --version` and sees `0.1.0`.

2. **CI validates a pull request.** A contributor opens a PR. GitHub Actions runs `npm run build` (TypeScript type check) and `npm test` (vitest). If either fails, the PR is blocked. No binaries are compiled on PRs — only on tag push.

3. **Maintainer cuts a release.** Maintainer pushes tag `v0.2.0`. GitHub Actions cross-compiles 4 binaries via `bun build --compile --target=bun-{platform}`, generates `checksums.txt` with SHA256 hashes, and creates a GitHub Release with all 5 assets attached. Release notes are auto-generated from commits since the last tag.

4. **User self-updates.** User runs `nectar upgrade`. The command hits the GitHub Releases API for the latest release, compares the tag against the baked-in version, downloads the correct platform binary to a temp file, verifies its checksum, replaces the running binary via rename-into-place, and prints before/after versions.

5. **User checks for updates without installing.** `nectar upgrade --check` prints whether an update is available and exits. No download, no file changes.

6. **User skips confirmation.** `nectar upgrade --yes` downloads and replaces without prompting.

7. **Offline user runs upgrade.** Network request fails. `nectar upgrade` prints a clear error ("Could not reach GitHub — check your connection") and exits non-zero. No temp files left behind.

---

## Architecture

### Version Injection

The version is currently hardcoded in two places:
- `package.json` → `"version": "0.1.0"`
- `src/cli/index.ts` → `.version('0.1.0')`

**Strategy:** Create a `src/version.ts` that exports the version string. Both `package.json` and `src/cli/index.ts` consume it (CLI via import). At CI release time, the workflow replaces the version string in `src/version.ts` with the git tag value before compilation. This keeps the source simple — no env vars, no generated files, just a sed on one line.

```typescript
// src/version.ts
export const VERSION = '0.1.0';
```

`src/cli/index.ts` imports and uses it: `.version(VERSION)`. `nectar upgrade` imports it to compare against the remote latest.

### Binary Compilation

`bun build --compile` bundles the TypeScript source, all `node_modules`, and a minimal Bun runtime into a single executable. The project is pure ESM with no native add-ons — no special handling needed.

Build matrix (CI):
```
bun build --compile --target=bun-darwin-arm64  src/cli/index.ts --outfile dist/nectar-darwin-arm64
bun build --compile --target=bun-darwin-x64    src/cli/index.ts --outfile dist/nectar-darwin-x64
bun build --compile --target=bun-linux-x64     src/cli/index.ts --outfile dist/nectar-linux-x64
bun build --compile --target=bun-linux-arm64   src/cli/index.ts --outfile dist/nectar-linux-arm64
```

Local dev build (optional npm script):
```
bun build --compile src/cli/index.ts --outfile nectar
```

### Checksum File

`checksums.txt` contains one line per binary, SHA256:

```
a1b2c3...  nectar-darwin-arm64
d4e5f6...  nectar-darwin-x64
...
```

Generated in CI via `shasum -a 256 nectar-* > checksums.txt`.

### GitHub Actions Workflow

Two triggers in one workflow file (`.github/workflows/ci.yml`):

**Trigger 1 — push/PR to main:**
- Checkout, setup Node 22, `npm ci`, `npm run build`, `npm test`
- Fast, lightweight — no Bun, no compilation

**Trigger 2 — tag push (`v*`):**
- Same build+test step first (gate)
- Setup Bun
- Extract version from tag (`GITHUB_REF_NAME` → strip `v` prefix)
- Inject version into `src/version.ts` via sed
- Cross-compile 4 binaries
- Generate checksums
- Create GitHub Release via `gh release create` or `softprops/action-gh-release`
- Upload binaries + checksums as release assets
- Auto-generate release notes from commits

### Install Script (`install.sh`)

A POSIX-compatible shell script in the repo root. Behavior:

1. Detect OS (`uname -s` → `darwin`/`linux`) and arch (`uname -m` → `arm64`/`x86_64`/`aarch64`)
2. Map to asset name: `nectar-{os}-{arch}` (normalize `x86_64` → `x64`, `aarch64` → `arm64`)
3. Determine install directory: `$NECTAR_INSTALL_DIR` env var, or `~/.local/bin` (create if needed), or `/usr/local/bin` as fallback
4. Fetch latest release tag from GitHub API (`/repos/calebmchenry/nectar/releases/latest`)
5. Download the binary and `checksums.txt` from that release via `curl`
6. Verify SHA256 checksum (use `shasum -a 256` on macOS, `sha256sum` on Linux)
7. Move binary to install dir, `chmod +x`
8. Print themed success message with version and PATH hint if install dir isn't in `$PATH`

Requirements: `curl`, `shasum` or `sha256sum` — universally available on macOS and Linux.

### Upgrade Command (`src/cli/commands/upgrade.ts`)

Follows the `registerXCommand(program)` pattern. Implementation:

```
nectar upgrade [--check] [--yes]
```

**Flow:**

1. **Fetch latest release:** `GET https://api.github.com/repos/calebmchenry/nectar/releases/latest` — skip drafts/prereleases automatically (the API endpoint does this).
2. **Compare versions:** Parse `tag_name` (strip `v` prefix) against imported `VERSION`. If equal, print "already up to date" and exit.
3. **`--check` mode:** Print available version and exit.
4. **Confirm:** Unless `--yes`, prompt the user (use Commander's built-in or readline).
5. **Detect platform:** `process.platform` + `process.arch` → map to asset name.
6. **Download binary:** Stream the asset URL to a temp file in the same directory as the current binary (to ensure same filesystem for rename).
7. **Download checksums:** Fetch `checksums.txt` from the same release.
8. **Verify:** Compute SHA256 of the downloaded binary, compare against the line in checksums for the matching asset name. Abort on mismatch with clear error.
9. **Replace:** Resolve current binary path via `process.execPath` (handles symlinks). Write new binary to temp path → `chmod` to match old permissions → `fs.unlink` old → `fs.rename` temp into place.
10. **Confirm:** Print old → new version with themed output.

**Error handling:**
- Network failure → clear message, exit 1, no temp files left
- Permission denied → suggest `sudo` or relocating the binary
- Checksum mismatch → abort with "checksum verification failed" message, delete temp file
- Interrupted download → cleanup temp file via `finally` block

### README.md

Structure:
- Project name + one-line tagline
- License badge (MIT)
- "What is Nectar?" — 1 paragraph elevator pitch
- "Install" — `curl | sh` one-liner + manual download instructions
- "Quick Start" — a simple 3-node `.dot` file and `nectar run` command with example output
- "Self-Update" — `nectar upgrade`
- "Development" — `npm install`, `npm test`, `npm run build`
- "License" — MIT, link to LICENSE file
- Link to attractor spec

### LICENSE

Standard MIT license text. Copyright holder: Caleb McHenry. Year: 2026.

---

## Implementation Phases

### Phase 1: Version Module + LICENSE (~10%)

**Files:** `src/version.ts` (create), `src/cli/index.ts` (modify), `LICENSE` (create)

**Tasks:**

- [ ] Create `src/version.ts` exporting `VERSION = '0.1.0'`
- [ ] Update `src/cli/index.ts` to import `VERSION` from `../version.js` and use `.version(VERSION)`
- [ ] Remove hardcoded `'0.1.0'` string from `src/cli/index.ts`
- [ ] Create `LICENSE` with MIT license text, copyright Caleb McHenry 2026
- [ ] Verify `npm run build` still passes
- [ ] Verify `npm test` still passes (no regressions from import change)

### Phase 2: Upgrade Command (~30%)

**Files:** `src/cli/commands/upgrade.ts` (create), `src/cli/index.ts` (modify), `test/cli/upgrade.test.ts` (create)

**Tasks:**

- [ ] Create `src/cli/commands/upgrade.ts` implementing `registerUpgradeCommand(program)`
- [ ] Implement `fetchLatestRelease()`: GET GitHub Releases API, parse JSON, return `{ tag, assets[], checksumsUrl }`
  - Use Node's built-in `fetch` (available in Node 22+)
  - Handle network errors gracefully (try/catch with user-friendly message)
  - Skip drafts/prereleases (the `/releases/latest` endpoint handles this)
- [ ] Implement `compareVersions(current, latest)`: simple semver string comparison — split on `.`, compare numeric segments
- [ ] Implement `detectPlatform()`: map `process.platform` + `process.arch` to asset suffix (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`). Throw on unsupported platform with clear message.
- [ ] Implement `downloadAsset(url, destPath)`: stream response body to file using `fs.createWriteStream` + `Readable.fromWeb`. Clean up temp file on error.
- [ ] Implement `verifyChecksum(filePath, checksums, assetName)`: compute SHA256 via `crypto.createHash('sha256')`, compare against matching line in checksums text. Return boolean.
- [ ] Implement `replaceBinary(tempPath, targetPath)`: resolve `process.execPath`, `fs.stat` to capture permissions, `fs.unlink` old, `fs.rename` temp → target, `fs.chmod` to restore permissions.
- [ ] Wire up `--check` flag: fetch + compare + print, no download
- [ ] Wire up `--yes` flag: skip confirmation prompt
- [ ] Wire up default (interactive) mode: prompt with readline, abort on `n`
- [ ] Themed output:
  - Checking: `🐝 Checking the hive for updates...`
  - Available: `🍯 New nectar available! v0.1.0 → v0.2.0`
  - Downloading: `⬇️  Downloading nectar-darwin-arm64...`
  - Verified: `✅ Verified checksum`
  - Done: `🌸 Upgraded! You're now on v0.2.0`
  - Up to date: `✅ Already on the latest nectar (v0.1.0)`
  - Network error: `🥀 Could not reach the hive — check your connection`
  - Permission denied: `🥀 Permission denied writing to {path}. Try: sudo nectar upgrade`
  - Checksum failure: `🥀 Checksum verification failed — download may be corrupted. Aborting.`
- [ ] Register in `src/cli/index.ts`: `import { registerUpgradeCommand } from './commands/upgrade.js'` + `registerUpgradeCommand(program)`
- [ ] Tests (mocked — no real network calls):
  - `fetchLatestRelease` returns parsed release when API responds 200
  - `fetchLatestRelease` throws with message on network error
  - `compareVersions` correctly identifies newer, same, older
  - `detectPlatform` maps known platform+arch combos correctly
  - `detectPlatform` throws on unsupported platform (e.g., `win32`)
  - `verifyChecksum` returns true on match, false on mismatch
  - `--check` mode: prints available update, exits without download
  - `--check` mode: prints "up to date" when versions match
  - Temp file cleanup on download failure
  - Temp file cleanup on checksum failure

### Phase 3: GitHub Actions CI/CD (~25%)

**Files:** `.github/workflows/ci.yml` (create)

**Tasks:**

- [ ] Create `.github/workflows/ci.yml` with two job groups:

**Job: `build-and-test`** (runs on push to main and PRs):
```yaml
runs-on: ubuntu-latest
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: '22' }
  - run: npm ci
  - run: npm run build
  - run: npm test
```

**Job: `release`** (runs on tag push `v*`, needs `build-and-test`):
```yaml
runs-on: ubuntu-latest
permissions:
  contents: write
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: '22' }
  - uses: oven-sh/setup-bun@v2
  - run: npm ci
  - run: npm run build
  - run: npm test
  - name: Inject version from tag
    run: |
      VERSION="${GITHUB_REF_NAME#v}"
      sed -i "s/VERSION = '.*'/VERSION = '${VERSION}'/" src/version.ts
  - name: Cross-compile binaries
    run: |
      mkdir -p dist
      bun build --compile --target=bun-darwin-arm64 src/cli/index.ts --outfile dist/nectar-darwin-arm64
      bun build --compile --target=bun-darwin-x64   src/cli/index.ts --outfile dist/nectar-darwin-x64
      bun build --compile --target=bun-linux-x64    src/cli/index.ts --outfile dist/nectar-linux-x64
      bun build --compile --target=bun-linux-arm64  src/cli/index.ts --outfile dist/nectar-linux-arm64
  - name: Generate checksums
    run: |
      cd dist
      shasum -a 256 nectar-* > checksums.txt
  - name: Create GitHub Release
    uses: softprops/action-gh-release@v2
    with:
      generate_release_notes: true
      files: |
        dist/nectar-darwin-arm64
        dist/nectar-darwin-x64
        dist/nectar-linux-x64
        dist/nectar-linux-arm64
        dist/checksums.txt
```

- [ ] Verify the workflow YAML is valid (use `actionlint` or manual review)
- [ ] Ensure `permissions: contents: write` is set on the release job for `GITHUB_TOKEN` to create releases
- [ ] Ensure tag-triggered release still runs build+test as a gate before compiling

### Phase 4: Install Script (~15%)

**Files:** `install.sh` (create)

**Tasks:**

- [ ] Create `install.sh` as a POSIX shell script (`#!/bin/sh`)
- [ ] Set strict mode: `set -eu`
- [ ] Detect OS: `uname -s | tr '[:upper:]' '[:lower:]'` → `darwin` or `linux`; abort with message on anything else
- [ ] Detect arch: `uname -m` → normalize `x86_64` → `x64`, `aarch64` → `arm64`, `arm64` stays `arm64`; abort on unsupported
- [ ] Compose asset name: `nectar-${OS}-${ARCH}`
- [ ] Determine install dir: `${NECTAR_INSTALL_DIR:-${HOME}/.local/bin}`; create with `mkdir -p` if needed
- [ ] Fetch latest release tag: `curl -fsSL https://api.github.com/repos/calebmchenry/nectar/releases/latest | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/'`
  - Minimal JSON parsing without `jq` dependency
- [ ] Download binary: `curl -fSL -o /tmp/nectar-download "https://github.com/calebmchenry/nectar/releases/download/v${VERSION}/${ASSET_NAME}"`
- [ ] Download checksums: `curl -fsSL -o /tmp/nectar-checksums.txt "https://github.com/calebmchenry/nectar/releases/download/v${VERSION}/checksums.txt"`
- [ ] Verify checksum:
  - macOS: `shasum -a 256 /tmp/nectar-download | awk '{print $1}'`
  - Linux: `sha256sum /tmp/nectar-download | awk '{print $1}'`
  - Extract expected: `grep "${ASSET_NAME}" /tmp/nectar-checksums.txt | awk '{print $1}'`
  - Compare; abort on mismatch
- [ ] Install: `mv /tmp/nectar-download "${INSTALL_DIR}/nectar"` + `chmod +x`
- [ ] Cleanup: `rm -f /tmp/nectar-checksums.txt`
- [ ] Print themed success:
  ```
  🐝 Nectar installed successfully! (v0.1.0)
  🌸 Binary: ~/.local/bin/nectar
  ```
- [ ] If install dir not in `$PATH`, print hint: `Add ~/.local/bin to your PATH to use nectar from anywhere`
- [ ] Trap cleanup on error: `trap 'rm -f /tmp/nectar-download /tmp/nectar-checksums.txt' EXIT`
- [ ] Validate with `shellcheck install.sh` (zero warnings)

### Phase 5: README.md (~10%)

**Files:** `README.md` (create)

**Tasks:**

- [ ] Write project header: `# Nectar` with one-line tagline
- [ ] MIT license badge: `[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)`
- [ ] "What is Nectar?" section — one paragraph: pipeline orchestration engine implementing the attractor spec, CLI tool with a pollinator theme, runs DOT-defined workflows with 9 handler types, checkpointing, goal gates, multi-model LLM support
- [ ] "Install" section:
  - One-liner: `curl -fsSL https://raw.githubusercontent.com/calebmchenry/nectar/main/install.sh | sh`
  - Manual: download from GitHub Releases, `chmod +x`, move to PATH
  - Verify: `nectar --version`
- [ ] "Quick Start" section:
  - Minimal `.dot` garden file (3 nodes: start → tool → exit)
  - `nectar run garden.dot` command
  - Example themed output snippet
- [ ] "Self-Update" section: `nectar upgrade` and `nectar upgrade --check`
- [ ] "Development" section: `git clone`, `npm install`, `npm run build`, `npm test`, `npm start -- run garden.dot`
- [ ] "License" section: "MIT — see [LICENSE](LICENSE)"
- [ ] Link to attractor spec repo

### Phase 6: Integration Smoke + Local Bun Compile Test (~10%)

**Tasks:**

- [ ] Verify `npm run build` passes
- [ ] Verify `npm test` passes — zero regressions
- [ ] If Bun is available locally: run `bun build --compile src/cli/index.ts --outfile /tmp/nectar-test` and verify the binary starts (`/tmp/nectar-test --version` prints version, `/tmp/nectar-test --help` prints help)
- [ ] Run `shellcheck install.sh` — zero warnings
- [ ] Verify `nectar upgrade --check` works against the live GitHub API (will report "no releases yet" or similar — confirm it doesn't crash)
- [ ] Review README for accuracy: install instructions match actual script, quick-start example matches actual CLI output
- [ ] Verify CI workflow YAML parses correctly (can use `act --list` if available, or manual review)

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/version.ts` | Create | Single source of truth for version string |
| `src/cli/index.ts` | Modify | Import `VERSION`, register `upgrade` command |
| `src/cli/commands/upgrade.ts` | Create | `nectar upgrade` command: check, download, verify, replace |
| `.github/workflows/ci.yml` | Create | CI on push/PR; release on tag push with cross-compile + checksums |
| `install.sh` | Create | Platform-detecting install script with checksum verification |
| `README.md` | Create | Elevator pitch, install, quick-start, dev setup |
| `LICENSE` | Create | MIT license |
| `test/cli/upgrade.test.ts` | Create | Unit tests for upgrade command (mocked network) |

---

## Definition of Done

### Build and Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes — zero regressions from existing test suite
- [ ] New `src/version.ts` import works correctly in all consuming files

### Version Module
- [ ] `src/version.ts` exists and exports `VERSION`
- [ ] `src/cli/index.ts` uses imported `VERSION` (no hardcoded version string)
- [ ] `nectar --version` prints the version from `src/version.ts`

### Upgrade Command
- [ ] `nectar upgrade --check` reports available updates or "up to date" — no crashes on network error
- [ ] `nectar upgrade` downloads, verifies checksum, and replaces the binary (tested manually against a real release once one exists)
- [ ] `nectar upgrade --yes` skips confirmation prompt
- [ ] Themed output matches INTENT.md examples
- [ ] Network errors produce a clear, non-crashing error message
- [ ] Permission errors suggest `sudo` or relocation
- [ ] Checksum mismatch aborts with clear message and cleans up temp files
- [ ] Temp files are always cleaned up (success, failure, interrupt)
- [ ] At least 10 unit tests covering: API parsing, version comparison, platform detection, checksum verification, error paths, `--check` mode, temp cleanup

### CI/CD
- [ ] `.github/workflows/ci.yml` exists and is valid YAML
- [ ] Push/PR to main triggers: `npm run build` + `npm test`
- [ ] Tag push (`v*`) triggers: build + test + cross-compile 4 binaries + checksums + GitHub Release
- [ ] Release job has `permissions: contents: write`
- [ ] Version is injected from tag into `src/version.ts` before compilation
- [ ] Release includes auto-generated notes from commits
- [ ] All 4 binaries + `checksums.txt` are attached as release assets

### Install Script
- [ ] `install.sh` exists in repo root
- [ ] Detects OS (macOS, Linux) and arch (arm64, x64) correctly
- [ ] Downloads correct binary from latest GitHub Release
- [ ] Verifies SHA256 checksum; aborts on mismatch
- [ ] Installs to `$NECTAR_INSTALL_DIR` or `~/.local/bin` (created if needed)
- [ ] Prints themed success message with version
- [ ] Prints PATH hint if install dir is not in `$PATH`
- [ ] Cleans up temp files on error (trap)
- [ ] `shellcheck install.sh` passes with zero warnings
- [ ] Works on macOS and Linux (POSIX sh, no bash-isms)

### README
- [ ] `README.md` exists in repo root
- [ ] Contains: elevator pitch, install instructions, quick-start example, self-update, dev setup, license section
- [ ] Install instructions match actual `install.sh` behavior
- [ ] Quick-start example uses a valid `.dot` file and `nectar run` command
- [ ] MIT license badge present

### LICENSE
- [ ] `LICENSE` file exists in repo root with MIT license text

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **`bun build --compile` cross-compile failures** | Medium | High | Test compilation locally for native platform first. CI uses the official `oven-sh/setup-bun` action. Cross-compile targets are well-documented in Bun docs. If a target fails, the release job fails — no partial release. |
| **Binary size unexpectedly large** | Medium | Medium | Bun compile includes a runtime (~50-90MB typical). This is expected and acceptable for a self-contained binary. Document in README if relevant. |
| **`process.execPath` doesn't resolve correctly in compiled binary** | Low | High | Bun's `process.execPath` returns the binary path for compiled executables. Test this explicitly in the Bun smoke test. Fallback to `process.argv[0]` with symlink resolution via `fs.realpathSync`. |
| **GitHub API rate limiting in `install.sh`** | Low | Medium | The `/releases/latest` endpoint is a single unauthenticated request. GitHub allows 60/hour for unauthenticated. The script makes at most 3 requests (API + binary + checksums). Only a concern for CI pipelines installing repeatedly — they should cache. |
| **Version injection sed fails on non-GNU sed (macOS)** | Medium | Medium | The CI runs on `ubuntu-latest` where GNU sed is default. The sed pattern is simple (`s/VERSION = '.*'/VERSION = '...'/`) and works on both GNU and BSD sed. |
| **Self-update on read-only filesystem or restricted install** | Low | Medium | Detect permission error, print clear message suggesting `sudo` or relocating the binary. Never crash silently. |
| **Rename-into-place fails across filesystem boundaries** | Low | Medium | Write temp file in the same directory as the target binary (not `/tmp`), ensuring same filesystem for atomic rename. |
| **install.sh minimal JSON parsing breaks on unexpected API response** | Low | Low | The `grep + sed` approach for extracting `tag_name` is fragile but works for GitHub's stable API format. If it fails, the script aborts with a clear "could not determine latest version" error. A future enhancement could add `jq` as optional. |

---

## Security

- **Checksum verification is mandatory.** Both `install.sh` and `nectar upgrade` verify SHA256 before installing. A checksum mismatch is always fatal.
- **HTTPS only.** All downloads use HTTPS URLs to GitHub. No HTTP fallback.
- **No arbitrary code execution.** `install.sh` does not run the downloaded binary as part of installation. It only downloads, verifies, and places it.
- **Temp files have restrictive permissions.** Downloaded binaries are written to temp files before being moved into place. The temp file is not executable until `chmod +x` at the final install location.
- **GitHub API responses are untrusted.** The upgrade command validates response structure before acting on it. Malformed responses cause a clean abort, not a crash.
- **`curl | sh` risk is acknowledged.** This is standard practice for CLI tools but users who prefer auditing first can `curl -o install.sh ... && less install.sh && sh install.sh`.

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `commander` | CLI framework for `nectar upgrade` command | In `package.json`, used by all commands |
| `chalk` | Themed terminal output in upgrade command | In `package.json`, used throughout CLI |
| `ora` | Spinner for download progress | In `package.json`, used in `run` command |
| Node.js `crypto` | SHA256 hash computation for checksum verification | Built-in (Node 22) |
| Node.js `fetch` | GitHub API requests in upgrade command | Built-in (Node 22) |
| Node.js `fs`, `path`, `os` | File operations for binary replacement | Built-in |
| Node.js `readline` | Interactive confirmation prompt | Built-in |
| Bun | Cross-compile in CI only — not a dev dependency | Installed in CI via `oven-sh/setup-bun` |
| `softprops/action-gh-release` | GitHub Release creation in CI | GitHub Actions marketplace |
| `actions/setup-node@v4` | Node.js setup in CI | GitHub Actions |
| `oven-sh/setup-bun@v2` | Bun setup in CI | GitHub Actions |

**Zero new npm dependencies.** The upgrade command uses Node built-ins (`fetch`, `crypto`, `fs`, `readline`). Bun is CI-only for compilation.

---

## Open Questions

1. **Bun compile smoke test in CI on PRs?** Should the `build-and-test` job also run a `bun build --compile` as a smoke test to catch compile failures before a tag push? Pro: catches issues early. Con: adds ~30s and a Bun install to every PR. **Recommendation:** Add it. The cost is low and catching compile failures before tagging is worth it. Put it in a separate optional job so it doesn't block PR merges.

2. **Version in `package.json` drift?** `package.json` has its own `"version"` field. Should CI also update `package.json` version to match the tag, or leave it at `0.1.0` since npm publishing is forbidden? **Recommendation:** Update both in CI for consistency. The `package.json` version is visible in `npm run` output and should match.

3. **GitHub org/user in URLs.** The INTENT doc uses `<org>/nectar` as placeholder. The actual remote is `calebmchenry/nectar`. All URLs in install.sh, upgrade command, and README should use `calebmchenry/nectar`. If this changes, it's a one-line constant.

4. **Upgrade command in compiled binary only?** Should `nectar upgrade` work when running from source (`tsx src/cli/index.ts`), or only in compiled binaries? **Recommendation:** Make it work in both, but print a warning when running from source ("You're running from source — upgrade replaces compiled binaries. Use git pull instead.") by checking if `process.execPath` ends in `bun` or `node`.

5. **Should install.sh support `--version` flag for installing a specific version?** **Recommendation:** Defer. Keep the script simple for v1 — always install latest. Specific version install can be done by downloading directly from the releases page.
