# AFK-P0 — Environment and baseline

Readiness: ready. Dependency installation and acceptance configuration are in-scope preparation, now established. Starting commit: `e99f832f26dc9d245c019a9ddd19fa5dee792427`.

Contract: P0 in the skills repository's approved AFK implementation plan. Independent worktree on branch `codex/afk-workflow`; host CLI versions are recorded in that plan.

| Criterion | Execution and expected proof                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-P0.1   | Install with `npm ci`; execute `npm run typecheck`, `npm test`, `npm run build`; retain commands, exit status, totals, failures and skips under `acceptance/runs/AFK-P0/baseline/`              |
| AC-P0.2   | Existing noSandbox and lifecycle tests execute host commands and temporary Git repositories, using `src/testSetup.ts` isolation; establish their current results before adding regression tests |
| AC-P0.3   | Both repositories now have `docs/agents/acceptance.md`; write each work package's bound plan before editing its implementation                                                                  |

Baselines: existing regression-test results, not an old/new artifact comparison. New failure scenarios will have red/green evidence at their agreed seams. No application code is changed by P0. Required gates are the three commands above. The temporary project's real agent provider is not needed for this package.

Preparation findings: a first test invocation before building failed 72 tests (1375 passed, 2 skipped). After building, 49 tests failed (1398 passed, 2 skipped): macOS temporary path aliases disagreed with Git/shell physical paths, and generic Podman mocks implicitly assumed Linux. The P0 fixture repair canonicalizes the temporary root and makes Podman mock platforms explicit; it does not claim a runtime path-alias fix. The affected 10 files now pass (298 tests, 2 Windows-only skips). CLI baseline runs must follow build.
