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
| [`Dockerfile`](Dockerfile) | Layers the prompt-cache hook and a UI base-path patch onto `ghcr.io/berriai/litellm` |
| [`prompt_cache_hook.py`](prompt_cache_hook.py) | The hook: opt-in Anthropic prompt caching |
| [`charts/litellm/`](charts/litellm) | Helm chart — deployment, service, secret, optional ingress and ServiceMonitor |
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
| `LITELLM_INGRESS_HOST` | Enables ingress for `/llm-gateway` when set |
| `LITELLM_IMAGE` | Defaults to a pinned `docker.io/primussafe/litellm` timestamp tag |

## Credentials already in the release history

`secrets.existingSecret` keeps the master key and the database URL out of the
values Helm stores **from the next revision onward**. It does not reach back:
revisions written before it was set still carry both in plain text, and an
upgrade does not rewrite them.

Each revision is a Secret named `sh.helm.release.v1.<release>.v<N>` in the
release namespace, so `helm get values <release> --revision N` returns what that
revision held. Deleting those Secrets removes the values and the ability to roll
back to those points; it does not undo the exposure, so treat anything that was
in them as compromised and rotate it.

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

**The prompt-cache hook** is opt-in per request. Sending
`x-auto-prompt-caching: true` (or `1h` for the hour-long entry) makes the hook
attach Anthropic `cache_control` markers to tools and messages on Claude
routes, so repeated prefixes report `cache_read_input_tokens`. Requests that do
not send the header are left untouched.

The chart does not load the hook by default. Its default `callbacks` list is
empty, because the image the chart pins (`docker.io/primussafe/litellm:20260331111348`)
predates this directory and does not contain `prompt_cache_hook.py`; naming the
hook there would start a proxy that cannot import it. Build an image from this
directory ([Building the image](#building-the-image)), deploy it, and then opt in:

```yaml
litellmSettings:
  callbacks:
    - litellm.proxy.hooks.prompt_cache_hook.proxy_handler_instance
```

`scripts/release-tests/litellm-prompt-cache-hook.sh` keeps this honest: it fails
if the chart's default `callbacks` ever name a hook while the image pins are
still not a `build.sh` tag (or disagree with each other).

**Upgrading from a release that used the previous default.** The chart's default
`callbacks` used to be one combined hook that the pinned image contains. With the
default now empty, a `helm upgrade` or `deploy.sh` run with default values drops
that callback without an error: prompt caching stops (`cache_read_input_tokens`
falls to 0) and the per-key header injection the old hook also did stops with it,
and `deploy.sh`'s post-deploy check only verifies callbacks that are named. A
release that relies on the previous default must set `litellmSettings.callbacks`
explicitly in its private values, naming the hook or hooks its image contains,
**before** upgrading.

**The UI patch** rewrites the pre-built static assets' base path from `/ui` to
`/llm-gateway` with `sed`, rather than rebuilding the UI — the upstream build
needs Google Fonts access, which is blocked in the build environment. If you
change `LITELLM_SERVER_ROOT_PATH`, this patch no longer matches and the admin UI
will not load; the API is unaffected.

The base image is pinned by digest and floors at `v1.96.2`, which is the first
release carrying Auto Router v2 and classifier context windows.

## Scraping `/metrics`

The proxy only emits `litellm_deployment_*` series when `prometheus` is in
`litellm_settings.callbacks`. The ServiceMonitor then copies those process
counters into the cluster TSDB so they survive pod restarts. Enabling the
scrape object without the callback yields empty targets, not an error.

`callbacks` in Helm **replaces** the chart default list, so list every entry you
want. On an image built from this directory that includes the prompt-cache hook
(or a hook of your own that the image can import):

```yaml
litellmSettings:
  callbacks:
    - prometheus
    - litellm.proxy.hooks.prompt_cache_hook.proxy_handler_instance
serviceMonitor:
  enabled: true
```

On the pinned legacy image, drop the second entry: it does not carry the hook.

Leave `serviceMonitor.namespace` empty so the ServiceMonitor is created in the
release namespace and can read `secrets.existingSecret` (key `master_key`).
`bearerTokenSecret` is resolved in the ServiceMonitor's namespace, not the
Service's. If a scrape operator requires the object elsewhere, copy or mint a
Secret in that namespace and set `serviceMonitor.bearerTokenSecret.name`.

## Building the image

`./build.sh` (needs `REGISTRY`; set `HARBOR_PASSWORD` to build in-cluster with
kaniko when there is no docker daemon). The tag it writes names the LiteLLM
version taken from the Dockerfile, and `deploy.sh` refuses an image whose
version-named tag disagrees with that pin.

The chart's image pins (`charts/litellm/values.yaml` `image.tag`,
`charts/litellm/Chart.yaml` `appVersion`, and the `LITELLM_IMAGE` default in
`deploy.sh`) still name the legacy `20260331111348`. Publishing an image is a
release step, not part of the tree: when one is published, bump all three to
its tag and put the hook back into the chart's default `callbacks` in the same
change. The release test fails if only the second half happens.

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

**Do not mount the hook from a ConfigMap.** The image bakes `prompt_cache_hook.py`
into whatever path the installed LiteLLM actually imports from, which moves
between base images -- older ones resolve to `/app/litellm`, current ones to a
venv `site-packages` tree. A mount pinned to the old path onto a new image
starts cleanly, passes readiness, and leaves the hook inert. `deploy.sh` now
fails the deploy when the configured callback cannot be resolved inside the
running pod, but a hand-applied Deployment bypasses that check entirely.
