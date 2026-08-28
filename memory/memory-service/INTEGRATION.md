# Claw Memory Service Integration

## Current Integration Model

`claw-memory-service` is an owned Claw service. It writes directly to
`claw-memory-postgres` and does not call any upstream memory infrastructure.

```
Claw Brain / Admin UI / knowledge-worker
        │
        ▼
claw-memory-service
        │
        ▼
claw-memory-postgres
```

## Claw Brain remote backend

Set:

```bash
MEMORY_BACKEND=remote
MEMORY_SERVICE_URL=http://claw-memory-service.<namespace>.svc.cluster.local:8765
```

Then the existing TypeScript client calls the compatible `/api/memories/*`
routes and the service persists rows in Claw-owned Postgres.

## Frontend Admin UI

Use the gateway path that proxies to this service, for example:

```text
https://cluster.example.com/claw-memory/api
```

## Deployment Order

```bash
# Provision the database and application DSN Secrets through your secret
# manager before applying the workloads.
kubectl apply -f memory/memory-service/deploy/k8s/postgres.yaml
kubectl apply -f memory/memory-service/deploy/k8s/configmap.yaml
kubectl apply -f memory/memory-service/deploy/k8s/deployment.yaml
```

## Schema Migrations

Schema changes ship as numbered SQL files under
`memory/memory-service/migrations/`.

* `001_*` moves the legacy `scope_path TEXT` column to a `scope JSONB`
  column with a GIN containment index. Apply step1 → deploy new binary →
  apply step2.
* `002_kb_extension.sql` adds the KB-extension columns
  (`kind`, `slug`, `access_count`, `last_accessed`, `success_rate`,
  `edges`) and their partial indices. Pure additive; safe to apply with
  the older binary still running.

Roll-forward example:

```bash
# 001 — JSONB scope (skip if already applied in your environment).
psql "$MEMORY_SERVICE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f memory/memory-service/migrations/001_scope_to_jsonb_step1.sql
# deploy JSONB-scope binary, verify ...
psql "$MEMORY_SERVICE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f memory/memory-service/migrations/001_scope_to_jsonb_step2.sql

# 002 — KB extension.
psql "$MEMORY_SERVICE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f memory/memory-service/migrations/002_kb_extension.sql
# deploy KB-extension binary; /api/kb/* lights up on the next pod.
```

See `memory/memory-service/migrations/README.md` for full rollout, rollback,
and verification instructions.

## KB Extension (`/api/kb/*`)

Optional surface mounted alongside `/api/memories/*` and gated by the
`KB_ENDPOINTS_ENABLED` env var (default `true`). KB rows are
distinguished by `kind IS NOT NULL` and never appear in the legacy
endpoints. See `docs/claw-memory-service-kb-extension-design.md` for
the contract and the activation algorithm.

## Verification

```bash
kubectl -n primus-claw port-forward svc/claw-memory-service 8765:80
curl http://localhost:8765/health
curl http://localhost:8765/api/users
```

Insert a row:

```bash
curl -X POST http://localhost:8765/api/memories/insert \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"demo","entry":{"category":"preference","content":"demo likes uv","importance":0.8}}'
```

Insert a KB article (only when `KB_ENDPOINTS_ENABLED=true`):

```bash
curl -X POST http://localhost:8765/api/kb/insert \
  -H 'Content-Type: application/json' \
  -d '{
    "scope":{"org":"hyperloom","framework":"sglang"},
    "kind":"technique",
    "slug":"smoke-test-001",
    "content":"hello kb",
    "importance":0.5
  }'
```

Check DB:

```bash
kubectl -n primus-claw exec -it statefulset/claw-memory-postgres -- \
  psql -U claw_memory -d claw_memory -c \
  "SELECT user_id, category, content FROM claw_memory_entries ORDER BY created_at DESC LIMIT 5;"
```
