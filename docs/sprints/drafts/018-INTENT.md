# Sprint 018 — Intent Document

## Seed Prompt

Plan a sprint for releasing Nectar on GitHub. The requirements are defined in `docs/INTENT.md` Section 6 "Distribution & Publishing". The sprint should cover:

1. **Bun compile** setup for cross-platform standalone binaries (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
2. **GitHub Actions CI/CD** — on push/PR: build + test; on tag push: cross-compile + checksums + GitHub Release with auto-generated notes
3. **install.sh** convenience script that detects platform, downloads correct binary, verifies checksum
4. **`nectar upgrade`** command for self-update from GitHub Releases
5. **README.md** with elevator pitch, install instructions, quick-start example
6. **LICENSE** file (MIT)

## Orientation Summary

- **Project state**: Nectar v0.1.0, 17 sprints planned/completed. CLI uses Commander at `src/cli/index.ts`. Builds with `tsc`, tests with `vitest`. No CI, no README, no LICENSE, no upgrade command exist yet.
- **Recent direction**: Sprints 001–017 focused on attractor spec compliance (engine, handlers, agent loop, LLM client). Engine execution gaps are nearly closed.
- **Repo**: `github.com/calebmchenry/nectar` — remote exists, no GitHub Actions workflows.
- **Key constraint**: `docs/INTENT.md` Section 6 is prescriptive — bun compile, GitHub Releases (not npm), install.sh, `nectar upgrade`, SHA256 checksums, specific CI trigger rules.

## Relevant Codebase Areas

| Area | Path | Relevance |
|------|------|-----------|
| CLI entry point | `src/cli/index.ts` | Where `nectar upgrade` command gets registered; has hardcoded `version('0.1.0')` |
| Package config | `package.json` | Version field, build scripts, bin mapping |
| Existing commands | `src/cli/commands/` | Pattern for adding new commands (Commander subcommands) |
| Test suite | `test/` | Vitest tests; CI must run `npm test` |
| Build script | `npm run build` → `tsc -p tsconfig.json` | CI must run this for type checking |
| Sprint docs | `docs/sprints/` | Where the final sprint doc lands |

## Constraints

1. **Bun for compilation only** — the project develops with Node/npm/tsx but compiles to standalone binaries with `bun build --compile`. No bun dependency at dev time beyond the CI compile step.
2. **No npm publishing** — INTENT.md explicitly forbids it. Distribution is GitHub Releases only.
3. **Version must be baked in** — the compiled binary needs to know its version. Currently hardcoded in `src/cli/index.ts` and `package.json`. CI should derive version from the git tag.
4. **SHA256 checksums are mandatory** — every release must include a checksums file; both `install.sh` and `nectar upgrade` must verify.
5. **Cross-platform targets** (minimum): `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.
6. **Existing patterns**: CLI commands follow the `registerXCommand(program)` pattern in separate files under `src/cli/commands/`.

## Success Criteria

1. `npm run build` and `npm test` pass in CI on every push/PR to main.
2. Tagging `v*` triggers a release workflow that produces 4 platform binaries + checksums + a GitHub Release.
3. `curl -fsSL .../install.sh | sh` downloads and verifies the correct binary on macOS and Linux.
4. `nectar upgrade` checks for updates, downloads, verifies checksum, and replaces the binary in-place.
5. `nectar upgrade --check` reports available updates without installing.
6. Root `README.md` exists with install instructions, quick-start, and elevator pitch.
7. Root `LICENSE` (MIT) exists.

## Verification Strategy

- **CI workflow**: Push a test tag to a fork or use `act` locally to validate the release workflow.
- **Upgrade command**: Unit tests with mocked GitHub API responses. Integration test with a local HTTP server serving fake release assets.
- **Install script**: `shellcheck` lint + manual test on macOS and Linux (or Docker).
- **README**: Visual review.

## Uncertainty Assessment

| Factor | Level | Rationale |
|--------|-------|-----------|
| Correctness | **Low** | Well-defined requirements from INTENT.md Section 6; standard CI/CD patterns |
| Scope | **Low** | Bounded and enumerated — 6 concrete deliverables |
| Architecture | **Low-Medium** | Extends existing CLI pattern; GitHub Actions is new to the repo but standard; bun cross-compile is straightforward but may have edge cases |

## Open Questions

1. Should CI also run a `bun build --compile` smoke test on PRs (to catch compile failures before release), or only on tag push?
2. Version injection: should the tag-triggered CI replace the hardcoded version string at build time (e.g., sed or env var), or should the source read from a generated version file?
3. Should `nectar upgrade` support `--pre` for pre-release versions from the start, or defer that?
4. Does the install script need to handle existing installations (i.e., detect and warn about a previously installed nectar)?
