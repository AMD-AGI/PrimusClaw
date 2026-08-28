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
| `LITELLM_INGRESS_HOST` | Enables ingress for `/llm-gateway` when set |
| `LITELLM_IMAGE` | Defaults to a pinned `docker.io/primussafe/litellm` timestamp tag |

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
