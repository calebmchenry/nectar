# Sprint 018: Distribution & Publishing (Nectar Release)

## Overview

Sprint 018 focuses on packaging and releasing Nectar as a standalone, cross-platform CLI tool. Based on the requirements in `docs/INTENT.md` Section 6, this sprint transitions the project from a local Node/TypeScript development environment to distributable binaries using `bun build --compile`. It introduces GitHub Actions for continuous integration and automated releases, provides a convenient `install.sh` script, and adds a `nectar upgrade` command for self-updating. Additionally, it establishes the project's public-facing foundation with a `README.md` and an MIT `LICENSE`.

## Use Cases

- **As a user**, I want to install Nectar with a single command (`curl ... | sh`) so I don't have to configure a Node.js environment.
- **As a user**, I want to update my existing Nectar installation to the latest version by running `nectar upgrade`, without manually downloading files.
- **As a contributor**, I want my pull requests to automatically run build and test checks via CI to ensure code quality.
- **As a maintainer**, I want to publish a new release for all supported platforms simply by pushing a semantic version git tag (`v*`).

## Architecture

- **Cross-Compilation**: We will use `bun build --compile` exclusively in the CI environment to package the TypeScript source (`src/cli/index.ts`) into standalone binaries. Development remains on Node/npm/tsx. Target platforms are `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`.
- **CI/CD Pipeline**: GitHub Actions will host two workflows:
  1. `ci.yml`: Runs `npm run build` and `npm test` on pushes and PRs to `main`. It will also include a `bun build --compile` smoke test to catch compilation issues early.
  2. `release.yml`: Triggers on `v*` tags. It writes the tag version into the codebase, cross-compiles the 4 targets, generates a SHA256 checksums file, and publishes a GitHub Release with auto-generated release notes.
- **Installation Script**: `install.sh` will be a portable shell script that detects `process.platform` and `process.arch` equivalent, downloads the correct binary and checksum file from the latest GitHub Release, verifies the checksum, and installs it into a local bin directory (e.g., `~/.local/bin`).
- **Self-Update Mechanism**: The `nectar upgrade` command will use the GitHub Releases API to compare its baked-in version with the latest release. It will download the new asset and checksum, verify the SHA256 hash, write the new binary to a temporary file, and perform a rename-in-place (`fs.renameSync`) to safely overwrite the currently running executable.

## Implementation (Phased)

### Phase 1: Foundation
1. **LICENSE**: Create `LICENSE` file with the MIT License.
2. **README**: Create `README.md` with:
   - One-paragraph elevator pitch.
   - Installation instructions (using the upcoming `install.sh` and manual steps).
   - Quick-start example (simple `.dot` file and run command).
   - CLI screenshot/recording emphasizing the pollinator theme.
   - Link to attractor specs.

### Phase 2: CI/CD Workflows
1. **CI Workflow (`.github/workflows/ci.yml`)**:
   - Trigger on `push` to `main` and `pull_request`.
   - Steps: Setup Node, `npm ci`, `npm run build`, `npm test`.
   - Setup Bun, run a dry-run `bun build --compile src/cli/index.ts` to ensure the codebase compiles successfully.
2. **Release Workflow (`.github/workflows/release.yml`)**:
   - Trigger on `push` tags matching `v*`.
   - Steps: Checkout, Setup Node, Setup Bun.
   - Inject version: write the tag name to a static file (e.g., `src/version.ts`) so it's baked into the binary.
   - Run `bun build --compile` for the 4 target platforms.
   - Generate `checksums.txt` using `shasum -a 256`.
   - Create GitHub Release, attach binaries and `checksums.txt`.

### Phase 3: Install Script
1. **`install.sh`**:
   - Create the script in the repository root.
   - Detect OS (`uname -s`) and Architecture (`uname -m`).
   - Map to asset names (e.g., `nectar-darwin-arm64`).
   - Fetch latest release metadata from GitHub API to determine version.
   - Download binary and `checksums.txt` using `curl`.
   - Verify hash using `shasum -c` or `sha256sum -c`.
   - Move to installation directory, ensuring executable permissions (`chmod +x`).
   - Output themed success message.

