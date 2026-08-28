# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Data-plane client for EnvD execution, files, sessions and service access."""

from __future__ import annotations

import base64
import os
import uuid
from urllib.parse import quote, urlparse, urlunparse

from ._base import BaseClient, iter_sse


class DataPlaneClient(BaseClient):
    """HTTP client for sandbox invocation routes proxied through the Router."""

    def __init__(
        self,
        *,
        router_url: str,
        session_id: str,
        sandbox_name: str,
        namespace: str = "default",
        api_key=None,
        timeout: float = 120.0,
        verify_ssl=None,
    ) -> None:
        super().__init__(router_url, api_key=api_key, timeout=timeout, verify_ssl=verify_ssl)
        self.session_id = session_id
        self.sandbox_name = sandbox_name
        self.namespace = namespace

    def _headers(self, headers=None):
        merged = super()._headers(headers)
        merged["x-session-id"] = self.session_id
        return merged

    def _invocation_path(self, path: str) -> str:
        clean = path if path.startswith("/") else f"/{path}"
        return (
            f"/v1/namespaces/{quote(self.namespace, safe='')}"
            f"/code-interpreters/{quote(self.sandbox_name, safe='')}/invocations{clean}"
        )

    @staticmethod
    def _normalize_workspace_path(path: str) -> str:
        return path.lstrip("/") if path else path

    def execute(self, command, *, timeout: str = "60s", working_dir: str = "", env=None) -> dict:
        payload = {
            "command": command,
            "timeout": timeout,
            "working_dir": working_dir,
            "env": env or {},
        }
        return self._request_json("POST", self._invocation_path("/api/execute"), json=payload)

    def execute_stream(self, command, *, timeout: str = "300s", working_dir: str = "", env=None):
        payload = {
            "command": command,
            "timeout": timeout,
            "working_dir": working_dir,
            "env": env or {},
        }
        resp = self._request("POST", self._invocation_path("/api/execute/stream"), json=payload, stream=True)
        try:
            for item in iter_sse(resp):
                data = item.get("data")
                if isinstance(data, dict):
                    flattened = {"event": item.get("event", "")}
                    flattened.update(data)
                    yield flattened
                else:
                    yield item
        finally:
            resp.close()

    def run_code(self, language: str, code: str, *, timeout: str = "60s") -> dict:
        suffix_map = {
            "python": ".py",
            "python3": ".py",
            "bash": ".sh",
            "sh": ".sh",
            "node": ".js",
        }
        interpreter_map = {
            "python": "python",
            "python3": "python3",
            "bash": "bash",
            "sh": "sh",
            "node": "node",
        }
        suffix = suffix_map.get(language, ".txt")
        interpreter = interpreter_map.get(language, language)
        remote_path = f".agent-sandbox-run-{uuid.uuid4().hex}{suffix}"
        self.file_write(remote_path, code.encode("utf-8"), mode="0644")
        try:
            return self.execute([interpreter, remote_path], timeout=timeout)
        finally:
            try:
                self.file_delete(remote_path)
            except Exception:
                pass

    def session_create(self) -> str:
        resp = self._request_json("POST", self._invocation_path("/api/session/create"))
        return resp.get("terminal_id", "")

    def session_exec(self, terminal_id: str, command: str, *, timeout: str = "30s", working_dir: str = "") -> dict:
        return self._request_json(
            "POST",
            self._invocation_path(f"/api/session/{quote(terminal_id, safe='')}/exec"),
            json={"command": command, "timeout": timeout, "working_dir": working_dir},
        )

    def session_output(self, terminal_id: str) -> str:
        resp = self._request_json("GET", self._invocation_path(f"/api/session/{quote(terminal_id, safe='')}/output"))
        return resp.get("output", "")

    def session_delete(self, terminal_id: str) -> None:
        self._request("DELETE", self._invocation_path(f"/api/session/{quote(terminal_id, safe='')}"))

    def send_keys(self, terminal_id: str, keys: list[str]) -> None:
        self._request(
            "POST",
            self._invocation_path(f"/api/terminal/{quote(terminal_id, safe='')}/send_keys"),
            json={"keys": keys},
        )

    def screen(self, terminal_id: str) -> dict:
        return self._request_json("GET", self._invocation_path(f"/api/terminal/{quote(terminal_id, safe='')}/screen"))

    def file_write(self, remote_path: str, data: bytes, *, mode: str = "0644") -> None:
        remote_path = self._normalize_workspace_path(remote_path)
        self._request(
            "POST",
            self._invocation_path("/api/files"),
            json={
                "path": remote_path,
                "content": base64.b64encode(data).decode("ascii"),
                "mode": mode,
            },
        )

    def file_upload(self, local_path: str, remote_path: str) -> None:
        remote_path = self._normalize_workspace_path(remote_path)
        with open(local_path, "rb") as file_obj:
            self._request(
                "POST",
                self._invocation_path("/api/files"),
                data={"path": remote_path},
                files={"file": (os.path.basename(local_path), file_obj)},
            )

    def file_download(self, remote_path: str, local_path: str) -> None:
        rel_path = quote(self._normalize_workspace_path(remote_path), safe="/")
        resp = self._request("GET", self._invocation_path(f"/api/files/{rel_path}"), stream=True)
        try:
            with open(local_path, "wb") as file_obj:
                for chunk in resp.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        file_obj.write(chunk)
        finally:
            resp.close()

    def file_list(self, path: str = ".") -> list[dict]:
        resp = self._request_json(
            "GET",
            self._invocation_path("/api/files"),
            params={"path": self._normalize_workspace_path(path)},
        )
        return resp.get("files", [])

    def file_delete(self, remote_path: str) -> None:
        rel_path = quote(self._normalize_workspace_path(remote_path), safe="/")
        self._request("DELETE", self._invocation_path(f"/api/files/{rel_path}"))

    def gpu_status(self) -> dict:
        return self._request_json("GET", self._invocation_path("/api/gpu/status"))

    def proxy_url(self, port: int) -> str:
        return self.base_url + self._invocation_path(f"/proxy/{port}")

    def proxy_request(self, port: int, path: str = "/", method: str = "GET", raise_for_status: bool = True, **kwargs):
        path = path if path.startswith("/") else f"/{path}"
        url = self.base_url + self._invocation_path(f"/proxy/{port}{path}")
        resp = self.session.request(
            method,
            url,
            headers=self._headers(kwargs.pop("headers", None)),
            timeout=kwargs.pop("timeout", self.timeout),
            verify=self.verify_ssl,
            **kwargs,
        )
        if raise_for_status and resp.status_code >= 400:
            from ._base import raise_api_error

            raise_api_error(resp)
        return resp

    def tunnel_url(self, remote_port: int) -> str:
        parsed = urlparse(self.base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunparse(
            (
                scheme,
                parsed.netloc,
                self._invocation_path(f"/tunnel/{remote_port}"),
                "",
                "",
                "",
            )
        )
