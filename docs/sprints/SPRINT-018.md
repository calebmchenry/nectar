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
| 1 | Version module | Generated `src/generated/version.ts` with `scripts/release/write-version.mjs` |
| 2 | `nectar upgrade` | Self-update command: check, download, verify, replace binary in-place |
| 3 | GitHub Actions CI/CD | `ci.yml`: build + test + Bun smoke. `release.yml`: cross-compile + checksums + GitHub Release |
| 4 | `install.sh` | Platform-detecting convenience script with checksum verification |
| 5 | `README.md` | Elevator pitch, install instructions, quick-start, screenshot/recording, license badge |
| 6 | `LICENSE` | MIT license file |

**Out of scope:**

- Homebrew tap
- Windows binaries
- npm publishing (explicitly forbidden by INTENT.md)
- Shell completions generation in CI (follow-up)
- Pre-release/`--pre` flag on upgrade (follow-up)

---

## Use Cases

1. **First-time install on macOS Apple Silicon.** User runs `curl -fsSL https://raw.githubusercontent.com/calebmchenry/nectar/main/install.sh | sh`. The script detects `darwin` + `arm64`, downloads `nectar-darwin-arm64` from the latest GitHub Release via redirect URL, verifies its SHA256 checksum against `SHA256SUMS`, places the binary in `~/.local/bin/nectar`, and prints a themed success message with a PATH hint if needed.

2. **CI validates a pull request.** A contributor opens a PR. GitHub Actions runs `npm run build` (TypeScript type check), `npm test` (vitest), and a host-platform `bun build --compile` smoke test. If any step fails, the PR is blocked.

3. **Maintainer cuts a release.** Maintainer pushes tag `v0.2.0`. GitHub Actions cross-compiles 4 binaries, generates `SHA256SUMS`, and creates a GitHub Release with all 5 assets attached and auto-generated release notes.

4. **User self-updates.** `nectar upgrade` hits the GitHub Releases API, compares the tag against the baked-in version, downloads the correct platform binary to a temp file in the same directory, verifies its checksum, and atomically renames it into place.

5. **User checks for updates without installing.** `nectar upgrade --check` prints whether an update is available and exits. No download, no file changes.

6. **User skips confirmation.** `nectar upgrade --yes` downloads and replaces without prompting.

7. **Offline user runs upgrade.** Network request fails. `nectar upgrade` prints a clear error and exits non-zero. No temp files left behind.

8. **Developer runs upgrade from source.** `tsx src/cli/index.ts upgrade` detects it's not a compiled binary, prints "Running from source — use `git pull` to update", and exits without modifying files.

---

## Architecture

### Version Injection

Create `scripts/release/write-version.mjs` that generates `src/generated/version.ts`:

```typescript
// src/generated/version.ts (generated — do not edit)
export const NECTAR_VERSION = '0.1.0';
```

The script reads `NECTAR_VERSION` env var (set from the git tag in CI) or falls back to `package.json` version. It is invoked via `prebuild` hook in `package.json`. The generated file is `.gitignore`d.

`src/cli/index.ts` imports `NECTAR_VERSION` from `../generated/version.js`. The upgrade command imports it to compare against the remote latest.

### Upgrade Module (`src/upgrade/`)

Four single-purpose modules behind a clean service boundary:

- **`src/upgrade/platform.ts`** — Maps `process.platform` + `process.arch` to release asset names. Throws a typed error on unsupported platforms. Also detects if Nectar is running as a compiled binary vs. from source (Node/tsx/Bun runtime).

- **`src/upgrade/github.ts`** — Fetches `/repos/calebmchenry/nectar/releases/latest` via `fetch()`. Returns an `UpgradePlan`:
  ```typescript
  interface UpgradePlan {
    currentVersion: string;
    latestVersion: string;
    assetName: string;
    binaryPath: string;
    downloadUrl: string;
    checksumsUrl: string;
  }
  ```
  Handles: no releases yet (404), missing platform asset, network errors.

- **`src/upgrade/checksum.ts`** — Parses `SHA256SUMS` file format. Computes SHA256 via `crypto.createHash('sha256')` with streaming. Returns match/mismatch.

- **`src/upgrade/install.ts`** — Resolves current binary path via `fs.realpath(process.execPath)`. Stages download in the same directory as target (same filesystem for atomic rename). Preserves file permissions. Replaces via `fs.rename(tempPath, targetPath)` — atomic on POSIX, no `unlink` step. Cleans up temp files in all cases (success, failure, interrupt) via `finally`.

