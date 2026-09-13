# Acceptance — AFK-P1

verdict: passed
required criteria: 3/3 · required gates: 3/3
coverage: 3/3 · failed: 0 · blocked: 0 · gap: 0 · none: 0

contract: P1 in the skills repository's approved implementation plan
plan: acceptance/plans/AFK-P1.md
code state: `9c8fef39bf18089716086a0730d2f269b0adaff6`, clean implementation checkpoint
provider changes: native noSandbox on macOS; other providers remain source compatible and explicitly report unsupported confirmed cancellation
environment: final checks observed Node v26.3.0, npm 11.16.0, Darwin 25.5.0. Earlier preparation recorded different Node/npm versions; these are the versions actually used for the final P1 checks.
proof-quality results: actual owned process trees, exit and post-return writes; positive merge plus negative shutdown gates. Repeated process-group diagnosis reproduced Darwin's transient EPERM outside the execution sandbox: nested probe 10/96 failed and minimal probe 5/96 failed, with only zombie members visible. After bounded polling until ESRCH, the original nested probe passed 96/96 and the permanent concurrent regression passed 64/64. EPERM is never treated as confirmed absence.

All raw paths below are relative to `acceptance/runs/AFK-P1/`.

| Criterion | Requirement | Expected result / reference                                                                                          | Proof and judge                                                                          | Outcome | Round | Evidence                                                                                                                                                                                 |
| --------- | ----------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-P1.1   | required    | Idle, abort and completion grace stop the invocation before returning                                                | Real shell/child/descendant PID and heartbeat assertions, program                        | pass    | 2     | `abort-red.log`, `abort-green.log`, `idle-red.log`, `idle-green.log`, `final-tests.log`; `src/run-cancellation.test.ts`                                                                  |
| AC-P1.2   | required    | TERM escalates when needed; unknown termination or failed shutdown prevents merge and preserves recoverable worktree | Resistant child marker, actual candidate commits and target/worktree assertions, program | pass    | 2     | `merge-shutdown-red.log`, `merge-shutdown-green.log`, `reaping-red.log`, `reaping-green.log`, `debug/probe-red.log`, `debug/minimal-red.log`, `debug/probe-green.log`, `final-tests.log` |
| AC-P1.3   | required    | Normal completion merges, trailing output survives and late cancellation does not affect another invocation          | Positive native run and provider exec regression, program                                | pass    | 2     | `normal-merge-red.log`, `normal-merge-green.log`, `final-tests.log`; `src/sandboxes/no-sandbox-cancellation.test.ts`                                                                     |

## Required gates

| Gate      | Outcome | Execution record                                                                                                  |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| Typecheck | pass    | `npm run typecheck`, exit 0, `final-typecheck.log`                                                                |
| Build     | pass    | `npm run build`, exit 0, `final-build.log`; includes Effect-free public declaration check                         |
| Test      | pass    | `npm test`, exit 0, `final-tests.log`: 55 files, 1465 passed, 2 Windows skips, 72.40 seconds; no unhandled errors |

`git diff --check` passed. No diagnostic instrumentation remains in runtime source. Finite diagnostic fixtures and their logs are retained explicitly under the ignored `debug/` evidence directory.

## Independent review

Standards and Spec reviewed from fixed P0 checkpoint `9862dca`, then reviewed repairs through `9c8fef3`. Resolved findings: stale timeout documentation, duplicated shutdown handling, tests decoding behavior from names, shutdown failure occurring after merge, and attempting branch detach through an already closed sandbox. Final Standards: zero remaining findings. Final Spec: zero remaining findings. Final full gates ran after these repairs.

## Reference artifacts and limits

Expected results come from the P1 contract; no comparative product baseline is required. The process model follows [Node child_process](https://nodejs.org/api/child_process.html#subprocesskillsignal). Darwin diagnosis is consistent with [XNU kern_sig.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c): zombie members are excluded from group signal permission traversal.

Windows termination and actual Docker/Podman/Daytona/Vercel runtimes were not executed and are not claimed as verified. Deliberate escape from the owned POSIX process group is outside this contract. No outstanding P1 action; P2–P8 remain pending.
