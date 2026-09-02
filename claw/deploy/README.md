# Claw Deployment Guide

Complete deployment guide for deploying Claw into the
`primus-claw` Kubernetes namespace.

## Architecture

```
Browser / MCP Client
        │ HTTPS
        ▼
   Higress Ingress (/claw-api)
        │
        ▼
┌──────────────── primus-claw namespace ────────────────┐
│  primus-claw-api (Deployment)                         │
│    ├── PostgreSQL (PGO) ── primus-claw database       │
│    ├── NATS JetStream (claw-nats, 3-node cluster)     │
│    └── MinIO (minio ns, cross-namespace)              │
│                                                       │
│  primus-claw-brain (Deployment)                       │
│    ├── NATS JetStream consumer                        │
│    ├── SaFE Sandbox (Hands per-session)               │
│    └── LiteLLM Gateway (LLM proxy)                    │
└───────────────────────────────────────────────────────┘
```

## Prerequisites

| Dependency   | Requirement                                              |
|--------------|----------------------------------------------------------|
| Kubernetes   | 1.27+, `kubectl` configured                             |
| Helm         | 3.x (`helm repo add nats https://nats-io.github.io/k8s/helm/charts/`) |
| PostgreSQL   | PGO-managed cluster in `primus-claw` with Secret `primus-claw-pguser-postgres` |
| MinIO        | Running in `minio` namespace, accessible at `minio.minio.svc.cluster.local:9000`, with the `S3_BUCKET` bucket (default `claw`) already created — no script creates it |
| Container image | `<REGISTRY>/claw:<TAG>` built and pushed      |
| Ingress      | Higress ingress controller installed                     |
| Sandbox namespace | The namespace named by `secret.sandboxNamespace` must already exist. Sandboxes without a request-supplied `workspace_id` are created there by the agent-sandbox router; the chart does not create it, and install fails early if it is missing. Defaults to `default`. |

## Quick Start (One-Click)

```bash
# 1. Copy/fill per-env values (contains secrets; do not commit)
cp deploy/values.example.env deploy/values.primus-claw.env

# 2. Deploy everything
REGISTRY=myregistry.com/claw TAG=v1.0.0 bash deploy/deploy.sh
```

### Upgrade Note: BYOK Verification Protocol

Manual `.env` or non-Helm deployments upgrading to this version must set
`BYOK_VERIFY_API_STYLE`. Use `openai` for LiteLLM and other OpenAI-compatible
gateways, or `anthropic` for the native Anthropic API. Helm and the one-click
deployment script populate this value automatically.

### Upgrade Note: Multi-Node Default Timeout

The multi-node workload lifetime used when a request carries no timeout is now
configurable through `MULTI_NODE_DEFAULT_TIMEOUT_SECONDS` and defaults to
`86400` (24h), replacing the previously hardcoded `90000` (25h). The value is
the total lifetime, so any graceful-shutdown allowance has to be part of it. To
keep the old behaviour on an existing deployment, set
`MULTI_NODE_DEFAULT_TIMEOUT_SECONDS=90000`.

The script performs these steps in order:

1. **PGO** — `helm install primus-pgo` into the namespace (skip with `--skip-pgo`)
2. **NATS** — `helm upgrade --install primus-claw-nats` (3-node JetStream cluster)
3. **PostgreSQL** — create the PostgresCluster, wait for it, grant on the app database
4. **Helm chart** — Secret → Services → API → Brain → Ingress
5. **Rollout wait** — `kubectl rollout status` for the API and Brain Deployments
6. **Health check** — `curl` API `/health` endpoint
7. **Lifecycle rules** — Prints manual command for `minio-lifecycle.py`

The script does **not** create the S3 bucket. MinIO is provisioned out-of-band
(see the note at the top of `deploy.sh`), and nothing in this repository issues
a `CreateBucket` — so the bucket named by `S3_BUCKET` (default `claw`) has to
exist before the first session runs, or workspace sync has nowhere to write.

### Deploy Script Flags

| Flag                | Effect                                        |
|---------------------|-----------------------------------------------|
| `--dry-run`            | Print what would be applied, no changes made      |
| `--skip-pgo`           | Skip the PGO operator install (reuse existing)    |
| `--skip-nats`          | Skip NATS Helm install (reuse existing)           |
| `--skip-pg`            | Skip PostgresCluster creation, readiness and grants |
| `--skip-lifecycle`     | Skip lifecycle rules reminder                     |
| `--skip-shared-assets` | Skip the shared-volume hands-binary deploy        |