### Upgrade Command (`src/cli/commands/upgrade.ts`)

Follows `registerXCommand(program)` pattern. Flags: `--check`, `--yes`.

**Themed output:**
- Checking: `🐝 Checking the hive for updates...`
- Available: `🍯 New nectar available! v0.1.0 → v0.2.0`
- Downloading: `⬇️  Downloading nectar-darwin-arm64...` (with ora spinner)
- Verified: `✅ Verified checksum`
- Done: `🌸 Upgraded! You're now on v0.2.0`
- Up to date: `✅ Already on the latest nectar (v0.1.0)`
- From source: `🌱 Running from source — use git pull to update`
- Network error: `🥀 Could not reach the hive — check your connection`
- Permission denied: `🥀 Permission denied writing to {path}. Try: sudo nectar upgrade`
- Checksum failure: `🥀 Checksum verification failed — download may be corrupted. Aborting.`

Interactive confirmation (default mode) uses `readline` from Node built-ins. Detects non-TTY and behaves pipe-friendly (plain text, no spinners).

### Binary Compilation

`bun build --compile` bundles TypeScript source, all `node_modules`, and a minimal Bun runtime into a single executable. The project is pure ESM with no native add-ons.

Build targets (CI only):
```
bun build --compile --target=bun-darwin-arm64  src/cli/index.ts --outfile dist/nectar-darwin-arm64
bun build --compile --target=bun-darwin-x64    src/cli/index.ts --outfile dist/nectar-darwin-x64
bun build --compile --target=bun-linux-x64     src/cli/index.ts --outfile dist/nectar-linux-x64
bun build --compile --target=bun-linux-arm64   src/cli/index.ts --outfile dist/nectar-linux-arm64
```

### Checksum File

`SHA256SUMS` — one line per binary, standard format:
```
a1b2c3...  nectar-darwin-arm64
d4e5f6...  nectar-darwin-x64
...
```

Generated in CI via `sha256sum nectar-* > SHA256SUMS` (on ubuntu-latest).

### GitHub Actions — Two Workflows

**`.github/workflows/ci.yml`** — Push to main + PRs:
- Checkout → setup Node 22 → `npm ci` → `npm run build` → `npm test`
- Setup Bun → `bun build --compile src/cli/index.ts --outfile /tmp/nectar-smoke` (host platform smoke test)
- Permissions: `contents: read`

**`.github/workflows/release.yml`** — Tag push (`v*`):
- Checkout → setup Node 22 → setup Bun → `npm ci`
- Inject version: `NECTAR_VERSION="${GITHUB_REF_NAME#v}" node scripts/release/write-version.mjs`
- `npm run build` → `npm test` (gate)
- Cross-compile 4 binaries into `dist/`
- Generate `SHA256SUMS`: `cd dist && sha256sum nectar-* > SHA256SUMS`
- Create release: `gh release create "$GITHUB_REF_NAME" dist/* --generate-notes`
- Permissions: `contents: write`

### Install Script (`install.sh`)

POSIX shell script (`#!/bin/sh`, `set -eu`). Avoids GitHub API JSON parsing entirely by using redirect URLs:

```
https://github.com/calebmchenry/nectar/releases/latest/download/nectar-{os}-{arch}
https://github.com/calebmchenry/nectar/releases/latest/download/SHA256SUMS
```

Flow:
1. Detect OS (`uname -s` → lowercase) and arch (`uname -m` → normalize `x86_64` → `x64`, `aarch64` → `arm64`)
2. Create temp dir via `mktemp -d`; `trap` cleanup on EXIT
3. Download binary and `SHA256SUMS` via `curl -fSL` into temp dir
4. Verify checksum (`sha256sum` on Linux, `shasum -a 256` on macOS)
5. Install to `${NECTAR_INSTALL_DIR:-$HOME/.local/bin}` (create with `mkdir -p`)
6. `chmod +x`, print themed success with version
7. Print PATH hint if install dir is not in `$PATH`

Wrap main logic in a `main()` function called at the end of the file to prevent partial execution from pipe interruption.

Honor `NECTAR_RELEASE_BASE_URL` override for testing.

### README.md

