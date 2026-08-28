# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Postgres-backed persistence for the Claw Memory Service.

This is the real backend behind `/api/*`. It stores memories directly in a
Claw-owned Postgres database and does not proxy reads or writes to any upstream
memory service.

Scopes are persisted as ``JSONB`` (column ``scope``) and queried with
JSONB containment (``@>``). The legacy slash-delimited string form
(``org:claw/user:abc``) is still accepted on the boundary and translated to a
dict on the way in. See ``migrations/001_scope_to_jsonb_step1.sql`` for the
backfill script.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Optional, Union

ScopeLike = Union[Mapping[str, Any], str, None]


class MemoryStoreError(RuntimeError):
    """Raised when the local memory store cannot satisfy a request."""

    def __init__(self, status: int, body: Any):
        super().__init__(f"memory store returned {status}: {body}")
        self.status = status
        self.body = body


@dataclass
class LocalSearchHit:
    """Search hit shape compatible with the existing HTTP handlers."""

    memory_id: str
    score: float
    content: str
    category: str
    importance: float
    scope: dict = field(default_factory=dict)
    user_id: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""

    def model_dump(self) -> dict[str, Any]:
        return self.__dict__.copy()


# Canonical ordering for the legacy ``key:val/key:val`` string form. Any keys
# not listed here are appended afterwards in alphabetical order. Kept stable so
# downstream consumers that still display ``scopePath`` see deterministic
# strings.
#
# KB-extension keys (framework / workload / precision / scale / objective) are
# included so KB rows also produce a deterministic ``scopePath`` projection.
# Insertion order in this tuple does not affect storage; ``scope`` is canonical
# JSONB and equality is key-order independent.
_SCOPE_KEY_ORDER: tuple[str, ...] = (
    "org",
    "tenant",
    "framework",
    "model_family",
    "model",
    "workload",
    "precision",
    "scale",
    "objective",
    "session",
    "user",
)


def _scope_from_string(s: str) -> dict[str, Any]:
    """Parse legacy ``key:val/key:val`` strings into a dict."""
    if not s:
        return {}
    out: dict[str, Any] = {}
    for seg in s.split("/"):
        if not seg:
            continue
        k, sep, v = seg.partition(":")
        if not sep or not k:
            continue
        out[k] = v
    return out


def _scope_to_string(scope: Optional[Mapping[str, Any]]) -> str:
    """Render a scope dict back to the legacy slash-delimited form."""
    if not scope:
        return ""
    keys = list(scope.keys())
    ordered: list[str] = []
    seen: set[str] = set()
    for k in _SCOPE_KEY_ORDER:
        if k in scope:
            ordered.append(k)
            seen.add(k)
    for k in sorted(keys):
        if k not in seen:
            ordered.append(k)
    return "/".join(f"{k}:{scope[k]}" for k in ordered if scope.get(k) not in (None, ""))


def _normalize_scope(value: ScopeLike) -> dict[str, Any]:
    """Coerce dict / legacy string / None into a plain ``dict``."""
    if value is None:
        return {}
    if isinstance(value, str):
        return _scope_from_string(value)
    if isinstance(value, Mapping):
        return {str(k): v for k, v in value.items() if v not in (None, "")}
    raise TypeError(f"unsupported scope value: {type(value).__name__}")


# ── KB extension constants ─────────────────────────────────────────────────

# Set of KB ``kind`` discriminators recognised by ``/api/kb/*``. KB rows are
# the only rows where ``kind`` is non-NULL. Legacy memory rows always have
# ``kind IS NULL`` and bypass every KB-aware code path.
KB_VALID_KINDS: frozenset[str] = frozenset(
    {
        "model_profile",
        "technique",
        "pitfall",
        "params_catalog",
        "experience",
        "skill",
    }
)

# Sentinel ``user_id`` used for KB rows. Preserves the existing NOT NULL
# constraint without modifying schema or the legacy ``/api/users``
# aggregator (which scans ``org:claw`` and groups by user). KB rows live
# under different orgs (``hyperloom``, ...) so they are invisible to that
# aggregator.
KB_USER_SENTINEL: str = "__kb__"

# KB rows reuse the legacy ``category`` column with this fallback value to
# satisfy the existing ``VALID_XF_CATEGORIES`` enum on the wire. The true
# KB type lives in the dedicated ``kind`` column.
KB_FALLBACK_CATEGORY: str = "env_fact"


