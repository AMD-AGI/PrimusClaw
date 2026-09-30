# Agent Sandbox

A **fork** of the open-source project [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) (`agents.x-k8s.io` CRD), with substantial AMD additions. Agent Sandbox provides on-demand, isolated code-execution environments (Code Interpreter) for AI agents and LLMs. Every session runs in a dedicated Kubernetes Pod and is reclaimed when it expires.

> **Licensing:** this directory is Apache-2.0 (upstream's license), *not* the MIT
> license that covers the rest of PrimusClaw. See [`LICENSE`](./LICENSE),
> [`NOTICE`](./NOTICE) and [`UPSTREAM.md`](./UPSTREAM.md) for what is inherited
> from upstream versus added by AMD.

> **The shipped defaults are not a security boundary.** A default install runs
> sandboxes as ordinary `runc` containers with authentication and the egress
> proxy both disabled. How much isolation you actually get is a deployment
> choice — read [Security model and defaults](#security-model-and-defaults)
> before exposing this to untrusted code or untrusted callers.

## Architecture

- **Controller** (`controllers/`, `cmd/controlplane`) — reconciles the `Sandbox` CRD and its extensions (`SandboxTemplate`, `SandboxClaim`, `SandboxWarmPool`).
- **Router** (`pkg/router`) — the unified API gateway. All external traffic enters here under `/v1/...`. Control-plane requests are reverse-proxied to the Workload Manager; data-plane invocations are routed to the target sandbox Pod.
- **envd** (`pkg/envd`, `cmd/envd`) — the in-Pod runtime agent (port `8080`). Beyond executing code/commands and handling files, persistent shell sessions, interactive terminals and GPU queries, it also governs the sandbox's outbound network behavior. Injected into any base image via an `initContainer`, so no custom image build is required.

See [docs/architecture.md](./docs/architecture.md) for the full architecture diagram.

### Security model and defaults

**Design intent.** Unlike a typical container platform that trusts the code inside the container and defends against external attackers, Agent Sandbox is *designed* on the assumption that the **code inside the sandbox is untrusted** (it may be AI-generated and prompt-injected). The orchestration layer (control plane) decides *which image, how many resources, and where* a sandbox runs; the **Runtime layer inside the Pod** constrains *what the in-sandbox processes may reach on the network and which credentials they may use*. Because the reference cluster uses the Flannel CNI (no Kubernetes `NetworkPolicy` support), all network controls are enforced at the application layer by the envd transparent proxy, with Kata VM isolation as a fallback.

**What you actually get by default.** The design intent above is only realised
once the relevant controls are turned on. The values shipped in
`deploy/helm/values.yaml` are development defaults:

| Control | Shipped default | Consequence when left at the default |
|---|---|---|
| Container runtime | `runc` (Kata is a separate opt-in template) | Shared host kernel; a kernel-level escape is not contained |
| `router.config.enableAuth` | `false` | Router and Workload Manager register **no** auth middleware; any caller that can reach them can create sandboxes and exec commands inside them |
| `egress.enabled` | `false` | envd does not start the transparent proxy at all, so there is **no** SSRF protection and **no** outbound filtering |
| Network policy | n/a (Flannel) | There is no network-level backstop for the item above |
| Default egress policy preset | `agent-default` allows external traffic | Even with the proxy on, outbound internet is permitted unless you tighten the policy |
| Credentials in the sandbox | caller's per-user gateway key is injected | In-sandbox code can read and spend the invoking user's own key (upstream provider keys stay in LiteLLM) |

To stop the unauthenticated case from happening silently, the control plane
**refuses to start** when `enableAuth` is false unless you also set
`security.allowInsecureNoAuth: true` (env `ALLOW_INSECURE_NO_AUTH=true`). Treat
that flag as "development cluster only".

#### Production hardening

Minimum changes before running untrusted code or accepting untrusted callers:

```yaml
security:
  allowInsecureNoAuth: false     # leave false; the control plane enforces it
router:
  config:
    enableAuth: true
    safeApiUrl: https://<your-safe-api>
workloadmanager:
  config:
    enableAuth: true
    safeApiUrl: https://<your-safe-api>
egress:
  enabled: true                  # transparent proxy + SSRF protection
  extraBlockedCIDRs: "169.254.0.0/16,100.64.0.0/10"
```

In addition:

- Run sandboxes on the **Kata** runtime template (`kata-qemu`) so a container
  escape does not reach the host kernel.
- Tighten the egress policy away from the permissive `agent-default` preset to an
  allowlist appropriate to your workloads.
- Scope and rate-limit the per-user gateway keys at the SaFE layer, and be ready
  to revoke them — in-sandbox code can read the key of the user who invoked it.
- Apply a restricted Pod Security Standard to the sandbox namespace, and keep
  sandbox namespaces separate from the control-plane namespace.

#### Extra CA certificates

If sandbox egress goes through a TLS-intercepting proxy, give the sandboxes your
organisation's CA from a ConfigMap. You do not need to rebuild an image or
commit the certificate. Each key is one PEM certificate; a bundle produced by
trust-manager works too. Create it in every namespace sandboxes run in:

```bash
kubectl -n <sandbox-namespace> create configmap <your-ca-configmap> \
  --from-file=ca.crt=/path/to/your-root-ca.pem
```

##### Configuration

| Setting | Where | Meaning |
|---|---|---|
| `SANDBOX_EXTRA_CA_CONFIGMAP` | `install.sh` / `deploy.sh` env; controller env | Name of the ConfigMap of PEM certificates. Empty (default): no ConfigMap. |
| `controlplane.config.sandboxExtraCAConfigMap` | Helm value | The same, set on the chart directly. |
| `SANDBOX_EXTRA_CA_NAMESPACES` | `install.sh` / `deploy.sh` env | Comma-separated namespaces `install.sh` checks for the ConfigMap. |
| `SANDBOX_EXTRA_CA_REQUIRED` / `controlplane.config.sandboxExtraCARequired` | env / Helm value | `true`: require an anchor from the injector image alone, without a ConfigMap. |
| `EXTRA_CA_REQUIRED` | main-container env, read by the script | `true`: fail when no extra anchor is found (the controller sets it). |
| `EXTRA_CA_IMAGE_BUNDLE` | main-container env, read by the script | Path of the image-baked bundle; default `/shared/bin/extra-ca-bundle.pem`. |
| `/etc/claw/extra-ca` | mount path | Where the ConfigMap is mounted; the script reads every file in it. |
| `EXTRA_CA_CERT_URLS` | `docker build --build-arg` of the envd-injector image | Space-separated URLs of PEM certificates baked into `/extra-ca-bundle.pem`. Empty by default. |

##### How it works

Both ways of starting a sandbox below use the same script from the
envd-injector image, `/setup-extra-ca.sh`. It merges

- `/shared/bin/extra-ca-bundle.pem`, the bundle baked into the injector image at
  build time with `--build-arg EXTRA_CA_CERT_URLS=...` (empty by default), and
- every file in `/etc/claw/extra-ca`, where you mount the ConfigMap,

with the user image's system bundle into `/shared/bin/ca-bundle.pem`.

The container is *configured to use the bundle* when `SSL_CERT_FILE`,
`CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` or `NODE_EXTRA_CA_CERTS` is
`/shared/bin/ca-bundle.pem`, or `EXTRA_CA_REQUIRED=true`. Then, if neither
source holds a certificate, the script exits non-zero with
`setup-extra-ca: error: ...` naming both paths, and envd does not start. A mounted
file that is not a PEM certificate is an error too. When the container is not
configured to use the bundle and finds no certificate, the script skips and
exits 0.

##### From the controller (CodeInterpreter) and the chart

```bash
SANDBOX_EXTRA_CA_CONFIGMAP=<your-ca-configmap> \
SANDBOX_EXTRA_CA_NAMESPACES=<sandbox-namespace> \
deploy/scripts/install.sh   # together with your usual install settings
```

With Helm directly, set `controlplane.config.sandboxExtraCAConfigMap`. Every
sandbox the controller creates then mounts the ConfigMap at `/etc/claw/extra-ca`,
copies `/setup-extra-ca.sh` and `/extra-ca-bundle.pem` from the injector, runs
the script before the build steps and envd, and points the four variables above
at the bundle unless the template already sets them. The main container gets
`terminationMessagePolicy: FallbackToLogsOnError`, so `kubectl describe pod`
shows the script's error.

A misconfiguration does not start a sandbox that cannot verify TLS:

- `install.sh` refuses to install if the ConfigMap is missing from a listed
  namespace, or holds no certificate;
- a sandbox in a namespace without the ConfigMap stays in `ContainerCreating`
  with a `FailedMount` event naming it;
- a sandbox that finds no certificate, or a key that is not PEM, exits before
  envd starts with the reason in its termination message;
- an injector image older than this support fails too: one without
  `/setup-extra-ca.sh` fails the initContainer's copy, and a script that exits
  without writing the bundle is caught by the controller's own check.

To rely on anchors baked into the injector image alone, without a ConfigMap,
set `SANDBOX_EXTRA_CA_REQUIRED=true` (`controlplane.config.sandboxExtraCARequired`).
With neither setting, sandbox pods are unchanged.

##### From a pod template you maintain

Some platforms render sandbox pods from their own, self-maintained sandbox
templates instead of through the CodeInterpreter controller. Such a template
lives outside this repository; this repository only fixes the injector image's
side of the contract: the image ships `/setup-extra-ca.sh` and
`/extra-ca-bundle.pem` at those paths, and the script reads
`/etc/claw/extra-ca`. A template uses it like this (placeholders only):

```yaml
initContainers:
- name: envd-injector
  image: <registry>/agent-sandbox-envd-injector:<tag>
  command: ["sh", "-c"]
  args:
  - |
    cp /envd /shared/bin/envd
    # ... tmux, iptables, musl loader as in codeinterpreter_controller.go ...
    cp /setup-extra-ca.sh /extra-ca-bundle.pem /shared/bin/
  volumeMounts: [{name: envd-bin, mountPath: /shared/bin}]
containers:
- name: <main>
  image: <user-image>
  command: ["/bin/sh", "-c"]
  args: ["/shared/bin/setup-extra-ca.sh && exec /shared/bin/envd --port=8080 --workspace=<workspace>"]
  env:
  - {name: SSL_CERT_FILE,       value: /shared/bin/ca-bundle.pem}
  - {name: REQUESTS_CA_BUNDLE,  value: /shared/bin/ca-bundle.pem}
  - {name: CURL_CA_BUNDLE,      value: /shared/bin/ca-bundle.pem}
  - {name: NODE_EXTRA_CA_CERTS, value: /shared/bin/ca-bundle.pem}
  terminationMessagePolicy: FallbackToLogsOnError
  volumeMounts:
  - {name: envd-bin, mountPath: /shared/bin}
  - {name: extra-ca, mountPath: /etc/claw/extra-ca, readOnly: true}
volumes:
- {name: envd-bin, emptyDir: {}}
- name: extra-ca
  configMap: {name: <your-ca-configmap>}   # not optional: a missing one holds the pod
```

**Deprecated compatibility paths.** The injector image also ships the same
script as `/setup-amd-ca.sh` and the same bundle as `/amd-bundle.pem`, for
self-maintained sandbox templates written before the generic names existed.
A template that copies and runs those names keeps working unchanged and behaves
exactly the same (the script finds the bundle under either name). New templates
should use `/setup-extra-ca.sh` and `/extra-ca-bundle.pem`.

Mounting the ConfigMap is optional for this contract: a template that already
works with an injector image built with your CA keeps working unchanged. Once
the template points the variables at the bundle, though, an injector image with
no baked CA and no ConfigMap mounted stops the sandbox before envd starts,
instead of starting one whose every https call fails. Mount the ConfigMap (or
build the image with your CA) before rolling out such an image.

## Sandbox Type: CodeInterpreter

A high-frequency, short-task code-execution environment that also supports long-lived agent sessions. Key capabilities:

- **Any base image** — specify any Docker image via `fromImage` (e.g. `python:3.11-slim`, `node:18-alpine`); `envd` is auto-injected, no custom build needed.
- **Init steps** — define startup commands (e.g. `pip install`) via `steps`; executed during WarmPool pre-warm so users don't wait at create time.
- **Sidecar containers** — attach containers (e.g. Redis, MCP server) via `sidecars`, sharing the network with the main container (reachable over `localhost`).
- **WarmPool** — keep a pool of pre-warmed Pods to eliminate cold-start latency.
- **VM-level isolation** — optional Kata Containers (`kata-qemu`) runtime for independent-kernel isolation.
- **AMD GPU support** — request AMD GPUs (MI300X / MI325X / MI355X) via `gpu`.

> Resource specs (CPU / memory / GPU) are defined entirely by the template; runtime overrides are not supported. Create a separate template for a different spec.

## Core Features

- On-demand isolated sessions, each with a unique `sessionId`.
- Synchronous and streaming (SSE) command execution.
- File operations: upload (Base64 JSON or multipart), download, list, delete.
- Persistent shell sessions (tmux-backed) that retain cwd, env vars and background processes.
- Interactive terminal: send key sequences, capture screen snapshots.
- AMD GPU status queries.
- OpenAI-compatible: `OPENAI_BASE_URL` injected for in-sandbox model calls via the platform LLM proxy.
- Optional egress control (transparent proxy + SSRF protection) with policy synced from the Workload Manager.
- Session lifecycle management with max-duration auto-reclamation.
- Auth: SaFE Cookie (browser) or API Key (`ak-` prefix, for SDK / CLI).

## Runtime Security

> Everything in this section describes the behavior **when `egress.enabled: true`**.
> That is not the shipped default. With the egress proxy disabled envd never
> starts the proxy goroutine or installs the `iptables` rules, so none of the
> controls below — including the SSRF baseline — are in effect, and (with Flannel)
> nothing else restricts the sandbox's outbound traffic.

### Egress traffic governance

envd runs a **transparent proxy** as a goroutine inside the process (no extra sidecar or daemon). `iptables REDIRECT` forces all outbound TCP through the proxy; during init envd configures the rules with `CAP_NET_ADMIN`, then drops `CAP_NET_ADMIN`/`CAP_NET_RAW` so user processes cannot bypass it. Each connection goes through: recover the original destination (`SO_ORIGINAL_DST`) → extract the domain (TLS SNI / HTTP Host) → **SSRF check** → DNS-rebinding defense → policy evaluation → connect using the validated IP.

- **SSRF protection** (security baseline; not bypassable by in-sandbox code once the proxy is running, since `CAP_NET_ADMIN`/`CAP_NET_RAW` are dropped after init): always blocks loopback and IPv6 link-local/unique-local; by default blocks private ranges (`10/8`, `172.16/12`, `192.168/16`); extendable via Helm `extraBlockedCIDRs`. Applies even in `audit` mode — but not at all when `egress.enabled: false`.
- **DNS-rebinding defense**: once a hostname resolves to a safe IP, the proxy dials that exact IP rather than re-resolving the name.
- Source: `pkg/envd/egress/` (`ssrf.go`, proxy, dns, sni).

### Policy engine

An embedded **OPA (Open Policy Agent) Go SDK** evaluates `allow`/`deny`/`audit` at L4 (domain + port) — no external OPA daemon. Policies are cluster-scoped `ClusterSandboxPolicy` CRDs shipped as platform presets via the Helm chart; a CodeInterpreter template references one through `spec.runtimePolicy` (defaults to `agent-default`).

| Preset            | Use case            | External egress      | Internal egress     |
| ----------------- | ------------------- | -------------------- | ------------------- |
| `agent-default`   | Most agent tasks    | Open (SSRF-only)     | Blocked unless allow-listed |
| `agent-restricted`| High-security tasks | Allow-list only      | Blocked unless allow-listed |

- **Modes**: `enforce` (block on `deny`) and `audit` (log only, for policy debugging / canary). SSRF blocking stays enforced in both.
- **Developer allow-lists**: `allowedEgressHosts` (external domains, for `agent-restricted`) and `allowedInternalHosts` (internal IP/CIDR, must be precise — masks shorter than `/16` are rejected).
- Source: `pkg/policy/`.

### Policy hot reload

Allow-lists can be changed on a running sandbox without restarting the Pod. envd periodically **pulls** the latest policy from the Workload Manager (default every 30s, via Router, reusing the existing JWT channel) and atomically swaps it through the OPA SDK when the version changes. Two change sources: platform-level edits to `ClusterSandboxPolicy`, and per-sandbox developer updates via SDK/CLI/API (`PATCH /v1/sandbox/sessions/{id}/policy`, overwrite semantics). If the pull fails, the last good policy stays in effect. Source: `pkg/envd/policy_sync.go`.

## Unified Inference Egress

The sandbox Pod never holds a real *upstream provider* key. The Workload Manager injects `OPENAI_BASE_URL` (pointing at the in-cluster **LiteLLM** gateway) and a per-user `OPENAI_API_KEY` (SaFE API Key or LiteLLM Virtual Key); the real backend keys stay in LiteLLM. Note that the injected per-user key is a real credential belonging to the invoking user — in-sandbox code can read it, so scope and rate-limit it upstream. In-sandbox code can just `import openai` and call models, with per-user metering and isolation. This is optional — code may also override `base_url`/`api_key` to use a public or internal LLM directly (subject to egress policy).

## Custom Image Build

Instead of installing dependencies via `steps` on every start, a template can supply a Dockerfile (`build.dockerfile`) and the platform builds the image with **kaniko**, pushing to an internal registry and updating `fromImage`. Build caching is two-tiered: an image-hash index (identical Dockerfile → reuse) and kaniko layer cache (`--cache-repo`). Build Pods are sandboxed (no ServiceAccount token, no platform credentials, resource limits, build timeout). Source: `pkg/builder/`. (The Workload Manager also returns a warning when it detects `pip/apt/npm install` in `steps`, suggesting a custom image or `warmPoolSize`.)

## In-Sandbox Service Access

To reach a user-started service (Jupyter, Streamlit, REST API, MCP server, etc.) inside a sandbox:

- **Router reverse proxy** (recommended, for any HTTP service): `…/invocations/proxy/{port}/{path}` — reuses Router auth and rate limiting. Source: `pkg/router/port_proxy.go`. Note: path-based proxying can break deep-path frontend assets (configure `base_url`/`root_path`); a subdomain-based routing mode addresses this.
- **SDK / CLI port forward** (for debugging or non-HTTP protocols): `sandbox.port_forward(remote, local)` / `sandbox-cli forward $SESSION_ID 8000:8000`, via a Router WebSocket tunnel.

## Quick Start

### Install

`deploy/scripts/install.sh` requires an explicit authentication choice — it will
not silently install an unauthenticated control plane.

```bash
# Recommended: authenticate against SaFE.
SAFE_API_URL=https://<your-safe-api> deploy/scripts/install.sh

# Development clusters only: install without authentication.
ALLOW_INSECURE_NO_AUTH=true deploy/scripts/install.sh
```

The supported install path is the Helm-backed installer above. Files under
`deploy/k8s/` and `deploy/k8s-kata/` are environment-specific templates: they
contain `__...__` placeholders (including `__ALLOW_INSECURE_NO_AUTH__`) and do
not provision every dependency. Do not apply them directly to a cluster.

See [Production hardening](#production-hardening) for the rest of the checklist
(egress proxy, Kata runtime, key scoping).

### Use

```
1. Create a template   POST   /v1/templates                              (one-time, defines the spec)
2. Create a sandbox    POST   /v1/code-interpreter                       (returns a sessionId)
3. Use the sandbox     Sandbox API + sessionId                           (execute, files, etc.)
4. Delete the sandbox  DELETE /v1/code-interpreter/sessions/{sessionId}
```

## Service Endpoints

| Access     | Base URL                                                                    | Use case                        |
| ---------- | --------------------------------------------------------------------------- | ------------------------------- |
| In-cluster | `http://agent-sandbox-router.agent-sandbox-system.svc.cluster.local:8080`   | In-cluster Pods, agent services |
| External   | via the cluster gateway (deployment-specific)                          | Out-of-cluster clients, CI/CD   |

## API Reference

See [docs/API.md](./docs/API.md) for the full HTTP API (management plane + sandbox data plane).
