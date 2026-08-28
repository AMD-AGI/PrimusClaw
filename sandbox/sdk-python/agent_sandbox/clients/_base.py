# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Shared HTTP helpers for agent_sandbox clients."""

from __future__ import annotations

import json
import os
from typing import Generator, Optional

import requests

from ..exceptions import SandboxError, SandboxNotFoundError, SandboxTimeoutError


def resolve_verify_ssl(verify_ssl: Optional[bool]) -> bool:
    """Resolve SSL verification from explicit arg or SANDBOX_VERIFY_SSL."""
    if verify_ssl is not None:
        return verify_ssl
    raw = os.getenv("SANDBOX_VERIFY_SSL", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def raise_api_error(resp: requests.Response) -> None:
    """Raise a typed SDK exception from an HTTP error response."""
    message = ""
    try:
        payload = resp.json()
        if isinstance(payload, dict):
            message = payload.get("error") or payload.get("message") or ""
        else:
            message = str(payload)
    except Exception:
        message = resp.text.strip()

    if not message:
        message = f"HTTP {resp.status_code}"

    if resp.status_code == 404:
        raise SandboxNotFoundError(message)
    if resp.status_code in {408, 504}:
        raise SandboxTimeoutError(message)
    raise SandboxError(message)


def iter_sse(resp: requests.Response) -> Generator[dict, None, None]:
    """Parse a standard text/event-stream response."""
    event = ""
    data_lines: list[str] = []

    def flush() -> Optional[dict]:
        nonlocal event, data_lines
        if not event and not data_lines:
            return None
        raw_data = "\n".join(data_lines).strip()
        parsed = raw_data
        if raw_data:
            try:
                parsed = json.loads(raw_data)
            except Exception:
                parsed = raw_data
        payload = {"event": event or "message", "data": parsed}
        event = ""
        data_lines = []
        return payload

    for line in resp.iter_lines(decode_unicode=True):
        if line is None:
            continue
        if line == "":
            item = flush()
            if item is not None:
                yield item
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event = line[len("event:"):].strip()
            continue
        if line.startswith("data:"):
            data_lines.append(line[len("data:"):].lstrip())

    item = flush()
    if item is not None:
        yield item


class BaseClient:
    """Small requests-based helper with auth, SSE and error mapping."""

    def __init__(
        self,
        base_url: Optional[str],
        *,
        api_key: Optional[str] = None,
        timeout: float = 120.0,
        verify_ssl: Optional[bool] = None,
    ) -> None:
        self.base_url = (base_url or os.getenv("SANDBOX_API_URL", "")).rstrip("/")
        if not self.base_url:
            raise SandboxError("api_url is required")
        self.api_key = api_key or os.getenv("SANDBOX_API_KEY")
        self.timeout = timeout
        self.verify_ssl = resolve_verify_ssl(verify_ssl)
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "agent-sandbox-sdk/0.1.0"})

    def _headers(self, headers: Optional[dict] = None) -> dict:
        merged = {}
        if self.api_key:
            merged["Authorization"] = f"Bearer {self.api_key}"
        if headers:
            merged.update(headers)
        return merged

    def _request(
        self,
        method: str,
        path: str,
        *,
        stream: bool = False,
        headers: Optional[dict] = None,
        **kwargs,
    ) -> requests.Response:
        url = path if path.startswith("http://") or path.startswith("https://") else self.base_url + path
        try:
            resp = self.session.request(
                method,
                url,
                headers=self._headers(headers),
                timeout=kwargs.pop("timeout", self.timeout),
                verify=self.verify_ssl,
                stream=stream,
                **kwargs,
            )
        except requests.Timeout as exc:
            raise SandboxTimeoutError(str(exc)) from exc
        except requests.RequestException as exc:
            raise SandboxError(str(exc)) from exc
        if resp.status_code >= 400:
            raise_api_error(resp)
        return resp

    def _request_json(self, method: str, path: str, **kwargs):
        resp = self._request(method, path, **kwargs)
        if not resp.content:
            return {}
        return resp.json()
