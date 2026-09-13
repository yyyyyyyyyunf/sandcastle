# Native prepared iterations

The workflow needs one shared preparation/checking implementation across projects. A project supplies configuration and a native Sandcastle entry; it should not reimplement iteration control in an outer JavaScript runner.

Before allocation, a bounded host command receives a host-generated iteration ID and exact target snapshot. Run/no-work/blocked decisions carry opaque metadata. Sandcastle binds that decision through startup, gives the agent the actual source identity, and records preparation separately from agent execution. Metadata, tracker semantics and acceptance judgement belong to the shared workflow command.

`iterationOutput` reuses Output extraction before verification and merge. The host seals raw output first, saves validated output for the checker, records the decision, merges the checked SHA and finishes cleanup before the next preparation. Every failure stops progression and carries recovery references. No implicit retry resumes a previous ticket. With preparation, a completion token controls agent shutdown grace; it cannot declare an empty queue.

Legacy `output` stays a separate single-iteration API. Its required typed result cannot represent a valid zero-agent run, and its automatic session resumption would cross task boundaries in a queue. Its final extraction errors gain recovery references, while its existing post-run semantics remain documented separately.

The exported `WORKFLOW_PROTOCOL_VERSION = 1` lets generated entries reject unsupported package artifacts before invoking an agent. The version covers preparation JSON, handoff context and per-iteration extraction/verification ordering. It does not certify installed shared commands, model authentication or project acceptance capabilities.

Alternatives rejected: an unbounded callback without process ownership; a per-project outer loop; parsing blocked/held from stdout completion tokens; forcing legacy output into an optional value for every existing caller. Host commands share one owned transport with strict JSON, output bounds and cancellation deadlines. Existing unprepared iteration behavior remains compatible.
