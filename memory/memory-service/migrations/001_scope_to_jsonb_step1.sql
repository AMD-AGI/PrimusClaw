-- Copyright Advanced Micro Devices, Inc.
-- SPDX-License-Identifier: MIT

-- 001_scope_to_jsonb_step1.sql
--
-- Step 1 of the scope_path -> scope (JSONB) migration. Apply this BEFORE
-- rolling out the new claw-memory-service code.
--
-- Safe to re-run (idempotent). The script:
--   1. Adds a JSONB `scope` column (default '{}') if absent.
--   2. Backfills `scope` from the legacy `scope_path` text column by
--      splitting it on '/' and each segment on the first ':' to build a
--      key/value object. Only rows whose `scope` is still empty are
--      touched, so re-running after partial fills is safe.
--   3. Creates a GIN(jsonb_path_ops) index used by the new `@>` queries.
--   4. Drops the NOT NULL constraint on `scope_path` and gives it a default
--      of '' so the new binary (which only writes `scope`) can INSERT rows
--      while the legacy column is still around.
--
-- This step KEEPS the legacy `scope_path` column and its old index so the
-- old service binary continues to work during the rollout window. After
-- the new binary is fully deployed and verified, run step 2 to drop the
-- legacy column.

BEGIN;

ALTER TABLE claw_memory_entries
    ADD COLUMN IF NOT EXISTS scope JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Relax the legacy NOT NULL constraint on scope_path so the new binary can
-- INSERT rows without supplying scope_path. The old binary keeps working
-- because it always writes scope_path explicitly, and the column itself
-- is preserved (just nullable + defaulted to '') so step 2 stays the
-- only point of no return.
ALTER TABLE claw_memory_entries
    ALTER COLUMN scope_path DROP NOT NULL,
    ALTER COLUMN scope_path SET DEFAULT '';

-- Backfill: only fill rows that haven't been migrated yet.
--
-- Each segment is split on the *first* ':' only, so values that legitimately
-- contain ':' (e.g. ``model:Qwen3-14B:int8``) round-trip cleanly. This
-- matches the Python-side ``str.partition(":")`` behaviour in
-- ``postgres_store._scope_from_string``.
WITH segments AS (
    SELECT
        memory_id,
        regexp_match(seg, '^([^:]+):(.*)$') AS m
    FROM (
        SELECT memory_id,
               unnest(string_to_array(COALESCE(scope_path, ''), '/')) AS seg
        FROM claw_memory_entries
    ) s
    WHERE seg <> ''
),
parsed AS (
    SELECT
        memory_id,
        COALESCE(
            jsonb_object_agg(m[1], m[2])
                FILTER (WHERE m IS NOT NULL AND m[1] <> ''),
            '{}'::jsonb
        ) AS scope_obj
    FROM segments
    GROUP BY memory_id
)
UPDATE claw_memory_entries AS e
SET    scope = parsed.scope_obj
FROM   parsed
WHERE  e.memory_id = parsed.memory_id
  AND  (e.scope IS NULL OR e.scope = '{}'::jsonb);

CREATE INDEX IF NOT EXISTS idx_claw_memory_entries_scope_gin
    ON claw_memory_entries USING GIN (scope jsonb_path_ops)
    WHERE deleted_at IS NULL;

COMMIT;

-- Verification (run manually after step 1):
--   SELECT count(*) FILTER (WHERE scope = '{}'::jsonb) AS empty_scope_rows,
--          count(*) AS total
--   FROM   claw_memory_entries
--   WHERE  deleted_at IS NULL;
--
-- ``empty_scope_rows`` should be zero (or only equal to rows that had no
-- legacy scope_path to begin with).
