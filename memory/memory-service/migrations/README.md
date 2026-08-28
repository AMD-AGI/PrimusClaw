# Memory Service Migrations

Numbered SQL migrations for `claw-memory-postgres`. Apply them in order
with `psql` (or any SQL runner).

* `001_*` introduces the `scope JSONB` column that replaces the legacy
  `scope_path TEXT` column. Split into two steps so existing deployments
  can roll the new service binary without downtime.
* `002_kb_extension.sql` adds the KB-extension columns (`kind`, `slug`,
  `access_count`, `last_accessed`, `success_rate`, `edges`) and their
  partial indices. Pure `ADD COLUMN`; safe to run live against PG 16 in
  well under a second on the current row counts.

## File layout

| File | When to run |
| --- | --- |
| `001_scope_to_jsonb_step1.sql` | **Before** deploying the JSONB-scope service binary. Adds the JSONB column, backfills it, and creates the new GIN index. The legacy column stays intact, so the old binary keeps working. |
| `001_scope_to_jsonb_step2.sql` | **After** the JSONB-scope binary is deployed and verified. Drops the legacy `scope_path` column and its index. |
| `001_scope_to_jsonb_rollback.sql` | Rollback for step 1 only. Cannot recover from step 2 without a backup. |
| `002_kb_extension.sql` | **Before** deploying the KB-extension binary. Adds the 6 KB columns and 5 partial indices. Older binaries ignore the new columns entirely. |
| `002_kb_extension_rollback.sql` | Drops the KB columns and indices. Run only if you also disable `KB_ENDPOINTS_ENABLED` and verify there are no live KB rows. |

## Recommended rollout

1. **Snapshot**: `pg_dump -Fc claw_memory > /backup/claw_memory_pre_jsonb.dump`
2. **Apply step 1** (idempotent, safe with old binary running):
   ```bash
   psql "$MEMORY_SERVICE_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f memory/memory-service/migrations/001_scope_to_jsonb_step1.sql
   ```
3. **Verify backfill**:
   ```sql
   SELECT count(*) FILTER (WHERE scope = '{}'::jsonb) AS empty_scope,
          count(*)                                     AS total
   FROM   claw_memory_entries
   WHERE  deleted_at IS NULL;
   ```
   `empty_scope` should be 0 (or only equal to rows that legitimately had
   no `scope_path`).
4. **Smoke-test reads** with the legacy binary still running (the JSONB
   column is unused by it).
5. **Deploy** the new `claw-memory-service` image (this PR). The new
   binary writes `scope` directly and reads via JSONB containment.
6. **Verify** with the new binary by listing/inserting a memory with a
   richer scope, e.g.:
   ```bash
   curl -X POST http://localhost:8765/api/memories/insert \
     -H 'Content-Type: application/json' \
     -d '{"user_id":"demo","entry":{
       "category":"env_fact",
       "content":"hello jsonb",
       "scope":{"org":"hyperloom","model_family":"qwen","model":"Qwen3-14B"}
     }}'
   ```
7. **Apply step 2** to drop the legacy column:
   ```bash
   psql "$MEMORY_SERVICE_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f memory/memory-service/migrations/001_scope_to_jsonb_step2.sql
   ```

## Rollback

* Between step 1 and step 2: run `001_scope_to_jsonb_rollback.sql` and
  redeploy the previous `claw-memory-service` image.
* After step 2: restore from the snapshot taken in step 1.

## KB extension rollout (`002_kb_extension.sql`)

Pre-flight requires `001_*` to be fully applied (the JSONB `scope`
column is the storage key for the KB unique index).

1. **Snapshot**: `pg_dump -Fc claw_memory > /backup/claw_memory_pre_kb.dump`
2. **Apply 002**:
   ```bash
   psql "$MEMORY_SERVICE_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f memory/memory-service/migrations/002_kb_extension.sql
   ```
3. **Verify columns and indices**:
   ```sql
   \d claw_memory_entries
   SELECT count(*)                    AS legacy_rows,
          count(*) FILTER (WHERE kind IS NOT NULL) AS kb_rows
   FROM   claw_memory_entries
   WHERE  deleted_at IS NULL;
   -- legacy_rows ≥ 0; kb_rows = 0 immediately post-migration.
   ```
4. **Deploy** the KB-extension binary (this PR). The default
   `KB_ENDPOINTS_ENABLED=true` activates `/api/kb/*` immediately.
5. **Smoke-test** with the canonical request:
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
   curl -X POST http://localhost:8765/api/kb/list \
     -H 'Content-Type: application/json' \
     -d '{"scope_filter":{"org":"hyperloom"}}'
   ```
6. **Rollback options** (in increasing severity):
   * Disable the routes: set `KB_ENDPOINTS_ENABLED=false` and bounce the
     pod. KB rows persist; the service responds 404 on `/api/kb/*`.
   * Drop the KB schema additions: run
     `002_kb_extension_rollback.sql`. Only safe if you accept losing
     every KB row currently in storage.

## Backfill semantics

The backfill in step 1 splits each row's `scope_path` on `/` and each
segment on the first `:` to build a JSONB object:

| Legacy `scope_path` | Backfilled `scope` |
| --- | --- |
| `org:claw` | `{"org": "claw"}` |
| `org:claw/user:abc` | `{"org": "claw", "user": "abc"}` |
| `org:claw/user:abc/session:s1` | `{"org": "claw", "user": "abc", "session": "s1"}` |
| `(empty)` | `{}` |

Each segment is split on the **first** `:` only, so values that legitimately
contain `:` (e.g. `model:Qwen3-14B:int8`) round-trip cleanly. This matches
the Python-side `str.partition(":")` behaviour in
`postgres_store._scope_from_string`.
