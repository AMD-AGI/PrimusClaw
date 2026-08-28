# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""HTTP handlers for the KB extension (`/api/kb/*`).

Adds 10 endpoints on top of the legacy ``/api/memories/*`` surface:

    POST /api/kb/insert         POST /api/kb/list           GET    /api/kb/{id}
    POST /api/kb/upsert         POST /api/kb/search         DELETE /api/kb/{id}
    POST /api/kb/batch_insert   POST /api/kb/activate
    POST /api/kb/touch/{id}     POST /api/kb/edges/add

All routes are gated by the ``KB_ENDPOINTS_ENABLED`` flag (see
``config.py``); when disabled the router is not mounted at all and
clients receive ``404 Not Found``. KB rows are distinguished from
legacy memory rows by ``kind IS NOT NULL`` and never appear in the
legacy endpoints.

See ``docs/claw-memory-service-kb-extension-design.md`` for the
contract and the activation algorithm.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from claw_memory.storage.activation import ActivationContext, activate
from claw_memory.storage.handlers import _get_client
from claw_memory.storage.postgres_store import (
    KB_VALID_KINDS,
    MemoryStoreError,
    _scope_to_string,
)

log = logging.getLogger(__name__)

router = APIRouter()


# ── Response wrapper ─────────────────────────────────────────────────────

def _wrap_kb_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Project a stored KB row to the canonical response shape (§3.3 of
    the design doc).

    Keeps both the new ``scope`` (dict) and the legacy ``scopePath``
    (string) projections so any older client that still reads the
    string form keeps working.
    """
    meta = entry.get("metadata") or {}
    scope = entry.get("scope") or {}
    return {
        "id":             str(entry.get("memory_id") or entry.get("id") or ""),
        "kind":           entry.get("kind"),
        "slug":           entry.get("slug"),
        "content":        entry.get("content", ""),
        "importance":     entry.get("importance", 0.5),
        "access_count":   int(entry.get("access_count") or 0),
        "last_accessed":  entry.get("last_accessed"),
        "success_rate":   entry.get("success_rate"),
        "scope":          scope,
        "scopePath":      entry.get("scope_path") or _scope_to_string(scope),
        "edges":          entry.get("edges") or {},
        "metadata":       meta,
        "source_session": meta.get("source_session"),
        "source_type":    meta.get("source_type"),
        "created_at":     entry.get("created_at"),
        "updated_at":     entry.get("updated_at"),
    }


def _validate_kind(kind: str) -> None:
    if kind not in KB_VALID_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"kind must be one of {sorted(KB_VALID_KINDS)}",
        )


def _validate_scope(scope: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not scope or not isinstance(scope, dict):
        raise HTTPException(status_code=400, detail="scope dict is required")
    return scope


def _store_error(e: MemoryStoreError) -> HTTPException:
    return HTTPException(status_code=e.status, detail=e.body)


# ── Pydantic request models ──────────────────────────────────────────────

class KBInsertRequest(BaseModel):
    scope: Dict[str, Any]
    kind: str
    slug: str
    content: Optional[str] = None
    importance: Optional[float] = Field(default=0.5, ge=0.0, le=1.0)
    metadata: Optional[Dict[str, Any]] = None
    edges: Optional[Dict[str, Any]] = None
    source_session: Optional[str] = None
    source_type: Optional[str] = None


class KBBatchRequest(BaseModel):
    entries: List[KBInsertRequest]
    on_conflict: Literal["error", "skip", "upsert"] = "upsert"


class KBListRequest(BaseModel):
    scope_filter: Optional[Dict[str, Any]] = None
    kind: Optional[Any] = None
    metadata_filter: Optional[Dict[str, Any]] = None
    importance_min: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    limit: int = Field(default=100, ge=1, le=500)
    offset: int = Field(default=0, ge=0)
    sort_by: Literal["importance", "updated_at", "access_count"] = "importance"
    order: Literal["desc", "asc"] = "desc"


class KBSearchRequest(BaseModel):
    query: str
    scope_filter: Optional[Dict[str, Any]] = None
    kind: Optional[Any] = None
    top_k: int = Field(default=20, ge=1, le=100)
    threshold: float = Field(default=0.1, ge=0.0, le=1.0)


class KBActivateRequest(BaseModel):
    activation_context: Dict[str, Any]
    budget_tokens: int = Field(default=6000, ge=1, le=200_000)
    max_articles: int = Field(default=30, ge=1, le=500)
    min_weight: float = Field(default=0.10, ge=0.0, le=1.0)
    kinds: Optional[List[str]] = None
    include_debug: bool = False
    candidate_cap: int = Field(default=200, ge=1, le=2000)


class KBEdgesAddRequest(BaseModel):
    id: str
    edges_to_add: Dict[str, Any]


class KBDeleteRequest(BaseModel):
    id: str


class KBTouchRequest(BaseModel):
    id: str
    success: Optional[bool] = None


# ── Helpers (moved out for testability) ──────────────────────────────────

async def _do_insert(req: KBInsertRequest) -> Dict[str, Any]:
    _validate_kind(req.kind)
    scope = _validate_scope(req.scope)
    return await _get_client().kb_insert(
        scope=scope,
        kind=req.kind,
        slug=req.slug,
        content=req.content or "",
        importance=0.5 if req.importance is None else req.importance,
        metadata=req.metadata,
        edges=req.edges,
        source_session=req.source_session,
        source_type=req.source_type,
    )


async def _do_upsert(req: KBInsertRequest):
    _validate_kind(req.kind)
    scope = _validate_scope(req.scope)
    return await _get_client().kb_upsert(
        scope=scope,
        kind=req.kind,
        slug=req.slug,
        content=req.content,
        importance=req.importance,
        metadata=req.metadata,
        edges=req.edges,
        source_session=req.source_session,
        source_type=req.source_type,
    )


def _upsert_response(entry: Dict[str, Any], action: str) -> Dict[str, Any]:
    wrapped = _wrap_kb_entry(entry)
    return {
        "status": "ok",
        "id": wrapped["id"],
        "action": action,
        "created": action == "inserted",
        "scope": wrapped["scope"],
        "kind": wrapped["kind"],
        "slug": wrapped["slug"],
        "importance": wrapped["importance"],
        "updated_at": wrapped["updated_at"],
    }


def _set_warnings(response: Response, warnings: List[str]) -> None:
    if warnings:
        response.headers["X-KB-Warning"] = ", ".join(dict.fromkeys(warnings))


# ── Routes ───────────────────────────────────────────────────────────────

@router.post("/kb/insert")
async def kb_insert(req: KBInsertRequest) -> Dict[str, Any]:
    try:
        entry = await _do_insert(req)
        return {"status": "ok", "id": entry.get("memory_id")}
    except MemoryStoreError as e:
        raise _store_error(e)


@router.post("/kb/upsert")
async def kb_upsert(req: KBInsertRequest, response: Response) -> Dict[str, Any]:
    try:
        existing = await _get_client().kb_list(
            scope_filter=req.scope,
            kind=req.kind,
            metadata_filter=None,
            limit=1,
            offset=0,
        )
        existing_rows = [
            row for row in existing.get("entries", [])
            if row.get("scope") == req.scope and row.get("slug") == req.slug
        ]
        old_importance = (
            float(existing_rows[0].get("importance", 0.0))
            if existing_rows and req.importance is not None
            else None
        )
        entry, action = await _do_upsert(req)
        if old_importance is not None and req.importance is not None and req.importance < old_importance:
            _set_warnings(response, ["importance_protected"])
        return _upsert_response(entry, action)
    except MemoryStoreError as e:
        raise _store_error(e)


@router.post("/kb/batch_insert")
async def kb_batch_insert(req: KBBatchRequest) -> Dict[str, Any]:
    if not req.entries:
        return {
            "status": "ok",
            "inserted": 0,
            "updated": 0,
            "skipped": 0,
            "errors": [],
            "results": [],
            "summary": {"ok": 0, "error": 0, "total": 0, "skipped": 0},
        }
    if len(req.entries) > 200:
        raise HTTPException(
            status_code=400,
            detail=f"batch_insert accepts at most 200 entries (got {len(req.entries)})",
        )

    inserted = 0
    updated = 0
    skipped = 0
    errors: List[Dict[str, Any]] = []
    results: List[Dict[str, Any]] = []

    for idx, entry_req in enumerate(req.entries):
        try:
            if req.on_conflict == "upsert":
                entry, action = await _do_upsert(entry_req)
                if action == "inserted":
                    inserted += 1
                else:
                    updated += 1
                results.append({
                    "index": idx,
                    "id": entry.get("memory_id"),
                    "created": action == "inserted",
                    "status": "ok",
                })
                continue

            try:
                entry = await _do_insert(entry_req)
                inserted += 1
                results.append({
                    "index": idx,
                    "id": entry.get("memory_id"),
                    "created": True,
                    "status": "ok",
                })
            except MemoryStoreError as e:
                if e.status == 409 and req.on_conflict == "skip":
                    skipped += 1
                    results.append({
                        "index": idx,
                        "id": None,
                        "created": False,
                        "status": "skipped",
                    })
                    continue
                raise
        except HTTPException as e:
            errors.append({"index": idx, "error": str(e.detail)})
            results.append({
                "index": idx,
                "id": None,
                "created": False,
                "status": "error",
                "error": {"code": "invalid_entry", "message": str(e.detail)},
            })
        except MemoryStoreError as e:
            errors.append({"index": idx, "error": str(e.body)})
            results.append({
                "index": idx,
                "id": None,
                "created": False,
                "status": "error",
                "error": {"code": e.status, "message": str(e.body)},
            })
        # This entry point reports per-entry outcomes in the body rather than
        # raising, so the rule unexpected_error applies is applied by hand: an
        # unforeseen message is written by whichever library raised it, and is
        # logged rather than returned.
        except Exception as e:
            log.exception("kb_insert entry %d failed unexpectedly: %s", idx, type(e).__name__)
            errors.append({"index": idx, "error": "internal error"})
            results.append({
                "index": idx,
                "id": None,
                "created": False,
                "status": "error",
                "error": {"code": "unexpected", "message": "internal error"},
            })

    error_count = len(errors)
    return {
        "status":   "ok",
        "inserted": inserted,
        "updated":  updated,
        "skipped":  skipped,
        "errors":   errors,
        "results":  results,
        "summary": {
            "ok": inserted + updated,
            "error": error_count,
            "total": len(req.entries),
            "skipped": skipped,
        },
    }


@router.post("/kb/list")
async def kb_list(req: KBListRequest) -> Dict[str, Any]:
    try:
        resp = await _get_client().kb_list(
            scope_filter=req.scope_filter,
            kind=req.kind,
            metadata_filter=req.metadata_filter,
            importance_min=req.importance_min,
            sort_by=req.sort_by,
            order=req.order,
            limit=req.limit,
            offset=req.offset,
        )
        entries = [_wrap_kb_entry(r) for r in resp.get("entries", [])]
        # ``total_estimated`` is the page size; an exact count would
        # require an additional query and the design notes call this
        # field "estimated".
        return {
            "entries": entries,
            "total_estimated": len(entries),
            "total": req.offset + len(entries),
            "has_more": len(entries) == req.limit,
        }
    except MemoryStoreError as e:
        raise _store_error(e)


@router.post("/kb/search")
async def kb_search(req: KBSearchRequest) -> Dict[str, Any]:
    try:
        hits = await _get_client().kb_search(
            query=req.query,
            scope_filter=req.scope_filter,
            kind=req.kind,
            top_k=req.top_k,
            threshold=req.threshold,
        )
        return {
            "results": [
                {"entry": _wrap_kb_entry(row), "score": float(score)}
                for row, score in hits
            ]
        }
    except MemoryStoreError as e:
        raise _store_error(e)


@router.post("/kb/activate")
async def kb_activate(req: KBActivateRequest) -> Dict[str, Any]:
    try:
        ac = ActivationContext.from_dict(req.activation_context)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if req.kinds:
        bad = [k for k in req.kinds if k not in KB_VALID_KINDS]
        if bad:
            raise HTTPException(
                status_code=400,
                detail=f"invalid kinds: {bad}; allowed {sorted(KB_VALID_KINDS)}",
            )
    try:
        return await activate(
            _get_client(),
            ac,
            budget_tokens=req.budget_tokens,
            max_articles=req.max_articles,
            min_weight=req.min_weight,
            kinds=req.kinds,
            include_debug=req.include_debug,
            candidate_cap=req.candidate_cap,
        )
    except MemoryStoreError as e:
        raise _store_error(e)


@router.post("/kb/touch/{entry_id}")
async def kb_touch(entry_id: str, req: Optional[KBTouchRequest] = None) -> Dict[str, Any]:
    try:
        row = await _get_client().kb_touch(
            entry_id,
            success=req.success if req else None,
        )
        if row is None:
            raise HTTPException(status_code=404, detail=f"kb entry {entry_id} not found")
        wrapped = _wrap_kb_entry(row)
        return {
            "status": "ok",
            "access_count": wrapped["access_count"],
            "entry": wrapped,
        }
    except MemoryStoreError as e:
        raise _store_error(e)


@router.post("/kb/touch")
async def kb_touch_body(req: KBTouchRequest) -> Dict[str, Any]:
    return await kb_touch(req.id, req)


@router.post("/kb/edges/add")
async def kb_edges_add(req: KBEdgesAddRequest) -> Dict[str, Any]:
    if not req.edges_to_add:
        raise HTTPException(status_code=400, detail="edges_to_add is required")
    try:
        merged = await _get_client().kb_add_edges(req.id, req.edges_to_add)
        if merged is None:
            raise HTTPException(status_code=404, detail=f"kb entry {req.id} not found")
        mirrored_to: List[str] = []
        mirror_skipped: List[Dict[str, str]] = []
        for target_id in req.edges_to_add.get("contradicts") or []:
            if target_id == req.id:
                continue
            target = await _get_client().kb_get(str(target_id))
            if not target:
                mirror_skipped.append({"id": str(target_id), "reason": "not_found"})
                continue
            target_edges = await _get_client().kb_add_edges(
                str(target_id),
                {"contradicts": [req.id]},
            )
            if target_edges is None:
                mirror_skipped.append({"id": str(target_id), "reason": "not_found"})
                continue
            mirrored_to.append(str(target_id))
        return {
            "status": "ok",
            "id": req.id,
            "edges": merged,
            "mirrored_to": mirrored_to,
            "mirror_skipped": mirror_skipped,
        }
    except MemoryStoreError as e:
        raise _store_error(e)


@router.get("/kb/get/{entry_id}")
async def kb_get_compat(entry_id: str) -> Dict[str, Any]:
    try:
        row = await _get_client().kb_get(entry_id)
        if not row:
            raise HTTPException(status_code=404, detail=f"kb entry {entry_id} not found")
        return _wrap_kb_entry(row)
    except MemoryStoreError as e:
        raise _store_error(e)


@router.get("/kb/{entry_id}")
async def kb_get(entry_id: str) -> Dict[str, Any]:
    try:
        row = await _get_client().kb_get(entry_id)
        if not row:
            raise HTTPException(status_code=404, detail=f"kb entry {entry_id} not found")
        return {"entry": _wrap_kb_entry(row)}
    except MemoryStoreError as e:
        raise _store_error(e)


@router.post("/kb/delete")
async def kb_delete_body(req: KBDeleteRequest) -> Dict[str, Any]:
    try:
        ok = await _get_client().kb_delete(req.id)
        return {"id": req.id, "deleted": ok}
    except MemoryStoreError as e:
        raise _store_error(e)


@router.delete("/kb/{entry_id}")
async def kb_delete(entry_id: str) -> Dict[str, str]:
    try:
        ok = await _get_client().kb_delete(entry_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"kb entry {entry_id} not found")
        return {"status": "ok"}
    except MemoryStoreError as e:
        raise _store_error(e)
