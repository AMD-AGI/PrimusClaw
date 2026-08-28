# Claw Memory Service

Owned memory service for the PrimusClaw ecosystem.

This service persists Claw agent memories directly into a Claw-owned Postgres
database.

## Architecture

```
Claw Brain / Admin UI / knowledge-worker
        │
        ▼
claw-memory-service
        │
        ▼
claw-memory-postgres (owned Postgres)
```

## Scope Model

Each memory row carries a JSONB **scope** dict that partitions the data.
Reads filter rows with PostgreSQL JSONB containment (`scope @> $filter`),
which means "every row whose scope is a superset of the filter".

| Use case | Stored scope |
| --- | --- |
| Default Claw user memory | `{"org":"claw","user":"abc"}` |
| Org-wide aggregation (read-only filter) | `{"org":"claw"}` |
| Hyperloom KB entry tied to a model | `{"org":"hyperloom","model_family":"qwen","model":"Qwen3-14B"}` |
| Per-session note | `{"org":"hyperloom","session":"sess_1"}` |

Both shapes are accepted at the HTTP boundary:

* `scope`: the canonical dict (preferred for new clients).
* `scopePath`: the legacy `key:val/key:val` string form. Translated
  internally and still emitted on responses for backward compatibility.

The underlying column is indexed with `GIN(scope jsonb_path_ops)`, so
ancestor/descendant lookups remain O(log n) regardless of how many
dimensions a deployment uses. See
`migrations/001_scope_to_jsonb_step1.sql` for the schema migration that
introduces this column.

## API Surface

The service exposes a legacy-compatible agent API under `/api`:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/users` | List users with stored memories |
| `GET /api/memories/stats?user_id=...` | Per-user stats |
| `POST /api/memories/list` | List memories with paging/filter/sort |
| `POST /api/memories/insert` | Insert one memory |
| `POST /api/memories/search` | Text search over stored memories |
| `GET /api/memories/{id}` | Get one memory |
| `PUT /api/memories/{id}` | Update one memory |
| `DELETE /api/memories/{id}?user_id=...` | Soft-delete one memory |
| `DELETE /api/memories` | Soft-delete all non-profile memories for a user |
| `GET /api/memories/profile/{user_id}` | Get user profile |
| `POST /api/memories/profile` | Upsert user profile |

### KB Extension (`/api/kb/*`)

Optional, gated by `KB_ENDPOINTS_ENABLED` (default `true`). Adds a
shared knowledge-base surface alongside per-user memory. KB rows are
distinguished by `kind IS NOT NULL`; legacy memory queries never see
them.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/kb/insert` | Insert a KB article (rejects on duplicate `(scope,kind,slug)`) |
| `POST /api/kb/upsert` | Idempotent write keyed by `(scope, kind, slug)` |
| `POST /api/kb/batch_insert` | Bulk insert (`on_conflict`: error / skip / upsert) |
| `POST /api/kb/list` | List KB rows with scope/kind/metadata/importance filters |
| `POST /api/kb/search` | Bigram text search restricted to KB rows |
| `POST /api/kb/activate` | 4-layer activation engine, returns a token-bounded working set |
| `POST /api/kb/touch/{id}` | Increment `access_count`, refresh `last_accessed` |
| `POST /api/kb/edges/add` | Union backlinks/contradicts edges; overwrite `superseded_by` |
| `GET /api/kb/{id}` | Fetch one KB entry |
| `DELETE /api/kb/{id}` | Soft-delete a KB row |

KB rows live under their own org (e.g. `{"org":"hyperloom",...}`) and
are invisible to the `/api/memories/*` and `/api/users` surfaces.
See `docs/claw-memory-service-kb-extension-design.md` for the
contract, the activation algorithm, and the schema migration that
backs it (`migrations/002_kb_extension.sql`).

## Runtime Configuration

| Variable | Description |
| --- | --- |
| `MEMORY_SERVICE_DATABASE_URL` | Postgres DSN for the owned memory DB |
| `MEMORY_STORAGE_DATABASE_URL` | Backward-compatible fallback DSN env name |
| `DATABASE_URL` | Generic fallback DSN env name |
| `MEMORY_SERVICE_HOST` | Bind host, default `0.0.0.0` |
| `MEMORY_SERVICE_PORT` | Bind port, default `8765` |
| `KB_ENDPOINTS_ENABLED` | Mount `/api/kb/*` (default `true`). Set to `false` for instant rollback to pre-extension behaviour without changing the image or the schema. |

Example:

```bash
MEMORY_SERVICE_DATABASE_URL=<postgres-dsn> \
  claw-memory-service
```

## Deploy

The CI workflow builds this service as:

```text
docker.io/primussafe/claw-memory-service:<tag>
```

Recommended Helm deployment:

```bash
helm upgrade --install claw-memory-service memory/memory-service/deploy/helm \
  -n primus-claw --create-namespace \
  --set image.tag=<ci-timestamp-or-latest> \
  --set postgres.auth.existingSecret=claw-memory-postgres-secret
```

That Secret supplies `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` to
both the bundled StatefulSet and the memory service.

For an externally managed Postgres instead of the bundled StatefulSet:

```bash
helm upgrade --install claw-memory-service memory/memory-service/deploy/helm \
  -n primus-claw --create-namespace \
  --set postgres.enabled=false \
  --set externalDatabase.url='<postgres-dsn>'
```

Setting `externalDatabase.url` or `externalDatabase.existingSecret` skips the
bundled Secret, Service, and StatefulSet even when `postgres.enabled` stays
`true`, and `postgres.auth.password` is then no longer required.

Rotating the bundled database password takes two steps, because the official
Postgres image only reads `POSTGRES_PASSWORD` while initialising an empty data
directory:

```bash
kubectl -n primus-claw exec sts/claw-memory-service-postgres -- \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER USER \"$POSTGRES_USER\" WITH PASSWORD '<new-password>'"
helm upgrade claw-memory-service memory/memory-service/deploy/helm \
  -n primus-claw --reuse-values \
  --set-string postgres.auth.password='<new-password>'
```

The `helm upgrade` step changes the Deployment's `checksum/postgres-secret`
annotation, so the memory-service Pods restart and pick up the new credential.

Raw manifests are still available for quick manual deployment:

```bash
# Create claw-memory-postgres-secret and claw-memory-service-secret through
# your secret manager before applying these manifests.
kubectl apply -f memory/memory-service/deploy/k8s/postgres.yaml
kubectl apply -f memory/memory-service/deploy/k8s/configmap.yaml
kubectl apply -f memory/memory-service/deploy/k8s/deployment.yaml
```

The Postgres Secret must contain `POSTGRES_DB`, `POSTGRES_USER`, and
`POSTGRES_PASSWORD`; the application Secret must contain
`MEMORY_SERVICE_DATABASE_URL`. Never store populated Secret manifests in Git.

## Claw Brain remote backend

Set these env vars in the Claw Brain deployment:

```bash
MEMORY_BACKEND=remote
MEMORY_SERVICE_URL=http://claw-memory-service.<namespace>.svc.cluster.local:8765
```

The TypeScript client also accepts the legacy `MEMORY_STORAGE_URL` env var as a fallback, but new deployments should use `MEMORY_SERVICE_URL`.