## Configuration Reference

### ConfigMap (`claw-config`)

| Variable                       | Description                              | Default                                              |
|--------------------------------|------------------------------------------|------------------------------------------------------|
| `NATS_URL`                     | NATS JetStream endpoint                  | `nats://claw-nats.primus-claw.svc.cluster.local:4222` |
| `POSTGRES_DB`                  | Target database name                     | `primus-claw`                                        |
| `POSTGRES_SSLMODE`             | PG SSL mode                              | `require`                                            |
| `SAFE_API_URL`                 | SaFE platform base URL                   | `https://cluster.example.com`                |
| `SANDBOX_NAMESPACE`            | SaFE sandbox namespace                   | `example-sandbox`                                     |
| `ANTHROPIC_BASE_URL`           | LLM gateway URL                          | `https://cluster.example.com/llm-gateway`   |
| `S3_ENDPOINT`                  | MinIO / S3 endpoint                      | `http://minio.minio.svc.cluster.local:9000`          |
| `S3_BUCKET`                    | S3 bucket name                           | `claw`                                               |
| `MAX_TURNS`                    | Agent loop max turns                     | `2000`                                               |
| `MAX_CONCURRENT`               | Max concurrent Brain sessions            | `3`                                                  |
| `API_PORT`                     | API listen port                          | `8200`                                               |

### Secret (`primus-claw-secrets`)

| Key                    | Description                                          |
|------------------------|------------------------------------------------------|
| `AUTH_INTERNAL_TOKEN`  | Shared secret used only for Brain↔Hands / Brain↔API auth and SaFE auth headers |
| `ANTHROPIC_AUTH_TOKEN` | LLM gateway auth token                               |
| `OPENAI_API_KEY`       | OpenAI API key (for LiteLLM routing)                 |
| `S3_ACCESS_KEY`        | MinIO access key                                     |
| `S3_SECRET_KEY`        | MinIO secret key                                     |

### Sandbox and TLS Chart Values

| Value | Description |
|-------|-------------|
| `secret.clawDeployMode` | `safe` routes sandboxes through the SaFE workload API; `kubernetes` (BYOK) drives the agent-sandbox router directly. Empty selects `safe`. |
| `secret.sandboxRouterUrl` / `secret.sandboxNamespace` | Rendered into both the `SANDBOX_*` and `AGENT_SANDBOX_*` environment names, because which pair Brain reads is decided by `clawDeployMode`. Required to be non-empty in `kubernetes` mode, where the chart fails rather than letting the first message error out. `sandboxNamespace` is the fallback for requests that carry no `workspace_id`, not the only namespace sandboxes can land in. |
| `secret.litellmApiBase` / `secret.safeDefaultWorkspace` | Defaults used in generated optimization prompts. If `litellmApiBase` is empty, callers of `claw_build_geak_prompt` must pass `api_base`. |
| `secret.workspacePersistBase` | Shared-filesystem checkpoint root. Empty disables filesystem sync and leaves S3 as durable fallback. |
| `secret.multiNodeDefaultTimeoutSeconds` / `secret.sandboxDefaultTimeoutSeconds` | Total lifetime when a request supplies no timeout. Defaults do not receive an additional shutdown buffer. |
| `defaultSandbox.image` / `.cpu` / `.memory` | Seeded by the API migration into the `resources` table as the `type='default'` row when that row is absent. This is the bottom of the image/size resolution chain (`metadata` > plugin row > default). The row is always seeded, because `cpu`/`memory` bottom out here too and a request that names only an image still needs them; leaving `image` empty just means every caller must pass `sandbox_image` itself. Editing the row afterwards wins; the seed only fills an empty table. |
| `tls.insecureSkipVerify` | Sets `NODE_TLS_REJECT_UNAUTHORIZED=0` on api and brain, disabling certificate verification for *every* outbound connection. Off by default. To reach an endpoint behind a private CA, add the anchor to the image trust store instead — the runtime stage already wires `NODE_EXTRA_CA_CERTS`. |
| `postgres.sslNoVerify` | Sends `POSTGRES_SSLMODE=no-verify` to api, keeping the PG connection encrypted while skipping server-certificate validation. Off by default, so api validates the certificate. Turn it on (`PG_SSL_NO_VERIFY=true` for `deploy.sh`) against a PGO-managed database, whose CA is absent from the image trust store; the alternative is adding that CA to the trust store and leaving this off. |

