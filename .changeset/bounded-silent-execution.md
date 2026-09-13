---
"@ai-hero/sandcastle": minor
---

Add executionTimeoutSeconds to run, worktree.run and sandbox.run as a fixed per-invocation deadline. Allow idleTimeoutSeconds: false for silent tools only with a finite execution deadline. Reject invalid and overflowing timer limits before execution and distinguish execution deadline errors from idle expiry.
