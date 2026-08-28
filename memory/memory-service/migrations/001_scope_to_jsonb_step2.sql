-- Copyright Advanced Micro Devices, Inc.
-- SPDX-License-Identifier: MIT

-- 001_scope_to_jsonb_step2.sql
--
-- Step 2 of the scope_path -> scope (JSONB) migration. Apply this ONLY
-- after step 1 has been run AND the new claw-memory-service code is
-- fully deployed and verified in your environment.
--
-- This drops the legacy `scope_path` text column and its old index. After
-- this point, rolling back to a pre-JSONB binary requires restoring the
-- column from a backup.

BEGIN;

DROP INDEX IF EXISTS idx_claw_memory_entries_scope_active;

ALTER TABLE claw_memory_entries
    DROP COLUMN IF EXISTS scope_path;

COMMIT;