### PostgreSQL Connection

PG credentials come from the PGO-managed Secret `primus-claw-pguser-postgres`
(keys: `host`, `port`, `user`, `password`). The `entrypoint.sh` assembles
`DATABASE_URL` at container startup from `POSTGRES_*` env vars.

TLS is on by default: `POSTGRES_SSLMODE` defaults to `require`, which
node-postgres treats as `verify-full`, so the server certificate is validated
against the image trust store. A PGO-managed database signs its certificate with
its own generated CA, which that store does not carry, and the connection then
fails with `SELF_SIGNED_CERT_IN_CHAIN`. Either add the PGO CA (`ca.crt` in the
`<cluster>-cluster-cert` Secret) to the trust store, or set
`postgres.sslNoVerify` to stay encrypted without validating.

## NATS Helm Values

The NATS cluster is deployed via Helm with values in `deploy/nats-values.yaml`:

- Release name: `claw-nats` (Service: `claw-nats.primus-claw.svc:4222`)
- 3 replicas with JetStream enabled (50Gi file store)
- Image: `nats:2.12.6-alpine`

To customize, edit `nats-values.yaml` before running `deploy.sh`.

## Day-2 Operations

### Scale API

```bash
kubectl scale deployment primus-claw-api -n primus-claw --replicas=4
# Or let HPA handle it (configured: min=2, max=5, targetCPU=70%)
```

### Scale Brain

```bash
kubectl scale deployment primus-claw-brain -n primus-claw --replicas=5
```

### Rolling Restart

```bash
kubectl rollout restart deployment/primus-claw-api -n primus-claw
kubectl rollout restart deployment/primus-claw-brain -n primus-claw
```

### Grafana Dashboard

`charts/claw/dashboards/claw-brain.json` is a Grafana dashboard for the Brain's
Prometheus metrics — 87 panels across 10 rows, each carrying a description saying what
it measures, how to read it, and what is normal versus what should worry you.

Install it with the chart, as ConfigMaps a Grafana sidecar discovers:

```yaml
grafanaDashboard:
  enabled: true
  folder: Claw                 # omit to leave them in Grafana's General folder
  datasourceUid: <prom-uid>    # the datasource that scrapes Brain /metrics
```

Or import the JSON by hand — Grafana UI, Dashboards -> New -> Import -> Upload JSON —
in which case the `${DS_PROMETHEUS}` input prompts for the datasource instead.

The chart route needs `datasourceUid` because a sidecar import never prompts; the
placeholder is substituted at render time. The dashboard JSON must stay inside
`charts/claw/`, since `.Files.Glob` cannot read a path that escapes the chart and fails
by rendering an empty ConfigMap rather than by erroring.

**A label collision worth knowing about.** The Brain and API label their own
metrics `service="claw-brain"` / `service="claw-api"` (prom-client
`setDefaultLabels`), and a ServiceMonitor overwrites `service` with the
Kubernetes Service name — `primus-claw-brain` / `primus-claw-api` — because
scrape-time labels win. Enabling `serviceMonitor` therefore changes the value of
that label. The shipped dashboard does not depend on it: `claw_*` metric names
are unique, so its queries carry no `service` selector, and the generic
`process_*` / `nodejs_*` series match both spellings. Queries you write yourself
should do the same rather than pin one value.

**Scraping.** The Deployments carry `prometheus.io/scrape` annotations, and no operator
reads them — that convention only works with a plain Prometheus whose scrape config was
written to relabel on it. On an operator-managed cluster the annotations are inert, so
the pods look instrumented, `/metrics` answers, and every panel is empty. Turn on the
ServiceMonitors instead:

```yaml
serviceMonitor:
  enabled: true
  labels:
    release: kube-prometheus-stack   # whatever label your Prometheus selects on
```

That creates one ServiceMonitor per component against the `http` port of the
`primus-claw-api` and `primus-claw-brain` Services. The VictoriaMetrics Operator's
Prometheus converter is on by default and turns them into VMServiceScrapes, so the same
object covers both ecosystems — except where that operator runs namespace-scoped
(`WATCH_NAMESPACE` set) and this release deploys outside its namespace, in which case it
never sees them and you need a scrape object it does see. It is off by default because
the `monitoring.coreos.com` CRDs may not be installed; enabling it without them makes the
apply fail, which is deliberate — rendering nothing when scraping was explicitly asked
for is the failure this setting exists to prevent.

