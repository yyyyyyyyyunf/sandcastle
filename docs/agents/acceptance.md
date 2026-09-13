# Acceptance

The current AFK reliability delivery is governed by the approved cross-repository plan in the skills repository, `docs/plans/afk-workflow-implementation.md`, and its three ADRs. The development worktree is `/private/tmp/afk-sandcastle-work`; the fork's original checkout is not the test fixture.

## Proof and gates

- Use Vitest through the existing `src/**/*.test.ts` discovery and `src/testSetup.ts` Git-config isolation.
- Agreed seams: sandbox/provider exec, public `run()`/worktree execution and lifecycle, real temporary Git repositories, observable child-process exit/write behavior, and structured workflow check commands. Scripted agent/provider fixtures avoid model calls until the final integration stage.
- Tests for timeout must observe the owned process tree and writes after return, not merely a rejected Promise. Fixtures reclaim only their own processes and temporary state even when testing the old leaking behavior.
- Required gates: `npm run typecheck`, `npm run build`, `npm test`, in that order when testing CLI changes or a fresh checkout: CLI tests execute `dist/main.js`. Start with affected Vitest files during implementation; run full gates before delivery.
- New behavior uses expected outcomes in P1–P6. Existing regression tests prove preserved behavior; no comparative screenshot/performance baseline is required.
- Independent code review precedes acceptance. No extra final human-approval gate is required.
- Real integration uses the public exports of a local `npm pack` artifact in a temporary Kimi/noSandbox/Backlog project. It does not publish to npm or operate formal project queues.

## Artifacts and capabilities

Committed plans: `acceptance/plans/`; committed reports: `acceptance/reports/`; committed baselines if needed: `acceptance/baseline/`. Raw evidence is gitignored under `acceptance/runs/<delivery>/<run-id>/`.

Development dependencies are installed from `package-lock.json` during P0. Record Node/npm versions per delivery: the shell selects different versions in the skills checkout and this temporary worktree (P4 here used Node 26.3.0; P5 in skills used Node 24.21.0). Windows/provider compatibility is covered by applicable tests; unexecuted platform/runtime checks remain explicitly unverified. Actual Kimi authentication is rechecked in P8.

For P6, also run `npx vitest run --config acceptance/fixtures/vitest.config.ts`. This explicit integration gate requires installed Backlog and the shared setup-agent-workflow skill (default `~/.codex/skills/setup-agent-workflow`, override `SANDCASTLE_WORKFLOW_SKILL_DIR`). Missing capabilities fail the gate; it is separate from the portable package suite and is never silently skipped. It uses scripted native agents and real Backlog/Git, not model calls. P8 separately proves the packed artifact with Kimi.
