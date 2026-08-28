<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# deploy — whole-stack installer

`deploy.sh` chains the per-component installers so a standalone PrimusClaw stack
comes up in one command. Each component also keeps its own `deploy/` and can be
installed on its own; this directory only orchestrates them.

| Step | Installer | Required |
|---|---|---|
| 1 | [`sandbox/deploy/`](../sandbox/deploy) — Agent Sandbox control plane | yes |
| 2 | [`claw/deploy/`](../claw/deploy) — Claw API / Brain | yes |
| 3 | [`litellm/`](litellm) — the LiteLLM gateway wrapper | default on, `--skip-litellm` to omit |

LiteLLM is deployed **after** Claw so it can reuse the PostgresCluster that
Claw's installer provisions.

## Before you start

You need a Kubernetes cluster, `kubectl`, `helm`, and a storage class. You also
need a **SaFE endpoint** for `SAFE_API_URL` — SaFE is the authentication and
workload platform Claw delegates to, and it is a separate system
([AMD-AGI/Primus-SaFE](https://github.com/AMD-AGI/Primus-SaFE)), not part of
this repository. Production installs require it.

Without SaFE you can still bring the stack up for evaluation on an isolated
cluster by passing `--insecure-sandbox`, which deploys the sandbox control plane
with **no authentication at all**. Do not do this on any cluster that is shared
or reachable from a network you do not control.

## Usage

```bash
# Preview. Prints the plan; child installers preview where they support it.
SAFE_API_URL=https://safe.example.com bash deploy/deploy.sh --dry-run

# Execute. --yes is required for any real cluster mutation.
SAFE_API_URL=https://safe.example.com bash deploy/deploy.sh --yes

# Sandbox + Claw only.
SAFE_API_URL=https://safe.example.com bash deploy/deploy.sh --yes --skip-litellm

# Isolated development cluster, no Sandbox auth — read the warning above first.
bash deploy/deploy.sh --yes --insecure-sandbox
```

`bash deploy/deploy.sh --help` lists every flag and the full environment
surface: namespaces, image registries and tags, storage class, domain, egress
policy, and the LiteLLM database wiring.

Nothing mutates the cluster without `--yes`. That is deliberate — the default
run prints the plan and stops.

## Profiles

Reusable, non-secret settings go in a profile file:

```bash
cp deploy/profile.example.env /tmp/primus-claw-deploy.env
# edit it, then
bash deploy/deploy.sh --config /tmp/primus-claw-deploy.env --dry-run
```

Precedence is: exported environment variables beat profile values, and CLI
flags beat both. `--config` takes precedence over `DEPLOY_PROFILE_FILE`.

**A profile is not a place for credentials.** [`profile.example.env`](profile.example.env)
carries none, and the loader is not designed to protect them. Inject secrets
through Kubernetes Secrets, Vault, CI secrets, or an ignored
`claw/deploy/values.<NAMESPACE>.env`.

## The LiteLLM wrapper

[`litellm/`](litellm) packages the upstream LiteLLM gateway — a Dockerfile that
layers an auth hook onto the upstream image, a Helm chart, and a deploy script.
Provider and model routing is deployment-specific and belongs in a private
values file passed as `LITELLM_VALUES_FILE`;
[`litellm/values.autorouting.example.yaml`](litellm/values.autorouting.example.yaml)
shows the shape, including complexity-based auto-routing.

Two conveniences worth knowing: `LITELLM_DATABASE_URL` is optional when the
wrapper can discover Claw's PGO database in the same namespace, and
`LITELLM_MASTER_KEY` is generated on first install and reused from the existing
Secret afterwards.

## Verifying a release

From the repository root:

```bash
make release-verify       # Docker/Helm/installer/PostgreSQL gates, no cluster
RELEASE_IMAGE=<registry>/primus-claw:<tag> make release-verify-k8s
```

See [`../SECURITY.md`](../SECURITY.md#release-verification) for what each gate
covers.
