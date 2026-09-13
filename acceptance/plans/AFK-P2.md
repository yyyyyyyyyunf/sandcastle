# AFK-P2 — Activity and bounded silent execution

Readiness: ready. Implementation starts after P1 checkpoint `9c8fef3` passed its independent review and all required gates. Contract: P2 in the approved skills implementation plan. Seams and commands remain those agreed in `docs/agents/acceptance.md`.

| Criterion | Execution and expected proof                                                                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-P2.1   | Public run with a short real process producing raw stdout without newlines, stderr, or unparseable lines remains active. A fixed execution deadline still stops continuous output. Provider callback tests cover raw transport behavior without asserting private timer structure. |
| AC-P2.2   | Explicit disabled-idle mode requires a finite positive execution deadline, validated before allocation. A silent process may finish inside that budget; its mere existence never renews the budget.                                                                                |
| AC-P2.3   | Overdue silent execution stops its owned child process and post-return writes via P1; idle and execution errors are distinct, while completion grace retains its documented successful buffered-result semantics after confirmed termination.                                      |

API direction: optional raw `ExecOptions.onActivity`; `idleTimeoutSeconds: false` paired with `executionTimeoutSeconds`. Preserve numeric idle defaults and completion grace. Thread these options through `run`, worktree run and reusable sandbox run. Public invocation fixtures use real temporary Git and finite owned processes; provider SDK transport mocks verify callback forwarding but do not claim live remote cancellation.

One behavior slice at a time: red evidence, minimum repair, green evidence under `acceptance/runs/AFK-P2/`. Then independent Standards/Spec review and typecheck → build → full tests. No model calls are needed for P2.
