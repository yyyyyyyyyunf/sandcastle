# Acceptance — AFK-P6

verdict: passed
required criteria: 4/4 · required gates: 4/4
coverage: 4/4 · failed: 0 · blocked: 0 · gap: 0 · none: 0

contract: P6 in the skills repository's approved implementation plan
plan: acceptance/plans/AFK-P6.md
code state: `82183fc3a94ef1f2b8effbb3dd314947827f2c07`, clean checkpoint; runtime review fixes `314d2d0`
environment: macOS, Node v26.3.0/npm 11.16.0, Git 2.50.1, Backlog 1.51.0; native processes and temporary Git repositories
provider changes: none; no Windows guarded execution or live container claim
proof quality: public entry points, real owned processes and Git refs, installed shared workflow commands and real Backlog. No model calls. Filtered red/green diagnostics are not counted as full-suite coverage.

Raw evidence below is relative to `acceptance/runs/AFK-P6/`.

| Criterion | Expected result                                                                                                                                                                          | Proof and judge                                                                                                   | Outcome | Evidence                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| AC-P6.1   | Two dependent tasks are selected once each, verified and merged, then host preparation returns no-work without another agent                                                             | Public run with installed shared commands, actual Backlog/Git and scripted native agent; program assertions       | pass    | `final-integration.log`: 1 integration, two accepted tasks, three preparations, no remaining work |
| AC-P6.2   | First held/missing result and copy/record/cleanup faults prevent another allocation; blocked/no-work/iteration-limit are distinct                                                        | Public entry matrices and real filesystem/process failures; program assertions                                    | pass    | `final-tests.log`, `final-fixture.log`, `preparation-failures-green.log`                          |
| AC-P6.3   | Host identity, metadata, actual source/target/candidate revisions, results and earlier completed iterations remain attributable                                                          | Inline/file/worktree/nested-sandbox handoff tests; later extraction failure recovery; complete-output regressions | pass    | `final-tests.log`, `review-boundaries-green.log`, `guarded-regression.log`                        |
| AC-P6.4   | Existing Output extraction validates each result before checker/merge; failures retain raw output/source without retry; legacy output retains post-run semantics and recovery references | Structured schema/tag failures and explicit legacy output regression; program assertions                          | pass    | `final-tests.log`, `final-fixture.log`, `output-red.log`, `output-green.log`                      |

Required gates all exited 0: `npm run typecheck` (`final-typecheck.log`), `npm run build` (`final-build.log`, including public declarations free of Effect), `npm test` (`final-tests.log`), and `npx vitest run --config acceptance/fixtures/vitest.config.ts` (`final-integration.log`). Full suite: 69 files, 1561 passed, 2 existing Windows skips, 80.36 seconds. The P6 delta adds 40 package cases; the separate integration has no skips and uses `/Users/zongyf/.codex/skills/setup-agent-workflow/scripts/workflow.mjs` and its installed schema. `git diff --check` passed.

Initial no-work tests failed through unintended allocation (`preparation-red.log`). Prompt-expression mutation tests then exposed invocation against a changed startup baseline (`prompt-baseline-red.log`); both pass after rechecking immediately before the handoff. Independent Spec review reproduced two further gaps: terminal preparation decisions bypassed snapshot validation, and caller-owned APIs omitted preparation metadata. Six public regressions failed before repair (`review-red.log`); the final boundary run passed 25/25. The first review-green run retained two test-label expectation mistakes (`changed-no-work`/`changed-blocked` expected as error kinds); correcting the expectations to the documented `changed` kind required no runtime change.

Independent Standards review identified a legacy/native tag-documentation ambiguity and suggested a correctly named shared error extractor and complete handoff type. These are fixed in `314d2d0`. Its final test-table readability suggestion is fixed in `82183fc`. Final Standards and Spec reviews have no remaining findings.

The first real Backlog integration exposed a tracker detail: Git does not recreate empty `backlog/completed/` in a fresh worktree, and Backlog 1.51.0 `task complete` fails there until the directory exists. The integration explicitly proves absence, creates the directory, then collects TASK-1 and confirms TASK-2's dependency remains satisfied. This is a workflow instruction follow-up for P7, not a Sandcastle workaround. A subsequent test assertion used `task.filePath` instead of the actual `task.path`; the corrected full integration passes (`shared-integration-green.log`, `final-integration.log`). Both failed diagnostics remain available.

No outstanding P6 actions. Host preparation and extraction remain opt-in, require verification/artifacts and supported merge-to-head, and do not certify product acceptance by themselves. Legacy post-run retries are separate runs. P7 still needs generated setup/migration proof, and P8 still needs the packed public artifact and real Kimi execution; neither is claimed by these scripted-agent tests.
