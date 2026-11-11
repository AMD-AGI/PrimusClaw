<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Claw — the agent harness

The agent orchestration platform of PrimusClaw: an API / Brain / Hands service
triad that runs autonomous agent sessions inside per-session sandboxes, backed
by NATS JetStream, PostgreSQL, and S3-compatible object storage. It is an
npm-workspaces monorepo that builds into a single container image serving three
roles. The repository root [`README.md`](../README.md) shows how Claw fits with
the personal agent and the connector; this file is the working guide for the
tree itself.

## Architecture

```
                     HTTPS / SSE
                          │
                          ▼
                 ┌─────────────────┐
                 │   Claw API      │  Fastify · sessions, events, memory,
                 │  (packages/api) │  skills, plugins, MCP, admin, A2A
                 └────────┬────────┘
                          │ publish task / subscribe events
                          ▼
                 ┌─────────────────┐
                 │   Claw Brain    │  agent loop · LLM calls · tool
                 │ (packages/brain)│  routing · SaFE sandbox lifecycle
                 └────────┬────────┘
                          │ MCP (bootstrap + tool calls)
                          ▼
                 ┌─────────────────┐
                 │   Claw Hands    │  per-session SaFE sandbox pod
                 │ (packages/hands)│  MCP tool server (fs / exec / patch)
                 └─────────────────┘

Shared: NATS JetStream (task queue + event bus) · PostgreSQL (state) ·
S3 / MinIO (workspace sync) · Anthropic / LiteLLM gateway (LLM)
```

One container image, three roles selected by the entrypoint's first
argument (`api` / `brain` / `hands`) — see
[`deploy/README.md`](deploy/README.md).

## Workspaces

| Package | Role |
|---|---|
| [`packages/utils`](packages/utils) | Domain-free helpers safe for every role, including the in-sandbox one: KV abstraction, secret redaction, constant-time compare, env settings |
| [`packages/protocol`](packages/protocol) | The api↔brain contract: shared types, NATS subject builders, sandbox env composition, and the coordination protocols (run leases, task consumer, sandbox handle map, Hands parking) |
| [`packages/hands`](packages/hands) | The MCP tool server that runs *inside* the sandbox (fs / shell / s3 tools) |
| [`packages/brain`](packages/brain) | The agent loop: LLM calls, tool routing, sub-agents, sandbox lifecycle, workspace↔S3 sync. Pulls tasks from one durable JetStream consumer, `brain-workers`, which the API provisions and every replica shares; whichever replica has capacity takes the next task |
| [`packages/api`](packages/api) | The public Fastify server: sessions, events, memory, skills, plugins, MCP, admin, A2A, task DAGs |

Build order is `utils → protocol → {hands, brain, api}`, and `npm run build
--workspaces` relies on the order declared in [`package.json`](package.json):
each package consumes its dependencies' emitted `.d.ts`, so a package must be
listed after everything it imports.

`hands` runs inside the sandbox. It depends on `utils` and `protocol`, but takes
from `protocol` only the contract it shares with Brain: background-shell records
and their classification, reclaim causes and reap grace bounds, and the Hands
credential header. `protocol` has no dependency other than `utils`, and `hands`
opens no NATS or database connection.

## Build and run

```bash
npm ci
npm run build          # tsc, all workspaces in dependency order

cp .env.example .env   # then fill in the required values
                       # incl. USER_ENV_ENCRYPTION_KEY=$(openssl rand -base64 32);
                       # on a single-node NATS set NATS_REPLICAS=1
./scripts/start-all.sh # hands + brain + api in one terminal
```

`start-all.sh` and `stop-all.sh` read `/proc` and use `ss`/`pgrep`, so they are
**Linux-only**. On macOS, start the three services individually with `npm run
dev --workspace packages/<name>`.

Per-package scripts: `dev` (tsx watch), `build` (tsc), `typecheck`, `test`.

## Try it without any infrastructure

```bash
npm ci && npm run build
./examples/hands-mcp/run.sh
```

Runs Hands against a throwaway workspace over the real MCP transport — no
cluster, GPU, LLM key, or network egress. See
[`examples/hands-mcp`](examples/hands-mcp/README.md). `make demo` from the
repository root runs the same script.

## Tests

```bash
npm test                                  # all workspaces
npm test --workspace packages/brain       # one workspace
```

