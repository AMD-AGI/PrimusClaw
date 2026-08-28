# PrimusClaw

[![Tests](https://github.com/AMD-AGI/PrimusClaw/actions/workflows/tests.yml/badge.svg)](https://github.com/AMD-AGI/PrimusClaw/actions/workflows/tests.yml)
[![Lint](https://github.com/AMD-AGI/PrimusClaw/actions/workflows/lint.yaml/badge.svg)](https://github.com/AMD-AGI/PrimusClaw/actions/workflows/lint.yaml)
[![Build](https://github.com/AMD-AGI/PrimusClaw/actions/workflows/build.yaml/badge.svg)](https://github.com/AMD-AGI/PrimusClaw/actions/workflows/build.yaml)
[![CodeQL](https://github.com/AMD-AGI/PrimusClaw/actions/workflows/codeql.yml/badge.svg)](https://github.com/AMD-AGI/PrimusClaw/security/code-scanning)

PrimusClaw is an LLM agent orchestration system: an API / Brain / Hands service
triad that runs autonomous coding-agent sessions inside per-session sandboxes,
backed by NATS JetStream, PostgreSQL, and S3-compatible object storage.

The agent harness is called **Claw** and lives under [`claw/`](claw), an
npm-workspaces monorepo. The repository also carries the components Claw runs
against — see [Repository layout](#repository-layout).

## Prerequisites

Claw delegates authentication and sandbox workload placement to **SaFE**
(AMD's Secure Agent Fabric/Environment platform, published separately as
[AMD-AGI/Primus-SaFE](https://github.com/AMD-AGI/Primus-SaFE)). Everywhere this
README says "SaFE sandbox", that is the system meant. `SAFE_API_URL` is
**required for any production deployment**, and the API fails closed without it.

You do not need SaFE to evaluate the project:

| What you want to do | What you need |
|---|---|
| Exercise the tool-execution layer end to end | Node 26. Run `make demo` — no cluster, GPU, LLM key, or network egress |
| Run api / brain / hands locally | Node 26, PostgreSQL, NATS, S3-compatible storage, an LLM gateway |
| Install the full stack on a cluster | The above, plus Kubernetes and a SaFE endpoint |
| Install on an **isolated** cluster with no SaFE | `deploy/deploy.sh --insecure-sandbox`, which turns authentication **off entirely** — never on a shared or reachable cluster |

Claw requires **Node 26**, a Current release rather than an LTS.

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
[`deploy/README.md`](claw/deploy/README.md).

## Packages

| Package | Path | Description |
|---------|------|-------------|
| **api** | `packages/api` | Public-facing Fastify server: sessions, events (SSE), memory, skills, plugins, MCP, admin, A2A, task DAGs. Persists to PostgreSQL, publishes tasks to NATS. |
| **brain** | `packages/brain` | Core agent-loop engine: LLM calls, tool routing/resolution, sub-agents, SaFE sandbox lifecycle, workspace↔S3 sync. Consumes tasks from NATS as a pull-consumer (auto-sharded across replicas). |
| **hands** | `packages/hands` | MCP tool server that runs *inside* the per-session SaFE sandbox (fs / exec / patch tools). Brain talks to it over MCP/HTTP. |
| **protocol** | `packages/protocol` | The api↔brain contract: shared types, NATS subject builders, sandbox env composition, and the coordination protocols (run leases, task consumer, sandbox handle map, hands parking). |
| **utils** | `packages/utils` | Domain-free helpers, safe for every role including the in-sandbox one: KV abstraction, secret redaction, constant-time compare, env settings. |

Dependency order is `utils → protocol → {hands, brain, api}`. `hands` deliberately
depends on `utils` only: it runs inside the sandbox and must not reach the
control-plane protocol.

## Repository layout

| Path | Language | What it is |
|------|----------|------------|
| [`claw/`](claw) | TypeScript | The agent harness: `api` / `brain` / `hands` npm workspaces, Helm chart, design docs. |
| [`sandbox/`](sandbox) | Go | SaFE sandbox control plane — a fork of [`sigs.k8s.io/agent-sandbox`](sandbox/UPSTREAM.md) that provisions the per-session pods Brain drives. |
| [`memory/`](memory) | Python | Long-term memory plane: `memory-service` (retrieval API) and `knowledge-worker` (ingestion). |
| [`deploy/`](deploy) | — | Whole-stack installer that chains the per-component deploy scripts, plus deployment packaging for the upstream LiteLLM gateway. Each component also keeps its own `deploy/`. |
| [`docs/`](docs) | — | Sphinx site for the **Python** packages only. TypeScript and Go docs live next to their code. |
| [`scripts/`](scripts) | — | Repo-wide release verification. Per-component scripts live in each component. |

## Claw package structure

```
claw/
├── packages/
│   ├── utils/           # domain-free helpers (kv/, security/, env settings)
│   ├── protocol/         # shared types, NATS subjects, sandbox/ coordination
│   ├── hands/             # in-sandbox MCP tool server
│   │   └── src/tools/      # fs/, shell/, s3/ tool implementations
│   ├── brain/             # agent-loop engine
│   │   ├── src/agent/       # agent loop, engine adapters, prompt, hooks, HITL
│   │   ├── src/tasks/        # task runner, dispatch, locks, gates
│   │   ├── src/delivery/      # doorbell intake, claim-next, delivery dispatch
│   │   ├── src/clients/        # hands, MCP, A2A, run-claim clients
│   │   ├── src/workspace/       # snapshot sync, reaper, S3 upload
│   │   └── src/sandbox/          # SaFE sandbox client
│   └── api/                # public API server
│       ├── src/routes/       # sessions, events, memory, skills, plugins, mcp, admin, a2a, tasks
│       ├── src/sessions/      # dispatch, teardown, context, sweepers
│       ├── src/marketplace/    # plugins, skills, evolution
│       └── src/infra/           # db, nats, metrics, leader lock, schema guard
├── deploy/
│   ├── README.md            # deploy guide (Docker + one-click K8s)
│   ├── charts/claw/          # Helm chart — single source for all K8s manifests
│   └── deploy.sh / upgrade.sh / build.sh   # Kaniko or local Docker
├── docs/                      # design docs (architecture, agent-server, plugins, ...)
├── scripts/                     # plugin migration/lint scripts
│   └── start-all.sh / start-api.sh / start-brain.sh / start-hands.sh / stop-all.sh
├── Dockerfile                    # single image, entrypoint dispatches by role
└── .env.example
```

## Quick Start (local dev)

```bash
cd claw
npm install
npm run build              # builds all workspaces (tsc)

cp .env.example .env
# fill in DATABASE_URL, NATS_URL, ANTHROPIC_AUTH_TOKEN, S3_*, SAFE_API_URL,
# AUTH_INTERNAL_TOKEN, and USER_ENV_ENCRYPTION_KEY (`openssl rand -base64 32`)
#
# Against a single-node `nats-server -js`, also set BRAIN_REGISTRY_REPLICAS,
# BRAIN_CHECKPOINTS_REPLICAS and SYSTEM_ENV_REPLICAS to 1 — JetStream refuses
# replicated buckets outside a cluster, and the API exits provisioning them.

./scripts/start-all.sh              # starts hands, brain, api together (one terminal)
# or individually: ./scripts/start-api.sh / ./scripts/start-brain.sh / ./scripts/start-hands.sh
```

Per-package scripts (`npm run <script> --workspace packages/<name>`):
`dev` (tsx watch), `build` (tsc), `typecheck`, `test`.

## Try it without a cluster

`make demo` runs the Hands MCP server — the layer that actually edits files and
runs commands for an agent — against a throwaway workspace and drives it over the
real MCP transport. No Kubernetes, no GPU, no LLM API key, no network egress.
See [`claw/examples/hands-mcp`](claw/examples/hands-mcp/README.md).

## Verifying the repository

`make verify` from the repository root builds and tests every tree — TypeScript,
Go, Python and the docs — plus the lint and license checks. It mirrors CI, so a
green run should mean a green pull request. `make help` lists the per-tree
targets if you only need one of them.

### Docker

```bash
cd claw
docker build -t claw:local .
docker run --env-file .env claw:local api     # or: brain / hands
```

### Kubernetes

Deploy or upgrade prebuilt images in the `primus-claw` namespace — see
[`claw/deploy/README.md`](claw/deploy/README.md).

```bash
bash claw/deploy/deploy.sh       # first-time Claw-only install
bash claw/deploy/upgrade.sh -n primus-claw  # rolling upgrade
```

### Standalone Stack

For Kubernetes standalone mode, the repository also provides a top-level
orchestrator that always installs Agent Sandbox and Claw. LiteLLM is installed
by default and can be skipped with `--skip-litellm`:

```bash
# Production: Sandbox authentication is mandatory.
SAFE_API_URL=https://safe.example.com bash deploy/deploy.sh --yes

# Preview without mutating cluster state where child installers support it.
SAFE_API_URL=https://safe.example.com bash deploy/deploy.sh --dry-run

# Load reusable, non-secret environment settings from a profile.
cp deploy/profile.example.env /tmp/primus-claw-deploy.env
bash deploy/deploy.sh --config /tmp/primus-claw-deploy.env --dry-run

# Install only the required Sandbox + Claw components.
SAFE_API_URL=https://safe.example.com bash deploy/deploy.sh --yes --skip-litellm

# Isolated development cluster only: explicitly acknowledge no Sandbox auth.
bash deploy/deploy.sh --yes --insecure-sandbox
```

The public profile contains no credentials; inject those through Kubernetes
Secrets, Vault, CI, or an ignored Claw `values.<NAMESPACE>.env` file. The
LiteLLM wrapper lives under [`deploy/litellm`](deploy/litellm/README.md), and its
Helm chart lives under [`deploy/litellm/charts/litellm`](deploy/litellm/charts/litellm).
Provide provider/model routing through a private Helm values file.
`LITELLM_DATABASE_URL` is optional when the wrapper can discover Claw's PGO
database, and `LITELLM_MASTER_KEY` is generated or reused from the existing
Secret.

## Reserved Workspace Paths

A session's `/workspace` is yours except for the names below, which the
platform owns. Pick another name for your own data: what happens to a file you
create under one of these is decided by the platform's lifecycle for that name,
not by yours, and nothing warns you at the time.

Dropped from the snapshot — a file you create here is not carried into your
next sandbox and will not be there when the session is rehydrated:

| Path | Owner |
|------|-------|
| `.uploads/` | Files uploaded through the API; expired on their own schedule |
| `.transcripts/` | Per-run transcripts Brain writes straight to object storage |
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
ownership, and will simply be rebuilt: `.git`, `node_modules`, `.task-venv`,
`.cache`, `.runtime`, `__pycache__`, `torchinductor_*`, `hsa`, `worktree`, and
object files (`*.o`, `*.co`). The full list is `WORKSPACE_EXCLUDES` in
[`claw/packages/brain/src/workspace/excludes.ts`](claw/packages/brain/src/workspace/excludes.ts).

## Key Environment Variables

See [`.env.example`](claw/.env.example) for the full list.

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
| `API_PORT` / `EXECUTOR_PORT` / `MCP_PORT` | Service listen ports (api / brain / hands) |

## Design Docs

Deeper design notes live in [`claw/docs/`](claw/docs/README.md), which indexes
the published documents and also names the ones cited from source comments that
are not part of this release, so a grep for a filename gives an answer.

Per-tree documentation: [`claw/`](claw/README.md) ·
[`sandbox/`](sandbox/README.md) · [`memory/`](memory/README.md) ·
[`deploy/`](deploy/README.md). The Sphinx site under [`docs/`](docs) covers
the Python packages only.

## Contributing

Setup, the `make verify` gate, coverage floors, and the DCO sign-off requirement
are in [`CONTRIBUTING.md`](CONTRIBUTING.md). Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

Vulnerabilities go through the private process in [`SECURITY.md`](SECURITY.md) —
never a public issue. That file also states the security posture a production
deployment is expected to meet, which is worth reading before you deploy rather
than after.

Release notes and the versioning policy: [`CHANGELOG.md`](CHANGELOG.md).

## License

PrimusClaw is released under the **MIT License**. The full license text
is in [`LICENSE`](LICENSE).

You may use PrimusClaw commercially, modify it, and distribute it under
the terms of the MIT license, provided the copyright notice and the
permission notice are retained in all copies or substantial portions of
the software.

Third-party agent CLIs that PrimusClaw invokes (`cursor-agent`, Claude
Code, and OpenAI Codex) are installed at runtime rather than distributed
with this repository. They are governed by their own separate license
terms and are NOT covered by the MIT license above — see the
"Third-Party Tools and Agents" section in [`LICENSE`](LICENSE). You are
responsible for reviewing and complying with each tool's individual
license.

The `sandbox/` directory is a **fork** of the upstream
`sigs.k8s.io/agent-sandbox` project (© The Kubernetes Authors) with
substantial AMD additions, licensed separately under the **Apache License
2.0** and NOT covered by the MIT license above. See
[`sandbox/LICENSE`](sandbox/LICENSE), [`sandbox/NOTICE`](sandbox/NOTICE)
and [`sandbox/UPSTREAM.md`](sandbox/UPSTREAM.md) for the per-directory
attribution split.