def _merge_edges(
    current: Optional[Mapping[str, Any]],
    additions: Mapping[str, Any],
) -> dict[str, Any]:
    """Merge ``edges_to_add`` into the current ``edges`` JSONB.

    - ``backlinks`` and ``contradicts`` arrays union (order-preserving dedupe).
    - ``superseded_by`` is overwritten when the addition is non-null.
    - Unknown keys are passed through unchanged from ``current`` and
      overwritten when present in ``additions``.
    """
    out: dict[str, Any] = dict(current or {})
    for key in ("backlinks", "contradicts"):
        if key not in additions:
            continue
        cur_list = list(out.get(key) or [])
        add_list = list(additions.get(key) or [])
        seen: dict[str, None] = dict.fromkeys(str(v) for v in cur_list)
        for v in add_list:
            seen.setdefault(str(v), None)
        out[key] = list(seen.keys())
    if "superseded_by" in additions:
        sup = additions.get("superseded_by")
        if sup is not None:
            out["superseded_by"] = sup
    for key, val in additions.items():
        if key in {"backlinks", "contradicts", "superseded_by"}:
            continue
        out[key] = val
    return out


def _merge_metadata(
    current: Optional[Mapping[str, Any]],
    additions: Optional[Mapping[str, Any]],
) -> dict[str, Any]:
    """Deep-merge KB metadata without losing existing evidence fields."""
    out: dict[str, Any] = dict(current or {})
    for key, value in (additions or {}).items():
        existing = out.get(key)
        if isinstance(existing, Mapping) and isinstance(value, Mapping):
            out[key] = _merge_metadata(existing, value)
        elif isinstance(existing, list) and isinstance(value, list):
            merged = list(existing)
            for item in value:
                if item not in merged:
                    merged.append(item)
            out[key] = merged
        else:
            out[key] = value
    return out


