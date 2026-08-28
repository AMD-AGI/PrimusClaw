-- Copyright Advanced Micro Devices, Inc.
-- SPDX-License-Identifier: MIT

-- 002_kb_extension_rollback.sql
--
-- Reverses 002_kb_extension.sql.
--
-- Safe to run only if no callers rely on KB rows. Soft-delete any KB rows
-- first if you want to retain the data; this script drops the columns
-- entirely.

DROP INDEX IF EXISTS idx_kb_kind;
DROP INDEX IF EXISTS idx_kb_slug;
DROP INDEX IF EXISTS idx_kb_edges;
DROP INDEX IF EXISTS uniq_kb_scope_kind_slug;
DROP INDEX IF EXISTS idx_kb_lifecycle;

ALTER TABLE claw_memory_entries
    DROP COLUMN IF EXISTS kind,
    DROP COLUMN IF EXISTS slug,
    DROP COLUMN IF EXISTS access_count,
    DROP COLUMN IF EXISTS last_accessed,
    DROP COLUMN IF EXISTS success_rate,
    DROP COLUMN IF EXISTS edges;
