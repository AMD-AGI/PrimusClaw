-- Copyright Advanced Micro Devices, Inc.
-- SPDX-License-Identifier: MIT

-- 002_kb_extension.sql
--
-- Add KB-extension columns and indices to ``claw_memory_entries``.
-- This migration is purely additive and safe to run while the service is
-- live: ``ADD COLUMN IF NOT EXISTS`` with defaults takes a brief lock but
-- does not rewrite the table (PG 11+ stores defaults as metadata), and all
-- new indices are partial (``WHERE kind IS NOT NULL``) so legacy query
-- plans are unaffected.
--
-- For very large tables, the deploy runner can replace ``CREATE INDEX``
-- with ``CREATE INDEX CONCURRENTLY`` (one statement per transaction).
-- For typical deployment sizes, plain ``CREATE INDEX`` finishes in well
-- under a second, so we keep the simple form here. Use
-- ``CREATE INDEX CONCURRENTLY`` when tables are very large.
--
-- See migrations/README.md for the rollout sequence and verification
-- queries.

ALTER TABLE claw_memory_entries
    ADD COLUMN IF NOT EXISTS kind          TEXT,
    ADD COLUMN IF NOT EXISTS slug          TEXT,
    ADD COLUMN IF NOT EXISTS access_count  BIGINT      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS success_rate  REAL,
    ADD COLUMN IF NOT EXISTS edges         JSONB       NOT NULL DEFAULT '{}'::jsonb;

-- Discriminator + slug lookups (e.g. /api/kb/list filters).
CREATE INDEX IF NOT EXISTS idx_kb_kind
    ON claw_memory_entries (kind)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_slug
    ON claw_memory_entries (slug)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;

-- Edges JSONB containment (used by activation spread + admin queries).
CREATE INDEX IF NOT EXISTS idx_kb_edges
    ON claw_memory_entries USING GIN (edges)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;

-- Idempotent upsert key + duplicate guard for /api/kb/insert.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_scope_kind_slug
    ON claw_memory_entries (scope, kind, slug)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;

-- Composite ordering used by the activation candidate scan and lifecycle
-- queries (highest importance first, then most-touched, then most-recent).
CREATE INDEX IF NOT EXISTS idx_kb_lifecycle
    ON claw_memory_entries (importance DESC, access_count DESC, updated_at DESC)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;
