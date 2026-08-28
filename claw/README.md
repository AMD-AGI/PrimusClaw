<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Claw — the agent harness

The TypeScript half of PrimusClaw: an npm-workspaces monorepo that builds into a
single container image serving three roles. The repository root
[`README.md`](../README.md) covers the architecture; this file is the working
guide for the tree itself.

## Workspaces

| Package | Role |
|---|---|
| [`packages/utils`](packages/utils) | Domain-free helpers safe for every role, including the in-sandbox one: KV abstraction, secret redaction, constant-time compare, env settings |
| [`packages/protocol`](packages/protocol) | The api↔brain contract: shared types, NATS subject builders, sandbox env composition, run leases, task consumer |
| [`packages/hands`](packages/hands) | The MCP tool server that runs *inside* the sandbox (fs / shell / s3 tools) |
| [`packages/brain`](packages/brain) | The agent loop: LLM calls, tool routing, sub-agents, sandbox lifecycle, workspace↔S3 sync |
| [`packages/api`](packages/api) | The public Fastify server: sessions, events, memory, skills, plugins, MCP, admin, A2A, task DAGs |

Build order is `utils → protocol → {hands, brain, api}`, and `npm run build
--workspaces` relies on the order declared in [`package.json`](package.json):
each package consumes its dependencies' emitted `.d.ts`, so a package must be
listed after everything it imports.

`hands` depends on `utils` only, deliberately. It runs inside the sandbox and
must not reach the control-plane protocol.

## Build and run

```bash
npm ci
npm run build          # tsc, all workspaces in dependency order

cp .env.example .env   # then fill in the required values
                       # incl. USER_ENV_ENCRYPTION_KEY=$(openssl rand -base64 32);
                       # on a single-node NATS set the three *_REPLICAS to 1
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
├── packages/          # the five workspaces above
├── deploy/            # Helm chart, deploy/upgrade/build scripts, entrypoint
├── docs/              # design docs — see docs/README.md for the index
├── examples/          # runnable examples
├── scripts/           # start/stop scripts and the CI lint invariants
├── tests/             # SDK-level scripts against a deployed stack
├── Dockerfile         # one image; entrypoint dispatches on api / brain / hands
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
TLS the image will trust. A URL that cannot be fetched, or that does not return
PEM, fails the build rather than being skipped.

This is the supported alternative to `tls.insecureSkipVerify` in the Helm
chart, which turns off certificate verification for *every* outbound connection
and is only for diagnosing a trust-store problem.

## Deployment

See [`deploy/README.md`](deploy/README.md) for Docker and Kubernetes, and the
repository root README for the whole-stack installer.
