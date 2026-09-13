---
"@ai-hero/sandcastle": minor
---

Add optional artifact directory export and a persistent per-run JSON record to run, worktree.run and sandbox.run. Snapshot declared repository-relative evidence into unique host attempt directories before merge/cleanup, record candidate and merged commits, and stop with recovery references if export or recording fails. Support noSandbox and shared bind mounts; isolated providers report this mode as unsupported.
