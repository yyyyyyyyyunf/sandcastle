---
"@fly4ai/sandcastle": patch
---

Fix Docker sandbox shutdown always hitting the 7s bounded shutdown timeout. `removeContainer` used a bare `docker stop`, whose default 10s SIGTERM grace exceeds the shutdown budget, so any container whose PID 1 ignores SIGTERM (e.g. exec-form `sleep infinity`) deterministically failed with "Sandbox shutdown failed: Shutdown did not finish within 7 seconds". Stop with `-t 2` and force-remove instead. The Podman provider already force-removes and is unaffected.