Two things bite when installing the dashboard outside `helm install`:

- **`kubectl apply` cannot take it.** The JSON is ~250KB, and `kubectl apply` stores the
  whole object in the `kubectl.kubernetes.io/last-applied-configuration` annotation,
  which is capped at 256KB. Piping `helm template` into `kubectl apply` therefore fails
  with `metadata.annotations: Too long`. Use `kubectl apply --server-side`, which does not
  write that annotation. `helm install` and `helm upgrade` are unaffected — they track
  state in the release secret, not in an annotation.
- **No sidecar, no import.** The ConfigMap is only picked up by a Grafana whose deployment
  runs a dashboard sidecar. On a Grafana managed by grafana-operator there is usually no
  sidecar, and the equivalent is a `GrafanaDashboard` CR carrying the same JSON, with the
  `__inputs` entry resolved by `spec.datasources` instead of by
  `grafanaDashboard.datasourceUid`:

  ```yaml
  spec:
    datasources:
      - inputName: DS_PROMETHEUS
        datasourceName: <your Prometheus datasource NAME, not its uid>
  ```

Thresholds and panel maxima assume the upstream defaults — `MAX_CONCURRENT=3`,
`MAX_RESIDENT=6` (a delivery residency ceiling of 9), `brain.replicas=3`,
`WORKSPACE_SYNC_NORMAL_SLOTS=4`, `terminationGracePeriodSeconds=300`. Panels whose scale
depends on one of these say so in their description; adjust the maxima if your
deployment overrides them.

### Rollback

```bash
kubectl rollout undo deployment/primus-claw-api -n primus-claw
kubectl rollout undo deployment/primus-claw-brain -n primus-claw
```

### Check Status

```bash
kubectl get pods -n primus-claw -l app=claw
kubectl logs -n primus-claw -l component=api --tail=50
kubectl logs -n primus-claw -l component=brain --tail=50
```

## Health Endpoints

| Component | Endpoint                | Port |
|-----------|-------------------------|------|
| API       | `GET /health`           | 8200 |
| Brain     | `GET /health`           | 8100 |
| NATS      | `GET /healthz` (monitoring) | 8222 |

## MinIO Lifecycle Rules

After deployment, configure S3 object expiry rules for user uploads:

```bash
bash -c 'set -a && source .env && set +a && \
  cd claw && python3 deploy/minio-lifecycle.py'
```

Requires `boto3` (`pip install boto3`). See `deploy/minio-lifecycle.py` for user-upload tag tiers and `imports/staging/` prefix expiry on the plugins bucket (or merged when `S3_BUCKET` equals `S3_PLUGINS_BUCKET`).

## Troubleshooting

| Symptom | Check |
|---------|-------|
| API pods CrashLoopBackOff | `kubectl logs -n primus-claw -l component=api` — likely DB connection issue |
| Brain not consuming tasks | Verify NATS: `kubectl exec -n primus-claw claw-nats-0 -- nats stream ls` |
| S3 upload failures | Verify MinIO connectivity: `kubectl exec -n primus-claw <api-pod> -- curl -s http://minio.minio.svc.cluster.local:9000/minio/health/live` |
| NATS connection refused | Check `claw-nats` pods: `kubectl get pods -n primus-claw -l app.kubernetes.io/instance=claw-nats` |
| PG auth failure | Verify Secret: `kubectl get secret primus-claw-pguser-postgres -n primus-claw -o jsonpath='{.data.host}' \| base64 -d` |

## File Manifest

| File | Purpose |
|------|---------|
| `deploy.sh` | One-click deployment script (installs the chart; bootstraps PostgresCluster from the chart template) |
| `upgrade.sh` | Rolling upgrade script (renders API/Brain from the chart via `helm template --show-only`) |
| `build.sh` | Claw image build script |
| `charts/claw/` | Helm chart — single source of truth for every manifest (API, Brain, Secret, Services, Ingress, PostgresCluster) |
| `nats-values.yaml` | NATS Helm values |
| `minio-lifecycle.py` | S3 bucket lifecycle rules script (boto3) |
| `charts/claw/dashboards/claw-brain.json` | Grafana dashboard for the Brain metrics (installed by the chart when `grafanaDashboard.enabled`, or imported by hand) |
| `charts/claw/templates/servicemonitor.yaml` | Prometheus Operator ServiceMonitors for API and Brain (`serviceMonitor.enabled`) |