class PostgresMemoryStore:
    """Async Postgres store used by the real `/api/*` routes."""

    def __init__(self, dsn: str) -> None:
        if not dsn:
            raise ValueError("Postgres DSN is required")
        self._dsn = dsn
        self._pool: Any = None

    async def connect(self) -> None:
        import asyncpg

        async def init_connection(conn: Any) -> None:
            await conn.set_type_codec(
                "jsonb",
                encoder=json.dumps,
                decoder=json.loads,
                schema="pg_catalog",
            )
            await conn.set_type_codec(
                "json",
                encoder=json.dumps,
                decoder=json.loads,
                schema="pg_catalog",
            )

        self._pool = await asyncpg.create_pool(
            self._dsn,
            min_size=1,
            max_size=5,
            init=init_connection,
        )
        async with self._pool.acquire() as conn:
            await conn.execute(_SCHEMA_SQL)

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()

    async def store(
        self,
        content: str,
        *,
        category: str = "env_fact",
        importance: float = 0.5,
        tags: Optional[list[str]] = None,
        metadata: Optional[dict] = None,
        scope: ScopeLike = None,
        scope_path: ScopeLike = None,
        user_id: Optional[str] = None,
        immutable: bool = False,
    ) -> dict:
        memory_id = f"mem_{uuid.uuid4().hex[:12]}"
        metadata = metadata or {}
        scope_dict = _normalize_scope(scope if scope is not None else scope_path)
        if not scope_dict:
            scope_dict = {"org": "claw"}
            if user_id:
                scope_dict["user"] = user_id

        row = await self._fetchrow(
            """
            INSERT INTO claw_memory_entries (
                memory_id, user_id, category, content, importance, tags,
                metadata, scope, immutable
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
            RETURNING *
            """,
            memory_id,
            user_id or "",
            category,
            content,
            float(importance),
            tags or [],
            metadata,
            scope_dict,
            immutable,
        )
        return self._row_to_dict(row)

    async def get(self, memory_id: str) -> Optional[dict]:
        row = await self._fetchrow(
            """
            SELECT *
            FROM claw_memory_entries
            WHERE memory_id = $1 AND deleted_at IS NULL
            """,
            memory_id,
        )
        return self._row_to_dict(row) if row else None

    async def update(self, memory_id: str, **fields: Any) -> dict:
        allowed = {"content", "category", "importance", "metadata", "tags", "scope"}
        # Map legacy ``scope_path`` callers onto ``scope``.
        if "scope_path" in fields and "scope" not in fields:
            fields["scope"] = fields.pop("scope_path")
        updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
        if "scope" in updates:
            updates["scope"] = _normalize_scope(updates["scope"])
        if not updates:
            existing = await self.get(memory_id)
            if not existing:
                raise MemoryStoreError(404, f"memory {memory_id} not found")
            return existing

        assignments: list[str] = []
        values: list[Any] = []
        for idx, (key, value) in enumerate(updates.items(), start=2):
            if key in ("metadata", "scope"):
                assignments.append(f"{key} = ${idx}::jsonb")
            else:
                assignments.append(f"{key} = ${idx}")
            values.append(value)

        sql = f"""
            UPDATE claw_memory_entries
            SET {", ".join(assignments)}, updated_at = now()
            WHERE memory_id = $1 AND deleted_at IS NULL
            RETURNING *
        """
        row = await self._fetchrow(sql, memory_id, *values)
        if not row:
            raise MemoryStoreError(404, f"memory {memory_id} not found")
        return self._row_to_dict(row)

    async def delete(self, memory_id: str) -> bool:
        row = await self._fetchrow(
            """
            UPDATE claw_memory_entries
            SET deleted_at = now(), updated_at = now()
            WHERE memory_id = $1 AND deleted_at IS NULL
            RETURNING memory_id
            """,
            memory_id,
        )
        return row is not None

    async def list(
        self,
        *,
        scope: ScopeLike = None,
        scope_path: ScopeLike = None,
        inherit: bool = True,
        user_id: Optional[str] = None,
        category: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        scope_dict = _normalize_scope(scope if scope is not None else scope_path)
        scope_arg: Optional[dict] = scope_dict or None

        if inherit:
            # Containment: rows whose scope is a superset of `scope_dict`.
            # Empty scope filter (``None``) matches everything.
            scope_clause = "($1::jsonb IS NULL OR scope @> $1::jsonb)"
        else:
            # Exact match. JSONB equality is canonical (key-order
            # independent), so this works regardless of insertion order.
            scope_clause = "($1::jsonb IS NULL OR scope = $1::jsonb)"

        sql = f"""
            SELECT *
            FROM claw_memory_entries
            WHERE deleted_at IS NULL
              AND {scope_clause}
              AND ($2::text IS NULL OR user_id = $2)
              AND ($3::text IS NULL OR category = $3)
            ORDER BY updated_at DESC, created_at DESC
            LIMIT $4 OFFSET $5
        """
        rows = await self._fetch(
            sql,
            scope_arg,
            user_id,
            category,
            int(limit),
            int(offset),
        )
        return {"results": [self._row_to_dict(r) for r in rows]}

    async def search(
        self,
        query: str,
        *,
        scope: ScopeLike = None,
        scope_path: ScopeLike = None,
        inherit: bool = True,
        top_k: int = 10,
        threshold: float = 0.0,
        filters: Optional[dict] = None,
        weights: Optional[dict] = None,
        user_id: Optional[str] = None,
    ) -> list[LocalSearchHit]:
        rows = (
            await self.list(
                scope=scope if scope is not None else scope_path,
                inherit=inherit,
                user_id=user_id,
                limit=max(1000, top_k * 20),
            )
        ).get("results", [])

        q_grams = _bigrams(query)
        if not q_grams:
            return []

        scored: list[tuple[float, dict]] = []
        for row in rows:
            if row.get("metadata", {}).get("is_user_profile") is True:
                continue
            c_grams = _bigrams(row.get("content", ""))
            overlap = len(q_grams & c_grams)
            if overlap == 0:
                continue
            score = overlap / len(q_grams)
            if query.strip().lower() in row.get("content", "").lower():
                score = max(score, 0.92)
            if score >= threshold:
                scored.append((round(min(1.0, score), 3), row))

        scored.sort(key=lambda x: (x[0], x[1].get("importance", 0.0)), reverse=True)
        return [
            LocalSearchHit(
                memory_id=row["memory_id"],
                score=score,
                content=row["content"],
                category=row["category"],
                importance=row["importance"],
                scope=row.get("scope") or {},
                user_id=row.get("user_id"),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
            for score, row in scored[:top_k]
        ]

    # ── KB extension methods ─────────────────────────────────────────────
    #
    # All KB methods explicitly filter by ``kind IS NOT NULL`` so they can
    # never read or mutate legacy memory rows. KB rows always carry
    # ``user_id = KB_USER_SENTINEL`` and ``category = KB_FALLBACK_CATEGORY``
    # to satisfy the existing NOT NULL constraints; ``kind`` is the real
    # type discriminator.

    async def kb_insert(
        self,
        *,
        scope: ScopeLike,
        kind: str,
        slug: str,
        content: str,
        importance: float = 0.5,
        metadata: Optional[Mapping[str, Any]] = None,
        edges: Optional[Mapping[str, Any]] = None,
        source_session: Optional[str] = None,
        source_type: Optional[str] = None,
    ) -> dict:
        """Insert a new KB article. Raises ``MemoryStoreError(409)`` on
        duplicate ``(scope, kind, slug)``.
        """
        import asyncpg  # lazy import; not needed for non-PG tests

        if kind not in KB_VALID_KINDS:
            raise MemoryStoreError(400, f"kind must be one of {sorted(KB_VALID_KINDS)}")
        if not slug:
            raise MemoryStoreError(400, "slug is required")

        scope_dict = _normalize_scope(scope)
        if not scope_dict:
            raise MemoryStoreError(400, "scope is required for KB rows")

        meta = dict(metadata or {})
        if source_session is not None:
            meta["source_session"] = source_session
        if source_type is not None:
            meta["source_type"] = source_type

        edges_dict = dict(edges or {})

        memory_id = f"mem_{uuid.uuid4().hex[:12]}"
        try:
            row = await self._fetchrow(
                """
                INSERT INTO claw_memory_entries (
                    memory_id, user_id, category, content, importance, tags,
                    metadata, scope, immutable, kind, slug, edges
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
                        false, $9, $10, $11::jsonb)
                RETURNING *
                """,
                memory_id,
                KB_USER_SENTINEL,
                KB_FALLBACK_CATEGORY,
                content,
                float(importance),
                [],
                meta,
                scope_dict,
                kind,
                slug,
                edges_dict,
            )
        except asyncpg.exceptions.UniqueViolationError as e:
            raise MemoryStoreError(
                409,
                f"kb row already exists for scope={scope_dict} kind={kind} slug={slug}",
            ) from e
        return self._row_to_dict(row)

    async def kb_upsert(
        self,
        *,
        scope: ScopeLike,
        kind: str,
        slug: str,
        content: Optional[str] = None,
        importance: Optional[float] = 0.5,
        metadata: Optional[Mapping[str, Any]] = None,
        edges: Optional[Mapping[str, Any]] = None,
        source_session: Optional[str] = None,
        source_type: Optional[str] = None,
    ) -> tuple[dict, str]:
        """Idempotent upsert keyed by ``(scope, kind, slug)``.

        Returns ``(entry, action)`` where ``action`` is ``"inserted"`` or
        ``"updated"``.
        """
        if kind not in KB_VALID_KINDS:
            raise MemoryStoreError(400, f"kind must be one of {sorted(KB_VALID_KINDS)}")

        scope_dict = _normalize_scope(scope)
        if not scope_dict:
            raise MemoryStoreError(400, "scope is required for KB rows")

        existing = await self._fetchrow(
            """
            SELECT *
            FROM claw_memory_entries
            WHERE deleted_at IS NULL
              AND kind IS NOT NULL
              AND scope = $1::jsonb
              AND kind  = $2
              AND slug  = $3
            """,
            scope_dict, kind, slug,
        )

        meta = dict(metadata or {})
        if source_session is not None:
            meta["source_session"] = source_session
        if source_type is not None:
            meta["source_type"] = source_type
        edges_dict = dict(edges or {})

        if existing:
            existing_dict = self._row_to_dict(existing)
            final_content = content if content is not None else existing_dict.get("content", "")
            existing_importance = float(existing_dict.get("importance", 0.5))
            final_importance = (
                existing_importance
                if importance is None
                else max(existing_importance, float(importance))
            )
            merged_meta = _merge_metadata(existing_dict.get("metadata") or {}, meta)
            merged_edges = _merge_edges(existing_dict.get("edges") or {}, edges_dict)
            row = await self._fetchrow(
                """
                UPDATE claw_memory_entries
                SET content    = $2,
                    importance = $3,
                    metadata   = $4::jsonb,
                    edges      = $5::jsonb,
                    updated_at = now()
                WHERE memory_id = $1 AND deleted_at IS NULL
                RETURNING *
                """,
                existing["memory_id"],
                final_content,
                final_importance,
                merged_meta,
                merged_edges,
            )
            return self._row_to_dict(row), "updated"

        entry = await self.kb_insert(
            scope=scope_dict,
            kind=kind,
            slug=slug,
            content=content or "",
            importance=0.5 if importance is None else importance,
            metadata=meta,
            edges=edges_dict,
        )
        return entry, "inserted"

    async def kb_get(self, memory_id: str) -> Optional[dict]:
        row = await self._fetchrow(
            """
            SELECT *
            FROM claw_memory_entries
            WHERE memory_id = $1
              AND deleted_at IS NULL
              AND kind IS NOT NULL
            """,
            memory_id,
        )
        return self._row_to_dict(row) if row else None

    async def kb_delete(self, memory_id: str) -> bool:
        row = await self._fetchrow(
            """
            UPDATE claw_memory_entries
            SET deleted_at = now(), updated_at = now()
            WHERE memory_id = $1
              AND deleted_at IS NULL
              AND kind IS NOT NULL
            RETURNING memory_id
            """,
            memory_id,
        )
        return row is not None

    async def kb_list(
        self,
        *,
        scope_filter: ScopeLike = None,
        kind: Optional[Any] = None,
        metadata_filter: Optional[Mapping[str, Any]] = None,
        importance_min: Optional[float] = None,
        sort_by: str = "importance",
        order: str = "desc",
        limit: int = 100,
        offset: int = 0,
    ) -> dict:
        """List KB rows with composable filters. ``kind`` may be ``str`` or
        ``Iterable[str]``."""
        scope_dict = _normalize_scope(scope_filter)
        scope_arg: Optional[dict] = scope_dict or None

        kinds_arg: Optional[list[str]]
        if kind is None:
            kinds_arg = None
        elif isinstance(kind, str):
            kinds_arg = [kind]
        else:
            kinds_arg = [str(k) for k in kind]

        meta_arg: Optional[dict] = (
            dict(metadata_filter) if metadata_filter else None
        )

        sort_col = {
            "importance":   "importance",
            "updated_at":   "updated_at",
            "access_count": "access_count",
        }.get(sort_by, "importance")
        order_sql = "DESC" if order.lower() == "desc" else "ASC"

        sql = f"""
            SELECT *
            FROM claw_memory_entries
            WHERE deleted_at IS NULL
              AND kind IS NOT NULL
              AND ($1::jsonb IS NULL OR scope @> $1::jsonb)
              AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
              AND ($3::jsonb IS NULL OR metadata @> $3::jsonb)
              AND ($4::float8 IS NULL OR importance >= $4)
            ORDER BY {sort_col} {order_sql}, updated_at DESC
            LIMIT $5 OFFSET $6
        """
        rows = await self._fetch(
            sql,
            scope_arg,
            kinds_arg,
            meta_arg,
            None if importance_min is None else float(importance_min),
            int(limit),
            int(offset),
        )
        return {"entries": [self._row_to_dict(r) for r in rows]}

    async def kb_search(
        self,
        query: str,
        *,
        scope_filter: ScopeLike = None,
        kind: Optional[Any] = None,
        top_k: int = 20,
        threshold: float = 0.1,
    ) -> list[tuple[dict, float]]:
        """Bigram text search restricted to KB rows. Mirrors the legacy
        memory search: O(n) scan over a bounded window with the same
        scoring formula."""
        resp = await self.kb_list(
            scope_filter=scope_filter,
            kind=kind,
            limit=max(1000, top_k * 20),
            sort_by="updated_at",
        )
        rows = resp.get("entries", [])

        q_grams = _bigrams(query)
        if not q_grams:
            return []

        scored: list[tuple[float, dict]] = []
        ql = query.strip().lower()
        for row in rows:
            c_grams = _bigrams(row.get("content", ""))
            overlap = len(q_grams & c_grams)
            if overlap == 0:
                continue
            score = overlap / len(q_grams)
            if ql and ql in (row.get("content") or "").lower():
                score = max(score, 0.92)
            if score >= threshold:
                scored.append((round(min(1.0, score), 3), row))

        scored.sort(key=lambda x: (x[0], x[1].get("importance", 0.0)), reverse=True)
        return [(row, score) for score, row in scored[:top_k]]

    async def kb_touch(
        self,
        memory_id: str,
        *,
        success: Optional[bool] = None,
    ) -> Optional[dict]:
        """Update lifecycle counters for one KB row."""
        current = await self._fetchrow(
            """
            SELECT access_count, success_rate
            FROM claw_memory_entries
            WHERE memory_id = $1
              AND deleted_at IS NULL
              AND kind IS NOT NULL
            """,
            memory_id,
        )
        if current is None:
            return None

        old_count = int(current["access_count"] or 0)
        new_count = old_count + 1
        success_rate = current["success_rate"]
        if success is not None:
            incoming = 1.0 if success else 0.0
            success_rate = incoming if success_rate is None else (
                float(success_rate) * old_count + incoming
            ) / new_count

        row = await self._fetchrow(
            """
            UPDATE claw_memory_entries
            SET access_count = access_count + 1,
                last_accessed = now(),
                success_rate = $2
            WHERE memory_id = $1
              AND deleted_at IS NULL
              AND kind IS NOT NULL
            RETURNING *
            """,
            memory_id,
            success_rate,
        )
        return self._row_to_dict(row) if row else None

    async def kb_add_edges(
        self,
        memory_id: str,
        edges_to_add: Mapping[str, Any],
    ) -> Optional[dict]:
        """Merge ``edges_to_add`` into the row's ``edges`` JSONB. Returns
        the merged ``edges`` dict, or ``None`` if the row is not a KB row.
        """
        existing_row = await self._fetchrow(
            """
            SELECT edges
            FROM claw_memory_entries
            WHERE memory_id = $1
              AND deleted_at IS NULL
              AND kind IS NOT NULL
            """,
            memory_id,
        )
        if existing_row is None:
            return None
        current = existing_row["edges"] or {}
        if isinstance(current, str):
            current = json.loads(current)
        merged = _merge_edges(current, edges_to_add)
        await self._fetchrow(
            """
            UPDATE claw_memory_entries
            SET edges = $2::jsonb,
                updated_at = now()
            WHERE memory_id = $1
              AND deleted_at IS NULL
              AND kind IS NOT NULL
            RETURNING memory_id
            """,
            memory_id,
            merged,
        )
        return merged

    async def kb_org_candidates(
        self,
        *,
        org: str,
        kinds: Optional[list[str]] = None,
        candidate_cap: int = 200,
    ) -> list[dict]:
        """Return all live KB rows under ``scope @> {"org": <org>}``.

        Activation Layer 0/1 weighting is applied in Python; this method
        intentionally returns the raw rows + the partial composite
        ordering. ``candidate_cap`` is the hard ceiling before Layer 1
        spread; default 200 mirrors the design spec.
        """
        kinds_arg: Optional[list[str]] = list(kinds) if kinds else None
        org_filter = {"org": org}
        rows = await self._fetch(
            """
            SELECT *
            FROM claw_memory_entries
            WHERE deleted_at IS NULL
              AND kind IS NOT NULL
              AND scope @> $1::jsonb
              AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
            ORDER BY importance DESC, access_count DESC, updated_at DESC
            LIMIT $3
            """,
            org_filter,
            kinds_arg,
            int(candidate_cap),
        )
        return [self._row_to_dict(r) for r in rows]

    async def kb_count(
        self,
        *,
        scope_filter: ScopeLike = None,
        kind: Optional[Any] = None,
    ) -> int:
        """Return the count of live KB rows matching the filters.

        Used by lightweight stats endpoints that need a totals-only view
        without paging through ``kb_list``.
        """
        scope_dict = _normalize_scope(scope_filter)
        scope_arg: Optional[dict] = scope_dict or None

        kinds_arg: Optional[list[str]]
        if kind is None:
            kinds_arg = None
        elif isinstance(kind, str):
            kinds_arg = [kind]
        else:
            kinds_arg = [str(k) for k in kind]

        row = await self._fetchrow(
            """
            SELECT COUNT(*) AS n
            FROM claw_memory_entries
            WHERE deleted_at IS NULL
              AND kind IS NOT NULL
              AND ($1::jsonb IS NULL OR scope @> $1::jsonb)
              AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
            """,
            scope_arg,
            kinds_arg,
        )
        return int((row or {}).get("n") or 0)

    async def kb_fetch_by_slugs(
        self,
        *,
        org: str,
        slugs: list[str],
    ) -> list[dict]:
        """Fetch live KB rows whose ``slug`` is in ``slugs`` and that share
        the activation context's ``org``."""
        if not slugs:
            return []
        rows = await self._fetch(
            """
            SELECT *
            FROM claw_memory_entries
            WHERE deleted_at IS NULL
              AND kind IS NOT NULL
              AND slug = ANY($1::text[])
              AND scope @> $2::jsonb
            """,
            [str(s) for s in slugs],
            {"org": org},
        )
        return [self._row_to_dict(r) for r in rows]

    async def _fetchrow(self, sql: str, *args: Any) -> Any:
        if not self._pool:
            raise MemoryStoreError(503, "Postgres store is not connected")
        async with self._pool.acquire() as conn:
            return await conn.fetchrow(sql, *args)

    async def _fetch(self, sql: str, *args: Any) -> list[Any]:
        if not self._pool:
            raise MemoryStoreError(503, "Postgres store is not connected")
        async with self._pool.acquire() as conn:
            return await conn.fetch(sql, *args)

    @staticmethod
    def _row_to_dict(row: Any) -> dict[str, Any]:
        d = dict(row)
        metadata = d.get("metadata") or {}
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        d["metadata"] = metadata

        scope_val = d.get("scope") or {}
        if isinstance(scope_val, str):
            scope_val = json.loads(scope_val)
        d["scope"] = scope_val
        # Provide a stringified projection for any callers that still read
        # ``scope_path`` (handlers, frontends, legacy clients). It is purely
        # derived; the source of truth is ``scope``.
        d["scope_path"] = _scope_to_string(scope_val)

        if "edges" in d:
            edges_val = d.get("edges") or {}
            if isinstance(edges_val, str):
                edges_val = json.loads(edges_val)
            d["edges"] = edges_val

        for key in ("created_at", "updated_at", "deleted_at", "last_accessed"):
            if isinstance(d.get(key), datetime):
                d[key] = d[key].astimezone(timezone.utc).isoformat()
        return d


def _bigrams(text: str) -> set[str]:
    cleaned = re.sub(r"\s+", "", (text or "").lower())
    if len(cleaned) < 2:
        return set()
    return {cleaned[i:i + 2] for i in range(len(cleaned) - 1)}


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS claw_memory_entries (
    memory_id     TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    category      TEXT NOT NULL,
    content       TEXT NOT NULL,
    importance    DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    tags          TEXT[] NOT NULL DEFAULT '{}',
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    scope         JSONB NOT NULL DEFAULT '{}'::jsonb,
    immutable     BOOLEAN NOT NULL DEFAULT false,
    -- KB-extension columns (added in 002_kb_extension.sql; mirrored here so
    -- fresh installs match the post-migration shape).
    kind          TEXT,
    slug          TEXT,
    access_count  BIGINT NOT NULL DEFAULT 0,
    last_accessed TIMESTAMPTZ,
    success_rate  REAL,
    edges         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_claw_memory_entries_user_active
    ON claw_memory_entries (user_id, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_claw_memory_entries_scope_gin
    ON claw_memory_entries USING GIN (scope jsonb_path_ops)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_claw_memory_entries_category_active
    ON claw_memory_entries (category)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_claw_memory_entries_metadata_gin
    ON claw_memory_entries USING GIN (metadata);

-- KB-extension indices (partial: only KB rows). Legacy query plans on
-- ``kind IS NULL`` rows are unaffected.
CREATE INDEX IF NOT EXISTS idx_kb_kind
    ON claw_memory_entries (kind)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_slug
    ON claw_memory_entries (slug)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_edges
    ON claw_memory_entries USING GIN (edges)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_scope_kind_slug
    ON claw_memory_entries (scope, kind, slug)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_lifecycle
    ON claw_memory_entries (importance DESC, access_count DESC, updated_at DESC)
    WHERE deleted_at IS NULL AND kind IS NOT NULL;
"""
