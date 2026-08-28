# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Unit tests for the JSONB scope helpers.

These tests do not require a running Postgres instance; they exercise the
pure-Python normalization layer that translates between dict scopes and
the legacy slash-delimited string form.
"""

from __future__ import annotations

import os
import sys

import pytest

# Make ``src`` importable without installing the package.
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from claw_memory.storage.postgres_store import (  # noqa: E402
    _normalize_scope,
    _scope_from_string,
    _scope_to_string,
)


class TestScopeFromString:
    def test_empty(self) -> None:
        assert _scope_from_string("") == {}

    def test_single_segment(self) -> None:
        assert _scope_from_string("org:claw") == {"org": "claw"}

    def test_user_scope(self) -> None:
        assert _scope_from_string("org:claw/user:abc") == {
            "org": "claw",
            "user": "abc",
        }

    def test_multi_segment(self) -> None:
        got = _scope_from_string(
            "org:hyperloom/model_family:qwen/model:Qwen3-14B/session:s1"
        )
        assert got == {
            "org": "hyperloom",
            "model_family": "qwen",
            "model": "Qwen3-14B",
            "session": "s1",
        }

    def test_value_with_colon(self) -> None:
        # Only the first ':' in a segment is treated as the separator.
        assert _scope_from_string("tag:k:v") == {"tag": "k:v"}

    def test_skips_empty_segments(self) -> None:
        assert _scope_from_string("/org:claw//user:abc/") == {
            "org": "claw",
            "user": "abc",
        }


class TestScopeToString:
    def test_empty(self) -> None:
        assert _scope_to_string({}) == ""

    def test_canonical_ordering(self) -> None:
        # Even if the dict is provided in a different order, the canonical
        # key order from `_SCOPE_KEY_ORDER` is preserved on output.
        scope = {"user": "abc", "org": "claw"}
        assert _scope_to_string(scope) == "org:claw/user:abc"

    def test_unknown_keys_alphabetical(self) -> None:
        scope = {"org": "claw", "zzz": "1", "aaa": "2"}
        assert _scope_to_string(scope) == "org:claw/aaa:2/zzz:1"

    def test_filters_empty_values(self) -> None:
        assert _scope_to_string({"org": "claw", "user": ""}) == "org:claw"


class TestNormalizeScope:
    def test_none(self) -> None:
        assert _normalize_scope(None) == {}

    def test_dict_passthrough(self) -> None:
        d = {"org": "claw", "user": "abc"}
        assert _normalize_scope(d) == d

    def test_dict_drops_empty(self) -> None:
        assert _normalize_scope({"org": "claw", "user": "", "x": None}) == {
            "org": "claw"
        }

    def test_legacy_string(self) -> None:
        assert _normalize_scope("org:claw/user:abc") == {
            "org": "claw",
            "user": "abc",
        }

    def test_unsupported_type_rejected(self) -> None:
        with pytest.raises(TypeError):
            _normalize_scope(123)  # type: ignore[arg-type]


class TestRoundtrip:
    @pytest.mark.parametrize(
        "raw",
        [
            "org:claw",
            "org:claw/user:abc",
            "org:hyperloom/model_family:qwen/model:Qwen3-14B",
            "org:hyperloom/model:Qwen3-14B/session:s1/user:abc",
        ],
    )
    def test_string_dict_string_is_canonical(self, raw: str) -> None:
        d = _scope_from_string(raw)
        out = _scope_to_string(d)
        # Round-trip via dict ALWAYS produces the canonical key order.
        assert _scope_from_string(out) == d
