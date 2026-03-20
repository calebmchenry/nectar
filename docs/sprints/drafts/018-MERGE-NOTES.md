# Sprint 018 — Merge Notes

## Draft Strengths

### Claude Draft
- Best UX details: themed output messages for every state, specific error messages, effort percentages per phase
- Most granular DoD (35+ items organized by category)
- Detailed risk table with likelihood/impact ratings (8 risks)
- Comprehensive use cases covering 7 scenarios

### Codex Draft
- Best architecture: `src/upgrade/` boundary with 4 single-purpose modules + `UpgradePlan` interface
- Generated version file (`scripts/release/write-version.mjs`) — avoids sed fragility
- Redirect-URL-based install.sh — avoids GitHub API JSON parsing entirely
- Separate CI/release workflows with minimal permissions
- Strongest testing strategy: local fake release server for integration tests

### Gemini Draft
- Concise and scannable structure
- Good instinct on CI/release workflow split
- Correctly identified Bun compile smoke test on PRs
- Practical resolution of open questions

## Valid Critiques Accepted

1. **Binary replacement must be atomic** (all three critiques) — `fs.rename(temp, target)` on same filesystem, no `unlink` step. Claude's `unlink → rename` creates a failure window.
2. **install.sh must use `mktemp -d`** (Claude critique of Gemini) — hardcoded `/tmp` paths create symlink race vulnerability.
3. **install.sh should use redirect URLs** (Claude + Gemini critiques) — `releases/latest/download/{asset}` avoids all JSON parsing. Codex's approach wins.
4. **Use `gh release create` over `softprops/action-gh-release`** (Claude critique) — fewer supply chain dependencies, available on all runners.
5. **Separate CI and release workflows** (Codex + Gemini) — cleaner permissions, easier to reason about.
6. **Guard against running upgrade from source** (Codex critique) — must detect when running via Node/tsx and refuse to replace the Node binary.
7. **Use `SHA256SUMS` not `checksums.txt`** (Claude critique) — conventional name, self-documents the algorithm.
8. **Generated version file over sed** (Gemini + Codex critiques of Claude) — more robust, avoids GNU/BSD sed divergence.
9. **Add integration tests with local fake server** (Codex critique of Claude) — unit mocks are insufficient for network+filesystem operations.
10. **README must include screenshot/recording** (Codex critique) — INTENT.md Section 6 explicitly requires it.

## Valid Critiques Rejected

1. **Codex's three release scripts** — `build-targets.mjs` and `write-checksums.mjs` are ~10 lines each. Inline in workflow YAML. Keep only `write-version.mjs`.
2. **Codex's `build/release/` output directory** — unnecessary cognitive load. Use `dist/release/` to stay in the `dist/` family, or just `dist/` in CI since tsc output isn't needed after compile.
3. **`prebuild`/`pretest`/`prestart` hooks for version generation** — too aggressive, blocks new contributors. Use `prebuild` only; tests import the built output and `prestart` can generate on demand.

## Interview Refinements

1. **Versioning**: User chose generated file approach (Codex). Use `scripts/release/write-version.mjs`.
2. **CI scope**: User confirmed Bun smoke test on PRs.
3. **README scope**: User wants screenshot/recording included in sprint, not deferred.
