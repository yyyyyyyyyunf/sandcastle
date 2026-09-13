# Acceptance — AFK-P4

verdict: passed
required criteria: 4/4 · required gates: 3/3
coverage: 4/4 · failed: 0 · blocked: 0 · gap: 0 · none: 0

contract: P4 in the skills repository's approved implementation plan
plan: acceptance/plans/AFK-P4.md
code state: `b3c353c`, clean checkpoint (runtime/review fixes `853cb5d`)
environment: macOS, Node v26.3.0/npm 11.16.0, Git 2.50.1; native processes and temporary Git repositories
provider changes: none; no live container or Windows guarded-execution claim
proof quality: real negative controls exposed an accepted concurrent target update and missing termination-handler output. Repairs lock both source and target HEAD identities through checkout and seal output only after confirmed termination. Test budgets changed for composite Git cases under full-suite load; runtime bounds and assertions were retained.

Raw evidence paths below are relative to `acceptance/runs/AFK-P4/`.

| Criterion | Expected result                                                                                                              | Proof and judge                                              | Outcome | Evidence                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------- |
| AC-P4.1   | Checker sees the stopped candidate, durable evidence and complete output before merge at run/worktree/sandbox entries        | Real process/CLI and filesystem assertions, program          | pass    | `verification-red.log`, `checkpoint-tests.log`, `completion-red.log`, `output-green.log`, `accepted-tests.log` |
| AC-P4.2   | Accept merges the checked candidate; retain preserves clean source and stops before another agent                            | Public entries and actual Git refs, program                  | pass    | `checkpoint-tests.log`, `accepted-tests.log`                                                                   |
| AC-P4.3   | Source/target revision or symbolic HEAD changes and merge failures cannot deliver unchecked work                             | Real Git races and index-lock failure, program               | pass    | `race-red.log`, `locking.log`, `race-budget.log`, `accepted-tests.log`                                         |
| AC-P4.4   | Retain differs from malformed JSON, command failure and timeout; timeout/abort leave no continuing checker descendant writes | Native resistant child and PID/heartbeat assertions, program | pass    | `failures-red.log`, `failures-green.log`, `locking.log`, `accepted-tests.log`                                  |

Required gates: `npm run typecheck`, `npm run build`, `npm test` all exited 0 (`accepted-typecheck.log`, `accepted-build.log`, `accepted-tests.log`). Final suite: 65 files, 1521 passed, 2 Windows skips, 77.89 seconds. The 22 P4 cases cover public entries, early rejection, failures/races and complete output. `git diff --check` passed. Earlier full runs had one default five-second fixture timeout each; `fixture-budget.log` and `race-budget.log` preserve focused reruns before the final complete gate.

Independent review: Standards identified an incorrect error inheritance and a misplaced/misnamed Git reader; Spec reproduced missing SIGTERM-handler output during completion grace. All fixed in `853cb5d`, with both final reviews reporting zero remaining findings. The last checkpoint changes only a composite test budget and the existing patch changeset description.

No outstanding P4 actions. Guarded execution requires explicit merge-to-head, artifacts, confirmed POSIX ownership and Git 2.30+. Git plumbing does not invoke porcelain post-merge hooks; partial checkout/filesystem failure may require recovery from preserved source and journal. This does not claim power-loss atomicity. Native per-iteration preparation and structured-output extraction remain P6 work.
