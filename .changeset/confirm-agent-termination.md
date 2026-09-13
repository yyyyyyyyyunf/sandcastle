---
"@ai-hero/sandcastle": patch
---

Propagate exec cancellation to noSandbox process groups and wait for termination before returning from idle timeout, external abort, or completion grace. Stop outstanding exec invocations on close, escalate SIGTERM when needed, and preserve worktrees when termination or provider shutdown cannot be confirmed. Provider handles may opt into the confirmed cancellation contract; unsupported providers no longer treat completion grace as verified success.
