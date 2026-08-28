<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Claw design docs

Design notes for the Claw harness. These describe intent and mechanism — the
code is the authority on current behaviour, and where the two disagree the code
wins.

| Document | What it covers |
|---|---|
| [`architecture-design.md`](architecture-design.md) | The API / Brain / Hands split, data stores, and how a session flows through them |
| [`agent-server-design.md`](agent-server-design.md) | The agent server surface: sessions, events, A2A, and the environment a run sees |
| [`agent-team-design.md`](agent-team-design.md) | Sub-agents and multi-agent coordination, agent cards, outbound host policy |
| [`builtin-tools-design.md`](builtin-tools-design.md) | The built-in tool set, including the web-fetch SSRF guard and its denylist |
| [`execution-template-design.md`](execution-template-design.md) | Execution templates: how a run's image, resources, and prompt are composed |
| [`memory-skill-evolution-design.md`](memory-skill-evolution-design.md) | Long-term memory and skill self-evolution, both behind feature flags |
| [`brain-graceful-upgrade.md`](brain-graceful-upgrade.md) | Draining and restarting Brain without losing in-flight runs |
| [`litellm-auto-routing-design.md`](litellm-auto-routing-design.md) | Complexity-based model routing through the LiteLLM gateway |
| [`plugins.md`](plugins.md) | The plugin format and the marketplace import path |
| `architecture.drawio` | Editable source for the architecture diagram |

## Documents referenced from the code but not published here

Several source comments cite design documents by filename and section — for
example `task-design.md §11.2` in `packages/api/src/routes/internal-tasks.ts`.
The documents below are **not part of this repository**, so those citations
point at nothing you can open. They are listed here so that grepping for one
gives an answer rather than silence.

| Referenced as | Subject | Where the behaviour actually lives |
|---|---|---|
| `task-design.md` | Task DAGs, batches, per-task auth, Backend-MCP routing | `packages/api/src/tasks/`, `src/routes/tasks.ts`, `src/routes/internal-tasks.ts`, `src/backend-mcp/` |
| `security-design.md` | Brain admin-route threat model (404-not-401 semantics) | `packages/brain/src/routes/admin.ts` — the rules are restated in that file's header |
| `system-env-design.md` | System-level encrypted env distribution | `packages/api/src/infra/nats.ts`, `src/infra/db.ts` |
| `user-env-vars-design.md` | Per-user env vars and the key-rotation playbook | `deploy/common.sh`, `deploy/values.example.env` |
| `session-env-design.md` | Session-scoped env validation | `packages/api/src/routes/sessions.ts` |
| `workspace-reaper-design.md` | Workspace GC and the reaper CronJob | `packages/brain/src/workspace/reaper.ts` |
| `workbench-architecture.md` | Workbench registry, routes and their types | `packages/api/src/workbenches/` |
| `checkpoint-architecture-redesign.md` | Run checkpointing and snapshot restore | `packages/brain/src/workspace/`, `packages/brain/src/tasks/` |
| `primus-claw-anthropic-managed-agents-sdk-compat-design.html` | Anthropic managed-agents SDK compatibility surface | `packages/api/src/routes/anthropic-managed-agents.ts`, `tests/run-anthropic-sdk-tests.sh` |
| `sse-v1-compat-removal.md` | Retirement of the v1 SSE compatibility mode | `packages/api/src/routes/events.ts` |

If you are adding a comment that cites a design document, cite one from the
first table, or describe the rule inline. A pointer to a document the reader
cannot obtain is worse than no pointer.
