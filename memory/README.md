<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# memory — the long-term memory plane

The Python half of PrimusClaw: two services that let an agent remember across
sessions, and turn what happened in those sessions into a searchable knowledge
base.

| Component | What it does |
|---|---|
| [`memory-service`](memory-service) | Retrieval and persistence API. Stores agent memories and KB articles in a Claw-owned PostgreSQL, partitioned by a JSONB scope |
| [`knowledge-worker`](knowledge-worker) | Stateless ingestion worker. Reads raw session events and writes structured KB articles through the memory service's `/api/kb/*` contract |

`knowledge-worker` is a producer for `memory-service`; nothing flows the other
way, and they share no code.

## Both are optional

Claw runs without either. Long-term memory is gated behind
`CLAW_MEMORY_ENABLED`, which **defaults to `false`** — with the flag off, reads,
writes, and the decay cron all short-circuit, and Brain's `save_memory` tool
calls are discarded server-side with a `memory.write_skipped_flag_off` warning.
Existing rows are preserved while the flag is off, so turning it back on
restores prior behaviour.

If you are upgrading a deployment that relied on memory, you must set the flag
explicitly or the feature stops working silently. The same applies to
`CLAW_SKILL_EVOLUTION_ENABLED`. See [`../claw/.env.example`](../claw/.env.example).

## Install and test

```bash
pip install -e "memory/memory-service/.[dev,storage]"
pip install -e "memory/knowledge-worker/.[dev]"

pytest memory/memory-service/tests memory/knowledge-worker/tests
```

The `storage` extra is not optional for running the tests: without it collection
fails on missing `fastapi` / `asyncpg`. `make verify-python` from the repository
root runs both suites and tells you what to install if the packages are missing.

Coverage floors for these two trees are enforced in CI and documented in
[`../CONTRIBUTING.md`](../CONTRIBUTING.md#coverage-source-of-truth).

## Docs

Per-component detail lives in each directory's README, plus
[`memory-service/INTEGRATION.md`](memory-service/INTEGRATION.md) for wiring it
to Claw. The generated Python API reference covers `claw_memory` and
`knowledge_worker` — build it with `make verify-docs`.
