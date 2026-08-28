# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""HTTP handlers for the Claw Memory Service.

Maps the agent-facing API surface (legacy category names, user-scoped)
onto Claw-owned Postgres storage.

Scopes are persisted as JSONB on the storage layer. This module accepts
both the new ``scope`` dict and the legacy ``scopePath`` slash-delimited
string on input, and emits both shapes on output for backward compatibility
with existing TypeScript clients and the admin UI.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from claw_memory.storage.config import DATABASE_URL
from claw_memory.storage.postgres_store import (
    MemoryStoreError,
    PostgresMemoryStore,
    _normalize_scope,
    _scope_to_string,
)

log = logging.getLogger(__name__)

store: Optional[PostgresMemoryStore] = None

router = APIRouter()


# ── Error mapping ────────────────────────────────────────────────────────
#
# MemoryStoreError bodies are written in postgres_store for the caller -- "slug is
# required", "memory %s not found" -- and are returned as-is. Where asyncpg raises,
# it is attached with `from e` and stays out of the body, so nothing internal
# travels in one.
#
# An unforeseen exception is the opposite: its message is written by whichever
# library raised it, and this service installs no authentication, so anything able
# to reach it could read whatever that message happened to carry. Those are
# answered with a fixed phrase and logged instead.
#
# stacklevel=2 attributes the log line to the handler that failed rather than to
# this helper, which is the part worth knowing.

def unexpected_error(e: Exception) -> HTTPException:
    """Map an unforeseen failure to a response that omits its message."""
    log.exception("unhandled error serving request: %s", type(e).__name__, stacklevel=2)
    return HTTPException(status_code=500, detail="internal error")


# ── Lifecycle ────────────────────────────────────────────────────────────

@router.on_event("startup")
async def startup() -> None:
    global store
    if not DATABASE_URL:
        raise RuntimeError(
            "PostgresMemoryStore configuration is incomplete: set a database URL "
            "or POSTGRES_HOST, POSTGRES_DB, POSTGRES_USER, and POSTGRES_PASSWORD"
        )
    store = PostgresMemoryStore(DATABASE_URL)
    await store.connect()
    log.info("PostgresMemoryStore initialized")


@router.on_event("shutdown")
async def shutdown() -> None:
    if store:
        await store.close()


def _get_client() -> Any:
    """Return the configured Postgres store."""
    if not store:
        raise HTTPException(status_code=503, detail="MemoryService database not configured")
    return store


# ── Category mapping ─────────────────────────────────────────────────────
# Claw stores its domain categories directly in its own Postgres table.
VALID_XF_CATEGORIES = {
    "preference",
    "correction",
    "env_fact",
    "tool_quirk",
    "pattern",
    "user_profile",
}
VALID_SORT_FIELDS = {"updated_at", "created_at", "importance"}
VALID_ORDER = {"asc", "desc"}


# ── Helpers ──────────────────────────────────────────────────────────────

# Project-wide parent scope. With JSONB containment (``@>``) the parent
# scope automatically matches every descendant: a row with
# ``{"org":"claw","user":"abc"}`` satisfies ``scope @> {"org":"claw"}``.
_PARENT_SCOPE: Dict[str, Any] = {"org": "claw"}


def _default_scope(user_id: str) -> Dict[str, Any]:
    """Return the canonical user-scoped dict.

    Unlike the previous slash-delimited form, JSONB containment means we
    can safely pass this same dict to both reads (filter rows whose scope
    is a superset of this) and writes (the row stores it verbatim).
    """
    return {**_PARENT_SCOPE, "user": user_id}


def _resolve_legacy_category(entry: Dict[str, Any]) -> str:
    meta = entry.get("metadata") or {}
    return meta.get("claw_category") or entry.get("category", "env_fact")


def _is_user_profile(entry: Dict[str, Any]) -> bool:
    return (entry.get("metadata") or {}).get("is_user_profile") is True


