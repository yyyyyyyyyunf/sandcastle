# AFK-P1 — Confirm execution termination

Readiness: ready. Starting implementation revision: `09292b7`. Contract: P1 in the skills repository's `docs/plans/afk-workflow-implementation.md`; agreed seams and gates: `docs/agents/acceptance.md`.

| Criterion | Execution and expected proof                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-P1.1   | Vitest at the provider exec and public run/orchestration seams. Owned shell/child/grandchild fixtures stop writing before idle, abort, or completion-grace returns.                                                                   |
| AC-P1.2   | A SIGTERM-resistant child requires escalation; cancellation waits for confirmation. A provider unable to confirm termination yields an explicit error and preserves its worktree instead of proceeding to merge or another iteration. |
| AC-P1.3   | Normal exit retains output including trailing lines; abort after a completed invocation does not affect a later invocation.                                                                                                           |

Use short finite fixtures, each with its own temporary directory and cleanup. Record red/green logs under `acceptance/runs/AFK-P1/`. Run affected Vitest files while implementing, then typecheck, build, full tests, independent code review, and this acceptance plan. macOS process-group behavior is exercised here; Windows native process termination is not claimed as executed. Existing provider interfaces remain source compatible; unsupported cancellation must be observable rather than silently treated as success.
