<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# LiteLLM gateway wrapper

Deployment packaging for the upstream [LiteLLM](https://github.com/BerriAI/litellm)
proxy, which PrimusClaw uses as its LLM gateway. This directory adds an image
layer, a Helm chart, and a deploy script; **the gateway itself is upstream
software under its own license**, not part of PrimusClaw.

| File | What it is |
|---|---|
| [`Dockerfile`](Dockerfile) | Layers the auth hook and a UI base-path patch onto `ghcr.io/berriai/litellm` |
| [`apim_key_hook.py`](apim_key_hook.py) | The hook: injects a per-virtual-key APIM subscription header, and opt-in Anthropic prompt caching |
| [`charts/litellm/`](charts/litellm) | Helm chart — deployment, service, secret, optional ingress at `/llm-gateway` |
| [`deploy.sh`](deploy.sh) | Installs the chart; also invoked by the whole-stack installer |
| [`values.autorouting.example.yaml`](values.autorouting.example.yaml) | Example model list and complexity-based auto-routing config |

## Install

Normally you do not run this directly — [`../deploy.sh`](../deploy.sh) installs
it as step 3, after Claw, so it can reuse Claw's PostgresCluster. To install it
on its own:

```bash
LITELLM_VALUES_FILE=/path/to/private-values.yaml \
  bash deploy/litellm/deploy.sh
```

Environment surface:

| Variable | Notes |
|---|---|
| `LITELLM_DATABASE_URL` | PostgreSQL URL. Optional when the wrapper can discover Claw's PGO cluster in the namespace |
| `LITELLM_MASTER_KEY` | Generated on first install, then reused from the existing Secret |
| `LITELLM_VALUES_FILE` | Private Helm values carrying `modelList` and provider credentials |
| `LITELLM_EXISTING_SECRET` | Existing Secret containing `master_key` and `database_url`; prevents either value from entering Helm release values |
| `LITELLM_INGRESS_HOST` | Enables ingress for `/llm-gateway` when set |
| `LITELLM_IMAGE` | Defaults to a pinned `docker.io/primussafe/litellm` timestamp tag |

The chart also accepts `secrets.existingSecret` in
`LITELLM_VALUES_FILE`; the wrapper detects it and skips credential discovery.
`extraEnv` appends raw container environment entries, including `valueFrom`,
while `litellmSettings` and `generalSettings` configure the corresponding
LiteLLM sections. The `AMD_HYPERLOOM_APIM_KEY` and
`AMD_HYPERLOOM_APIM_USER` environment variables only support shared-key user
attribution; APIM authentication still comes from Virtual Key
`metadata.apim_key` or model configuration.

## Credentials already in the release history

`secrets.existingSecret` keeps the master key and the database URL out of the
values Helm stores **from the next revision onward**. It does not reach back:
revisions written before it was set still carry both in plain text, and an
upgrade does not rewrite them.

Each revision is a Secret named `sh.helm.release.v1.<release>.v<N>` in the
release namespace, so `helm get values <release> --revision N` — or plain read
access to Secrets there — returns what that revision held. `helm history` lists
which revisions exist.

Deleting those Secrets removes the values, and with them the ability to roll
back to those points. It does not undo the exposure: anyone who could read them
already could. Treat both values as compromised and rotate.

**Rotating the database URL.** Change the password on the database, update the
Secret named by `secrets.existingSecret`, and redeploy. Nothing else derives
from it.

**Rotating the master key.** Do this in two steps, not one. The master key is
the proxy's admin credential, and when `LITELLM_SALT_KEY` is unset it is *also*
the key that encrypts model credentials stored in the database under
`STORE_MODEL_IN_DB` — LiteLLM falls back to the master key when no salt key is
configured. Changing it on such a deployment leaves every stored model
credential undecryptable. So:

1. Set `LITELLM_SALT_KEY` to the master key's **current** value (via `extraEnv`)
   and redeploy. Nothing is re-encrypted and nothing changes behaviourally —
   the value the code was already using is now pinned explicitly — but the
   encryption key is no longer tied to the admin credential.
2. Verify the proxy still answers and still resolves models from the database,
   then rotate the master key on its own.

Virtual keys already issued keep working across a master-key rotation: they are
stored as a plain SHA-256 hash of the key itself, with the master key playing no
part.

## Model routing is deployment-specific

The chart ships **no model list**. Which providers and models a deployment
exposes, and with which credentials, belongs in a private values file — never in
this repository.

[`values.autorouting.example.yaml`](values.autorouting.example.yaml) shows the
structure, including the `claude-auto` complexity router that dispatches to a
cheaper or more capable model per request. See
[`../../claw/docs/litellm-auto-routing-design.md`](../../claw/docs/litellm-auto-routing-design.md)
for the design.

**Keep the routing table and Claw's `DEFAULT_MODEL` in step.** Claw sends its
default model name to this gateway; a name absent from `modelList` fails at the
gateway rather than in Claw, which makes the cause harder to see. Changing one
means changing both.

## Two things the image layer does

**The auth hook** lets a caller present only a LiteLLM virtual key. The
subscription key for the upstream provider is stored in that key's metadata and
injected by the hook, so provider credentials never reach the client. Sending
`x-auto-prompt-caching: true` additionally makes the hook attach Anthropic
`cache_control` markers to tools and messages, so repeated prefixes report
`cache_read_input_tokens`.

**The UI patch** rewrites the pre-built static assets' base path from `/ui` to
`/llm-gateway` with `sed`, rather than rebuilding the UI — the upstream build
needs Google Fonts access, which is blocked in the build environment. If you
change `LITELLM_SERVER_ROOT_PATH`, this patch no longer matches and the admin UI
will not load; the API is unaffected.

The base image is pinned by digest and floors at `v1.96.2`, which is the first
release carrying Auto Router v2 and classifier context windows.

## Building the image

`./build.sh` (needs `REGISTRY`; set `HARBOR_PASSWORD` to build in-cluster with
kaniko when there is no docker daemon). The tag it writes names the LiteLLM
version taken from the Dockerfile, and `deploy.sh` refuses an image whose
version-named tag disagrees with that pin.

## Upgrading LiteLLM

**The database migration is one-way.** LiteLLM runs `prisma migrate deploy` on
startup whenever a database is configured. Going from 1.82.1 to 1.98.0 applied
46 migrations; nothing tries the reverse, and the older image against the newer
schema is untested. Rolling the image back is therefore not a rollback.

Before upgrading:

1. Snapshot the schema and the applied-migration list -- the data is usually
   covered by the cluster's own backups, but the schema is what the upgrade
   changes and what a rollback would have to answer for:
   `pg_dump -d <db> --schema-only` and `select migration_name from _prisma_migrations`.
2. Save the current Deployment and ConfigMaps.
3. Start the new image against the REAL config in a throwaway pod with the
   database detached, and confirm `/health/readiness` returns 200. A config key
   the new version dropped shows up here rather than under traffic.

**Do not mount the hook from a ConfigMap.** The image bakes `apim_key_hook.py`
into whatever path the installed LiteLLM actually imports from, which moves
between base images -- older ones resolve to `/app/litellm`, current ones to a
venv `site-packages` tree. A mount pinned to the old path onto a new image
starts cleanly, passes readiness, and leaves the hook inert. `deploy.sh` now
fails the deploy when the configured callback cannot be resolved inside the
running pod, but a hand-applied Deployment bypasses that check entirely.
