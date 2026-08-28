# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Test-only in-memory KB client with the same async surface as KBClient."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List


class InMemoryKBClient:
    def __init__(self) -> None:
        self._rows: Dict[str, Dict[str, Any]] = {}
        self._seq = 0

    async def upsert(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        key = (
            tuple(sorted((payload.get("scope") or {}).items())),
            payload["kind"],
            payload["slug"],
        )
        for row in self._rows.values():
            if row["_key"] == key:
                row["content"] = payload.get("content", row["content"])
                row["importance"] = max(row["importance"], payload.get("importance", 0.5))
                row["metadata"].update(payload.get("metadata") or {})
                row["updated_at"] = _now()
                return _upsert_response(row, created=False)

        self._seq += 1
        article_id = f"kb_mem_{self._seq:04d}"
        row = {
            "_key": key,
            "id": article_id,
            "scope": dict(payload.get("scope") or {}),
            "kind": payload["kind"],
            "slug": payload["slug"],
            "content": payload.get("content") or "",
            "importance": payload.get("importance", 0.5),
            "metadata": dict(payload.get("metadata") or {}),
            "created_at": _now(),
            "updated_at": _now(),
            "deleted_at": None,
        }
        self._rows[article_id] = row
        return _upsert_response(row, created=True)

    async def list(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        scope_filter = payload.get("scope_filter") or {}
        rows: List[Dict[str, Any]] = []
        for row in self._rows.values():
            if row.get("deleted_at") and not payload.get("include_deleted"):
                continue
            if payload.get("kind") and row["kind"] != payload["kind"]:
                continue
            if any(row["scope"].get(k) != v for k, v in scope_filter.items()):
                continue
            rows.append(row)
        return {
            "entries": [_article_response(r) for r in rows],
            "total": len(rows),
            "has_more": False,
        }


def _upsert_response(row: Dict[str, Any], *, created: bool) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "scope": row["scope"],
        "kind": row["kind"],
        "slug": row["slug"],
        "created": created,
        "importance": row["importance"],
        "updated_at": row["updated_at"],
    }


def _article_response(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "scope": row["scope"],
        "kind": row["kind"],
        "slug": row["slug"],
        "content": row["content"],
        "importance": row["importance"],
        "metadata": row["metadata"],
        "edges": {"contradicts": [], "backlinks": [], "superseded_by": None},
        "access_count": 0,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "deleted_at": row["deleted_at"],
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