def _wrap_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a stored memory row to the legacy agent API shape used by frontends."""
    meta = entry.get("metadata") or {}
    scope = entry.get("scope") or {}
    return {
        "id":             str(entry.get("memory_id") or entry.get("id") or ""),
        "category":       _resolve_legacy_category(entry),
        "content":        entry.get("content", ""),
        "importance":     entry.get("importance", 0.5),
        "source_session": meta.get("sourceSession"),
        "source_type":    meta.get("sourceType", "auto"),
        "access_count":   meta.get("access_count", 0),
        "created_at":     entry.get("created_at"),
        "last_accessed":  entry.get("updated_at"),
        "metadata":       meta,
        # New canonical field.
        "scope":          scope,
        # Legacy stringified projection, kept for older TS clients / UI.
        "scopePath":      entry.get("scope_path") or _scope_to_string(scope),
    }


def _extract_user_from_scope(scope: Optional[Dict[str, Any]]) -> Optional[str]:
    """Pull the ``user`` segment out of a scope dict."""
    if not scope or not isinstance(scope, dict):
        return None
    val = scope.get("user")
    return str(val) if val else None


def _resolve_scope_input(
    scope: Optional[Dict[str, Any]],
    scope_path: Optional[str],
) -> Dict[str, Any]:
    """Normalize either ``scope`` (dict) or ``scopePath`` (legacy string) to a dict.

    ``scope`` wins when both are provided.
    """
    if scope is not None:
        return _normalize_scope(scope)
    if scope_path:
        return _normalize_scope(scope_path)
    return {}


def _sort_results(
    rows: List[Dict[str, Any]], *, sort_by: str, order: str,
) -> List[Dict[str, Any]]:
    field_map = {
        "updated_at":  lambda r: r.get("updated_at") or r.get("created_at") or "",
        "created_at":  lambda r: r.get("created_at") or "",
        "importance":  lambda r: r.get("importance") or 0.0,
    }
    key = field_map.get(sort_by, field_map["updated_at"])
    return sorted(rows, key=key, reverse=(order == "desc"))


# ── Request models ───────────────────────────────────────────────────────

class MemoryEntryInput(BaseModel):
    category: str
    content: str
    importance: float = 0.7
    sourceSession: Optional[str] = None
    sourceType: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    # New canonical field. Either form is accepted; ``scope`` wins.
    scope: Optional[Dict[str, Any]] = None
    # Legacy slash-delimited form, e.g. ``"org:claw/user:abc"``.
    scopePath: Optional[str] = None


class InsertRequest(BaseModel):
    user_id: str
    entry: MemoryEntryInput


class ListRequest(BaseModel):
    user_id: str
    limit: int = Field(default=30, ge=1, le=500)
    offset: int = Field(default=0, ge=0)
    category: Optional[str] = None
    sort_by: str = "updated_at"
    order: str = "desc"
    include_profile: bool = False


class SearchRequest(BaseModel):
    user_id: str
    query: str
    top_k: int = Field(default=10, ge=1, le=100)
    threshold: float = Field(default=0.0, ge=0.0, le=1.0)


class DeleteAllRequest(BaseModel):
    user_id: str


class UpdateRequest(BaseModel):
    user_id: str
    content: Optional[str] = None
    category: Optional[str] = None
    importance: Optional[float] = None


class ProfileUpsertRequest(BaseModel):
    user_id: str
    content: str


# ── Cross-user discovery ─────────────────────────────────────────────────
# IMPORTANT: this scans the ``org:claw`` parent scope and groups by the
# ``user`` key parsed out of each row's scope. With JSONB containment a
# single ``@> {"org":"claw"}`` filter returns every row owned by the org.
_USER_SCAN_LIMIT = 2000


@router.get("/users")
async def list_users() -> List[Dict[str, Any]]:
    """List every user that has at least one memory under ``org:claw``."""
    try:
        resp = await _get_client().list(
            scope=_PARENT_SCOPE, limit=_USER_SCAN_LIMIT,
        )
        rows = resp.get("results", [])

        users: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            uid = _extract_user_from_scope(r.get("scope"))
            if not uid:
                continue
            slot = users.setdefault(uid, {
                "user_id":      uid,
                "memory_count": 0,
                "has_profile":  False,
                "last_active":  None,
            })
            if _is_user_profile(r):
                slot["has_profile"] = True
                continue  # don't count the profile row toward memory_count
            slot["memory_count"] += 1
            ts = r.get("updated_at") or r.get("created_at")
            if ts and (slot["last_active"] is None or ts > slot["last_active"]):
                slot["last_active"] = ts

        return sorted(
            users.values(),
            key=lambda u: u["last_active"] or "",
            reverse=True,
        )
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


# ── Per-user CRUD ────────────────────────────────────────────────────────

@router.post("/memories/list")
async def list_memories(req: ListRequest) -> List[Dict[str, Any]]:
    """List memories for a user, with optional filter + sort + pagination.

    Returns a flat array (backward-compatible with the V2 TS client).
    """
    if req.sort_by not in VALID_SORT_FIELDS:
        raise HTTPException(status_code=400, detail=f"sort_by must be one of {VALID_SORT_FIELDS}")
    if req.order not in VALID_ORDER:
        raise HTTPException(status_code=400, detail=f"order must be one of {VALID_ORDER}")
    if req.category and req.category != "all" and req.category not in VALID_XF_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"category must be one of {sorted(VALID_XF_CATEGORIES)} or 'all'",
        )

    try:
        scope = _default_scope(req.user_id)
        # Fetch a window large enough to cover offset+limit after filtering.
        fetch_n = max(req.offset + req.limit, 200)
        resp = await _get_client().list(scope=scope, limit=fetch_n)
        rows = resp.get("results", [])

        # Filter
        filtered: List[Dict[str, Any]] = []
        for r in rows:
            if not req.include_profile and _is_user_profile(r):
                continue
            if req.category and req.category != "all":
                if _resolve_legacy_category(r) != req.category:
                    continue
            filtered.append(r)

        # Sort + paginate
        filtered = _sort_results(filtered, sort_by=req.sort_by, order=req.order)
        page = filtered[req.offset:req.offset + req.limit]
        return [_wrap_entry(r) for r in page]
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


@router.post("/memories/insert")
async def insert_memory(req: InsertRequest) -> Dict[str, str]:
    try:
        if req.entry.category not in VALID_XF_CATEGORIES:
            raise HTTPException(
                status_code=400,
                detail=f"category must be one of {sorted(VALID_XF_CATEGORIES)}",
            )
        cat = req.entry.category

        meta = dict(req.entry.metadata or {})
        meta["claw_category"] = req.entry.category
        if req.entry.sourceSession:
            meta["sourceSession"] = req.entry.sourceSession
        if req.entry.sourceType:
            meta["sourceType"] = req.entry.sourceType

        # Build the final scope. Caller-supplied ``scope`` / ``scopePath``
        # is honoured but always merged with ``user:<id>`` so per-user
        # partitioning matches what the rest of the code expects.
        write_scope = _resolve_scope_input(req.entry.scope, req.entry.scopePath)
        if not write_scope:
            write_scope = dict(_PARENT_SCOPE)
        write_scope.setdefault("user", req.user_id)

        await _get_client().store(
            content=req.entry.content,
            category=cat,
            importance=req.entry.importance,
            metadata=meta,
            scope=write_scope,
            user_id=req.user_id,
        )
        return {"status": "ok"}
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


@router.post("/memories/search")
async def search_memories(req: SearchRequest) -> List[Dict[str, Any]]:
    """Search stored memories and return scored hits.

    The lightweight search hit shape omits ``metadata``, so we hydrate each
    hit by fetching the full row in parallel. ``top_k`` is bounded, so the
    extra round-trips are cheap and give us the correct ``claw_category`` /
    ``is_user_profile`` flags downstream.
    """
    try:
        scope = _default_scope(req.user_id)
        hits = await _get_client().search(
            query=req.query,
            scope=scope,
            inherit=True,
            top_k=req.top_k,
            threshold=req.threshold,
        )
        if not hits:
            return []

        full_rows = await asyncio.gather(
            *[_get_client().get(h.memory_id) for h in hits],
            return_exceptions=True,
        )

        out: List[Dict[str, Any]] = []
        for hit, row in zip(hits, full_rows):
            base: Dict[str, Any]
            if isinstance(row, dict):
                base = row
            else:
                # Hydration failed; fall back to the search-result shape.
                base = hit.model_dump()
            if _is_user_profile(base):
                continue
            wrapped = _wrap_entry(base)
            wrapped["score"] = hit.score
            out.append(wrapped)
        return out
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


@router.get("/memories/stats")
async def memory_stats(user_id: str = Query(...)) -> Dict[str, Any]:
    """Per-user aggregation: total/active/profile flag/by_category/24h ingestion."""
    try:
        scope = _default_scope(user_id)
        resp = await _get_client().list(scope=scope, limit=_USER_SCAN_LIMIT)
        rows = resp.get("results", [])

        by_category: Dict[str, int] = {k: 0 for k in VALID_XF_CATEGORIES if k != "user_profile"}
        total = 0
        active = 0
        has_profile = False
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        ingested_last_24h = 0

        for r in rows:
            if _is_user_profile(r):
                has_profile = True
                continue
            total += 1
            active += 1  # remote service has no soft-delete; treat all as active
            cat = _resolve_legacy_category(r)
            if cat in by_category:
                by_category[cat] += 1
            else:
                by_category[cat] = 1
            created = r.get("created_at") or ""
            if created and created >= cutoff:
                ingested_last_24h += 1

        return {
            "total":             total,
            "active":            active,
            "has_profile":       has_profile,
            "ingested_last_24h": ingested_last_24h,
            "by_category":       by_category,
        }
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


# ── Profile (specific path; declared BEFORE /memories/{entry_id}) ────────

@router.post("/memories/profile")
async def upsert_profile(req: ProfileUpsertRequest) -> Dict[str, str]:
    try:
        scope = _default_scope(req.user_id)
        resp = await _get_client().list(scope=scope, limit=50)
        existing = next(
            (r for r in resp.get("results", []) if _is_user_profile(r)),
            None,
        )

        if existing:
            await _get_client().update(
                existing["memory_id"],
                content=req.content,
                importance=1.0,
            )
        else:
            # JSONB containment makes the per-user write trivial: we just
            # store the canonical user-scoped dict directly.
            await _get_client().store(
                content=req.content,
                category="user_profile",
                importance=1.0,
                metadata={"is_user_profile": True, "claw_category": "user_profile"},
                scope=scope,
                user_id=req.user_id,
            )
        return {"status": "ok"}
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


@router.get("/memories/profile/{user_id}")
async def get_profile(user_id: str) -> Optional[Dict[str, Any]]:
    try:
        scope = _default_scope(user_id)
        resp = await _get_client().list(scope=scope, limit=50)
        existing = next(
            (r for r in resp.get("results", []) if _is_user_profile(r)),
            None,
        )
        return _wrap_entry(existing) if existing else None
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


# ── Single-memory routes (must come AFTER specific paths above) ──────────

@router.get("/memories/{entry_id}")
async def get_memory(entry_id: str) -> Dict[str, Any]:
    try:
        row = await _get_client().get(entry_id)
        if not row:
            raise HTTPException(status_code=404, detail=f"memory {entry_id} not found")
        return _wrap_entry(row)
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


@router.put("/memories/{entry_id}")
async def update_memory(entry_id: str, req: UpdateRequest) -> Dict[str, str]:
    try:
        updates: Dict[str, Any] = {}
        if req.content is not None:
            updates["content"] = req.content
        if req.importance is not None:
            updates["importance"] = req.importance

        if req.category is not None:
            if req.category not in VALID_XF_CATEGORIES:
                raise HTTPException(
                    status_code=400,
                    detail=f"category must be one of {sorted(VALID_XF_CATEGORIES)}",
                )
            updates["category"] = req.category

        if not updates:
            return {"status": "ok"}

        existing = await _get_client().get(entry_id)
        if not existing:
            raise HTTPException(status_code=404, detail=f"memory {entry_id} not found")

        if req.category is not None:
            meta = dict(existing.get("metadata") or {})
            meta["claw_category"] = req.category
            updates["metadata"] = meta

        await _get_client().update(entry_id, **updates)
        return {"status": "ok"}
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


@router.delete("/memories/{entry_id}")
async def delete_memory(entry_id: str, user_id: str = Query(...)) -> Dict[str, str]:
    try:
        ok = await _get_client().delete(entry_id)
        if not ok:
            raise HTTPException(status_code=404, detail="not found")
        return {"status": "ok"}
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)


@router.delete("/memories")
async def delete_all(req: DeleteAllRequest) -> Dict[str, Any]:
    try:
        scope = _default_scope(req.user_id)
        resp = await _get_client().list(scope=scope, limit=_USER_SCAN_LIMIT)
        results = resp.get("results", [])

        deleted = 0
        for r in results:
            if _is_user_profile(r):
                continue  # protect the profile from mass-delete
            if await _get_client().delete(r["memory_id"]):
                deleted += 1

        return {"status": "ok", "deleted": deleted}
    except MemoryStoreError as e:
        raise HTTPException(status_code=e.status, detail=e.body)
    except Exception as e:
        raise unexpected_error(e)
