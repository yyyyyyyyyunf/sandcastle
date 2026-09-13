# Acceptance — AFK-P3

verdict: passed
required criteria: 4/4 · required gates: 3/3
coverage: 4/4 · failed: 0 · blocked: 0 · gap: 0 · none: 0

contract: P3 in the skills repository's approved implementation plan
plan: acceptance/plans/AFK-P3.md
code state: `f3d4442ae492a5a3d9765d2b06fd68e5b912746f`, clean checkpoint
environment: macOS, Node v26.3.0/npm 11.16.0. Real noSandbox execution and temporary Git repositories; shared host export is available for bind mounts, without claiming live container proof. Isolated artifact mode rejects before agent execution.
proof quality: real failures preceded repairs, including lost earlier recovery paths, deleted clean failed evidence, missing cleanup-error paths, recursive root aliases, and caller-owned evidence deleted by close. Actual worktree deletion and readable remaining snapshots are asserted. Branch-only commits are not reported as merged.

Raw evidence paths are relative to `acceptance/runs/AFK-P3/`.

| Criterion | Requirement / expected result                                                                                                   | Proof and judge                                                       | Outcome | Evidence                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| AC-P3.1   | All preserved worktrees survive later clean/failed iterations in public result/error; legacy path is latest preserved           | Real Git/native process, program                                      | pass    | `paths-red.log`, `paths-green.log`, `error-paths-red.log`, `error-paths-green.log`, `review-green.log`                   |
| AC-P3.2   | Separate snapshots remain readable after cleanup at run/worktree/sandbox entries                                                | Two iterations with different contents, actual close/removal, program | pass    | `artifacts-red.log`, `handles-artifacts-red.log`, `multi-corrected.log`, `review-green.log`                              |
| AC-P3.3   | Invalid mappings, aliases, copy/record/cleanup failure preserve source and stop allocation                                      | Filesystem faults and alias paths, program                            | pass    | `faults-red.log`, `faults-green.log`, `alias-root-red.log`, `alias-root-green.log`, `review-red.log`, `review-green.log` |
| AC-P3.4   | Journal contains candidate/actual merge revisions, completed attempts, error and recovery references; persistence failure stops | Read persisted JSON against Git state, program                        | pass    | `record-red.log`, `record-green.log`, `failed-evidence-red.log`, `failed-evidence-green.log`, `review-green.log`         |

Required gates: `npm run typecheck` and `npm run build` exited 0 (`review-final-typecheck.log`, `review-final-build.log`); declarations remain Effect-free. `npm test` exited 0: 61 files, 1499 passed, 2 Windows skips, 72.97 seconds (`review-final-tests.log`). The final focused P3 suite has 12 passing cases. Initial fixture typing/setup mistakes and their corrected runs remain in raw logs. `git diff --check` passed.

Independent review: Spec found evidence roots inside removable worktrees and false merge records. Standards also found the merge issue and repeated recovery deduplication. All repaired in `f3d4442`; both final reviews report zero remaining findings. No outstanding P3 action.

The run journal describes orchestration; legacy post-run structured-output retry semantics remain unchanged until P6. Caller-owned worktrees record `caller-owned`; a later explicit close is outside that run's cleanup record. This proves process-lifecycle persistence, not Git/filesystem atomicity under power loss. P4–P8 remain pending.
