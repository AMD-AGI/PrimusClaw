-- Copyright Advanced Micro Devices, Inc.
-- SPDX-License-Identifier: MIT

-- 001_scope_to_jsonb_rollback.sql
--
-- Rollback for the scope_path -> scope (JSONB) migration. Use this only
-- when reverting BEFORE step 2 has been applied (i.e. while the legacy
-- `scope_path` column still exists). Once step 2 has dropped the column
-- you cannot rollback without restoring from a backup.

BEGIN;

-- Re-create the legacy index, in case step 2 has not been run but the
-- index was dropped manually.
CREATE INDEX IF NOT EXISTS idx_claw_memory_entries_scope_active
    ON claw_memory_entries (scope_path text_pattern_ops)
    WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS idx_claw_memory_entries_scope_gin;

ALTER TABLE claw_memory_entries
    DROP COLUMN IF EXISTS scope;

-- Restore the original NOT NULL constraint on scope_path. Any rows that
-- the new binary inserted with a NULL or empty scope_path during the
-- rollout window must be backfilled (or deleted) BEFORE this rollback,
-- otherwise this ALTER will fail.
UPDATE claw_memory_entries
SET    scope_path = COALESCE(NULLIF(scope_path, ''), 'org:claw')
WHERE  scope_path IS NULL OR scope_path = '';

ALTER TABLE claw_memory_entries
    ALTER COLUMN scope_path SET NOT NULL,
    ALTER COLUMN scope_path DROP DEFAULT;

COMMIT;
