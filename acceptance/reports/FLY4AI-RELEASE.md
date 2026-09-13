# Acceptance — fly4ai release preparation

verdict: passed
required criteria: 5/5 · required gates: 6/6
coverage: 5/5 · failed: 0 · blocked: 0 · gap: 0 · none: 0

contract: user requested both main merges, refreshed local main and skill links, and the `fly4ai` package scope; publication was subsequently reserved to the user
plan: [FLY4AI-RELEASE](../plans/FLY4AI-RELEASE.md)
code state: Sandcastle `d1633b9`, including scope checkpoint `730454c`; skills `0f7066d`. Both were clean, on their local main branches and equal to origin/main after non-forced pushes. This report is a subsequent documentation-only commit.
provider changes: none; Node 24.21.0, npm, installed Changesets, local tarball, temporary install directory. No model invocation or npm publication.
proof-quality results: exact equality of 61 distribution files across source, tarball, direct install and compatibility alias; existing initializer assertions and full regression suite; public import and Kimi type compatibility checks. Historical P8 evidence remains unchanged.

Raw Sandcastle evidence is under `acceptance/runs/FLY4AI-RELEASE/` in the development worktree `/private/tmp/afk-sandcastle-work`. Skills link/integrity evidence is under the same relative directory in `/Users/zongyf/Documents/code/mine/skills`.

| Criterion | Required expected result                                                                                             | Proof / judge                                                                                            | Outcome | Evidence                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| R1        | `@fly4ai/sandcastle` 0.13.0, fork repository metadata, public npm configuration and existing changesets in changelog | Manifest/lockfile/changelog and tarball assertions / program                                             | pass    | `version.log`, `pack.json`, `package-identity.json`                                              |
| R2        | New scope in current templates, executable examples and docs; runtime regression checks pass                         | Existing InitService assertions, packaged CLI init, public import / program                              | pass    | `tests.log`, `init.log`, `cli-version.log`, `package-smoke.json`                                 |
| R3        | Skills retain capability checks and provide a working Kimi peer compatibility path                                   | Integrity, installed npm graph, public provider construction and TypeScript assignability / program      | pass    | skills `integrity.log`; `dependencies.log`, `adapter-types.log`, `package-smoke.json`            |
| R4        | Both remote/local main branches include delivery; skills links point at the updated local checkout                   | Non-forced Git pushes, local/remote tracking equality, clean state and resolved symlink checks / program | pass    | `main-delivery.json`; skills `links.json`, `link-skills.log`                                     |
| R5        | User controls publication                                                                                            | Release trigger inspection and executed-command record / program                                         | pass    | `.github/workflows/release.yml` has only `workflow_dispatch`; no publish or release tag executed |

## Required gates

| Gate                                                   | Result                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Sandcastle `npm run typecheck`                         | pass, `typecheck.log`                                                                   |
| Sandcastle `npm run build` including public type check | pass, `build.log`                                                                       |
| Sandcastle `npm test`                                  | pass, 69 files, 1561 passed / 2 existing Windows-only skips, 84.07 seconds; `tests.log` |
| Skills `bash .githooks/pre-commit`                     | pass, skills `integrity.log`                                                            |
| Sandcastle `git diff --check`                          | pass before push; clean main independently recorded                                     |
| Skills `git diff --check`                              | pass before push; clean main independently recorded                                     |

Final independent Standards and Spec reviews of the release diff both report zero remaining findings. There was no additional test-before-implementation requirement for this packaging task. The existing AFK behavior is preserved by the full regression suite; P8 already records actual Kimi execution.

## Installed artifact and compatibility

`fly4ai-sandcastle-0.13.0.tgz` was packed from the built source and copied into the raw evidence directory. SHA-256: `f5c6cf979dce3b50855d3925f3183ed1f38b8f99e44d7c2f50733589bd9af795`. Its 64 files comprise 61 distribution files plus package metadata, README and license. The installed lockfile integrity matches the packed SHA-512 for both dependency names.

Fixture: `/private/tmp/fly4ai-release-e27bjdhh/project`. npm installed the scoped dependency and Kimi 0.1.1 using the old peer name as a local tarball alias of the same fork. `npm ls --all` exited 0, and Kimi's returned provider type is assignable to the scoped package's `AgentProvider`. Public import exposes workflow protocol 1; noSandbox constructs successfully. No agent was launched. After publication, the documented registry equivalent is `@ai-hero/sandcastle@npm:@fly4ai/sandcastle@^0.13.0`, alongside the direct scoped dependency.

The package's actual initializer generated `.sandcastle/main.ts` with imports from the new scope. As documented by setup, the initializer's supported Docker/Claude scaffold was used without execution or image building; the programmatic noSandbox/Kimi providers were checked separately. CLI output reports 0.13.0. Observation scripts and fixture manifests are retained with the evidence.

Two fixture-command assumptions were corrected and retained: the first offline install inherited a company registry whose response was absent from the cache, so the successful command explicitly selected the public registry; the first init call requested no-sandbox, which is not in the initializer menu, so the successful call used the supported placeholder scaffold. Neither required a product change. The inherited package-lock root version was stale at 0.6.5; package and lockfile metadata now agree at 0.13.0.

## Git and links

Skills main advanced from `0ebb852` to `0f7066d`; Sandcastle fork main advanced from `e99f832` to `d1633b9`. Both local main branches were updated, without force pushing. `scripts/link-skills.sh` exited 0: 32 skills linked into `~/.agents/skills` and `~/.claude/skills`, and all 64 links resolve to this skills checkout. No non-link skill directories existed at the destinations.

GitHub returned no CI runs for this fork at the time of inspection; no remote CI pass is claimed. The required local gates above passed. The release workflow is manual, and the pending npm login was cancelled when the user took ownership of publication.

## Reference artifacts

Expected results are defined by the user request and the linked plan. Existing regression assertions prove preserved behavior. No visual or performance baseline is required; old acceptance reports retain their original package identities.

## Outstanding actions

None within code preparation and Git delivery. The user owns npm organization/login setup and publication. No npm package, Git release tag or GitHub release was created by this task.

## None

This report records delivery and does not alter packaged behavior.
