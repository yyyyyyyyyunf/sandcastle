---
"@fly4ai/sandcastle": patch
---

Retain all preserved worktree references across iterations, including later failures and cleanup errors. The legacy single-path field now identifies the most recently preserved worktree even if a subsequent iteration was clean.
