# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Unit tests for the request-side scope helpers in handlers.py.

These tests do not require a database; they only verify that the
boundary translation between ``scope`` (dict) and the legacy
``scopePath`` (string) behaves as documented.
"""

from __future__ import annotations

import os
import sys

# Make ``src`` importable without installing the package.
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from claw_memory.storage.handlers import (  # noqa: E402
    _PARENT_SCOPE,
    _default_scope,
    _extract_user_from_scope,
    _resolve_scope_input,
    _wrap_entry,
)


class TestDefaultScope:
    def test_user_scope_includes_org(self) -> None:
        assert _default_scope("abc") == {"org": "claw", "user": "abc"}

    def test_parent_scope_is_dict(self) -> None:
        assert _PARENT_SCOPE == {"org": "claw"}


class TestExtractUserFromScope:
    def test_user_present(self) -> None:
        assert _extract_user_from_scope({"org": "claw", "user": "abc"}) == "abc"

    def test_user_absent(self) -> None:
        assert _extract_user_from_scope({"org": "claw"}) is None

    def test_none(self) -> None:
        assert _extract_user_from_scope(None) is None

    def test_non_dict(self) -> None:
        assert _extract_user_from_scope("org:claw/user:abc") is None  # type: ignore[arg-type]


class TestResolveScopeInput:
    def test_dict_wins_over_string(self) -> None:
        out = _resolve_scope_input(
            scope={"org": "hyperloom"},
            scope_path="org:claw/user:abc",
        )
        assert out == {"org": "hyperloom"}

    def test_string_fallback(self) -> None:
        out = _resolve_scope_input(scope=None, scope_path="org:claw/user:abc")
        assert out == {"org": "claw", "user": "abc"}

    def test_both_empty(self) -> None:
        assert _resolve_scope_input(scope=None, scope_path=None) == {}

    def test_empty_dict_treated_as_empty(self) -> None:
        # An explicit empty dict is normalized away so the caller falls
        # back to the default parent scope downstream.
        assert _resolve_scope_input(scope={}, scope_path=None) == {}


class TestWrapEntry:
    def _row(self, **overrides):
        base = {
            "memory_id":  "mem_123",
            "category":   "preference",
            "content":    "x",
            "importance": 0.5,
            "metadata":   {},
            "scope":      {"org": "claw", "user": "abc"},
            "scope_path": "org:claw/user:abc",
            "created_at": "2026-04-22T10:23:00Z",
            "updated_at": "2026-04-22T10:23:00Z",
        }
        base.update(overrides)
        return base

    def test_emits_both_scope_and_scope_path(self) -> None:
        wrapped = _wrap_entry(self._row())
        assert wrapped["scope"] == {"org": "claw", "user": "abc"}
        assert wrapped["scopePath"] == "org:claw/user:abc"
        assert wrapped["id"] == "mem_123"

    def test_falls_back_when_scope_path_missing(self) -> None:
        # The store always supplies `scope_path`, but ensure we can render
        # it on the fly if a row is missing it.
        row = self._row()
        del row["scope_path"]
        wrapped = _wrap_entry(row)
        assert wrapped["scopePath"] == "org:claw/user:abc"
