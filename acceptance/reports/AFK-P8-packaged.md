# Acceptance — AFK-P8 packaged integration

verdict: passed
required criteria: 4/4 · required gates: 8/8
coverage: 4/4 · failed: 0 · blocked: 0 · gap: 0 · none: 0

contract and binding plan: skills repository `docs/plans/afk-workflow-implementation.md` and `acceptance/plans/AFK-P8.md`
code state: clean Sandcastle `9679cb9d8dee35d90209c0a9d371b8aadbc5bbec`, accepted executable `82183fc3a94ef1f2b8effbb3dd314947827f2c07`; no Sandcastle code changed during P8. Final skills/proof checkpoint `14cc1ec`, shared executable `3c5227f`.
provider changes: none; actual public package, Kimi 0.42.0, adapter 0.1.1, host OAuth `kimi-code/k3`, Node 24.21.0, noSandbox, Backlog 1.51.0 on macOS.
proof quality: positive installed-package/run proofs and nine package/identity corruption controls passed; the previous run fails the stricter commit-order assertion. Final tests distinguish pre-implementation behavior in independent historical replay.

The complete cross-repository acceptance, failure ownership, exact task history, session evidence and reproducible host commands are in [the skills P8 report](/Users/zongyf/Documents/code/mine/skills/acceptance/reports/AFK-P8-packaged.md). This report records the owning Sandcastle repository's results. Local raw paths below are under `acceptance/runs/AFK-P8/`.

| Criterion | Required expected result                                                                                                                                                 | Proof and judge                                                                                                | Outcome | Round | Evidence                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------- | ----- | --------------------------------------------------------------------------------- |
| AC-P8.1   | Two dependent real tasks complete implementation, independent review, acceptance and committed terminal state through the packaged native entry                          | Kimi session exports, exact CLI assertions, Backlog/Git observations / program, with independent model reviews | pass    | 2     | `run-3-task-{1,2}-observed.json`, `run-3-final-tests.log`, full exports in skills |
| AC-P8.2   | Public package identity; correct attempts/targets/candidates/merges; persistent report/evidence; two accepted iterations, three preparations, no-work and source cleanup | Byte, integrity, Git and hash assertions plus isolated corruption controls / program                           | pass    | 2     | `order-package-identity.json`, `run-3-proof.json`, `run-3-controls.log`           |
| AC-P8.3   | Preserve original demo/fork/adapter and historical migration records; no formal queue migration                                                                          | Executed skills P7 migration proof and final original Git assertions / program                                 | pass    | 0     | `original-checkouts-final.json`, skills P7 report                                 |
| AC-P8.4   | Preserve failures, repair the actual owner, rerun affected gates and finish a successful complete real chain                                                             | Earlier failed-run archives, final regression gates and native completed run / program                         | pass    | 2     | skills P8 report and archives; local gate logs and final observations             |

## Required gates

All eight gates exited 0. Sandcastle typecheck, build and full tests ran in the prescribed order against the unchanged built source.

| Gate                                                           | Result / evidence                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                            | pass, `typecheck.log`                                                                         |
| `npm run build`, including public declarations                 | pass, `build.log`                                                                             |
| `npm test`                                                     | 69 files, 1561 passed, 2 existing Windows-only skips, 85.35 seconds; `tests.log`              |
| `npx vitest run --config acceptance/fixtures/vitest.config.ts` | one real Git/Backlog/shared-command test passed, 11.63 seconds; `shared-integration.log`      |
| Skills shared Node test suite after `14cc1ec`                  | 51 passed, zero skipped, 134.72 seconds; skills `order-repair-skills-tests.log`               |
| Skills integrity hook after `14cc1ec`                          | pass; skills `order-repair-integrity.log`                                                     |
| Final trial `npm test`                                         | 10 passed, zero skipped; `run-3-final-tests.log`                                              |
| Final trial `git diff --check`                                 | pass; `run-3-final-diff-check.log`, clean status independently asserted in `run-3-proof.json` |

## Package and actual native run

Local package remains version 0.12.0. `npm pack --ignore-scripts` followed the explicit build. Tarball SHA-256 is `2e299c3f8835507056effa42589852dce34852602c766043728e00fa27becf40`. Built, packed and installed distributions have the same 61 regular files and bytes, the npm lock integrity matches the tarball, and the actual public import resolves inside the installed package with workflow protocol capability 1. No source/dist links are used by the trial.

Final project `/private/tmp/afk-order-trial-ca_lb8qg/repo`, branch `native-order-trial`, ended clean at `33511116247b948d1931327ee525f53e898b9159`. Run `763aeaa8-5d54-407c-afec-446210e0c342` lasted 1505.64 seconds, from `2026-09-13T12:35:07.294Z` to `2026-09-13T13:00:12.934Z`. Configuration used explicit merge-to-head, max 3 iterations, idle timeout disabled with a finite 3600-second execution limit, 60-second completion grace and 30-second shared-command deadline.

TASK-1 attempt `5fb459cc-502d-4210-ab63-e53d7da105c3` was judged at `2cba864` and accepted/merged at `9568439`. TASK-2 attempt `048ec3b6-59a8-45c4-a072-a85e73644c7a` started from exactly that target, was judged at `866a2ce` and accepted/merged at `3351111`. Both plans and test specs are strict ancestors of their judged implementations. Both source worktrees were removed; declared evidence remained readable with matching hashes. The third preparation returned no-work without allocating another agent.

The two real sessions each contain two completed independent review contexts. The final CLI tests cover preservation, uppercase and JSON behavior, both switch orders and quoted-name escaping. Actual TDD behavior is proved by red-state replay and final green tests; TASK-1 did not explicitly call the TDD Skill tool, and its observation records that fact. Usage and elapsed time for the probe and all three runs are retained in `usage-observations.json` without claiming a billing estimate.

## Repairs and scope

Run 1 hit the trial's 900-second bound during TASK-2 finalization. Native termination completed, TASK-2 was not merged, its dirty worktree/evidence survived, and retained-work startup was rejected. The repeat used the setup template's existing finite 3600-second deadline. Run 2 passed transport and cleanup but failed its frozen requirement that tests precede the judged implementation commit. Skills implement/review and the host proof were repaired; the final complete run passes that stronger unchanged requirement. Neither observation required another Sandcastle modification during P8.

Package preparation and proof-observer failures, their original logs and successful repairs are accounted for in the full report. Final independent Standards/Spec reviews of skills/proof `14cc1ec` have zero remaining findings; Sandcastle's accepted P1–P6 reviews remain applicable. Original demo, fork checkout and adapter revisions/status are unchanged.

## Reference artifacts

The approved P8 plan and final trial ticket/plans define the expected behavior. Existing named regression assertions prove preservation; no visual/performance baseline is required. Skills P7's actual migration fixture supplies historical configuration/evidence preservation.

## Outstanding actions

None in the approved P0–P8 scope. This proves the serial macOS/Kimi/noSandbox/Backlog integration and the earlier deterministic failure scenarios. It does not establish universal agent success, host isolation, every provider/platform or other tracker integration. The package has not been published and formal projects have not been migrated.

## None

This report is documentation of the unchanged tested executable state.