Tests are `node:test` suites under `packages/*/test/`, run through `tsx`. Note
that each package's `tsconfig.json` includes `src` only, so `npm run typecheck`
covers the sources but not the test files themselves.

`tests/` at this level is a separate thing: ad-hoc `.mjs` scripts that drive a
running stack through the Anthropic SDK. They need a deployed environment and
are not part of `npm test`.

## Layout

```
claw/
├── packages/               # the five workspaces above
│   ├── utils/              # domain-free helpers (kv/, security/, env settings)
│   ├── protocol/           # shared types, NATS subjects, sandbox/ coordination
│   ├── hands/              # in-sandbox MCP tool server
│   │   └── src/tools/      # fs/, shell/, s3/ tool implementations
│   ├── brain/              # agent-loop engine
│   │   ├── src/agent/      # agent loop, engine adapters, prompt, hooks, HITL
│   │   ├── src/tasks/      # task runner, dispatch, locks, gates
│   │   ├── src/delivery/   # doorbell intake, claim-next, delivery dispatch
│   │   ├── src/clients/    # hands, MCP, A2A, run-claim clients
│   │   ├── src/workspace/  # snapshot sync, reaper, S3 upload
│   │   └── src/sandbox/    # SaFE sandbox client
│   └── api/                # public API server
│       ├── src/routes/     # sessions, events, memory, skills, plugins, mcp, admin, a2a, tasks
│       ├── src/sessions/   # dispatch, teardown, context, sweepers
│       ├── src/marketplace/  # plugins, skills, evolution
│       └── src/infra/      # db, nats, metrics, leader lock, schema guard
├── deploy/                 # deploy guide (README.md), Helm chart (charts/claw/, the single source
│                           # for all K8s manifests), deploy.sh / upgrade.sh / build.sh (Kaniko or
│                           # local Docker), entrypoint
├── docs/                   # design docs — see docs/README.md for the index
├── examples/               # runnable examples
├── scripts/                # start-all.sh / start-{api,brain,hands}.sh / stop-all.sh, plugin
│                           # migration scripts, and the CI lint invariants
├── tests/                  # SDK-level scripts against a deployed stack
├── Dockerfile              # one image; entrypoint dispatches on api / brain / hands
└── .env.example
```

## The lint scripts are architectural invariants

`scripts/lint-*.sh` are not style checks. Each encodes a rule that a normal
review misses — that workspace code must not call Hands directly without a
timeout, that every prom-client metric is registered, that session events are
redacted before persistence, that tenant routes authorize, that Brain's drain
path is guarded on shutdown. CI runs all five; so does `make verify-lint`.

## Private CA anchors

The published images trust the public CA set and nothing else. If your LLM
gateway, SaFE endpoint, or object storage is behind a TLS-intercepting proxy or
signed by a corporate CA, rebuild with your anchors:

```bash
docker build \
  --build-arg EXTRA_CA_CERT_URLS="https://host/root.crt https://host/issuing.crt" \
  -t claw:local .
```

The URLs are fetched at build time and installed into the runtime trust store,
which `NODE_EXTRA_CA_CERTS` then points at. Empty by default: an anchor baked
into a published image widens what that image accepts for everyone who runs it,
so it has to be an explicit choice by whoever builds it. Use content-addressed
URLs — a commit SHA or a digest — since whoever controls the ref controls what
TLS the image will trust. PEM or DER is accepted, because a Windows AD CS PKI
publishes DER at the CertEnroll URL its own certificates advertise. A URL that
cannot be fetched, or that returns something that is not a certificate in
either encoding, fails the build rather than being skipped.

This is the supported alternative to `tls.insecureSkipVerify` in the Helm
chart, which turns off certificate verification for *every* outbound connection
and is only for diagnosing a trust-store problem.

## Deployment

```bash
docker build -t claw:local .
docker run --env-file .env claw:local api     # or: brain / hands
```

To deploy or upgrade prebuilt images in the `primus-claw` Kubernetes namespace:

```bash
bash deploy/deploy.sh                    # first-time Claw-only install
bash deploy/upgrade.sh -n primus-claw    # rolling upgrade
```

See [`deploy/README.md`](deploy/README.md) for Docker and Kubernetes, and
[`../deploy/README.md`](../deploy/README.md) for the whole-stack installer
(Agent Sandbox, Claw and LiteLLM in one command).

## Reserved Workspace Paths

