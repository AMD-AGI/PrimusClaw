# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Mapping
from typing import Any


def _field(value: object, name: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _response_fields(response: object) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for name, expected_type in (("id", str), ("model", str), ("created_at", int)):
        value = _field(response, name)
        if type(value) is expected_type and value != "":
            fields[name] = value
    return fields


def preserve_upstream_error(exception: Exception, error: object, event: object = None) -> None:
    fields = {
        name: value
        for name in ("message", "code", "type", "param")
        if isinstance(value := _field(error, name), (str, int))
        and not isinstance(value, bool)
    }
    fields["_response_fields"] = _response_fields(_field(event, "response"))
    sequence_number = _field(event, "sequence_number")
    if type(sequence_number) is int and sequence_number >= 0:
        fields["_sequence_number"] = sequence_number
    setattr(exception, "_responses_stream_error", fields)


def _upstream_error(exception: Exception) -> dict[str, Any]:
    seen: set[int] = set()
    current: object = exception
    while isinstance(current, Exception) and id(current) not in seen:
        seen.add(id(current))
        error = getattr(current, "_responses_stream_error", None)
        if isinstance(error, dict) and error:
            return error
        current = getattr(current, "original_exception", None)
    return {}


def _error_code(exception: Exception, upstream: Mapping[str, Any]) -> str:
    code = upstream.get("code")
    error_type = upstream.get("type")
    for value in (code, error_type):
        if isinstance(value, (str, int)):
            normalized = str(value).lower()
            if normalized == "insufficient_quota":
                return "insufficient_quota"
            if normalized in ("429", "toomanyrequests", "too_many_requests") or normalized.startswith("rate_limit"):
                return "rate_limit_exceeded"
    if isinstance(code, str) and code and not code.isdecimal():
        return code
    status = getattr(exception, "status_code", None)
    if str(status) == "429":
        return "rate_limit_exceeded"
    return {
        "400": "invalid_request_error",
        "401": "authentication_error",
        "403": "permission_denied",
        "404": "not_found_error",
        "408": "request_timeout",
        "422": "invalid_request_error",
    }.get(str(status), "server_error")


class ResponsesStreamErrorState:
    def __init__(self) -> None:
        self.response_fields: dict[str, Any] = {}
        self.sequence_number = -1
        self.terminal_seen = False
        self._pending_terminal = False

    def observe_chunk(self, chunk: object, *, emitted: bool = True) -> None:
        sequence_number = _field(chunk, "sequence_number")
        if type(sequence_number) is int and sequence_number >= 0:
            self.sequence_number = max(self.sequence_number, sequence_number)
        self.response_fields.update(_response_fields(_field(chunk, "response")))
        response_id = _field(chunk, "response_id")
        if not self.response_fields.get("id") and isinstance(response_id, str) and response_id:
            self.response_fields["id"] = response_id
        self._pending_terminal = _field(chunk, "type") in ("response.completed", "response.failed", "response.incomplete")
        if emitted:
            self.mark_emitted()

    def mark_emitted(self) -> None:
        self.terminal_seen = self.terminal_seen or self._pending_terminal
        self._pending_terminal = False

    def format_failure(self, exception: Exception) -> str | None:
        if self.terminal_seen:
            return None
        upstream = _upstream_error(exception)
        for name, value in upstream.get("_response_fields", {}).items():
            self.response_fields.setdefault(name, value)
        upstream_sequence = upstream.get("_sequence_number")
        if type(upstream_sequence) is int:
            self.sequence_number = max(self.sequence_number, upstream_sequence - 1)
        message = upstream.get("message") or getattr(exception, "message", None) or str(exception)
        response = {
            "id": "resp_" + uuid.uuid4().hex,
            "object": "response",
            "created_at": int(time.time()),
            **self.response_fields,
            "status": "failed",
            "output": [],
            "error": {
                "code": _error_code(exception, upstream),
                "message": str(message) or "The response could not be completed.",
            },
        }
        self.sequence_number += 1
        self.terminal_seen = True
        payload = {"type": "response.failed", "sequence_number": self.sequence_number, "response": response}
        return "event: response.failed\ndata: " + json.dumps(payload, separators=(",", ":")) + "\n\n"
