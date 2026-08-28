# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Async HTTP client for the KB endpoints hosted by claw-memory-service."""

from __future__ import annotations

from typing import Any, Dict, Optional

import httpx


class KBClientError(RuntimeError):
    """Raised when claw-memory-service returns a non-2xx KB response."""

    def __init__(
        self,
        message: str,
        *,
        code: int = 0,
        error_id: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.error_id = error_id
        self.details = details or {}


class KBClient:
    """Thin async wrapper over ``/api/kb/*``."""

    def __init__(self, base_url: str, *, timeout: float = 10.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self) -> "KBClient":
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout)
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    def _ensure(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout)
        return self._client

    async def upsert(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return await self._post("/api/kb/upsert", payload)

    async def batch_insert(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return await self._post("/api/kb/batch_insert", payload)

    async def add_edges(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return await self._post("/api/kb/edges/add", payload)

    async def list(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return await self._post("/api/kb/list", payload)

    async def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            resp = await self._ensure().post(path, json=payload)
        except httpx.HTTPError as exc:
            raise KBClientError(f"transport error: {exc}", code=0) from exc

        if resp.status_code >= 400:
            try:
                body = resp.json() if resp.content else {}
            except ValueError:
                body = {"detail": resp.text}
            detail = body.get("detail") or body.get("error") or body
            raise KBClientError(
                str(detail),
                code=resp.status_code,
                error_id=body.get("error") if isinstance(body, dict) else None,
                details=body if isinstance(body, dict) else {},
            )
        return resp.json()
