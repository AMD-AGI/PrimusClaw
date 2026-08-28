# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Control-plane client for sandbox lifecycle, policy and template APIs."""

from __future__ import annotations

from typing import Generator, Optional
from urllib.parse import quote

from ._base import BaseClient, iter_sse


class ControlPlaneClient(BaseClient):
    """HTTP client for the unified control-plane API exposed by the Router."""

    def __init__(
        self,
        workload_manager_url: Optional[str] = None,
        *,
        api_key: Optional[str] = None,
        timeout: float = 120.0,
        verify_ssl: Optional[bool] = None,
    ) -> None:
        super().__init__(
            workload_manager_url,
            api_key=api_key,
            timeout=timeout,
            verify_ssl=verify_ssl,
        )

    def health(self) -> dict:
        return self._request_json("GET", "/health")

    def create_sandbox(self, name: str, *, namespace: str = "default", overrides: Optional[dict] = None) -> dict:
        payload = {"name": name, "namespace": namespace}
        if overrides:
            payload["overrides"] = overrides
        return self._request_json("POST", "/v1/code-interpreter", json=payload)

    def create_sandbox_stream(
        self,
        name: str,
        *,
        namespace: str = "default",
        overrides: Optional[dict] = None,
    ) -> Generator[dict, None, None]:
        payload = {"name": name, "namespace": namespace}
        if overrides:
            payload["overrides"] = overrides
        resp = self._request("POST", "/v1/code-interpreter/stream", json=payload, stream=True)
        try:
            yield from iter_sse(resp)
        finally:
            resp.close()

    def list_sandboxes(self, **params) -> dict:
        return self._request_json("GET", "/v1/code-interpreter/sessions", params=params)

    def get_sandbox(self, session_id: str) -> dict:
        return self._request_json("GET", f"/v1/code-interpreter/sessions/{quote(session_id, safe='')}")

    def delete_sandbox(self, session_id: str) -> bool:
        self._request("DELETE", f"/v1/code-interpreter/sessions/{quote(session_id, safe='')}")
        return True

    def get_policy(self, session_id: str) -> dict:
        return self._request_json("GET", f"/v1/sandbox/sessions/{quote(session_id, safe='')}/policy")

    def update_policy(
        self,
        session_id: str,
        *,
        allowed_egress_hosts: Optional[list[str]] = None,
        allowed_internal_hosts: Optional[list[str]] = None,
        policy_mode: Optional[str] = None,
    ) -> dict:
        payload = {}
        if allowed_egress_hosts is not None:
            payload["allowedEgressHosts"] = allowed_egress_hosts
        if allowed_internal_hosts is not None:
            payload["allowedInternalHosts"] = allowed_internal_hosts
        if policy_mode is not None:
            payload["policyMode"] = policy_mode
        return self._request_json(
            "PATCH",
            f"/v1/sandbox/sessions/{quote(session_id, safe='')}/policy",
            json=payload,
        )

    def get_logs(
        self,
        session_id: str,
        *,
        source: Optional[str] = None,
        event_type: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict:
        params = {"limit": limit, "offset": offset}
        if source:
            params["source"] = source
        if event_type:
            params["eventType"] = event_type
        return self._request_json(
            "GET",
            f"/v1/sandbox/sessions/{quote(session_id, safe='')}/logs",
            params=params,
        )

    def list_templates(self, **params) -> dict:
        return self._request_json("GET", "/v1/templates", params=params)

    def get_template(self, name: str, *, namespace: str = "default") -> dict:
        return self._request_json("GET", f"/v1/templates/{quote(namespace, safe='')}/{quote(name, safe='')}")

    def create_template(
        self,
        name: str,
        spec: dict,
        *,
        namespace: str = "default",
        public: bool = False,
        dockerfile: Optional[str] = None,
    ) -> dict:
        payload = {"name": name, "namespace": namespace, "spec": spec, "public": public}
        if dockerfile is not None:
            payload["dockerfile"] = dockerfile
        return self._request_json("POST", "/v1/templates", json=payload)

    def create_template_stream(
        self,
        name: str,
        spec: dict,
        *,
        namespace: str = "default",
        public: bool = False,
        dockerfile: Optional[str] = None,
    ) -> Generator[dict, None, None]:
        payload = {"name": name, "namespace": namespace, "spec": spec, "public": public}
        if dockerfile is not None:
            payload["dockerfile"] = dockerfile
        resp = self._request("POST", "/v1/templates/stream", json=payload, stream=True)
        try:
            yield from iter_sse(resp)
        finally:
            resp.close()

    def update_template(
        self,
        name: str,
        spec: dict,
        *,
        namespace: str = "default",
        public: Optional[bool] = None,
    ) -> dict:
        payload = {"spec": spec}
        if public is not None:
            payload["public"] = public
        return self._request_json(
            "PUT",
            f"/v1/templates/{quote(namespace, safe='')}/{quote(name, safe='')}",
            json=payload,
        )

    def delete_template(self, name: str, *, namespace: str = "default") -> bool:
        self._request("DELETE", f"/v1/templates/{quote(namespace, safe='')}/{quote(name, safe='')}")
        return True
