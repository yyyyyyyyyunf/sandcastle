---
"@fly4ai/sandcastle": patch
---

Count raw stdout and stderr chunks as agent activity before line buffering or output parsing, preventing false idle timeouts for partial lines and stderr-only output. Built-in providers forward raw activity; legacy provider line streaming remains compatible.