- `# Nectar` with one-line tagline + MIT license badge
- "What is Nectar?" — 1 paragraph elevator pitch
- Screenshot or terminal recording of themed CLI output
- "Install" — `curl | sh` one-liner + manual download + `nectar --version` verify
- "Quick Start" — a simple `.dot` garden and `nectar run` with example output
- "Self-Update" — `nectar upgrade` and `nectar upgrade --check`
- "Development" — clone, `npm install`, `npm run build`, `npm test`
- "License" — MIT, link to LICENSE
- Link to attractor spec

### LICENSE

MIT license. Copyright Caleb McHenry 2026.

---

## Implementation Phases

### Phase 1: Version Module + LICENSE (~10%)

**Files:**
- `scripts/release/write-version.mjs` (create)
- `src/generated/version.ts` (generated, gitignored)
- `src/cli/index.ts` (modify — import `NECTAR_VERSION`)
- `package.json` (modify — add `prebuild` hook)
- `.gitignore` (modify — add `src/generated/`)
- `LICENSE` (create)

**Tasks:**
- [ ] Create `scripts/release/write-version.mjs`: reads `NECTAR_VERSION` env var or `package.json` version, writes `src/generated/version.ts` with `export const NECTAR_VERSION = '...'`
- [ ] Ensure script creates `src/generated/` directory if missing (`mkdir -p` equivalent)
- [ ] Add `"prebuild": "node scripts/release/write-version.mjs"` to `package.json` scripts
- [ ] Update `src/cli/index.ts` to import `NECTAR_VERSION` from `../generated/version.js` and use `.version(NECTAR_VERSION)`
- [ ] Remove hardcoded `'0.1.0'` from `src/cli/index.ts`
- [ ] Add `src/generated/` to `.gitignore`
- [ ] Create `LICENSE` with MIT license text, copyright Caleb McHenry 2026
- [ ] Verify `npm run build` and `npm test` still pass

### Phase 2: Upgrade Command (~30%)

**Files:**
- `src/upgrade/platform.ts` (create)
- `src/upgrade/github.ts` (create)
- `src/upgrade/checksum.ts` (create)
- `src/upgrade/install.ts` (create)
- `src/cli/commands/upgrade.ts` (create)
- `src/cli/index.ts` (modify — register command)
- `test/upgrade/platform.test.ts` (create)
- `test/upgrade/checksum.test.ts` (create)
- `test/integration/upgrade.test.ts` (create)