A session's `/workspace` is yours except for the names below, which the
platform owns. Pick another name for your own data: what happens to a file you
create under one of these is decided by the platform's lifecycle for that name,
not by yours, and nothing warns you at the time.

Dropped from the snapshot — a file you create here is not carried into your
next sandbox and will not be there when the session is rehydrated:

| Path | Owner |
|------|-------|
| `.uploads/` | Files uploaded through the API (`POST /v1/sessions/:id/upload`), put into the sandbox when a run attaches to it, including one already running; expired on their own schedule |
| `.transcripts/` | Per-run transcripts Brain writes straight to object storage |
| `.tool-results/` | Whole tool outputs too long for the conversation, kept for the agent to page through |
| `.deliveries/` | Copies of the files the agent handed you with `deliver_file` |
| `.hands-binary` | Bootstrap artefact from older releases |
| `hands.log` | The agent runtime's own log, truncated at every launch |

Reserved but still restored — these are snapshotted to object storage and
handed back to the next sandbox, so a file you put here survives; it is simply
kept and expired on the platform's terms, and the API's file listing hides the
directory from the frontend:

| Path | Owner |
|------|-------|
| `.zip-cache/` | Archives built for download; expired on their own schedule |
| `.skills/` | Per-session skill state; excluded from the shared-filesystem snapshot only, because the sandbox image provides it |

Regenerable content is also left out of the snapshot for size rather than
ownership, and will simply be rebuilt: `node_modules`, `.task-venv`,
`.cache`, `.runtime`, `__pycache__`, `torchinductor_*`, `hsa`, `worktree`, and
object files (`*.o`, `*.co`). The full list is `WORKSPACE_EXCLUDES` in
[`claw/packages/brain/src/workspace/excludes.ts`](packages/brain/src/workspace/excludes.ts).

A repository's `.git` is **not** regenerable -- it holds commits that exist nowhere
else until they are pushed -- so it is carried with the rest of the workspace and a
sandbox rebuilt from the snapshot is still a repository. It is carried whole or not
at all: a `.git` over `WORKSPACE_GIT_MAX_BYTES` (default 300 MiB) or
`WORKSPACE_GIT_MAX_FILES` (default 2000) is left out, and so are the largest of a
workspace's repositories once they add up to more than
`WORKSPACE_GIT_TOTAL_MAX_BYTES` (1 GiB) or `WORKSPACE_GIT_TOTAL_MAX_FILES` (10000).
Either snapshot destination reports it in a `workspace_git_skipped` sandbox event; push
before leaving such a repository. A repository left out of a sync, or one the sandbox
cannot measure in `WORKSPACE_GIT_PROBE_TIMEOUT_SEC` (default 60; 8 on a SIGTERM sync),
does not stop the sync and does not lose its history: the rest of the workspace is saved
and that repository keeps the copy the last snapshot held. Git's own lock and temporary
files are not carried. `WORKSPACE_GIT_MAX_BYTES=0` turns `.git` snapshots off.

## Key Environment Variables

See [`.env.example`](.env.example) for the full list.

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `NATS_URL` / `NATS_USER` / `NATS_PASSWORD` | Task queue + event bus |
| `AUTH_INTERNAL_TOKEN` | Shared secret for Brain↔Hands / Brain↔API / SaFE auth |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `DEFAULT_MODEL` | LLM gateway |
| `SAFE_API_URL` / `SANDBOX_NAMESPACE` | SaFE sandbox platform |
| `LITELLM_API_BASE` / `SAFE_DEFAULT_WORKSPACE` | Defaults embedded in GEAK/Hyperloom prompts; MCP callers can pass `api_base` explicitly |
| `WORKSPACE_PERSIST_BASE` / `CLAW_DEPLOY_ROOT` | Optional shared workspace persistence and Hands distribution; empty values use S3/Brain HTTP fallbacks |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | Workspace object storage |
| `A2A_AGENTS` / `A2A_PEER_TOKEN_*` | The only peer agents Brain's `a2a_call` tool may reach, by name (a name list, or a JSON array whose `auth_env` names a variable starting with `A2A_PEER_TOKEN_`). Unset, `a2a_call` has no peers. **Breaking:** `a2a_call` no longer accepts a URL or sends the user's key to a peer; see `CHANGELOG.md` |
| `API_PORT` / `EXECUTOR_PORT` / `MCP_PORT` | Service listen ports (api / brain / hands) |
