# Completion timeout: stop a hanging process after the completion signal

Updated by AFK-P1: grace expiry requests termination and waits for confirmation before returning buffered output. A failed or unsupported termination stops the lifecycle and preserves the worktree. The original decision below explains the grace window; its former process-abandonment behavior is superseded.

When an agent emits the completion signal but its process does not exit — because a child it spawned (a subprocess like `gh`, or a long-lived MCP server) holds the sandbox exec's stdout open so EOF never arrives — Sandcastle previously hung until the full idle timeout (default 10 minutes) and then _failed_ the iteration with `AgentIdleTimeoutError`, discarding the already-committed work from the result. We now scan the agent's accumulated output stream for the completion signal and, once it is seen, replace the idle timeout with a one-minute **completion timeout**; if the process is still silent when that expires, we complete the iteration _successfully_ (collecting commits via the normal path) and warn that the process is **hanging**. A clean process exit within the window still completes normally, so healthy runs are unaffected and gain no added latency.

## Considered alternatives

- **Short-circuit on the agent's terminal stream event** rather than the signal string. Rejected: no reliable terminal event exists across providers. Claude Code emits a single terminal `result` event, but Sandcastle synthesizes a `result` event for _every_ agent message for Codex (`AgentProvider.ts:551`) and OpenCode (`715`), so keying on it would terminate those agents after their first message. Building a real per-provider terminal event is larger work than this bug warrants.
- **Kill the process immediately on signal detection.** Rejected: useful data trails the signal — Codex's token usage rides on `turn.completed`, Claude Code's canonical `result` text comes last, and a run using both completion signal and structured output may emit the `<tag>` payload after the marker. The silence-based window captures trailing output before giving up.

## Scope

The completion timeout is gated strictly on the completion signal. A process that hangs _before_ any signal is emitted is indistinguishable from an agent genuinely stuck mid-work, so it still rides the full idle timeout and fails.

## Consequences

The original implementation abandoned the hanging process, leaking no-sandbox children and potentially collecting commits while they were still being written. AFK-P1 replaces that behavior with confirmed cancellation. POSIX noSandbox exec owns a process group, applies bounded TERM/KILL escalation, and waits for the group to exit; normal EOF also checks for background children. Deliberately detached sessions are outside this contract. Windows and providers that have not opted into `supportsExecCancellation` report the capability gap on cancellation. Provider shutdown errors retain their causes and preserve the worktree.

The Effect race discards its losing fiber's errors, so termination failures are retained by the sandbox service and checked after the race. Sending a signal or observing the shell's exit alone does not establish that its descendants stopped. References: [Node child process](https://nodejs.org/api/child_process.html#subprocesskillsignal), [Windows taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill).

On Darwin, a group containing only unreaped zombies can transiently return EPERM: the kernel excludes zombies from its group signal count. Termination therefore continues bounded polling on EPERM; only ESRCH confirms absence. A real permission failure remains an unknown-termination error at the deadline. The owned-process diagnostic reproduced this in 10/96 nested and 5/96 direct invocations, with only `Z` members at failure. Reference: [XNU group signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c).
