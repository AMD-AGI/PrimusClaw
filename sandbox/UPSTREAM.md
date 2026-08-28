# Upstream provenance

This directory is a **fork** of
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox),
not a dependency and not an unmodified vendored copy.

| | |
|---|---|
| Upstream project | https://github.com/kubernetes-sigs/agent-sandbox |
| Upstream license | Apache License 2.0 (see [`LICENSE`](./LICENSE)) |
| Go module path | `sigs.k8s.io/agent-sandbox` (unchanged from upstream) |
| Base commit | **not recorded — see "Recording the base commit" below** |
| CRD group | `agents.x-k8s.io` (unchanged from upstream) |

## Why the module path is unchanged

`go.mod` still declares `module sigs.k8s.io/agent-sandbox`. This fork is **not**
published to that path, so the module path does not identify the code you are
building: anything importing `sigs.k8s.io/agent-sandbox` inside this repository
resolves to this tree, not to upstream. Do not assume API compatibility with
upstream at any given version.

## What is inherited vs. added

Both upstream and AMD-authored files carry SPDX headers, so provenance is
per-file rather than per-directory. The table below is a guide; the per-file
header is authoritative.

The split was established by comparing this tree against upstream directly
rather than by trusting the headers, because the fork was imported as a bulk
rename and so this repository's `git log` attributes every file to that import
rather than to its author. Files were classified as AMD-authored only when they
exist at no upstream path *and* share no substantial content with any upstream
file. Note that `client-go/**` and the `zz_generated` / `groupversion_info`
files keep the upstream copyright even where the types are AMD-defined: their
boilerplate comes from the Kubernetes code generators, which emit that header.

| Directory | Upstream-derived | AMD-authored | Notes |
|---|---:|---:|---|
| `api/`, `controllers/`, `internal/` | most | few | Core `Sandbox` CRD and reconcilers, largely upstream |
| `extensions/` | most | few | `SandboxTemplate` / `SandboxClaim` / `SandboxWarmPool` |
| `client-go/` | all | — | Generated clients; the generator emits the upstream header even for AMD-defined types |
| `manifests/` | most | `rbac/` | `rbac/agentd.yaml` and `rbac/workload-manager.yaml` cover AMD components and have no upstream counterpart |
| `test/` | all | — | Upstream e2e suites (now behind the `e2e` build tag) |
| `pkg/` | majority | substantial | Upstream primitives plus the AMD additions below |
| `cmd/` | some | majority | `cmd/controlplane` is the AMD unified control plane |
| `deploy/` | — | all | Entirely AMD: Helm chart, manifests, install/test scripts |
| `sdk-python/`, `docker/` | — | all | Neither directory exists upstream |
| `hack/` | mixed | mixed | |

The significant AMD additions are:

- **`cmd/controlplane`** — a unified binary running the Router, the Workload
  Manager and the controllers in one process.
- **`pkg/router`** — external API gateway (`/v1/...`), session routing and
  reverse proxy to sandbox Pods, SaFE authentication, port proxy.
- **`pkg/workloadmanager`** — control-plane API, the `CodeInterpreter` sandbox
  type, GC/TTL reconciliation, audit, authorization.
- **`pkg/envd/egress`** — in-process transparent egress proxy with SSRF and
  DNS-rebinding protection.
- **`pkg/policy`** — embedded OPA policy engine and the `ClusterSandboxPolicy`
  presets.
- **`pkg/agentd`, `pkg/store`, `pkg/audit`** — session runtime, Redis-backed
  state, audit trail.
- **AMD GPU support** (`amd.com/gpu` resources, MI300X / MI325X / MI355X) and
  the Kata Containers runtime path.
- **`deploy/`** — the entire deployment surface.

## Recording the base commit

The upstream commit this fork diverged from was not recorded when the fork was
taken, and it cannot be recovered reliably from the tree alone. This matters for
Apache-2.0 attribution hygiene and for pulling upstream fixes, so a maintainer
with the original history should fill in the table above and keep it current:

```bash
git remote add upstream https://github.com/kubernetes-sigs/agent-sandbox.git
git fetch upstream

# Best-effort: find the upstream commit closest to this tree.
git log upstream/main --oneline | head -50

# Once identified, record it and generate a divergence summary:
git diff --stat <upstream-sha> HEAD -- sandbox/
```

Until that is done, treat the "Base commit" row as unknown rather than assuming
this tracks any particular upstream release.

## Rebasing / pulling upstream changes

Because `deploy/` and the `pkg/router`, `pkg/workloadmanager`, `pkg/envd/egress`
and `pkg/policy` trees are AMD-authored, upstream merges mainly touch `api/`,
`controllers/`, `extensions/`, `internal/`, `client-go/` and `test/`. Re-run
`make gen-client` after any upstream API change, then `make all`.