**Tasks:**
- [ ] Create `src/upgrade/platform.ts`:
  - Map `process.platform` + `process.arch` to asset names (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`)
  - Throw typed error on unsupported platform with clear message
  - Export `isCompiledBinary()`: detect if running as compiled Bun binary vs. Node/tsx source
- [ ] Create `src/upgrade/github.ts`:
  - `fetchLatestRelease()`: GET `/repos/calebmchenry/nectar/releases/latest` via `fetch()`
  - Parse response, extract `tag_name` (strip `v` prefix), find matching asset URL and `SHA256SUMS` URL
  - Handle: 404 (no releases), network errors, missing platform asset, empty assets list
  - Return `UpgradePlan` interface
- [ ] Create `src/upgrade/checksum.ts`:
  - `parseChecksums(text)`: parse `SHA256SUMS` format into `Map<assetName, hash>`
  - `verifyChecksum(filePath, expectedHash)`: compute SHA256 via `crypto.createHash('sha256')` with file streaming, compare
  - Handle: missing asset line, malformed checksums, empty file
- [ ] Create `src/upgrade/install.ts`:
  - `resolveBinaryPath()`: `fs.realpath(process.execPath)` — resolve symlinks
  - `stageDownload(url, targetDir)`: stream `fetch()` response to temp file in same directory as target binary; return temp path
  - `replaceBinary(tempPath, targetPath)`: `fs.stat` to capture permissions → `fs.rename(tempPath, targetPath)` (atomic, same filesystem) → `fs.chmod` to restore permissions
  - `cleanup(tempPath)`: remove temp file, used in `finally` blocks
  - Handle: EACCES with suggestion to use `sudo`, cross-device (temp file in target dir prevents this)
- [ ] Create `src/cli/commands/upgrade.ts`:
  - `registerUpgradeCommand(program)` following existing pattern
  - `--check` flag: fetch + compare + print, no download
  - `--yes` flag: skip confirmation prompt
  - Default mode: prompt via `readline` (detect non-TTY, stay pipe-friendly)
  - Guard: if `isCompiledBinary()` is false, print source warning and exit
  - Progress: use `ora` spinner during download
  - All themed output as specified in Architecture section
  - `finally` block ensures temp file cleanup on any exit path
- [ ] Register in `src/cli/index.ts`: import and call `registerUpgradeCommand(program)`
- [ ] Create `test/upgrade/platform.test.ts`:
  - Maps known platform+arch combos correctly
  - Throws on unsupported platform (e.g., `win32`)
  - `isCompiledBinary()` detects source vs. compiled correctly
- [ ] Create `test/upgrade/checksum.test.ts`:
  - Parses valid `SHA256SUMS` correctly
  - Returns true on match, false on mismatch
  - Handles missing asset line, empty file, malformed entries
- [ ] Create `test/integration/upgrade.test.ts` (local HTTP server):
  - Serve fake release JSON, binary assets, and `SHA256SUMS`
  - `--check` reports available version without modifying files
  - `--check` reports "up to date" when versions match
  - `--yes` replaces the file contents and preserves executable permissions
  - Checksum mismatch aborts before replacement
  - Network failure surfaces clean error message
  - No release (404) surfaces clean error message
  - Missing platform asset surfaces clean error message
  - Temp files cleaned up in all cases

### Phase 3: GitHub Actions CI/CD (~20%)

**Files:**
- `.github/workflows/ci.yml` (create)
- `.github/workflows/release.yml` (create)

**Tasks:**
- [ ] Create `.github/workflows/ci.yml`:
  ```yaml
  name: CI
  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]
  permissions:
    contents: read
  jobs:
    build-and-test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: '22'
        - run: npm ci
        - run: npm run build
        - run: npm test
    bun-smoke:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: '22'
        - uses: oven-sh/setup-bun@v2
        - run: npm ci
        - run: npm run build
        - run: bun build --compile src/cli/index.ts --outfile /tmp/nectar-smoke
        - run: /tmp/nectar-smoke --version
        - run: /tmp/nectar-smoke --help
  ```
- [ ] Create `.github/workflows/release.yml`:
  ```yaml
  name: Release
  on:
    push:
      tags: ['v*']
  permissions:
    contents: write
  jobs:
    release:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: '22'
        - uses: oven-sh/setup-bun@v2
        - run: npm ci
        - name: Inject version from tag
          run: NECTAR_VERSION="${GITHUB_REF_NAME#v}" node scripts/release/write-version.mjs
        - run: npm run build
        - run: npm test
        - name: Cross-compile binaries
          run: |
            mkdir -p dist
            bun build --compile --target=bun-darwin-arm64 src/cli/index.ts --outfile dist/nectar-darwin-arm64
            bun build --compile --target=bun-darwin-x64   src/cli/index.ts --outfile dist/nectar-darwin-x64
            bun build --compile --target=bun-linux-x64    src/cli/index.ts --outfile dist/nectar-linux-x64
            bun build --compile --target=bun-linux-arm64  src/cli/index.ts --outfile dist/nectar-linux-arm64
        - name: Generate checksums
          run: cd dist && sha256sum nectar-* > SHA256SUMS
        - name: Verify 5 release assets
          run: test $(ls dist/ | wc -l) -eq 5
        - name: Create GitHub Release
          run: gh release create "$GITHUB_REF_NAME" dist/* --generate-notes
          env:
            GH_TOKEN: ${{ github.token }}
  ```
- [ ] Pin all action versions (already pinned to `@v4` / `@v2`)
- [ ] Verify YAML validity via manual review or `actionlint`

### Phase 4: Install Script (~15%)

**Files:**
- `install.sh` (create)

**Tasks:**
- [ ] Create `install.sh` as POSIX shell script (`#!/bin/sh`, `set -eu`)
- [ ] Detect OS: `uname -s | tr '[:upper:]' '[:lower:]'` → `darwin` or `linux`; abort on other
- [ ] Detect arch: `uname -m` → normalize `x86_64` → `x64`, `aarch64` → `arm64`, `arm64` stays; abort on unsupported
- [ ] Compose asset name: `nectar-${OS}-${ARCH}`
- [ ] Determine install dir: `${NECTAR_INSTALL_DIR:-${HOME}/.local/bin}`; `mkdir -p`
- [ ] Create temp dir: `TMPDIR=$(mktemp -d)`; `trap 'rm -rf "$TMPDIR"' EXIT`
- [ ] Determine base URL: `${NECTAR_RELEASE_BASE_URL:-https://github.com/calebmchenry/nectar/releases/latest/download}`
- [ ] Download binary: `curl -fSL -o "$TMPDIR/$ASSET" "$BASE_URL/$ASSET"`
- [ ] Download checksums: `curl -fsSL -o "$TMPDIR/SHA256SUMS" "$BASE_URL/SHA256SUMS"`
- [ ] Verify checksum:
  - Compute: `shasum -a 256` (macOS) or `sha256sum` (Linux)
  - Extract expected from `SHA256SUMS`
  - Compare; abort on mismatch with clear message
- [ ] Install: `mv "$TMPDIR/$ASSET" "$INSTALL_DIR/nectar"` + `chmod +x`
- [ ] Extract version from binary: `"$INSTALL_DIR/nectar" --version 2>/dev/null || echo "unknown"`
- [ ] Print themed success message
- [ ] Print PATH hint if `$INSTALL_DIR` is not in `$PATH`
- [ ] Wrap all logic in `main()` function called at end of file (prevents partial execution from pipe)
- [ ] Validate with `shellcheck install.sh` — zero warnings

### Phase 5: README + Screenshot (~15%)

**Files:**
- `README.md` (create)
- `gardens/quick-start.dot` (create — simple garden that runs without API keys)
- `docs/assets/cli-demo.png` or `docs/assets/cli-demo.gif` (create)

**Tasks:**
- [ ] Create `gardens/quick-start.dot`: 3-node garden (start → tool → exit) using a simple shell command (e.g., `echo "Hello from Nectar"`), no LLM API keys required
- [ ] Write `README.md`:
  - `# 🐝 Nectar` with one-line tagline
  - MIT license badge
  - Screenshot/recording of themed CLI output
  - "What is Nectar?" — 1 paragraph
  - "Install" — `curl | sh`, manual download, verify
  - "Quick Start" — `gardens/quick-start.dot` content + `nectar run gardens/quick-start.dot` + example output
  - "Self-Update" — `nectar upgrade`, `nectar upgrade --check`
  - "Development" — clone, npm install, npm run build, npm test
  - "License" — MIT + link
  - Link to attractor spec
- [ ] Create terminal screenshot/recording:
  - Run `nectar run` on a garden that produces themed output
  - Capture as PNG or GIF in `docs/assets/`
  - Reference in README
- [ ] Verify quick-start garden runs successfully without API keys
- [ ] Verify README install instructions match actual `install.sh` behavior

### Phase 6: Integration Smoke + Final Validation (~10%)

**Tasks:**
- [ ] Verify `npm run build` passes
- [ ] Verify `npm test` passes — zero regressions
- [ ] Run `shellcheck install.sh` — zero warnings
- [ ] If Bun available locally: `bun build --compile src/cli/index.ts --outfile /tmp/nectar-test` and verify:
  - `/tmp/nectar-test --version` prints version
  - `/tmp/nectar-test --help` prints help
  - `/tmp/nectar-test upgrade --check` runs without crash (may report no releases)
- [ ] Verify `install.sh` with `NECTAR_RELEASE_BASE_URL` override against local server
- [ ] Review CI workflow YAML for correctness
- [ ] Review README for accuracy and completeness

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/release/write-version.mjs` | Create | Generates `src/generated/version.ts` from env var or package.json |
| `src/generated/version.ts` | Generated | Baked version constant (gitignored) |
| `src/cli/index.ts` | Modify | Import `NECTAR_VERSION`, register `upgrade` command |
| `src/upgrade/platform.ts` | Create | OS/arch → asset name mapping, compiled binary detection |
| `src/upgrade/github.ts` | Create | GitHub Releases API fetch, `UpgradePlan` construction |
| `src/upgrade/checksum.ts` | Create | `SHA256SUMS` parsing and SHA256 verification |
| `src/upgrade/install.ts` | Create | Binary staging, permission preservation, atomic rename-in-place |
| `src/cli/commands/upgrade.ts` | Create | Commander wiring, themed output, `--check`/`--yes` flags |
| `.github/workflows/ci.yml` | Create | Push/PR validation: build + test + Bun smoke compile |
| `.github/workflows/release.yml` | Create | Tag-driven cross-compile, checksums, GitHub Release |
| `install.sh` | Create | Portable install script with redirect URLs and checksum verification |
| `README.md` | Create | Public project landing page, install docs, quick-start |
| `LICENSE` | Create | MIT license |
| `gardens/quick-start.dot` | Create | Simple garden for README example (no API keys needed) |
| `docs/assets/cli-demo.png` | Create | Terminal screenshot/recording for README |
| `.gitignore` | Modify | Add `src/generated/` |
| `package.json` | Modify | Add `prebuild` hook for version generation |
| `test/upgrade/platform.test.ts` | Create | Unit tests for platform mapping and binary detection |
| `test/upgrade/checksum.test.ts` | Create | Unit tests for checksum parsing and verification |
| `test/integration/upgrade.test.ts` | Create | Integration tests with local fake release server |

---

## Definition of Done

### Build and Regression
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm test` passes — zero regressions from existing test suite
- [ ] `src/generated/version.ts` is generated correctly by `prebuild` hook

### Version Module
- [ ] `scripts/release/write-version.mjs` reads `NECTAR_VERSION` env var or falls back to `package.json`
- [ ] `src/generated/version.ts` is `.gitignore`d
- [ ] `src/cli/index.ts` has no hardcoded version string
- [ ] `nectar --version` prints the version from generated module

### Upgrade Command
- [ ] `nectar upgrade --check` reports available updates or "up to date"
- [ ] `nectar upgrade --check` handles no-releases-yet (404) gracefully
- [ ] `nectar upgrade` (default) prompts for confirmation via readline
- [ ] `nectar upgrade --yes` skips confirmation prompt
- [ ] Download shows progress indication (ora spinner)
- [ ] Checksum verification uses `SHA256SUMS` and is mandatory — no bypass flag
- [ ] Binary replacement is atomic (`fs.rename`, same filesystem, no `unlink` step)
- [ ] Permissions are preserved on replaced binary
- [ ] Running from source prints warning and exits without modifying files
- [ ] Network errors produce a clear, non-crashing error message
- [ ] Permission errors suggest `sudo` or relocation
- [ ] Checksum mismatch aborts with clear message and cleans up temp files
- [ ] Missing platform asset in release produces clear error
- [ ] Temp files are always cleaned up (success, failure, interrupt)
- [ ] Non-TTY output is plain text and pipe-friendly
- [ ] Themed output follows pollinator personality
- [ ] At least 10 unit tests + integration tests against local fake server

### CI/CD
- [ ] `.github/workflows/ci.yml` triggers on push to main and PRs
- [ ] CI runs: `npm run build` + `npm test` + host-platform Bun compile smoke
- [ ] Bun smoke test verifies `--version` and `--help` on compiled binary
- [ ] `.github/workflows/release.yml` triggers on `v*` tag push
- [ ] Release job: build + test gate → cross-compile 4 binaries → `SHA256SUMS` → GitHub Release
- [ ] Release uses `gh release create` with `--generate-notes` (no third-party actions for release)
- [ ] Release verifies exactly 5 assets before publishing
- [ ] Release workflow has `permissions: contents: write`; CI has `contents: read`
- [ ] Version is injected from tag via `write-version.mjs` before compilation

### Install Script
- [ ] `install.sh` exists in repo root, POSIX `sh` compatible (no bash-isms)
- [ ] Uses `mktemp -d` for temp files (not hardcoded `/tmp` paths)
- [ ] Uses redirect URLs — no GitHub API JSON parsing
- [ ] Detects OS (macOS, Linux) and arch (arm64, x64) correctly
- [ ] Downloads correct binary from latest GitHub Release
- [ ] Verifies SHA256 checksum; aborts on mismatch
- [ ] Installs to `$NECTAR_INSTALL_DIR` or `~/.local/bin` (created if needed)
- [ ] Prints themed success message with version
- [ ] Prints PATH hint if install dir is not in `$PATH`
- [ ] Wraps logic in `main()` function for pipe safety
- [ ] Cleans up temp files on error (trap)
- [ ] Honors `NECTAR_RELEASE_BASE_URL` for testing
- [ ] `shellcheck install.sh` passes with zero warnings

### README
- [ ] `README.md` exists with: elevator pitch, install, quick-start, self-update, dev setup, license
- [ ] Install instructions match actual `install.sh` behavior
- [ ] Quick-start garden runs without API keys
- [ ] Screenshot or terminal recording included
- [ ] MIT license badge present
- [ ] Link to attractor spec

### LICENSE
- [ ] `LICENSE` file exists in repo root with MIT license text

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Bun cross-compile produces non-functional macOS binaries from ubuntu-latest** | Medium | High | PR-level Bun smoke test catches host-platform issues. Test compiled binary on macOS before first public release. Cross-compile targets are well-documented in Bun docs. |
| **Binary size unexpectedly large (~50-90MB)** | Medium | Low | Expected for Bun-compiled binaries with embedded runtime. Document in README if relevant. Not a blocker. |
| **`process.execPath` doesn't resolve correctly in compiled binary** | Low | High | Bun's `process.execPath` returns binary path for compiled executables. Test explicitly in Bun smoke test. `isCompiledBinary()` guard prevents source-mode upgrade. |
| **Binary replacement interrupted mid-rename** | Low | High | `fs.rename` on same filesystem is atomic on POSIX. Temp file is in same directory as target. No `unlink` step eliminates the "no binary" failure window. |
| **GitHub API rate limiting** | Low | Medium | `install.sh` avoids the API entirely (redirect URLs). `nectar upgrade` makes 1-3 requests per invocation — well within the 60/hr unauthenticated limit. Clear error message on 429. |
| **Version drift between package.json, generated file, and git tag** | Low | Medium | Generated version file is canonical. CI derives from tag. `package.json` version is only used as fallback for local dev. |
| **install.sh partial execution from pipe interruption** | Low | Medium | `main()` function pattern — script body is parsed fully before execution begins. |
| **Running `nectar upgrade` from source replaces Node binary** | Medium | High | `isCompiledBinary()` guard detects source mode and refuses to run upgrade. Prints clear message suggesting `git pull`. |

---

## Security Considerations

- **Checksum verification is mandatory.** Both `install.sh` and `nectar upgrade` verify SHA256 before installing. No `--no-verify` bypass flag.
- **HTTPS only.** All downloads use HTTPS URLs to GitHub. No HTTP fallback.
- **No arbitrary code execution.** `install.sh` does not run the downloaded binary as part of installation (except optional version extraction after install).
- **Temp files use `mktemp -d`.** No hardcoded paths, no symlink race vulnerabilities.
- **`nectar upgrade` uses Node built-ins only.** `fetch()` and `crypto` — no shell-outs to `curl`/`shasum`/`mv`. Eliminates command injection and PATH manipulation risks.
- **Minimal CI permissions.** CI: `contents: read`. Release: `contents: write`. No third-party actions for release publishing — `gh release create` only.
- **`curl | sh` risk acknowledged.** Users who prefer auditing can `curl -o install.sh ... && less install.sh && sh install.sh`.

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `commander` | CLI framework for upgrade command | In `package.json` |
| `chalk` | Themed terminal output | In `package.json` |
| `ora` | Spinner for download progress | In `package.json` |
| Node.js `crypto` | SHA256 hash computation | Built-in (Node 22) |
| Node.js `fetch` | GitHub API + binary downloads | Built-in (Node 22) |
| Node.js `fs`, `path`, `os` | File operations, binary replacement | Built-in |
| Node.js `readline` | Interactive confirmation prompt | Built-in |
| Bun | Cross-compile in CI only | CI-only via `oven-sh/setup-bun@v2` |
| `gh` CLI | GitHub Release creation in CI | Pre-installed on GitHub runners |

**Zero new npm dependencies.** Upgrade command uses Node built-ins exclusively.

---

## Open Questions

1. **Symlink resolution policy:** When the installed `nectar` is a symlink, should `nectar upgrade` replace the resolved target or the symlink itself? **Recommendation:** Replace the resolved target via `fs.realpath()`. Document this behavior. Replacing the symlink would break the link relationship.

2. **`workflow_dispatch` for release rehearsal:** Should `release.yml` support manual trigger for dry runs? **Recommendation:** Defer. Use a fork or `act` for the first rehearsal. Add `workflow_dispatch` if the manual approach proves insufficient.

3. **Quick-start garden content:** Should it use an existing garden in `gardens/` or a dedicated `gardens/quick-start.dot`? **Recommendation:** Create a dedicated `gardens/quick-start.dot` — simple, documented, and decoupled from more advanced examples. Must not require API keys.
