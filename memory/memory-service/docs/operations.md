# Operations Guide — Claw Memory Service

> Backend/operator notes for the owned Claw memory service.

## 0. Architecture

`claw-memory-service` persists directly into a Claw-owned Postgres database.
There is no bridge to external memory infrastructure.

```
claw-memory-service  ->  claw-memory-postgres
```

## 1. Deploy

```powershell
# Create claw-memory-postgres-secret and claw-memory-service-secret through
# the environment's secret manager before applying the workloads.
kubectl apply -f memory/memory-service/deploy/k8s/postgres.yaml
kubectl -n primus-claw rollout status statefulset/claw-memory-postgres --timeout=180s

kubectl apply -f memory/memory-service/deploy/k8s/configmap.yaml
kubectl apply -f memory/memory-service/deploy/k8s/deployment.yaml
kubectl -n primus-claw rollout restart deploy/claw-memory-service
kubectl -n primus-claw rollout status deploy/claw-memory-service --timeout=120s
```

The Postgres Secret requires `POSTGRES_DB`, `POSTGRES_USER`, and
`POSTGRES_PASSWORD`; the application Secret requires
`MEMORY_SERVICE_DATABASE_URL`. Do not store populated Secret manifests in Git.

### 1.1 Schema migrations

Apply the numbered migrations in `memory/memory-service/migrations/`
in order (see `migrations/README.md` for full notes).

```powershell
# 001 — scope_path TEXT -> scope JSONB (skip if already applied).
psql $env:MEMORY_SERVICE_DATABASE_URL -v ON_ERROR_STOP=1 `
  -f memory/memory-service/migrations/001_scope_to_jsonb_step1.sql
# Roll out the JSONB-scope binary, verify ...
psql $env:MEMORY_SERVICE_DATABASE_URL -v ON_ERROR_STOP=1 `
  -f memory/memory-service/migrations/001_scope_to_jsonb_step2.sql

# 002 — KB extension (additive; safe with the old binary running).
psql $env:MEMORY_SERVICE_DATABASE_URL -v ON_ERROR_STOP=1 `
  -f memory/memory-service/migrations/002_kb_extension.sql
# Roll out the KB-extension binary; /api/kb/* lights up via
# KB_ENDPOINTS_ENABLED (default true).
```

To roll back 002 without dropping data, set `KB_ENDPOINTS_ENABLED=false`
and restart the pod — `/api/kb/*` returns 404 and KB rows are inert.
Drop the schema additions only if you accept losing every KB row:

```powershell
psql $env:MEMORY_SERVICE_DATABASE_URL -v ON_ERROR_STOP=1 `
  -f memory/memory-service/migrations/002_kb_extension_rollback.sql
```

## 2. Smoke Test

```powershell
kubectl -n primus-claw port-forward svc/claw-memory-service 8765:80

$BASE = "http://localhost:8765"
$UID = "demo_chenluo"

curl "$BASE/health"   # {"status":"ok","kb_endpoints":true}

curl -Method POST "$BASE/api/memories/insert" -ContentType "application/json" -Body @"
{"user_id":"$UID","entry":{"category":"preference","content":"chenluo likes uv","importance":0.85,"sourceType":"manual"}}
"@

curl "$BASE/api/users"
curl "$BASE/api/memories/stats?user_id=$UID"
```

KB-extension smoke (only when `KB_ENDPOINTS_ENABLED=true`):

```powershell
curl -Method POST "$BASE/api/kb/insert" -ContentType "application/json" -Body @"
{"scope":{"org":"hyperloom","framework":"sglang"},"kind":"technique","slug":"smoke-test-001","content":"hello kb","importance":0.5}
"@

curl -Method POST "$BASE/api/kb/list" -ContentType "application/json" -Body @"
{"scope_filter":{"org":"hyperloom"}}
"@

curl -Method POST "$BASE/api/kb/activate" -ContentType "application/json" -Body @"
{"activation_context":{"org":"hyperloom","framework":"sglang","model":"deepseek-r1-0528-fp8","model_family":"deepseek","workload":"decode","precision":"fp8"}}
"@
```

## 3. Direct DB Check

```powershell
kubectl -n primus-claw exec -it statefulset/claw-memory-postgres -- psql -U claw_memory -d claw_memory
```

Inside `psql`:

```sql
SELECT memory_id, user_id, category, scope, content, created_at
FROM claw_memory_entries
ORDER BY created_at DESC
LIMIT 20;

-- Find every memory under a Hyperloom model family using JSONB containment.
SELECT memory_id, scope, content
FROM claw_memory_entries
WHERE deleted_at IS NULL
  AND scope @> '{"org":"hyperloom","model_family":"qwen"}'::jsonb
ORDER BY updated_at DESC
LIMIT 20;

-- KB rows only.
SELECT memory_id, kind, slug, scope, importance, access_count
FROM claw_memory_entries
WHERE deleted_at IS NULL
  AND kind IS NOT NULL
ORDER BY importance DESC, access_count DESC
LIMIT 20;
```

## 4. Troubleshooting

| Symptom | Likely Cause | Check |
| --- | --- | --- |
| `/api/*` returns 503 | DB DSN missing or DB unavailable | `kubectl logs deploy/claw-memory-service -n primus-claw` |
| Pod CrashLoopBackOff | Cannot connect to Postgres | Check `MEMORY_SERVICE_DATABASE_URL` secret and Postgres pod |
| `/api/users` empty | No writes yet | Insert a demo row via `/api/memories/insert` |