### Phase 4: Upgrade Command
1. **`src/cli/commands/upgrade.ts`**:
   - Implement `checkUpdate()` using `https` to fetch `/repos/<org>/nectar/releases/latest`.
   - Add flag handling: `--check` (report only), `--yes` (skip confirm).
   - Implement `downloadAndVerify()`: fetch asset, fetch checksum, stream to temp file, compute hash.
   - Implement `replaceBinary()`: determine current executable path (`process.argv[0]` or similar), rename downloaded temp file over the current executable.
2. **`src/cli/index.ts`**:
   - Refactor hardcoded version to import from `src/version.ts` (which defaults to '0.1.0-dev' locally).
   - Register the `upgrade` command.
3. **Tests**:
   - Add unit tests for version comparison and GitHub API response parsing.
   - Add integration tests using a mocked HTTP server for the download/verification flow.

## Files Summary

- `docs/sprints/drafts/018-GEMINI-DRAFT.md` (This file)
- `README.md` (New)
- `LICENSE` (New)
- `.github/workflows/ci.yml` (New)
- `.github/workflows/release.yml` (New)
- `install.sh` (New)
- `src/version.ts` (New, for baking in the version)
- `src/cli/commands/upgrade.ts` (New)
- `src/cli/index.ts` (Modified: register command, use dynamic version)
- `test/cli/upgrade.test.ts` (New)

## Definition of Done

- [ ] `npm run build` and `npm test` pass in CI on every push/PR to main, alongside a bun compile smoke test.
- [ ] Tagging a `v*` commit triggers the release workflow, producing 4 binaries + checksums + a GitHub Release.
- [ ] `curl -fsSL .../install.sh | sh` successfully downloads and verifies the correct binary on macOS and Linux.
- [ ] `nectar upgrade` checks for updates, verifies the checksum, and correctly replaces the binary in-place.
- [ ] `nectar upgrade --check` reports available updates without making changes.
- [ ] Root `README.md` exists with installation instructions, quick-start, and elevator pitch.
- [ ] Root `LICENSE` (MIT) exists.

## Risks

- **In-place Upgrade Permissions**: If Nectar is installed in a system directory (e.g., `/usr/local/bin`) by `sudo`, a normal user running `nectar upgrade` will face permission denied errors. The command must handle this gracefully, suggesting the user rerun with `sudo` or relocate the binary.
- **Bun Compilation Edge Cases**: While pure ESM code generally compiles well with Bun, there could be hidden runtime issues with specific Node APIs when bundled. The CI smoke test helps mitigate this.
- **API Rate Limiting**: Unauthenticated calls to the GitHub API (used by `nectar upgrade`) are heavily rate-limited. This might affect users frequently running `--check`. We should ensure caching or informative error messages.

## Security

- **Checksum Verification**: Both `install.sh` and `nectar upgrade` MUST verify the downloaded binary against the `checksums.txt` file provided in the GitHub Release. This is critical to prevent the execution of tampered binaries.
- **HTTPS Enforcement**: All downloads from GitHub must strictly use `https://`.
- **Script Piping Safety**: `install.sh` will be piped directly to `sh`. It must be robust, avoiding partial execution failures by wrapping the main logic in a function executed at the end of the script.

## Dependencies

- **Bun**: Used strictly in GitHub Actions for `bun build --compile`. No runtime or dev-time dependency locally.
- **Commander**: Existing dependency, used for the new `upgrade` command.
- **Native Node APIs**: `fs`, `https`, `crypto`, `os`, `child_process` (no external libraries needed for the upgrade command).

## Open Questions Resolved

1. **Smoke Test**: Yes, CI will run a `bun build --compile` smoke test on PRs to catch compilation failures before they reach the release branch.
2. **Version Injection**: The tag-triggered CI will replace a placeholder in a new `src/version.ts` file at build time, ensuring the compiled binary knows its exact release version without relying on `package.json` at runtime.
3. **Pre-release Support**: We will defer `--pre` flag support for pre-releases to a future sprint to keep the initial implementation scoped and simple.
4. **Install Script Overwrite**: The `install.sh` script will detect an existing installation and overwrite it, but will print a clear warning/notice before doing so.
